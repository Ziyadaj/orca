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
/** The text each tab's model last reported or was synced to. */
const modelDrafts = new Map<string, string>()

/** A pane pushed `text` (the tab's draft or loaded content) into the tab's model. */
export function noteEditorModelSynced(fileId: string, text: string): void {
  modelDrafts.set(fileId, text)
}

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
 * After a save of text that was not the model's. A model holding exactly what was written (a
 * pane remounted onto that draft) is re-based to it. Otherwise its base no longer describes disk,
 * so it is dropped, leaving the tab unguarded until the next stamp, as before this check existed;
 * unless a stamp after the save began (a reload) re-based it, which the generation shows.
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
  if (model.getValue() === writtenContent) {
    modelBaselines.set(model, writtenSignature)
    bumpModelGeneration(model)
  } else if (modelGenerations.get(model) === capturedGeneration) {
    modelBaselines.delete(model)
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
export function noteEditorDraftSource(fileId: string, draft: string): void {
  if (modelEditReportingFor === fileId) {
    otherSurfaceTabs.delete(fileId)
    modelDrafts.set(fileId, draft)
  } else {
    otherSurfaceTabs.add(fileId)
  }
}

export function noteOtherSurfaceEdit(fileId: string): void {
  otherSurfaceTabs.add(fileId)
}

/** Undoes a `noteOtherSurfaceEdit` whose edit was rolled back; returns the restore step. */
export function captureEditorTabSaveSource(fileId: string): () => void {
  const wasOtherSurface = otherSurfaceTabs.has(fileId)
  return () => {
    if (wasOtherSurface) {
      otherSurfaceTabs.add(fileId)
    } else {
      otherSurfaceTabs.delete(fileId)
    }
  }
}

/** A closed tab's id can come back for a different file session; start it fresh. */
export function forgetEditorTabSaveSource(fileId: string): void {
  otherSurfaceTabs.delete(fileId)
  tabModels.delete(fileId)
  signedDiskContent.delete(fileId)
  modelDrafts.delete(fileId)
}

/** A tab's live model and its stamp generation, or nothing when it has none. */
function liveTabModel(fileId: string): DiskBaselineModel | undefined {
  const model = tabModels.get(fileId)
  return model && !model.isDisposed() ? model : undefined
}

/**
 * Whether the tab's store draft is the model's text: the model's own last report or the last text
 * synced into it. Why: a draft written around the model (a reload's Undo, a rolled-back mobile save
 * while the tab is hidden) leaves the model holding other text, so the draft and the store's base
 * are the pair that belong together.
 */
function modelHoldsStoreDraft(fileId: string, storeDraft: string | undefined): boolean {
  return storeDraft === undefined || modelDrafts.get(fileId) === storeDraft
}

export type EditorSaveBaseline = {
  content: string
  signature: string | undefined
  fromModel: boolean
  modelGeneration?: number
}

/**
 * What a save of an edit tab writes and the disk version it must still find, decided by surface:
 * a tab edited through its Monaco model saves the model's text against the model's baseline; a
 * draft with no model yet, or written around the model, saves against the store's base; a tab last
 * edited on another surface saves its draft unguarded, as before.
 */
export function resolveEditorSaveBaseline(
  fileId: string,
  storeDraft: string | undefined,
  fallbackContent: string,
  storeSignature: string | undefined
): EditorSaveBaseline {
  const model = liveTabModel(fileId)
  const draft = storeDraft ?? fallbackContent
  const modelGeneration = model ? modelGenerations.get(model) : undefined
  if (otherSurfaceTabs.has(fileId)) {
    return { content: draft, signature: undefined, fromModel: false, modelGeneration }
  }
  if (!model || !modelHoldsStoreDraft(fileId, storeDraft)) {
    return { content: draft, signature: storeSignature, fromModel: false, modelGeneration }
  }
  const signature = modelBaselines.get(model)
  return signature === undefined
    ? { content: draft, signature: undefined, fromModel: false, modelGeneration }
    : { content: model.getValue(), signature, fromModel: true, modelGeneration }
}

/**
 * After a save of the model's own text: its base becomes the written version, unless a stamp
 * since the save began (a reload) re-based the model on newer disk text.
 */
export function settleEditorModelAfterSave(
  fileId: string,
  capturedGeneration: number | undefined,
  writtenSignature: string
): void {
  const model = liveTabModel(fileId)
  if (model && modelGenerations.get(model) === capturedGeneration) {
    modelBaselines.set(model, writtenSignature)
    bumpModelGeneration(model)
  }
}

/**
 * The draft a session persists and the base it carries, read together. Why the model's text and
 * base for a Monaco-edited tab: the store's draft can lag the model (mid paste) and the store's
 * base can differ from the model's (a stale split pane), and a restore must pair the two that match.
 */
export function persistedEditorDraftFields(
  fileId: string,
  storeDraft: string | undefined,
  storeSignature: string | undefined
): { dirtyDraftContent?: string; lastKnownDiskSignature?: string } {
  if (storeDraft === undefined) {
    return {}
  }
  const model = liveTabModel(fileId)
  const fromModel =
    model !== undefined && !otherSurfaceTabs.has(fileId) && modelHoldsStoreDraft(fileId, storeDraft)
  // Why the store's as fallback: a base dropped after another surface's save still lets a restore
  // notice an offline write, as before this check existed.
  const signature = fromModel ? (modelBaselines.get(model) ?? storeSignature) : storeSignature
  return {
    dirtyDraftContent: fromModel ? model.getValue() : storeDraft,
    ...(signature ? { lastKnownDiskSignature: signature } : {})
  }
}

/** What a Monaco editor knows about the disk text behind its tab, read when text enters the model. */
export type EditorDiskBaselineSource = {
  fileId: string
  /** The text loaded from disk for this tab, when it has been. */
  diskContent: string | undefined
  /** The tab's persisted base, for a restored draft whose model is new. */
  restoredDiskSignature: string | undefined
}

/** Last disk text signed per tab; why: remounts and tab switches re-apply the same text. */
const signedDiskContent = new Map<string, { content: string; signature: string }>()

function diskContentSignature(fileId: string, content: string): string {
  const cached = signedDiskContent.get(fileId)
  if (cached?.content === content) {
    return cached.signature
  }
  // Why written-content: after a save this text came from the editor, not a read, and disk holds its UTF-8 form.
  const signature = getWrittenContentDiskSignature(content)
  signedDiskContent.set(fileId, { content, signature })
  return signature
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
    stampEditorModelDiskBaseline(
      source.fileId,
      model,
      diskContentSignature(source.fileId, source.diskContent)
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
  signedDiskContent.clear()
  modelDrafts.clear()
  modelEditReportingFor = null
}
