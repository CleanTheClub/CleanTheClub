// The career record shape and the pure functions over it.
//
// IMPORT-FREE except the type-only `UpgradeId` (progression.ts has no imports of
// its own). Nothing here touches the SDK, the engine, storage or module state —
// that is what makes it unit-testable. Anything doing I/O belongs elsewhere.

import { UpgradeId } from '../../shared/progression'

// Bumped whenever the stored shape changes. Stored data outlives any deploy, so
// an old-format record can surface at ANY time — migrateRecord() therefore stays
// permanently and copes with partial/unknown shapes.
export const SCHEMA_VERSION = 1

export type ProgressRecord = {
  v:            number
  money:        number
  xp:           number
  upgrades:     Partial<Record<UpgradeId, number>>
  shifts:       number   // completed shifts, for stats / leaderboard categories
  lifetimeItems: number  // total items cleaned, all time
  displayName:  string
  // ── Retention hooks ─────────────────────────────────────────────────────────
  bestItems:    number   // personal best items cleaned in a single shift
  lastWorkDay:  string   // UTC 'YYYY-MM-DD' of the last PASSED shift
  workStreak:   number   // consecutive days with at least one passed shift
  dailyItems:   number   // items cleaned on dailyDay (drives the daily board)
  dailyDay:     string   // UTC day the dailyItems counter belongs to
  /**
   * Lifetime per-kind tallies — raw material for achievement gear. Keys are
   * normalized letters-only kind names ('pizza', 'wineglass', 'deposit', …);
   * achievements sum whatever they care about at read time. Sparse: a player
   * only holds keys for kinds they've touched.
   *
   * This is why the single document grew on two axes — it scales with the
   * VARIETY a player touches. Keyed mode keeps it out of the shared index.
   */
  kindCounts:   Record<string, number>
  /** Equipped flex carrier ('' = none) — overrides the upgrade gear ladder.
   *  Only ever set through setFlexGear, which re-checks the achievement. */
  flexGear:     string
  /**
   * When this player FIRST reached Club Owner (ms epoch; 0 = never). Stamped by
   * stampOwnerIfTop on every XP-changing path and never cleared — it orders the
   * CLUB OWNERS wall (founding owner first). Owners who topped out before this
   * field existed keep 0, which sorts them ahead: they were owners first.
   */
  ownerSinceMs: number
}

export const emptyRecord = (displayName = ''): ProgressRecord => ({
  v: SCHEMA_VERSION,
  money: 0,
  xp: 0,
  upgrades: {},
  shifts: 0,
  lifetimeItems: 0,
  displayName,
  bestItems: 0,
  lastWorkDay: '',
  workStreak: 0,
  dailyItems: 0,
  dailyDay: '',
  kindCounts: {},
  flexGear: '',
  ownerSinceMs: 0,
})

/** Defensive upgrade of any stored record to the current schema. */
export function migrateRecord(raw: any): ProgressRecord {
  const rec = emptyRecord()
  if (!raw || typeof raw !== 'object') return rec
  // Field-by-field so an unknown or partial shape yields a valid record instead of
  // throwing — a corrupt entry must never take down a player's whole session.
  if (typeof raw.money === 'number')         rec.money         = Math.max(0, Math.floor(raw.money))
  if (typeof raw.xp === 'number')            rec.xp            = Math.max(0, Math.floor(raw.xp))
  if (typeof raw.shifts === 'number')        rec.shifts        = Math.max(0, Math.floor(raw.shifts))
  if (typeof raw.lifetimeItems === 'number') rec.lifetimeItems = Math.max(0, Math.floor(raw.lifetimeItems))
  if (typeof raw.displayName === 'string')   rec.displayName   = raw.displayName
  if (typeof raw.bestItems === 'number')     rec.bestItems     = Math.max(0, Math.floor(raw.bestItems))
  if (typeof raw.lastWorkDay === 'string')   rec.lastWorkDay   = raw.lastWorkDay
  if (typeof raw.workStreak === 'number')    rec.workStreak    = Math.max(0, Math.floor(raw.workStreak))
  if (typeof raw.dailyItems === 'number')    rec.dailyItems    = Math.max(0, Math.floor(raw.dailyItems))
  if (typeof raw.dailyDay === 'string')      rec.dailyDay      = raw.dailyDay
  if (raw.upgrades && typeof raw.upgrades === 'object') {
    for (const [k, v] of Object.entries(raw.upgrades)) {
      if (typeof v === 'number' && v > 0) rec.upgrades[k as UpgradeId] = Math.floor(v)
    }
  }
  if (typeof raw.flexGear === 'string') rec.flexGear = raw.flexGear
  if (typeof raw.ownerSinceMs === 'number') rec.ownerSinceMs = Math.max(0, Math.floor(raw.ownerSinceMs))
  if (raw.kindCounts && typeof raw.kindCounts === 'object') {
    for (const [k, v] of Object.entries(raw.kindCounts)) {
      if (typeof v === 'number' && v > 0) rec.kindCounts[k] = Math.floor(v)
    }
  }
  return rec
}

/**
 * Whether a record is worth persisting.
 *
 * Deliberately conservative — a career is a player's investment and deleting one
 * has no undo. Only drops records with NO earned progress at all: someone who
 * arrived, got a row from getProgress's create-on-read, and never played. Keeps
 * storage proportional to real players, not to every address that ever loaded.
 */
export function isWorthKeeping(rec: ProgressRecord): boolean {
  return rec.shifts > 0 || rec.xp > 0 || rec.money > 0 || rec.lifetimeItems > 0
}
