/**
 * Recovering a journaled manifest whose shed drafts can't reach the host as declared: the host lost
 * the drafts kind, the desktop's copy is gone, or an older desktop rewrote the journal. The source
 * stays authoritative until commit, so the replacement is the live source re-exported.
 */
import type { OrcadMigrationCatalogState } from '../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import type { OrcadMigrationCutoverContext } from './orcad-migration-cutover-coordinator'
import {
  abortWithRecovery,
  confirmDurableCommit,
  recordObservedState
} from './orcad-migration-cutover-observation'
import {
  journalOrcadMigrationExport,
  orcadMigrationManifestMatchesDigest,
  readsEditorDrafts,
  unverifiableEditorDraftsState
} from './orcad-migration-editor-drafts-cutover'
import { readOrcadMigrationSignedManifestSidecar } from './orcad-migration-editor-drafts-sidecar'
import type { OrcadMigrationSourceCutoverPort } from './orcad-migration-source'

/**
 * A drafts-declaring manifest the host can no longer take, whose sidecar is gone, or whose journal
 * copy an older desktop rewrote. Settles the host's copy first, then re-journals the live source
 * under the same id; the drafts ride inline unless the host still takes the blob.
 */
export async function replaceUndeliverableDrafts(
  context: OrcadMigrationCutoverContext,
  source: OrcadMigrationSourceCutoverPort,
  cutover: OrcadMigrationSourceCutover
): Promise<OrcadMigrationSourceCutover> {
  const { destination, userDataPath } = context
  const hostManifest = orcadMigrationManifestMatchesDigest(cutover.manifest)
    ? cutover.manifest
    : readOrcadMigrationSignedManifestSidecar(userDataPath, cutover)
  if (!hostManifest) {
    // Without the signed bytes the host can't be asked, so nothing is aborted.
    throw unverifiableEditorDraftsState(new Error('orcad_migration_signed_manifest_missing'))
  }
  let state: OrcadMigrationCatalogState
  let shedDrafts: boolean
  try {
    state = await destination.readState(hostManifest)
    if (state.state === 'staged') {
      state = await abortWithRecovery(destination, hostManifest)
    }
    shedDrafts = state.state === 'absent' && (await readsEditorDrafts(destination))
  } catch (error) {
    throw unverifiableEditorDraftsState(error)
  }
  if (state.state === 'committed') {
    return recordObservedState(
      context,
      { ...cutover, manifest: hostManifest },
      await confirmDurableCommit(destination, hostManifest, state)
    )
  }
  if (state.state !== 'absent') {
    throw unverifiableEditorDraftsState(new Error(`orcad_migration_state_${state.state}`))
  }
  const replacement = source.exportReplacement(cutover, { shedDrafts })
  return journalOrcadMigrationExport(userDataPath, replacement, {
    ...cutover,
    phase: 'source-fenced',
    updatedAt: (context.now ?? (() => new Date()))().toISOString()
  })
}
