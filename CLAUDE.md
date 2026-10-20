@AGENTS.md

# Personal fork (`Ziyadaj/orca`)

This checkout is Ziyad's personal fork for UI customizations of Orca. Its work is not contributed back upstream.

- **Remotes**: `origin` = `Ziyadaj/orca` (the fork; push and open PRs here). `upstream` = `stablyai/orca` (read-only source of the latest changes).
- **Base**: the fork's `main` holds the UI customizations on top of upstream.
- **Staying current**: `pnpm dev` runs `config/scripts/sync-fork-upstream.mjs` first.
  - On `main`, it merges `upstream/main` and pushes to `origin`.
  - It skips if the tree is dirty, and aborts on conflicts so launch is never blocked. Resolve conflicts manually with `git merge upstream/main`.
  - Keep the `package.json` hook and this section when you resolve merges.

## Task workflow

1. Branch per task off an up-to-date `main` (`git fetch upstream && git merge upstream/main` first), e.g. `ui/<short-task-name>`.
2. Keep changes UI-focused and self-contained. Prefer new files over edits to hot upstream files, so upstream merges stay conflict-free.
3. Verify (typecheck, tests, lint per AGENTS.md), then ask before committing.
4. Open the PR against the fork: `gh pr create --repo Ziyadaj/orca --base main`. Never target `stablyai/orca`.
5. Request review from other agents before merging. Dispatch reviewer subagents, e.g. the `code-review` skill. Post their findings as PR comments, address them, and merge only after review passes.
