/**
 * The desktop's durable copy of a journaled manifest's shed drafts, beside the cutover journal.
 *
 * Keyed by migration id and manifest digest: a relink re-journals a different manifest under the
 * same id. Files are immutable once written, so a resumed transfer (after a restart, or after the
 * user closed the tab) sends exactly the bytes the signed manifest declares. The signed manifest is
 * kept next to them: an older desktop rewriting the journal drops `editorDraftsBlob`, and only these
 * exact bytes still answer the host's digest check.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assertOrcadMigrationManifestDigest } from '../orcad/orcad-migration-manifest-digest'
import {
  durableWriteTempPath,
  syncDirectoryDurablySync,
  writeFileDurableSync
} from '../durable-file-write'
import type { OrcadMigrationBlobDescriptor } from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import { parseOrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationEditorDraftsBody } from './orcad-migration-editor-drafts-shed'

const DIRECTORY = 'orcad-migration-editor-drafts'
const DRAFTS_SUFFIX = '.drafts'
const MANIFEST_SUFFIX = '.manifest.json'
const ID = /^[A-Za-z0-9_-]{1,128}$/
const SHA = /^[a-f0-9]{64}$/

type SidecarKey = { migrationId: string; manifestSha256: string }

export function orcadMigrationEditorDraftsSidecarDirectory(userDataPath: string): string {
  return join(userDataPath, DIRECTORY)
}

function stem(key: SidecarKey): string {
  if (!ID.test(key.migrationId) || !SHA.test(key.manifestSha256)) {
    throw new Error('orcad_migration_editor_drafts_sidecar_key_invalid')
  }
  return `${key.migrationId}.${key.manifestSha256}`
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Durable before it returns; call it before the journal entry that names the manifest. */
export function writeOrcadMigrationEditorDraftsSidecar(
  userDataPath: string,
  manifest: OrcadMigrationManifest,
  body: OrcadMigrationEditorDraftsBody
): void {
  const directory = orcadMigrationEditorDraftsSidecarDirectory(userDataPath)
  const created = !existsSync(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const base = join(directory, stem(manifest))
  writeImmutable(base + DRAFTS_SUFFIX, body.bytes)
  writeImmutable(base + MANIFEST_SUFFIX, Buffer.from(JSON.stringify(manifest), 'utf8'))
  syncDirectoryDurablySync(directory)
  if (created) {
    syncDirectoryDurablySync(userDataPath)
  }
}

function writeImmutable(path: string, bytes: Buffer): void {
  if (existsSync(path)) {
    // Same key, same bytes: a retried write. Different bytes would change what was signed.
    if (sha256(readFileSync(path)) !== sha256(bytes)) {
      throw new Error('orcad_migration_editor_drafts_sidecar_conflict')
    }
    return
  }
  writeFileDurableSync(durableWriteTempPath(path), path, bytes, 0o600)
}

/** The declared bytes, or null when they are gone or no longer match the declaration. */
export function readOrcadMigrationEditorDraftsSidecar(
  userDataPath: string,
  key: SidecarKey,
  descriptor: OrcadMigrationBlobDescriptor
): Buffer | null {
  const path = join(orcadMigrationEditorDraftsSidecarDirectory(userDataPath), stem(key))
  let bytes: Buffer
  try {
    bytes = readFileSync(path + DRAFTS_SUFFIX)
  } catch {
    return null
  }
  return bytes.byteLength === descriptor.byteLength && sha256(bytes) === descriptor.sha256
    ? bytes
    : null
}

/** The exact signed manifest, or null when no intact copy is kept for this key. */
export function readOrcadMigrationSignedManifestSidecar(
  userDataPath: string,
  key: SidecarKey
): OrcadMigrationManifest | null {
  const path = join(orcadMigrationEditorDraftsSidecarDirectory(userDataPath), stem(key))
  try {
    const raw: unknown = JSON.parse(readFileSync(path + MANIFEST_SUFFIX, 'utf8'))
    assertOrcadMigrationManifestDigest(raw)
    const manifest = parseOrcadMigrationManifest(raw)
    return manifest.migrationId === key.migrationId &&
      manifest.manifestSha256 === key.manifestSha256
      ? manifest
      : null
  } catch {
    return null
  }
}

/**
 * Keeps only the sidecars of manifests still pending in the journal: a confirmed commit or a
 * confirmed abort (the journal entry goes, or moves to another digest) releases them.
 */
export function pruneOrcadMigrationEditorDraftsSidecars(
  userDataPath: string,
  pending: readonly SidecarKey[]
): void {
  const directory = orcadMigrationEditorDraftsSidecarDirectory(userDataPath)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  const keep = new Set(pending.map(stem))
  let removed = false
  for (const name of names) {
    const key = name.endsWith(DRAFTS_SUFFIX)
      ? name.slice(0, -DRAFTS_SUFFIX.length)
      : name.endsWith(MANIFEST_SUFFIX)
        ? name.slice(0, -MANIFEST_SUFFIX.length)
        : null
    // Temporaries of a write that never published are orphans too.
    if (key === null || !keep.has(key)) {
      rmSync(join(directory, name), { force: true, recursive: true })
      removed = true
    }
  }
  if (removed) {
    syncDirectoryDurablySync(directory)
  }
}
