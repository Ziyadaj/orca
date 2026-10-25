/**
 * One `orca session ask` exchange: wait until the asked chat is idle, send the question as a turn
 * from the asker, and read the reply off the asked chat's journal. Asks to one chat go one at a
 * time, in arrival order; asks to different chats never wait on each other.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentJournalMessageItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import { sessionAskQuestionText, sessionAskSource } from '../../../shared/session-ask-message'
import { AGENT_SESSION_NOT_ATTACHED } from '../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { mintAgentSessionOperationId } from '../orchestration/structured-pointer-operation-id'
import { sendAgentTurn, type StructuredSessionTurnOutcome } from '../orchestration/send-agent-turn'
import { readStructuredSessionGateFacts } from '../orchestration/structured-mailbox-pointer-host'
import { canonicalOrcaSessionId } from '../orchestration/canonical-orca-session-id'
import type { OrchestrationDb } from '../orchestration/db'
import { structuredSessionMailTarget } from '../orchestration/structured-session-mail-target'
import type { StructuredSessionGateFacts } from '../orchestration/structured-session-pointer-delivery'
import { readSessionAskAnswer } from './session-ask-journal'

export type SessionAskStatus =
  | 'answered'
  | 'timed-out'
  | 'cancelled'
  | 'target-closed'
  | 'turn-failed'

export type SessionAskParty = { sessionId: OrcaSessionId; name: string | null }

export type SessionAskResult = {
  status: SessionAskStatus
  answer: string | null
  target: SessionAskParty
  timeoutMs: number
  /** Why a `turn-failed` ask got no answer, as a sentence or the journal's verdict. */
  reason?: string
}

type SessionAskJournal = Pick<AgentJournalSnapshot, 'items' | 'submissions'>

export type SessionAskDeps = {
  /** The chat's live session after any /clear; null once its tab is closed or it left this host. */
  liveSessionId(sessionId: string): OrcaSessionId | null
  /** One key per conversation, so asks to any session of a /clear lineage share a queue. */
  queueKey(sessionId: string): string
  /** Null when the chat's journal is unreadable here. */
  gateFacts(sessionId: string): Promise<StructuredSessionGateFacts | null>
  journal(sessionId: string): Promise<SessionAskJournal | null>
  /** Null when the chat is not attached. */
  send(input: {
    sessionId: string
    body: AgentJournalMessageItem
    operationId: string
    callerKey: string
  }): Promise<StructuredSessionTurnOutcome | null>
  /** Wakes on each turn completion or raised prompt; returns the unsubscribe. */
  onTurnEdge(sessionId: string, wake: () => void): () => void
  now(): number
  newOperationId(): string
  /** Fallback re-read interval, since the edge feed skips turns it only observed ending. */
  pollMs?: number
}

type SessionAskInput = {
  asker: SessionAskParty
  target: SessionAskParty
  question: string
  timeoutMs: number
  signal?: AbortSignal
}

const DEFAULT_POLL_MS = 5_000

const targetQueues = new Map<string, Promise<unknown>>()

export function runSessionAsk(
  deps: SessionAskDeps,
  input: SessionAskInput
): Promise<SessionAskResult> {
  // Time spent queued counts: the caller's transport gives up on its own clock.
  const deadline = deps.now() + input.timeoutMs
  const key = deps.queueKey(input.target.sessionId)
  const previous = targetQueues.get(key) ?? Promise.resolve()
  const run = previous.then(() => exchange(deps, input, deadline))
  const settled = run.catch(() => {})
  targetQueues.set(key, settled)
  void settled.then(() => {
    if (targetQueues.get(key) === settled) {
      targetQueues.delete(key)
    }
  })
  return run
}

async function exchange(
  deps: SessionAskDeps,
  input: SessionAskInput,
  deadline: number
): Promise<SessionAskResult> {
  const { timeoutMs, signal } = input
  let target = input.target
  const result = (
    status: SessionAskStatus,
    answer: string | null = null,
    reason?: string
  ): SessionAskResult => ({ status, answer, target, timeoutMs, ...(reason ? { reason } : {}) })
  const stopped = (): SessionAskResult | null =>
    signal?.aborted ? result('cancelled') : deps.now() >= deadline ? result('timed-out') : null

  // Busy is anything but idle: a pending approval counts, so a question never answers it.
  while (true) {
    const stop = stopped()
    if (stop) {
      return stop
    }
    const live = deps.liveSessionId(input.target.sessionId)
    if (!live) {
      return result('target-closed')
    }
    target = { ...target, sessionId: live }
    const facts = await deps.gateFacts(live)
    if (!facts) {
      return result('target-closed')
    }
    if (!facts.turnRunning && !facts.awaitingHuman) {
      break
    }
    const waited = await waitForEdge(live)
    if (waited) {
      return waited
    }
  }
  const sentTo = target.sessionId
  const beforeSend = stopped()
  if (beforeSend) {
    return beforeSend
  }

  const outcome = await deps.send({
    sessionId: sentTo,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: sessionAskQuestionText({
            askerName: input.asker.name ?? 'another session',
            question: input.question
          })
        }
      ],
      from: sessionAskSource(input.asker)
    },
    operationId: deps.newOperationId(),
    callerKey: `trusted-local:session-ask:${input.asker.sessionId}`
  })
  if (!outcome) {
    return result('target-closed')
  }
  if (outcome.kind === 'refused') {
    return result('turn-failed', null, outcome.refusal.message)
  }

  while (true) {
    // A /clear after the send ends the turn the question was in.
    if (deps.liveSessionId(input.target.sessionId) !== sentTo) {
      return result('target-closed')
    }
    const [facts, journal] = await Promise.all([deps.gateFacts(sentTo), deps.journal(sentTo)])
    if (!facts || !journal) {
      return result('target-closed')
    }
    const clientMessageId =
      outcome.kind === 'sent'
        ? outcome.clientMessageId
        : journal.submissions.find((s) => s.queuedMessageId === outcome.queued.messageId)
            ?.clientMessageId
    if (clientMessageId) {
      const read = readSessionAskAnswer(journal, clientMessageId)
      if (read.state === 'failed') {
        return result('turn-failed', null, read.reason)
      }
      if (read.state === 'answered' && !facts.turnRunning) {
        return result('answered', read.text)
      }
    }
    const waited = stopped() ?? (await waitForEdge(sentTo))
    if (waited) {
      return waited
    }
  }

  async function waitForEdge(sessionId: string): Promise<SessionAskResult | null> {
    await new Promise<void>((resolve) => {
      let unsubscribe = (): void => {}
      const done = (): void => {
        clearTimeout(timer)
        unsubscribe()
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(
        done,
        Math.max(0, Math.min(deps.pollMs ?? DEFAULT_POLL_MS, deadline - deps.now()))
      )
      unsubscribe = deps.onTurnEdge(sessionId, done)
      signal?.addEventListener('abort', done, { once: true })
    })
    return stopped()
  }
}

/** The host admits only `<13-digit ms>-<32 hex>` operation ids. */
export function sessionAskOperationId(now: number): string {
  return mintAgentSessionOperationId(now)
}

/** The exchange's reads and send against this host's structured sessions; null with no host. */
export function createSessionAskDeps(db: OrchestrationDb | null): SessionAskDeps | null {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  return {
    // Closed is the user closing the tab, never an idle-released agent: sending restarts that one.
    liveSessionId: (sessionId) => {
      const live = structuredSessionMailTarget(sessionId, db)?.sessionId
      return live && isOrcaSessionId(live) ? live : null
    },
    queueKey: (sessionId) =>
      isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId,
    gateFacts: (sessionId) => readStructuredSessionGateFacts(sessionId),
    journal: async (sessionId) => {
      try {
        return await host.journalSnapshot(sessionId)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== AGENT_SESSION_NOT_ATTACHED.code) {
          console.warn('[session-ask] journal unreadable', sessionId, error)
        }
        return null
      }
    },
    send: async ({ sessionId, body, operationId, callerKey }) => {
      const fence = host.deps.store.getRecord(sessionId)?.lease.runtimeFence
      if (fence === undefined) {
        return null
      }
      const outcome = await sendAgentTurn({
        kind: 'structured-session',
        host,
        sessionId,
        callerKey,
        // Queue, not steer: a person's send racing ours goes first and ours waits for its turn.
        turn: { body, operationId, expectedRuntimeFence: fence, delivery: 'queue' }
      })
      return outcome.kind === 'refused' && outcome.refusal.code === AGENT_SESSION_NOT_ATTACHED.code
        ? null
        : outcome
    },
    onTurnEdge: (sessionId, wake) => {
      const id = `session-ask:${randomUUID()}`
      return host.subscribeTurnCompletions({
        id,
        includePrompts: true,
        emit: (event) => {
          if (
            (event.type === 'completion' && event.completion.sessionId === sessionId) ||
            (event.type === 'prompt' && event.prompt.sessionId === sessionId)
          ) {
            wake()
          }
        }
      })
    },
    now: () => Date.now(),
    newOperationId: () => sessionAskOperationId(Date.now())
  }
}
