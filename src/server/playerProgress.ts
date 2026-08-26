// Per-player career progression — money, XP, job title and upgrade levels.
//
// SERVER AUTHORITY. Every value here is computed server-side from the server's own
// count of what was cleaned. Clients never report earnings; they send "I cleaned
// item X" and receive the resulting totals. Money buys real advantage and feeds
// leaderboards, so treating client numbers as input would be directly exploitable.
//
// STORAGE SHAPE: selected by CAREER_STORAGE_MODE (shared/config.ts).
//
//   'blob'  one document holds every player. The original shape — it matched the
//           leaderboard's proven pattern and kept a save to a single request,
//           which matters because writes belong at checkpoints, not per-frame.
//           Its cost is growth on two axes: players, and the variety each player
//           touches (kindCounts is sparse and unbounded), with every save
//           rewriting every career ever earned.
//
//   'keyed' one address-keyed record per wallet for the full career, plus a small
//           cross-player index for the boards. A save writes only the players who
//           changed. Read src/server/careers/boardIndex.ts before touching this
//           path — the index is not a cache, it is the roster that lets a failed
//           read be told apart from a new player, and per-player storage is
//           unsafe without it.
//
// Either way writes happen once per shift end, never per clean.
//
// The record shape and the pure logic over it (migration, the additive boot-race
// merge, the keep/prune rule) live in ./careers/* so they can be unit-tested
// without the SDK — see test/careers/. This module owns the in-memory state and
// the orchestration, and nothing else should.
//
// GUESTS: Decentraland guest accounts get a throwaway address per session, so
// persisting against it would silently lose everything on leave and pollute the
// stored document with dead entries. Guests play and earn normally in memory, are
// never written to storage, and the client shows a sign-in nudge.

import { engine, PlayerIdentityData } from '@dcl/sdk/ecs'
import { createPersistedDoc } from './persistence'
import { ADMIN_ADDRESSES, CAREER_STORAGE_MODE } from '../shared/config'
import {
  UpgradeId, canPurchase, rankForXp, titleForXp, PurchaseRefusal,
  ACHIEVEMENTS, achievementStates, TITLE_XP,
} from '../shared/progression'
import {
  ProgressRecord, SCHEMA_VERSION, emptyRecord, migrateRecord, isWorthKeeping,
} from './careers/record'
import { mergeSessionIntoStored } from './careers/merge'
import {
  BoardRow, CareerIndexDoc, INDEX_SCHEMA_VERSION,
  projectBoardRow, boardRowToRecord, migrateIndex, indexIsEmpty,
} from './careers/boardIndex'
import { readCareer, writeCareer } from './careers/keyedStore'
import { planMigration } from './careers/migration'

export { ProgressRecord }

/**
 * First crossing into the top rank stamps the coronation date (once, ever).
 * Called on every XP-raising path — shift awards and admin grants alike — so
 * the CLUB OWNERS wall order can't depend on which path promoted the player.
 */
function stampOwnerIfTop(address: string, rec: ProgressRecord): void {
  if (rec.ownerSinceMs === 0 && rankForXp(rec.xp) >= TITLE_XP.length - 1) {
    rec.ownerSinceMs = Date.now()
    markDirty(address)
  }
}

/** UTC day stamp — the boundary all daily mechanics share. */
export const todayStr = (): string => new Date().toISOString().slice(0, 10)
const yesterdayStr = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

/**
 * Bumps a lifetime kind counter (see ProgressRecord.kindCounts). Guests count
 * too — their record is session-only like everything else of theirs.
 */
export function bumpKindCount(address: string, kind: string, n = 1): void {
  if (!kind) return
  const rec = records.get(address.toLowerCase())
  if (!rec) return
  rec.kindCounts[kind] = (rec.kindCounts[kind] ?? 0) + n
  markDirty(address)
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
  markDirty(address)
  return { ok: true, current: value, target: def.target }
}

// ── In-memory state ───────────────────────────────────────────────────────────
const records = new Map<string, ProgressRecord>()   // address → record (guests included)
const guests  = new Set<string>()                   // addresses excluded from persistence
// Addresses whose record came from the STORE — proof of a persistent identity,
// which overrides an engine isGuest misreport (see registerProgressPlayer).
const loadedFromStore = new Set<string>()

// ── Dirty tracking ────────────────────────────────────────────────────────────
// Per-address, not one global flag. 'blob' mode only needs "did anything change",
// but 'keyed' mode has to know WHICH players to write — writing all of them would
// throw away the entire point of the shape. One set serves both: blob reads its
// size, keyed reads its members.
const dirtyAddresses = new Set<string>()
const isDirty = (): boolean => dirtyAddresses.size > 0
function markDirty(address: string): void {
  dirtyAddresses.add(address.toLowerCase())
}

const KEYED = CAREER_STORAGE_MODE === 'keyed'

// ── Keyed-mode state ──────────────────────────────────────────────────────────
// The board index, mirrored in memory. In keyed mode this is the ROSTER: an
// address with a row provably has a stored career, which is the only way to tell
// a failed per-player read from a genuinely new player. See careers/boardIndex.ts.
const indexRows = new Map<string, BoardRow>()
// Addresses whose in-memory record is the COMPLETE career, read from that
// player's own key. Only these may be written back.
const hydrated = new Set<string>()
// Addresses the index vouches for but whose record would not read. Their record
// in memory is a board projection or a stub, so writing it would destroy the real
// career — they stay unwritable until a retry succeeds.
const blocked = new Set<string>()
// Coalesces concurrent hydration of the same address.
const hydrating = new Map<string, Promise<void>>()

/**
 * The persisted document.
 *
 * blob:  every career, keyed by address.
 * keyed: the board index only — full records live in per-player storage.
 *
 * Two DIFFERENT storage keys, deliberately. The migration writes the index
 * without touching the legacy blob, so a cutover is reversible and a mode flip
 * can never make one shape read the other's bytes.
 */
type ProgressDoc = {
  v:       number
  players: Record<string, ProgressRecord>
}

const blobDoc = KEYED ? null : createPersistedDoc<ProgressDoc>(
  'playerProgress',
  'PROGRESS',
  // Wipe guard: never overwrite stored progression with an empty player set.
  (d) => !d || !d.players || Object.keys(d.players).length === 0,
  // Shrink guard: careers are kept forever (isWorthKeeping only drops rows with
  // no earned progress), so the player count does not halve on its own. If it
  // does, something is wrong upstream of the write.
  { count: (d) => Object.keys(d?.players ?? {}).length },
)

// Keyed mode still needs to READ the legacy blob exactly once, to migrate off
// it. Same key and same credentials as blob mode — it is the very same document.
const legacyBlobDoc = KEYED ? createPersistedDoc<ProgressDoc>(
  'playerProgress',
  'PROGRESS',
  (d) => !d || !d.players || Object.keys(d.players).length === 0,
) : null

// ITS OWN EnvVar PREFIX, WHICH IS NOT COSMETIC. On the jsonbin path
// createPersistedDoc picks the bin from the PREFIX alone — the storage key is
// only consulted for DCL Storage. Reusing 'PROGRESS' here would have written the
// index straight into the legacy blob's bin and overwritten every career in it,
// destroying both the "migration never touches the blob" guarantee and the
// rollback. The index needs its own bin: CAREER_INDEX_BIN_ID / _BIN_KEY.
const indexDoc = KEYED ? createPersistedDoc<CareerIndexDoc>(
  'careerIndex',
  'CAREER_INDEX',
  // Wipe guard's per-player twin: an empty index destroys the roster, and with
  // it the ability to tell a failed record read from a new player.
  (d) => indexIsEmpty(d),
) : null

let loadStarted = false
// The doc load is promise-guarded, but every caller of ensureProgressLoaded chains
// its own .then — without this guard each caller re-ran the merge (harmless thanks
// to the records.has check, but it double-logged and double-walked the document).
let mergeDone = false
// Set when a keyed career write fails, so the admin panel reports a save failure
// even though the index document itself wrote fine.
let careerWriteFailed = false

/** Career-doc persistence health — surfaced on the in-world admin panel. */
export function progressStorageStatus() {
  const base = (KEYED ? indexDoc! : blobDoc!).status()
  if (!KEYED) return base
  // Extra fields ride along harmlessly: the client parses this JSON into a typed
  // shape and ignores what it does not name. lastSaveOk has to fold in per-player
  // write health, or a green index would mask careers that are not saving.
  return {
    ...base,
    lastSaveOk: careerWriteFailed ? false : base.lastSaveOk,
    careersBlocked: blocked.size,
  }
}

// Fired after the load merge RESTORES careers over pre-load stub records, so
// server.ts can push the corrected state to those players immediately.
let onCareersRestored: ((addresses: string[]) => void) | undefined
export function setCareersRestoredHandler(fn: (addresses: string[]) => void): void {
  onCareersRestored = fn
}

export function ensureProgressLoaded(): Promise<unknown> {
  loadStarted = true
  const load = KEYED
    ? indexDoc!.ensureLoaded().then(applyStoredIndex)
    : blobDoc!.ensureLoaded().then(applyStoredDoc)
  return load.catch((e) => {
    // Saves stay blocked (loadConfirmed false), so nothing is overwritten.
    // The persistence layer keeps retrying in the background — if the store
    // comes back, the merge runs late (see the onLateLoad registrations)
    // and every connected player's real career is restored mid-session.
    console.log('[PROGRESS] load failed — progression will not persist until the store recovers:', e)
  })
}

/**
 * Merges one stored career over whatever this session already had for it.
 * Shared by both modes so the boot-race rules can never diverge between them.
 * Returns true when a pre-load session stub was folded in (i.e. the player needs
 * their corrected career pushed).
 */
function adoptStoredRecord(key: string, loaded: ProgressRecord): boolean {
  const existing = records.get(key)
  // A board projection is NOT session progress — it is seven fields read from the
  // index with everything else at defaults. Merging it would double-count money
  // and XP, so it is replaced outright.
  const isProjection = KEYED && !hydrated.has(key) && indexRows.has(key) && existing !== undefined
  const restored = existing !== undefined && !isProjection

  if (restored) mergeSessionIntoStored(loaded, existing!)

  records.set(key, loaded)
  loadedFromStore.add(key)
  // A stored career proves this identity persists — clear any guest
  // misflag applied by a register that ran before the load settled.
  if (guests.has(key)) {
    guests.delete(key)
    console.log(`[PROGRESS] ${key} was flagged guest but has a stored career — flag cleared`)
  }
  if (restored) console.log(`[PROGRESS] restored stored career for ${key} over a pre-load session stub`)
  return restored
}

// ── blob mode ─────────────────────────────────────────────────────────────────
// Runs for the FOREGROUND load and for a background LATE load alike: the merge
// is additive over session records (the boot-race design), which is exactly
// the right behavior when careers arrive minutes into a session too — what was
// earned during the outage stacks on top of the restored career.
function applyStoredDoc(stored: ProgressDoc | null): void {
  if (mergeDone) return
  mergeDone = true
  if (!stored || !stored.players) return
  let n = 0
  const restored: string[] = []
  for (const [address, raw] of Object.entries(stored.players)) {
    const key = address.toLowerCase()
    if (adoptStoredRecord(key, migrateRecord(raw))) restored.push(key)
    n++
  }
  console.log(`[PROGRESS] loaded ${n} player records${restored.length ? ` (${restored.length} restored over boot-race stubs)` : ''}`)
  finishRestore(restored)
}

// ── keyed mode ────────────────────────────────────────────────────────────────
/**
 * Adopts the board index. This does NOT load careers — it loads the roster plus
 * the seven fields the boards read, so offline veterans keep appearing on TOP
 * EARNERS and the CLUB OWNERS wall without holding every career in RAM.
 *
 * Records created here are PROJECTIONS and are never written back (see
 * boardRowToRecord). A player's real career is fetched by hydrate() when they
 * join, which is also when they become writable.
 */
function applyStoredIndex(stored: CareerIndexDoc | null): void {
  if (mergeDone) return
  mergeDone = true
  // Captured BEFORE projections are added: everyone already in `records` at this
  // point got there from a live session (register or getProgress's create-on-read),
  // so these are the players actually in the club — the ones who need a real
  // career read. Everyone else only needs their board projection.
  const present = [...records.keys()]

  const doc = migrateIndex(stored)
  let projected = 0
  for (const [address, row] of Object.entries(doc.rows)) {
    const key = address.toLowerCase()
    indexRows.set(key, row)
    // Never clobber a live session record with a projection — a player already
    // in the club has real earnings in memory and is about to be hydrated.
    if (!records.has(key)) {
      records.set(key, boardRowToRecord(row))
      projected++
    }
  }
  console.log(`[PROGRESS] board index loaded: ${indexRows.size} roster row(s), ${projected} projected for boards`)

  // The boot-race case: players who joined before the index landed. Hydrating
  // them folds this session's pre-load earnings onto their stored career.
  for (const key of present) if (!hydrated.has(key)) void hydrateCareer(key)

  // A CONFIRMED-empty index on a world that has a legacy blob means this is the
  // first keyed boot. (Confirmed matters: ensureLoaded rejects rather than
  // resolving when the read fails, so an empty index here is a real fact, not an
  // outage. Migrating on an outage would be catastrophic.)
  if (indexRows.size === 0) void runMigration()
}

/**
 * One-time move of every career out of the legacy blob into per-player keys.
 *
 * Runs at most once per world: afterwards the index has rows, so the caller's
 * emptiness check never fires again. The legacy blob is left completely intact —
 * see careers/migration.ts for why that matters.
 */
async function runMigration(): Promise<void> {
  console.log('[PROGRESS] board index is empty — looking for a legacy blob to migrate')
  let blob: ProgressDoc | null
  try {
    blob = await legacyBlobDoc!.ensureLoaded()
  } catch (e) {
    console.log('[PROGRESS] migration ABORTED — the legacy blob would not read, so an empty index ' +
      'cannot be trusted to mean "nothing to migrate". Nothing written. Will retry on the next boot:', e)
    return
  }
  if (!blob || !blob.players || Object.keys(blob.players).length === 0) {
    console.log('[PROGRESS] no legacy careers found — starting fresh in keyed mode')
    return
  }

  const plan = planMigration(blob.players)
  console.log(`[PROGRESS] MIGRATING ${plan.writes.length} career(s) to per-player storage` +
    `${plan.pruned ? ` (${plan.pruned} empty record(s) pruned)` : ''} — the legacy blob is left untouched`)

  // Bounded concurrency. Sequential would take minutes on a large roster; all at
  // once would hammer a service whose rate limits are undocumented (the repo's
  // "~40 concurrent" figure is an empirical observation, not a contract).
  const CONCURRENCY = 8
  const done: Array<{ address: string; record: ProgressRecord }> = []
  const failed: string[] = []
  const queue = [...plan.writes]
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      const ok = await writeCareer(next.address, next.record)
      if (ok) done.push(next)
      else failed.push(next.address)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  if (done.length === 0) {
    console.log('[PROGRESS] migration wrote NOTHING — index left empty so the next boot retries')
    return
  }

  // Index only the careers that ACTUALLY landed. Listing a player whose record
  // failed to write would make the roster vouch for a career that is not there,
  // and every later read of it would be classified as a failure — blocking that
  // player instead of letting the next attempt fix them.
  const rows: Record<string, BoardRow> = {}
  for (const { address, record } of done) rows[address] = projectBoardRow(record)
  const indexOk = await indexDoc!.save({ v: INDEX_SCHEMA_VERSION, rows })

  if (!indexOk) {
    console.log(`[PROGRESS] migration WROTE ${done.length} career(s) but the index write FAILED. ` +
      'Careers are safe in per-player storage; the next boot sees an empty index and re-derives ' +
      'the index from the blob. No data lost.')
    return
  }

  // Adopt into memory so this session serves the migrated state immediately.
  for (const { address, record } of done) {
    indexRows.set(address, projectBoardRow(record))
    if (!records.has(address)) records.set(address, record)
    hydrated.add(address)
    loadedFromStore.add(address)
  }
  console.log(`[PROGRESS] MIGRATION COMPLETE — ${done.length} career(s) now per-player` +
    `${failed.length ? `, ${failed.length} FAILED and still only in the blob (retried next boot)` : ''}. ` +
    'Verify the boards, then keep the blob as a rollback point.')
}

/**
 * Reads one player's full career from their own key and makes them writable.
 *
 * The three outcomes are the whole safety story — see careers/keyedStore.ts:
 *   found   adopt it (folding in any pre-load session earnings) and hydrate.
 *   absent  provably new: the session record IS the truth, so hydrate as-is.
 *   failed  the roster says a career exists but we could not read it. Do NOT
 *           hydrate — that leaves the player unwritable, so a save can never
 *           overwrite a real career with a projection or a stub.
 */
export async function hydrateCareer(address: string): Promise<void> {
  if (!KEYED) return
  const key = address.toLowerCase()
  if (hydrated.has(key)) return
  const inflight = hydrating.get(key)
  if (inflight) return inflight

  const run = (async () => {
    const result = await readCareer(key, indexRows.has(key))
    if (result.outcome === 'found') {
      const restored = adoptStoredRecord(key, result.record)
      hydrated.add(key)
      blocked.delete(key)
      if (restored) finishRestore([key])
    } else if (result.outcome === 'absent') {
      // No stored career and the roster agrees. Whatever is in memory (a fresh
      // record, or this session's earnings so far) is the truth from here.
      if (!records.has(key)) records.set(key, emptyRecord())
      hydrated.add(key)
      blocked.delete(key)
    } else {
      blocked.add(key)
      console.log(`[PROGRESS] career read BLOCKED for ${key} — ${result.reason}. ` +
        `Saves for this player are refused until a retry succeeds (nothing will be overwritten).`)
    }
  })().finally(() => { hydrating.delete(key) })

  hydrating.set(key, run)
  return run
}

/** Re-attempts every blocked hydration. Called at each save checkpoint. */
async function retryBlockedHydrations(): Promise<void> {
  if (blocked.size === 0) return
  const pending = [...blocked]
  console.log(`[PROGRESS] retrying ${pending.length} blocked career read(s)`)
  await Promise.all(pending.map((k) => hydrateCareer(k)))
}

/** Shared tail of every restore path. */
function finishRestore(restored: string[]): void {
  if (restored.length === 0) return
  // The merged truth should reach the store at the next checkpoint.
  for (const key of restored) markDirty(key)
  onCareersRestored?.(restored)
}

// Background recovery: a load that succeeds after the foreground window gave
// up flows through the SAME merge, restoring careers mid-session (every
// connected player has a session record by then, so they all land in
// `restored` and get their corrected state pushed).
if (KEYED) indexDoc!.onLateLoad(applyStoredIndex)
else blobDoc!.onLateLoad(applyStoredDoc)

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
  // A rename is a real change that used to reach the store only if some other
  // mutation happened to mark the document dirty before the next checkpoint.
  if (displayName) markDirty(key)

  // Keyed mode: fetch this player's real career. Deliberately not awaited — the
  // caller is synchronous and the additive merge is built for exactly this race,
  // so a player who acts before their career lands keeps those earnings and gets
  // the corrected total pushed by setCareersRestoredHandler.
  if (KEYED) void hydrateCareer(key)

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
    markDirty(address)
    return true
  }
  const def = ACHIEVEMENTS.find((a) => a.gear === gear)
  if (!def) return false
  const state = achievementStates(rec.kindCounts).find((s) => s.gear === gear)
  if (!state?.unlocked) return false
  rec.flexGear = gear
  markDirty(address)
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
  stampOwnerIfTop(address, rec)

  const rankAfter = rankForXp(rec.xp)
  markDirty(address)

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
  markDirty(address)
  stampOwnerIfTop(address, rec)
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
  markDirty(address)
  return { ok: true, record: rec, level: level + 1 }
}

/**
 * Persists all non-guest records. Call at shift end (a checkpoint), never per clean.
 * No-ops when nothing changed, so an idle server makes no requests.
 */
export async function saveProgress(): Promise<void> {
  if (!isDirty()) return
  if (!loadStarted) {
    console.log('[PROGRESS] save skipped — load never started')
    return
  }
  if (KEYED) return saveKeyed()
  return saveBlob()
}

/** Whether this address's record may be persisted at all. */
function persistable(address: string, rec: ProgressRecord): boolean {
  if (guests.has(address)) return false      // session-only, never written
  return isWorthKeeping(rec)
}

async function saveBlob(): Promise<void> {
  const players: Record<string, ProgressRecord> = {}
  let pruned = 0
  for (const [address, rec] of records) {
    if (!persistable(address, rec)) { if (!guests.has(address)) pruned++; continue }
    players[address] = rec
  }
  if (pruned > 0) console.log(`[PROGRESS] skipped ${pruned} empty record(s)`)
  if (Object.keys(players).length === 0) return   // nothing persistable (all guests)

  // Clear BEFORE the await so mutations that land mid-write re-mark the flag,
  // then restore on failure so the next checkpoint retries — the old
  // clear-and-forget meant a failed final save (e.g. right before the empty-
  // club shutdown) silently lost the shift.
  const inFlight = [...dirtyAddresses]
  dirtyAddresses.clear()
  const ok = await blobDoc!.save({ v: SCHEMA_VERSION, players })
  if (!ok) for (const a of inFlight) dirtyAddresses.add(a)
}

/**
 * Writes only the players who changed, then refreshes the board index.
 *
 * ORDER MATTERS AND IS NOT A TRANSACTION. The SDK has no multi-key write, no
 * CAS and no rollback, so the record and the index cannot land atomically. The
 * record goes first on purpose:
 *   record ok, index fails  → the career is safe; the boards lag by one
 *                             checkpoint and self-heal at the next save.
 *   index ok, record fails  → the roster would vouch for a career that is not
 *                             there, and every later read of it would be
 *                             classified as a FAILURE, blocking that player
 *                             for the session. Strictly worse, hence the order.
 */
async function saveKeyed(): Promise<void> {
  // Give blocked players another chance before deciding who to write — a player
  // whose read recovers here gets their real career saved this checkpoint
  // instead of waiting for the next one.
  await retryBlockedHydrations()

  const inFlight = [...dirtyAddresses]
  dirtyAddresses.clear()
  careerWriteFailed = false

  let written = 0
  let pruned  = 0
  let skipped = 0
  const failed: string[] = []

  for (const address of inFlight) {
    const rec = records.get(address)
    if (!rec) continue
    if (!persistable(address, rec)) { if (!guests.has(address)) pruned++; continue }
    // THE GUARD THAT MAKES THIS SHAPE SAFE. An un-hydrated record is either a
    // board projection (seven fields, everything else at defaults) or a stub
    // for a player whose stored career would not read. Writing either one
    // destroys a real career. Keep them dirty so a later checkpoint retries.
    if (!hydrated.has(address)) {
      skipped++
      dirtyAddresses.add(address)
      continue
    }
    const ok = await writeCareer(address, rec)
    if (ok) {
      written++
      indexRows.set(address, projectBoardRow(rec))
    } else {
      failed.push(address)
      dirtyAddresses.add(address)
    }
  }

  if (pruned > 0)  console.log(`[PROGRESS] skipped ${pruned} empty record(s)`)
  if (skipped > 0) console.log(`[PROGRESS] skipped ${skipped} un-hydrated record(s) — will retry (no data overwritten)`)
  if (failed.length > 0) {
    careerWriteFailed = true
    console.log(`[PROGRESS] ERROR: ${failed.length} career write(s) failed — will retry at the next checkpoint`)
  }

  if (written === 0) return

  // Refresh the roster + board projections. One document, written whole, but it
  // carries seven scalars per player rather than every career in full.
  const rows: Record<string, BoardRow> = {}
  for (const [address, row] of indexRows) rows[address] = row
  const indexOk = await indexDoc!.save({ v: INDEX_SCHEMA_VERSION, rows })
  if (!indexOk) {
    careerWriteFailed = true
    console.log('[PROGRESS] ERROR: board index write failed — careers are saved, boards will lag until the next checkpoint')
  }
  console.log(`[PROGRESS] saved ${written} career record(s), index ${indexOk ? 'updated' : 'STALE'} (${indexRows.size} rows)`)
}
