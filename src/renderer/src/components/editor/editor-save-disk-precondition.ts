import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type {
  FileWriteDiskConflict,
  FileWriteDiskPrecondition
} from '../../../../shared/file-write-disk-precondition'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'

export const SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE =
  'This file changed on disk. Review the change before saving.'
export const SAVE_REFUSED_DELETED_ON_DISK_MESSAGE = 'This file was deleted on disk.'

/**
 * Only the editor's own save, requested while its changed-on-disk banner shows, is the banner's
 * "overwrite" choice; programmatic saves (mobile, save-before-delete, rename) never saw it.
 * Why at enqueue: judged at execution, a save queued behind the refusal that raised the banner
 * would read the banner as permission.
 */
export function isConfirmedDiskOverwrite(
  file: Pick<OpenFile, 'externalMutation'> | undefined,
  confirmDiskOverwrite: boolean
): boolean {
  return confirmDiskOverwrite && file?.externalMutation === 'changed'
}

/** The disk state a save may overwrite, from the base resolved with its text (see resolveEditorSaveBaseline). */
export function getSaveDiskPrecondition(
  expectedSignature: string | undefined,
  trigger: 'autosave' | 'user',
  overwriteConfirmed: boolean
): FileWriteDiskPrecondition | undefined {
  if (overwriteConfirmed || expectedSignature === undefined) {
    return undefined
  }
  // Why: an explicit save may recreate a deleted file (nothing on disk to lose); autosave must not resurrect it.
  return trigger === 'user' ? { expectedSignature, allowMissing: true } : { expectedSignature }
}

/** Surfaces a refused save through the existing changed-on-disk banner or deleted tombstone. */
export function applySaveDiskConflict(
  state: Pick<
    AppState,
    'openFiles' | 'setExternalMutation' | 'clearPendingDiskBaselineVerification'
  >,
  fileId: string,
  diskConflict: FileWriteDiskConflict,
  connectionId: string | undefined
): void {
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  if (!file) {
    return
  }
  // Why: the writer just compared disk to the baseline, which is what the restore scan waits on.
  state.clearPendingDiskBaselineVerification(fileId)
  if (diskConflict === 'missing') {
    // Why edit-only: the watcher tombstones only edit tabs; a diff tab just keeps its draft. A
    // 'renamed' marker already explains the absence more precisely.
    if (file.mode === 'edit' && file.externalMutation === undefined) {
      state.setExternalMutation(fileId, 'deleted')
    }
    return
  }
  markFileChangedOnDisk(state, file, { connectionId, origin: 'live', saveRefused: true })
}
