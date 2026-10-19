// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import {
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  type EditorSaveAndCloseDetail
} from './editor/editor-autosave'
import { SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE } from './editor/editor-save-disk-precondition'
import {
  useTerminalEditorCloseDialogActions,
  type TerminalEditorCloseDialogActionsInput
} from './use-terminal-editor-close-dialog-actions'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const initialState = useAppStore.getInitialState()
const FILE_ID = 'file-1'

function controller(): TerminalEditorCloseDialogActionsInput {
  return {
    advanceEditorCloseQueue: vi.fn(),
    closedReactionsRef: { current: new Map() },
    inFlightSaveFileIdRef: { current: null },
    isClosingRef: { current: false },
    pendingEditorCloseQueueRef: { current: [] },
    queueEditorCloseRequests: vi.fn(),
    releaseCloseDialogGuardAfterDebounce: vi.fn(),
    saveDialogFileId: FILE_ID,
    setSaveDialogFileId: vi.fn(),
    settleQueuedClose: vi.fn(),
    // The file never closes, as when its save was refused.
    waitForFileClosed: vi.fn(() => new Promise<boolean>(() => undefined)),
    windowCloseAfterDirtyRef: { current: null }
  }
}

beforeEach(() => {
  useAppStore.setState({
    openFiles: [
      {
        id: FILE_ID,
        filePath: '/repo/file.ts',
        relativePath: 'file.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: true,
        mode: 'edit'
      }
    ]
  })
})

afterEach(() => {
  cleanup()
  toastError.mockReset()
  useAppStore.setState(initialState, true)
})

it('reports a refused close-dialog save at once and reopens the dialog', async () => {
  const onSaveAndClose = (event: Event): void => {
    const detail: EditorSaveAndCloseDetail | undefined =
      event instanceof CustomEvent ? event.detail : undefined
    detail?.onSaveFailed?.(SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE)
  }
  window.addEventListener(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, onSaveAndClose)
  const input = controller()
  try {
    const { result } = renderHook(() => useTerminalEditorCloseDialogActions(input))

    await act(() => result.current.handleSaveDialogSave())

    expect(toastError).toHaveBeenCalledWith(
      'This file changed on disk. Review the change before saving.'
    )
    expect(input.setSaveDialogFileId).toHaveBeenLastCalledWith(FILE_ID)
  } finally {
    window.removeEventListener(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, onSaveAndClose)
  }
})
