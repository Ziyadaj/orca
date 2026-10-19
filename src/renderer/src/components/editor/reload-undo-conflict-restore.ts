import type { editor, IDisposable } from 'monaco-editor'
import { useAppStore } from '@/store'

const watchByModel = new WeakMap<editor.ITextModel, IDisposable>()

/**
 * After a banner reload, undoing past it brings back text that disk no longer holds. Restore the
 * changed-on-disk mark (which suspends autosave) and the old baseline then; redo clears them again.
 */
export function watchUndoPastReload(
  model: editor.ITextModel,
  fileId: string,
  previousSignature: string | undefined,
  reloadSignature: string
): void {
  watchByModel.get(model)?.dispose()
  const afterReloadVersions = new Set([model.getAlternativeVersionId()])
  let restored = false
  const restoredSignature = previousSignature ?? reloadSignature

  const subscription = model.onDidChangeContent((event) => {
    const state = useAppStore.getState()
    const liveFile = state.openFiles.find((openFile) => openFile.id === fileId)
    const expectedSignature = restored ? restoredSignature : reloadSignature
    // Why: a save, Keep, a later reload or a new conflict now owns the mark and baseline.
    if (
      !liveFile ||
      liveFile.lastKnownDiskSignature !== expectedSignature ||
      (liveFile.externalMutation === 'changed') !== restored
    ) {
      stop()
      return
    }
    const version = model.getAlternativeVersionId()
    if (!event.isUndoing && !event.isRedoing) {
      if (restored) {
        // Why: typing over the pre-reload text discards the redo path back to the reload.
        stop()
      } else {
        afterReloadVersions.add(version)
      }
      return
    }
    const nowRestored = !afterReloadVersions.has(version)
    if (nowRestored === restored) {
      return
    }
    restored = nowRestored
    state.setExternalMutation(fileId, restored ? 'changed' : null)
    state.setLastKnownDiskSignature(fileId, restored ? restoredSignature : reloadSignature)
  })
  const handle: IDisposable = { dispose: () => subscription.dispose() }
  function stop(): void {
    subscription.dispose()
    if (watchByModel.get(model) === handle) {
      watchByModel.delete(model)
    }
  }
  watchByModel.set(model, handle)
}
