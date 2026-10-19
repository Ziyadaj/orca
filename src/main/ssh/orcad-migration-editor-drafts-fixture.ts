import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
} from '../../shared/orcad-runtime-capabilities'
import {
  advertisedOrcadMigrationBlobCapabilities,
  orcadMigrationBlobKindUnsupportedBlocker
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationEditorDraft } from '../../shared/orcad-migration/orcad-migration-editor-drafts'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import type { SshTarget } from '../../shared/ssh-types'
import { createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { orcadMigrationEditorDraftsSidecarDirectory } from './orcad-migration-editor-drafts-sidecar'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'

export const DRAFTS_TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}
export const DRAFTS_WORKTREE = 'repo-1::/srv/app'
export const DRAFTS_HOST = toSshExecutionHostId(DRAFTS_TARGET.id)

export function draftsUserDataPath(directories: string[]): string {
  const path = mkdtempSync(join(tmpdir(), 'orcad-editor-drafts-'))
  directories.push(path)
  return path
}

/** A relay-era desktop profile holding the host's one project. */
export function openDraftsDesktop(userDataPath: string, seed = true): Store {
  const store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  if (seed) {
    store.addSshTarget(DRAFTS_TARGET)
    store.addRepo({
      id: 'repo-1',
      path: '/srv/app',
      displayName: 'App',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git',
      connectionId: DRAFTS_TARGET.id
    })
  }
  return store
}

/** The host's open editor tabs, each with an unsaved draft unless its content is undefined. */
export function saveDrafts(
  store: Store,
  drafts: Record<string, string | undefined>,
  worktreeId = DRAFTS_WORKTREE
): void {
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(DRAFTS_HOST),
      openFilesByWorktree: {
        [worktreeId]: Object.entries(drafts).map(([name, content]) => ({
          filePath: `/srv/app/${name}`,
          relativePath: name,
          worktreeId,
          language: 'typescript',
          ...(content === undefined ? {} : { dirtyDraftContent: content })
        }))
      }
    },
    DRAFTS_HOST
  )
}

export function draftsOf(drafts: readonly OrcadMigrationEditorDraft[]): Record<string, string> {
  return Object.fromEntries(
    drafts.map((draft) => [draft.filePath.slice('/srv/app/'.length), draft.content])
  )
}

export function sidecarFiles(userDataPath: string): string[] {
  try {
    return readdirSync(orcadMigrationEditorDraftsSidecarDirectory(userDataPath)).sort()
  } catch {
    return []
  }
}

/**
 * The in-memory destination, able to lose the drafts kind as a downgraded host would. Its gate
 * is the catalog client's: a declaring manifest is refused before it is staged or committed.
 */
export function downgradableDestination() {
  const destination = fakeOrcadMigrationDestination()
  const host = { takesDrafts: true }
  const refuse = (manifest: OrcadMigrationManifest): void => {
    if (!host.takesDrafts && manifest.payload.dormantState?.editorDraftsBlob) {
      throw new Error(orcadMigrationBlobKindUnsupportedBlocker('editor-drafts'))
    }
  }
  const stage = destination.stage.getMockImplementation()!
  const commit = destination.commit.getMockImplementation()!
  destination.stage.mockImplementation(async (manifest) => {
    refuse(manifest)
    return stage(manifest)
  })
  destination.commit.mockImplementation(async (manifest, expectedBlobs) => {
    refuse(manifest)
    return commit(manifest, expectedBlobs)
  })
  destination.readCapabilities.mockImplementation(async () =>
    host.takesDrafts
      ? [ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY, ...advertisedOrcadMigrationBlobCapabilities()]
      : [
          ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
          ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY
        ]
  )
  return { destination, host }
}
