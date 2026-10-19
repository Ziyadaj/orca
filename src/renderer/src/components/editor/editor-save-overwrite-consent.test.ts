// Why: who may overwrite a changed-on-disk file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import { ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  createFakeEditorModel,
  stubEditorWindowWithDisk
} from './editor-autosave-controller-test-fixture'
import {
  __clearEditorModelDiskBaselinesForTests,
  stampEditorModelDiskBaseline
} from './editor-model-disk-baseline'
import { getDiskBaselineSignature } from './diff-content-signature'
import { keepTabEditsOverExternalChange } from './ExternalFileChangeBanner'
import { SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE } from './editor-save-disk-precondition'
import type * as RuntimeFileReadClient from '@/runtime/runtime-file-read-client'

const mocks = vi.hoisted(() => {
  const store: { current: StoreApi<AppState> | null } = { current: null }
  return { readRuntimeFileContent: vi.fn(), store }
})

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.store.current?.getState() }
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileReadClient>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

const FILE_PATH = '/repo/file.ts'

function setUp(diskContent: string | null, baseline: string, draft: string) {
  const disk = stubEditorWindowWithDisk(
    createFakeEditorDisk(diskContent === null ? {} : { [FILE_PATH]: diskContent })
  )
  const store = createEditorStore()
  mocks.store.current = store
  store.getState().openFile({
    filePath: FILE_PATH,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setLastKnownDiskSignature(FILE_PATH, getDiskBaselineSignature(baseline))
  stampEditorModelDiskBaseline(
    FILE_PATH,
    createFakeEditorModel(draft),
    getDiskBaselineSignature(baseline)
  )
  store.getState().setEditorDraft(FILE_PATH, draft)
  store.getState().markFileDirty(FILE_PATH, true)
  return { disk, store }
}

function editTab(store: StoreApi<AppState>) {
  return store.getState().openFiles.find((file) => file.id === FILE_PATH)
}

describe('editor save overwrite consent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.readRuntimeFileContent.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
    __clearEditorModelDiskBaselinesForTests()
    mocks.store.current = null
  })

  it('keeps the guard for a programmatic save while the banner shows', async () => {
    // Mobile markdown bridge, save-before-delete and untitled rename save without the user seeing the banner.
    const { disk, store } = setUp('agent rewrite', 'original', 'mine')
    store.setState({ settings: null })
    store.getState().setExternalMutation(FILE_PATH, 'changed')
    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: FILE_PATH })).rejects.toThrow()
      expect(disk.files.get(FILE_PATH)).toBe('agent rewrite')

      await requestEditorFileSave({ fileId: FILE_PATH, confirmDiskOverwrite: true })
      expect(disk.files.get(FILE_PATH)).toBe('mine')
    } finally {
      cleanup()
    }
  })

  it("treats the close dialog's Save under the banner as the overwrite choice", async () => {
    const { disk, store } = setUp('agent rewrite', 'original', 'mine')
    // Closing touches the tab model, so seed its empty maps.
    store.setState({
      settings: null,
      browserTabsByWorktree: {},
      tabsByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })
    store.getState().setExternalMutation(FILE_PATH, 'changed')
    const onSaveFailed = vi.fn()
    const cleanup = attachEditorAutosaveController(store)
    try {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, {
          detail: { fileId: FILE_PATH, onSaveFailed }
        })
      )
      await vi.waitFor(() => expect(editTab(store)).toBeUndefined())
      expect(disk.files.get(FILE_PATH)).toBe('mine')
      expect(onSaveFailed).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it('reports a close-dialog save refused over an unnoticed change right away', async () => {
    const { disk, store } = setUp('agent rewrite', 'original', 'mine')
    store.setState({ settings: null })
    const onSaveFailed = vi.fn()
    const cleanup = attachEditorAutosaveController(store)
    try {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, {
          detail: { fileId: FILE_PATH, onSaveFailed }
        })
      )
      await vi.waitFor(() =>
        expect(onSaveFailed).toHaveBeenCalledWith(SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE)
      )
      expect(disk.files.get(FILE_PATH)).toBe('agent rewrite')
      expect(editTab(store)).toBeDefined()
    } finally {
      cleanup()
    }
  })

  it('re-raises the banner when disk moved past what the compare dialog showed', async () => {
    const { disk, store } = setUp('second agent write', 'original', 'mine')
    store.getState().setExternalMutation(FILE_PATH, 'changed')
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'second agent write',
      isBinary: false
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      keepTabEditsOverExternalChange(editTab(store)!, 'first agent write')
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.files.get(FILE_PATH)).toBe('second agent write')
      expect(editTab(store)?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })

  it('keeps a renamed marker when an autosave finds the file gone', async () => {
    const { disk, store } = setUp(null, 'original', 'mine')
    store.getState().setExternalMutation(FILE_PATH, 'renamed')
    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.files.has(FILE_PATH)).toBe(false)
      expect(editTab(store)?.externalMutation).toBe('renamed')
    } finally {
      cleanup()
    }
  })
})
