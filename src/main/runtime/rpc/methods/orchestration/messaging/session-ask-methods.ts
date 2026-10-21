import type { z } from 'zod'
import { defineMethod, type RpcContext } from '../../../core'
import { clampOrchestrationAskTimeoutMs } from '../../../../../../shared/orchestration-ask-timeout'
import { isOrcaSessionId, type OrcaSessionId } from '../../../../../../shared/orca-session-address'
import { SessionAskParams } from '../../../../../../shared/rpc-contract/session-ask-params'
import { canonicalOrcaSessionId } from '../../../../orchestration/canonical-orca-session-id'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { readAgentSessionRecordStore } from '../../../../orchestration/structured-session-lineage'
import { structuredSessionMailTarget } from '../../../../orchestration/structured-session-mail-target'
import {
  createSessionAskDeps,
  runSessionAsk,
  type SessionAskDeps,
  type SessionAskResult
} from '../../../../session-ask/session-ask-exchange'
import { readSessionRecipient, refuseUndeliverableSessionRecipient } from './session-recipient'

export type SessionAskMethodIo = {
  db: OrchestrationDb | null
  deps: SessionAskDeps | null
  run: typeof runSessionAsk
  /** The lineage's live session, or null when it cannot be reached here. */
  liveTarget(sessionId: OrcaSessionId): OrcaSessionId | null
  canonical(sessionId: OrcaSessionId): OrcaSessionId
  nameOf(sessionId: OrcaSessionId): string | null
}

const NO_EFFECT = 'No question was sent.'

export async function handleSessionAsk(
  params: Pick<z.infer<typeof SessionAskParams>, 'to' | 'question' | 'timeoutMs'>,
  ctx: Pick<RpcContext, 'orchestrationCaller' | 'signal'>,
  io: SessionAskMethodIo
): Promise<SessionAskResult> {
  const caller = ctx.orchestrationCaller
  if (!caller) {
    throw new OrchestrationError(
      'session_ask_requires_chat',
      'orca session ask runs from inside an Orca chat session.'
    )
  }
  const store = readAgentSessionRecordStore()
  const recipient = readSessionRecipient(params.to, store)
  if (!recipient) {
    throw new OrchestrationError(
      'invalid_argument',
      `${params.to} does not name an Orca chat session on this host. ${NO_EFFECT}`
    )
  }
  if ('code' in recipient) {
    throw new OrchestrationError(recipient.code, recipient.message)
  }
  if (io.db) {
    const refusal = refuseUndeliverableSessionRecipient(recipient, store, io.db, NO_EFFECT)
    if (refusal) {
      throw new OrchestrationError(refusal.code, refusal.message)
    }
  }
  const live = io.liveTarget(recipient.sessionId)
  if (!live) {
    throw new OrchestrationError(
      'session_ask_target_not_running',
      `Agent session ${recipient.sessionId} is not running here. ${NO_EFFECT}`
    )
  }
  // Waiting on its own turn would deadlock until the timeout.
  if (io.canonical(live) === io.canonical(caller.sessionId)) {
    throw new OrchestrationError('invalid_argument', 'A session cannot ask itself.')
  }
  if (!io.deps) {
    throw new OrchestrationError(
      'session_host_unavailable',
      `This Orca is not running its agent-session host. ${NO_EFFECT}`
    )
  }
  return io.run(io.deps, {
    asker: { sessionId: caller.sessionId, name: io.nameOf(caller.sessionId) },
    target: { sessionId: live, name: io.nameOf(live) },
    question: params.question,
    timeoutMs: clampOrchestrationAskTimeoutMs(params.timeoutMs),
    signal: ctx.signal
  })
}

function liveSessionId(sessionId: OrcaSessionId, db: OrchestrationDb | null): OrcaSessionId | null {
  const live = structuredSessionMailTarget(sessionId, db)?.sessionId
  return live && isOrcaSessionId(live) ? live : null
}

export const ORCHESTRATION_SESSION_ASK_METHODS = [
  defineMethod({
    name: 'orchestration.sessionAsk',
    permission: 'workspace',
    params: SessionAskParams,
    handler: async (params, ctx) => {
      const db = ctx.runtime.getOrchestrationDb()
      return handleSessionAsk(params, ctx, {
        db,
        deps: createSessionAskDeps(db),
        run: runSessionAsk,
        liveTarget: (id) => liveSessionId(id, db),
        canonical: (id) => canonicalOrcaSessionId(id),
        nameOf: (id) => readAgentSessionRecordStore()?.getRecord(id)?.conversationName ?? null
      })
    }
  })
]
