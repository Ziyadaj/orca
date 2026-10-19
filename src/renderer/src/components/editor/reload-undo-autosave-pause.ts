import type { editor, IDisposable } from 'monaco-editor'

const pausedFileIds = new Set<string>()
const watchByModel = new WeakMap<editor.ITextModel, IDisposable>()

/** Undone-reload text is the user's choice, but only an explicit save may write it. */
export function isAutosavePausedAfterReloadUndo(fileId: string): boolean {
  return pausedFileIds.has(fileId)
}

export function resumeAutosaveAfterReloadUndo(fileId: string): void {
  pausedFileIds.delete(fileId)
}

/**
 * Pause autosave whenever undo/redo moves the model to before a banner reload, and resume when it
 * moves back after it. The boundary lasts until the next reload or the model goes away.
 */
export function watchReloadUndoBoundary(model: editor.ITextModel, fileId: string): void {
  watchByModel.get(model)?.dispose()
  resumeAutosaveAfterReloadUndo(fileId)
  const afterReloadVersions = new Set([model.getAlternativeVersionId()])
  let beforeReload = false
  const subscription = model.onDidChangeContent((event) => {
    const version = model.getAlternativeVersionId()
    if (!event.isUndoing && !event.isRedoing) {
      if (!beforeReload) {
        afterReloadVersions.add(version)
      }
      return
    }
    const nowBeforeReload = !afterReloadVersions.has(version)
    if (nowBeforeReload === beforeReload) {
      return
    }
    beforeReload = nowBeforeReload
    if (beforeReload) {
      pausedFileIds.add(fileId)
    } else {
      resumeAutosaveAfterReloadUndo(fileId)
    }
  })
  const willDispose = model.onWillDispose(stop)
  function stop(): void {
    subscription.dispose()
    willDispose.dispose()
    resumeAutosaveAfterReloadUndo(fileId)
    if (watchByModel.get(model)?.dispose === stop) {
      watchByModel.delete(model)
    }
  }
  watchByModel.set(model, { dispose: stop })
}
