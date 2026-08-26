// The cross-player board index — what makes per-player career storage possible.
//
// Two SDK facts force it:
//
//  1. YOU CANNOT ENUMERATE PLAYERS. `Storage.player.getValues(address)` only ever
//     lists ONE address's keys, and no `GET /players` is exposed to scenes. But
//     four of five leaderboard categories and the CLUB OWNERS wall are GLOBAL
//     top-N queries over every career ever earned. Without an index they collapse
//     to "whoever is in the club", and the owners wall empties whenever no owner
//     is online — most of the time, since founding owners are the least likely to
//     be present.
//
//  2. A FAILED READ LOOKS LIKE AN ABSENT ONE. `Storage.get` returns null for a
//     404 AND for 401/403/429/5xx/transport/parse failures; the status is
//     discarded. Under per-player storage that shreds careers: read null, assume
//     a new player, write an empty record over a real one — one wallet at a time.
//
// The index answers both. It holds the seven fields the boards read, and because
// it is the authoritative ROSTER, a null read for an address it lists is provably
// a FAILURE — which is what lets keyedStore refuse to write instead of recreating.
//
// So it must stay COMPLETE. Pruning to a top-N would make every career below the
// cut read as brand new, i.e. hazard 2 again.
//
// SIZE: a row is seven scalars with short keys, ~70 bytes plus a 44-byte address.
// An order of magnitude smaller than a full record, and FIXED per player where a
// record grows with kindCounts and upgrades. Still O(players) — see DEPLOY.md for
// what to do if that ever becomes the problem.

import { ProgressRecord, emptyRecord } from './record'

export const INDEX_SCHEMA_VERSION = 1

/**
 * One player's board projection. Keys are abbreviated because this document is
 * rewritten whole on every save:
 *   n displayName  m money  x xp  s shifts  di dailyItems  dd dailyDay  o ownerSinceMs
 *
 * Exactly what buildCategories() and ownersEntries() read. `dd` rides along
 * because TODAY'S TOP filters on the day; `x` is raw XP because both the rank
 * label and the owner predicate derive from it.
 */
export type BoardRow = {
  n:  string
  m:  number
  x:  number
  s:  number
  di: number
  dd: string
  o:  number
}

export type CareerIndexDoc = {
  v:    number
  rows: Record<string, BoardRow>
}

export const emptyIndex = (): CareerIndexDoc => ({ v: INDEX_SCHEMA_VERSION, rows: {} })

/** Full record → its board projection. */
export function projectBoardRow(rec: ProgressRecord): BoardRow {
  return {
    n:  rec.displayName,
    m:  rec.money,
    x:  rec.xp,
    s:  rec.shifts,
    di: rec.dailyItems,
    dd: rec.dailyDay,
    o:  rec.ownerSinceMs,
  }
}

/**
 * Board projection → a ProgressRecord holding only what the boards read.
 *
 * DANGEROUS IF WRITTEN BACK: every other field sits at its default, so
 * persisting one would erase upgrades, kindCounts, flexGear, bestItems and
 * streak. The keyed store only saves HYDRATED records for exactly this reason.
 * Used solely to put absent players on the boards.
 */
export function boardRowToRecord(row: BoardRow): ProgressRecord {
  const rec = emptyRecord(row.n)
  rec.money        = row.m
  rec.xp           = row.x
  rec.shifts       = row.s
  rec.dailyItems   = row.di
  rec.dailyDay     = row.dd
  rec.ownerSinceMs = row.o
  return rec
}

/** Defensive coercion of one stored row; null when the shape is unusable. */
export function migrateBoardRow(raw: any): BoardRow | null {
  if (!raw || typeof raw !== 'object') return null
  const num = (v: any) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.floor(v)) : 0)
  const str = (v: any) => (typeof v === 'string' ? v : '')
  return {
    n:  str(raw.n),
    m:  num(raw.m),
    x:  num(raw.x),
    s:  num(raw.s),
    di: num(raw.di),
    dd: str(raw.dd),
    o:  num(raw.o),
  }
}

/** Defensive coercion of a whole stored index. */
export function migrateIndex(raw: any): CareerIndexDoc {
  const doc = emptyIndex()
  if (!raw || typeof raw !== 'object' || !raw.rows || typeof raw.rows !== 'object') return doc
  for (const [address, rawRow] of Object.entries(raw.rows)) {
    const row = migrateBoardRow(rawRow)
    if (row) doc.rows[address.toLowerCase()] = row
  }
  return doc
}

/**
 * Wipe guard, the per-player twin of the blob's "never write an empty player
 * set". An empty index destroys the roster, and with it the ability to tell a
 * failed read from a new player.
 */
export function indexIsEmpty(doc: CareerIndexDoc | null): boolean {
  return !doc || !doc.rows || Object.keys(doc.rows).length === 0
}
