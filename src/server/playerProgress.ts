// Per-player career progression — money, XP, job title and upgrade levels.
//
// SERVER AUTHORITY. Every value here is computed server-side from the server's own
// count of what was cleaned. Clients never report earnings; they send "I cleaned
// item X" and receive the resulting totals. Money buys real advantage and feeds
// leaderboards, so treating client numbers as input would be directly exploitable.
//
// STORAGE SHAPE: one document holding every player, rather than a key per wallet.
// Matches the leaderboard's proven pattern and, more importantly, keeps writes to a
// single request per save — the Storage API is rate-limited (~40 concurrent) and the
// docs are explicit that writes belong at checkpoints, not per-frame. We write once
// per shift end, never per clean.
//
// GUESTS: Decentraland guest accounts get a throwaway address per session, so
// persisting against it would silently lose everything on leave and pollute the
// stored document with dead entries. Guests play and earn normally in memory, are
// never written to storage, and the client shows a sign-in nudge.

import { engine, PlayerIdentityData } from '@dcl/sdk/ecs'
import { createPersistedDoc } from './persistence'
import { ADMIN_ADDRESSES } from '../shared/config'
import {
  UpgradeId, canPurchase, rankForXp, titleForXp, PurchaseRefusal,
  ACHIEVEMENTS, achievementStates, TITLE_XP,
} from '../shared/progression'

// ── Record shape ──────────────────────────────────────────────────────────────
// SCHEMA_VERSION is bumped whenever the stored shape changes. Stored data outlives
// any single deploy, so an old-format record can surface at ANY time — typically
// from a returning player long after the migration was written. migrate() therefore
// stays permanently, and is written to cope with partial//unknown shapes rather than
// assuming the previous version exactly.
const SCHEMA_VERSION = 1

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

type ProgressDoc = {
  v:       number
  players: Record<string, ProgressRecord>
}

const emptyRecord = (displayName = ''): ProgressRecord => ({
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

/**
 * First crossing into the top rank stamps the coronation date (once, ever).
 * Called on every XP-raising path — shift awards and admin grants alike — so
 * the CLUB OWNERS wall order can't depend on which path promoted the player.
 */
function stampOwnerIfTop(rec: ProgressRecord): void {
  if (rec.ownerSinceMs === 0 && rankForXp(rec.xp) >= TITLE_XP.length - 1) {
    rec.ownerSinceMs = Date.now()
    dirty = true
  }
}

/** UTC day stamp — the boundary all daily mechanics share. */
export const todayStr = (): string => new Date().toISOString().slice(0, 10)
const yesterdayStr = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

/** Defensive upgrade of any stored record to the current schema. */
function migrate(raw: any): ProgressRecord {
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
 * Bumps a lifetime kind counter (see ProgressRecord.kindCounts). Guests count
 * too — their record is session-only like everything else of theirs.
 */
export function bumpKindCount(address: string, kind: string, n = 1): void {
  if (!kind) return
  const rec = records.get(address.toLowerCase())
  if (!rec) return
  rec.kindCounts[kind] = (rec.kindCounts[kind] ?? 0) + n
  dirty = true
}

/**
 * Admin test tool: SET one achievement's progress to a stage — a set, not an
 * add, so every test starts from a known state. Wipes all keys that feed the
 * achievement, then writes the stage value to the primary key. Dropping below
 * target also un-equips the gear if worn, so the in-hand model can never show
 * gear the record no longer justifies (and 'zero' → 'full' → click-to-equip
 * exercises the whole pedestal flow end to end).
 */
export type AchievementStage = 'zero' | 'half' | 'almost' | 'full'

export function adminSetAchievement(
  address: string, gear: string, stage: AchievementStage,
): { ok: boolean; current: number; target: number } {
  const def = ACHIEVEMENTS.find((a) => a.gear === gear)
  const rec = records.get(address.toLowerCase())
  if (!def || !rec) return { ok: false, current: 0, target: 0 }
  for (const k of def.keys) delete rec.kindCounts[k]
  const value = stage === 'zero' ? 0
    : stage === 'half'   ? Math.floor(def.target / 2)
    : stage === 'almost' ? def.target - 1
    : def.target
  if (value > 0) rec.kindCounts[def.keys[0]] = value
  if (value < def.target && rec.flexGear === gear) rec.flexGear = ''
  dirty = true
  return { ok: true, current: value, target: def.target }
}

// ── In-memory state ───────────────────────────────────────────────────────────
const records = new Map<string, ProgressRecord>()   // address → record (guests included)
const guests  = new Set<string>()                   // addresses excluded from persistence
// Addresses whose record came from the STORE — proof of a persistent identity,
// which overrides an engine isGuest misreport (see registerProgressPlayer).
const loadedFromStore = new Set<string>()
let   dirty   = false

const doc = createPersistedDoc<ProgressDoc>(
  'playerProgress',
  'PROGRESS',
  // Wipe guard: never overwrite stored progression with an empty player set.
  (d) => !d || !d.players || Object.keys(d.players).length === 0,
)

let loadStarted = false
// The doc load is promise-guarded, but every caller of ensureProgressLoaded chains
// its own .then — without this guard each caller re-ran the merge (harmless thanks
// to the records.has check, but it double-logged and double-walked the document).
let mergeDone = false
/** Career-doc persistence health — surfaced on the in-world admin panel. */
export function progressStorageStatus() {
  return doc.status()
}

// Fired after the load merge RESTORES careers over pre-load stub records, so
// server.ts can push the corrected state to those players immediately.
let onCareersRestored: ((addresses: string[]) => void) | undefined
export function setCareersRestoredHandler(fn: (addresses: string[]) => void): void {
  onCareersRestored = fn
}

export function ensureProgressLoaded(): Promise<unknown> {
  loadStarted = true
  return doc.ensureLoaded().then((stored) => {
    if (mergeDone) return
    mergeDone = true
    if (!stored || !stored.players) return
    let n = 0
    const restored: string[] = []
    for (const [address, raw] of Object.entries(stored.players)) {
      const key    = address.toLowerCase()
      const loaded = migrate(raw)
      const existing = records.get(key)
      if (existing) {
        // BOOT RACE — the bug that erased the owner's career on every
        // republish: a player who joins before the read settles (after a
        // republish, that is almost always the OWNER testing) gets a fresh
        // stub record; the old skip-if-present merge then ignored their real
        // career, and the next shift-end save wrote the stub over it in the
        // store. The stub only ever holds THIS session's pre-load earnings
        // (records are only created via emptyRecord), so the fix is to ADD
        // those few minutes on top of the restored career — nobody loses
        // either side of the race.
        loaded.money         += existing.money
        loaded.xp            += existing.xp
        loaded.shifts        += existing.shifts
        loaded.lifetimeItems += existing.lifetimeItems
        loaded.bestItems      = Math.max(loaded.bestItems, existing.bestItems)
        for (const [id, lvl] of Object.entries(existing.upgrades)) {
          const u = id as UpgradeId
          loaded.upgrades[u] = Math.max(loaded.upgrades[u] ?? 0, lvl ?? 0)
        }
        if (existing.displayName) loaded.displayName = existing.displayName
        // Pre-load kind tallies are additive, same as the headline numbers —
        // dropping them undercounted the achievement counters by whatever the
        // player touched before the read settled.
        for (const [k, cnt] of Object.entries(existing.kindCounts)) {
          loaded.kindCounts[k] = (loaded.kindCounts[k] ?? 0) + cnt
        }
        // Daily fields: SAME day sums (both sides earned today), a strictly
        // newer session day replaces. The old >=-replace dropped the stored
        // day's count whenever the race happened on the same UTC day —
        // which is when it always happens.
        if (existing.dailyDay === loaded.dailyDay && existing.dailyDay !== '') {
          loaded.dailyItems += existing.dailyItems
        } else if (existing.dailyDay > loaded.dailyDay) {
          loaded.dailyItems = existing.dailyItems
          loaded.dailyDay   = existing.dailyDay
        }
        if (existing.lastWorkDay >= loaded.lastWorkDay && existing.lastWorkDay !== '') {
          loaded.lastWorkDay = existing.lastWorkDay
          loaded.workStreak  = Math.max(loaded.workStreak, existing.workStreak)
        }
        restored.push(key)
        console.log(`[PROGRESS] restored stored career for ${key} over a pre-load session stub`)
      }
      records.set(key, loaded)
      loadedFromStore.add(key)
      // A stored career proves this identity persists — clear any guest
      // misflag applied by a register that ran before the load settled.
      if (guests.has(key)) {
        guests.delete(key)
        console.log(`[PROGRESS] ${key} was flagged guest but has a stored career — flag cleared`)
      }
      n++
    }
    console.log(`[PROGRESS] loaded ${n} player records${restored.length ? ` (${restored.length} restored over boot-race stubs)` : ''}`)
    if (restored.length > 0) {
      dirty = true   // the merged truth should reach the store at the next checkpoint
      onCareersRestored?.(restored)
    }
  }).catch((e) => {
    // Saves stay blocked (loadConfirmed false), so nothing is overwritten.
    console.log('[PROGRESS] load failed — progression will not persist this session:', e)
  })
}

/**
 * Whether this address belongs to a guest account.
 *
 * FIELD-VERIFIED LIMITATION: PlayerIdentityData does NOT reliably replicate to
 * the SERVER runtime (see the heartbeat-presence note in server.ts), so on the
 * server this scan is usually empty and returns false — in practice guests DO
 * get persisted. That is the accepted trade-off: a guest wrongly persisted
 * costs one dead record (isWorthKeeping prunes never-played rows), while a
 * real player wrongly skipped loses their career (this happened — the deployed
 * explorer once misflagged the signed-in OWNER as a guest). The override
 * branches below only matter if/when the platform starts replicating identity
 * server-side; they are kept as cheap insurance for that day.
 */
export function detectGuest(address: string): boolean {
  const target = address.toLowerCase()
  for (const [, data] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (data.address.toLowerCase() === target) return data.isGuest
  }
  // Unknown identity (component not replicated yet) — assume NOT a guest so a real
  // player is never denied persistence. A guest wrongly persisted costs one dead
  // record; a real player wrongly skipped loses their career.
  return false
}

export function registerProgressPlayer(address: string, displayName: string): ProgressRecord {
  const key = address.toLowerCase()
  let rec = records.get(key)
  if (!rec) {
    rec = emptyRecord(displayName)
    records.set(key, rec)
  }
  if (displayName) rec.displayName = displayName

  if (detectGuest(key)) {
    // The engine's isGuest is not fully trustworthy (the deployed explorer
    // flagged the signed-in OWNER as a guest — playtest 2026-08-07). Two facts
    // override it: an ADMIN address is definitionally a real wallet, and an
    // address with a STORED career already proved it persists. Genuine
    // one-time guests match neither and stay session-only.
    if (ADMIN_ADDRESSES.includes(key)) {
      guests.delete(key)
      console.log(`[PROGRESS] ${displayName || key} reported as guest but is an ADMIN — persisting anyway`)
    } else if (loadedFromStore.has(key)) {
      guests.delete(key)
      console.log(`[PROGRESS] ${displayName || key} reported as guest but has a stored career — persisting anyway`)
    } else {
      guests.add(key)
      console.log(`[PROGRESS] ${displayName || key} is a guest — progress is session-only`)
    }
  } else {
    guests.delete(key)
  }
  return rec
}

export const isGuestAddress = (address: string): boolean => guests.has(address.toLowerCase())

/**
 * Equip ('Disco_Ball' …) or clear ('') a flex carrier. Validation is entirely
 * server-side against this record's own tallies — the pedestal click is
 * presentation, and a crafted message can't equip an unearned showpiece.
 */
export function setFlexGear(address: string, gear: string): boolean {
  const rec = records.get(address.toLowerCase())
  if (!rec) return false
  if (gear === '') {
    if (rec.flexGear === '') return true
    rec.flexGear = ''
    dirty = true
    return true
  }
  const def = ACHIEVEMENTS.find((a) => a.gear === gear)
  if (!def) return false
  const state = achievementStates(rec.kindCounts).find((s) => s.gear === gear)
  if (!state?.unlocked) return false
  rec.flexGear = gear
  dirty = true
  return true
}

/**
 * Every known record, for building leaderboard categories.
 *
 * Guests are included: they earn normally for the session, and excluding them from
 * a live board would make the club look emptier than it is. They simply don't
 * persist, so they drop off when they leave.
 */
export function allProgressRecords(): Array<ProgressRecord & { address: string }> {
  // Address joined in from the map key — the leaderboard categories need it so
  // clients can fetch profile portraits for the rows.
  return [...records.entries()].map(([address, rec]) => ({ ...rec, address }))
}

export function getProgress(address: string): ProgressRecord {
  const key = address.toLowerCase()
  let rec = records.get(key)
  if (!rec) { rec = emptyRecord(); records.set(key, rec) }
  return rec
}

/**
 * Read-only lookup that does NOT create a record. Presence/heartbeat paths use
 * this: getProgress's create-on-read materialised a stub for every session id
 * that ever entered — which is exactly the record the boot-race merge then has
 * to repair, and a dead row in `records` for every passer-by.
 */
export function peekProgress(address: string): ProgressRecord | undefined {
  return records.get(address.toLowerCase())
}

// Streak bonus: +10 XP per consecutive work day, capped so a long streak is a
// treat rather than the dominant income source.
const STREAK_XP_PER_DAY = 10
const STREAK_XP_CAP_DAYS = 5

/**
 * Applies a completed shift's rewards plus the daily retention hooks:
 *  • opening bonus  — the first PASSED shift each UTC day doubles the shift XP;
 *  • work streak    — consecutive days with a passed shift add bonus XP;
 *  • daily counter  — items cleaned today, for the daily leaderboard;
 *  • personal best  — most items in a single shift.
 * Returns everything the payout screen needs to celebrate each piece.
 */
export function awardShift(
  address: string,
  money: number,
  xp: number,
  itemsCleaned: number,
  passed: boolean,
): {
  record: ProgressRecord
  promotedTo: string | null
  openingBonus: boolean
  streakDays: number
  streakXp: number
  xpApplied: number
  newBest: boolean
} {
  const rec = getProgress(address)
  const rankBefore = rankForXp(rec.xp)
  const today = todayStr()

  let xpApplied    = Math.max(0, Math.round(xp))
  let openingBonus = false
  let streakXp     = 0

  if (passed) {
    if (rec.lastWorkDay !== today) {
      openingBonus = true
      xpApplied *= 2
      rec.workStreak = rec.lastWorkDay === yesterdayStr() ? rec.workStreak + 1 : 1
    }
    if (rec.workStreak > 1) {
      streakXp = STREAK_XP_PER_DAY * Math.min(rec.workStreak - 1, STREAK_XP_CAP_DAYS)
      xpApplied += streakXp
    }
    rec.lastWorkDay = today
    // High-water mark for the Disco Ball achievement: streaks BREAK, and an
    // achievement must never re-lock, so unlocks read this, not workStreak.
    rec.kindCounts['streakbest'] = Math.max(rec.kindCounts['streakbest'] ?? 0, rec.workStreak)
  }

  // Daily counter — reset on the day boundary, then accumulate (pass or fail:
  // the daily board rewards graft, not just wins).
  if (rec.dailyDay !== today) { rec.dailyDay = today; rec.dailyItems = 0 }
  rec.dailyItems += Math.max(0, itemsCleaned)

  const newBest = itemsCleaned > rec.bestItems
  if (newBest) rec.bestItems = itemsCleaned

  rec.money += Math.max(0, Math.round(money))
  rec.xp    += xpApplied
  rec.shifts += 1
  rec.lifetimeItems += Math.max(0, itemsCleaned)
  stampOwnerIfTop(rec)

  const rankAfter = rankForXp(rec.xp)
  dirty = true

  return {
    record: rec,
    // Surfaced so the end-of-shift screen can celebrate a promotion explicitly,
    // which is the GDD's core "closer to my next promotion" payoff moment.
    promotedTo: rankAfter > rankBefore ? titleForXp(rec.xp) : null,
    openingBonus,
    streakDays: rec.workStreak,
    streakXp,
    xpApplied,
    newBest,
  }
}

/**
 * Admin testing tool: adjust money / XP directly. Same promotion detection as
 * awardShift so a granted rank still gets its celebration.
 */
export function adminAdjust(
  address: string,
  money: number,
  xp: number,
): { record: ProgressRecord; promotedTo: string | null } {
  const rec = getProgress(address)
  const rankBefore = rankForXp(rec.xp)
  rec.money = Math.max(0, rec.money + Math.round(money))
  rec.xp    = Math.max(0, rec.xp + Math.round(xp))
  dirty = true
  stampOwnerIfTop(rec)
  const rankAfter = rankForXp(rec.xp)
  return { record: rec, promotedTo: rankAfter > rankBefore ? titleForXp(rec.xp) : null }
}

/**
 * Attempts an upgrade purchase. All validation is server-side: the client's shop is
 * presentation only, and a crafted purchase message must not be able to grant a
 * level the player hasn't earned or paid for.
 */
export function purchaseUpgrade(
  address: string,
  id: UpgradeId,
): { ok: true; record: ProgressRecord; level: number } | { ok: false; reason: PurchaseRefusal } {
  const rec   = getProgress(address)
  const level = rec.upgrades[id] ?? 0
  const check = canPurchase(id, level, rec.money, rec.xp)
  if (!check.ok) return { ok: false, reason: check.reason }

  rec.money -= check.cost
  rec.upgrades[id] = level + 1
  dirty = true
  return { ok: true, record: rec, level: level + 1 }
}

/**
 * Persists all non-guest records. Call at shift end (a checkpoint), never per clean.
 * No-ops when nothing changed, so an idle server makes no requests.
 */
/**
 * Whether a record is worth persisting.
 *
 * Deliberately conservative: a career is a player's investment, and there is no
 * undo for deleting one. So this only drops records that represent NO earned
 * progress at all — someone who arrived, got a row created by getProgress (which
 * creates on read), and never completed a shift or bought anything. Everyone who
 * has actually played is kept forever, however long ago.
 *
 * That keeps the document proportional to real players rather than to every
 * address that has ever loaded the scene.
 */
function isWorthKeeping(rec: ProgressRecord): boolean {
  return rec.shifts > 0 || rec.xp > 0 || rec.money > 0 || rec.lifetimeItems > 0
}

export async function saveProgress(): Promise<void> {
  if (!dirty) return
  if (!loadStarted) {
    console.log('[PROGRESS] save skipped — load never started')
    return
  }
  const players: Record<string, ProgressRecord> = {}
  let pruned = 0
  for (const [address, rec] of records) {
    if (guests.has(address)) continue   // session-only, never written
    if (!isWorthKeeping(rec)) { pruned++; continue }
    players[address] = rec
  }
  if (pruned > 0) console.log(`[PROGRESS] skipped ${pruned} empty record(s)`)
  if (Object.keys(players).length === 0) return   // nothing persistable (all guests)

  // Clear BEFORE the await so mutations that land mid-write re-mark the flag,
  // then restore on failure so the next checkpoint retries — the old
  // clear-and-forget meant a failed final save (e.g. right before the empty-
  // club shutdown) silently lost the shift.
  dirty = false
  const ok = await doc.save({ v: SCHEMA_VERSION, players })
  if (!ok) dirty = true
}
