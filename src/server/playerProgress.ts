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
import {
  UpgradeId, canPurchase, rankForXp, titleForXp, PurchaseRefusal,
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
})

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
  if (raw.upgrades && typeof raw.upgrades === 'object') {
    for (const [k, v] of Object.entries(raw.upgrades)) {
      if (typeof v === 'number' && v > 0) rec.upgrades[k as UpgradeId] = Math.floor(v)
    }
  }
  return rec
}

// ── In-memory state ───────────────────────────────────────────────────────────
const records = new Map<string, ProgressRecord>()   // address → record (guests included)
const guests  = new Set<string>()                   // addresses excluded from persistence
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
export function ensureProgressLoaded(): Promise<unknown> {
  loadStarted = true
  return doc.ensureLoaded().then((stored) => {
    if (mergeDone) return
    mergeDone = true
    if (!stored || !stored.players) return
    let n = 0
    for (const [address, raw] of Object.entries(stored.players)) {
      // Don't clobber a record already mutated in memory: on a cold server a player
      // can clean items before the read lands, and their in-session earnings must
      // not be reverted by the slower disk value.
      if (records.has(address)) continue
      records.set(address.toLowerCase(), migrate(raw))
      n++
    }
    console.log(`[PROGRESS] loaded ${n} player records`)
  }).catch((e) => {
    // Saves stay blocked (loadConfirmed false), so nothing is overwritten.
    console.log('[PROGRESS] load failed — progression will not persist this session:', e)
  })
}

/**
 * Whether this address belongs to a guest account. Read from the engine's own
 * PlayerIdentityData rather than anything the client sends, since a client claiming
 * not to be a guest would otherwise get a permanent slot for a throwaway address.
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
    guests.add(key)
    console.log(`[PROGRESS] ${displayName || key} is a guest — progress is session-only`)
  } else {
    guests.delete(key)
  }
  return rec
}

export const isGuestAddress = (address: string): boolean => guests.has(address.toLowerCase())

/**
 * Every known record, for building leaderboard categories.
 *
 * Guests are included: they earn normally for the session, and excluding them from
 * a live board would make the club look emptier than it is. They simply don't
 * persist, so they drop off when they leave.
 */
export function allProgressRecords(): ProgressRecord[] {
  return [...records.values()]
}

export function getProgress(address: string): ProgressRecord {
  const key = address.toLowerCase()
  let rec = records.get(key)
  if (!rec) { rec = emptyRecord(); records.set(key, rec) }
  return rec
}

/** Applies a completed shift's rewards. Returns the record for broadcasting back. */
export function awardShift(
  address: string,
  money: number,
  xp: number,
  itemsCleaned: number,
): { record: ProgressRecord; promotedTo: string | null } {
  const rec = getProgress(address)
  const rankBefore = rankForXp(rec.xp)

  rec.money += Math.max(0, Math.round(money))
  rec.xp    += Math.max(0, Math.round(xp))
  rec.shifts += 1
  rec.lifetimeItems += Math.max(0, itemsCleaned)

  const rankAfter = rankForXp(rec.xp)
  dirty = true

  return {
    record: rec,
    // Surfaced so the end-of-shift screen can celebrate a promotion explicitly,
    // which is the GDD's core "closer to my next promotion" payoff moment.
    promotedTo: rankAfter > rankBefore ? titleForXp(rec.xp) : null,
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
export async function saveProgress(): Promise<void> {
  if (!dirty) return
  if (!loadStarted) {
    console.log('[PROGRESS] save skipped — load never started')
    return
  }
  const players: Record<string, ProgressRecord> = {}
  for (const [address, rec] of records) {
    if (guests.has(address)) continue   // session-only, never written
    players[address] = rec
  }
  if (Object.keys(players).length === 0) return   // nothing persistable (all guests)

  dirty = false
  await doc.save({ v: SCHEMA_VERSION, players })
}
