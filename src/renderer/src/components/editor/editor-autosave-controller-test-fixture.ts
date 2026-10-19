// Why: shared rig for autosave-controller suites — the controller needs a
// real editor store slice plus a window stub (event target, timers, fs
// bridge), and duplicating that per test file bloats suites past max-lines.
import { vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice } from '@/store/slices/editor'
import type { AppState } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  compareDiskWritePrecondition,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../../shared/file-write-disk-precondition'

export type FakeEditorDisk = {
  files: Map<string, string>
  fs: {
    writeFile: ReturnType<typeof vi.fn>
    deletePath: ReturnType<typeof vi.fn>
    stat: ReturnType<typeof vi.fn>
  }
}

/** In-memory stand-in for window.api.fs, so tests assert what is actually on disk. */
export function createFakeEditorDisk(initialFiles: Record<string, string> = {}): FakeEditorDisk {
  const files = new Map(Object.entries(initialFiles))
  return {
    files,
    fs: {
      writeFile: vi.fn(
        async ({
          filePath,
          content,
          diskPrecondition
        }: {
          filePath: string
          content: string
          diskPrecondition?: FileWriteDiskPrecondition
        }): Promise<FileWriteResult> => {
          // Why: mirrors main's writer, which refuses when disk drifted from the tab's baseline.
          const diskConflict = diskPrecondition
            ? compareDiskWritePrecondition(diskPrecondition, files.get(filePath) ?? null)
            : null
          if (diskConflict) {
            return { ok: false, diskConflict }
          }
          // Why: a UTF-8 write stores each lone surrogate as U+FFFD, as main's does.
          files.set(filePath, Buffer.from(content, 'utf8').toString('utf8'))
          return { ok: true }
        }
      ),
      deletePath: vi.fn(async ({ targetPath }: { targetPath: string }) => {
        files.delete(targetPath)
      }),
      stat: vi.fn(async ({ filePath }: { filePath: string }) => {
        const content = files.get(filePath)
        if (content === undefined) {
          throw new Error(`ENOENT: no such file ${filePath}`)
        }
        return { size: content.length, isDirectory: false, mtime: 0 }
      })
    }
  }
}

export type EditorWindowStub = {
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  dispatchEvent: Window['dispatchEvent']
  setTimeout: Window['setTimeout']
  clearTimeout: Window['clearTimeout']
  api: { fs: FakeEditorDisk['fs'] }
}

/** Stubs the global window with an isolated event target backed by `disk`. */
export function stubEditorWindowWithDisk(
  disk: FakeEditorDisk = createFakeEditorDisk()
): FakeEditorDisk {
  const eventTarget = new EventTarget()
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: { fs: disk.fs }
  } satisfies EditorWindowStub)
  return disk
}

/** Stubs the global window with an isolated event target and fs bridge;
 *  returns the writeFile mock for assertions. */
export function stubEditorWindow(): ReturnType<typeof vi.fn> {
  return stubEditorWindowWithDisk().fs.writeFile
}

export function createEditorStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    repos: [],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', hostId: 'local' }]
    },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: {},
    sshStateByEnvironment: {},
    settings: {
      editorAutoSave: true,
      editorAutoSaveDelayMs: 1000
    },
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

/** Store with a local worktree at /repo and an open, untouched untitled note at /repo/`fileName`. */
export function createUntitledNoteStore(fileName: string): StoreApi<AppState> {
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    },
    browserTabsByWorktree: {},
    tabsByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  store.getState().openFile({
    filePath: `/repo/${fileName}`,
    relativePath: fileName,
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit',
    isUntitled: true
  })
  return store
}

export type FakeEditorModel = {
  getValue: () => string
  getEOL: () => string
  isDisposed: () => boolean
  onWillDispose: (listener: () => void) => { dispose: () => void }
  setText: (text: string) => void
  dispose: () => void
}

/** Stands in for a tab's shared Monaco model: holds text and can be disposed. */
/** `eol` mimics Monaco's single line ending; text set on the model is converted to it. */
export function createFakeEditorModel(text: string, eol: '\n' | '\r\n' = '\n'): FakeEditorModel {
  const toModelEol = (value: string): string => value.replace(/\r\n|\r|\n/g, eol)
  let current = toModelEol(text)
  let disposed = false
  const disposeListeners: (() => void)[] = []
  return {
    getValue: () => current,
    getEOL: () => eol,
    isDisposed: () => disposed,
    onWillDispose: (listener) => {
      disposeListeners.push(listener)
      return { dispose: () => undefined }
    },
    setText: (next) => {
      current = toModelEol(next)
    },
    dispose: () => {
      disposed = true
      for (const listener of disposeListeners) {
        listener()
      }
    }
  }
}
