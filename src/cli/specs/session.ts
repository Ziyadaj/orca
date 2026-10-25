import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SESSION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['session', 'ask'],
    summary: 'Ask another running chat session and print its reply',
    usage:
      'orca session ask --to <orca_session_id:id> --question <text> [--timeout-ms <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'to', 'question', 'timeout-ms'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Asks another running chat session and prints its reply. Waits while the target is busy.',
      'Runs from inside an Orca chat session; the asked session sees the question as a message from this one.',
      'The asked session answers from what it already knows; neither conversation is copied into the other.'
    ],
    examples: [
      'orca session ask --to orca_session_id:claude_123 --question "Which table holds the permits?"'
    ]
  }
]
