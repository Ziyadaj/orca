import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hashMarkdownContent,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES
} from '../../../shared/mobile-markdown-document'
import { attachEditorAutosaveController } from '../components/editor/editor-autosave-controller'
import { useAppStore } from '../store'
import { attachMobileMarkdownBridge } from './mobile-markdown-bridge'
import { createFakeEditorModel } from '../components/editor/editor-autosave-controller-test-fixture'
import {
  __clearEditorModelDiskBaselinesForTests,
  noteEditorDraftSource,
  noteEditorModelSynced,
  persistedEditorDraftFields,
  reportEditorModelEdit,
  resolveEditorSaveBaseline,
  stampEditorModelDiskBaseline
} from '../components/editor/editor-model-disk-baseline'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import {
  cleanupMobileMarkdownBridgeHarness,
  createDeferred,
  openMarkdownFile,
  resetEditorState,
  sendRequest,
  setupWindow
} from './mobile-markdown-bridge-test-harness'

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => null
}))

describe('mobile markdown bridge save guards', () => {
  beforeEach(() => {
    resetEditorState()
  })

  afterEach(() => {
    cleanupMobileMarkdownBridgeHarness()
  })

  it('restores the previous desktop draft when a mobile save write fails', async () => {
    openMarkdownFile()
    const state = useAppStore.getState()
    state.setEditorDraft('/repo/README.md', 'desktop draft')
    state.markFileDirty('/repo/README.md', true)
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: 'desktop draft', isBinary: false }),
      writeFile: vi.fn().mockRejectedValue(new Error('disk full'))
    })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const response = await sendRequest({
        id: 'save-fail',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('desktop draft'),
        content: 'mobile edit'
      })

      expect(response).toMatchObject({ id: 'save-fail', ok: false })
      expect(useAppStore.getState().editorDrafts['/repo/README.md']).toBe('desktop draft')
      expect(useAppStore.getState().openFiles[0]?.isDirty).toBe(true)
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('keeps the desktop draft guarded after a failed mobile save rolls back', async () => {
    openMarkdownFile()
    const fileId = '/repo/README.md'
    // The desktop draft was typed in the tab's Monaco model, which knows its disk version.
    const model = createFakeEditorModel('desktop draft')
    stampEditorModelDiskBaseline(fileId, model, getDiskBaselineSignature('disk'))
    reportEditorModelEdit(fileId, () => {
      useAppStore.getState().setEditorDraft(fileId, 'desktop draft')
      noteEditorDraftSource(fileId, 'desktop draft')
    })
    useAppStore.getState().markFileDirty(fileId, true)
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: 'desktop draft', isBinary: false }),
      writeFile: vi.fn().mockRejectedValue(new Error('disk full'))
    })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      await sendRequest({
        id: 'save-fail',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('desktop draft'),
        content: 'mobile edit'
      })

      expect(resolveEditorSaveBaseline(fileId, 'desktop draft', '', undefined)).toMatchObject({
        fromModel: true,
        signature: getDiskBaselineSignature('disk')
      })
    } finally {
      detachAutosave()
      detachBridge()
      __clearEditorModelDiskBaselinesForTests()
    }
  })

  it('persists the restored desktop draft, not the phone text a hidden pane left in the model', async () => {
    openMarkdownFile()
    const fileId = '/repo/README.md'
    const model = createFakeEditorModel('desktop draft')
    stampEditorModelDiskBaseline(fileId, model, getDiskBaselineSignature('disk'))
    reportEditorModelEdit(fileId, () => {
      useAppStore.getState().setEditorDraft(fileId, 'desktop draft')
      noteEditorDraftSource(fileId, 'desktop draft')
    })
    useAppStore.getState().markFileDirty(fileId, true)
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: 'desktop draft', isBinary: false }),
      writeFile: vi.fn().mockImplementation(async () => {
        // The source pane synced the phone's text into the model, then the user switched tabs.
        model.setText('mobile edit')
        noteEditorModelSynced(fileId, 'mobile edit')
        throw new Error('disk full')
      })
    })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      await sendRequest({
        id: 'save-fail',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('desktop draft'),
        content: 'mobile edit'
      })

      expect(
        persistedEditorDraftFields(
          fileId,
          useAppStore.getState().editorDrafts[fileId],
          getDiskBaselineSignature('disk')
        ).dirtyDraftContent
      ).toBe('desktop draft')
      expect(
        resolveEditorSaveBaseline(fileId, 'desktop draft', '', getDiskBaselineSignature('disk'))
          .content
      ).toBe('desktop draft')
    } finally {
      detachAutosave()
      detachBridge()
      __clearEditorModelDiskBaselinesForTests()
    }
  })

  it('restores the previous desktop draft when save verification fails after write', async () => {
    openMarkdownFile()
    const state = useAppStore.getState()
    state.setEditorDraft('/repo/README.md', 'desktop draft')
    state.markFileDirty('/repo/README.md', true)
    let diskContent = 'desktop draft'
    const readFile = vi.fn().mockImplementation(async () => ({
      content: 'verified mismatch',
      isBinary: false
    }))
    const writeFile = vi.fn().mockImplementation(async ({ content }) => {
      diskContent = content
    })
    setupWindow({ readFile, writeFile })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const response = await sendRequest({
        id: 'save-verify-fail',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('desktop draft'),
        content: 'mobile edit'
      })

      expect(response).toMatchObject({ id: 'save-verify-fail', ok: false })
      expect(diskContent).toBe('mobile edit')
      expect(useAppStore.getState().editorDrafts['/repo/README.md']).toBe('desktop draft')
      expect(useAppStore.getState().openFiles[0]?.isDirty).toBe(true)
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('serializes saves so duplicate base versions do not both write', async () => {
    openMarkdownFile()
    let diskContent = 'original'
    const firstWrite = createDeferred()
    const readFile = vi.fn().mockImplementation(async () => ({
      content: diskContent,
      isBinary: false
    }))
    const writeFile = vi.fn().mockImplementation(async ({ content }) => {
      if (content === 'first edit') {
        await firstWrite.promise
      }
      diskContent = content
    })
    setupWindow({ readFile, writeFile })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const first = sendRequest({
        id: 'save-a',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'first edit'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const second = sendRequest({
        id: 'save-b',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'second edit'
      })
      firstWrite.resolve()

      await expect(first).resolves.toMatchObject({ id: 'save-a', ok: true })
      await expect(second).resolves.toMatchObject({ id: 'save-b', ok: false, error: 'conflict' })
      expect(diskContent).toBe('first edit')
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('treats a duplicate same-content save as idempotent success', async () => {
    openMarkdownFile()
    let diskContent = 'original'
    const firstWrite = createDeferred()
    const readFile = vi.fn().mockImplementation(async () => ({
      content: diskContent,
      isBinary: false
    }))
    const writeFile = vi.fn().mockImplementation(async ({ content }) => {
      if (content === 'mobile edit' && diskContent === 'original') {
        await firstWrite.promise
      }
      diskContent = content
    })
    setupWindow({ readFile, writeFile })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const first = sendRequest({
        id: 'save-a',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'mobile edit'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const second = sendRequest({
        id: 'save-b',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'mobile edit'
      })
      firstWrite.resolve()

      await expect(first).resolves.toMatchObject({ id: 'save-a', ok: true })
      await expect(second).resolves.toMatchObject({ id: 'save-b', ok: true })
      expect(diskContent).toBe('mobile edit')
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('rejects oversized multibyte mobile saves before writing', async () => {
    openMarkdownFile()
    const content = '😀'.repeat(Math.floor(MOBILE_MARKDOWN_EDIT_MAX_BYTES / 4) + 1)
    const writeFile = vi.fn().mockResolvedValue(undefined)
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: 'original', isBinary: false }),
      writeFile
    })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'save-large-multibyte',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content
      })

      expect(response).toMatchObject({
        id: 'save-large-multibyte',
        ok: false,
        error: 'file_too_large'
      })
      expect(writeFile).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })
})
