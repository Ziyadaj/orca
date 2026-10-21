import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  clampOrchestrationAskTimeoutMs,
  resolveOrchestrationAskClientTimeoutMs
} from '../../shared/orchestration-ask-timeout'
import { SESSION_ASK_RUNTIME_CAPABILITY } from '../../shared/session-ask-capability'
import { getOptionalPositiveIntegerValueFlag } from './orchestration/numeric-flags'

type SessionAskCliResult = {
  status: 'answered' | 'timed-out' | 'cancelled' | 'target-closed' | 'turn-failed'
  answer: string | null
  target: { sessionId: string; name: string | null }
  timeoutMs: number
  reason?: string
}

export const SESSION_ASK_HANDLERS: Record<string, CommandHandler> = {
  'session ask': async ({ flags, client, json }) => {
    const to = getOptionalStringFlag(flags, 'to')
    const question = getOptionalStringFlag(flags, 'question')
    if (!to || !question) {
      throw new RuntimeClientError('invalid_argument', 'Both --to and --question are required.')
    }
    const parsedTimeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
    const status = await client.getCliStatus()
    if (!status.result.runtime.capabilities?.includes(SESSION_ASK_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host cannot run `orca session ask`. Update Orca; no question was sent.'
      )
    }
    const response = await client.call<SessionAskCliResult>(
      'orchestration.sessionAsk',
      {
        to,
        question,
        timeoutMs:
          parsedTimeoutMs === undefined
            ? undefined
            : clampOrchestrationAskTimeoutMs(parsedTimeoutMs)
      },
      // Outlives the host's own wait, so the host answers the timeout, not the transport.
      { timeoutMs: resolveOrchestrationAskClientTimeoutMs(parsedTimeoutMs) }
    )
    const result = response.result
    if (json) {
      printResult(response, true, () => '')
    } else {
      console.log(sessionAskText(result))
    }
    if (result.status !== 'answered') {
      process.exitCode = 1
    }
  }
}

function sessionAskText(result: SessionAskCliResult): string {
  const name = `"${result.target.name ?? 'the session'}"`
  switch (result.status) {
    case 'answered':
      return `Reply from ${name} (orca_session_id:${result.target.sessionId}):\n${result.answer ?? ''}`
    case 'target-closed':
      return `${name} is no longer running.`
    case 'timed-out':
      return `No reply from ${name} within ${Math.round(result.timeoutMs / 1000)}s.`
    case 'cancelled':
      return `The question to ${name} was cancelled.`
    case 'turn-failed':
      return `${name} did not finish answering${result.reason ? `: ${result.reason}` : '.'}`
  }
}
