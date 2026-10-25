import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const SessionAskParams = z.object({
  to: requiredString('Missing --to'),
  question: requiredString('Missing --question'),
  timeoutMs: OptionalFiniteNumber,
  /** Bound by the host from the caller's session; the CLI never sends it. */
  from: OptionalString
})
