import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import { sessionAskQuestionText, sessionAskSource } from '../../../shared/session-ask-message'
import type { StructuredSessionGateFacts } from '../orchestration/structured-session-pointer-delivery'
import { runSessionAsk, type SessionAskDeps } from './session-ask-exchange'

function sid(value: string): OrcaSessionId {
  if (!isOrcaSessionId(value)) {
    throw new Error(`bad fixture id ${value}`)
  }
  return value
}

const ASKER = { sessionId: sid('claude_aaaaaaaa_0000_4000_8000_000000000001'), name: 'repo chat' }
const T = { sessionId: sid('claude_bbbbbbbb_0000_4000_8000_000000000002'), name: 'RCMC handover' }
const U = { sessionId: sid('codex_cccccccc_0000_4000_8000_000000000003'), name: 'other' }

const IDLE: StructuredSessionGateFacts = { turnRunning: false, awaitingHuman: false }
const TURN = 'turn-item'

type Journal = Pick<AgentJournalSnapshot, 'items' | 'submissions'>

function submission(clientMessageId: string, extra: Partial<AgentJournalSubmission> = {}) {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted' as const,
    providerItemId: `prov:${clientMessageId}`,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...extra
  }
}

function answeredJournal(clientMessageId: string, text: string): Journal {
  const items: AgentJournalRenderItem[] = [
    {
      itemId: `prov:${clientMessageId}`,
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'q' }] },
      turnScope: { kind: 'turn', turnItemId: `${TURN}-${clientMessageId}` }
    },
    {
      itemId: `a-${clientMessageId}`,
      revision: 1,
      sequence: 2,
      observedAt: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
      turnScope: { kind: 'turn', turnItemId: `${TURN}-${clientMessageId}` }
    }
  ]
  return { items, submissions: [submission(clientMessageId)] }
}

type Fake = {
  deps: SessionAskDeps
  sent: { sessionId: string; body: AgentJournalMessageItem }[]
  facts: Map<string, StructuredSessionGateFacts | null>
  journals: Map<string, Journal | null>
  edge(sessionId: string): void
}

function fake(): Fake {
  const facts = new Map<string, StructuredSessionGateFacts | null>()
  const journals = new Map<string, Journal | null>()
  const sent: Fake['sent'] = []
  const listeners = new Map<string, Set<() => void>>()
  let n = 0
  const deps: SessionAskDeps = {
    gateFacts: async (id) => (facts.has(id) ? (facts.get(id) ?? null) : IDLE),
    journal: async (id) => journals.get(id) ?? { items: [], submissions: [] },
    send: async ({ sessionId, body }) => {
      sent.push({ sessionId, body })
      const clientMessageId = `cm${sent.length}`
      journals.set(sessionId, answeredJournal(clientMessageId, `answer ${sent.length}`))
      return { kind: 'sent', clientMessageId, submission: submission(clientMessageId) }
    },
    onTurnEdge: (id, wake) => {
      const set = listeners.get(id) ?? new Set()
      set.add(wake)
      listeners.set(id, set)
      return () => set.delete(wake)
    },
    now: () => Date.now(),
    newOperationId: () => `op${++n}`,
    pollMs: 5
  }
  return {
    deps,
    sent,
    facts,
    journals,
    edge: (id) => {
      for (const wake of listeners.get(id) ?? []) {
        wake()
      }
    }
  }
}

const ask = (f: Fake, target = T, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  runSessionAsk(f.deps, {
    asker: ASKER,
    target,
    question: 'Who owns X?',
    timeoutMs: extra.timeoutMs ?? 2_000,
    signal: extra.signal
  })

describe('runSessionAsk', () => {
  it('answers when idle, sending the marked question', async () => {
    const f = fake()
    await expect(ask(f)).resolves.toEqual({
      status: 'answered',
      answer: 'answer 1',
      target: T,
      timeoutMs: 2_000
    })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: sessionAskQuestionText({ askerName: 'repo chat', question: 'Who owns X?' })
        }
      ],
      from: sessionAskSource(ASKER)
    })
  })

  it('waits while the target works or waits on a person, then sends once', async () => {
    const f = fake()
    f.facts.set(T.sessionId, { turnRunning: true, awaitingHuman: false })
    const pending = ask(f)
    await vi.waitFor(() => expect(f.deps.pollMs).toBe(5))
    f.facts.set(T.sessionId, { turnRunning: false, awaitingHuman: true })
    f.edge(T.sessionId)
    await new Promise((r) => setTimeout(r, 30))
    expect(f.sent).toHaveLength(0)
    f.facts.set(T.sessionId, IDLE)
    f.edge(T.sessionId)
    await expect(pending).resolves.toMatchObject({ status: 'answered' })
    expect(f.sent).toHaveLength(1)
  })

  it('delivers asks to one target first in, first out, without blocking other targets', async () => {
    const f = fake()
    const order: string[] = []
    const send = f.deps.send
    let releaseFirst: () => void = () => {}
    const firstHeld = new Promise<void>((r) => (releaseFirst = r))
    f.deps.send = async (input) => {
      order.push(input.sessionId)
      if (order.length === 1) {
        await firstHeld
      }
      return send(input)
    }
    const first = ask(f, T)
    const second = ask(f, T)
    const other = ask(f, U)
    await expect(other).resolves.toMatchObject({ status: 'answered' })
    expect(order).toEqual([T.sessionId, U.sessionId])
    releaseFirst()
    await expect(first).resolves.toMatchObject({ status: 'answered' })
    await expect(second).resolves.toMatchObject({ status: 'answered' })
    expect(order).toEqual([T.sessionId, U.sessionId, T.sessionId])
  })

  it('reports a target that closed before the send, without sending', async () => {
    const f = fake()
    f.facts.set(T.sessionId, null)
    await expect(ask(f)).resolves.toMatchObject({ status: 'target-closed', answer: null })
    expect(f.sent).toHaveLength(0)
  })

  it('reports a target that closed while answering', async () => {
    const f = fake()
    f.deps.send = async () => {
      f.journals.set(T.sessionId, { items: [], submissions: [submission('cm1')] })
      f.facts.set(T.sessionId, null)
      return { kind: 'sent', clientMessageId: 'cm1', submission: submission('cm1') }
    }
    await expect(ask(f)).resolves.toMatchObject({ status: 'target-closed', answer: null })
  })

  it('times out and cancels with no answer', async () => {
    const f = fake()
    f.facts.set(T.sessionId, { turnRunning: true, awaitingHuman: false })
    await expect(ask(f, T, { timeoutMs: 20 })).resolves.toMatchObject({
      status: 'timed-out',
      answer: null,
      timeoutMs: 20
    })
    const controller = new AbortController()
    const pending = ask(f, T, { signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', answer: null })
  })

  it('reports a failed turn', async () => {
    const f = fake()
    f.deps.send = async () => {
      f.journals.set(T.sessionId, {
        items: [],
        submissions: [submission('cm1', { dispatchState: 'rejected' })]
      })
      return { kind: 'sent', clientMessageId: 'cm1', submission: submission('cm1') }
    }
    await expect(ask(f)).resolves.toMatchObject({ status: 'turn-failed', answer: null })
  })

  it('follows a queued send to the submission that handed it over', async () => {
    const f = fake()
    f.deps.send = async () => {
      const journal = answeredJournal('cm-real', 'from the queue')
      journal.submissions = [submission('cm-real', { queuedMessageId: 'q1' })]
      f.journals.set(T.sessionId, journal)
      return {
        kind: 'queued',
        clientMessageId: 'cm-draft',
        queued: { messageId: 'q1', position: 0, state: 'waiting' }
      }
    }
    await expect(ask(f)).resolves.toMatchObject({ status: 'answered', answer: 'from the queue' })
  })
})
