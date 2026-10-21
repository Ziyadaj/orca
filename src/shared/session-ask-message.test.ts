import { describe, expect, it } from 'vitest'
import { formatOrcaSessionAddress, isOrcaSessionId } from './orca-session-address'
import { sessionAskQuestionText, sessionAskSource } from './session-ask-message'

const ASKER = 'claude_e17b4400_660b_4123_bf97_d1df9783c432'

describe('session ask message', () => {
  it('prefixes the question with who asked and how the reply travels', () => {
    expect(sessionAskQuestionText({ askerName: 'repo chat', question: 'Who owns X?' })).toBe(
      'Question from the Orca session "repo chat", sent with `orca session ask`. Answer it concisely from what you already know. Your final reply is returned to that session, so do not message it yourself.\n\nWho owns X?'
    )
  })

  it('names the asker as the message sender, with no orchestration kind', () => {
    if (!isOrcaSessionId(ASKER)) {
      throw new Error('fixture is not a session id')
    }
    expect(sessionAskSource({ sessionId: ASKER, name: 'repo chat' })).toEqual({
      kind: 'agent',
      orchestration: null,
      senders: [
        {
          name: 'repo chat',
          party: {
            address: formatOrcaSessionAddress(ASKER),
            terminalHandle: null,
            orcaSessionId: ASKER
          }
        }
      ]
    })
  })
})
