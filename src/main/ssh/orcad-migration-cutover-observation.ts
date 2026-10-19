/**
 * What the destination proved about one journaled migration, and the journal moves that follow from
 * it. A lost answer is re-read, never assumed; only a flushing acknowledgement proves a commit.
 */
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import type {
  OrcadMigrationSourceCutover,
  OrcadMigrationSourceCutoverPhase
} from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type {
  OrcadMigrationCutoverContext,
  OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import { writeOrcadMigrationSourceCutover } from './orcad-migration-cutover-journal'
import {
  editorDraftsExpectedBlobs,
  isEditorDraftsUnsupported
} from './orcad-migration-editor-drafts-cutover'

/**
 * A committed read may come from memory the server never flushed; only commit()'s acknowledgement,
 * which flushes before it answers, may move the journal to committed.
 */
export async function confirmDurableCommit(
  destination: OrcadMigrationDestinationCatalog,
  manifest: OrcadMigrationManifest,
  observed: Extract<OrcadMigrationCatalogState, { state: 'committed' }>
): Promise<OrcadMigrationCatalogState> {
  let state: OrcadMigrationCatalogState
  try {
    state = await destination.commit(manifest, editorDraftsExpectedBlobs(manifest))
  } catch (error) {
    // Never replayed to a host without the drafts kind. It never received this commit, and after
    // a restart reads only disk, so its committed answer is the newer build's flushed commit.
    if (isEditorDraftsUnsupported(error)) {
      return observed
    }
    throw error
  }
  if (state.state !== 'committed') {
    throw new Error(`orcad_migration_commit_not_committed:${state.state}`)
  }
  return state
}

/** Moves the journal to what the destination reported; durable before it returns. */
export function recordObservedState(
  context: OrcadMigrationCutoverContext,
  cutover: OrcadMigrationSourceCutover,
  state: OrcadMigrationCatalogState
): OrcadMigrationSourceCutover {
  if (state.state === 'absent') {
    throw new Error('orcad_migration_destination_catalog_absent')
  }
  if (
    state.migrationId !== cutover.migrationId ||
    state.manifestSha256 !== cutover.manifestSha256
  ) {
    throw new Error('orcad_migration_destination_state_mismatch')
  }
  if (
    state.state === 'committed' &&
    (state.receipt.migrationId !== cutover.migrationId ||
      state.receipt.manifestSha256 !== cutover.manifestSha256)
  ) {
    throw new Error('orcad_migration_destination_receipt_mismatch')
  }
  const phase: OrcadMigrationSourceCutoverPhase =
    state.state === 'committed' ? 'destination-committed' : 'destination-staged'
  if (phase === cutover.phase) {
    return cutover
  }
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    // Why: a journal never moves back from a proven commit.
    return cutover
  }
  const next: OrcadMigrationSourceCutover = {
    ...cutover,
    phase,
    updatedAt: (context.now ?? (() => new Date()))().toISOString()
  }
  writeOrcadMigrationSourceCutover(context.userDataPath, next)
  return next
}

export async function abortWithRecovery(
  destination: OrcadMigrationDestinationCatalog,
  manifest: OrcadMigrationManifest
): Promise<OrcadMigrationCatalogState> {
  try {
    return await destination.abort(manifest)
  } catch (abortError) {
    try {
      const observed = await destination.readState(manifest)
      if (observed.state === 'committed') {
        return observed
      }
      if (observed.state === 'absent') {
        // An absent read may predate the flush; a repeated abort proves it durable.
        return await destination.abort(manifest)
      }
    } catch {
      // Still unverifiable: keep the first failure and the fence.
    }
    throw abortError
  }
}
