// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore, stubEditorWindow } from './editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import { replaceModelContentAsUndoStep } from './monaco-content-sync'
import { watchReloadUndoBoundary } from './reload-undo-autosave-pause'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

const FILE_ID = '/repo/file.ts'

describe('autosave pause after undoing past a reload', () => {
  let model: monaco.editor.ITextModel
  let store: ReturnType<typeof createEditorStore>
  let writeFile: ReturnType<typeof vi.fn>
  let cleanup: () => void

  // Why: stands in for the editor bridge, which records every model change as the tab's draft.
  function syncDraftFromModel(): void {
    store.getState().setEditorDraft(FILE_ID, model.getValue())
    store.getState().markFileDirty(FILE_ID, model.getValue() !== 'agent text')
  }

  function type(text: string): void {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
    syncDraftFromModel()
  }

  async function undo(): Promise<void> {
    await model.undo()
    syncDraftFromModel()
  }

  async function redo(): Promise<void> {
    await model.redo()
    syncDraftFromModel()
  }

  async function autosaveWrites(): Promise<string[]> {
    writeFile.mockClear()
    await vi.advanceTimersByTimeAsync(1500)
    return writeFile.mock.calls.map(([request]) => request.content)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    model = monaco.editor.createModel('user draft', 'plaintext')
    writeFile = stubEditorWindow()
    store = createEditorStore()
    store.getState().openFile({
      filePath: FILE_ID,
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    cleanup = attachEditorAutosaveController(store)
    // The banner reload: one undoable edit to the agent's text, tab clean.
    replaceModelContentAsUndoStep(model, 'agent text')
    watchReloadUndoBoundary(model, FILE_ID)
  })

  afterEach(() => {
    cleanup()
    model.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('autosave never writes undone-reload text; an explicit save does', async () => {
    type('agent text, then typing')
    // Why: an autosave between the typing and the undo must not clear the boundary.
    expect(await autosaveWrites()).toEqual(['agent text, then typing'])

    await undo()
    await undo()
    expect(model.getValue()).toBe('user draft')
    expect(await autosaveWrites()).toEqual([])
    expect(store.getState().openFiles[0]?.externalMutation).toBeUndefined()

    writeFile.mockClear()
    await requestEditorFileSave({ fileId: FILE_ID })
    expect(writeFile.mock.calls.map(([request]) => request.content)).toEqual(['user draft'])
  })

  it('redo back across the reload leaves the tab clean and autosave running', async () => {
    type('agent text, then typing')
    await undo()
    await undo()
    await redo()

    expect(model.getValue()).toBe('agent text')
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    await redo()
    expect(await autosaveWrites()).toEqual(['agent text, then typing'])
  })

  it('crossing the boundary again after an explicit save pauses again', async () => {
    await undo()
    await requestEditorFileSave({ fileId: FILE_ID })
    await redo()
    await undo()

    expect(model.getValue()).toBe('user draft')
    expect(await autosaveWrites()).toEqual([])
  })

  it('a disk change after the undo raises the normal conflict', async () => {
    await undo()
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
        detail: { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'file.ts' }
      })
    )

    expect(store.getState().openFiles[0]?.externalMutation).toBe('changed')
    expect(store.getState().editorDrafts[FILE_ID]).toBe('user draft')
  })
})
