import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reserveDeadManWindowMs } from './cell-reserve-dead-man.js'
import { openRelayDatabase } from './database.js'
import { startReserveModeCell } from './test-fixtures/reserve-mode-cell.js'

// Step 6: a reserve-mode cell with phonePath=memory resumes paired phones without the database.

describe('the memory phone path', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  async function cell(now?: () => number) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-phone-path-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const database = await openRelayDatabase({ dataDir })
    cleanup.push(() => database.close())
    return await startReserveModeCell({ database, dataDir, cleanup, ...(now ? { now } : {}) })
  }

  it('acts only while the cell is in reserve mode, so admitMode=db or a dead-man trip turns it off', async () => {
    let now = Date.now()
    const reserve = await cell(() => now)
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('memory')
    reserve.setAdmitMode('db', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
    reserve.setAdmitMode('reserve', { phonePath: 'memory' })
    expect(reserve.relay.sessions.phonePathEffective()).toBe('memory')
    now += reserveDeadManWindowMs(reserve.config.cellId) + 1_000
    expect(reserve.relay.sessions.inReserveMode()).toBe(false)
    expect(reserve.relay.sessions.phonePathEffective()).toBe('db')
  })
})
