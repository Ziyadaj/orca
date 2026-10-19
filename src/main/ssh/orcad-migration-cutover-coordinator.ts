/**
 * Staging, committing and aborting a dormant migration on its destination orcad.
 *
 * The source stays authoritative until the destination proves a commit: before every stage and
 * commit the fenced source must still export the journaled manifest and carry no state the
 * manifest cannot. A lost answer is never read as success or as absence; the destination's
 * catalog state is re-read, and only that observation moves the journal, which is on disk before
 * anything is returned. A committed destination is never released.
 */
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration/orcad-migration-scrollback'
import type {
  OrcadMigrationBlobChunkRequest,
  OrcadMigrationBlobChunkResult,
  OrcadMigrationBlobDescriptor
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import { resolveDurableOrcadCatalogMutation } from './orcad-catalog-durable-mutation'
import { ORCAD_MIGRATION_DESTINATION_UNSUPPORTED } from './orcad-migration-catalog-client'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import {
  abortWithRecovery,
  confirmDurableCommit,
  recordObservedState
} from './orcad-migration-cutover-observation'
import { replaceUndeliverableDrafts } from './orcad-migration-editor-drafts-recovery'
import type { OrcadMigrationSourceCutoverPort } from './orcad-migration-source'
import {
  transferOrcadMigrationSnapshots,
  type OrcadMigrationSnapshotSource
} from './orcad-migration-snapshot-coordinator'
import type { OrcadMigrationPreflightStore } from './targets/ssh-target-orcad-preflight'
import { sshRelayMigrationCutoverPort } from './orcad-migration-ssh-relay-source'
import type { SshTargetOrcadClaims } from './targets/ssh-target-orcad-claims'
import {
  editorDraftsExpectedBlobs,
  isEditorDraftsUndeliverable,
  orcadMigrationManifestMatchesDigest,
  transferJournaledEditorDrafts
} from './orcad-migration-editor-drafts-cutover'

/** The destination's catalog operations, served by the T6-9 orcad.migration.* client. */
export type OrcadMigrationDestinationCatalog = {
  readState: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  stage: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogState>
  /** `expectedBlobs` names what the commit must find received; the host refuses one missing any. */
  commit: (
    manifest: OrcadMigrationManifest,
    expectedBlobs?: readonly OrcadMigrationBlobDescriptor[]
  ) => Promise<OrcadMigrationCatalogState>
  abort: (manifest: OrcadMigrationManifest) => Promise<OrcadMigrationCatalogAbortResult>
  stageChunk: (
    request: OrcadMigrationSnapshotChunkRequest
  ) => Promise<OrcadMigrationSnapshotChunkResult>
  readCapabilities: () => Promise<readonly string[]>
  stageBlobChunk: (
    request: OrcadMigrationBlobChunkRequest
  ) => Promise<OrcadMigrationBlobChunkResult>
}

export type OrcadMigrationCutoverContext = {
  userDataPath: string
  store: OrcadMigrationPreflightStore & OrcadMigrationSnapshotSource
  claims: SshTargetOrcadClaims
  destination: OrcadMigrationDestinationCatalog
  /** Rebuilt for every check when `store` is a copy that would never see a later edit. */
  freshSource?: () => OrcadMigrationPreflightStore
  /** The fenced source; defaults to the relay-era SSH target the journal names. */
  source?: OrcadMigrationSourceCutoverPort
  now?: () => Date
}

function cutoverSource(context: OrcadMigrationCutoverContext): OrcadMigrationSourceCutoverPort {
  return context.source ?? sshRelayMigrationCutoverPort(context)
}

export async function stageOrcadMigrationDestination(
  context: OrcadMigrationCutoverContext,
  migrationId: string
): Promise<OrcadMigrationSourceCutover> {
  let cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return cutover
  }
  assertSourceUnchanged(context, cutover)
  const { destination } = context
  const read = await destination.readState(cutover.manifest)
  const state =
    read.state === 'committed'
      ? await confirmDurableCommit(destination, cutover.manifest, read)
      : await resolveDurableOrcadCatalogMutation(
          () => destination.stage(cutover.manifest),
          () => destination.readState(cutover.manifest),
          (observed) => observed.state !== 'absent'
        )
  cutover = recordObservedState(context, cutover, state)
  if (state.state === 'staged') {
    await transferOrcadMigrationSnapshots({
      source: context.store,
      manifest: cutover.manifest,
      state,
      destination: { readState: destination.readState, stageChunk: destination.stageChunk }
    })
    await transferJournaledEditorDrafts(context, cutover)
  }
  return cutover
}

export async function commitOrcadMigrationDestination(
  context: OrcadMigrationCutoverContext,
  migrationId: string
): Promise<OrcadMigrationSourceCutover> {
  const cutover = requireCutover(context.userDataPath, migrationId)
  // An older desktop's rewrite drops the drafts declaration, so the host would refuse the digest.
  if (!isCommitted(cutover) && !orcadMigrationManifestMatchesDigest(cutover.manifest)) {
    await replaceUndeliverableDrafts(context, cutoverSource(context), cutover)
    return stageAndCommit(context, migrationId)
  }
  try {
    return await stageAndCommit(context, migrationId)
  } catch (error) {
    if (!isEditorDraftsUndeliverable(error)) {
      throw error
    }
    const replaced = await replaceUndeliverableDrafts(
      context,
      cutoverSource(context),
      requireCutover(context.userDataPath, migrationId)
    )
    return isCommitted(replaced) ? replaced : stageAndCommit(context, migrationId)
  }
}

async function stageAndCommit(
  context: OrcadMigrationCutoverContext,
  migrationId: string
): Promise<OrcadMigrationSourceCutover> {
  const staged = await stageOrcadMigrationDestination(context, migrationId)
  if (staged.phase !== 'destination-staged') {
    return staged
  }
  assertSourceUnchanged(context, staged)
  const { destination } = context
  // Why re-read: a lost commit reply may hide a commit that landed; the read decides.
  const state = await resolveDurableOrcadCatalogMutation(
    () => destination.commit(staged.manifest, editorDraftsExpectedBlobs(staged.manifest)),
    () => destination.readState(staged.manifest),
    (observed) => observed.state === 'committed'
  )
  if (state.state !== 'committed') {
    throw new Error(`orcad_migration_commit_not_committed:${state.state}`)
  }
  return recordObservedState(context, staged, state)
}

export type OrcadMigrationAbortResult =
  | { outcome: 'released'; evidence: 'catalog-absent' | 'destination-unsupported' }
  | { outcome: 'refused'; code: string; reason: string }

/**
 * Releases the source only on proof the destination holds nothing of this migration. `release`
 * defaults to dropping the fence and journal; a delta move keeps the fence instead.
 */
export async function abortOrcadMigrationCutover(
  context: OrcadMigrationCutoverContext,
  migrationId: string,
  release: (cutover: OrcadMigrationSourceCutover) => Promise<void> = (cutover) =>
    cutoverSource(context).releaseFence(cutover)
): Promise<OrcadMigrationAbortResult> {
  const cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return committedRefusal()
  }
  const { destination } = context
  let state: OrcadMigrationCatalogState
  try {
    state = await destination.readState(cutover.manifest)
  } catch (error) {
    // Unsupported means nothing could have been staged, but only if nothing ever was.
    if (isDestinationUnsupported(error) && cutover.phase === 'source-fenced') {
      await release(cutover)
      return { outcome: 'released', evidence: 'destination-unsupported' }
    }
    throw error
  }
  if (state.state !== 'committed') {
    state = await abortWithRecovery(destination, cutover.manifest)
  }
  if (state.state === 'committed') {
    recordObservedState(
      context,
      cutover,
      await confirmDurableCommit(destination, cutover.manifest, state)
    )
    return committedRefusal()
  }
  if (state.state !== 'absent') {
    throw new Error(`orcad_migration_abort_not_absent:${state.state}`)
  }
  await release(cutover)
  return { outcome: 'released', evidence: 'catalog-absent' }
}

function assertSourceUnchanged(
  context: OrcadMigrationCutoverContext,
  cutover: OrcadMigrationSourceCutover
): void {
  cutoverSource(context).verifyFence(cutover)
}

function isCommitted(cutover: OrcadMigrationSourceCutover): boolean {
  return cutover.phase === 'destination-committed' || cutover.phase === 'source-retired'
}

function requireCutover(userDataPath: string, migrationId: string): OrcadMigrationSourceCutover {
  const cutover = listOrcadMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover) {
    throw new Error('orcad_migration_source_cutover_not_found')
  }
  return cutover
}

function committedRefusal(): OrcadMigrationAbortResult {
  return {
    outcome: 'refused',
    code: 'orcad_migration_committed_source_cannot_be_released',
    reason: 'The managed server already holds this migration; it can only move forward.'
  }
}

function isDestinationUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message === ORCAD_MIGRATION_DESTINATION_UNSUPPORTED
}
