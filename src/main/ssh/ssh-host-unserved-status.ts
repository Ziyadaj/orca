/** What a connect publishes when the managed server doesn't serve the host; there is no fallback. */
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import type { SshManagedServerStatus } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from './ssh-host-server-on-connect'

type UnservedDecision = Extract<HostServerOnConnectResult, { route: 'unserved' }>

// Why `kind: 'relay'`: the published status keeps its shipped shape; it now means "not served".
export function unservedServerStatus(
  decision: UnservedDecision
): Extract<SshManagedServerStatus, { kind: 'relay' }> {
  return {
    kind: 'relay',
    reason: decision.reason,
    ...(decision.detail ? { detail: decision.detail } : {}),
    ...(decision.terminals !== undefined ? { terminals: decision.terminals } : {}),
    ...(decision.terminalsElsewhere ? { terminalsElsewhere: true } : {}),
    ...(decision.canLeaveBehind ? { canLeaveBehind: true } : {}),
    ...(decision.held ? { held: true } : {}),
    ...(decision.bridged ? { bridged: true } : {})
  }
}

const HELD_MOVE_MESSAGE =
  'Orca paused moving this host’s projects to its managed server because it couldn’t confirm the server’s copy. Nothing is lost: the host keeps its projects and stays locked until the move finishes. Connect again to resume. If the server can’t come back, stop or forget it in Settings > Managed servers.'

// Dev builds ship no server template; say how to get one instead of blaming the host.
const DEV_TEMPLATE_MISSING_MESSAGE =
  'This development build has no managed server template, which SSH hosts need. Run `pnpm build:orcad-template`, or set ORCA_ORCAD_TEMPLATE_PATH to an orcad-template folder (a packaged Orca app has one in its Resources).'

function isUnpackagedBuild(): boolean {
  return hasAppEnvironment() && !getAppEnvironment().isPackaged()
}

/** Untranslated twin of the renderer's status line, for logs and callers without the catalog. */
export function unservedHostServerMessage(decision: UnservedDecision): string {
  if (decision.held && (decision.reason === 'failed' || decision.reason === 'deferred')) {
    return HELD_MOVE_MESSAGE
  }
  switch (decision.reason) {
    case 'orcad_unavailable':
      return decision.detail === 'artifacts_unavailable' && isUnpackagedBuild()
        ? DEV_TEMPLATE_MISSING_MESSAGE
        : 'This SSH host isn’t supported by this version of Orca. To keep using it, install an older version of Orca.'
    case 'relay_terminals_live':
    case 'relay_terminals_unverifiable':
      return 'Terminals started by an older version of Orca are still running on this host, and they don’t stop on their own. Close them in that version of Orca or end them on the host, then reconnect.'
    case 'refused':
      return decision.detail ?? 'Orca couldn’t set up its server on this host.'
    case 'source_changed':
      return 'An older version of Orca changed this host’s projects. Move those changes to its managed server in SSH Hosts settings to continue.'
    case 'deferred':
    case 'failed':
      return 'Orca couldn’t start its server on this host. Try connecting again.'
  }
}
