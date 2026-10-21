import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isTextBlock } from '../../../shared/native-chat-types'

export type SessionAskJournalRead =
  | { state: 'pending' }
  | { state: 'answered'; text: string }
  | { state: 'failed'; reason: 'interrupted' | 'unverifiable' | 'rejected' }

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
  }
  return { state: 'answered', text: mainAgentText(snapshot.items, turnItemId) }
}

function openedTurnItemId(
  items: readonly AgentJournalRenderItem[],
  userKeys: ReadonlySet<string>
): string | null {
  for (const item of items) {
    if (item.body.kind === 'message' && userKeys.has(item.itemId)) {
      return item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null
    }
  }
  // A lifecycle row still running names its opener even before the user row is scoped.
  for (const item of items) {
    if (item.body.kind === 'turn' && item.body.userItemId && userKeys.has(item.body.userItemId)) {
      return item.itemId
    }
  }
  return null
}

function mainAgentText(items: readonly AgentJournalRenderItem[], turnItemId: string): string {
  return items
    .filter(
      (item) =>
        !item.agentId &&
        item.turnScope?.kind === 'turn' &&
        item.turnScope.turnItemId === turnItemId &&
        item.body.kind === 'message' &&
        item.body.role === 'assistant'
    )
    .flatMap((item) => (item.body.kind === 'message' ? item.body.blocks.filter(isTextBlock) : []))
    .map((block) => block.text)
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}
