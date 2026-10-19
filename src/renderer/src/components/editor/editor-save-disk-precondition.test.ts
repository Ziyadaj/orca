import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests, hasRecentSelfWrite } from './editor-self-write-registry'
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
import { SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE } from './editor-save-disk-precondition'

const mocks = vi.hoisted(() => ({
  getConnectionIdForFile: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

const FILE_ID = '/repo/file.ts'

function openDirtyFileWithBaseline(
  store: ReturnType<typeof createEditorStore>,
  baseline: string,
  draft: string
): void {
  store.getState().openFile({
    filePath: FILE_ID,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  store.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature(baseline))
  // The tab's shared Monaco model holds the draft and is based on `baseline`.
  stampEditorModelDiskBaseline(
    FILE_ID,
    createFakeEditorModel(draft),
    getDiskBaselineSignature(baseline)
  )
  store.getState().setEditorDraft(FILE_ID, draft)
  store.getState().markFileDirty(FILE_ID, true)
}

function disableAutoSave(store: ReturnType<typeof createEditorStore>): void {
  const settings = store.getState().settings
  if (settings) {
    store.setState({ settings: { ...settings, editorAutoSave: false } })
  }
}

function liveFile(store: ReturnType<typeof createEditorStore>) {
  return store.getState().openFiles.find((file) => file.id === FILE_ID)
}

describe('editor save disk precondition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
    __clearEditorModelDiskBaselinesForTests()
  })

  it('autosaves over an unchanged disk and rebaselines to the saved content', async () => {
    const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_ID]: 'original' }))
    const store = createEditorStore()
    openDirtyFileWithBaseline(store, 'original', 'edited')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          diskPrecondition: { expectedSignature: getDiskBaselineSignature('original') }
        })
      )
      expect(disk.files.get(FILE_ID)).toBe('edited')
      expect(liveFile(store)?.isDirty).toBe(false)
      expect(liveFile(store)?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('edited'))
    } finally {
      cleanup()
    }
  })

  it('refuses an autosave over an unnoticed external write and raises the banner', async () => {
    const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_ID]: 'agent rewrite' }))
    const store = createEditorStore()
    openDirtyFileWithBaseline(store, 'original', 'edited')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
      expect(disk.files.get(FILE_ID)).toBe('agent rewrite')
      const file = liveFile(store)
      expect(file?.isDirty).toBe(true)
      expect(file?.externalMutation).toBe('changed')
      expect(file?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('original'))
      expect(store.getState().editorDrafts[FILE_ID]).toBe('edited')
      expect(hasRecentSelfWrite(FILE_ID, 'agent rewrite')).toBe(false)

      // The banner suspends autosave, so no retry loop hammers the disk.
      await vi.advanceTimersByTimeAsync(5000)
      expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  it('rejects an explicit save over an unnoticed external write and keeps the draft', async () => {
    const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_ID]: 'agent rewrite' }))
    const store = createEditorStore()
    disableAutoSave(store)
    openDirtyFileWithBaseline(store, 'original', 'edited')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: FILE_ID })).rejects.toThrow(
        SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE
      )

      expect(disk.files.get(FILE_ID)).toBe('agent rewrite')
      expect(liveFile(store)?.isDirty).toBe(true)
      expect(liveFile(store)?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })

  it('lets an explicit save under the changed-on-disk banner overwrite the disk', async () => {
    const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_ID]: 'agent rewrite' }))
    const store = createEditorStore()
    disableAutoSave(store)
    openDirtyFileWithBaseline(store, 'original', 'edited')
    store.getState().setExternalMutation(FILE_ID, 'changed')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: FILE_ID, confirmDiskOverwrite: true })

      expect(disk.fs.writeFile).toHaveBeenCalledWith(
        expect.not.objectContaining({ diskPrecondition: expect.anything() })
      )
      expect(disk.files.get(FILE_ID)).toBe('edited')
      expect(liveFile(store)?.isDirty).toBe(false)
      expect(liveFile(store)?.externalMutation).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('verifies an explicit save while the restored baseline is still unverified', async () => {
    const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_ID]: 'agent rewrite' }))
    const store = createEditorStore()
    disableAutoSave(store)
    openDirtyFileWithBaseline(store, 'original', 'restored draft')
    store.setState({
      openFiles: store
        .getState()
        .openFiles.map((f) =>
          f.id === FILE_ID ? { ...f, pendingDiskBaselineVerification: true } : f
        )
    })

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: FILE_ID })).rejects.toThrow(
        SAVE_REFUSED_CHANGED_ON_DISK_MESSAGE
      )

      expect(disk.files.get(FILE_ID)).toBe('agent rewrite')
      const file = liveFile(store)
      expect(file?.externalMutation).toBe('changed')
      expect(file?.pendingDiskBaselineVerification).toBeFalsy()
    } finally {
      cleanup()
    }
  })

  it('tombstones instead of autosave-resurrecting a file deleted outside Orca', async () => {
    const disk = stubEditorWindowWithDisk(createFakeEditorDisk())
    const store = createEditorStore()
    openDirtyFileWithBaseline(store, 'original', 'edited')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await vi.advanceTimersByTimeAsync(1500)

      expect(disk.files.has(FILE_ID)).toBe(false)
      expect(liveFile(store)?.externalMutation).toBe('deleted')
      expect(liveFile(store)?.isDirty).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('recreates a deleted file on an explicit save', async () => {
    const disk = stubEditorWindowWithDisk(createFakeEditorDisk())
    const store = createEditorStore()
    disableAutoSave(store)
    openDirtyFileWithBaseline(store, 'original', 'edited')

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorFileSave({ fileId: FILE_ID })

      expect(disk.fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          diskPrecondition: {
            expectedSignature: getDiskBaselineSignature('original'),
            allowMissing: true
          }
        })
      )
      expect(disk.files.get(FILE_ID)).toBe('edited')
      expect(liveFile(store)?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })
})
