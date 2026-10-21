import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isTextBlock } from '../../../shared/native-chat-types'

export type SessionAskJournalRead =
  | { state: 'pending' }
  | { state: 'answered'; text: string }
  | {
      state: 'failed'
      reason:
        | 'interrupted'
        | 'unverifiable'
        | 'rejected'
        | 'failure'
        | 'cancellation'
        | 'superseded'
        | 'no-reply'
    }

/**
 * The asked chat's reply to one send, read off its FULL reduced timeline. A settled turn's
 * lifecycle item is tombstoned, so "done" is the turn having opened and no longer running.
 */
export function readSessionAskAnswer(
  snapshot: Pick<AgentJournalSnapshot, 'items' | 'submissions'>,
  clientMessageId: string
): SessionAskJournalRead {
  const submission = snapshot.submissions.find((s) => s.clientMessageId === clientMessageId)
  if (submission?.dispatchState === 'rejected') {
    return { state: 'failed', reason: 'rejected' }
  }
  // Codex keys the user item by the orca submission key, Claude by the provider's item id.
  const userKeys = new Set([agentJournalSubmissionKey(clientMessageId)])
  if (submission?.providerItemId) {
    userKeys.add(submission.providerItemId)
  }
  const turnItemId = openedTurnItemId(snapshot.items, userKeys)
  if (!turnItemId) {
    return { state: 'pending' }
  }
  const lifecycle = snapshot.items.find((i) => i.itemId === turnItemId && i.body.kind === 'turn')
  if (lifecycle?.body.kind === 'turn') {
    if (lifecycle.body.state === 'interrupted' || lifecycle.body.state === 'unverifiable') {
      return { state: 'failed', reason: lifecycle.body.state }
    }
    if (lifecycle.body.state !== 'completed') {
      return { state: 'pending' }
    }
    // Absent means unknown, not failed; only a recorded non-success verdict fails the ask.
    const outcome = lifecycle.body.outcome
    if (outcome && outcome !== 'success') {
      return { state: 'failed', reason: outcome }
    }
  }
  const text = finalReplyText(snapshot.items, turnItemId)
  return text ? { state: 'answered', text } : { state: 'failed', reason: 'no-reply' }
}

function openedTurnItemId(
  items: readonly AgentJournalRenderItem[],
  userKeys: ReadonlySet<string>
): string | null {
  for (const item of items) {
    if (
      item.body.kind === 'message' &&
      userKeys.has(item.itemId) &&
      item.turnScope?.kind === 'turn'
    ) {
      return item.turnScope.turnItemId
    }
  }
  // The sent row can stay thread-scoped; the turn's lifecycle row names it as its opener.
  for (const item of items) {
    if (item.body.kind === 'turn' && item.body.userItemId && userKeys.has(item.body.userItemId)) {
      return item.itemId
    }
  }
  return null
}

/** The turn's final main-agent message, as the spec asks: narration before it is not the reply. */
function finalReplyText(items: readonly AgentJournalRenderItem[], turnItemId: string): string {
  let reply = ''
  for (const item of items) {
    if (
      !item.agentId &&
      item.turnScope?.kind === 'turn' &&
      item.turnScope.turnItemId === turnItemId &&
      item.body.kind === 'message' &&
      item.body.role === 'assistant'
    ) {
      const text = item.body.blocks
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('')
        .trim()
      if (text) {
        reply = text
      }
    }
  }
  return reply
}
