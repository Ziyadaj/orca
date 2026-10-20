// Personal fork: merge upstream main into local main before each `pnpm dev` so it never lags.
// Never blocks launch — any failure just warns.
import { execFileSync } from 'node:child_process'

const BRANCH = 'main'
const UPSTREAM = 'upstream'
const FORK = 'origin'

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const warn = (msg) => console.warn(`[sync-fork-upstream] ${msg}`)

try {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== BRANCH) {
    process.exit(0)
  }
  if (git('status', '--porcelain', '--untracked-files=no')) {
    warn('uncommitted changes; skipping upstream merge')
    process.exit(0)
  }
  git('fetch', '--quiet', UPSTREAM, 'main')
  if (git('rev-list', '--count', `HEAD..${UPSTREAM}/main`) === '0') {
    process.exit(0)
  }
  try {
    git('merge', '--no-edit', `${UPSTREAM}/main`)
    console.log(`[sync-fork-upstream] merged ${UPSTREAM}/main into ${BRANCH}`)
  } catch {
    git('merge', '--abort')
    warn(`merge with ${UPSTREAM}/main conflicts; resolve manually (git merge ${UPSTREAM}/main)`)
    process.exit(0)
  }
  try {
    git('push', '--quiet', FORK, BRANCH)
  } catch {
    warn(`push to ${FORK} failed; run: git push ${FORK} ${BRANCH}`)
  }
} catch (err) {
  warn(`skipped: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
}
