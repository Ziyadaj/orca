import { getWrittenContentDiskSignature } from '../../../../shared/disk-baseline-signature'
import { normalizeToModelEol } from './monaco-content-sync'

/** The parts of a Monaco text model this needs. */
type DiskBaselineModel = {
  getValue(): string
  getEOL(): string
  isDisposed(): boolean
  onWillDispose(listener: () => void): unknown
}

/**
 * The disk version each Monaco model's text is based on. Why the model owns it: every pane, split
 * and tab showing a file shares that one model, so the text a save writes and the disk version it
 * was edited from live in one place and change together. Tabs only point at their model.
 */
const modelBaselines = new WeakMap<DiskBaselineModel, string>()
/** Bumped by every stamp, so a late save can tell whether the model was re-based since it began. */
const modelGenerations = new WeakMap<DiskBaselineModel, number>()

function bumpModelGeneration(model: DiskBaselineModel): void {
  modelGenerations.set(model, (modelGenerations.get(model) ?? 0) + 1)
}
const tabModels = new Map<string, DiskBaselineModel>()
const watchedModels = new WeakSet<DiskBaselineModel>()
/** Tabs whose latest edit came from another surface (rich markdown, notebook, CSV, diff, mobile). */
const otherSurfaceTabs = new Set<string>()
let modelEditReportingFor: string | null = null

function bindTabModel(fileId: string, model: DiskBaselineModel): void {
  tabModels.set(fileId, model)
  if (watchedModels.has(model)) {
    return
  }
  watchedModels.add(model)
  model.onWillDispose(() => {
    for (const [tabId, tabModel] of tabModels) {
      if (tabModel === model) {
        tabModels.delete(tabId)
      }
    }
  })
}

/** Records that `model`, shown for `fileId`, now holds text based on the disk version `signature`. */
export function stampEditorModelDiskBaseline(
  fileId: string,
  model: DiskBaselineModel,
  signature: string
): void {
  bindTabModel(fileId, model)
  modelBaselines.set(model, signature)
  bumpModelGeneration(model)
}

/** After this tab's save or the user adopting disk: the model's text is now based on `signature`. */
export function restampEditorModelDiskBaseline(fileId: string, signature: string): void {
  const model = tabModels.get(fileId)
  if (model && !model.isDisposed()) {
    modelBaselines.set(model, signature)
    bumpModelGeneration(model)
  }
}

/**
 * After a save of text that was not the model's: the model's baseline no longer describes disk,
 * so drop it (unguarded until the next stamp, as before this check existed). Why the generation: a
 * base stamped after the save began (a reload) still describes the model and is kept; a model that
 * holds exactly what was written is re-based to it.
 */
export function settleEditorModelAfterOtherSurfaceSave(
  fileId: string,
  capturedGeneration: number | undefined,
  writtenContent: string,
  writtenSignature: string
): void {
  const model = tabModels.get(fileId)
  if (!model || model.isDisposed()) {
    return
  }
  if (modelGenerations.get(model) === capturedGeneration) {
    modelBaselines.delete(model)
    return
  }
  if (model.getValue() === writtenContent) {
    modelBaselines.set(model, writtenSignature)
    bumpModelGeneration(model)
  }
}

/** Monaco reports its own edits through this, so the tab's draft is known to be the model's text. */
export function reportEditorModelEdit(fileId: string, report: () => void): void {
  modelEditReportingFor = fileId
  try {
    report()
  } finally {
    modelEditReportingFor = null
  }
}

/** Every editor surface's content change for `fileId` passes here, Monaco's included. */
export function noteEditorDraftSource(fileId: string): void {
  if (modelEditReportingFor === fileId) {
    otherSurfaceTabs.delete(fileId)
  } else {
    otherSurfaceTabs.add(fileId)
  }
}

export function noteOtherSurfaceEdit(fileId: string): void {
  otherSurfaceTabs.add(fileId)
}

/** A closed tab's id can come back for a different file session; start it fresh. */
export function forgetEditorTabSaveSource(fileId: string): void {
  otherSurfaceTabs.delete(fileId)
  tabModels.delete(fileId)
}

/**
 * What a save of an edit tab writes and the disk version it must still find, decided by surface:
 * a tab edited through its Monaco model saves the model's text against the model's baseline (or,
 * before any model exists, a restored draft against its persisted base); a tab last edited on
 * another surface saves its draft unguarded, as before.
 */
export function resolveEditorSaveBaseline(
  fileId: string,
  draftOrFallback: string,
  persistedSignature: string | undefined
): {
  content: string
  signature: string | undefined
  fromModel: boolean
  modelGeneration?: number
} {
  if (otherSurfaceTabs.has(fileId)) {
    const model = tabModels.get(fileId)
    return {
      content: draftOrFallback,
      signature: undefined,
      fromModel: false,
      modelGeneration: model ? modelGenerations.get(model) : undefined
    }
  }
  const model = tabModels.get(fileId)
  if (!model || model.isDisposed()) {
    return { content: draftOrFallback, signature: persistedSignature, fromModel: false }
  }
  const signature = modelBaselines.get(model)
  return signature === undefined
    ? {
        content: draftOrFallback,
        signature: undefined,
        fromModel: false,
        modelGeneration: modelGenerations.get(model)
      }
    : { content: model.getValue(), signature, fromModel: true }
}

/** What a Monaco editor knows about the disk text behind its tab, read when text enters the model. */
export type EditorDiskBaselineSource = {
  fileId: string
  /** The text loaded from disk for this tab, when it has been. */
  diskContent: string | undefined
  /** The tab's persisted base, for a restored draft whose model is new. */
  restoredDiskSignature: string | undefined
}

/**
 * Called in the same step that text enters the model, with the model's own text, so a baseline is
 * only ever stamped together with the text the model actually holds.
 */
export function stampAppliedEditorContent(
  model: DiskBaselineModel,
  modelText: string,
  source: EditorDiskBaselineSource,
  phase: 'mount' | 'sync'
): void {
  // Why normalized: the model keeps one line ending, so disk text with others enters it converted;
  // the signature stays the raw disk text's, which is what the writer compares against.
  if (
    source.diskContent !== undefined &&
    modelText === normalizeToModelEol(source.diskContent, model)
  ) {
    // Why written-content: after a save this text came from the editor, not a read, and disk holds its UTF-8 form.
    stampEditorModelDiskBaseline(
      source.fileId,
      model,
      getWrittenContentDiskSignature(source.diskContent)
    )
    return
  }
  bindTabModel(source.fileId, model)
  // Why mount only: a restored draft's new model starts from the persisted base; later syncs of a
  // draft into an already-based model must not move it.
  if (
    phase === 'mount' &&
    source.restoredDiskSignature !== undefined &&
    !modelBaselines.has(model)
  ) {
    modelBaselines.set(model, source.restoredDiskSignature)
    bumpModelGeneration(model)
  }
}

export function __clearEditorModelDiskBaselinesForTests(): void {
  tabModels.clear()
  otherSurfaceTabs.clear()
  modelEditReportingFor = null
}
