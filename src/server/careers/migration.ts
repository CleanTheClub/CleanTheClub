// Planning the one-way trip from the single blob to per-player records.
//
// PURE — no I/O, so the decision is testable apart from the writes that carry it
// out. playerProgress owns the execution.
//
// Safety properties this shape buys:
//   non-destructive  nothing here deletes or rewrites the blob, which is what
//                    keeps CAREER_STORAGE_MODE reversible while you verify.
//   idempotent       the caller only migrates on a CONFIRMED-empty index, and
//                    this derives from the blob rather than accumulating.
//   resumable        per-player writes are independent, so a partial migration
//                    is a valid state and the next attempt re-derives the plan.

import { ProgressRecord, migrateRecord, isWorthKeeping } from './record'
import {
  BoardRow, CareerIndexDoc, INDEX_SCHEMA_VERSION, projectBoardRow,
} from './boardIndex'

export type MigrationPlan = {
  /** One entry per player to write to their own key. */
  writes: Array<{ address: string; record: ProgressRecord }>
  /** The index to write AFTER the records land. */
  index: CareerIndexDoc
  /** Records dropped by the keep/prune rule — no earned progress at all. */
  pruned: number
}

/**
 * Builds the plan from a legacy blob's `players` map. Applies the same keep rule
 * as a normal save, so migrating doesn't resurrect rows a save would prune, and
 * runs everything through migrateRecord so one corrupt entry can't strand the
 * migration partway.
 */
export function planMigration(players: unknown): MigrationPlan {
  const plan: MigrationPlan = {
    writes: [],
    index: { v: INDEX_SCHEMA_VERSION, rows: {} },
    pruned: 0,
  }
  if (!players || typeof players !== 'object') return plan

  const rows: Record<string, BoardRow> = {}
  for (const [rawAddress, raw] of Object.entries(players as Record<string, unknown>)) {
    const address = rawAddress.toLowerCase()
    const record = migrateRecord(raw)
    if (!isWorthKeeping(record)) { plan.pruned++; continue }
    plan.writes.push({ address, record })
    rows[address] = projectBoardRow(record)
  }
  plan.index.rows = rows
  return plan
}
