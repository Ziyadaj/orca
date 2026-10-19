import type { OpenFile } from '@/store/slices/editor'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'

/** The owner key of a local workspace's edit-tab model. */
export function localEditorModelOwnerKey(worktreeId: string): string {
  return JSON.stringify([null, 'local', worktreeId])
}

export function getEditorModelOwnerKey(file: OpenFile, state: WorktreeOperationRouteState): string {
  const captured = file.operationProvenance?.generation.route
  const route =
    captured ??
    resolveWorktreeOperationRoute(
      state.activeWorktreeId === file.worktreeId ? { ...state, activeWorktreeId: null } : state,
      file.worktreeId
    )
  const environmentId = captured
    ? captured.runtimeEnvironmentId
    : file.runtimeEnvironmentId !== undefined
      ? file.runtimeEnvironmentId?.trim() || null
      : (route?.runtimeEnvironmentId ?? null)
  const hostId = captured
    ? captured.executionHostId
    : file.externalSshTargetId
      ? toSshExecutionHostId(file.externalSshTargetId)
      : route &&
          (file.runtimeEnvironmentId === undefined ||
            (file.runtimeEnvironmentId || null) === route.runtimeEnvironmentId)
        ? route.executionHostId
        : environmentId
          ? toRuntimeExecutionHostId(environmentId)
          : null
  // Why the workspace: each workspace's tab owns its own draft and unsaved state, so its model (text,
  // undo, and the disk version a save is checked against) must be its own; split panes of one tab
  // still share it. Unresolved owners must not borrow another host's retained text.
  return JSON.stringify(
    hostId
      ? [environmentId, hostId, file.worktreeId]
      : [environmentId, 'unresolved', file.worktreeId, file.id]
  )
}
