// Planning the one-way trip from the single blob to per-player records.
//
// PURE — no I/O. Given the legacy document's `players` map it returns exactly what
// should be written and what should be dropped, so the decision can be unit-tested
// (test/careers/migration.spec.ts) separately from the writes that carry it out.
// playerProgress owns the execution.
//
// SAFETY PROPERTIES this shape buys:
//
//  * Non-destructive. Nothing here deletes or rewrites the legacy blob. After a
//    migration the old document still holds every career exactly as it did, which
//    is what makes CAREER_STORAGE_MODE reversible while you are still verifying.
//
//  * Idempotent. The caller only migrates when the index came back CONFIRMED
//    empty. Once the index has rows, this never runs again — and re-running it
//    would be harmless anyway, since it derives everything from the blob rather
//    than accumulating.
//
//  * Resumable. Per-player writes are independent, so a partial migration is a
//    valid state: the players who made it are keyed, the index lists exactly
//    them, and the next attempt re-derives the whole plan from the blob. There
//    is no half-written record to repair.

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
 * Builds the migration plan from a legacy blob's `players` map.
 *
 * Applies the SAME keep rule as a normal save (isWorthKeeping), so migrating
 * does not resurrect the empty rows a save would have pruned, and runs every
 * record through migrateRecord so a corrupt entry becomes a valid zeroed record
 * instead of throwing partway through and stranding the migration.
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
