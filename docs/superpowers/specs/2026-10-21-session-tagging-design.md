# Session tagging in the chat composer — design

Status: draft for review · Fork: `Ziyadaj/orca` · Date: 2026-10-21

## Intent

Ziyad often works in several agent sessions at once, e.g. a GitHub-repo session and a folder session (RCMC handover) that already knows a domain. To get an answer from the folder session today, he asks it for its session ID, pastes the ID into the repo session, and the repo agent messages it (last time via Claude Code's built-in peer messaging: `ListAgents` → `SendMessage` to `rcmc-cf`, reply delivered as a `<cross-session-message>` turn).

That worked well because **neither session loaded the other's history**: the folder agent answered from what it already knew, and the repo agent kept its context small. The friction is only the ID lookup.

Session tagging removes the lookup: tag the other session from the chat box, and the agent asks it directly.

## Goals

1. **Tag a session from the composer** without ever seeing or copying an ID. Typing `@` lists sessions (name, agent, workspace, status) above files; picking one inserts a session pill.
2. **The agent asks the tagged session**, and the tagged session answers from its own context. No transcript or history is copied across in either direction.
3. **Any chat-UI agent works**, not only Claude: every agent Orca runs as a chat-UI (structured) session — today Claude and Codex — as either the asker or the answerer.
4. **Wait, don't interrupt.** If the tagged session is busy, the question queues until it is idle, then goes in.
5. **Show only the agent's reply** in the asking chat, with a **"Conversation with <session>" card at the end of the reply** (option B from the mockups). Collapsed by default; it expands in place to show each message exchanged, and has a link that opens the tagged session.

## Non-goals (v1)

- Importing or summarizing another session's history (that's the existing "Hand Off to Another Agent" feature).
- Tagging **finished** sessions. Nice-to-have later: Orca would resume the session (AI Vault can already resume) and then ask. Design the picker so finished sessions can be added as a group later.
- **Terminal-tab agents** (agents running as plain PTY terminals). The user doesn't use them; v1 lists and targets chat-UI sessions only.
- Sessions on other hosts (SSH/remote Orca servers) in the picker. v1 lists the local host only, but nothing may break when the current session itself is remote.
- Multi-session fan-out orchestration, task DAGs, supervision. Existing orchestration covers that.

## Anti-goals

- **Nothing else changes behaviour.** This is the user's only hard requirement: file mentions, slash commands, existing hand-off, orchestration, agent status, and terminal behaviour must be unaffected. Iterating on this feature over several PRs is fine; regressions elsewhere are not.
- No typing into a busy agent's terminal.
- No hidden full-history transfer "to be helpful".

## Decided by the user

- Trigger lives in the chat composer as a picker; no IDs shown.
- Running sessions first; finished sessions only if cheap (deferred).
- Any agent, not just Claude — but only chat-UI sessions; terminal-tab agents are out of scope.
- Busy target → wait until idle.
- Asking chat shows the agent's reply only, plus an expandable conversation card at the end of the reply (layout B).
- In the **tagged** session, the incoming question is shown as a marked message from the other session — the same treatment as Claude's "Another Claude session sent a message" — not as a normal message from the user.

## Proposed approach (builder may refine)

### Messenger: Orca, not the agent CLI

Claude's peer messaging only links Claude sessions, so Orca carries the message between chat-UI sessions. Orca already runs both Claude and Codex as structured sessions (`src/main/claude/claude-structured-*`, `src/main/codex/codex-structured-*`) and the hook-server agent-status store knows whether each is working, waiting, or idle. `orca terminal *` verbs target PTY terminals and are not the path here.

Recommended: a single new CLI verb, e.g. `orca session ask --to <session> --question <text>`, that does the whole exchange:

1. Wait until the target is idle (see "My calls" for what counts as busy). Time out with a clear message.
2. Deliver the question into the target's structured session wrapped in a `<cross-session-message from=… from-name=…>` envelope. That tag is already classified as harness machinery in `src/shared/harness-injected-user-turns.ts`, so it renders as a marked inter-session message and is not treated as a user prompt (not used for titles, etc.). Check the Codex side gets the same treatment. The envelope tells the target to answer concisely from its own knowledge.
3. Wait for the target's turn to finish and take the answer from the structured session's final assistant message — no screen scraping.
4. Record the exchange (asker, target, question, answer, timestamps), print the answer, and return.

This keeps the asking agent's instructions tiny ("run `orca session ask` with this session") and makes the behaviour the same for Claude and Codex.

### Composer

- Extend the existing `@` mention menu (`NativeChatAutocompleteMenus.tsx`, `use-native-chat-mention-files.ts`) with a **Sessions** group above **Files**, fed from the renderer agent-status store. Exclude the current session. Each row: status dot, session/tab title, agent name, workspace, and status text.
- Add a session pill node to the prompt editor (`NativeChatPromptEditor.tsx`), alongside the existing file and image reference nodes.
- On send, serialize the pill to a short reference the agent can act on: the target's display name, its Orca handle, and a one-line instruction to use `orca session ask`.

### Transcript

- Render the "Conversation with <session>" card at the end of the asking agent's reply when that turn contains one or more `orca session ask` exchanges. Collapsed shows the target name and message count. Expanded lists each message with direction (asked → / replied ←) and an "Open session" link.
- The card must also cover replies that arrive as Claude `<cross-session-message>` turns (already classified in `src/shared/harness-injected-user-turns.ts`), if the builder uses that path.

## Constraints

- Follow `docs/STYLEGUIDE.md`, the native-chat type-scale/colour rules, and the shadcn primitives (see AGENTS.md).
- Keep changes self-contained in new files where possible so upstream merges stay clean (fork workflow in CLAUDE.md).
- Agent status: read from the hook-server store only; don't add a second status source.
- Remote wire compatibility: anything added to RPCs must be an optional field or a new, capability-checked method.
- Structured-session changes (`src/main/claude/claude-structured-*`) require the real-Claude-CLI tests listed in AGENTS.md.
- Cross-platform (macOS/Linux/Windows): no hardcoded paths or shortcuts.

## My calls (Claude's, from the design review — check these)

- **Busy = anything but idle.** A target waiting on an approval or question prompt counts as busy, so a question never answers someone else's prompt. A target where the user has an unsent draft in its composer also counts as busy.
- **Queue order:** asks to the same target are delivered one at a time, first in, first out.
- **Session identity:** the pill stores the stable structured-session identity Orca already uses for agent status, not a tab or terminal handle. If the target has closed by ask time, the ask fails and the card shows "session no longer running".
- **Persistence:** exchanges are stored with the asking turn so the card renders after reload or restart.
- **Remote asker:** if the current session runs on a remote host, the Sessions group is hidden in v1 rather than half-working.
- **Discoverability:** the serialized pill carries the instruction to use `orca session ask`. Chat-UI agents already run with `orca` available, as this session does.

## Left to the builder

- Exact CLI verb and flag names, and where exchanges are stored.
- Idle-wait and answer-wait timeouts, and the wording of the prefix sent to the target.
- Whether multiple tagged sessions in one message are supported in v1 (guess: yes, one card per target).
- How the asking agent learns about `orca session ask` (prompt serialization only, or also an `orca-cli` skill note).
- Splitting into PRs. Suggested order: (1) CLI exchange + store, (2) composer picker + pill, (3) conversation card.

## Success

Tag "RCMC handover" from the GitHub-repo chat, ask a question, and get a correct answer in the reply. Repeat it with a Codex session. Neither session's context grows beyond the question and answer, and nothing else in Orca behaves differently.
