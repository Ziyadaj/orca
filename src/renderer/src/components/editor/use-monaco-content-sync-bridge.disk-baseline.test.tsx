// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { editor } from 'monaco-editor'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { createFakeEditorModel } from './editor-autosave-controller-test-fixture'
import {
  __clearEditorModelDiskBaselinesForTests,
  resolveEditorSaveBaseline,
  stampEditorModelDiskBaseline,
  type EditorDiskBaselineSource
} from './editor-model-disk-baseline'
import { useMonacoContentSyncBridge } from './use-monaco-content-sync-bridge'

const MODEL_KEY = 'file:///repo/file.ts'

afterEach(() => {
  cleanup()
  __clearEditorModelDiskBaselinesForTests()
})

it('re-bases the model when a reload lands exactly the text the model already holds', () => {
  // The dirty draft "D" equals the new disk text, so the reload pushes nothing into the model.
  const model = Object.assign(createFakeEditorModel('D'), { uri: { toString: () => MODEL_KEY } })
  stampEditorModelDiskBaseline('tab', model, getDiskBaselineSignature('O'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge reads only getModel on this path.
  const editorInstance = { getModel: () => model } as unknown as editor.IStandaloneCodeEditor
  const source = (diskContent: string): EditorDiskBaselineSource => ({
    fileId: 'tab',
    diskContent,
    restoredDiskSignature: undefined
  })
  const { rerender } = renderHook(
    ({ diskContent }: { diskContent: string }) =>
      useMonacoContentSyncBridge({
        editorRef: { current: editorInstance },
        content: 'D',
        contentRef: { current: 'D' },
        contentSyncModeRef: { current: 'undoable' },
        modelKey: MODEL_KEY,
        onContentChange: () => undefined,
        diskBaselineRef: { current: source(diskContent) },
        diskContent
      }),
    { initialProps: { diskContent: 'O' } }
  )

  rerender({ diskContent: 'D' })

  expect(resolveEditorSaveBaseline('tab', undefined, 'D', undefined).signature).toBe(
    getDiskBaselineSignature('D')
  )
})

it('does not push a lagging content prop over a paste when only the disk text changed', () => {
  // Autosave mid paste wrote the model's text M; the saved event changes the disk text, but the
  // content prop (the draft) still lags at D0.
  const model = Object.assign(createFakeEditorModel('M'), { uri: { toString: () => MODEL_KEY } })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a push would call model methods this fake lacks and throw.
  const editorInstance = { getModel: () => model } as unknown as editor.IStandaloneCodeEditor
  const { result, rerender } = renderHook(
    ({ diskContent }: { diskContent: string }) =>
      useMonacoContentSyncBridge({
        editorRef: { current: editorInstance },
        content: 'D0',
        contentRef: { current: 'D0' },
        contentSyncModeRef: { current: 'undoable' },
        modelKey: MODEL_KEY,
        onContentChange: () => undefined,
        diskBaselineRef: {
          current: { fileId: 'tab', diskContent, restoredDiskSignature: undefined }
        },
        diskContent
      }),
    { initialProps: { diskContent: 'D0' } }
  )
  result.current.lastSyncedContentRef.current = 'M'

  rerender({ diskContent: 'M' })

  expect(model.getValue()).toBe('M')
})

it('does not take a reload as the base while a paste kept it out of the model', () => {
  const model = Object.assign(createFakeEditorModel('D + paste'), {
    uri: { toString: () => MODEL_KEY }
  })
  stampEditorModelDiskBaseline('tab', model, getDiskBaselineSignature('D'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge reads only getModel while a paste blocks the push.
  const editorInstance = { getModel: () => model } as unknown as editor.IStandaloneCodeEditor
  const { result, rerender } = renderHook(
    ({ content }: { content: string }) =>
      useMonacoContentSyncBridge({
        editorRef: { current: editorInstance },
        content,
        contentRef: { current: content },
        contentSyncModeRef: { current: 'undoable' },
        modelKey: MODEL_KEY,
        onContentChange: () => undefined,
        diskBaselineRef: {
          current: { fileId: 'tab', diskContent: content, restoredDiskSignature: undefined }
        },
        diskContent: content
      }),
    { initialProps: { content: 'D' } }
  )
  result.current.isApplyingLargePasteRef.current = true

  // A clean reload to E arrives mid paste; the model keeps D + paste.
  rerender({ content: 'E' })

  expect(resolveEditorSaveBaseline('tab', undefined, 'D', undefined).signature).toBe(
    getDiskBaselineSignature('D')
  )
})
