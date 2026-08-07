import { engine, Entity, Name, Transform, executeTask, GltfContainer, ColliderLayer } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { Storage, EnvVar } from '@dcl/sdk/server'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { OUTCOME_OPTIMAL } from '../shared/config'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, ADMIN_ADDRESSES, ItemCategory, THEME_DEFS, ThemeId, THEME_SLOT_PREFIX, THEME_SLOT_COUNT, themeModelSrc, TIGHT_ANCHOR_PARTS, THEME_SMALL_MODELS, DISASTER_PREFIX, DISASTER_STAGES, DISASTER_CHANCE_CLASSIC, DISASTER_THEMES, DISASTER_BONUS, BIN_STREAM_CAPACITY, HAUL_BONUS } from '../shared/config'
import { SCENE_ITEM_PREFIXES, RUBBISH_ID_PREFIX, GLASS_ID_PREFIX, BOTTLE_ID_PREFIX, STICKY_ID_PREFIX, RubbishType, classifyRubbish, discoverGlasses, discoverBottles, discoverRubbish, discoverStickyPatches } from '../shared/glassDiscovery'
import { initRoundManager, onItemCleaned, onSceneItemCleaned, onPlayerEnter, onPlayerLeave, onAdminReset, onNextRoundRequest, onStartMatch, getPhase, getRoundNumber, recordContribution, setShiftCompleteHandler, setRoundStartHandler, setStartHold, getThemeContractKinds, setForcedTheme, setThemeSpawnRoller, setCrewPowerProvider } from './RoundManager'
import { OUTCOME_ADEQUATE } from '../shared/config'
import { shiftRewards, titleProgress, titleForXp, rankForXp, upgradeValue, UpgradeId } from '../shared/progression'
import {
  ensureProgressLoaded, registerProgressPlayer, getProgress, awardShift,
  purchaseUpgrade, saveProgress, isGuestAddress, allProgressRecords, adminAdjust, todayStr,
  progressStorageStatus, setCareersRestoredHandler,
} from './playerProgress'

// ── Leaderboard ───────────────────────────────────────────────
interface LeaderboardEntry { displayName: string; total: number }
const leaderboard = new Map<string, LeaderboardEntry>()  // address → entry

// Single-promise guard — ensures loadLeaderboard() only ever runs once,
// even if ensureLeaderboardLoaded() is called concurrently by multiple handlers.
let leaderboardLoadPromise: Promise<void> | null = null

function ensureLeaderboardLoaded(): Promise<void> {
  if (!leaderboardLoadPromise) leaderboardLoadPromise = loadLeaderboard()
  return leaderboardLoadPromise
}

// True once we've confirmed (via a settled read) what's actually in storage. Until
// then we must NOT save — a write before a confirmed read can overwrite good data.
let leaderboardLoadConfirmed = false

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type LbRecord = { address: string; displayName: string; total: number }

// ── Persistence backend ───────────────────────────────────────────────────────
// Decentraland Worlds have a server-storage bug: `Storage` is scoped per DEPLOY
// (content hash), not per location, so after a republish the server reads a fresh,
// EMPTY bucket and can never see the previous deploy's data (the owner CLI can,
// because it reads the latest deploy's bucket). Confirmed in production: 90s of
// retried reads all 404'd while the CLI read the data instantly. Retrying can't fix
// a scope problem — the data simply isn't in the bucket the server is allowed to read.
//
// Fix: persist to an EXTERNAL store the server can read consistently across deploys.
// When LEADERBOARD_BIN_ID + LEADERBOARD_BIN_KEY are set (server EnvVars), we use
// jsonbin.io; otherwise we fall back to DCL `Storage` (which works fine on LAND).
let binCfg: { id: string; key: string } | null = null
let binCfgLoaded = false
async function getBinCfg(): Promise<{ id: string; key: string } | null> {
  if (!binCfgLoaded) {
    binCfgLoaded = true
    try {
      const id  = await EnvVar.get('LEADERBOARD_BIN_ID')
      const key = await EnvVar.get('LEADERBOARD_BIN_KEY')
      binCfg = id && key ? { id, key } : null
    } catch (e) {
      console.log('[SERVER] EnvVar read failed — using DCL Storage for leaderboard:', e)
      binCfg = null
    }
    console.log(binCfg
      ? '[SERVER] Leaderboard persistence: external store (jsonbin)'
      : '[SERVER] Leaderboard persistence: DCL Storage (no LEADERBOARD_BIN_* env vars)')
  }
  return binCfg
}

// Read stored records. Returns [] for a confirmed-empty store, or null when the read
// couldn't be completed (treated as "unknown" → keep retrying, never overwrite).
async function loadRecords(): Promise<LbRecord[] | null> {
  const cfg = await getBinCfg()
  if (cfg) {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${cfg.id}/latest`, {
      headers: { 'X-Master-Key': cfg.key },
    })
    if (res.status === 404) return []                       // empty/new bin
    if (!res.ok) throw new Error(`jsonbin read ${res.status}`)
    const json: any = await res.json()
    const rec = json?.record
    return Array.isArray(rec) ? (rec as LbRecord[]) : []
  }
  // DCL Storage fallback — Storage.get returns null on not-found (404).
  const raw = await Storage.get<string>('leaderboard')
  return raw ? (JSON.parse(raw) as LbRecord[]) : null
}

async function saveRecords(records: LbRecord[]): Promise<void> {
  const cfg = await getBinCfg()
  if (cfg) {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${cfg.id}`, {
      method: 'PUT',
      headers: {
        'X-Master-Key':     cfg.key,
        'Content-Type':     'application/json',
        'X-Bin-Versioning': 'false',   // overwrite in place, don't pile up versions
      },
      body: JSON.stringify(records),
    })
    if (!res.ok) throw new Error(`jsonbin write ${res.status}`)
    return
  }
  await Storage.set('leaderboard', JSON.stringify(records))
}

// ── Load / save ───────────────────────────────────────────────────────────────
// We still retry the read (network resilience + the DCL-Storage fallback's cold
// start), but with the external store a 404 means "empty bin" and confirms instantly,
// so this no longer stalls a fresh deploy. We only keep retrying a genuinely failed
// (thrown) or null read, never overwriting before a settled read.
const READ_RETRY_MS  = 4_000    // gap between read attempts
const READ_WINDOW_MS = 30_000   // total time we'll keep trying before giving up
async function loadLeaderboard(): Promise<void> {
  const deadline = Date.now() + READ_WINDOW_MS
  let attempt = 0
  while (true) {
    attempt++
    try {
      const records = await loadRecords()
      if (records !== null) {
        for (const r of records) leaderboard.set(r.address, { displayName: r.displayName, total: r.total })
        console.log(`[SERVER] Loaded leaderboard: ${leaderboard.size} players (attempt ${attempt})`)
        leaderboardLoadConfirmed = true
        return
      }
      // null = read couldn't be completed (DCL-Storage 404). Keep trying to the deadline.
      if (Date.now() >= deadline) {
        console.log(`[SERVER] No leaderboard data after ${attempt} attempts — starting fresh`)
        leaderboardLoadConfirmed = true
        return
      }
    } catch (e) {
      console.log(`[SERVER] leaderboard load attempt ${attempt} failed:`, e)
      if (Date.now() >= deadline) throw e   // give up → saves stay blocked (no wipe)
    }
    await sleep(READ_RETRY_MS)
  }
}

async function saveLeaderboard(): Promise<void> {
  // Never persist before a confirmed read, and never overwrite stored data with an
  // empty map — both are wipe signatures, not legitimate saves.
  if (!leaderboardLoadConfirmed) {
    console.log('[SERVER] Skipping save — leaderboard load not yet confirmed')
    return
  }
  if (leaderboard.size === 0) {
    console.log('[SERVER] Skipping save — leaderboard is empty (guarding against wipe)')
    return
  }
  // Drop scoreless rows — registerPlayer creates an entry with total 0 for
  // everyone who walks in, so without this the document accumulates a record
  // per visitor rather than per player. Anyone who has cleaned even one item is
  // kept permanently; this only sheds rows that carry no information.
  const records = [...leaderboard.entries()]
    .filter(([, e]) => e.total > 0)
    .map(([address, e]) => ({ address, ...e }))
  if (records.length === 0) {
    console.log('[SERVER] Skipping save — no scoring players yet')
    return
  }
  console.log(`[SERVER] Saving leaderboard: ${records.length} players`)
  try {
    await saveRecords(records)
    console.log(`[SERVER] Saved leaderboard OK (${records.length} players)`)
  } catch (e) {
    console.log('[SERVER] ERROR: leaderboard SAVE failed:', e)
  }
}

// ── Leaderboard categories (V2) ───────────────────────────────────────────────
// The GDD asks for "expanded leaderboard categories and statistics". Rather than
// building extra in-world boards, all categories ship in one payload and the single
// board cycles through them (see leaderboardSystem).
//
// "Cleaned" deliberately still comes from the legacy leaderboard map rather than
// progression's lifetimeItems: that map holds real historical data players have
// already earned, while lifetimeItems starts at zero for everyone. Rebuilding the
// board from progression would silently wipe every existing score from view.
const LB_TOP_N = 10   // per category; keeps the payload far inside the ~13KB cap

type LbCategory = {
  key:         string
  title:       string
  scoreHeader: string
  entries:     Array<{ displayName: string; score: string }>
}

function buildCategories(): LbCategory[] {
  const progress = allProgressRecords().filter((r) => r.displayName)

  const topBy = <T,>(
    items: T[],
    value: (t: T) => number,
    label: (t: T) => string,
    format: (t: T) => string,
  ) =>
    items
      .filter((t) => value(t) > 0)   // an all-zero board reads as broken, not empty
      .sort((a, b) => value(b) - value(a))
      .slice(0, LB_TOP_N)
      .map((t) => ({ displayName: label(t), score: format(t) }))

  return [
    {
      // Daily board — resets every UTC day, so newcomers always have a winnable
      // race even while the all-time boards belong to the veterans.
      key: 'today', title: "TODAY'S TOP", scoreHeader: 'CLEANED',
      entries: topBy(
        progress.filter((r) => r.dailyDay === todayStr()),
        (r) => r.dailyItems, (r) => r.displayName, (r) => String(r.dailyItems),
      ),
    },
    {
      key: 'cleaned', title: 'TOP CLEANERS', scoreHeader: 'CLEANED',
      entries: topBy(
        [...leaderboard.values()],
        (e) => e.total, (e) => e.displayName, (e) => String(e.total),
      ),
    },
    {
      key: 'earnings', title: 'TOP EARNERS', scoreHeader: 'EARNED',
      entries: topBy(
        progress,
        (r) => r.money, (r) => r.displayName, (r) => `$${r.money}`,
      ),
    },
    {
      key: 'rank', title: 'HIGHEST RANK', scoreHeader: 'TITLE',
      entries: topBy(
        progress,
        (r) => r.xp, (r) => r.displayName, (r) => titleForXp(r.xp),
      ),
    },
    {
      key: 'shifts', title: 'MOST SHIFTS', scoreHeader: 'SHIFTS',
      entries: topBy(
        progress,
        (r) => r.shifts, (r) => r.displayName, (r) => String(r.shifts),
      ),
    },
  ]
}

function leaderboardJson(): string {
  // Categories only — the client falls back to treating a bare array as the legacy
  // single-board shape, so an older client against a newer server still renders.
  return JSON.stringify({ categories: buildCategories() })
}

function broadcastLeaderboard(to?: string[]): void {
  const entriesJson = leaderboardJson()
  if (to) {
    room.send('leaderboardUpdate', { entriesJson }, { to })
  } else {
    room.send('leaderboardUpdate', { entriesJson })
  }
}

// Trailing debounce — collapses rapid back-to-back cleanItem score updates
// into a single save+broadcast after LB_DEBOUNCE_MS of quiet.
const LB_DEBOUNCE_MS = 4_000
let lbDebounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleLbUpdate(): void {
  if (lbDebounceTimer !== null) clearTimeout(lbDebounceTimer)
  lbDebounceTimer = setTimeout(() => {
    lbDebounceTimer = null
    executeTask(async () => {
      // Always wait for the load to complete before saving — prevents overwriting
      // good stored data with an empty map on a cold server start where a player
      // cleans an item within the first 4 seconds (before Storage.get resolves).
      try {
        await ensureLeaderboardLoaded()
      } catch {
        console.log('[SERVER] Leaderboard load failed — skipping broadcast')
        return
      }
      // Broadcast ONLY — no write. Persisting here meant one full-document PUT
      // per burst of cleaning (5-10 per round); the external store now gets a
      // single checkpoint write at shift end instead, alongside progress. Worst
      // case a server crash mid-round loses that round's score deltas, which is
      // exactly the checkpoint granularity the Storage guidance asks for.
      broadcastLeaderboard()
    })
  }, LB_DEBOUNCE_MS)
}

// ── Progression ───────────────────────────────────────────────────────────────

/** Everything the payout screen celebrates about one finished shift. */
type LastShift = {
  money: number; xp: number; passed: boolean; items: number
  grade: string; tip: number
  earlyBonus: number; earlySeconds: number; disasterBonus: number; haulBonus: number
  contractLabel: string | null; contractDone: boolean; contractBonus: number
  openingBonus: boolean; streakDays: number; streakXp: number; newBest: boolean
}

/** Serialises one player's career state for the progressUpdate message. */
function progressPayload(
  address: string,
  lastShift?: LastShift,
  promotedTo?: string | null,
): string {
  const rec  = getProgress(address)
  const prog = titleProgress(rec.xp)
  return JSON.stringify({
    // Fuels the welcome-back card's "opening shift bonus ready!" line.
    openingAvailable: rec.lastWorkDay !== todayStr(),
    money:     rec.money,
    xp:        rec.xp,
    shifts:    rec.shifts,
    rank:      prog.rank,
    title:     prog.title,
    nextTitle: prog.nextTitle,
    fraction:  prog.fraction,
    upgrades:  rec.upgrades,
    // Drives the "sign in to save your progress" nudge — guests earn and spend
    // normally for the session, but nothing is written to storage.
    isGuest:   isGuestAddress(address),
    // Personal best (items in one shift) — fuels the payout card's "beat your
    // best" target line.
    bestItems: rec.bestItems ?? 0,
    lastShift: lastShift ?? null,
    promotedTo: promotedTo ?? null,
  })
}

function sendProgress(
  address: string,
  lastShift?: LastShift,
  promotedTo?: string | null,
): void {
  room.send('progressUpdate', { progressJson: progressPayload(address, lastShift, promotedTo) }, { to: [address] })
}

// ── Participation (pre sign-up) ───────────────────────────────────────────────
// A shift is opt-in. Players who arrive mid-round — including anyone who reloaded
// or whose phone backgrounded and reconnected — spectate until they sign up, and
// join at the start of the next round rather than dropping into a half-cleaned club.
//
// The GDD specifies pre sign-up over auto sign-up, so arriving never silently
// enrols anyone; they choose, and the choice takes effect at a clean boundary.
//
// Server-authoritative because participation gates whether cleans are ACCEPTED —
// a client that decided this for itself could simply declare itself active.
const activePlayers = new Set<string>()   // cleaning in the current round
const signedUp      = new Set<string>()   // queued for the next round
// Everyone currently counted as in-scene. Module scope alongside the other
// presence sets so helpers here (e.g. broadcastRanks) can read it.
// Auto-start hold for first-time players reading the career intro.
const INTRO_READ_HOLD_MS = 30_000
let introHoldUntil = 0

const activeSessions = new Set<string>()

// ── Rubbish carrying (GDD: bin depositing + Carry Capacity upgrade) ───────────
// Rubbish must be CARRIED to a big rubbish bag: each accepted rubbish clean fills
// the player's hands, and at capacity further rubbish is refused until they empty
// at a bag. Only the rubbish group — glasses/bottles keep their instant collect
// loop and sticky patches are mopped, not carried.
//
// Cleanliness and wages still count at PICKUP, so the carry loop changes routing
// (when do I break for a bag trip?) without touching any round or reward math.
//
// Sorted streams: general waste and recyclables are carried in separate pouches;
// CAPACITY limits the total across both, and a bin only empties its own stream.
type CarriedLoad = { general: number; recycle: number }
const carriedRubbish = new Map<string, CarriedLoad>()   // address → pieces in hand

// ── Dumpster haul loop ────────────────────────────────────────────────────────
// Per-stream deposit tally for the round; at BIN_STREAM_CAPACITY that stream's
// bins overflow and refuse deposits until someone hauls A BIN to a dumpster.
// The haul is a physical round trip: the clicked bin VANISHES from its station
// into the hauler's hands ('out'), gets emptied at the dumpster (stream
// unlocks), then must be carried home ('back') — the bonus banks on return.
const binFill = { general: 0, recycle: 0 }
type Haul = { stream: RubbishType; binName: string; stage: 'out' | 'back' }
const haulingBy    = new Map<string, Haul>()          // address → haul in progress
const streamHauler = new Map<RubbishType, string>()   // stream → who took its bin
const haulBonuses  = new Map<string, number>()        // address → banked haul pay
const binStreamFull = (s: RubbishType): boolean => binFill[s] >= BIN_STREAM_CAPACITY
// Scene bin models, discovered server-side so their Transforms can be hidden/
// restored authoritatively (CRDT propagates the vanish to every client).
const serverBins = new Map<string, { entity: Entity; type: RubbishType; base: { x: number; y: number; z: number } }>()

// itemId → stream, classified from the scene Name at discovery (see initServer).
const rubbishTypes = new Map<string, RubbishType>()

// Themed-round spawn slots: which model each live slot wears this round (drives
// its carry stream + contract kinds) and where it stands (vacuum sweep). Both
// re-filled by the spawn roller every round.
const themeSlotModels    = new Map<string, string>()
const themeSlotPositions = new Map<string, { x: number; y: number; z: number }>()
// itemId → lowercase scene Name, for the theme mask's per-name rubbish filter.
const itemNames          = new Map<string, string>()
// Authored scale per spawn model, harvested from the scene at discovery: when a
// hand-placed scene item's Name contains a model name, its hand-tuned scale is
// what that model should spawn at (playtest: scale-1 spawns were visibly wrong
// for models the user had scaled in the editor). Longest-first so 'pizzaEaten'
// wins over 'pizza' and 'sockB' over 'sock'. Default 1 when never hand-placed.
const ALL_THEME_MODELS = [...new Set(THEME_DEFS.flatMap((t) => t.spawns?.models ?? []))]
  .sort((a, b) => b.length - a.length)
const themeModelScales = new Map<string, { x: number; y: number; z: number }>()

// Which carry stream (if any) an item fills. Glasses and bottles count too —
// playtest: "not all collected rubbish seems to count towards my carry limit
// which is unclear" — and being glass, they're recycling. Sticky patches are
// mopped, not carried, so they return null.
function carryStreamFor(itemId: string): RubbishType | null {
  if (itemId.startsWith(RUBBISH_ID_PREFIX)) return rubbishTypes.get(itemId) ?? 'general'
  if (itemId.startsWith(GLASS_ID_PREFIX) || itemId.startsWith(BOTTLE_ID_PREFIX)) return 'recycle'
  // Themed extras classify by their MODEL name through the same shared
  // classifier as scene rubbish (pizza → general, drink/bottle → recycle).
  // Spring-cleaning sticky spawns are MOP work — carried by nobody.
  if (itemId.startsWith(THEME_SLOT_PREFIX)) {
    const model = themeSlotModels.get(itemId)
    if (model && model.toLowerCase().includes('sticky')) return null
    return model ? classifyRubbish(model) : 'general'
  }
  // Disaster pile bits are hauled junk (they fill hands like rubbish); the
  // stain and polish are mop work, carried by nobody.
  if (itemId.startsWith(DISASTER_PREFIX)) {
    return itemId.includes('pile') ? 'general' : null
  }
  return null
}

/**
 * Item category for the themed-round mask (RoundManager). Built here because
 * this module owns the discovery/stream maps. Anything that isn't rubbish,
 * glassware or a sticky patch is a restore prop from CLUTTER_DEFS.
 */
function itemCategoryFor(itemId: string): ItemCategory {
  if (itemId.startsWith(STICKY_ID_PREFIX)) return 'sticky'
  if (itemId.startsWith(GLASS_ID_PREFIX) || itemId.startsWith(BOTTLE_ID_PREFIX)) return 'glasses'
  if (itemId.startsWith(RUBBISH_ID_PREFIX)) {
    return (rubbishTypes.get(itemId) ?? 'general') === 'recycle' ? 'recycle' : 'general'
  }
  return 'reset'
}

function getLoad(address: string): CarriedLoad {
  let l = carriedRubbish.get(address)
  if (!l) { l = { general: 0, recycle: 0 }; carriedRubbish.set(address, l) }
  return l
}

function carriedTotal(address: string): number {
  const l = carriedRubbish.get(address)
  return l ? l.general + l.recycle : 0
}

// Portable Bin upgrade: level = on-the-spot empties per shift. Usage is counted
// here (per shift, cleared at round start) so a crafted message can't empty for
// free more times than the level that was paid for.
const portableUsed = new Map<string, number>()     // address → empties used this shift

// Vacuum upgrade: extra rubbish pieces swept per click, nearest-first inside this
// radius of the clicked item. Distances use the discovery-time local positions of
// the rubbish group's items, which share one parent — consistent for comparison.
const VACUUM_RADIUS_M = 3

function carryCapacityFor(address: string): number {
  const rec = getProgress(address)
  return upgradeValue('carryCapacity', rec.upgrades?.carryCapacity ?? 0)
}

function portableLeftFor(address: string): number {
  const rec  = getProgress(address)
  const uses = upgradeValue('portableBin', rec.upgrades?.portableBin ?? 0)
  return Math.max(0, uses - (portableUsed.get(address) ?? 0))
}

function vacuumExtraFor(address: string): number {
  const rec = getProgress(address)
  return upgradeValue('vacuum', rec.upgrades?.vacuum ?? 0)
}

function sendCarried(address: string): void {
  const load = carriedRubbish.get(address)
  room.send(
    'carriedUpdate',
    {
      carriedGeneral: load?.general ?? 0,
      carriedRecycle: load?.recycle ?? 0,
      capacity:       carryCapacityFor(address),
      portableLeft:   portableLeftFor(address),
      hauling:        haulingBy.get(address)?.stream ?? '',
      haulStage:      haulingBy.get(address)?.stage ?? '',
      haulBinName:    haulingBy.get(address)?.binName ?? '',
    },
    { to: [address] },
  )
}

/** Hide or restore a hauled bin at its station (server-authoritative). */
function setBinAtStation(binName: string, present: boolean): void {
  const bin = serverBins.get(binName)
  if (!bin) return
  const tf = Transform.getMutableOrNull(bin.entity)
  if (!tf) return
  tf.scale = present ? { ...bin.base } : { x: 0.001, y: 0.001, z: 0.001 }
}

// ── Shift contracts ───────────────────────────────────────────────────────────
// A server-rolled mini-goal per player per round ("Mop 3 sticky patches"),
// paying a bonus at shift end. Progress is tallied HERE, from the server's own
// accepted cleans — the client only renders it, so a crafted message can't
// claim a contract it didn't do.
type ContractKind = 'general' | 'recycle' | 'glasses' | 'sticky' | 'deposits' | 'disaster'

// True while the CURRENT round has a live disaster spot — set by the spawn
// roller. Gates the disaster contract out of rounds where it can't be done.
let disasterThisRound = false
// address → finale bonus earned this round; paid through the shift payout so
// the card itemises it and it flows through awardShift like every other bonus.
const disasterBonuses = new Map<string, number>()
type Contract = {
  kind: ContractKind; target: number; progress: number
  money: number; xp: number; label: string
}
const contracts = new Map<string, Contract>()

const CONTRACT_DEFS: Array<{
  kind: ContractKind; min: number; max: number
  moneyPer: number; xpPer: number; label: (n: number) => string
}> = [
  { kind: 'general',  min: 8, max: 14, moneyPer: 4,  xpPer: 2, label: (n) => `Clean ${n} general waste` },
  { kind: 'recycle',  min: 8, max: 14, moneyPer: 4,  xpPer: 2, label: (n) => `Clean ${n} recyclables` },
  { kind: 'glasses',  min: 5, max: 9,  moneyPer: 6,  xpPer: 3, label: (n) => `Collect ${n} glasses` },
  { kind: 'sticky',   min: 2, max: 4,  moneyPer: 15, xpPer: 8, label: (n) => `Mop ${n} sticky patches` },
  { kind: 'deposits', min: 2, max: 3,  moneyPer: 12, xpPer: 6, label: (n) => `Empty bins ${n} times` },
  // Only rollable on rounds that actually HAVE a disaster (see rollContract).
  // Target 5 = every stage of the one spot: three pile bits, stain, polish.
  { kind: 'disaster', min: 5, max: 5,  moneyPer: 8,  xpPer: 4, label: () => 'Clear the disaster zone' },
]

function rollContract(): Contract {
  // Themed rounds narrow the pool to the night's story (e.g. cocktail night
  // rolls glasses/recycle goals). Falls back to the full pool if a theme names
  // no kind that exists here — a misconfigured theme must not break contracts.
  // The disaster contract only exists on rounds with a live disaster — an
  // impossible contract is worse than none. Both the themed pool AND the
  // fallback draw from the same availability-filtered set.
  const available  = CONTRACT_DEFS.filter((d) => d.kind !== 'disaster' || disasterThisRound)
  const allowed = getThemeContractKinds()
  const themedPool = allowed !== null ? available.filter((d) => allowed.includes(d.kind)) : available
  const pool = themedPool.length > 0 ? themedPool : available
  const def = pool[Math.floor(Math.random() * pool.length)]
  const target = def.min + Math.floor(Math.random() * (def.max - def.min + 1))
  return {
    kind: def.kind, target, progress: 0,
    money: target * def.moneyPer, xp: target * def.xpPer,
    label: def.label(target),
  }
}

function sendContract(address: string): void {
  const c = contracts.get(address)
  room.send('contractUpdate', { contractJson: c ? JSON.stringify(c) : '' }, { to: [address] })
}

function bumpContract(address: string, kinds: ContractKind[]): void {
  const c = contracts.get(address)
  if (!c || c.progress >= c.target || !kinds.includes(c.kind)) return
  c.progress++
  sendContract(address)
}

/** Which contract kinds an accepted clean of this item advances. */
function contractKindsFor(itemId: string): ContractKind[] {
  const kinds: ContractKind[] = []
  const stream = carryStreamFor(itemId)
  if (stream === 'general') kinds.push('general')
  if (stream === 'recycle') kinds.push('recycle')
  if (itemId.startsWith(GLASS_ID_PREFIX))  kinds.push('glasses')
  if (itemId.startsWith(STICKY_ID_PREFIX)) kinds.push('sticky')
  // Cocktail-night drinkware counts toward glasses contracts like scene glasses;
  // spring-cleaning sticky spawns advance mop contracts like scene patches.
  const model = themeSlotModels.get(itemId)
  if (model && (model.includes('drink') || model.includes('glass'))) kinds.push('glasses')
  if (model && model.toLowerCase().includes('sticky')) kinds.push('sticky')
  // Every disaster stage advances the disaster contract (5 stages = target 5).
  if (itemId.startsWith(DISASTER_PREFIX)) kinds.push('disaster')
  return kinds
}

// Grade stamp for the payout screen — same thresholds the wage math uses.
function gradeFor(pct: number): string {
  if (pct >= 0.95)             return 'S'
  if (pct >= OUTCOME_OPTIMAL)  return 'A'
  if (pct >= OUTCOME_ADEQUATE) return 'B'
  return 'C'
}

/**
 * Broadcasts every in-scene player's career rank to everyone. Clients render a
 * plate above each avatar from this, standing in for the explorer nametags the
 * scene hides. Sent whenever the roster or anyone's rank can have changed —
 * joins, shift payouts, admin grants — never per frame.
 */
function broadcastRanks(): void {
  const roster: Array<{ a: string; n: string; t: string; r: number }> = []
  for (const address of activeSessions) {
    const rec = getProgress(address)
    if (!rec.displayName) continue   // name not known yet; the plate falls back
    roster.push({
      a: address.toLowerCase(),
      n: rec.displayName,
      t: titleForXp(rec.xp),
      r: rankForXp(rec.xp),
    })
  }
  room.send('ranksUpdate', { rosterJson: JSON.stringify(roster) })
}

function sendParticipation(address: string): void {
  room.send(
    'participationUpdate',
    { active: activePlayers.has(address), signedUp: signedUp.has(address) },
    { to: [address] },
  )
}

export function initServer() {
  console.log('[SERVER] started')

  const itemEntities    = new Map<string, Entity>()
  const sceneItemScales = new Map<string, { x: number; y: number; z: number }>()
  // Every hand-placed sample for theme spawn scales. `model` (GLB src basename)
  // is the reliable identity; `name` (entity Name) is the legacy fallback.
  const themeScaleSamples: Array<{ name: string; model?: string; scale: { x: number; y: number; z: number } }> = []
  // Discovery-time positions of scene items, for the vacuum's proximity sweep.
  const sceneItemPositions = new Map<string, { x: number; y: number; z: number }>()
  let enumId = 1

  // CLUTTER_DEFS items — new entities created by the server
  for (const def of CLUTTER_DEFS) {
    const entity = engine.addEntity()
    ClutterSync.create(entity, { itemId: def.id, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [ClutterSync.componentId], enumId++)
    itemEntities.set(def.id, entity)
  }

  // Scene-placed groups — discovered deterministically (sorted entity ID) so the
  // itemId (= prefix + composite entity id) and enumIds are consistent across server
  // restarts and client discovery.
  //
  // IMPORTANT: we sync a SEPARATE logical entity per item, NOT the visual composite
  // entity. Calling syncEntity on a static composite entity replicates the whole
  // entity (Transform + GltfContainer) to clients as a networked copy, which renders
  // ON TOP of the client's own local composite copy — the "duplicate model" bug.
  // The client bridges ClutterSync ↔ its local visual entity by itemId, so a logical
  // sync entity (ClutterSync only, no visuals) is all that needs to cross the wire.
  for (const { entity, itemId } of [
    ...discoverGlasses(),
    ...discoverBottles(),
    ...discoverRubbish(),
    ...discoverStickyPatches(),
  ]) {
    const syncEnt = engine.addEntity()
    ClutterSync.create(syncEnt, { itemId, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(syncEnt, [ClutterSync.componentId], enumId++)
    itemEntities.set(itemId, syncEnt)

    // Record original scale (read from the visual composite entity) for round reset
    const tf = Transform.getOrNull(entity)
    sceneItemScales.set(itemId, tf
      ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z }
      : { x: 1, y: 1, z: 1 })
    if (tf) {
      sceneItemPositions.set(itemId, { x: tf.position.x, y: tf.position.y, z: tf.position.z })
    }
    // Classify rubbish into its recycling stream from the authored scene Name.
    if (itemId.startsWith(RUBBISH_ID_PREFIX)) {
      rubbishTypes.set(itemId, classifyRubbish(Name.getOrNull(entity)?.value ?? ''))
    }
    // Scene Name per item — the theme mask's keepRubbishNames filter matches on it.
    const sceneName = (Name.getOrNull(entity)?.value ?? '').toLowerCase()
    itemNames.set(itemId, sceneName)
    // Collect every hand-placed item's name + scale; the theme spawner derives
    // per-model spawn scales from these after the loop.
    if (tf && sceneName) {
      themeScaleSamples.push({ name: sceneName, scale: { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z } })
    }
  }

  // CH-scale samples from EVERY GLB placement in the scene — not only the
  // cleanable groups, and identified by the MODEL FILE it renders, not its
  // entity Name: the user's placed brokenGlass is *named* "Wine Glass_2" (CH
  // auto-naming), so name matching missed it. The src basename is the true
  // identity, and exact matching also stops brokenGlass samples polluting
  // reallyBrokenGlass. Parked / hidden entities (scale ≈ 0) are skipped.
  for (const [entity] of engine.getEntitiesWith(GltfContainer, Transform)) {
    const src  = GltfContainer.get(entity).src.toLowerCase()
    const base = src.split('/').pop()?.replace('.glb', '').replace('.gltf', '') ?? ''
    if (!base) continue
    const tf = Transform.getOrNull(entity)
    if (!tf || tf.scale.x <= 0.011) continue
    themeScaleSamples.push({
      name:  (Name.getOrNull(entity)?.value ?? '').toLowerCase(),
      model: base,
      scale: { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z },
    })
  }

  // ── Theme spawn scales — MEDIAN over hand-placed instances of the SAME model ─
  // First-match harvesting picked whichever instance discovery met first, and
  // hand-placed copies are scaled individually — an outlier gave every spawn a
  // wrong size; the median is robust to that. Matching is space/underscore-
  // insensitive, and STRICTLY same-model: an earlier "family" fallback borrowed
  // the scene Bottle's scale for brokenBottle.glb, but authored scales only
  // mean anything for the mesh they were tuned on (playtest: broken bottles
  // wrong size). Models with no hand-placed twin use the explicit override map.
  {
    const norm = (s: string) => s.toLowerCase().replace(/[\s_]/g, '')
    const median = (v: number[]): number => {
      const a = [...v].sort((x, y) => x - y)
      return a[Math.floor(a.length / 2)]
    }
    const report: string[] = []
    for (const model of ALL_THEME_MODELS) {
      const m = norm(model)
      // Exact GLB identity first; entity-name substring only as a fallback.
      let matches = themeScaleSamples.filter((s) => s.model === m)
      if (matches.length === 0) matches = themeScaleSamples.filter((s) => norm(s.name).includes(m))
      if (matches.length === 0) {
        report.push(`${model}=EXCLUDED`)
        console.log(`[SERVER] ⚠ theme model '${model}' has NO Creator Hub placement to take its scale from — it will NOT spawn. Place one instance in CH to enable it.`)
        continue
      }
      themeModelScales.set(model, {
        x: median(matches.map((s) => s.scale.x)),
        y: median(matches.map((s) => s.scale.y)),
        z: median(matches.map((s) => s.scale.z)),
      })
      report.push(`${model}=${themeModelScales.get(model)!.x.toFixed(2)}(CH×${matches.length})`)
    }
    console.log(`[SERVER] theme model scales: ${report.join(' ')}`)
  }

  // ── Bin models (server-side) — hauled bins vanish/return authoritatively ────
  for (const [entity] of engine.getEntitiesWith(Name)) {
    const n = Name.get(entity).value
    const t: RubbishType | null =
      n.startsWith('Bin_General') ? 'general' : n.startsWith('Bin_Recycling') ? 'recycle' : null
    if (!t) continue
    const tf = Transform.getOrNull(entity)
    serverBins.set(n, {
      entity, type: t,
      base: tf ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z } : { x: 1, y: 1, z: 1 },
    })
  }
  console.log(`[SERVER] tracked ${serverBins.size} bin models for the haul loop`)

  // ── Themed-round spawn slots ─────────────────────────────────────────────────
  // Server-created entities whose Transform + GltfContainer + ClutterSync all
  // replicate over CRDT — clients render the models and late joiners get the
  // current spawn state for free; only pointer wiring is client-side
  // (themeSpawnSystem). Parked underground at scale ~0 until a themed round's
  // roller places them.
  const THEME_PARK = { x: 8, y: -50, z: 8 }
  for (let i = 0; i < THEME_SLOT_COUNT; i++) {
    const id = `${THEME_SLOT_PREFIX}${i}`
    const entity = engine.addEntity()
    Transform.create(entity, {
      position: { ...THEME_PARK },
      scale: { x: 0.001, y: 0.001, z: 0.001 },
    })
    // No GltfContainer at boot — the roller creates a FRESH one on every
    // activation (delete-then-recreate forces the explorer to actually load the
    // new model; an in-place src swap does not reliably reload). Its componentId
    // is still registered for sync below so those later adds replicate.
    ClutterSync.create(entity, { itemId: id, isCleaned: true, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [Transform.componentId, GltfContainer.componentId, ClutterSync.componentId], enumId++)
    itemEntities.set(id, entity)
  }

  // ── Disaster spot stage entities ─────────────────────────────────────────────
  // One disaster per round max, as five sequential logical items at one spot:
  // three pile bits (quick clicks) → the stain beneath (hold + skill check) →
  // a polish pass (short hold, cash finale). Same server-owned CRDT visual
  // pattern as theme slots; the roller places them, cleanItem gates the order.
  const DISASTER_STAGE_MODELS: Record<string, string> = {
    pileA:  themeModelSrc('bigRubbishBag'),
    pileB:  themeModelSrc('bigRubbishBag'),
    pileC:  themeModelSrc('bigRubbishBag'),
    stain:  'assets/scene/Models/StickyPatchBB/StickyPatchBB.glb',
    polish: 'assets/scene/Models/StickyPatchB/StickyPatchB.glb',
  }
  for (const stage of DISASTER_STAGES) {
    const id = `${DISASTER_PREFIX}0_${stage}`
    const entity = engine.addEntity()
    Transform.create(entity, {
      position: { x: 8, y: -50, z: 8 },
      scale: { x: 0.001, y: 0.001, z: 0.001 },
    })
    ClutterSync.create(entity, { itemId: id, isCleaned: true, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [Transform.componentId, GltfContainer.componentId, ClutterSync.componentId], enumId++)
    itemEntities.set(id, entity)
  }
  const disasterStageCleaned = (stage: string): boolean => {
    const e = itemEntities.get(`${DISASTER_PREFIX}0_${stage}`)
    return e ? ClutterSync.getOrNull(e)?.isCleaned !== false : true
  }
  /** Order gate: piles anytime; the stain needs the pile gone; polish needs the stain gone. */
  function disasterStageUnlocked(itemId: string): boolean {
    const stage = itemId.slice(itemId.lastIndexOf('_') + 1)
    if (stage.startsWith('pile')) return true
    if (stage === 'stain')  return disasterStageCleaned('pileA') && disasterStageCleaned('pileB') && disasterStageCleaned('pileC')
    if (stage === 'polish') return disasterStageCleaned('stain')
    return false
  }

  const gameStateEntity = engine.addEntity()
  GameState.create(gameStateEntity, {
    phase: 'lobby',   // boot into the lobby; initRoundManager re-affirms this
    cleanedCount: 0,
    totalCount: itemEntities.size,
    secondsLeft: 0,
    roundNumber: 0,
    outcome: '',
    playersIn: 0,
    starting: false,
  })
  syncEntity(gameStateEntity, [GameState.componentId], enumId)

  // Restores original Transform scales for all scene items (called on round reset)
  function restoreSceneItemScales() {
    for (const [itemId, origScale] of sceneItemScales) {
      const e = itemEntities.get(itemId)
      if (!e) continue
      const tf = Transform.getMutableOrNull(e)
      if (tf) tf.scale = { x: origScale.x, y: origScale.y, z: origScale.z }
    }
  }

  initRoundManager(itemEntities, gameStateEntity, restoreSceneItemScales, itemCategoryFor, (itemId) => itemNames.get(itemId) ?? '')
  setStartHold(() => Date.now() < introHoldUntil)

  // Crew power = average total upgrade levels across the ACTIVE crew. Drives
  // respawn pace + demand (RoundManager) so a veteran's round stays as full as
  // a rookie's — their throughput grew, so the mess grows with it.
  function crewPowerNow(): number {
    let total = 0
    let n = 0
    for (const address of activePlayers) {
      const rec = getProgress(address)
      if (!rec) continue
      total += Object.values(rec.upgrades ?? {}).reduce((sum, lvl) => sum + (lvl ?? 0), 0)
      n++
    }
    return n === 0 ? 0 : total / n
  }
  setCrewPowerProvider(crewPowerNow)

  // Boot-race career restores (see playerProgress): the affected player — after
  // a republish, almost always the owner testing — gets their real career
  // pushed the moment the merge lands, plus fresh plates for everyone.
  setCareersRestoredHandler((addresses) => {
    for (const a of addresses) sendProgress(a)
    broadcastRanks()
  })

  // ── Themed spawn roller — called by RoundManager inside every round's mask ────
  // Parks all slots, then places countMin..countMax random models at anchors
  // sampled (without replacement) from the authored scene items' positions:
  // every anchor is a spot already validated by having an item placed there, so
  // random spawns can't land inside furniture. Small jitter + random yaw keep
  // repeat themes from looking identical.
  setThemeSpawnRoller((themeId) => {
    // Park everything and DELETE the GltfContainer — the explorer does not
    // reliably reload a GltfContainer whose src merely swaps in place (the bin
    // watchdog learned this the hard way: delete + recreate forces a fresh
    // load). Recreation happens a beat later, guaranteeing a tick boundary
    // between delete and create.
    for (let i = 0; i < THEME_SLOT_COUNT; i++) {
      const e = itemEntities.get(`${THEME_SLOT_PREFIX}${i}`)
      if (!e) continue
      if (GltfContainer.getOrNull(e)) GltfContainer.deleteFrom(e)
      const tf = Transform.getMutableOrNull(e)
      if (tf) {
        tf.position = { ...THEME_PARK }
        tf.scale    = { x: 0.001, y: 0.001, z: 0.001 }
      }
    }
    themeSlotModels.clear()
    themeSlotPositions.clear()

    // Park the disaster stages too — re-placed below when this round rolls one.
    for (const stage of DISASTER_STAGES) {
      const e = itemEntities.get(`${DISASTER_PREFIX}0_${stage}`)
      if (!e) continue
      if (GltfContainer.getOrNull(e)) GltfContainer.deleteFrom(e)
      const tf = Transform.getMutableOrNull(e)
      if (tf) {
        tf.position = { ...THEME_PARK }
        tf.scale    = { x: 0.001, y: 0.001, z: 0.001 }
      }
    }

    const def = THEME_DEFS.find((t) => t.id === themeId)
    const cfg = def?.spawns

    // Anchor pool, best spots first: positions of items this theme MASKS are
    // guaranteed empty this round (their item is absent), so extras land there
    // before doubling up on an occupied spot — pizzas take over the bar where
    // the glasses were. Full-mix themes have no freed spots and use everything.
    const shuffle = <T,>(arr: T[]): T[] => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    }
    // The roller runs immediately after the mask, so "this spot is free" is
    // simply "its item is already cleaned" — one source of truth that includes
    // the name-filtered rubbish, not a re-derivation of the mask rules.
    // Each anchor also carries whether its spot is TIGHT (glassware shelf /
    // table cluster) — only small models may land there.
    type Anchor = { x: number; y: number; z: number; tight: boolean; freed: boolean }
    const freed:    Anchor[] = []
    const occupied: Anchor[] = []
    for (const [itemId, pos] of sceneItemPositions) {
      const name  = itemNames.get(itemId) ?? ''
      const tight = TIGHT_ANCHOR_PARTS.some((p) => name.includes(p))
      const e = itemEntities.get(itemId)
      const isFreed = !!(e && ClutterSync.getOrNull(e)?.isCleaned)
      ;(isFreed ? freed : occupied).push({ ...pos, tight, freed: isFreed })
    }
    const anchors = [...shuffle(freed), ...shuffle(occupied)]

    // CH-scale rule: only models with a Creator Hub placement (= a known
    // authored scale) may spawn. Excluded ones were warned about at boot.
    const spawnable   = cfg ? cfg.models.filter((m) => themeModelScales.has(m)) : []
    const smallModels = spawnable.filter((m) => THEME_SMALL_MODELS.has(m))
    const count = !cfg ? 0 : Math.min(
      THEME_SLOT_COUNT,
      anchors.length,
      cfg.countMin + Math.floor(Math.random() * (cfg.countMax - cfg.countMin + 1)),
    )
    const ids: string[] = []
    const modelTally = new Map<string, number>()
    for (const a of anchors) {
      if (!cfg || ids.length >= count) break
      // Tight spot with no small model in this theme (pizza night, walkout):
      // skip it rather than clip a big model into a shelf.
      const pool = a.tight ? smallModels : spawnable
      if (pool.length === 0) continue
      const id = `${THEME_SLOT_PREFIX}${ids.length}`
      const entity = itemEntities.get(id)
      if (!entity) continue
      // FREED anchors are empty — spawn nearly on the spot (tight jitter; wide
      // scatter walked items off tables). OCCUPIED anchors still hold their
      // item, so the spawn lands in a ring BESIDE it — playtest: "multiple
      // items in the same spawn point" was spawns stacked inside base items on
      // full-mix themes, where no anchor is ever freed.
      const ang = Math.random() * Math.PI * 2
      const r   = a.freed ? Math.random() * 0.12 : 0.5 + Math.random() * 0.4
      const pos = {
        x: a.x + Math.cos(ang) * r,
        y: a.y,
        z: a.z + Math.sin(ang) * r,
      }
      const model = pool[Math.floor(Math.random() * pool.length)]
      Transform.createOrReplace(entity, {
        position: pos,
        rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0),
        // The model's own authored Creator Hub scale — guaranteed present, the
        // spawnable filter above excludes anything without one.
        scale: themeModelScales.get(model)!,
      })
      themeSlotModels.set(id, model)
      themeSlotPositions.set(id, pos)
      modelTally.set(model, (modelTally.get(model) ?? 0) + 1)
      ids.push(id)
    }
    // ── Disaster spot roll ──────────────────────────────────────────────────────
    // Always on the designated themes, a dice roll on classic rounds, never on
    // the warm-up. Takes an OPEN anchor from the BACK of the pool (theme spawns
    // fill from the front) so the two never fight over a spot.
    const disasterIds: string[] = []
    let disasterSpawned = false
    disasterThisRound = false
    // Disaster themes ALWAYS spawn one, round 0 included — a pinned walkout
    // test round must have its disaster (playtest: "didn't come across any
    // disaster zones" — every test was a fresh round 0). Only the classic
    // dice-roll skips the warm-up.
    const wantDisaster =
      DISASTER_THEMES.includes(themeId) ||
      (themeId === '' && getRoundNumber() > 0 && Math.random() < DISASTER_CHANCE_CLASSIC)
    const pileCH = themeModelScales.get('bigRubbishBag')
    if (wantDisaster && !pileCH) {
      console.log(`[SERVER] ⚠ disaster skipped — 'bigRubbishBag' has no Creator Hub placement for its scale`)
    }
    if (wantDisaster && pileCH) {
      const spot = [...anchors].reverse().find((a) => !a.tight)
      if (spot) {
        disasterSpawned    = true
        disasterThisRound  = true
        // Pile bits clustered around the spot at the bag's own CH scale (the
        // CH-scale rule — no tweaks); stain + polish AT it, hidden until their
        // stage unlocks (revealed by applyAcceptedClean).
        const layout: Record<string, { dx: number; dz: number; scale: number }> = {
          pileA:  { dx: -0.5,  dz: -0.3,  scale: pileCH.x },
          pileB:  { dx:  0.55, dz: -0.25, scale: pileCH.x },
          pileC:  { dx:  0,    dz:  0.55, scale: pileCH.x },
          stain:  { dx: 0, dz: 0, scale: 0.001 },
          polish: { dx: 0, dz: 0, scale: 0.001 },
        }
        for (const stage of DISASTER_STAGES) {
          const id = `${DISASTER_PREFIX}0_${stage}`
          const entity = itemEntities.get(id)
          if (!entity) continue
          const l = layout[stage]
          Transform.createOrReplace(entity, {
            position: { x: spot.x + l.dx, y: spot.y, z: spot.z + l.dz },
            rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0),
            scale:    { x: l.scale, y: l.scale, z: l.scale },
          })
          themeSlotPositions.set(id, { x: spot.x + l.dx, y: spot.y, z: spot.z + l.dz })
          disasterIds.push(id)
        }
        console.log(`[SERVER] disaster spot at (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)})`)
      }
    }

    // Fresh GltfContainers one beat after the deletes above — never a same-tick
    // src swap. The round-start intro holds for seconds, so the delay is unseen.
    setTimeout(() => {
      for (const id of ids) {
        const entity = itemEntities.get(id)
        const model  = themeSlotModels.get(id)
        if (!entity || !model) continue
        GltfContainer.createOrReplace(entity, { src: themeModelSrc(model), visibleMeshesCollisionMask: ColliderLayer.CL_POINTER })
      }
      if (disasterSpawned) {
        for (const stage of DISASTER_STAGES) {
          const entity = itemEntities.get(`${DISASTER_PREFIX}0_${stage}`)
          if (!entity) continue
          GltfContainer.createOrReplace(entity, { src: DISASTER_STAGE_MODELS[stage], visibleMeshesCollisionMask: ColliderLayer.CL_POINTER })
        }
      }
    }, 150)
    const tally = [...modelTally].map(([m, n]) => `${m}×${n}`).join(', ')
    console.log(`[SERVER] theme '${themeId}': ${ids.length} extras spawned (${tally})${disasterSpawned ? ' + 1 disaster' : ''}`)
    return [...ids, ...disasterIds]
  })

  // Kick off the progression read early so records are in memory before the first
  // shift ends. Failure is non-fatal: play continues, saves stay blocked.
  executeTask(async () => { await ensureProgressLoaded() })

  // ── Round start → promote everyone who signed up ────────────────────────────
  setRoundStartHandler((roundNumber) => {
    // A match started from the lobby enrols everyone present: they were already
    // gathered and pressed START, so asking them to sign up again would be busywork.
    if (roundNumber === 0) {
      for (const address of activeSessions) activePlayers.add(address)
    }
    for (const address of signedUp) activePlayers.add(address)
    signedUp.clear()

    // Fresh shift, empty hands, portable-bin uses restocked, empty bins and no
    // bags mid-haul — and tell everyone, so the carry chip resets immediately.
    carriedRubbish.clear()
    portableUsed.clear()
    binFill.general = 0
    binFill.recycle = 0
    // Any bin still in someone's hands snaps home for the fresh shift.
    for (const [, haul] of haulingBy) setBinAtStation(haul.binName, true)
    haulingBy.clear()
    streamHauler.clear()
    haulBonuses.clear()   // unbanked haul pay dies with the old round
    syncBinFull()
    for (const address of activeSessions) sendCarried(address)

    // Fresh contracts for everyone cleaning this round; spectators get none
    // (an empty send clears any stale contract chip on their HUD).
    contracts.clear()
    disasterBonuses.clear()   // unbanked finale bonuses die with the old round
    for (const address of activePlayers) contracts.set(address, rollContract())
    for (const address of activeSessions) sendContract(address)

    // Tell every known player where they stand — those promoted in, and those still
    // spectating, so a spectator's UI shows the sign-up prompt for the new round.
    for (const address of activeSessions) sendParticipation(address)
    console.log(`[PARTICIPATION] round ${roundNumber} — ${activePlayers.size} cleaning, ${activeSessions.size - activePlayers.size} spectating, crew power ${crewPowerNow().toFixed(1)}`)
  })

  // ── Shift complete → pay wages, award XP, persist ───────────────────────────
  // A completed round IS a shift. Rewards are derived entirely from the SERVER's
  // cleanliness count and its own contribution tally — nothing here trusts a value
  // that came from a client.
  // $ per second saved by an early 100% close. A strong crew closing ~30s early
  // earns ~$60 on top — meaningful, but below what the same time spent cleaning
  // a fuller club would pay, so it never beats actually having more to clean.
  const EARLY_CLOSE_RATE = 2

  setShiftCompleteHandler((cleanedFraction, contributions, playersPresent, earlyCloseSeconds) => {
    const grade = gradeFor(cleanedFraction)
    // Only players who actually cleaned something are paid; idling through a shift
    // earns nothing even though the club got cleaned around them.
    for (const [address, items] of contributions) {
      if (items <= 0) continue
      const others  = Math.max(0, playersPresent - 1)
      const rewards = shiftRewards(cleanedFraction, OUTCOME_ADEQUATE, others)
      let money = rewards.money
      let xp    = rewards.xp

      // Contract payout — validated against the server's own tally.
      const c = contracts.get(address)
      const contractDone = c !== undefined && c.progress >= c.target
      if (c && contractDone) { money += c.money; xp += c.xp }

      // Patron tip — a small variable reward, passed shifts only.
      let tip = 0
      if (rewards.passed && Math.random() < 0.4) {
        tip = 5 + Math.floor(Math.random() * 21)
        money += tip
      }

      // Early-close bonus — the crew hit 100% and closed the club ahead of the
      // clock; every contributor shares the same per-second rate.
      const earlyBonus = earlyCloseSeconds > 0 && rewards.passed
        ? earlyCloseSeconds * EARLY_CLOSE_RATE
        : 0
      money += earlyBonus

      // Disaster finale bonus — banked when this player landed the polish.
      const disasterBonus = disasterBonuses.get(address) ?? 0
      disasterBonuses.delete(address)
      money += disasterBonus

      // Dumpster runs — banked per haul during the round.
      const haulBonus = haulBonuses.get(address) ?? 0
      haulBonuses.delete(address)
      money += haulBonus

      const res = awardShift(address, money, xp, items, rewards.passed)
      sendProgress(address, {
        money,
        xp: res.xpApplied,
        passed: rewards.passed,
        items,
        grade,
        tip,
        earlyBonus,
        earlySeconds: earlyCloseSeconds,
        disasterBonus,
        haulBonus,
        contractLabel: c?.label ?? null,
        contractDone,
        contractBonus: contractDone && c ? c.money : 0,
        openingBonus: res.openingBonus,
        streakDays: res.streakDays,
        streakXp: res.streakXp,
        newBest: res.newBest,
      }, res.promotedTo)
      if (res.promotedTo) console.log(`[PROGRESS] ${address} promoted to ${res.promotedTo}`)
      // Poor-man's analytics — grep [METRICS] in server-logs for balance tuning.
      console.log(`[METRICS] shift: player=${address.slice(0, 8)} items=${items} clean=${Math.round(cleanedFraction * 100)}% passed=${rewards.passed} grade=${grade} contract=${contractDone} tip=$${tip} players=${playersPresent}`)
    }

    // Promotions land here, so refresh everyone's plates.
    broadcastRanks()

    // Earnings, rank and shift-count boards only change at shift end, so refresh
    // them here — the clean-driven debounce would otherwise leave three of the four
    // categories stale until someone happened to clean something.
    broadcastLeaderboard()

    // One write per document per shift end — the checkpoint granularity the
    // Storage guidance expects. Never per clean, never per burst.
    executeTask(async () => {
      await saveProgress()
      await saveLeaderboard()
      // Fresh save just happened (or just failed) — tell every admin panel.
      broadcastStorageStatus()
    })
  })

  // Career-storage health → clients (admin panel line). Broadcast is fine: the
  // payload is tiny and only admins render it.
  function broadcastStorageStatus(address?: string): void {
    const payload = { statusJson: JSON.stringify(progressStorageStatus()) }
    if (address) room.send('storageStatus', payload, { to: [address] })
    else room.send('storageStatus', payload)
  }

  // Load persisted leaderboard from Storage (async — data arrives soon after startup).
  // ensureLeaderboardLoaded() guarantees only one load ever runs, even if registerPlayer
  // fires concurrently before this completes.
  executeTask(async () => {
    await ensureLeaderboardLoaded()
  })

  // Track which session IDs are currently counted as "in scene".
  // Guards against double-counting when both onEnterSceneObservable AND
  // registerPlayer fire for the same player (the normal walk-in path), and
  // ensures teleport-in players (who skip the boundary event) are still counted
  // once registerPlayer arrives.
  // Players who vanished mid-shift while actively cleaning (reload, backgrounded
  // phone). If they come back inside the grace window they're re-enrolled instead
  // of being demoted to spectator — reported as "reloading the scene kicks you out
  // of the game". Coming back during an intermission queues them for the next
  // round via the normal signedUp path.
  const RECONNECT_GRACE_MS = 120_000
  const recentlyActive = new Map<string, number>()   // address → when they vanished

  function playerEntered(sessionId: string) {
    if (activeSessions.has(sessionId)) return
    activeSessions.add(sessionId)

    // Client playtest feedback: "didn't get time to read the full narrative
    // before the game started". A player on their FIRST-ever visit gets a
    // reading window: the lobby's auto-start waits INTRO_READ_HOLD_MS from
    // their arrival (veterans don't trigger it, START NOW bypasses it, and it
    // can't stack beyond the newest first-timer's window).
    try {
      if (getProgress(sessionId).shifts === 0) {
        introHoldUntil = Math.max(introHoldUntil, Date.now() + INTRO_READ_HOLD_MS)
        console.log(`[ROUND] first-time player ${sessionId} — holding auto-start for intro`)
      }
    } catch { /* guests without records just don't extend the hold */ }

    // Reconnect grace — HERE, on the universal entry path, not in registerPlayer.
    // registerPlayer fires once per client session, but a mobile app-switch
    // suspends the client WITHOUT reloading: heartbeats stop, the player is
    // counted out, and their resumed pings re-enter them through this function.
    // When the grace only lived in registerPlayer, such a player came back into
    // the room but never back into the shift, while their client still believed
    // it was active — every clean got cleanRejected, and scrubbed items snapped
    // back instantly in a loop.
    const vanishedAt = recentlyActive.get(sessionId)
    if (vanishedAt !== undefined) {
      recentlyActive.delete(sessionId)
      if (Date.now() - vanishedAt <= RECONNECT_GRACE_MS) {
        if (getPhase() === 'playing') activePlayers.add(sessionId)
        else signedUp.add(sessionId)
        console.log(`[PARTICIPATION] ${sessionId} returned within grace — re-enrolled`)
      }
    }
    // Always resync participation on entry — a suspended client's mirror is
    // stale in exactly the cases where it matters most.
    sendParticipation(sessionId)

    onPlayerEnter()
  }

  function playerLeft(sessionId: string) {
    if (!activeSessions.has(sessionId)) return
    activeSessions.delete(sessionId)
    // Drop participation, so the player isn't silently counted as cleaning while
    // gone — but remember active cleaners for the reconnect grace window.
    // carriedRubbish is deliberately KEPT: zeroing it here would make a reload a
    // free hands-empty (round start clears it anyway).
    if (activePlayers.has(sessionId)) recentlyActive.set(sessionId, Date.now())
    activePlayers.delete(sessionId)
    signedUp.delete(sessionId)
    contracts.delete(sessionId)
    // A hauler leaving puts the bin back at its station: anyone else can take
    // over (unlike carriedRubbish, keeping this would deadlock the stream —
    // the bin would be gone forever).
    const haul = haulingBy.get(sessionId)
    if (haul) {
      haulingBy.delete(sessionId)
      streamHauler.delete(haul.stream)
      setBinAtStation(haul.binName, true)
    }
    onPlayerLeave()
  }

  onEnterSceneObservable.add((player) => {
    heartbeat(player.userId)
  })

  // Leaves are deliberately NOT taken from onLeaveSceneObservable: on a scene
  // reload the stale leave for the dead connection can arrive AFTER the new
  // connection has re-registered, zeroing the count with the player still in the
  // club (blocks START MATCH; can yank a live round back to the lobby). And
  // presence can NOT be read from the engine's PlayerIdentityData either — the
  // server runtime does not reliably replicate player entities (detectGuest's
  // fallback exists for the same reason), so an engine-side scan reads empty and
  // would count everyone OUT.
  //
  // The one ground truth that provably reaches the server is the message channel
  // itself — the same transport every clean and purchase already rides on. So
  // presence is heartbeat-based: clients ping every ~5s (see leaderboardSystem),
  // any message refreshes its sender's lastSeen, and a player is only counted out
  // after PRESENCE_TIMEOUT_MS of silence. A reload never drops the count, because
  // the new connection pings under the same address well inside the window.
  const PRESENCE_POLL_MS    = 4_000
  const PRESENCE_TIMEOUT_MS = 30_000   // ~2.5 missed 12s heartbeats

  const lastSeen = new Map<string, number>()   // address → last message of any kind

  function heartbeat(address: string) {
    lastSeen.set(address, Date.now())
    playerEntered(address)   // no-op when already counted
  }

  setInterval(() => {
    const now = Date.now()
    for (const addr of [...activeSessions]) {
      const seen = lastSeen.get(addr)
      if (seen !== undefined && now - seen <= PRESENCE_TIMEOUT_MS) continue
      lastSeen.delete(addr)
      console.log(`[SERVER] presence: no heartbeat from ${addr} — counting out`)
      playerLeft(addr)
    }
  }, PRESENCE_POLL_MS)

  // Applies one ACCEPTED clean: flips the synced state, attributes the wage and
  // leaderboard credit, fills the cleaner's hands (rubbish), and schedules the
  // respawn. Shared by the direct click path and the vacuum sweep so the two can
  // never disagree about what "cleaned" means. Callers own sendCarried — one
  // update after the whole click (sweep included), not one per item.
  function applyAcceptedClean(address: string, itemId: string, entity: Entity): void {
    const cs = ClutterSync.getMutable(entity)
    cs.isCleaned = true
    cs.cleanedAt = Date.now()
    cs.cleanedBy = address

    // Attribute this clean to the player for end-of-shift wages. Counted here, at
    // the point the server ACCEPTS the clean, so respawns during the round can't
    // erase the credit.
    recordContribution(address)

    // Accepted carryable mess goes into the player's hands, in its stream's pouch.
    const stream = carryStreamFor(itemId)
    if (stream) getLoad(address)[stream]++

    // Advance the player's shift contract if this clean matches it.
    bumpContract(address, contractKindsFor(itemId))

    // Update all-time leaderboard score for this player.
    // Only runs after the leaderboard has loaded (leaderboardLoadPromise resolved).
    // scheduleLbUpdate() debounces rapid back-to-back saves — one disk write per burst.
    if (leaderboardLoadPromise !== null) {
      const entry = leaderboard.get(address)
      if (entry) {
        entry.total += 1
      } else {
        leaderboard.set(address, { displayName: address.slice(0, 8) + '…', total: 1 })
      }
      scheduleLbUpdate()
    }

    // Themed extras: hide server-side (CRDT propagates) and NEVER respawn —
    // clearing the party's mess is the shift, so it has to stay cleared.
    if (itemId.startsWith(THEME_SLOT_PREFIX)) {
      const tf = Transform.getMutableOrNull(entity)
      if (tf) tf.scale = { x: 0.001, y: 0.001, z: 0.001 }
      return
    }

    // Disaster stages: hide the cleaned stage, reveal the next one, and pay the
    // finale. No respawns — a disaster is cleared once.
    if (itemId.startsWith(DISASTER_PREFIX)) {
      const tf = Transform.getMutableOrNull(entity)
      if (tf) tf.scale = { x: 0.001, y: 0.001, z: 0.001 }
      const reveal = (stage: string) => {
        const e = itemEntities.get(`${DISASTER_PREFIX}0_${stage}`)
        const t = e && Transform.getMutableOrNull(e)
        if (t) t.scale = { x: 1, y: 1, z: 1 }
      }
      const stage = itemId.slice(itemId.lastIndexOf('_') + 1)
      if (stage.startsWith('pile') && disasterStageUnlocked(`${DISASTER_PREFIX}0_stain`)) {
        reveal('stain')
        console.log('[SERVER] disaster: pile cleared — stain revealed')
      } else if (stage === 'stain') {
        reveal('polish')
        console.log('[SERVER] disaster: stain mopped — polish revealed')
      } else if (stage === 'polish') {
        // Finale — the polisher's bonus is banked and paid through the shift
        // payout, so the report card itemises it and it flows through
        // awardShift like the tip and contract bonuses do.
        disasterBonuses.set(address, (disasterBonuses.get(address) ?? 0) + DISASTER_BONUS)
        console.log(`[SERVER] disaster CLEARED by ${address} — +$${DISASTER_BONUS} at shift end`)
      }
      return
    }

    const isSceneItem = SCENE_ITEM_PREFIXES.some(p => itemId.startsWith(p))
    if (isSceneItem) {
      // Hide the item by collapsing its scale — server is HOST so CRDT propagates to all clients
      const tf = Transform.getMutableOrNull(entity)
      if (tf) tf.scale = { x: 0.001, y: 0.001, z: 0.001 }
      // Decay: restore the item after CLUTTER_RESPAWN_MS, same as regular clutter.
      // The callback flips isCleaned and restores the original scale so clients
      // pick it up via ClutterSync and re-enable clicks automatically.
      onSceneItemCleaned(itemId, () => {
        const e = itemEntities.get(itemId)
        if (!e) return
        const cs2 = ClutterSync.getMutable(e)
        cs2.isCleaned = false
        cs2.cleanedAt = 0
        cs2.cleanedBy = ''
        const orig = sceneItemScales.get(itemId)
        if (orig) {
          const t2 = Transform.getMutableOrNull(e)
          if (t2) t2.scale = { x: orig.x, y: orig.y, z: orig.z }
        }
      })
    } else {
      const def = CLUTTER_DEFS.find(d => d.id === itemId)
      if (!def) {
        console.log(`[SERVER] cleanItem: unknown itemId '${itemId}' — skipped`)
        return
      }
      onItemCleaned(def)
    }
  }

  // Vacuum sweep: also clean up to `maxExtra` uncleaned rubbish pieces nearest to
  // the clicked item, never taking more than the player's remaining hand space.
  function sweepNearbyRubbish(address: string, aroundItemId: string, maxExtra: number): void {
    // Themed extras sweep like loose rubbish — a vacuum at a pizza party is the
    // upgrade's showcase moment.
    const centre = sceneItemPositions.get(aroundItemId) ?? themeSlotPositions.get(aroundItemId)
    if (!centre) return
    const space  = carryCapacityFor(address) - carriedTotal(address)
    const budget = Math.min(maxExtra, Math.max(0, space))
    if (budget <= 0) return

    const candidates: Array<{ itemId: string; entity: Entity; d2: number }> = []
    for (const [itemId, entity] of itemEntities) {
      if (!(itemId.startsWith(RUBBISH_ID_PREFIX) || themeSlotPositions.has(itemId)) || itemId === aroundItemId) continue
      if (ClutterSync.getOrNull(entity)?.isCleaned !== false) continue
      const p = sceneItemPositions.get(itemId) ?? themeSlotPositions.get(itemId)
      if (!p) continue
      const dx = p.x - centre.x, dy = p.y - centre.y, dz = p.z - centre.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 <= VACUUM_RADIUS_M * VACUUM_RADIUS_M) candidates.push({ itemId, entity, d2 })
    }
    candidates.sort((a, b) => a.d2 - b.d2)
    for (const c of candidates.slice(0, budget)) applyAcceptedClean(address, c.itemId, c.entity)
  }

  room.onMessage('cleanItem', (data, context) => {
    if (!context) return
    heartbeat(context.from)   // any message proves presence, not just pings
    if (getPhase() !== 'playing') {   // reject during lobby/countdown and intermission
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      return
    }
    // Spectators can watch but not clean. Enforced here rather than only in the
    // client's pointer gating, since a crafted message would bypass that entirely
    // and let a non-participant earn a wage.
    if (!activePlayers.has(context.from)) {
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      return
    }
    const entity = itemEntities.get(data.itemId)
    if (!entity || ClutterSync.getOrNull(entity)?.isCleaned) {
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      return
    }
    // Disaster stages clean IN ORDER — the stain is under the pile, the polish
    // needs a mopped surface. Locked stages are invisible client-side anyway;
    // this stops a crafted message skipping to the finale bonus.
    if (data.itemId.startsWith(DISASTER_PREFIX) && !disasterStageUnlocked(data.itemId)) {
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      return
    }
    // Carry gate — full hands can't pick up more carryable mess (rubbish, glasses,
    // bottles). The client pre-empts this with a toast + sound, but it's enforced
    // here so a crafted message can't ignore the capacity the upgrade is selling.
    // A hauled dumpster bag IS your hands — no pickups until it's emptied.
    const isCarryItem = carryStreamFor(data.itemId) !== null
    if (isCarryItem && (haulingBy.has(context.from) || carriedTotal(context.from) >= carryCapacityFor(context.from))) {
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      sendCarried(context.from)
      return
    }

    applyAcceptedClean(context.from, data.itemId, entity)

    if (isCarryItem) {
      // Vacuum sweeps loose rubbish and themed extras — glasses/bottles are
      // picked one by one.
      if (data.itemId.startsWith(RUBBISH_ID_PREFIX) || data.itemId.startsWith(THEME_SLOT_PREFIX)) {
        const extra = vacuumExtraFor(context.from)
        if (extra > 0) sweepNearbyRubbish(context.from, data.itemId, extra)
      }
      sendCarried(context.from)
    }
  })

  // Sent immediately on join (before getUserData) to wake a cold server, then
  // every ~5s as the presence heartbeat that keeps the sender counted in-scene.
  room.onMessage('ping', (_data, context) => {
    if (!context) return
    heartbeat(context.from)
  })

  room.onMessage('signUpNext', (_data, context) => {
    if (!context) return
    const address = context.from
    // Already cleaning — nothing to queue. Re-send so a stale client corrects itself.
    if (!activePlayers.has(address)) signedUp.add(address)
    sendParticipation(address)
  })

  room.onMessage('cancelSignUp', (_data, context) => {
    if (!context) return
    signedUp.delete(context.from)
    sendParticipation(context.from)
  })

  // Empty carried rubbish at a big rubbish bag. No phase or participation guard:
  // emptying is always safe (it only ever zeroes a count this server itself put
  // there), and a spectator's deposit is simply a no-op.
  // A bin only accepts its own stream — the general count survives a recycling
  // deposit and vice versa, which is what makes sorting a real decision.
  // GameState's bin-fill levels are owned here (RoundManager's sync only writes
  // the fields it knows, so these persist between its ticks). Levels, not
  // booleans: clients render the junk piling up and the pre-overflow stink.
  function syncBinFull(): void {
    const gs = GameState.getMutable(gameStateEntity)
    gs.binFillGeneral = binFill.general
    gs.binFillRecycle = binFill.recycle
  }

  room.onMessage('depositRubbish', (data, context) => {
    if (!context) return
    const stream: RubbishType = data.binType === 'recycle' ? 'recycle' : 'general'
    // Overflowed stream refuses deposits — the client pre-empts with a toast;
    // this resync corrects any stale client that sent anyway.
    if (binStreamFull(stream)) {
      sendCarried(context.from)
      return
    }
    const load = getLoad(context.from)
    // A real (non-empty) deposit advances the deposits contract.
    if (load[stream] > 0) {
      bumpContract(context.from, ['deposits'])
      binFill[stream] += load[stream]
      syncBinFull()   // every deposit — clients render the pile growing
      if (binStreamFull(stream)) {
        console.log(`[CARRY] ${stream} bins FULL (${binFill[stream]}) — haul needed`)
      }
    }
    load[stream] = 0
    sendCarried(context.from)
  })

  // Pick up an overflowing BIN. Empty hands only — the bin IS the load — and
  // one bin per stream at a time. The named bin vanishes from its station.
  room.onMessage('takeFullBag', (data, context) => {
    if (!context) return
    const address = context.from
    const stream: RubbishType = data.binType === 'recycle' ? 'recycle' : 'general'
    const bin = serverBins.get(data.binName)
    if (getPhase() !== 'playing' || !activePlayers.has(address)) return
    if (!bin || bin.type !== stream) { sendCarried(address); return }
    if (!binStreamFull(stream) || haulingBy.has(address) || streamHauler.has(stream)) {
      sendCarried(address)
      return
    }
    if (carriedTotal(address) > 0) { sendCarried(address); return }
    haulingBy.set(address, { stream, binName: data.binName, stage: 'out' })
    streamHauler.set(stream, address)
    setBinAtStation(data.binName, false)
    sendCarried(address)
    console.log(`[CARRY] ${address.slice(0, 8)} took bin '${data.binName}' — off to the dumpster`)
  })

  // Empty the hauled bin into a dumpster — the stream unlocks immediately
  // (other bins of the stream take deposits again), but the EMPTY bin is still
  // in hand: the return leg completes the trip and banks the bonus.
  room.onMessage('dumpsterEmpty', (_data, context) => {
    if (!context) return
    const address = context.from
    const haul = haulingBy.get(address)
    if (!haul || haul.stage !== 'out') { sendCarried(address); return }
    haul.stage = 'back'
    streamHauler.delete(haul.stream)
    binFill[haul.stream] = 0
    syncBinFull()
    bumpContract(address, ['deposits'])   // a dumpster run is the deposit of deposits
    sendCarried(address)
    console.log(`[CARRY] ${address.slice(0, 8)} emptied bin '${haul.binName}' — bringing it home`)
  })

  // Set the emptied bin back at its station — round trip complete, bonus banked.
  room.onMessage('returnBin', (_data, context) => {
    if (!context) return
    const address = context.from
    const haul = haulingBy.get(address)
    if (!haul || haul.stage !== 'back') { sendCarried(address); return }
    haulingBy.delete(address)
    setBinAtStation(haul.binName, true)
    haulBonuses.set(address, (haulBonuses.get(address) ?? 0) + HAUL_BONUS)
    sendCarried(address)
    console.log(`[CARRY] ${address.slice(0, 8)} returned bin '${haul.binName}' — +$${HAUL_BONUS} banked`)
  })

  // Portable Bin: empty on the spot, limited uses per shift. Both the level and
  // the remaining uses are validated here — the button is presentation only.
  // Empties BOTH streams: it's your own bin, sorting is somebody else's problem.
  room.onMessage('portableEmpty', (_data, context) => {
    if (!context) return
    const address = context.from
    if (carriedTotal(address) <= 0 || portableLeftFor(address) <= 0) {
      sendCarried(address)   // resync so a stale client button corrects itself
      return
    }
    portableUsed.set(address, (portableUsed.get(address) ?? 0) + 1)
    carriedRubbish.set(address, { general: 0, recycle: 0 })
    sendCarried(address)
  })

  room.onMessage('startNextRound', (_data, _context) => {
    onNextRoundRequest()
  })

  // Any player can start a match from the lobby (begins the shared countdown).
  room.onMessage('startMatch', (_data, _context) => {
    onStartMatch()
  })

  room.onMessage('registerPlayer', (data, context) => {
    if (!context) return
    const address = context.from

    // Fallback enter-trigger for players who teleport directly into the scene
    // and skip the parcel-boundary crossing that fires onEnterSceneObservable.
    heartbeat(address)   // covers reconnect-grace re-enrollment (see playerEntered)

    // Storage health for this joiner's admin panel (waits a beat so the load
    // has usually resolved a backend by the time it reports).
    executeTask(async () => {
      await ensureProgressLoaded().catch(() => {})
      broadcastStorageStatus(address)
    })

    executeTask(async () => {
      // ensureLeaderboardLoaded() returns the in-flight Promise if already loading,
      // so concurrent registerPlayer calls never start a second disk read.
      await ensureLeaderboardLoaded()
      const existing = leaderboard.get(address)
      if (existing) {
        existing.displayName = data.displayName
      } else {
        leaderboard.set(address, { displayName: data.displayName, total: 0 })
      }
      // NOTE: no save here on purpose. Writing the whole leaderboard on every join is
      // unnecessary churn and an extra wipe surface; the display name persists on the
      // player's next score change (scheduleLbUpdate). Just broadcast the current top-10.
      broadcastLeaderboard([address])

      // Career state, so the HUD shows the right title and balance from the moment
      // they arrive rather than only after their first shift ends.
      await ensureProgressLoaded()
      registerProgressPlayer(address, data.displayName)
      sendProgress(address)
      // Tells a joining player whether they're cleaning or spectating, which drives
      // the sign-up prompt on their first frame rather than after a round boundary.
      sendParticipation(address)
      // Carry state, so the HUD chip shows the right capacity from the first frame.
      sendCarried(address)
      // Everyone (including the joiner) needs the updated roster for plates.
      broadcastRanks()

      console.log(`[SERVER] registerPlayer: ${data.displayName} (${address})`)
    })
  })

  // Upgrade purchase. The client's shop is presentation only — cost, rank gate and
  // affordability are all re-checked here against the server's copy, so a crafted
  // message can't grant a level the player hasn't earned or paid for.
  room.onMessage('buyUpgrade', (data, context) => {
    if (!context) return
    const address = context.from
    executeTask(async () => {
      await ensureProgressLoaded()
      const result = purchaseUpgrade(address, data.upgradeId as UpgradeId)
      if (!result.ok) {
        console.log(`[PROGRESS] buyUpgrade refused (${result.reason}) for ${address}: ${data.upgradeId}`)
        sendProgress(address)   // resync so a stale client shop corrects itself
        return
      }
      console.log(`[PROGRESS] ${address} bought ${data.upgradeId} → level ${result.level}`)
      sendProgress(address)
      // Capacity changes the chip's denominator and a portable bin adds its button
      // immediately — resync the carry payload for both.
      if (data.upgradeId === 'carryCapacity' || data.upgradeId === 'portableBin') sendCarried(address)
      // Purchases are a checkpoint too: money left the wallet, and losing that to a
      // server shutdown would be worse than losing an unsaved shift.
      await saveProgress()
    })
  })

  room.onMessage('adminReset', (_data, context) => {
    if (!context) return
    if (!ADMIN_ADDRESSES.includes(context.from.toLowerCase())) {
      console.log(`[SERVER] adminReset rejected — not an admin: ${context.from}`)
      return
    }
    onAdminReset()
  })

  // Admin testing tool: grant yourself money / XP (drives the +$ / +rank buttons).
  room.onMessage('adminForceTheme', (data, context) => {
    if (!context) return
    if (!ADMIN_ADDRESSES.includes(context.from.toLowerCase())) {
      console.log(`[SERVER] adminForceTheme rejected — not an admin: ${context.from}`)
      return
    }
    // '' clears the pin (back to random); anything else must be a known theme.
    const valid = data.themeId === '' || THEME_DEFS.some((t) => t.id === data.themeId)
    if (!valid) {
      console.log(`[SERVER] adminForceTheme: unknown theme '${data.themeId}' — ignored`)
      return
    }
    setForcedTheme(data.themeId === '' ? null : (data.themeId as ThemeId))
    console.log(`[SERVER] adminForceTheme: ${data.themeId === '' ? 'cleared (random)' : `pinned '${data.themeId}'`} by ${context.from}`)
  })

  room.onMessage('adminGrant', (data, context) => {
    if (!context) return
    if (!ADMIN_ADDRESSES.includes(context.from.toLowerCase())) {
      console.log(`[SERVER] adminGrant rejected — not an admin: ${context.from}`)
      return
    }
    const address = context.from
    executeTask(async () => {
      await ensureProgressLoaded()
      const { promotedTo } = adminAdjust(address, data.money, data.xp)
      console.log(`[SERVER] adminGrant: +$${data.money} +${data.xp}xp → ${address}${promotedTo ? ` (${promotedTo})` : ''}`)
      sendProgress(address, undefined, promotedTo)
      broadcastRanks()   // an admin rank grant changes the plate
      await saveProgress()
    })
  })
}
