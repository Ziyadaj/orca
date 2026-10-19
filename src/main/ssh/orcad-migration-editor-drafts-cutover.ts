/**
 * The desktop half of a cutover whose manifest sheds drafts into an `editor-drafts` blob: journal
 * the bytes before the manifest, send them from that copy only, and name them in the commit.
 */
import {
  ORCAD_MIGRATION_DESTINATION_BLOB_KIND_UNSUPPORTED,
  findUnsupportedMigrationBlobKind,
  type OrcadMigrationBlobDescriptor
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration/orcad-migration-source-cutover'
import { errorMessage } from '../../shared/error-message'
import { translateMain } from '../i18n/main-i18n'
import { assertOrcadMigrationManifestDigest } from '../orcad/orcad-migration-manifest-digest'
import { transferOrcadMigrationBlobs } from './orcad-migration-blob-coordinator'
import { writeOrcadMigrationSourceCutover } from './orcad-migration-cutover-journal'
import type {
  OrcadMigrationCutoverContext,
  OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import { orcadMigrationEditorDraftsDescriptor } from './orcad-migration-editor-drafts-shed'
import {
  readOrcadMigrationEditorDraftsSidecar,
  writeOrcadMigrationEditorDraftsSidecar
} from './orcad-migration-editor-drafts-sidecar'
import type { OrcadMigrationExport } from './orcad-migration-manifest-export'

const SIDECAR_MISSING = 'orcad_migration_editor_drafts_sidecar_missing'
const STATE_UNVERIFIABLE = 'orcad_migration_editor_drafts_state_unverifiable'

export function editorDraftsExpectedBlobs(
  manifest: OrcadMigrationManifest
): OrcadMigrationBlobDescriptor[] {
  const declaration = manifest.payload.dormantState?.editorDraftsBlob
  return declaration ? [orcadMigrationEditorDraftsDescriptor(declaration)] : []
}

export async function readsEditorDrafts(
  destination: Pick<OrcadMigrationDestinationCatalog, 'readCapabilities'>
): Promise<boolean> {
  const capabilities = await destination.readCapabilities()
  return findUnsupportedMigrationBlobKind([{ blobKind: 'editor-drafts' }], capabilities) === null
}

/** The host refused the drafts kind before anything was sent. */
export function isEditorDraftsUnsupported(error: unknown): boolean {
  return errorMessage(error).includes(
    `${ORCAD_MIGRATION_DESTINATION_BLOB_KIND_UNSUPPORTED}:editor-drafts`
  )
}

/** This journaled manifest's drafts can't reach the host; only a replacement manifest can. */
export function isEditorDraftsUndeliverable(error: unknown): boolean {
  return isEditorDraftsUnsupported(error) || errorMessage(error).includes(SIDECAR_MISSING)
}

export function orcadMigrationManifestMatchesDigest(manifest: OrcadMigrationManifest): boolean {
  try {
    assertOrcadMigrationManifestDigest(manifest)
    return true
  } catch {
    return false
  }
}

export function unverifiableEditorDraftsState(cause: unknown): Error {
  return new Error(
    `${STATE_UNVERIFIABLE}:${translateMain(
      'managedServerMigration.draftsStateUnverifiable',
      "Orca can't confirm this host's migration state, so your unsaved changes stay on this computer. Reconnect to retry."
    )} (${errorMessage(cause)})`
  )
}

/** Drafts first, then the journal that names them: a journaled manifest always has its bytes. */
export function journalOrcadMigrationExport(
  userDataPath: string,
  exported: OrcadMigrationExport,
  cutover: Omit<OrcadMigrationSourceCutover, 'manifest' | 'manifestSha256'>
): OrcadMigrationSourceCutover {
  const journaled: OrcadMigrationSourceCutover = {
    ...cutover,
    manifestSha256: exported.manifest.manifestSha256,
    manifest: exported.manifest
  }
  if (exported.editorDrafts) {
    writeOrcadMigrationEditorDraftsSidecar(userDataPath, exported.manifest, exported.editorDrafts)
  }
  writeOrcadMigrationSourceCutover(userDataPath, journaled)
  return journaled
}

/** From the journaled copy, never the live session: a closed tab still sends what was signed. */
export async function transferJournaledEditorDrafts(
  context: Pick<OrcadMigrationCutoverContext, 'userDataPath' | 'destination'>,
  cutover: OrcadMigrationSourceCutover
): Promise<void> {
  const [descriptor] = editorDraftsExpectedBlobs(cutover.manifest)
  if (!descriptor) {
    return
  }
  const bytes = readOrcadMigrationEditorDraftsSidecar(context.userDataPath, cutover, descriptor)
  if (!bytes) {
    throw new Error(SIDECAR_MISSING)
  }
  const { destination } = context
  await transferOrcadMigrationBlobs({
    source: {
      readChunk: async (_blob, offset, maxBytes) => bytes.subarray(offset, offset + maxBytes)
    },
    manifest: cutover.manifest,
    blobs: [descriptor],
    destination: {
      readCapabilities: destination.readCapabilities,
      readState: destination.readState,
      stageChunk: destination.stageBlobChunk
    }
  })
}
