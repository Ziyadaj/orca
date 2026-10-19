/**
 * S10 live check: an unsaved editor draft on a relay-era SSH host, converted to a managed server.
 * Records where the draft is after the converting connect and a reconnect: the host server's
 * hot-exit session (must hold the exact bytes), and the reconnecting desktop editor (recorded, not
 * asserted: the host may publish only `isDirty` to clients, a known gap tracked on its own).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  launchManagedWorkspace,
  skipUnlessManagedDockerHost,
  withManagedHost,
  type ManagedHostFixture
} from './helpers/orcad-managed-workspace'
import { reconnect } from './helpers/orcad-convert-flow'
import { readPersistedProfileState } from './helpers/persisted-profile-state'

skipUnlessManagedDockerHost()

type EditorVerdict = 'present' | 'dirty-only' | 'absent'
type HostVerdict = { verdict: 'present' | 'mismatch' | 'absent'; where: string[] }

function draftOf(marker: string, bytes: number): string {
  const lines: string[] = []
  let length = 0
  for (let line = 0; length < bytes; line += 1) {
    const text = `${marker} unsaved line ${line}\n`
    lines.push(text)
    length += text.length
  }
  return lines.join('').slice(0, bytes)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Every string in `value` equal to, or carrying, the draft, by JSON path. */
function findDraft(value: unknown, draft: string, marker: string): HostVerdict {
  const exact: string[] = []
  const partial: string[] = []
  const walk = (node: unknown, at: string): void => {
    if (typeof node === 'string') {
      if (node === draft) {
        exact.push(at)
      } else if (node.includes(marker)) {
        partial.push(`${at} (${node.length} chars)`)
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${at}[${index}]`))
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(child, at ? `${at}.${key}` : key)
      }
    }
  }
  walk(value, '')
  if (exact.length > 0) {
    return { verdict: 'present', where: exact }
  }
  return partial.length > 0
    ? { verdict: 'mismatch', where: partial }
    : { verdict: 'absent', where: [] }
}

/** The managed server's committed profile, copied off the host so it is read as stored. */
function readHostProfiles(fixture: ManagedHostFixture): Record<string, unknown>[] {
  const { host } = fixture
  const databases = host.exec!(
    `find / -xdev -name profile-state.db -path '*/profiles/*' 2>/dev/null || true`
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const states: Record<string, unknown>[] = []
  for (const database of databases) {
    const profileDir = path.posix.dirname(database)
    const profileId = path.posix.basename(profileDir)
    const local = mkdtempSync(path.join(tmpdir(), 'orca-s10d-host-'))
    try {
      const profilesDir = path.join(local, 'profiles')
      mkdirSync(profilesDir, { recursive: true })
      // The directory carries the WAL beside the database: committed rows may still sit there.
      host.copyFromHost!(profileDir, profilesDir)
      if (readdirSync(path.join(profilesDir, profileId)).includes('profile-state.db')) {
        states.push(readPersistedProfileState(local, profileId))
      }
    } finally {
      rmSync(local, { recursive: true, force: true })
    }
  }
  return states
}

async function readEditorVerdict(
  page: Page,
  filePath: string,
  draft: string
): Promise<{ verdict: EditorVerdict; detail: string }> {
  const seen = await page.evaluate(
    ({ filePath }) => {
      const state = window.__store?.getState()
      const files = (state?.openFiles ?? []).filter((file) => file.filePath === filePath)
      return files.map((file) => ({
        id: file.id,
        worktreeId: file.worktreeId,
        isDirty: file.isDirty,
        draft: state?.editorDrafts[file.id] ?? null
      }))
    },
    { filePath }
  )
  const detail = JSON.stringify(
    seen.map(({ draft: content, ...rest }) => ({
      ...rest,
      draftChars: content?.length ?? null,
      draftSha: content === null ? null : sha256(content)
    }))
  )
  if (seen.some((file) => file.draft === draft)) {
    return { verdict: 'present', detail }
  }
  return { verdict: seen.some((file) => file.isDirty) ? 'dirty-only' : 'absent', detail }
}

function record(testInfo: TestInfo, label: string, line: string): void {
  console.log(`S10D-LIVE ${label} ${line}`)
  testInfo.annotations.push({ type: 'S10D-LIVE', description: `${label} ${line}` })
}

for (const { label, bytes } of [
  // Well inside the 768 KiB signed manifest.
  { label: 'inline', bytes: 2 * 1024 },
  // Over the manifest budget: only the editor-drafts blob can carry it.
  { label: 'blob', bytes: 2 * 1024 * 1024 }
]) {
  test(`an unsaved ${label} editor draft survives conversion to a managed server`, async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
  {}, testInfo) => {
    test.setTimeout(14 * 60_000)
    await withManagedHost(testInfo, async (fixture) => {
      const marker = `S10D_${label.toUpperCase()}_${Date.now()}`
      const draft = draftOf(marker, bytes)
      const { page, seeded } = await launchManagedWorkspace(fixture, {
        seed: { draftContent: draft }
      })
      // A further reconnect: what the editor sees once the converted host is reached again.
      await reconnect(page, seeded.targetId)
      let host: HostVerdict = { verdict: 'absent', where: [] }
      await expect
        .poll(
          () => {
            const found = readHostProfiles(fixture).map((state) => findDraft(state, draft, marker))
            host = found.find((entry) => entry.verdict === 'present') ??
              found.find((entry) => entry.verdict === 'mismatch') ?? {
                verdict: 'absent',
                where: []
              }
            return host.verdict
          },
          { timeout: 60_000 }
        )
        .toBe('present')
        .catch(() => {})
      // The editor may hydrate the moved tab a moment after the reconnect settles.
      let editor = await readEditorVerdict(page, seeded.sessionFilePath, draft)
      await expect
        .poll(
          async () => {
            editor = await readEditorVerdict(page, seeded.sessionFilePath, draft)
            return editor.verdict
          },
          { timeout: 30_000 }
        )
        .toBe('present')
        .catch(() => {})
      record(
        testInfo,
        label,
        `bytes=${draft.length} sha=${sha256(draft)} editor=${editor.verdict} host=${host.verdict} ` +
          `hostAt=${JSON.stringify(host.where)} editorFiles=${editor.detail}`
      )
      await page.screenshot({ path: testInfo.outputPath(`editor-draft-${label}.png`) })
      // Asserted after the record, so a miss still says where the draft did and did not go.
      expect(host.verdict, `the host never held the ${label} draft`).toBe('present')
    })
  })
}
