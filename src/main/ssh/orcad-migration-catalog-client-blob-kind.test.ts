import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcadMigrationBlobChunkRequest,
  OrcadMigrationBlobDescriptor
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
} from '../../shared/orcad-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const sendRequest = vi.hoisted(() => vi.fn())
const status = vi.hoisted((): { capabilities: string[] } => ({ capabilities: [] }))
vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    pairing: unknown,
    method: string,
    params: unknown,
    _timeoutMs: number,
    validate: (response: unknown) => void
  ) => {
    validate({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: { capabilities: status.capabilities }
    })
    return sendRequest(pairing, method, params)
  }
}))

const {
  abortRemoteOrcadMigrationCatalog,
  commitRemoteOrcadMigrationCatalog,
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationBlobChunk,
  stageRemoteOrcadMigrationCatalog
} = await import('./orcad-migration-catalog-client')
const { readRemoteOrcadMigrationCapabilities } =
  await import('./orcad-migration-destination-capabilities')

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

const request: OrcadMigrationBlobChunkRequest = {
  migrationId: 'migration-blob',
  manifestSha256: 'a'.repeat(64),
  blob: {
    blobKind: 'shell-history',
    key: `${'b'.repeat(16)}-zsh`,
    sha256: 'c'.repeat(64),
    byteLength: 3
  },
  offset: 0,
  bytesBase64: 'YWJj'
}

beforeEach(() => {
  vi.clearAllMocks()
  sendRequest.mockResolvedValue({
    ok: true,
    _meta: { runtimeId: 'runtime' },
    result: {
      migrationId: request.migrationId,
      manifestSha256: request.manifestSha256,
      blobKind: 'shell-history',
      key: request.blob.key,
      receivedBytes: 3
    }
  })
})

describe('orcad migration blob chunk capability gate', () => {
  it.each([
    ['an older destination', [ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY]],
    [
      'a destination with only the channel',
      [ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY, ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY]
    ]
  ])('never sends a blob to %s, and names the kind', async (_, capabilities) => {
    status.capabilities = capabilities
    await expect(stageRemoteOrcadMigrationBlobChunk(pairingCode, request)).rejects.toThrow(
      /^orcad_migration_destination_blob_kind_unsupported:shell-history:/
    )
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('sends through its own method once the destination installs the kind', async () => {
    status.capabilities = [
      ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
      'orcad.migration-blob.shell-history.v1'
    ]
    await expect(stageRemoteOrcadMigrationBlobChunk(pairingCode, request)).resolves.toMatchObject({
      receivedBytes: 3
    })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      'orcad.migration.stageBlobChunk',
      request
    )
  })
})

describe('orcad migration commit names its blob set', () => {
  const manifest: OrcadMigrationManifest = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: request.migrationId,
    createdAt: '2026-08-30T12:00:00.000Z',
    source: {
      sshTargetId: 'source',
      sshTargetGeneration: 1,
      targetLabel: 'Source'
    },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    manifestSha256: request.manifestSha256
  }
  const expectedBlobs: OrcadMigrationBlobDescriptor[] = [request.blob]
  const installing = [
    ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
    ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
    'orcad.migration-blob.shell-history.v1'
  ]

  beforeEach(() => {
    sendRequest.mockResolvedValue({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: {
        state: 'staged',
        migrationId: manifest.migrationId,
        manifestSha256: manifest.manifestSha256,
        stagedAt: '2026-08-30T12:00:00.000Z'
      }
    })
  })

  it('sends exactly `{ manifest }` when the move carried no blobs, even to a blob host', async () => {
    for (const capabilities of [[ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY], installing]) {
      status.capabilities = capabilities
      await commitRemoteOrcadMigrationCatalog(pairingCode, manifest)
      await commitRemoteOrcadMigrationCatalog(pairingCode, manifest, {
        expectedBlobs: []
      })
      expect(sendRequest).toHaveBeenLastCalledWith(
        expect.anything(),
        'orcad.migration.commitCatalog',
        { manifest }
      )
    }
  })

  it('names the blobs to a destination with the channel, and never to one without', async () => {
    status.capabilities = installing
    await commitRemoteOrcadMigrationCatalog(pairingCode, manifest, {
      expectedBlobs
    })
    expect(sendRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      'orcad.migration.commitCatalog',
      { manifest, expectedBlobs }
    )

    sendRequest.mockClear()
    status.capabilities = [ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY]
    await expect(
      commitRemoteOrcadMigrationCatalog(pairingCode, manifest, {
        expectedBlobs
      })
    ).rejects.toThrow(/^orcad_migration_destination_blob_kind_unsupported:shell-history:/)
    expect(sendRequest).not.toHaveBeenCalled()
  })
})

describe('a manifest that sheds drafts into the blob', () => {
  const declared: OrcadMigrationManifest = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-drafts',
    createdAt: '2026-10-01T12:00:00.000Z',
    source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel: 'Source' },
    payload: {
      repositories: [],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        editorDraftsBlob: {
          sha256: 'd'.repeat(64),
          byteLength: 10,
          entries: [{ worktreeKey: 'repo::/srv', filePath: '/srv/a.ts' }]
        }
      }
    },
    manifestSha256: 'e'.repeat(64)
  }
  const staged = {
    ok: true,
    _meta: { runtimeId: 'runtime' },
    result: {
      state: 'absent',
      migrationId: declared.migrationId,
      manifestSha256: declared.manifestSha256
    }
  }

  it('is never staged or committed on a host whose parser would drop the declaration', async () => {
    // An old-schema host: catalog and blob channel, but no drafts kind.
    status.capabilities = [
      ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY
    ]
    sendRequest.mockResolvedValue(staged)
    await expect(stageRemoteOrcadMigrationCatalog(pairingCode, declared)).rejects.toThrow(
      /^orcad_migration_destination_blob_kind_unsupported:editor-drafts:/
    )
    await expect(commitRemoteOrcadMigrationCatalog(pairingCode, declared)).rejects.toThrow(
      /^orcad_migration_destination_blob_kind_unsupported:editor-drafts:/
    )
    expect(sendRequest).not.toHaveBeenCalled()

    // Recovery still asks and aborts by the same signed manifest.
    await readRemoteOrcadMigrationCatalogState(pairingCode, declared)
    sendRequest.mockResolvedValueOnce({ ...staged, result: { ...staged.result, aborted: true } })
    await abortRemoteOrcadMigrationCatalog(pairingCode, declared)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual([
      'orcad.migration.catalogState',
      'orcad.migration.abortCatalog'
    ])
  })

  it('goes to a host that advertises the drafts kind, and reads its capabilities', async () => {
    status.capabilities = [
      ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
      'orcad.migration-blob.editor-drafts.v1'
    ]
    sendRequest.mockResolvedValue(staged)
    await stageRemoteOrcadMigrationCatalog(pairingCode, declared)
    expect(sendRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      'orcad.migration.stageCatalog',
      { manifest: declared }
    )
    sendRequest.mockResolvedValue({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: { capabilities: status.capabilities }
    })
    await expect(readRemoteOrcadMigrationCapabilities(pairingCode)).resolves.toEqual(
      status.capabilities
    )
  })
})
