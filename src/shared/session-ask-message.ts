// What `orca session ask` sends into the asked chat: the provider-visible text, and the `from`
// source the chat draws as "Message from <asker>" (never sent to the provider).

import type { AgentMessageSource } from './agent-session-message-source'
import { formatOrcaSessionAddress, type OrcaSessionId } from './orca-session-address'

export function sessionAskQuestionText(input: { askerName: string; question: string }): string {
  return `Question from the Orca session "${input.askerName}", sent with \`orca session ask\`. Answer it concisely from what you already know. Your final reply is returned to that session, so do not message it yourself.\n\n${input.question}`
}

export function sessionAskSource(asker: {
  sessionId: OrcaSessionId
  name: string | null
}): AgentMessageSource {
  return {
    kind: 'agent',
    orchestration: null,
    senders: [
      {
        name: asker.name,
        party: {
          address: formatOrcaSessionAddress(asker.sessionId),
          terminalHandle: null,
          orcaSessionId: asker.sessionId
        }
      }
    ]
  }
}
