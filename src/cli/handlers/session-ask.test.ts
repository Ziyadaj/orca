import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_ASK_RUNTIME_CAPABILITY } from '../../shared/session-ask-capability'
import type { RuntimeClient } from '../runtime-client'
import { SESSION_ASK_HANDLERS } from './session-ask'

const TARGET = 'claude_bbbbbbbb_0000_4000_8000_000000000002'

function client(result: Record<string, unknown>, capabilities = [SESSION_ASK_RUNTIME_CAPABILITY]) {
  const call = vi.fn(async () => ({ id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }))
  const getCliStatus = vi.fn(async () => ({
    result: { runtime: { reachable: true, capabilities } }
  }))
  const fake = { call, getCliStatus }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only call and getCliStatus, which the fake implements.
  return fake as unknown as RuntimeClient & { call: typeof call }
}

function answered(status: string, answer: string | null = null) {
  return {
    status,
    answer,
    target: { sessionId: TARGET, name: 'RCMC handover' },
    timeoutMs: 600_000
  }
}

const run = (c: RuntimeClient, extra: [string, string][] = [], json = false) =>
  SESSION_ASK_HANDLERS['session ask']({
    flags: new Map<string, string | boolean>([
      ['to', `orca_session_id:${TARGET}`],
      ['question', 'hi'],
      ...extra
    ]),
    client: c,
    cwd: '/',
    json
  })

let log: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  process.exitCode = undefined
})

afterEach(() => {
  log.mockRestore()
  process.exitCode = undefined
})

describe('orca session ask', () => {
  it('asks with no caller param and prints the reply under its header', async () => {
    const c = client(answered('answered', 'pong'))
    await run(c)
    expect(c.call).toHaveBeenCalledWith(
      'orchestration.sessionAsk',
      { to: `orca_session_id:${TARGET}`, question: 'hi', timeoutMs: undefined },
      { timeoutMs: 605_000 }
    )
    expect(log).toHaveBeenCalledWith(
      `Reply from "RCMC handover" (orca_session_id:${TARGET}):\npong`
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('reports a closed target and fails', async () => {
    await run(client(answered('target-closed')))
    expect(log).toHaveBeenCalledWith('"RCMC handover" is no longer running.')
    expect(process.exitCode).toBe(1)
  })

  it('reports a timeout in seconds and fails', async () => {
    await run(client({ ...answered('timed-out'), timeoutMs: 30_000 }), [['timeout-ms', '30000']])
    expect(log).toHaveBeenCalledWith('No reply from "RCMC handover" within 30s.')
    expect(process.exitCode).toBe(1)
  })

  it('says why the asked session did not answer', async () => {
    await run(client({ ...answered('turn-failed'), reason: 'The chat moved on.' }))
    expect(log).toHaveBeenCalledWith('"RCMC handover" did not finish answering: The chat moved on.')
    expect(process.exitCode).toBe(1)
  })

  it('refuses a host without the capability before asking', async () => {
    const c = client(answered('answered', 'x'), [])
    await expect(run(c)).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(c.call).not.toHaveBeenCalled()
  })
})
