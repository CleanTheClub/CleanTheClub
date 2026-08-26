// The cross-player board index — the piece that makes per-player career storage
// possible at all.
//
// WHY THIS EXISTS. Two hard facts about the SDK's server storage forced it:
//
//  1. YOU CANNOT ENUMERATE PLAYERS. `Storage.player.getValues(address, …)` takes
//     the address as a required argument and only ever lists ONE address's keys.
//     There is no listPlayers, no cross-player prefix scan, and no `GET /players`
//     route exposed to scenes (the service has one, but it is CLI-only and
//     destructive). Meanwhile four of the five leaderboard categories and the
//     whole CLUB OWNERS wall are GLOBAL top-N queries over every career ever
//     earned, online or not. Without an index they would silently collapse to
//     "whoever happens to be in the club", and the owners wall would empty out
//     whenever no owner is logged in — which is most of the time, since founding
//     owners are exactly the players least likely to be present.
//
//  2. A FAILED READ IS INDISTINGUISHABLE FROM AN ABSENT ONE. `Storage.get`
//     returns null for a 404 AND for 401/403/429/5xx/transport/parse failures;
//     the HTTP status is discarded. So "this player has no career" and "storage
//     is refusing us" look identical at the call site. Under per-player storage
//     that is a career-shredder: read null, assume new player, write a fresh
//     empty record over a real career — one wallet at a time, quietly.
//
// The index answers both. It holds the seven fields the boards actually read, so
// the boards never need the full population in RAM; and because it is the
// authoritative ROSTER, a null per-player read for an address the index knows
// about is provably a FAILURE, not an absence. That is what lets the keyed store
// refuse to write rather than recreate. See keyedStore.hydrate.
//
// CONSEQUENCE: the index must stay COMPLETE. It cannot be pruned to a top-N,
// however tempting — a career outside the top N whose row got dropped would read
// as a brand-new player on next join, which is the exact bug above.
//
// SIZE. A row is seven scalars with short keys, ~70 bytes plus a 44-byte address
// key. That is roughly an order of magnitude smaller per player than a full
// record, and — more importantly — FIXED, where a full record grows with the
// variety of items a player touches (kindCounts) and the upgrades they buy. The
// blob grew on two axes; the index grows on one, slowly. It is still O(players),
// so it is not a permanent answer for an unbounded playerbase; the note in
// DEPLOY.md records what to do next if it ever gets there.
//
// IMPORT-FREE apart from the type-only record module — see record.ts.

import { ProgressRecord, emptyRecord } from './record'

export const INDEX_SCHEMA_VERSION = 1

/**
 * One player's board-visible projection. Keys are abbreviated on purpose: this
 * document is written whole on every save, so every byte is paid repeatedly.
 *
 *   n  displayName    m  money       x  xp            s  shifts
 *   di dailyItems     dd dailyDay    o  ownerSinceMs
 *
 * Exactly the fields read by buildCategories() and ownersEntries() in server.ts.
 * `dd` has to ride along with `di` because TODAY'S TOP filters on the day the
 * count belongs to, and `x` is stored raw rather than as a precomputed rank
 * because both the HIGHEST RANK label and the owner predicate derive from XP.
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
 * Board projection → a ProgressRecord carrying only what the boards read.
 *
 * DANGEROUS IF WRITTEN BACK. Every other field is at its `emptyRecord()` default,
 * so persisting one of these would erase the player's upgrades, kindCounts,
 * flexGear, bestItems and streak. The keyed store therefore tracks which records
 * are HYDRATED (read in full from the player's own key) and refuses to save
 * anything that is not. This function exists solely to populate the boards for
 * players who are not in the club.
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
 * Wipe guard for the index document — the per-player twin of the blob's
 * "never overwrite with an empty player set". An index with no rows would
 * also destroy the roster, and with it the ability to tell a failed read
 * from a new player.
 */
export function indexIsEmpty(doc: CareerIndexDoc | null): boolean {
  return !doc || !doc.rows || Object.keys(doc.rows).length === 0
}
