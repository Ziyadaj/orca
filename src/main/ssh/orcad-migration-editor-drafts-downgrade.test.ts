import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseOrcadMigrationEditorDraftsBytes } from '../../shared/orcad-migration/orcad-migration-editor-drafts'
import { closeTestStores } from '../persistence-test-harness'
import type { Store } from '../persistence/loading-store/store'
import {
  commitOrcadMigrationDestination,
  stageOrcadMigrationDestination,
  type OrcadMigrationCutoverContext
} from './orcad-migration-cutover-coordinator'
import {
  listOrcadMigrationSourceCutovers,
  orcadMigrationCutoverJournalDirectory
} from './orcad-migration-cutover-journal'
import {
  DRAFTS_TARGET,
  DRAFTS_WORKTREE,
  downgradableDestination,
  draftsOf,
  draftsUserDataPath,
  openDraftsDesktop,
  saveDrafts,
  sidecarFiles
} from './orcad-migration-editor-drafts-fixture'
import { installOrcadMigrationScrollbackRetention } from './orcad-migration-scrollback-retention-wiring'
import { fenceOrcadMigrationSource } from './orcad-migration-source-fence'
import { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function fenced(drafts: Record<string, string | undefined>) {
  const userDataPath = draftsUserDataPath(directories)
  const store = openDraftsDesktop(userDataPath)
  saveDrafts(store, drafts)
  installOrcadMigrationScrollbackRetention(userDataPath, store)
  const claims = new SshTargetOrcadClaims(store)
  const result = await fenceOrcadMigrationSource({
    userDataPath,
    store,
    claims,
    targetId: DRAFTS_TARGET.id,
    destinationEnvironmentId: 'env-1',
    destinationName: 'Managed',
    terminalProof: { verdict: 'exited', provenPtyIds: [] }
  })
  if (result.outcome !== 'fenced') {
    throw new Error('expected a fence')
  }
  const { destination, host } = downgradableDestination()
  const contextFor = (desktop: Store): OrcadMigrationCutoverContext => ({
    userDataPath,
    store: desktop,
    claims: new SshTargetOrcadClaims(desktop),
    destination
  })
  const journal = () => listOrcadMigrationSourceCutovers(userDataPath)[0]!
  return {
    userDataPath,
    store,
    destination,
    host,
    context: contextFor(store),
    contextFor,
    migrationId: result.cutover.migrationId,
    journal
  }
}

function inlineDrafts(h: Awaited<ReturnType<typeof fenced>>): Record<string, string> {
  const files = h.journal().manifest.payload.dormantState?.workspaceSession?.openFilesByWorktree
  return Object.fromEntries(
    (files?.[DRAFTS_WORKTREE] ?? []).flatMap((file) =>
      file.dirtyDraftContent === undefined ? [] : [[file.relativePath, file.dirtyDraftContent]]
    )
  )
}

function committedManifests(h: Awaited<ReturnType<typeof fenced>>) {
  return h.destination.commit.mock.calls.map(([manifest]) => manifest)
}

describe('a host that loses the drafts kind mid-move', () => {
  it('staged: aborts, then commits the live drafts inline under the same id', async () => {
    const h = await fenced({ 'a.ts': 'journaled a', 'b.ts': undefined })
    const declared = h.journal().manifest
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    expect(
      draftsOf(
        parseOrcadMigrationEditorDraftsBytes(
          h.destination.blobBytes.get(h.migrationId)!,
          declared.payload.dormantState!.editorDraftsBlob!
        )
      )
    ).toEqual({ 'a.ts': 'journaled a' })
    // The source stays authoritative: what the user typed since is what a re-export carries.
    saveDrafts(h.store, { 'a.ts': 'typed after the abort', 'b.ts': undefined })
    h.host.takesDrafts = false

    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-committed'
    })
    expect(h.destination.abort).toHaveBeenCalledTimes(1)
    expect(h.journal().migrationId).toBe(h.migrationId)
    expect(h.journal().manifestSha256).not.toBe(declared.manifestSha256)
    expect(h.journal().manifest.payload.dormantState?.editorDraftsBlob).toBeUndefined()
    expect(inlineDrafts(h)).toEqual({ 'a.ts': 'typed after the abort' })
    expect(committedManifests(h).some((m) => m.payload.dormantState?.editorDraftsBlob)).toBe(false)
    expect(sidecarFiles(h.userDataPath)).toEqual([])
  })

  it('absent: re-exports inline without an abort', async () => {
    const h = await fenced({ 'a.ts': 'never staged' })
    h.host.takesDrafts = false
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-committed'
    })
    expect(h.destination.abort).not.toHaveBeenCalled()
    expect(inlineDrafts(h)).toEqual({ 'a.ts': 'never staged' })
  })

  it('committed: takes the commit the newer build flushed, without replaying it', async () => {
    const h = await fenced({ 'a.ts': 'committed draft' })
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    const commit = h.destination.commit.getMockImplementation()!
    // The commit flushes, then the reply is lost and the host comes back older.
    h.destination.commit.mockImplementationOnce(async (manifest, blobs) => {
      await commit(manifest, blobs)
      h.host.takesDrafts = false
      throw new Error('socket closed')
    })
    h.destination.readState.mockRejectedValueOnce(new Error('socket closed'))
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'socket closed'
    )
    expect(h.journal().phase).toBe('destination-staged')

    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-committed'
    })
    expect(h.destination.commits).toBe(1)
    expect(h.destination.abort).not.toHaveBeenCalled()
    // Only the newer host ever saw a commit naming the drafts, and it named the blob.
    expect(h.destination.commit.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ blobKind: 'editor-drafts', key: 'drafts' })
    ])
  })

  it('unverifiable: keeps the journal and the drafts, and says to reconnect', async () => {
    const h = await fenced({ 'a.ts': 'kept' })
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    const sidecar = sidecarFiles(h.userDataPath)
    h.host.takesDrafts = false
    const readState = h.destination.readState.getMockImplementation()!
    let refused = 0
    // The host answers until it refuses the drafts; the state query that would settle it is lost.
    h.destination.readState.mockImplementation(async (manifest) => {
      if (refused >= 2) {
        throw new Error('socket closed')
      }
      return readState(manifest)
    })
    const stage = h.destination.stage.getMockImplementation()!
    h.destination.stage.mockImplementation(async (manifest) => {
      refused += 1
      return stage(manifest)
    })
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      /orcad_migration_editor_drafts_state_unverifiable:.*Reconnect to retry/
    )
    expect(h.journal().manifest.payload.dormantState?.editorDraftsBlob).toBeDefined()
    expect(sidecarFiles(h.userDataPath)).toEqual(sidecar)
    expect(h.destination.abort).not.toHaveBeenCalled()
  })

  it('fails clearly and names the drafts when they no longer fit inline; the source keeps them', async () => {
    const big = 'x'.repeat(900 * 1024)
    const h = await fenced({ 'big.ts': big })
    h.host.takesDrafts = false
    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      /Unsaved changes .* \/srv\/app\/big\.ts.*orcad_migration_manifest_too_large/
    )
    expect(h.destination.commits).toBe(0)
    expect(
      h.store.getWorkspaceSession(`ssh:${DRAFTS_TARGET.id}`).openFilesByWorktree?.[
        DRAFTS_WORKTREE
      ]?.[0]?.dirtyDraftContent
    ).toBe(big)
  })

  it('resumes after a desktop restart from the journal and its sidecar', async () => {
    const h = await fenced({ 'a.ts': 'before restart' })
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    await h.store.flushPendingOrThrowAsync()
    await closeTestStores()
    const restarted = openDraftsDesktop(h.userDataPath, false)
    installOrcadMigrationScrollbackRetention(h.userDataPath, restarted)
    expect(sidecarFiles(h.userDataPath)).toHaveLength(2)
    h.host.takesDrafts = false

    await expect(
      commitOrcadMigrationDestination(h.contextFor(restarted), h.migrationId)
    ).resolves.toMatchObject({ phase: 'destination-committed' })
    expect(inlineDrafts(h)).toEqual({ 'a.ts': 'before restart' })
  })
})

describe('a journal an older desktop rewrote', () => {
  /** What an older parser writes back: the declaration dropped, so the digest no longer holds. */
  function rollBack(h: Awaited<ReturnType<typeof fenced>>): void {
    const path = join(
      orcadMigrationCutoverJournalDirectory(h.userDataPath),
      `${h.migrationId}.json`
    )
    const record = JSON.parse(readFileSync(path, 'utf8'))
    delete record.manifest.payload.dormantState.editorDraftsBlob
    writeFileSync(path, JSON.stringify(record))
  }

  it('is asked and aborted by its signed copy, then re-exported from the live source', async () => {
    const h = await fenced({ 'a.ts': 'rolled back' })
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    rollBack(h)
    saveDrafts(h.store, { 'a.ts': 'after the upgrade' })

    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).resolves.toMatchObject({
      phase: 'destination-committed'
    })
    expect(h.destination.abort).toHaveBeenCalledTimes(1)
    // Re-exported for a host that still takes the blob, so the live draft goes shed again.
    expect(
      draftsOf(
        parseOrcadMigrationEditorDraftsBytes(
          h.destination.blobBytes.get(h.migrationId)!,
          h.journal().manifest.payload.dormantState!.editorDraftsBlob!
        )
      )
    ).toEqual({ 'a.ts': 'after the upgrade' })
  })

  it('stays unverifiable, with nothing aborted, when the signed copy is gone too', async () => {
    const h = await fenced({ 'a.ts': 'rolled back' })
    await stageOrcadMigrationDestination(h.context, h.migrationId)
    rollBack(h)
    rmSync(join(h.userDataPath, 'orcad-migration-editor-drafts'), { recursive: true })

    await expect(commitOrcadMigrationDestination(h.context, h.migrationId)).rejects.toThrow(
      'orcad_migration_editor_drafts_state_unverifiable'
    )
    expect(h.destination.abort).not.toHaveBeenCalled()
    expect(h.journal().phase).toBe('destination-staged')
  })
})
