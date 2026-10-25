import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { readSessionAskAnswer } from './session-ask-journal'

const CM = 'cm1'
const PROVIDER_USER_ITEM = 'claude:prov:user-1'
const TURN_ITEM = 'legacy:claude:prov:turn-lifecycle%3Aturn-1'

function submission(
  dispatchState: AgentJournalSubmission['dispatchState'],
  providerItemId: string | null = PROVIDER_USER_ITEM
): AgentJournalSubmission {
  return {
    clientMessageId: CM,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState,
    providerItemId,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

function item(
  itemId: string,
  body: AgentJournalRenderItem['body'],
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId, revision: 1, body, sequence: 1, observedAt: 1, ...extra }
}

const userItem = (itemId = PROVIDER_USER_ITEM): AgentJournalRenderItem =>
  item(
    itemId,
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'q' }] },
    { turnScope: { kind: 'turn', turnItemId: TURN_ITEM } }
  )

const turnItem = (state: 'running' | 'interrupted' | 'unverifiable'): AgentJournalRenderItem =>
  item(
    TURN_ITEM,
    { kind: 'turn', turnId: 'turn-1', state, userItemId: PROVIDER_USER_ITEM },
    { turnScope: { kind: 'thread' } }
  )

const assistant = (id: string, text: string, agentId?: string): AgentJournalRenderItem =>
  item(
    id,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    { turnScope: { kind: 'turn', turnItemId: TURN_ITEM }, ...(agentId ? { agentId } : {}) }
  )

describe('readSessionAskAnswer', () => {
  it('is pending while the turn the question opened is running', () => {
    const snapshot = {
      items: [userItem(), turnItem('running'), assistant('a1', 'partial')],
      submissions: [submission('accepted')]
    }
    expect(readSessionAskAnswer(snapshot, CM)).toEqual({ state: 'pending' })
  })

  it('answers with the final main-agent message, skipping narration and subagents', () => {
    const snapshot = {
      items: [
        userItem(),
        assistant('a1', 'first'),
        assistant('s1', 'subagent noise', 'agent-7'),
        assistant('a2', 'second')
      ],
      submissions: [submission('accepted')]
    }
    expect(readSessionAskAnswer(snapshot, CM)).toEqual({ state: 'answered', text: 'second' })
  })

  it('finds the turn through the orca submission key, as Codex records it', () => {
    const snapshot = {
      items: [userItem(agentJournalSubmissionKey(CM)), assistant('a1', 'codex says')],
      submissions: [submission('accepted', 'codex:thread:turn:0')]
    }
    expect(readSessionAskAnswer(snapshot, CM)).toEqual({ state: 'answered', text: 'codex says' })
  })

  it('fails when the turn was interrupted', () => {
    const snapshot = {
      items: [userItem(), turnItem('interrupted')],
      submissions: [submission('accepted')]
    }
    expect(readSessionAskAnswer(snapshot, CM)).toEqual({ state: 'failed', reason: 'interrupted' })
  })

  it('fails when the send was rejected', () => {
    const snapshot = { items: [], submissions: [submission('rejected', null)] }
    expect(readSessionAskAnswer(snapshot, CM)).toEqual({ state: 'failed', reason: 'rejected' })
  })

  it('is pending before any turn exists for the send', () => {
    expect(
      readSessionAskAnswer({ items: [], submissions: [submission('pending', null)] }, CM)
    ).toEqual({ state: 'pending' })
    expect(readSessionAskAnswer({ items: [], submissions: [] }, CM)).toEqual({ state: 'pending' })
  })

  it('finds the turn through its lifecycle when the sent row is still thread-scoped', () => {
    // As a live Claude journal reduces: the submission row keeps the orca key and thread scope,
    // and the completed lifecycle names the provider's user item.
    const sentRow = item(
      agentJournalSubmissionKey(CM),
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'q' }] },
      { turnScope: { kind: 'thread' } }
    )
    const completed = item(
      TURN_ITEM,
      { kind: 'turn', turnId: 'turn-1', state: 'completed', userItemId: PROVIDER_USER_ITEM },
      { turnScope: { kind: 'thread' } }
    )
    const snapshot = {
      items: [sentRow, completed, assistant('a1', 'Falcon, port 6543')],
      submissions: [submission('accepted')]
    }
    expect(readSessionAskAnswer(snapshot, CM)).toEqual({
      state: 'answered',
      text: 'Falcon, port 6543'
    })
  })

  it('fails a turn the provider ended with an error', () => {
    const failed = item(
      TURN_ITEM,
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'failure',
        userItemId: PROVIDER_USER_ITEM
      },
      { turnScope: { kind: 'thread' } }
    )
    expect(
      readSessionAskAnswer({ items: [failed], submissions: [submission('accepted')] }, CM)
    ).toEqual({ state: 'failed', reason: 'failure' })
  })

  it('fails a settled turn that left no reply text', () => {
    const snapshot = { items: [userItem()], submissions: [submission('accepted')] }
    expect(readSessionAskAnswer(snapshot, CM)).toEqual({ state: 'failed', reason: 'no-reply' })
  })
})
