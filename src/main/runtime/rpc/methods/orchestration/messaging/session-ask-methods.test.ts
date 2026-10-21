import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isOrcaSessionId, type OrcaSessionId } from '../../../../../../shared/orca-session-address'
import { classifyRuntimeLongPoll } from '../../../../runtime-rpc/runtime-rpc-long-poll'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { OrchestrationDb } from '../../../../orchestration/db'
import { handleSessionAsk, type SessionAskMethodIo } from './session-ask-methods'

const { readSessionRecipient, refuseUndeliverableSessionRecipient } = vi.hoisted(() => ({
  readSessionRecipient: vi.fn(),
  refuseUndeliverableSessionRecipient: vi.fn()
}))
vi.mock('./session-recipient', () => ({
  readSessionRecipient,
  refuseUndeliverableSessionRecipient
}))

function sid(value: string): OrcaSessionId {
  if (!isOrcaSessionId(value)) {
    throw new Error(`bad fixture id ${value}`)
  }
  return value
}

const ASKER = sid('claude_aaaaaaaa_0000_4000_8000_000000000001')
const TARGET = sid('claude_bbbbbbbb_0000_4000_8000_000000000002')
const TARGET_LIVE = sid('claude_bbbbbbbb_0000_4000_8000_000000000003')

const caller: OrchestrationSessionCaller = {
  address: `orca_session_id:${ASKER}`,
  terminalHandle: null,
  paneKey: null,
  orcaSessionId: ASKER,
  sessionId: ASKER,
  workspaceId: 'ws'
}

function io(overrides: Partial<SessionAskMethodIo> = {}): SessionAskMethodIo {
  return {
    db: new OrchestrationDb(':memory:'),
    deps: {
      gateFacts: vi.fn(),
      journal: vi.fn(),
      send: vi.fn(),
      onTurnEdge: vi.fn(),
      now: () => 0,
      newOperationId: () => 'op'
    },
    run: vi.fn(async (_deps, input) => ({
      status: 'answered' as const,
      answer: '42',
      target: input.target,
      timeoutMs: input.timeoutMs
    })),
    liveTarget: () => TARGET_LIVE,
    canonical: (id) => (id === TARGET_LIVE ? TARGET : id),
    nameOf: (id) => (id === ASKER ? 'repo chat' : 'RCMC handover'),
    ...overrides
  }
}

beforeEach(() => {
  readSessionRecipient.mockReset().mockReturnValue({ sessionId: TARGET, address: `x` })
  refuseUndeliverableSessionRecipient.mockReset().mockReturnValue(null)
})

describe('orchestration.sessionAsk', () => {
  it('refuses a caller that is not a chat session', async () => {
    await expect(
      handleSessionAsk({ to: `orca_session_id:${TARGET}`, question: 'q' }, {}, io())
    ).rejects.toMatchObject({
      code: 'session_ask_requires_chat',
      message: 'orca session ask runs from inside an Orca chat session.'
    })
  })

  it('refuses a session asking itself, before anything is sent', async () => {
    const run = vi.fn()
    readSessionRecipient.mockReturnValue({ sessionId: ASKER, address: 'x' })
    await expect(
      handleSessionAsk(
        { to: ASKER, question: 'q' },
        { orchestrationCaller: caller },
        io({ run, liveTarget: () => ASKER })
      )
    ).rejects.toMatchObject({ code: 'invalid_argument', message: 'A session cannot ask itself.' })
    expect(run).not.toHaveBeenCalled()
  })

  it('passes on an unknown or other-host recipient refusal', async () => {
    refuseUndeliverableSessionRecipient.mockReturnValue({
      code: 'session_caller_host_boundary',
      message: 'runs on another host'
    })
    await expect(
      handleSessionAsk({ to: TARGET, question: 'q' }, { orchestrationCaller: caller }, io())
    ).rejects.toMatchObject({ code: 'session_caller_host_boundary' })
    readSessionRecipient.mockReturnValue(null)
    await expect(
      handleSessionAsk({ to: 'nobody', question: 'q' }, { orchestrationCaller: caller }, io())
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('asks the live session of the lineage with a clamped budget', async () => {
    const methodIo = io()
    const result = await handleSessionAsk(
      { to: TARGET, question: 'Who owns X?', timeoutMs: 99_999_999 },
      { orchestrationCaller: caller },
      methodIo
    )
    expect(result).toMatchObject({ status: 'answered', answer: '42', timeoutMs: 1_800_000 })
    expect(methodIo.run).toHaveBeenCalledWith(
      methodIo.deps,
      expect.objectContaining({
        asker: { sessionId: ASKER, name: 'repo chat' },
        target: { sessionId: TARGET_LIVE, name: 'RCMC handover' },
        question: 'Who owns X?',
        timeoutMs: 1_800_000
      })
    )
  })

  it('keeps the socket alive like orchestration.ask', () => {
    expect(
      classifyRuntimeLongPoll({ id: '1', authToken: 't', method: 'orchestration.sessionAsk' })
    ).toBe('ask')
  })
})
