/**
 * The signed manifest a relay-hosted SSH target's state is exported as.
 *
 * Reads only: the catalog rows the target owns and the dormant state that references them, copied
 * out of the profile-state store. The source keeps every row; retiring it happens only after the
 * destination has verified and imported this exact manifest.
 */
import { randomUUID } from 'node:crypto'
import {
  MAX_ORCAD_MIGRATION_MANIFEST_BYTES,
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import { computeOrcadMigrationManifestSha256 } from '../orcad/orcad-migration-manifest-digest'
import {
  inlineOrcadMigrationEditorDraftPaths,
  shedOrcadMigrationEditorDrafts,
  type OrcadMigrationEditorDraftsBody
} from './orcad-migration-editor-drafts-shed'
import {
  IDENTITY_ORCAD_MIGRATION_PATH_REWRITER,
  rewriteOrcadMigrationPayloadPaths,
  type OrcadMigrationPathRewriter
} from './orcad-migration-path-rewrite'

export type OrcadMigrationExportStore = Pick<
  Store,
  | 'collectOrcadMigrationSourceDormantState'
  | 'getFolderWorkspaces'
  | 'getProjectGroups'
  | 'getRepos'
> & {
  /** Groups the server's record wins for: still read for row ownership, never exported. */
  serverOwnedProjectGroupIds?: ReadonlySet<string>
}

export type OrcadMigrationManifestExportOptions = {
  migrationId?: string
  now?: () => Date
  destinationEnvironmentId?: string
  /** Only these rows: a re-export of what earlier migrations of the host already moved. */
  onlyCatalog?: OrcadMigrationCatalogIds
  /** Maps source paths to destination paths before signing; identity for an SSH host. */
  rewrite?: OrcadMigrationPathRewriter
  /**
   * Moves unsaved editor buffers into an `editor-drafts` blob the manifest declares. Only for a
   * destination that advertises that kind: an older one would commit the session without them.
   */
  shedDrafts?: boolean
}

export type OrcadMigrationExport = {
  manifest: OrcadMigrationManifest
  /** The bytes `editorDraftsBlob` declares; null when nothing was shed. */
  editorDrafts: OrcadMigrationEditorDraftsBody | null
}

export function createOrcadMigrationManifest(
  store: OrcadMigrationExportStore,
  target: SshTarget,
  options: OrcadMigrationManifestExportOptions = {}
): OrcadMigrationManifest {
  return exportOrcadMigration(store, target, options).manifest
}

export function exportOrcadMigration(
  store: OrcadMigrationExportStore,
  target: SshTarget,
  options: OrcadMigrationManifestExportOptions = {}
): OrcadMigrationExport {
  const rewrite = options.rewrite ?? IDENTITY_ORCAD_MIGRATION_PATH_REWRITER
  const collected = restrictCatalog(
    collectOrcadMigrationSourceCatalog(store, target),
    options.onlyCatalog
  )
  const serverOwned = store.serverOwnedProjectGroupIds
  const sourcePayload = serverOwned
    ? {
        ...collected,
        projectGroups: collected.projectGroups.filter((group) => !serverOwned.has(group.id))
      }
    : collected
  const source = {
    sshTargetId: target.id,
    sshTargetGeneration: target.generation ?? null,
    targetLabel: target.label
  }
  const dormantState = store.collectOrcadMigrationSourceDormantState(
    source,
    sourcePayload,
    options.destinationEnvironmentId
  )
  // After collection: dormant state is selected by the source's own paths and ids.
  const rewritten = rewriteOrcadMigrationPayloadPaths(
    { ...sourcePayload, ...(hasDormantState(dormantState) ? { dormantState } : {}) },
    rewrite
  )
  // After the rewrite: the blob names entries by the paths the destination holds.
  const shed = options.shedDrafts
    ? shedOrcadMigrationEditorDrafts(rewritten)
    : { payload: rewritten, body: null }
  const payload = shed.payload
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: options.migrationId ?? randomUUID(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    source,
    payload,
    ...(options.destinationEnvironmentId
      ? { destinationEnvironmentId: options.destinationEnvironmentId }
      : {})
  }
  try {
    const manifest = parseOrcadMigrationManifest({
      ...unsigned,
      manifestSha256: computeOrcadMigrationManifestSha256(unsigned)
    })
    return { manifest, editorDrafts: shed.body }
  } catch (error) {
    if (error instanceof Error && error.message === ORCAD_MIGRATION_MANIFEST_TOO_LARGE) {
      throw new Error(describeOversizedOrcadMigrationPayload(payload))
    }
    throw error
  }
}

const ORCAD_MIGRATION_MANIFEST_TOO_LARGE = 'orcad_migration_manifest_too_large'

/** The bare code told users nothing (#30126): name the largest parts and what to trim. */
export function describeOversizedOrcadMigrationPayload(
  payload: OrcadMigrationCatalogPayload,
  limitBytes = MAX_ORCAD_MIGRATION_MANIFEST_BYTES
): string {
  const dormant = payload.dormantState
  const parts: [string, unknown][] = [
    ['projects', payload.repositories],
    ['folder workspaces', payload.folderWorkspaces],
    ['project groups', payload.projectGroups],
    ['saved tabs and panes', dormant?.workspaceSession],
    ['saved terminal history', dormant?.terminalScrollbackSnapshots],
    ['saved workspace details', dormant?.worktreeMeta],
    ['workspace history', [dormant?.worktreeLineage, dormant?.workspaceLineage]],
    ['sparse checkout presets', dormant?.sparsePresets],
    [
      'retired workspace names',
      [dormant?.retiredWorktreeNames, dormant?.retiredWorktreeNamespaces]
    ],
    ['automations', [dormant?.automations, dormant?.automationRuns]],
    ['sidebar and browser settings', dormant?.clientState]
  ]
  const largest = parts
    .map(([words, value]) => ({
      words,
      bytes: new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 3)
    .map(({ words, bytes }) => `${words} (${formatKib(bytes)})`)
  const drafts = inlineOrcadMigrationEditorDraftPaths(payload)
  // Drafts ride inline only to a server too old for the drafts blob; say which ones to resolve.
  const draftsLine =
    drafts.paths.length > 0
      ? ` Unsaved changes (${formatKib(drafts.bytes)}) stay on this computer until you save or ` +
        `discard them: ${drafts.paths.slice(0, 5).join(', ')}` +
        `${drafts.paths.length > 5 ? ` and ${drafts.paths.length - 5} more` : ''}.`
      : ''
  return (
    `This SSH host's saved state is too large to move to its Orca server (limit ` +
    `${formatKib(limitBytes)}). Largest parts: ${largest.join(', ')}.${draftsLine} ` +
    `Close tabs you no longer need or remove unused projects for this host, then reconnect. ` +
    `(${ORCAD_MIGRATION_MANIFEST_TOO_LARGE})`
  )
}

function formatKib(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`
}

export type OrcadMigrationCatalogIds = {
  repositoryIds: ReadonlySet<string>
  folderWorkspaceIds: ReadonlySet<string>
  projectGroupIds: ReadonlySet<string>
}

export function orcadMigrationCatalogIds(
  payloads: readonly OrcadMigrationCatalogPayload[]
): OrcadMigrationCatalogIds {
  return {
    repositoryIds: new Set(payloads.flatMap((p) => p.repositories.map((row) => row.id))),
    folderWorkspaceIds: new Set(payloads.flatMap((p) => p.folderWorkspaces.map((row) => row.id))),
    projectGroupIds: new Set(payloads.flatMap((p) => p.projectGroups.map((row) => row.id)))
  }
}

function restrictCatalog(
  payload: OrcadMigrationCatalogPayload,
  ids: OrcadMigrationCatalogIds | undefined
): OrcadMigrationCatalogPayload {
  if (!ids) {
    return payload
  }
  return {
    repositories: payload.repositories.filter((row) => ids.repositoryIds.has(row.id)),
    folderWorkspaces: payload.folderWorkspaces.filter((row) => ids.folderWorkspaceIds.has(row.id)),
    projectGroups: payload.projectGroups.filter((row) => ids.projectGroupIds.has(row.id))
  }
}

function hasDormantState(state: OrcadMigrationDormantStatePayload): boolean {
  return (
    state.worktreeMeta.length > 0 ||
    state.worktreeLineage.length > 0 ||
    state.workspaceLineage.length > 0 ||
    state.sparsePresets.length > 0 ||
    state.retiredWorktreeNames.length > 0 ||
    state.retiredWorktreeNamespaces.length > 0 ||
    state.workspaceSession !== undefined ||
    (state.terminalScrollbackSnapshots?.length ?? 0) > 0 ||
    (state.automations?.length ?? 0) > 0 ||
    (state.automationRuns?.length ?? 0) > 0 ||
    (state.clientState !== undefined && Object.keys(state.clientState).length > 0)
  )
}
