// The career record shape, and the pure functions that create, validate and
// judge one.
//
// DELIBERATELY IMPORT-FREE except for the type-only `UpgradeId` (progression.ts
// has no imports of its own). Nothing here touches the SDK, the engine, storage
// or module-scope state, which is what makes it unit-testable — see
// test/careers/record.spec.ts. Anything that does I/O belongs in a sibling
// module, not here.

import { UpgradeId } from '../../shared/progression'

// SCHEMA_VERSION is bumped whenever the stored shape changes. Stored data outlives
// any single deploy, so an old-format record can surface at ANY time — typically
// from a returning player long after the migration was written. migrateRecord()
// therefore stays permanently, and is written to cope with partial/unknown shapes
// rather than assuming the previous version exactly.
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
   * Lifetime per-kind tallies — the raw material for achievement gear ("clean
   * 1000 pieces of pizza"). Keys are normalized letters-only kind names
   * ('pizza', 'wineglass', 'deposit', 'shiftcocktailnight', …); achievements
   * sum whatever keys they care about at read time. Counting ships AHEAD of
   * the achievements because stats can't be backfilled. Sparse by nature —
   * a player only holds keys for kinds they've actually touched.
   *
   * This is also the field that made the single-document shape a problem: it
   * grows per player with the VARIETY they touch, so the blob grew on two axes
   * at once. In keyed mode it lives in the player's own record and never
   * reaches the cross-player index.
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
 * Deliberately conservative: a career is a player's investment, and there is no
 * undo for deleting one. So this only drops records that represent NO earned
 * progress at all — someone who arrived, got a row created by getProgress (which
 * creates on read), and never completed a shift or bought anything. Everyone who
 * has actually played is kept forever, however long ago.
 *
 * That keeps storage proportional to real players rather than to every address
 * that has ever loaded the scene.
 */
export function isWorthKeeping(rec: ProgressRecord): boolean {
  return rec.shifts > 0 || rec.xp > 0 || rec.money > 0 || rec.lifetimeItems > 0
}
