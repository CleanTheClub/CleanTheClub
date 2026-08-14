import { engine, Entity, Name, Transform, executeTask, GltfContainer, ColliderLayer } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { createPersistedDoc } from './persistence'
import { OUTCOME_OPTIMAL } from '../shared/config'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, ADMIN_ADDRESSES, ItemCategory, THEME_DEFS, ThemeId, THEME_SLOT_PREFIX, THEME_SLOT_COUNT, themeModelSrc, TIGHT_ANCHOR_PARTS, THEME_SMALL_MODELS, DISASTER_PREFIX, DISASTER_STAGES, DISASTER_CHANCE_CLASSIC, DISASTER_THEMES, DISASTER_BONUS, BIN_CAPACITY, HAUL_BONUS } from '../shared/config'
import { SCENE_ITEM_PREFIXES, RUBBISH_ID_PREFIX, GLASS_ID_PREFIX, BOTTLE_ID_PREFIX, STICKY_ID_PREFIX, RubbishType, classifyRubbish, discoverGlasses, discoverBottles, discoverRubbish, discoverStickyPatches } from '../shared/glassDiscovery'
import { initRoundManager, onItemCleaned, onSceneItemCleaned, onPlayerEnter, onPlayerLeave, onAdminReset, onStartMatch, getPhase, getRoundNumber, getTheme, recordContribution, setShiftCompleteHandler, setRoundStartHandler, setStartHold, getThemeContractKinds, setForcedTheme, setThemeSpawnRoller, setCrewPowerProvider, setSpawnInHandler } from './RoundManager'
import { OUTCOME_ADEQUATE } from '../shared/config'
import { shiftRewards, titleProgress, titleForXp, rankForXp, upgradeValue, carryGearModel, achievementStates, UpgradeId } from '../shared/progression'
import {
  ensureProgressLoaded, registerProgressPlayer, getProgress, peekProgress, awardShift,
  purchaseUpgrade, saveProgress, isGuestAddress, allProgressRecords, adminAdjust, todayStr,
  progressStorageStatus, setCareersRestoredHandler, bumpKindCount, setFlexGear,
} from './playerProgress'

// ── Leaderboard ───────────────────────────────────────────────
interface LeaderboardEntry { displayName: string; total: number }
const leaderboard = new Map<string, LeaderboardEntry>()  // address → entry

type LbRecord = { address: string; displayName: string; total: number }

// ONE persistence implementation for everything. The leaderboard predates
// createPersistedDoc and carried its own duplicate jsonbin/Storage backend —
// with weaker wipe guards, no write serialization and no status reporting.
// Same env vars (LEADERBOARD_BIN_ID/KEY) and same storage key, so this reads
// and writes the exact document it always did. The Worlds-storage history and
// backend selection rules live in persistence.ts.
const leaderboardDoc = createPersistedDoc<LbRecord[]>(
  'leaderboard',
  'LEADERBOARD',
  (records) => !records || records.length === 0,
)

let lbLoadStarted = false
let lbMergeDone = false
function ensureLeaderboardLoaded(): Promise<void> {
  lbLoadStarted = true
  return leaderboardDoc.ensureLoaded().then((stored) => {
    if (lbMergeDone) return
    lbMergeDone = true
    if (!stored) return
    for (const r of stored) {
      if (!r || typeof r.address !== 'string' || typeof r.total !== 'number') continue
      // Additive over any pre-load session entry (same boot race as careers):
      // cleans that landed before the read settled stack on the stored total
      // instead of being overwritten by it.
      const existing = leaderboard.get(r.address)
      leaderboard.set(r.address, {
        displayName: existing?.displayName || r.displayName || '',
        total: (existing?.total ?? 0) + Math.max(0, Math.floor(r.total)),
      })
    }
    console.log(`[SERVER] Loaded leaderboard: ${leaderboard.size} players`)
  })
}

async function saveLeaderboard(): Promise<void> {
  // Drop scoreless rows — registerPlayer creates an entry with total 0 for
  // everyone who walks in, so without this the document accumulates a record
  // per visitor rather than per player. Anyone who has cleaned even one item is
  // kept permanently; this only sheds rows that carry no information.
  const records = [...leaderboard.entries()]
    .filter(([, e]) => e.total > 0)
    .map(([address, e]) => ({ address, ...e }))
  // Unconfirmed-load and empty-document wipe guards, write serialization and
  // failure logging all live in the shared doc layer.
  await leaderboardDoc.save(records)
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
  // address rides along so clients can fetch profile portraits for the rows.
  entries:     Array<{ displayName: string; score: string; address: string }>
}

function buildCategories(): LbCategory[] {
  const progress = allProgressRecords().filter((r) => r.displayName)

  const topBy = <T extends { address: string },>(
    items: T[],
    value: (t: T) => number,
    label: (t: T) => string,
    format: (t: T) => string,
  ) =>
    items
      .filter((t) => value(t) > 0)   // an all-zero board reads as broken, not empty
      .sort((a, b) => value(b) - value(a))
      .slice(0, LB_TOP_N)
      .map((t) => ({ displayName: label(t), score: format(t), address: t.address }))

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
        [...leaderboard.entries()].map(([address, e]) => ({ address, ...e })),
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

// Top all-time cleaners WITH addresses — the wall-of-fame slots need the
// address to fetch each player's profile snapshot (categories carry names only,
// which is all the text board needs). Must match the client's SLOT_COUNT.
const PODIUM_N = 6

function podiumEntries(): Array<{ address: string; displayName: string; total: number }> {
  return [...leaderboard.entries()]
    .filter(([, e]) => e.total > 0 && e.displayName)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, PODIUM_N)
    .map(([address, e]) => ({ address, displayName: e.displayName, total: e.total }))
}

function leaderboardJson(): string {
  // Categories only — the client falls back to treating a bare array as the legacy
  // single-board shape, so an older client against a newer server still renders.
  return JSON.stringify({ categories: buildCategories(), podium: podiumEntries() })
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
    // Flex gear: what's equipped, plus live progress for the pedestals and the
    // payout card's achievement lines. Server-computed so the client renders
    // exactly what the server would accept.
    flexGear:     rec.flexGear ?? '',
    achievements: achievementStates(rec.kindCounts),
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
// Per-BIN deposit tally for the round, keyed by scene Name. Each of the 8 bins
// fills independently, so a full bin is a routing decision ("next station") or
// an invitation to haul it — never a hard stop. It used to be one counter per
// STREAM, which meant all 4 bins of that stream refused at once and only one
// player could hold the bag: a second player carrying that stream had no legal
// move at all until the hauler reached a dumpster (playtest 2026-08-11).
//
// The haul is a physical round trip: the clicked bin VANISHES from its station
// into the hauler's hands ('out'), is emptied at the dumpster (that bin resets
// to zero), then must be carried home ('back') — the bonus banks on return.
const binFill = new Map<string, number>()
type Haul = { stream: RubbishType; binName: string; stage: 'out' | 'back' }
const haulingBy    = new Map<string, Haul>()          // address → haul in progress
const binHauler    = new Map<string, string>()        // bin name → who took it
const haulBonuses  = new Map<string, number>()        // address → banked haul pay
const binFillOf   = (name: string): number  => binFill.get(name) ?? 0
const binIsFull   = (name: string): boolean => binFillOf(name) >= BIN_CAPACITY
// Scene bin models, discovered server-side so their Transforms can be hidden/
// restored authoritatively (CRDT propagates the vanish to every client).
const serverBins = new Map<string, { entity: Entity; type: RubbishType }>()

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
 * Lifetime-stat key for a cleaned item — normalized letters-only, so
 * 'Wine Glass_12' → 'wineglass' and 'pizza_4' → 'pizza'. Theme spawns key by
 * their MODEL ('pizza', 'brokenbottle'); disaster stages roll up under one key.
 * Granular on purpose: achievements later sum whichever keys they care about
 * ("pieces of pizza" = pizza + pizzaeaten).
 */
const statNorm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '')
function statKeyFor(itemId: string): string {
  if (itemId.startsWith(THEME_SLOT_PREFIX)) return statNorm(themeSlotModels.get(itemId) ?? 'themed')
  if (itemId.startsWith(DISASTER_PREFIX))  return 'disasterstage'
  const name = itemNames.get(itemId)
  return statNorm(name && name !== '' ? name : itemId)
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

function buildCarryPublic(address: string) {
  const load = carriedRubbish.get(address)
  return {
    address,
    total:       (load?.general ?? 0) + (load?.recycle ?? 0),
    capacity:    carryCapacityFor(address),
    hauling:     haulingBy.get(address)?.stream ?? '',
    haulStage:   haulingBy.get(address)?.stage ?? '',
    haulBinName: haulingBy.get(address)?.binName ?? '',
    gear:        (() => { const r = getProgress(address); return carryGearModel(r.upgrades, r.flexGear) })(),
  }
}

// Last broadcast public state per player. carryPublic goes to EVERY peer, and
// sendCarried also runs on reject/resync paths — without this cache one spammed
// no-op message per inbound (300/s allowed) became one room-wide broadcast,
// enough for a single hostile client to saturate every peer's receive budget.
const lastCarryPublicKey = new Map<string, string>()

/** Replay another player's current carry visual to one recipient (late join). */
function sendCarryPublicTo(subject: string, recipient: string): void {
  room.send('carryPublic', buildCarryPublic(subject), { to: [recipient] })
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
  // Public subset for everyone else — drives the box/bin on this player's
  // avatar as seen by OTHERS (the emote replicates via the platform; the prop
  // must be replicated by us). Broadcast only on CHANGE — the p2p resync above
  // is unconditional, but the room doesn't need to hear about no-ops.
  const pub = buildCarryPublic(address)
  const key = `${pub.total}|${pub.capacity}|${pub.hauling}|${pub.haulStage}|${pub.haulBinName}|${pub.gear}`
  if (lastCarryPublicKey.get(address) === key) return
  lastCarryPublicKey.set(address, key)
  room.send('carryPublic', pub)
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
  const roster: Array<{ a: string; n: string; t: string; r: number; c: number }> = []
  for (const address of activeSessions) {
    const rec = getProgress(address)
    if (!rec.displayName) continue   // name not known yet; the plate falls back
    roster.push({
      a: address.toLowerCase(),
      n: rec.displayName,
      t: titleForXp(rec.xp),
      r: rankForXp(rec.xp),
      // Cleaning this round — spectate uses this to point its camera at actual
      // cleaners rather than at other bystanders.
      c: activePlayers.has(address) ? 1 : 0,
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
  // Every hand-placed sample for theme spawn scales. `model` (GLB src basename)
  // is the reliable identity; `name` (entity Name) is the legacy fallback.
  const themeScaleSamples: Array<{ name: string; model?: string; cleanable: boolean; scale: { x: number; y: number; z: number } }> = []
  // Discovery-time positions of scene items, for the vacuum's proximity sweep.
  const sceneItemPositions = new Map<string, { x: number; y: number; z: number }>()
  let enumId = 1

  // CLUTTER_DEFS items — new entities created by the server
  for (const def of CLUTTER_DEFS) {
    const entity = engine.addEntity()
    ClutterSync.create(entity, { itemId: def.id, isCleaned: false })
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
    ClutterSync.create(syncEnt, { itemId, isCleaned: false })
    syncEntity(syncEnt, [ClutterSync.componentId], enumId++)
    itemEntities.set(itemId, syncEnt)

    const tf = Transform.getOrNull(entity)
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
      const s = (GltfContainer.getOrNull(entity)?.src ?? '').toLowerCase()
      themeScaleSamples.push({
        name:  sceneName,
        model: s.split('/').pop()?.replace('.glb', '').replace('.gltf', '') || undefined,
        cleanable: true,          // discovered inside a cleanable group
        scale: { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z },
      })
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
      cleanable: false,           // scenery / props that merely share the GLB
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
      // A spawn is a piece of MESS, so take its size from placements that are
      // themselves cleanable mess. Sampling every placement of the GLB was
      // deliberate (it catches a mis-named cleanable, e.g. the brokenGlass
      // placed as "Wine Glass_2"), but it also picks up scenery that merely
      // shares the model: 'Fixed View Camera' sits at the scene root at scale
      // 1 next to the rubbish camera at 0.5, and the median of those spawned
      // cameras at DOUBLE size (playtest: "a giant camera on lost property
      // night"). Scenery is still the fallback when a model has no cleanable
      // twin at all.
      const cleanableOnly = matches.filter((s) => s.cleanable)
      if (cleanableOnly.length > 0) matches = cleanableOnly
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
      report.push(`${model}=${themeModelScales.get(model)!.x.toFixed(2)}(CH×${matches.length}${matches.every((s) => s.cleanable) ? '' : ' scenery'})`)
    }
    console.log(`[SERVER] theme model scales: ${report.join(' ')}`)
  }

  // ── Bin models (server-side) — hauled bins vanish/return authoritatively ────
  for (const [entity] of engine.getEntitiesWith(Name)) {
    const n = Name.get(entity).value
    const t: RubbishType | null =
      n.startsWith('Bin_General') ? 'general' : n.startsWith('Bin_Recycling') ? 'recycle' : null
    if (!t) continue
    serverBins.set(n, { entity, type: t })
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
    ClutterSync.create(entity, { itemId: id, isCleaned: true })
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
    // StickyPatch (not the B stub — that GLB is a 160-byte empty file) so the
    // polish pass reads as a lighter patch than the BB stain it follows.
    polish: 'assets/scene/Models/StickyPatch/StickyPatch.glb',
  }
  for (const stage of DISASTER_STAGES) {
    const id = `${DISASTER_PREFIX}0_${stage}`
    const entity = engine.addEntity()
    Transform.create(entity, {
      position: { x: 8, y: -50, z: 8 },
      scale: { x: 0.001, y: 0.001, z: 0.001 },
    })
    ClutterSync.create(entity, { itemId: id, isCleaned: true })
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

  initRoundManager(itemEntities, gameStateEntity, itemCategoryFor, (itemId) => itemNames.get(itemId) ?? '')
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
  // Handle for the cross-tick GltfContainer recreate below. An aborted round
  // (admin reset, or a fast re-roll) used to leave the old timer in flight, so
  // it re-created models on slots the NEW roll had already parked — and two
  // rolls' timers could interleave on the same slot ids.
  let slotModelTimer: ReturnType<typeof setTimeout> | null = null

  setThemeSpawnRoller((themeId) => {
    if (slotModelTimer) { clearTimeout(slotModelTimer); slotModelTimer = null }
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
    slotModelTimer = setTimeout(() => {
      slotModelTimer = null
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
    binFill.clear()
    // Any bin still in someone's hands snaps home for the fresh shift — clients
    // restore station bins themselves from the carryPublic below going empty.
    haulingBy.clear()
    binHauler.clear()
    haulBonuses.clear()   // unbanked haul pay dies with the old round
    syncBinFull()
    for (const address of activeSessions) sendCarried(address)

    // Stale contracts vanish immediately (chips clear); fresh ones roll at the
    // spawn-in beat below, once the disaster roll has decided what's possible.
    contracts.clear()
    disasterBonuses.clear()   // unbanked finale bonuses die with the old round
    for (const address of activeSessions) sendContract(address)

    // Tell every known player where they stand — those promoted in, and those still
    // spectating, so a spectator's UI shows the sign-up prompt for the new round.
    // This runs AT the phase flip: delaying it to the spawn-in beat flashed the
    // spectate overlay at every enrolled player (live two-player test).
    for (const address of activeSessions) sendParticipation(address)
    // The active set just changed (sign-ups promoted in), so the roster's
    // cleaning flags are stale until rebroadcast — spectate cameras key off them.
    broadcastRanks()
    console.log(`[PARTICIPATION] round ${roundNumber} — ${activePlayers.size} cleaning, ${activeSessions.size - activePlayers.size} spectating, crew power ${crewPowerNow().toFixed(1)}`)
  })

  // ── Spawn-in complete → contracts roll (disaster availability now known) ─────
  setSpawnInHandler(() => {
    for (const address of activePlayers) contracts.set(address, rollContract())
    for (const address of activeSessions) sendContract(address)
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

      // Shift-type tally — 'shiftclassic', 'shiftpizzaparty', … (fuels
      // achievement gates like "work 10 cocktail nights").
      bumpKindCount(address, 'shift' + statNorm(getTheme() || 'classic'))

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

  // Career-storage health → the admin panel line. Sent only to admins actually
  // in the room — nobody else renders it, so a room-wide broadcast was noise.
  function broadcastStorageStatus(address?: string): void {
    const payload = { statusJson: JSON.stringify(progressStorageStatus()) }
    // Session ids may arrive mixed-case; ADMIN_ADDRESSES is lowercase.
    const to = address
      ? [address]
      : [...activeSessions].filter((s) => ADMIN_ADDRESSES.includes(s.toLowerCase()))
    if (to.length > 0) room.send('storageStatus', payload, { to })
  }

  // Load persisted leaderboard from Storage (async — data arrives soon after startup).
  // ensureLeaderboardLoaded() guarantees only one load ever runs, even if registerPlayer
  // fires concurrently before this completes. Failure is survivable (the board
  // just starts empty-looking and saves stay wipe-guarded) — never let the
  // rejection escape the task.
  executeTask(async () => {
    await ensureLeaderboardLoaded().catch((e) => {
      console.log('[SERVER] leaderboard boot load failed:', e)
    })
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
      // peek, not get: getProgress creates-on-read, and this presence path runs
      // for every session id that ever enters — each stub it created was a dead
      // row the boot-race merge then had to repair. No record = first-timer.
      if ((peekProgress(sessionId)?.shifts ?? 0) === 0) {
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
        // activePlayers changed mid-round → refresh the roster's cleaning
        // flags, or spectate cameras can't see the re-enrolled cleaner.
        broadcastRanks()
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
    const wasActive = activePlayers.has(sessionId)
    if (wasActive) recentlyActive.set(sessionId, Date.now())
    activePlayers.delete(sessionId)
    signedUp.delete(sessionId)
    contracts.delete(sessionId)
    // A cleaner leaving changes the roster's cleaning flags — keep spectate
    // target lists honest.
    if (wasActive) broadcastRanks()
    // A hauler leaving puts the bin back at its station: anyone else can take
    // over (unlike carriedRubbish, keeping this would deadlock the stream —
    // the bin would be gone forever).
    const haul = haulingBy.get(sessionId)
    if (haul) {
      haulingBy.delete(sessionId)
      binHauler.delete(haul.binName)
      // Broadcasts the cleared haul so every client restores the station bin.
      sendCarried(sessionId)
    }
    // Forget the last-broadcast carry key so a rejoin always re-announces.
    lastCarryPublicKey.delete(sessionId)
    onPlayerLeave()

    // Last player out → checkpoint. The runtime shuts the server down ~2min
    // after the club empties, and the next save moment (shift end) will never
    // come — without this, a mid-round purchase or admin grant made after the
    // previous checkpoint would evaporate (official guidance: save at
    // player-leave). saveProgress no-ops unless something is dirty.
    if (activeSessions.size === 0) {
      console.log('[SERVER] club empty — checkpoint save')
      executeTask(async () => {
        await saveProgress()
        await saveLeaderboard()
      })
    }
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
  // presence is heartbeat-based: clients ping every 12s (see leaderboardSystem),
  // any message refreshes its sender's lastSeen, and a player is only counted out
  // after PRESENCE_TIMEOUT_MS of silence. A reload never drops the count, because
  // the new connection pings under the same address well inside the window.
  //
  // BUDGET RULE: keep the timeout ≥5 missed pings. It was left at 30s when the
  // request diet moved pings from 5s to 12s — a budget of 2.5 pings, so one
  // alt-tab or app-switch counted a live player out. Solo, that emptied the
  // club → lobby → the next arrival auto-started a fresh round-0 that enrolled
  // everyone present — the "round restarts and the mid-round joiner can play"
  // playtest bug. The ping is a dt-accumulator: it stops whenever the client's
  // render loop stops, which backgrounded tabs and app-switches do routinely.
  const PRESENCE_POLL_MS    = 4_000
  const PRESENCE_TIMEOUT_MS = 60_000   // 5 missed 12s heartbeats

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
    ClutterSync.getMutable(entity).isCleaned = true

    // Attribute this clean to the player for end-of-shift wages. Counted here, at
    // the point the server ACCEPTS the clean, so respawns during the round can't
    // erase the credit.
    recordContribution(address)
    // Lifetime kind tally — achievement fuel ("clean 1000 pieces of pizza").
    bumpKindCount(address, statKeyFor(itemId))

    // Accepted carryable mess goes into the player's hands, in its stream's pouch.
    const stream = carryStreamFor(itemId)
    if (stream) getLoad(address)[stream]++

    // Advance the player's shift contract if this clean matches it.
    bumpContract(address, contractKindsFor(itemId))

    // Update all-time leaderboard score for this player.
    // Only runs once the leaderboard load has been kicked off.
    // scheduleLbUpdate() debounces rapid back-to-back saves — one disk write per burst.
    if (lbLoadStarted) {
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
        bumpKindCount(address, 'disastercleared')
        console.log(`[SERVER] disaster CLEARED by ${address} — +$${DISASTER_BONUS} at shift end`)
      }
      return
    }

    const isSceneItem = SCENE_ITEM_PREFIXES.some(p => itemId.startsWith(p))
    if (isSceneItem) {
      // Scene items sync a LOGICAL entity carrying only ClutterSync — visibility
      // is entirely client-side (each client hides/restores its own composite
      // copy from the isCleaned flag). The old Transform writes here targeted
      // the logical entity, which has no Transform: verified no-ops, deleted.
      onSceneItemCleaned(itemId, () => {
        const e = itemEntities.get(itemId)
        if (!e) return
        ClutterSync.getMutable(e).isCleaned = false
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

  // ── Per-sender action pacing ────────────────────────────────────────────────
  // The server never learns player positions (player entities don't replicate
  // to this runtime), so proximity checks are impossible — pacing is the
  // platform-compliant defence against scripted farming and message floods.
  // Floors sit ABOVE anything reachable in normal play (fast play peaks around
  // 4 accepted cleans/s) but far below the 300 msgs/s a hostile client may
  // send. Over-pace messages are dropped SILENTLY: replying to spam is how a
  // flood turns into amplified outbound traffic.
  // Also refreshes presence: any real message proves the player is here, which
  // stops deposit-only stretches from reading as a timeout mid-shift.
  const lastActionAt = new Map<string, number>()   // "address|action" → ms
  function paced(address: string, action: string, minIntervalMs: number): boolean {
    heartbeat(address)
    const key = `${address}|${action}`
    const now = Date.now()
    if (now - (lastActionAt.get(key) ?? 0) < minIntervalMs) return false
    lastActionAt.set(key, now)
    return true
  }

  // Purchases are checkpoints (money left the wallet), but a save PER purchase
  // was also an unthrottled backend PUT — enough spam could crowd the 40
  // in-flight host-call budget. Trailing debounce: the last purchase in a
  // burst triggers one save shortly after. Shift-end and empty-club
  // checkpoints still await their saves directly.
  let progressSaveTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleProgressSave(delayMs = 3_000): void {
    if (progressSaveTimer) clearTimeout(progressSaveTimer)
    progressSaveTimer = setTimeout(() => {
      progressSaveTimer = null
      executeTask(async () => { await saveProgress() })
    }, delayMs)
  }

  room.onMessage('cleanItem', (data, context) => {
    if (!context) return
    if (!paced(context.from, 'clean', 125)) return   // 8/s ceiling, silent
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
    if (!paced(address, 'signup', 500)) return
    // Already cleaning — nothing to queue. Re-send so a stale client corrects itself.
    if (!activePlayers.has(address)) signedUp.add(address)
    sendParticipation(address)
  })

  room.onMessage('cancelSignUp', (_data, context) => {
    if (!context) return
    if (!paced(context.from, 'signup', 500)) return
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
    // Only non-empty bins are listed — absent means zero.
    const packed = [...binFill.entries()]
      .filter(([, n]) => n > 0)
      .map(([name, n]) => `${name}:${n}`)
      .join(',')
    const gs = GameState.getMutable(gameStateEntity)
    if (gs.binFills !== packed) gs.binFills = packed
  }

  room.onMessage('depositRubbish', (data, context) => {
    if (!context) return
    if (!paced(context.from, 'deposit', 400)) return   // a real deposit needs a walk to the bin
    const stream: RubbishType = data.binType === 'recycle' ? 'recycle' : 'general'
    const bin = serverBins.get(data.binName)
    // Unknown bin, or wrong stream for it — resync and ignore.
    if (!bin || bin.type !== stream) { sendCarried(context.from); return }
    // THIS bin is full: the player takes its bag instead (takeFullBag). Other
    // bins of the same stream still accept, so nobody is ever stuck.
    if (binIsFull(data.binName)) { sendCarried(context.from); return }
    const load = getLoad(context.from)
    // A real (non-empty) deposit advances the deposits contract.
    if (load[stream] > 0) {
      bumpContract(context.from, ['deposits'])
      bumpKindCount(context.from, 'deposit')
      binFill.set(data.binName, binFillOf(data.binName) + load[stream])
      syncBinFull()   // every deposit — clients render the pile growing
      if (binIsFull(data.binName)) {
        console.log(`[CARRY] bin '${data.binName}' FULL (${binFillOf(data.binName)}) — haul available`)
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
    if (!paced(address, 'haul', 500)) return
    const stream: RubbishType = data.binType === 'recycle' ? 'recycle' : 'general'
    const bin = serverBins.get(data.binName)
    if (getPhase() !== 'playing' || !activePlayers.has(address)) return
    if (!bin || bin.type !== stream) { sendCarried(address); return }
    // That specific bin must be full and unclaimed; one haul per player.
    if (!binIsFull(data.binName) || haulingBy.has(address) || binHauler.has(data.binName)) {
      sendCarried(address)
      return
    }
    // Tip whatever is in the player's arms into the bag as they lift it.
    // Requiring EMPTY hands here DEADLOCKED the loop: a full bin refuses
    // deposits, so "hands full + bin full" left the player with no legal
    // action at all until the round ended (playtest 2026-08-11 — the bin just
    // blipped "nope"). The load is bound for the dumpster either way.
    const load = getLoad(address)
    if (load.general + load.recycle > 0) {
      load.general = 0
      load.recycle = 0
      // Stat only: the dumpster run already credits the deposits contract, so
      // crediting here too would pay one trip twice.
      bumpKindCount(address, 'deposit')
    }
    haulingBy.set(address, { stream, binName: data.binName, stage: 'out' })
    binHauler.set(data.binName, address)
    sendCarried(address)
    console.log(`[CARRY] ${address.slice(0, 8)} took bin '${data.binName}' — off to the dumpster`)
  })

  // Empty the hauled bin into a dumpster — the stream unlocks immediately
  // (other bins of the stream take deposits again), but the EMPTY bin is still
  // in hand: the return leg completes the trip and banks the bonus.
  room.onMessage('dumpsterEmpty', (_data, context) => {
    if (!context) return
    const address = context.from
    if (!paced(address, 'haul', 500)) return
    const haul = haulingBy.get(address)
    if (!haul || haul.stage !== 'out') {
      console.log(`[CARRY] dumpsterEmpty REFUSED for ${address.slice(0, 8)} — ${!haul ? 'no haul in progress' : `stage is '${haul.stage}', expected 'out'`}`)
      sendCarried(address); return
    }
    haul.stage = 'back'
    binHauler.delete(haul.binName)
    binFill.set(haul.binName, 0)
    syncBinFull()
    bumpContract(address, ['deposits'])   // a dumpster run is the deposit of deposits
    sendCarried(address)
    console.log(`[CARRY] ${address.slice(0, 8)} emptied bin '${haul.binName}' — bringing it home`)
  })

  // Set the emptied bin back at its station — round trip complete, bonus banked.
  room.onMessage('returnBin', (_data, context) => {
    if (!context) return
    const address = context.from
    if (!paced(address, 'haul', 500)) return
    const haul = haulingBy.get(address)
    if (!haul || haul.stage !== 'back') {
      console.log(`[CARRY] returnBin REFUSED for ${address.slice(0, 8)} — ${!haul ? 'no haul in progress' : `stage is '${haul.stage}', expected 'back'`}`)
      sendCarried(address); return
    }
    haulingBy.delete(address)
    haulBonuses.set(address, (haulBonuses.get(address) ?? 0) + HAUL_BONUS)
    bumpKindCount(address, 'haulcompleted')
    sendCarried(address)
    console.log(`[CARRY] ${address.slice(0, 8)} returned bin '${haul.binName}' — +$${HAUL_BONUS} banked`)
  })

  // Portable Bin: empty on the spot, limited uses per shift. Both the level and
  // the remaining uses are validated here — the button is presentation only.
  // Empties BOTH streams: it's your own bin, sorting is somebody else's problem.
  room.onMessage('portableEmpty', (_data, context) => {
    if (!context) return
    const address = context.from
    if (!paced(address, 'portable', 500)) return
    if (carriedTotal(address) <= 0 || portableLeftFor(address) <= 0) {
      sendCarried(address)   // resync so a stale client button corrects itself
      return
    }
    portableUsed.set(address, (portableUsed.get(address) ?? 0) + 1)
    carriedRubbish.set(address, { general: 0, recycle: 0 })
    bumpKindCount(address, 'portableempty')
    sendCarried(address)
  })

  // Any player can start a match from the lobby (begins the shared countdown).
  room.onMessage('startMatch', (_data, context) => {
    if (!context) return
    if (!paced(context.from, 'start', 1_000)) return
    // Log rejected presses: a START pressed mid-round (a joiner's pre-sync UI
    // used to offer one) was silently swallowed, leaving no trace to debug by.
    if (getPhase() !== 'lobby') {
      console.log(`[SERVER] startMatch from ${context.from.slice(0, 8)} ignored — phase '${getPhase()}'`)
      return
    }
    onStartMatch()
  })

  // Names come from the client and are re-broadcast to every peer (ranksUpdate,
  // leaderboardUpdate) AND persisted — an unbounded string here can breach the
  // ~13KB synced-message cap for the whole room and bloat the stored doc, so
  // cap length and strip control characters before the name touches anything.
  const MAX_NAME_LEN = 24
  const sanitizeDisplayName = (raw: unknown): string => {
    const cleaned = String(raw ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_NAME_LEN)
    return cleaned.length > 0 ? cleaned : 'Cleaner'
  }

  room.onMessage('registerPlayer', (data, context) => {
    if (!context) return
    const address = context.from
    if (!paced(address, 'register', 1_500)) return   // also blocks rename spam
    const displayName = sanitizeDisplayName(data.displayName)

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
      // The leaderboard is decoration — a failed read must never block the
      // career path below. ensureLeaderboardLoaded() caches a REJECTED promise
      // after its retry window, so an unguarded await here used to kill every
      // subsequent join (no career, no participation, no carry chip) for the
      // server's whole lifetime after one bad read.
      try {
        // ensureLeaderboardLoaded() returns the in-flight Promise if already loading,
        // so concurrent registerPlayer calls never start a second disk read.
        await ensureLeaderboardLoaded()
        const existing = leaderboard.get(address)
        if (existing) {
          existing.displayName = displayName
        } else {
          leaderboard.set(address, { displayName, total: 0 })
        }
        // NOTE: no save here on purpose. Writing the whole leaderboard on every join is
        // unnecessary churn and an extra wipe surface; the display name persists on the
        // player's next score change (scheduleLbUpdate). Just broadcast the current top-10.
        broadcastLeaderboard([address])
      } catch (e) {
        console.log(`[LB] load failed during registerPlayer — joining without leaderboard: ${e}`)
      }

      // Career state, so the HUD shows the right title and balance from the moment
      // they arrive rather than only after their first shift ends. A failed load
      // degrades to a session-only career (the wipe guards already prevent an
      // unconfirmed session from overwriting the stored doc).
      await ensureProgressLoaded().catch(() => {})
      registerProgressPlayer(address, displayName)
      sendProgress(address)
      // Tells a joining player whether they're cleaning or spectating, which drives
      // the sign-up prompt on their first frame rather than after a round boundary.
      sendParticipation(address)
      // Carry state, so the HUD chip shows the right capacity from the first frame.
      sendCarried(address)
      // carryPublic now only broadcasts on CHANGE, so a late joiner would miss
      // everyone's standing carry visuals (a full box, a bin mid-haul) until
      // the next pickup. Replay the room's current state to the newcomer.
      for (const other of activeSessions) {
        if (other !== address) sendCarryPublicTo(other, address)
      }
      // Everyone (including the joiner) needs the updated roster for plates.
      broadcastRanks()

      console.log(`[SERVER] registerPlayer: ${displayName} (${address})`)
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
      // All three drive the visible GEAR ladder (and the first two also change
      // the HUD chip), so each needs a carry resync — carryPublic.gear is what
      // tells every other client which prop to put in this player's hands.
      if (data.upgradeId === 'carryCapacity' || data.upgradeId === 'portableBin'
          || data.upgradeId === 'vacuum') sendCarried(address)
      // Purchases are a checkpoint too: money left the wallet, and losing that to a
      // server shutdown would be worse than losing an unsaved shift.
      scheduleProgressSave()
    })
  })

  room.onMessage('equipGear', (data, context) => {
    if (!context) return
    const address = context.from
    if (!paced(address, 'equip', 500)) return
    executeTask(async () => {
      await ensureProgressLoaded().catch(() => {})
      const ok = setFlexGear(address, data.gear)
      if (!ok) console.log(`[GEAR] equip refused for ${address.slice(0, 8)}: '${data.gear}'`)
      // Refresh either way — a refused equip resyncs the truthful state, an
      // accepted one updates the pedestals, payout lines and everyone's view
      // of this player's hands.
      sendProgress(address)
      sendCarried(address)
      if (ok) scheduleProgressSave()
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
      scheduleProgressSave()
    })
  })
}
