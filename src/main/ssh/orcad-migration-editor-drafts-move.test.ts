import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { advertisedOrcadMigrationBlobCapabilities } from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import { parseOrcadMigrationEditorDraftsBytes } from '../../shared/orcad-migration/orcad-migration-editor-drafts'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import { ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  commitStagedOrcadMigrationCatalogDurably,
  stageOrcadMigrationCatalogDurably
} from '../runtime/orcad-migration-catalog-import'
import { SshConnectionStore } from './connection/ssh-connection-store'
import type { OrcadMigrationDestinationCatalog } from './orcad-migration-cutover-coordinator'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import {
  DRAFTS_HOST,
  DRAFTS_TARGET,
  DRAFTS_WORKTREE,
  draftsUserDataPath,
  openDraftsDesktop,
  saveDrafts,
  sidecarFiles
} from './orcad-migration-editor-drafts-fixture'
import { installOrcadMigrationScrollbackRetention } from './orcad-migration-scrollback-retention-wiring'
import { runOrcadDeltaMove } from './orcad-migration-delta-move'
import { reconcileManagedOrcadSshTargets } from './orcad-retained-source'
import { runTargetLifecycle } from '../ipc/ssh/ssh-target-lifecycle-queue'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn() }
})
vi.mock('./targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore
}))
vi.mock('../managed-server/lifecycle/orcad-runtime-deployment', () => ({
  createManagedOrcadEnvironment: mocks.deploy
}))
vi.mock('../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  closeOrcadManagedTunnel: vi.fn(async () => {})
}))

const { convertSshTargetToManagedOrcad } =
  await import('../managed-server/lifecycle/orcad-runtime-conversion')

const MIB = 1024 * 1024
const directories: string[] = []
let userDataPath: string
let desktop: Store
let server: Store

function useDesktop(store: Store): void {
  desktop = store
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  mocks.state.targetStore = new SshConnectionStore(store as never)
  installOrcadMigrationScrollbackRetention(userDataPath, store)
}

/** The real server-side import behind the T6-9 calls, as orcad serves them. */
function serverDestination(): OrcadMigrationDestinationCatalog {
  return {
    readState: async (manifest) => server.getOrcadMigrationCatalogState(manifest),
    stage: (manifest) => stageOrcadMigrationCatalogDurably({ store: server, manifest }),
    commit: (manifest, expectedBlobs) =>
      commitStagedOrcadMigrationCatalogDurably({
        store: server,
        manifest,
        ...(expectedBlobs?.length ? { expectedBlobs } : {}),
        onDurableCommit: () => {}
      }),
    abort: async (manifest) => {
      const result = server.abortStagedOrcadMigrationCatalog(manifest)
      return result.aborted ? result : { ...result, durableAbsent: true as const }
    },
    stageChunk: async (request) => server.stageOrcadMigrationSnapshotChunk(request),
    readCapabilities: async () => [
      ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      ...advertisedOrcadMigrationBlobCapabilities()
    ],
    stageBlobChunk: async (request) => server.stageOrcadMigrationBlobChunk(request)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = draftsUserDataPath(directories)
  useDesktop(openDraftsDesktop(userDataPath))
  server = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'server', 'orca-data.json')
  })
  mocks.ensureTunnel.mockResolvedValue(undefined)
  mocks.deploy.mockImplementation(async (path: string, args: { name: string }) => {
    const id = getManagedOrcadFenceEnvironmentId(desktop.getSshTarget(DRAFTS_TARGET.id))!
    if (!listEnvironments(path).some((entry) => entry.id === id)) {
      addManagedOrcadEnvironment(path, {
        id,
        name: args.name,
        pairingCode: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:46768/',
          deviceToken: 'device-token',
          publicKeyB64: 'public-key'
        }),
        orcadDeployment: {
          sshTargetId: DRAFTS_TARGET.id,
          sshTargetGeneration: 2,
          localPort: 46_768,
          remotePort: 6_768
        }
      })
    }
    return { outcome: 'created', environment: {}, activeVersion: '1.0.0' }
  })
})

afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const convert = (destination = serverDestination()) =>
  convertSshTargetToManagedOrcad(userDataPath, {
    sshTargetId: DRAFTS_TARGET.id,
    name: 'Managed',
    censusHost: async () => ({ verdict: 'exited', count: 0 }),
    destinationFor: () => destination,
    now: () => new Date('2026-10-19T00:00:00.000Z')
  })

/** The drafts the server's hot-exit session holds now, by file name. */
function serverDrafts(): Record<string, string> {
  const files = server.getWorkspaceSession().openFilesByWorktree?.[DRAFTS_WORKTREE] ?? []
  return Object.fromEntries(
    files.flatMap((file) =>
      file.dirtyDraftContent === undefined ? [] : [[file.relativePath, file.dirtyDraftContent]]
    )
  )
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Dormant terminal tabs whose saved scrollback adds up to `totalBytes`. */
function saveScrollback(totalBytes: number, tabs: number): void {
  const session = desktop.getWorkspaceSession(DRAFTS_HOST)
  const leaf = (index: number): TerminalPaneLayoutNode => ({
    type: 'leaf',
    leafId: `leaf-${index}`
  })
  const ids = Array.from({ length: tabs }, (_, index) => index)
  desktop.setWorkspaceSession(
    {
      ...session,
      tabsByWorktree: {
        [DRAFTS_WORKTREE]: ids.map((index) => ({
          id: `tab-${index}`,
          ptyId: null,
          worktreeId: DRAFTS_WORKTREE,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: 1
        }))
      },
      terminalLayoutsByTabId: Object.fromEntries(
        ids.map((index) => [
          `tab-${index}`,
          {
            root: leaf(index),
            activeLeafId: `leaf-${index}`,
            expandedLeafId: null,
            buffersByLeafId: { [`leaf-${index}`]: `${index}`.repeat(totalBytes / tabs) }
          }
        ])
      )
    },
    DRAFTS_HOST
  )
}

describe('a conversion whose drafts would overflow the manifest', () => {
  it('keeps the manifest under 720 KiB and lands 8 MiB of drafts byte-identical', async () => {
    const drafts = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [`big-${index}.ts`, `${index}é`.repeat(MIB)])
    )
    saveDrafts(desktop, drafts)
    saveScrollback(5 * MIB, 5)

    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })

    const [journal] = listOrcadMigrationSourceCutovers(userDataPath)
    expect(Buffer.byteLength(JSON.stringify(journal!.manifest))).toBeLessThan(720 * 1024)
    expect(journal!.manifest.payload.dormantState?.terminalScrollbackSnapshots).toHaveLength(5)
    const landed = serverDrafts()
    expect(Object.keys(landed).sort()).toEqual(Object.keys(drafts).sort())
    for (const [name, content] of Object.entries(drafts)) {
      expect(digest(landed[name]!)).toBe(digest(content))
    }
    // Committed: the desktop's copy is released.
    expect(sidecarFiles(userDataPath)).toEqual([])
  })
})

describe('a drafts transfer interrupted between chunks', () => {
  it('resumes after the tab closed and the desktop restarted, sending what was signed', async () => {
    const signed = 'signed draft '.repeat(200_000)
    saveDrafts(desktop, { 'a.ts': signed, 'b.ts': 'small' })
    const destination = serverDestination()
    const stageBlobChunk = destination.stageBlobChunk
    let chunks = 0
    destination.stageBlobChunk = async (request) => {
      chunks += 1
      if (chunks === 2) {
        throw new Error('transport lost')
      }
      return stageBlobChunk(request)
    }
    await expect(convert(destination)).rejects.toThrow('transport lost')
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.phase).toBe('destination-staged')

    // The user closes the dirty tab, then the desktop restarts.
    saveDrafts(desktop, { 'b.ts': 'small' })
    await desktop.flushPendingOrThrowAsync()
    await closeTestStores()
    useDesktop(openDraftsDesktop(userDataPath, false))
    server = createSqliteTestStore(Store, {
      dataFile: join(userDataPath, 'server', 'orca-data.json')
    })

    await expect(convert(destination)).resolves.toMatchObject({ outcome: 'converted' })
    expect(serverDrafts()).toEqual({ 'a.ts': signed, 'b.ts': 'small' })
  })
})

describe('a conversion aborted and retried', () => {
  it('carries the drafts the source holds at the retry', async () => {
    saveDrafts(desktop, { 'a.ts': 'first try' })
    const destination = serverDestination()
    // The server holds an unrelated row at the same path, so the first try is refused at stage.
    server.addRepo({
      id: 'server-repo',
      path: '/srv/app',
      displayName: 'Server',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git'
    })
    await expect(convert(destination)).rejects.toThrow('orcad_migration_repository_path_conflict')
    const { abandonOrcadConversion } = await import('./orcad-conversion-abandon')
    await abandonOrcadConversion({
      userDataPath,
      store: desktop,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture's target store wraps this desktop store.
      claims: (mocks.state.targetStore as SshConnectionStore).getOrcadRuntimeClaims(),
      targetId: DRAFTS_TARGET.id,
      destinationFor: () => destination
    })
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
    expect(sidecarFiles(userDataPath)).toEqual([])

    // The conflicting row goes (here: a fresh server), and the user edits before retrying.
    server = createSqliteTestStore(Store, {
      dataFile: join(userDataPath, 'server-2', 'orca-data.json')
    })
    saveDrafts(desktop, { 'a.ts': 'edited before the retry' })
    await expect(convert(destination)).resolves.toMatchObject({ outcome: 'converted' })
    expect(serverDrafts()).toEqual({ 'a.ts': 'edited before the retry' })
  })
})

describe('a delta move resumed after an unconfirmed commit', () => {
  it('skips the "nothing new" check and still moves the declared drafts', async () => {
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    // An older build adds a project, with an unsaved draft, after the conversion.
    desktop.addRepo({
      id: 'repo-2',
      path: '/srv/tool',
      displayName: 'Tool',
      badgeColor: '#737373',
      addedAt: 2,
      kind: 'git',
      connectionId: DRAFTS_TARGET.id
    })
    saveDrafts(desktop, { 'tool.ts': 'delta draft' }, 'repo-2::/srv/tool')
    const now = () => new Date('2026-10-19T01:00:00.000Z')
    reconcileManagedOrcadSshTargets(userDataPath, desktop, now)
    const destination = serverDestination()
    let offline = false
    const { stageBlobChunk, readState } = destination
    // Contact is lost mid-transfer, so the move can neither finish nor prove the server empty.
    destination.stageBlobChunk = async () => {
      offline = true
      throw new Error('socket closed')
    }
    destination.readState = async (manifest) => {
      if (offline) {
        throw new Error('socket closed')
      }
      return readState(manifest)
    }
    const move = () =>
      runOrcadDeltaMove({
        userDataPath,
        store: desktop,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture's target store wraps this desktop store.
        claims: (mocks.state.targetStore as SshConnectionStore).getOrcadRuntimeClaims(),
        target: desktop.getSshTarget(DRAFTS_TARGET.id)!,
        environment: listEnvironments(userDataPath)[0]!,
        destination,
        censusHost: async () => ({ verdict: 'exited', count: 0 }),
        ensureTunnel: async () => {},
        runTargetLifecycle,
        now
      })
    await expect(move()).rejects.toThrow('socket closed')
    const resumed = listOrcadMigrationSourceCutovers(userDataPath).find(
      (cutover) => cutover.supersedesMigrationId
    )
    expect(resumed?.manifest.payload.dormantState?.editorDraftsBlob?.entries).toHaveLength(1)

    offline = false
    destination.stageBlobChunk = stageBlobChunk
    // The live draft is gone; the resumed manifest still sends the bytes it signed.
    saveDrafts(desktop, {}, 'repo-2::/srv/tool')
    await expect(move()).resolves.toMatchObject({ outcome: 'moved' })
    const files = server.getWorkspaceSession().openFilesByWorktree?.['repo-2::/srv/tool'] ?? []
    expect(files.map((file) => file.dirtyDraftContent)).toEqual(['delta draft'])
  })
})

describe('the shed export', () => {
  it('keeps the declaration and the blob body in their golden shape', async () => {
    saveDrafts(desktop, { 'a.ts': 'unsaved\n', 'b.ts': undefined })
    const { exportOrcadMigration } = await import('./orcad-migration-manifest-export')
    const exported = exportOrcadMigration(desktop, DRAFTS_TARGET, {
      migrationId: 'golden',
      now: () => new Date('2026-10-19T00:00:00.000Z'),
      shedDrafts: true
    })
    const dormant = exported.manifest.payload.dormantState!
    expect(dormant.workspaceSession?.openFilesByWorktree?.[DRAFTS_WORKTREE]).toEqual([
      expect.not.objectContaining({ dirtyDraftContent: expect.anything() }),
      expect.not.objectContaining({ dirtyDraftContent: expect.anything() })
    ])
    expect(dormant.editorDraftsBlob).toMatchInlineSnapshot(`
      {
        "byteLength": 108,
        "entries": [
          {
            "filePath": "/srv/app/a.ts",
            "worktreeKey": "repo-1::/srv/app",
          },
        ],
        "sha256": "92865f583e0dcd0b83a22374684af8980f799df04640089a926055d1afad91c0",
      }
    `)
    expect(exported.editorDrafts?.bytes.toString('utf8')).toMatchInlineSnapshot(
      `"{"version":1,"drafts":[{"worktreeKey":"repo-1::/srv/app","filePath":"/srv/app/a.ts","content":"unsaved\\n"}]}"`
    )
    expect(
      parseOrcadMigrationEditorDraftsBytes(exported.editorDrafts!.bytes, dormant.editorDraftsBlob!)
    ).toEqual([{ worktreeKey: DRAFTS_WORKTREE, filePath: '/srv/app/a.ts', content: 'unsaved\n' }])
  })

  it('agrees with the source check: neither shedding nor a later edit reads as a source change', async () => {
    saveDrafts(desktop, { 'a.ts': 'unsaved' })
    const { createOrcadMigrationManifest } = await import('./orcad-migration-manifest-export')
    const { frozenSourceDigest } = await import('./orcad-migration-source-assertions')
    const at = { migrationId: 'm', now: () => new Date('2026-10-19T00:00:00.000Z') }
    const fence: OrcadMigrationManifest = createOrcadMigrationManifest(desktop, DRAFTS_TARGET, {
      ...at,
      shedDrafts: true
    })
    saveDrafts(desktop, { 'a.ts': 'typed since', 'c.ts': 'new' })
    const assertion = createOrcadMigrationManifest(desktop, DRAFTS_TARGET, {
      ...at,
      shedDrafts: true
    })
    expect(frozenSourceDigest(assertion)).toBe(frozenSourceDigest(fence))
    expect(frozenSourceDigest(createOrcadMigrationManifest(desktop, DRAFTS_TARGET, at))).toBe(
      frozenSourceDigest(fence)
    )
  })
})
