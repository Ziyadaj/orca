// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const attemptEditorFileSave = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./editor-file-save-attempt', () => ({ attemptEditorFileSave }))

import { useEditorPanelSave } from './useEditorPanelSave'

afterEach(() => {
  cleanup()
  attemptEditorFileSave.mockClear()
})

const source: OpenFile = {
  id: 'source',
  filePath: '/repo/notes.md',
  relativePath: 'notes.md',
  worktreeId: 'wt',
  language: 'markdown',
  mode: 'edit',
  isDirty: true,
  externalMutation: 'changed'
}
const preview: OpenFile = {
  ...source,
  id: 'preview',
  mode: 'markdown-preview',
  markdownPreviewSourceFileId: 'source',
  isDirty: false,
  externalMutation: undefined
}

function renderSave(activeFile: OpenFile) {
  return renderHook(() =>
    useEditorPanelSave({
      activeFile,
      openFiles: [source, preview],
      requestRenameForFile: vi.fn()
    })
  ).result
}

it('takes Save in the editor showing the banner as the overwrite choice', async () => {
  await renderSave(source).current.handleSave('mine')

  expect(attemptEditorFileSave).toHaveBeenCalledWith(
    expect.objectContaining({ fileId: 'source', confirmDiskOverwrite: true })
  )
})

it('keeps the guard for Save from a preview tab, which shows no banner', async () => {
  await renderSave(preview).current.handleSave('mine')

  expect(attemptEditorFileSave).toHaveBeenCalledWith(
    expect.not.objectContaining({ confirmDiskOverwrite: true })
  )
})
