// Why: the tab's one shared Monaco model owns the disk baseline; these replay the sequences that
// broke when the baseline lived next to per-pane caches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import { requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { __clearSelfWriteRegistryForTests } from './editor-self-write-registry'
import {
  createEditorStore,
  createFakeEditorDisk,
  createFakeEditorModel,
  stubEditorWindowWithDisk,
  type FakeEditorDisk,
  type FakeEditorModel
} from './editor-autosave-controller-test-fixture'
import {
  __clearEditorModelDiskBaselinesForTests,
  noteEditorDraftSource,
  noteEditorModelSynced,
  reportEditorModelEdit,
  stampAppliedEditorContent
} from './editor-model-disk-baseline'
import { getDiskBaselineSignature } from './diff-content-signature'
import {
  keepTabEditsOverExternalChange,
  reloadTabContentFromDisk
} from './ExternalFileChangeBanner'
import { buildEditorSessionData } from '@/lib/workspace-session'
import type * as RuntimeFileReadClient from '@/runtime/runtime-file-read-client'

const mocks = vi.hoisted(() => {
  const store: { current: StoreApi<AppState> | null } = { current: null }
  return { store, readRuntimeFileContent: vi.fn(), toast: vi.fn() }
})
vi.mock('sonner', () => ({ toast: Object.assign(mocks.toast, { error: vi.fn() }) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.store.current?.getState() }
}))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileReadClient>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

const FILE_ID = '/repo/file.ts'

type Harness = {
  disk: FakeEditorDisk
  store: StoreApi<AppState>
  model: FakeEditorModel
  /** A pane mounting or syncing `paneText` into the shared model, as MonacoEditor does. */
  showInPane: (paneText: string, diskContent: string, phase?: 'mount' | 'sync') => void
  /** A keystroke in any pane: the shared model changes and reports its text. */
  type: (text: string) => void
  save: () => Promise<void>
}

function setUp(disk: string, opened: string, eol: '\n' | '\r\n' = '\n'): Harness {
  const fakeDisk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_ID]: disk }))
  const store = createEditorStore()
  mocks.store.current = store
  store.setState({ settings: null })
  store.getState().openFile({
    filePath: FILE_ID,
    relativePath: 'file.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  })
  const model = createFakeEditorModel(opened, eol)
  noteEditorModelSynced(FILE_ID, model.getValue())
  stampAppliedEditorContent(
    model,
    model.getValue(),
    { fileId: FILE_ID, diskContent: opened, restoredDiskSignature: undefined },
    'mount'
  )
  return {
    disk: fakeDisk,
    store,
    model,
    showInPane: (paneText, diskContent, phase = 'sync') => {
      model.setText(paneText)
      noteEditorModelSynced(FILE_ID, model.getValue())
      stampAppliedEditorContent(
        model,
        model.getValue(),
        { fileId: FILE_ID, diskContent, restoredDiskSignature: undefined },
        phase
      )
    },
    type: (text) => {
      model.setText(text)
      reportEditorModelEdit(FILE_ID, () => {
        store.getState().setEditorDraft(FILE_ID, text)
        noteEditorDraftSource(FILE_ID, text)
      })
      store.getState().markFileDirty(FILE_ID, true)
    },
    save: () => requestEditorFileSave({ fileId: FILE_ID })
  }
}

describe('a tab whose shared Monaco model owns the disk baseline', () => {
  let cleanupController: () => void = () => undefined
  beforeEach(() => {
    __clearSelfWriteRegistryForTests()
    __clearEditorModelDiskBaselinesForTests()
    mocks.readRuntimeFileContent.mockReset()
  })
  afterEach(() => {
    cleanupController()
    vi.unstubAllGlobals()
    mocks.store.current = null
  })
  const attach = (harness: Harness): Harness => {
    cleanupController = attachEditorAutosaveController(harness.store)
    return harness
  }

  it('saves normal single-pane edits back to back without a false refusal', async () => {
    const tab = attach(setUp('A', 'A'))
    tab.type('A 1')
    await tab.save()
    tab.type('A 1 2')
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe('A 1 2')
  })

  it('refuses an edit to text loaded before an unnoticed external rewrite', async () => {
    const tab = attach(setUp('A', 'A'))
    tab.disk.files.set(FILE_ID, 'B')
    tab.type('A edited')

    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  it('keeps split panes on one baseline: a stale pane remounting moves both text and base', async () => {
    // Pane 2 loaded B; pane 1 still caches A and remounts, pushing A into the one shared model.
    const tab = attach(setUp('B', 'B'))
    tab.showInPane('A', 'A', 'mount')
    tab.type('A edited')

    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  it('bases an edit in the other pane after an undo to clean on the same model text', async () => {
    const tab = attach(setUp('A', 'A'))
    tab.type('A x')
    tab.type('A')
    tab.store.getState().markFileDirty(FILE_ID, false)
    tab.type('A y')
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe('A y')
  })

  it('does not take a reload as the base when typing kept the old text in the model', async () => {
    // The tab is dirty, so the pane syncs the draft, not the reloaded disk text.
    const tab = attach(setUp('A', 'A'))
    tab.type('A typed')
    tab.disk.files.set(FILE_ID, 'B')
    tab.showInPane('A typed', 'B')

    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  it('re-bases a clean tab when a reload enters the model', async () => {
    const tab = attach(setUp('A', 'A'))
    tab.disk.files.set(FILE_ID, 'B')
    tab.showInPane('B', 'B')
    tab.type('B edited')
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe('B edited')
  })

  it.each([
    ['CRLF line endings', 'a\r\nb', 'a\r\nb\r\nc'],
    ['a byte-order mark', '﻿header', '﻿header edited'],
    ['a stray half of an emoji pair', 'x', 'x \uD800']
  ])('saves twice over %s without a false refusal', async (_label, start, edited) => {
    const tab = attach(setUp(start, start, start.includes('\r\n') ? '\r\n' : '\n'))
    tab.type(edited)
    await tab.save()
    tab.type(`${edited} again`)
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe(
      Buffer.from(`${edited} again`, 'utf8').toString('utf8')
    )
  })

  it('saves over the disk version Keep My Edits adopted', async () => {
    const tab = attach(setUp('A', 'A'))
    tab.type('mine')
    tab.disk.files.set(FILE_ID, 'agent rewrite')
    tab.store.getState().setExternalMutation(FILE_ID, 'changed')
    const tabFile = tab.store.getState().openFiles.find((file) => file.id === FILE_ID)!
    keepTabEditsOverExternalChange(tabFile, 'agent rewrite')
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe('mine')
  })

  it('bases a restored draft on its persisted signature, not the disk loaded at restore', async () => {
    const tab = attach(setUp('B', 'B'))
    const restored = createFakeEditorModel('draft from A')
    noteEditorModelSynced(FILE_ID, 'draft from A')
    stampAppliedEditorContent(
      restored,
      'draft from A',
      {
        fileId: FILE_ID,
        diskContent: 'B',
        restoredDiskSignature: getDiskBaselineSignature('A')
      },
      'mount'
    )
    tab.store.getState().setEditorDraft(FILE_ID, 'draft from A')
    tab.store.getState().markFileDirty(FILE_ID, true)

    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  it('saves text from another editor surface unguarded, as before', async () => {
    // Rich markdown, notebooks and diff panes produce drafts that are not the model's text.
    const tab = attach(setUp('A', 'A'))
    tab.disk.files.set(FILE_ID, 'B')
    tab.store.getState().setEditorDraft(FILE_ID, 'rich editor text')
    noteEditorDraftSource(FILE_ID, 'rich editor text')
    tab.store.getState().markFileDirty(FILE_ID, true)
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe('rich editor text')
  })

  it('re-bases the source model from the store after another surface saved', async () => {
    // Source mode loaded O; the rich editor saved D1 (unguarded) and kept typing D2.
    const tab = attach(setUp('O', 'O'))
    tab.store.getState().setEditorDraft(FILE_ID, 'D1')
    noteEditorDraftSource(FILE_ID, 'D1')
    tab.store.getState().markFileDirty(FILE_ID, true)
    await tab.save()
    tab.store.getState().setEditorDraft(FILE_ID, 'D2')
    noteEditorDraftSource(FILE_ID, 'D2')
    tab.store.getState().markFileDirty(FILE_ID, true)
    // Back in source mode the retained model mounts with D2.
    tab.model.setText('D2')
    stampAppliedEditorContent(
      tab.model,
      'D2',
      {
        fileId: FILE_ID,
        diskContent: 'D1',
        restoredDiskSignature: tab.store.getState().openFiles[0]?.lastKnownDiskSignature
      },
      'mount'
    )
    tab.type('D2 typed in source')
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe('D2 typed in source')
  })

  it('re-bases a remount on saved text holding a stray half of an emoji pair', async () => {
    const tab = attach(setUp('x', 'x'))
    tab.type('x \uD800')
    await tab.save()
    // The saved event caches the editor's own string, which the remount pushes back as disk text.
    tab.showInPane('x \uD800', 'x \uD800', 'mount')
    tab.type('x \uD800 more')
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe('x \uFFFD more')
  })

  it('keeps one baseline for one model when two tabs share it', async () => {
    // Two tab ids (different workspaces, same file and owner) point at one Monaco model.
    const tab = attach(setUp('B', 'B'))
    stampAppliedEditorContent(
      tab.model,
      'A',
      { fileId: 'other-tab', diskContent: 'A', restoredDiskSignature: undefined },
      'mount'
    )
    tab.model.setText('A')
    tab.type('A edited')

    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  it('saves the model text, guarded, while a chunked paste has not reached the draft yet', async () => {
    const tab = attach(setUp('A', 'A'))
    tab.type('A typed')
    tab.disk.files.set(FILE_ID, 'B')
    // The paste lands in the model before the draft catches up.
    tab.model.setText('A typed + pasted')

    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  it('guards a restored draft whose model has not mounted yet with its persisted base', async () => {
    const fakeDisk = stubEditorWindowWithDisk(createFakeEditorDisk({ [FILE_ID]: 'B' }))
    const store = createEditorStore()
    mocks.store.current = store
    store.setState({ settings: null })
    store.getState().openFile({
      filePath: FILE_ID,
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature('A'))
    store.getState().setEditorDraft(FILE_ID, 'draft from A')
    store.getState().markFileDirty(FILE_ID, true)
    cleanupController = attachEditorAutosaveController(store)

    await expect(requestEditorFileSave({ fileId: FILE_ID })).rejects.toThrow()
    expect(fakeDisk.files.get(FILE_ID)).toBe('B')
  })

  it('raises the banner when an explicit save of a clean tab is refused', async () => {
    // Cmd+S with no edits (or a Markdown whitespace-only edit that stays clean) after a missed rewrite.
    const tab = attach(setUp('A', 'A'))
    tab.disk.files.set(FILE_ID, 'B')

    await expect(requestEditorFileSave({ fileId: FILE_ID, fallbackContent: 'A' })).rejects.toThrow()
    expect(tab.store.getState().openFiles[0]?.externalMutation).toBe('changed')
  })

  it('keeps the source model guarded when a slow rich-editor save lands after the user went back to it', async () => {
    const tab = attach(setUp('O', 'O'))
    let releaseWrite: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    tab.disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        await gate
        tab.disk.files.set(filePath, content)
        return { ok: true }
      }
    )
    // The rich editor saves D1 (unguarded) slowly…
    tab.store.getState().setEditorDraft(FILE_ID, 'D1')
    noteEditorDraftSource(FILE_ID, 'D1')
    tab.store.getState().markFileDirty(FILE_ID, true)
    const richSave = tab.save()
    await vi.waitFor(() => expect(tab.disk.fs.writeFile).toHaveBeenCalledTimes(1))
    // …while the user switches to source mode and types there.
    tab.type('D2 from source')
    releaseWrite()
    await richSave

    // The model's base was dropped; a draft saved now still carries the store's version.
    const state = tab.store.getState()
    expect(
      buildEditorSessionData(state.openFiles, state.editorDrafts, {}, {}, {}).openFilesByWorktree?.[
        'wt-1'
      ]?.[0]?.lastKnownDiskSignature
    ).toBe(state.openFiles[0]?.lastKnownDiskSignature)
    expect(state.openFiles[0]?.lastKnownDiskSignature).toBeDefined()

    await tab.save()
    expect(tab.disk.files.get(FILE_ID)).toBe('D2 from source')
  })

  it('re-bases a source pane that remounted onto a slow rich-editor save once it lands', async () => {
    const tab = attach(setUp('O', 'O'))
    let releaseWrite: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    tab.disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        await gate
        tab.disk.files.set(filePath, content)
        return { ok: true }
      }
    )
    tab.store.getState().setEditorDraft(FILE_ID, 'D1')
    noteEditorDraftSource(FILE_ID, 'D1')
    tab.store.getState().markFileDirty(FILE_ID, true)
    const richSave = tab.save()
    await vi.waitFor(() => expect(tab.disk.fs.writeFile).toHaveBeenCalledTimes(1))
    // The source pane remounts showing the dirty draft, before the write lands.
    tab.showInPane('D1', 'O', 'mount')
    releaseWrite()
    await richSave

    tab.disk.files.set(FILE_ID, 'agent rewrite')
    tab.type('D1 typed')
    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('agent rewrite')
  })

  it('keeps a dirty tab in one workspace on its own base while another workspace loads newer disk', async () => {
    // Each workspace's tab has its own model now, so workspace 2's load re-bases only its own.
    const tab = attach(setUp('A', 'A'))
    tab.type('A edited')
    tab.disk.files.set(FILE_ID, 'B')
    tab.store.getState().openFile({
      filePath: FILE_ID,
      relativePath: 'file.ts',
      worktreeId: 'wt-2',
      language: 'typescript',
      mode: 'edit'
    })
    const otherTab = tab.store.getState().openFiles.find((file) => file.worktreeId === 'wt-2')!
    expect(otherTab.id).not.toBe(FILE_ID)
    const otherModel = createFakeEditorModel('B')
    stampAppliedEditorContent(
      otherModel,
      otherModel.getValue(),
      { fileId: otherTab.id, diskContent: 'B', restoredDiskSignature: undefined },
      'mount'
    )

    const state = tab.store.getState()
    expect(
      buildEditorSessionData(state.openFiles, state.editorDrafts, {}, {}, {}).openFilesByWorktree?.[
        'wt-1'
      ]?.[0]?.lastKnownDiskSignature
    ).toBe(getDiskBaselineSignature('A'))
    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  it('persists the model text with its base when a save lands mid chunked paste', async () => {
    const tab = attach(setUp('A', 'A'))
    tab.type('A typed')
    // The paste lands in the model; the save writes it before the draft catches up.
    tab.model.setText('A typed + pasted')
    await tab.save()
    expect(tab.disk.files.get(FILE_ID)).toBe('A typed + pasted')
    tab.store.getState().markFileDirty(FILE_ID, true)

    const state = tab.store.getState()
    const persisted = buildEditorSessionData(state.openFiles, state.editorDrafts, {}, {}, {})
      .openFilesByWorktree?.['wt-1']?.[0]
    // A restore must never pair the pre-paste draft with the saved text's version.
    expect(persisted?.dirtyDraftContent).toBe('A typed + pasted')
    expect(persisted?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('A typed + pasted'))
  })

  it("keeps a reload's Undo draft paired with its own base while the tab's model holds the reload", async () => {
    const tab = attach(setUp('A', 'A'))
    tab.store.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature('A'))
    tab.type('D')
    tab.disk.files.set(FILE_ID, 'B')
    const file = tab.store.getState().openFiles[0]!
    // Reload: the model takes B; then the user switches tabs, so no pane re-syncs it.
    reloadTabContentFromDisk(file, () => {
      tab.showInPane('B', 'B')
      tab.store.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature('B'))
    })
    const undo: () => void = mocks.toast.mock.calls[0]?.[1]?.action?.onClick
    undo()

    const state = tab.store.getState()
    const persisted = buildEditorSessionData(state.openFiles, state.editorDrafts, {}, {}, {})
      .openFilesByWorktree?.['wt-1']?.[0]
    expect(persisted?.dirtyDraftContent).toBe('D')
    expect(persisted?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('A'))
    // Saving the restored draft is checked against the version it was edited from.
    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  it('adopts a slow save reply only if no reload re-based the tab meanwhile', async () => {
    const tab = attach(setUp('A', 'A'))
    let releaseWrite: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    tab.disk.fs.writeFile.mockImplementationOnce(
      async ({ filePath, content }: { filePath: string; content: string }) => {
        tab.disk.files.set(filePath, content)
        await gate
        return { ok: true }
      }
    )
    tab.type('X')
    const slowSave = tab.save()
    await vi.waitFor(() => expect(tab.disk.fs.writeFile).toHaveBeenCalledTimes(1))
    // While the reply is in flight, an agent writes B and the user reloads it and edits.
    tab.disk.files.set(FILE_ID, 'B')
    tab.store.getState().markFileDirty(FILE_ID, false)
    tab.showInPane('B', 'B')
    tab.store.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature('B'))
    releaseWrite()
    await slowSave
    tab.type('B edited')
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe('B edited')
  })

  it('persists a draft with the base its model holds, so a restart cannot adopt a newer one', async () => {
    // The store loaded B; a stale split pane remounted A into the shared model, and the user typed.
    const tab = attach(setUp('B', 'B'))
    tab.store.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature('B'))
    tab.showInPane('A', 'A', 'mount')
    tab.type('A edited')

    const state = tab.store.getState()
    const persisted = buildEditorSessionData(state.openFiles, state.editorDrafts, {}, {}, {})
      .openFilesByWorktree?.['wt-1']?.[0]
    expect(persisted?.dirtyDraftContent).toBe('A edited')
    expect(persisted?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('A'))

    // After a restart the restored draft has no model yet; its save is guarded by what was persisted.
    __clearEditorModelDiskBaselinesForTests()
    tab.store.getState().setLastKnownDiskSignature(FILE_ID, persisted?.lastKnownDiskSignature ?? '')
    await expect(tab.save()).rejects.toThrow()
    expect(tab.disk.files.get(FILE_ID)).toBe('B')
  })

  // Why: Monaco keeps one line ending, so disk text with others enters the model converted.
  it.each([
    ['a CRLF model over LF disk', 'a\nb', '\r\n' as const],
    ['an LF model over CRLF disk', 'a\r\nb', '\n' as const],
    ['a CRLF model over mixed line endings', 'a\r\nb\nc', '\r\n' as const]
  ])('re-bases %s when a reload enters the model', async (_label, reloaded, eol) => {
    const tab = attach(setUp('O', 'O', eol))
    tab.disk.files.set(FILE_ID, reloaded)
    tab.showInPane(reloaded, reloaded)
    tab.type(`${tab.model.getValue()} edited`)
    await tab.save()

    expect(tab.disk.files.get(FILE_ID)).toBe(`${tab.model.getValue()}`)
  })
})
