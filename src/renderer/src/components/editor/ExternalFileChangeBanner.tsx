import React, { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import { ExternalFileChangeCompareDialog } from './ExternalFileChangeCompareDialog'
import { getDiskBaselineSignature } from './diff-content-signature'
import { restampEditorModelDiskBaseline } from './editor-model-disk-baseline'
import { getChangedOnDiskMarkGeneration } from './editor-changed-on-disk-mark'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'

// Why: when an external process (usually an agent) rewrites a file while the
// tab holds unsaved edits, the reload pipeline preserves the buffer and marks
// the tab externalMutation='changed' (issue #7265). This banner is the
// recovery path — without it the tab is silently stale until close/reopen and
// the next save clobbers the newer disk content unannounced.

const RELOAD_UNDO_TOAST_DURATION_MS = 8_000

export function reloadTabContentFromDisk(
  file: OpenFile,
  reloadContent: (file: OpenFile) => void
): void {
  const state = useAppStore.getState()
  const discardedDraft = state.editorDrafts[file.id]
  const discardedDiskSignature = state.openFiles.find(
    (openFile) => openFile.id === file.id
  )?.lastKnownDiskSignature
  // Why: drop the draft before reloading — the buffer shadows loaded content
  // (editBuffers ?? fileContents), so a reload alone would keep showing the
  // stale unsaved text.
  state.clearEditorDraft(file.id)
  state.markFileDirty(file.id, false)
  state.setExternalMutation(file.id, null)
  reloadContent(file)
  if (discardedDraft === undefined) {
    return
  }
  // Why: on diff tabs the reload rotates the Monaco model, destroying the undo
  // stack — without this toast a mistaken click is an unrecoverable discard.
  toast(
    translate('auto.components.editor.ExternalFileChangeBanner.5c02de9b31', 'Reloaded from disk'),
    {
      description: file.relativePath,
      duration: RELOAD_UNDO_TOAST_DURATION_MS,
      action: {
        label: translate('auto.components.editor.ExternalFileChangeBanner.d1e830fa22', 'Undo'),
        onClick: () => {
          const current = useAppStore.getState()
          const liveFile = current.openFiles.find((openFile) => openFile.id === file.id)
          // Why: the tab may have closed while the toast was up; restoring a
          // draft for a dead fileId would strand an orphan buffer. And if the
          // user already typed after the reload (dirty), that newer work wins
          // — undoing over it would be a second silent discard. isDirty is the
          // signal: the editor content-sync repopulates editorDrafts with the
          // reloaded content itself, so draft existence proves nothing.
          if (!liveFile || liveFile.isDirty) {
            return
          }
          current.setEditorDraft(file.id, discardedDraft)
          current.markFileDirty(file.id, true)
          // Why: the disk still differs from the restored draft, so the
          // conflict (and its autosave suspension) must come back with it.
          current.setExternalMutation(file.id, 'changed')
          if (discardedDiskSignature !== undefined) {
            // Why: the reload re-stamped the baseline to the new disk content;
            // restoring the pre-reload signature with the draft keeps the
            // restart scan re-deriving the conflict the undo just brought back.
            current.setLastKnownDiskSignature(file.id, discardedDiskSignature)
            restampEditorModelDiskBaseline(file.id, discardedDiskSignature)
          }
          trackExternalChangeConflictAction(file, 'undo_reload')
        }
      }
    }
  )
}

/** The tab's edits are now based on this disk version, in the store record and the editor model. */
function adoptDiskBaseline(fileId: string, signature: string): void {
  useAppStore.getState().setLastKnownDiskSignature(fileId, signature)
  restampEditorModelDiskBaseline(fileId, signature)
}

/** `seenDiskContent`: the disk text the compare dialog showed, when Keep was chosen there. */
/** Resolves once the dismissal settles (after the disk read, when one is needed). */
export async function keepTabEditsOverExternalChange(
  file: OpenFile,
  seenDiskContent?: string
): Promise<void> {
  const state = useAppStore.getState()
  if (seenDiskContent !== undefined) {
    // Why: adopt only the version the user compared against; a later write makes the next save refuse.
    adoptDiskBaseline(file.id, getDiskBaselineSignature(seenDiskContent))
    state.setExternalMutation(file.id, null)
    return
  }
  // Why: the dismissal must survive restart — without advancing the baseline
  // to the current disk content, the restored-tab conflict scan re-derives
  // the dismissed conflict from the stale signature on every launch.
  // Best-effort: a failed read leaves the old signature, which can only
  // re-surface the banner — never lose data.
  const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  if (!target) {
    state.setExternalMutation(file.id, null)
    return
  }
  // Why the conflict stays until the read lands: it holds autosave, which would otherwise save
  // against the old base, be refused, and raise the banner again on every slow remote read.
  const markGeneration = getChangedOnDiskMarkGeneration(file.id)
  const dismiss = (signature?: string): void => {
    const liveFile = useAppStore.getState().openFiles.find((openFile) => openFile.id === file.id)
    // Why: a reload, a deletion, a closed tab or a newer conflict in the interim owns the outcome.
    if (
      liveFile?.externalMutation !== 'changed' ||
      getChangedOnDiskMarkGeneration(file.id) !== markGeneration
    ) {
      return
    }
    if (signature !== undefined) {
      adoptDiskBaseline(file.id, signature)
    }
    useAppStore.getState().setExternalMutation(file.id, null)
  }
  await readRuntimeFileContent({
    target,
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
    expectedExternalSshTargetId: file.externalSshTargetId,
    access: editorTabFileAccess(state, file)
  })
    .then((result) =>
      dismiss(result.isBinary ? undefined : getDiskBaselineSignature(result.content))
    )
    .catch(() => dismiss())
}

export function ExternalFileChangeBanner({
  file,
  currentContent,
  reloadContent
}: {
  file: OpenFile
  /** The tab's live buffer (draft if dirty) — what "Keep My Edits" keeps. */
  currentContent: string
  /** Refetches the tab's content — file body for edit tabs, diff body for
   *  unstaged diff tabs. */
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  const [compareOpen, setCompareOpen] = useState(false)

  const handleReload = (): void => {
    trackExternalChangeConflictAction(file, 'reload')
    reloadTabContentFromDisk(file, reloadContent)
  }
  const [keepPending, setKeepPending] = useState(false)
  const handleKeepEdits = (seenDiskContent?: string): void => {
    // Why: one dismissal at a time; its disk read can take a while on a slow remote.
    if (keepPending) {
      return
    }
    setKeepPending(true)
    trackExternalChangeConflictAction(file, 'keep')
    void keepTabEditsOverExternalChange(file, seenDiskContent).finally(() => setKeepPending(false))
  }
  const handleCompare = (): void => {
    trackExternalChangeConflictAction(file, 'compare')
    setCompareOpen(true)
  }

  return (
    // Why: role=alert because the banner appears asynchronously (an agent
    // rewrote the file) — screen readers must announce it unprompted.
    <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          {/* Why: wraps instead of truncating — the overwrite warning at the
              end of the sentence is the part the user must not lose. */}
          <span className="min-w-0 font-medium text-foreground">
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.7c41e90d12',
              'This file changed on disk while you have unsaved edits. Saving will overwrite the newer disk content.'
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="xs" variant="outline" onClick={handleCompare}>
            {translate('auto.components.editor.ExternalFileChangeBanner.90b2ce7d43', 'Compare')}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={handleReload}>
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.3fa2b8d417',
              'Reload from Disk'
            )}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={keepPending}
            onClick={() => handleKeepEdits()}
          >
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.a95d02c644',
              'Keep My Edits'
            )}
          </Button>
        </div>
      </div>
      {compareOpen && (
        <ExternalFileChangeCompareDialog
          file={file}
          currentContent={currentContent}
          open={compareOpen}
          onOpenChange={setCompareOpen}
          onReload={handleReload}
          onKeepEdits={handleKeepEdits}
        />
      )}
    </div>
  )
}
