/** What a destination orcad advertises right now, read through the pinned migration preflight. */
import { z } from 'zod'
import { listServerRows, type CatalogRequestOptions } from './orcad-migration-catalog-client'

const StatusCapabilitiesSchema = z.object({ capabilities: z.array(z.string()).optional() })

/** Read per move: a server may be upgraded or downgraded between moves. */
export async function readRemoteOrcadMigrationCapabilities(
  pairingCode: string,
  options: CatalogRequestOptions = {}
): Promise<readonly string[]> {
  const status = await listServerRows(pairingCode, 'status.get', 'status', options)
  return StatusCapabilitiesSchema.parse(status).capabilities ?? []
}
