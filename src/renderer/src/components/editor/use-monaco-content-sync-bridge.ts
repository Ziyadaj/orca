import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import { syncContentUpdate, type MonacoContentSyncMode } from './monaco-content-sync'
import {
  noteEditorModelSynced,
  reportEditorModelEdit,
  stampAppliedEditorContent,
  type EditorDiskBaselineSource
} from './editor-model-disk-baseline'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync,
  shouldIgnoreMonacoContentChange
} from './monaco-programmatic-sync'

export type MonacoContentSyncBridge = {
  contentRef: MutableRefObject<string>
  lastSyncedContentRef: MutableRefObject<string>
  contentSyncModeRef: MutableRefObject<MonacoContentSyncMode>
  isApplyingProgrammaticContentRef: MutableRefObject<boolean>
  isApplyingLargePasteRef: MutableRefObject<boolean>
  diskBaselineRef: MutableRefObject<EditorDiskBaselineSource>
  handleChange: (value: string | undefined) => void
}

/** Why the caller owns `contentRef`/`contentSyncModeRef`: both are latest-value refs
 *  assigned during render, which must happen in the component body so the mount
 *  handler and any handler firing before commit already read the current props. */
export function useMonacoContentSyncBridge(params: {
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>
  content: string
  contentRef: MutableRefObject<string>
  contentSyncModeRef: MutableRefObject<MonacoContentSyncMode>
  modelKey: string
  onContentChange: (content: string) => void
  diskBaselineRef: MutableRefObject<EditorDiskBaselineSource>
  /** Re-runs the stamp when only the disk text changes. */
  diskContent: string | undefined
}): MonacoContentSyncBridge {
  const {
    editorRef,
    content,
    contentRef,
    contentSyncModeRef,
    modelKey,
    onContentChange,
    diskBaselineRef,
    diskContent
  } = params

  const lastSyncedContentRef = useRef<string>(content)

  // Why: reconciliation uses real edit ops (to keep undo sane), so these programmatic edits must suppress onChange or they'd mark the file dirty.
  const isApplyingProgrammaticContentRef = useRef(false)
  const isApplyingLargePasteRef = useRef(false)
  const previousContentRef = useRef<string | null>(null)
  const previousDiskContentRef = useRef<string | undefined | null>(null)

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        if (editorRef.current?.getModel()?.uri.toString() !== modelKey) {
          return
        }
        // Why: split panes share one retained model, so a sibling must ignore the echoed programmatic-sync onChange or it marks the file dirty.
        if (isApplyingLargePasteRef.current) {
          lastSyncedContentRef.current = value
          return
        }
        if (
          shouldIgnoreMonacoContentChange({
            modelKey,
            isApplyingProgrammaticContent: isApplyingProgrammaticContentRef.current
          })
        ) {
          return
        }
        lastSyncedContentRef.current = value
        reportEditorModelEdit(diskBaselineRef.current.fileId, () => onContentChange(value))
      }
    },
    [diskBaselineRef, editorRef, modelKey, onContentChange]
  )

  // Why: sync the model on external `content` drift; useLayoutEffect lands the overwrite before paint so no stale text flashes. On-mount handled in handleMount.
  useLayoutEffect(() => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!ed || !model || model.uri.toString() !== modelKey) {
      return
    }
    // Why content-change only: a diskContent-only rerun must not push a lagging prop over the
    // model, and a chunked paste in flight owns the model until it reports.
    const contentChanged = previousContentRef.current !== content
    previousContentRef.current = content
    const diskChanged = previousDiskContentRef.current !== diskContent
    previousDiskContentRef.current = diskContent
    let pushed = false
    if (
      contentChanged &&
      !isApplyingLargePasteRef.current &&
      lastSyncedContentRef.current !== content
    ) {
      beginProgrammaticContentSync(modelKey)
      isApplyingProgrammaticContentRef.current = true
      try {
        syncContentUpdate(ed, content, contentSyncModeRef.current)
        lastSyncedContentRef.current = content
        pushed = true
      } finally {
        isApplyingProgrammaticContentRef.current = false
        endProgrammaticContentSync(modelKey)
      }
    }
    // Why the model's own text: a reload can land text the model already holds, and a push skipped
    // mid paste must not stamp a base for text the model doesn't hold. Why only on a push or a disk
    // change: echoes of the user's own typing can't make the model match new disk text.
    if (pushed) {
      noteEditorModelSynced(diskBaselineRef.current.fileId, model.getValue())
    }
    if (pushed || diskChanged) {
      stampAppliedEditorContent(model, model.getValue(), diskBaselineRef.current, 'sync')
    }
  }, [content, contentSyncModeRef, diskBaselineRef, diskContent, editorRef, modelKey])

  return {
    contentRef,
    lastSyncedContentRef,
    contentSyncModeRef,
    isApplyingProgrammaticContentRef,
    isApplyingLargePasteRef,
    diskBaselineRef,
    handleChange
  }
}
