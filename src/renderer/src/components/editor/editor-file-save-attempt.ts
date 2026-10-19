import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { FileWriteDiskConflict } from '../../../../shared/file-write-disk-precondition'
import { requestEditorFileSave, type EditorSaveFileTarget } from './editor-autosave'
import {
  SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE,
  SAVE_REFUSED_DELETED_ON_DISK_MESSAGE
} from './editor-save-disk-precondition'

function saveRefusalNotice(diskConflict: FileWriteDiskConflict): string {
  return diskConflict === 'missing'
    ? translate(
        'auto.components.editor.editor.save.refused.deletedOnDisk',
        'This file was deleted on disk.'
      )
    : translate(
        'auto.components.editor.editor.save.refused.changedOnDisk',
        'This file changed on disk. Review the change before saving.'
      )
}

export function editorSaveFailureNotice(error: unknown): string {
  // Why: the save event bridge forwards only the message, so a disk refusal is recognized by it.
  const message = error instanceof Error ? error.message : String(error)
  if (message === SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE) {
    return saveRefusalNotice('changed')
  }
  if (message === SAVE_REFUSED_DELETED_ON_DISK_MESSAGE) {
    return saveRefusalNotice('missing')
  }
  return translate(
    'auto.components.editor.editor.save.failure.notice.8c59ce5075',
    'Failed to save the file. Please try again.'
  )
}

export async function attemptEditorFileSave(target: EditorSaveFileTarget): Promise<boolean> {
  try {
    await requestEditorFileSave(target)
    return true
  } catch (error) {
    // Why: shortcut handlers need a non-throwing result, while dependent actions must not treat a rejected write as success.
    console.error('[editor] file save failed', error)
    toast.error(editorSaveFailureNotice(error))
    return false
  }
}
