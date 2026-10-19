import type { editor } from 'monaco-editor'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getDiskBaselineSignature } from './diff-content-signature'
import { ORCA_EDITOR_FILE_RELOADED_EVENT, type EditorFileSavedDetail } from './editor-autosave'
import { getDiskChangeRevision } from './editor-changed-on-disk-mark'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { toEditorModelUri } from './editor-model-uri'
import { replaceModelContentAsUndoStep } from './monaco-content-sync'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync
} from './monaco-programmatic-sync'
import {
  resumeAutosaveAfterReloadUndo,
  watchReloadUndoBoundary
} from './reload-undo-autosave-pause'

type AppState = ReturnType<typeof useAppStore.getState>

async function readTabTextFromDisk(file: OpenFile): Promise<string | null> {
  const state = useAppStore.getState()
  const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  if (!target) {
    return null
  }
  const result = await readRuntimeFileContent({
    target,
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
    expectedExternalSshTargetId: file.externalSshTargetId,
    access: editorTabFileAccess(state, file)
  })
  return result.isBinary ? null : result.content
}

function findLiveFile(state: AppState, fileId: string): OpenFile | undefined {
  return state.openFiles.find((openFile) => openFile.id === fileId)
}

type MountedEditModel = { model: editor.ITextModel; modelKey: string }

/** The edit tab's Monaco model, only while a code editor shows it — the only place Cmd+Z reaches. */
export function getMountedEditModel(file: OpenFile, state: AppState): MountedEditModel | null {
  const registry = editorModelRegistry.get()
  if (file.mode !== 'edit' || !registry) {
    return null
  }
  const modelKey = toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state))
  const model = registry.editor.getModel(registry.Uri.parse(modelKey))
  return model && !model.isDisposed() && model.isAttachedToEditor() ? { model, modelKey } : null
}

export type MountedReloadResult = 'applied' | 'superseded' | 'unavailable'

/**
 * Reload into the mounted model as one undoable edit. Anything that moved the text or disk while
 * the read was in flight supersedes it, and the banner stays.
 */
export async function reloadMountedModelFromDisk(
  file: OpenFile,
  { model, modelKey }: MountedEditModel
): Promise<MountedReloadResult> {
  const versionAtClick = model.getVersionId()
  const diskRevisionAtClick = getDiskChangeRevision(file.id)
  const content = await readTabTextFromDisk(file)
  const state = useAppStore.getState()
  const liveFile = findLiveFile(state, file.id)
  if (content === null) {
    return 'unavailable'
  }
  if (
    liveFile?.externalMutation !== 'changed' ||
    getMountedEditModel(liveFile, state)?.model !== model ||
    model.getVersionId() !== versionAtClick ||
    // Why: a write during the read only re-marks an already-marked tab, so the read may be stale.
    getDiskChangeRevision(file.id) !== diskRevisionAtClick
  ) {
    return 'superseded'
  }
  // Why: one shared model serves every split pane; the in-flight mark makes each pane's
  // bridge treat the edit as programmatic instead of a keystroke.
  beginProgrammaticContentSync(modelKey)
  try {
    replaceModelContentAsUndoStep(model, content)
  } finally {
    endProgrammaticContentSync(modelKey)
  }
  // Why: panels adopt the new text before the draft clears, so no render falls back to stale content.
  window.dispatchEvent(
    new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_RELOADED_EVENT, {
      detail: { fileId: file.id, content }
    })
  )
  state.setLastKnownDiskSignature(file.id, getDiskBaselineSignature(content))
  state.clearEditorDraft(file.id)
  state.markFileDirty(file.id, false)
  state.setExternalMutation(file.id, null)
  watchReloadUndoBoundary(model, file.id)
  return 'applied'
}

/** Surfaces without a mounted Monaco model: drop the draft and refetch. Not undoable. */
export function discardDraftAndReloadContent(
  file: OpenFile,
  reloadContent: (file: OpenFile) => void
): void {
  const state = useAppStore.getState()
  // Why: the draft shadows loaded content (editBuffers ?? fileContents), so it must go first.
  state.clearEditorDraft(file.id)
  state.markFileDirty(file.id, false)
  state.setExternalMutation(file.id, null)
  resumeAutosaveAfterReloadUndo(file.id)
  reloadContent(file)
}

export function keepTabEditsOverExternalChange(file: OpenFile): void {
  useAppStore.getState().setExternalMutation(file.id, null)
  // Why: advance the baseline so the restart conflict scan doesn't re-derive the dismissed
  // conflict. Best-effort: a failed read only re-surfaces the banner.
  void readTabTextFromDisk(file)
    .then((content) => {
      const current = useAppStore.getState()
      const liveFile = findLiveFile(current, file.id)
      // Why: a newer conflict marked in the interim owns the baseline.
      if (content === null || !liveFile || liveFile.externalMutation === 'changed') {
        return
      }
      current.setLastKnownDiskSignature(file.id, getDiskBaselineSignature(content))
    })
    .catch(() => undefined)
}
