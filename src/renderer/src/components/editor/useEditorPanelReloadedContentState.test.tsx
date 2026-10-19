// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  readRuntimeFileContent: vi.fn(),
  setLastKnownDiskSignature: vi.fn()
}))

vi.mock('@/runtime/runtime-file-routing', () => ({ getRuntimeFileReadScope: vi.fn(() => null) }))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/runtime-file-watch-client', () => ({ subscribeRuntimeFileChanges: vi.fn() }))
vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: vi.fn()
}))
vi.mock('@/runtime/runtime-git-client-context', () => ({ getRuntimeGitScope: vi.fn(() => null) }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  isWorktreeConnectionResolved: vi.fn(() => true)
}))
vi.mock('@/lib/worktree-host-connection-phase', () => import('./local-host-test-fixture'))
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

import { getDiskBaselineSignature } from './diff-content-signature'
import { ORCA_EDITOR_FILE_RELOADED_EVENT } from './editor-autosave'
import { useEditorPanelContentState } from './useEditorPanelContentState'

const file: OpenFile = {
  id: '/repo/file.ts',
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  isDirty: false,
  mode: 'edit'
}
const OPEN_FILES = [file]
const EMPTY_VIEW_MODE = {}
let latestFileContents: Record<string, FileContent> = {}

function Probe(): null {
  latestFileContents = useEditorPanelContentState({
    activeFile: file,
    isChangesMode: false,
    openFiles: OPEN_FILES,
    gitStatusEntries: undefined,
    editorViewMode: EMPTY_VIEW_MODE
  }).fileContents
  return null
}

describe('useEditorPanelContentState banner reload', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    latestFileContents = {}
    mocks.readRuntimeFileContent.mockReset()
    mocks.setLastKnownDiskSignature.mockReset()
    mocks.getState.mockReturnValue({
      settings: null,
      openFiles: OPEN_FILES,
      setLastKnownDiskSignature: mocks.setLastKnownDiskSignature
    })
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('ignores an older file read that resolves after the reload', async () => {
    let resolveStaleRead: (value: FileContent) => void = () => undefined
    mocks.readRuntimeFileContent
      .mockReturnValueOnce(
        new Promise<FileContent>((resolve) => {
          resolveStaleRead = resolve
        })
      )
      .mockResolvedValue({ content: 'reloaded text', isBinary: false })

    await act(async () => {
      root.render(<Probe />)
    })
    await vi.waitFor(() => expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1))

    act(() => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_FILE_RELOADED_EVENT, {
          detail: { fileId: file.id, content: 'reloaded text' }
        })
      )
    })
    expect(latestFileContents[file.id]?.content).toBe('reloaded text')

    await act(async () => {
      resolveStaleRead({ content: 'stale content', isBinary: false })
    })
    expect(latestFileContents[file.id]?.content).toBe('reloaded text')
    expect(mocks.setLastKnownDiskSignature).not.toHaveBeenCalledWith(
      file.id,
      getDiskBaselineSignature('stale content')
    )
  })
})
