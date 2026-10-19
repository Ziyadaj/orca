// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { createFakeEditorModel } from './editor-autosave-controller-test-fixture'
import {
  __clearEditorModelDiskBaselinesForTests,
  noteEditorDraftSource,
  reportEditorModelEdit,
  resolveEditorSaveBaseline,
  stampEditorModelDiskBaseline
} from './editor-model-disk-baseline'
import { installMonacoEditorInputBindings } from './monaco-editor-input-bindings'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./editor-shortcuts', () => ({
  installEditorAddReviewNoteShortcut: () => () => undefined,
  installEditorSaveShortcut: () => () => undefined,
  installMonacoEditorFindShortcut: () => () => undefined
}))
// A chunked paste that finishes at once.
vi.mock('./monaco-large-text-paste', () => ({
  handleMonacoLargeTextPaste: (
    _editor: unknown,
    _event: unknown,
    handlers: { onPasteStart: () => void; onPasteResult: (result: { status: string }) => void }
  ) => {
    handlers.onPasteStart()
    handlers.onPasteResult({ status: 'pasted' })
  }
}))

afterEach(() => {
  __clearEditorModelDiskBaselinesForTests()
})

it("reports a finished chunked paste as the model's own edit, so the next save stays guarded", () => {
  const model = createFakeEditorModel('base + pasted')
  stampEditorModelDiskBaseline('tab', model, getDiskBaselineSignature('base'))
  const container = document.createElement('div')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bindings call only these editor methods once shortcuts are mocked.
  const editorInstance = {
    getContainerDomNode: () => container,
    getValue: () => model.getValue(),
    addAction: () => ({ dispose: () => undefined })
  } as unknown as editor.IStandaloneCodeEditor
  installMonacoEditorInputBindings({
    editorInstance,
    worktreeId: undefined,
    editorContainerRef: { current: container },
    propsRef: {
      current: {
        relativePath: 'file.ts',
        language: 'typescript',
        onSave: vi.fn(),
        // The panel's content handler: records the draft and where it came from.
        onContentChange: (value: string) => noteEditorDraftSource('tab', value)
      }
    },
    readOnlyRef: { current: false },
    lastSyncedContentRef: { current: '' },
    isApplyingLargePasteRef: { current: false },
    reportModelEdit: (report) => reportEditorModelEdit('tab', report),
    commentPopoverRef: { current: null },
    shouldShowMarkdownAnnotationsRef: { current: false },
    setCommentPopover: vi.fn(),
    setSelectionAnnotationTarget: vi.fn()
  })

  container.dispatchEvent(new Event('paste'))

  expect(resolveEditorSaveBaseline('tab', 'base + pasted', '', undefined)).toMatchObject({
    fromModel: true,
    signature: getDiskBaselineSignature('base')
  })
})
