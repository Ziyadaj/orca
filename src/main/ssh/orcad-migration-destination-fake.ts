import { vi, type Mock } from 'vitest'
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  advertisedOrcadMigrationBlobCapabilities,
  type OrcadMigrationBlobUploadState
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import { ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import type { OrcadMigrationDestinationCatalog } from './orcad-migration-cutover-coordinator'

type Catalog = OrcadMigrationDestinationCatalog

export type FakeOrcadMigrationDestination = {
  commits: number
  /** Every blob's received bytes, by migration id; cleared by an abort. */
  blobBytes: Map<string, Buffer>
} & {
  [Method in keyof Catalog]: Mock<Catalog[Method]>
}

/**
 * An in-memory destination with the T6-9 semantics: idempotent stage, receipt-keyed commit, one
 * catalog state per migration so a delta move after a first migration starts absent.
 */
export function fakeOrcadMigrationDestination(): FakeOrcadMigrationDestination {
  const states = new Map<string, 'absent' | 'staged' | 'committed'>()
  const uploads = new Map<string, OrcadMigrationBlobUploadState>()
  const stateOf = (manifest: OrcadMigrationManifest) => states.get(manifest.migrationId) ?? 'absent'
  const view = (manifest: OrcadMigrationManifest): OrcadMigrationCatalogState => {
    const state = stateOf(manifest)
    const base = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    if (state === 'committed') {
      return {
        ...base,
        state,
        receipt: {
          version: 1,
          migrationId: manifest.migrationId,
          manifestSha256: manifest.manifestSha256,
          source: manifest.source,
          importedAt: '2026-10-01T00:00:00.000Z',
          repositoryIds: [],
          projectGroupIds: [],
          folderWorkspaceIds: []
        }
      }
    }
    const upload = uploads.get(manifest.migrationId)
    return state === 'staged'
      ? {
          ...base,
          state,
          stagedAt: '2026-10-01T00:00:00.000Z',
          snapshotUploads: [],
          ...(upload ? { blobUploads: [{ ...upload }] } : {})
        }
      : { ...base, state }
  }
  const destination: FakeOrcadMigrationDestination = {
    commits: 0,
    blobBytes: new Map(),
    readState: vi.fn<Catalog['readState']>(async (manifest: OrcadMigrationManifest) =>
      view(manifest)
    ),
    stage: vi.fn<Catalog['stage']>(async (manifest: OrcadMigrationManifest) => {
      if (stateOf(manifest) === 'absent') {
        states.set(manifest.migrationId, 'staged')
      }
      return view(manifest)
    }),
    commit: vi.fn<Catalog['commit']>(async (manifest: OrcadMigrationManifest) => {
      if (stateOf(manifest) === 'staged') {
        states.set(manifest.migrationId, 'committed')
        destination.commits += 1
      }
      return view(manifest)
    }),
    abort: vi.fn<Catalog['abort']>(async (manifest: OrcadMigrationManifest) => {
      const aborted = stateOf(manifest) === 'staged'
      if (aborted) {
        states.set(manifest.migrationId, 'absent')
        uploads.delete(manifest.migrationId)
        destination.blobBytes.delete(manifest.migrationId)
      }
      return { ...view(manifest), aborted, ...(aborted ? {} : { durableAbsent: true as const }) }
    }),
    stageChunk: vi.fn<Catalog['stageChunk']>(),
    readCapabilities: vi.fn<Catalog['readCapabilities']>(async () => [
      ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      ...advertisedOrcadMigrationBlobCapabilities()
    ]),
    stageBlobChunk: vi.fn<Catalog['stageBlobChunk']>(async (request) => {
      const bytes = Buffer.concat([
        destination.blobBytes.get(request.migrationId)?.subarray(0, request.offset) ??
          Buffer.alloc(0),
        Buffer.from(request.bytesBase64, 'base64')
      ])
      destination.blobBytes.set(request.migrationId, bytes)
      uploads.set(request.migrationId, { ...request.blob, receivedBytes: bytes.length })
      return {
        migrationId: request.migrationId,
        manifestSha256: request.manifestSha256,
        blobKind: request.blob.blobKind,
        key: request.blob.key,
        receivedBytes: bytes.length
      }
    })
  }
  return destination
}
