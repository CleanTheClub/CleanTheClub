import { Entity } from '@dcl/sdk/ecs'
import { ClutterSync, GameState } from '../shared/schemas'
import { RUBBISH_ID_PREFIX } from '../shared/glassDiscovery'
import {
  CLUTTER_DEFS,
  ROUND_DURATIONS_MS, OPEN_DISPLAY_MS, FINALE_DISPLAY_MS, MILESTONE_EVERY,
  CLUTTER_RESPAWN_MS, FAST_RESPAWN_MS, RESPAWN_SCALE_FACTORS, RESPAWN_CUTOFF_FRACTION,
  DEMAND_FACTORS,
  OUTCOME_OPTIMAL, OUTCOME_ADEQUATE,
  THEME_DEFS, THEME_CHANCE, ThemeId, ItemCategory, THEME_SLOT_PREFIX, DISASTER_PREFIX,
  RESPAWN_POWER_PER_LEVEL, DEMAND_POWER_PER_LEVEL,
} from '../shared/config'

export type Phase   = 'lobby' | 'playing' | 'open'
export type Outcome = '' | 'perfect' | 'optimal' | 'adequate' | 'suboptimal'

// Pre-match countdown after a player presses START in the lobby.
const LOBBY_COUNTDOWN_MS = 5_000

let itemEntities:    Map<string, Entity>
let gameStateEntity: Entity
let phase:        Phase   = 'lobby'
let roundNumber:  number  = 0
let roundStartMs  = 0
let openStartMs   = 0
let playerCount   = 0
let currentOutcome: Outcome = ''

// Lobby pre-match countdown state.
let starting = false
let startCountdownStartMs = 0
let startCountdownTimer: ReturnType<typeof setTimeout> | null = null

// True during the open phase that follows the FINAL round — the "victory hold".
// Triggers a longer celebration window and signals clients to show the finale
// ('Club Complete!') messaging.  The next round loops back to round 0.
let isFinale = false

// ── Themed rounds ─────────────────────────────────────────────────────────────
// The server rolls a theme per round; excluded item categories start the round
// PRE-CLEANED (isCleaned=true), which hides them on every client through the
// same path a player-clean does. Demand and the cleaned count are then measured
// against the ACTIVE set only, so a themed round doesn't open at "40% clean".
let currentTheme: ThemeId = ''
let lastThemeId:  ThemeId = ''   // no theme twice in a row
// itemIds that are IN the current round. Empty set = classic round, everything active.
const activeItems = new Set<string>()
// itemId → category, installed by server.ts (it owns the discovery/stream maps).
let categoryFor: ((itemId: string) => ItemCategory) | undefined
// itemId → lowercase scene Name, for keepRubbishNames (also from server.ts).
let nameFor: ((itemId: string) => string) | undefined

export function getTheme(): ThemeId { return currentTheme }

/** Contract kinds allowed this round, or null for the full pool. */
export function getThemeContractKinds(): string[] | null {
  const def = THEME_DEFS.find((t) => t.id === currentTheme)
  return def?.contractKinds ?? null
}

function isActiveItem(id: string): boolean {
  return activeItems.size === 0 || activeItems.has(id)
}

// Admin testing pin — while set, every round rolls this theme (round 0 included,
// so a tester doesn't have to sit through the warm-up). null = normal rolling.
let forcedTheme: ThemeId | null = null
export function setForcedTheme(id: ThemeId | null): void { forcedTheme = id }

function rollTheme(): ThemeId {
  if (forcedTheme !== null) return forcedTheme
  // Warm-up round teaches the full loop; themes need the categoriser installed.
  if (roundNumber === 0 || !categoryFor) return ''
  // BOSS ROUND: every milestone round is Spring Cleaning — the whole club
  // needs mopping. Pinned to milestones, and excluded from the random pool
  // below so it stays a rhythm the crew can feel coming.
  if (isMilestoneRound(roundNumber)) return 'springCleaning'
  if (Math.random() >= THEME_CHANCE) return ''
  const pool = THEME_DEFS.filter((t) => t.id !== lastThemeId && t.id !== 'springCleaning')
  return pool[Math.floor(Math.random() * pool.length)].id
}

// Rolls this round's themed extra spawns, installed by server.ts (it owns the
// positions/models). Parks every slot, wakes the chosen ones, returns their ids.
let rollThemeSpawns: ((theme: ThemeId) => string[]) | undefined
export function setThemeSpawnRoller(fn: (theme: ThemeId) => string[]): void {
  rollThemeSpawns = fn
}

// Pre-clean every item OUTSIDE the theme's categories, park/activate the theme
// spawn slots, and build the round's ACTIVE set. Runs after resetClutter, which
// just un-cleaned the whole scene (slots included — they are re-masked here).
function applyThemeMask(): void {
  activeItems.clear()
  const def  = THEME_DEFS.find((t) => t.id === currentTheme)
  const cats = def?.categories ?? null
  let masked = 0
  for (const [id, entity] of itemEntities) {
    // Spawn slots AND disaster stages are dormant unless the roller wakes them
    // below — letting a disaster id fall through to the category branch would
    // add five phantom items to demand on rounds with no disaster.
    if (id.startsWith(THEME_SLOT_PREFIX) || id.startsWith(DISASTER_PREFIX)) {
      ClutterSync.getMutable(entity).isCleaned = true
      continue
    }
    // Base rubbish faces the theme's name filter when it has one — "general"
    // is too coarse a category to keep ties out of the pizza party. Everything
    // else (sticky, glasses, resets) is governed by categories alone.
    let inRound: boolean
    if (cats === null) {
      inRound = true
    } else if (def?.keepRubbishNames && id.startsWith(RUBBISH_ID_PREFIX)) {
      const name = nameFor?.(id) ?? ''
      inRound = def.keepRubbishNames.some((frag) => name.includes(frag))
    } else {
      inRound = !categoryFor || cats.includes(categoryFor(id))
    }
    if (inRound) {
      activeItems.add(id)
    } else {
      ClutterSync.getMutable(entity).isCleaned = true
      masked++
    }
  }
  // Themed extras — the roller places models at sampled anchors and reports
  // which slots are live this round; they count toward demand like any item.
  for (const id of rollThemeSpawns?.(currentTheme) ?? []) {
    const entity = itemEntities.get(id)
    if (!entity) continue
    ClutterSync.getMutable(entity).isCleaned = false
    activeItems.add(id)
  }
  if (currentTheme !== '') {
    console.log(`[ROUND] Theme '${currentTheme}' — ${activeItems.size} items in, ${masked} masked`)
  }
}

// Guards against double-triggering the next round during the open phase
let nextRoundTriggered = false

// ── Last call — early close on 100% ───────────────────────────────────────────
// When the crew hits 100% with time to spare, the round ends after a short
// grace window instead of idling out the clock (the pattern completion-driven
// games use: done IS the climax). The seconds saved become an early-close
// bonus, so mastery is paid rather than just skipped past.
const LAST_CALL_MS = 10_000
let lastCallStartMs = 0   // 0 = not in last call
let earlyCloseS     = 0   // full seconds saved off the round clock, for the bonus

function startLastCall(): void {
  const remainingMs = getRoundDurationMs() - (Date.now() - roundStartMs)
  // Inside the natural final stretch anyway — let the clock finish normally.
  if (remainingMs <= LAST_CALL_MS) return
  earlyCloseS     = Math.floor((remainingMs - LAST_CALL_MS) / 1000)
  lastCallStartMs = Date.now()
  clearAllRespawns()   // nothing may reappear during the victory lap
  if (roundTimer) clearTimeout(roundTimer)
  roundTimer = setTimeout(triggerOpen, LAST_CALL_MS)
  syncGameState()
  console.log(`[ROUND] LAST CALL — 100% with ${earlyCloseS + LAST_CALL_MS / 1000}s left; closing in ${LAST_CALL_MS / 1000}s`)
}

let roundTimer: ReturnType<typeof setTimeout> | null = null
const respawnTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ── Per-shift contribution tally ──────────────────────────────────────────────
// address → items cleaned during the CURRENT round. Counted incrementally rather
// than tallied from ClutterSync at round end, because items respawn mid-round —
// a snapshot at the end would undercount badly.
const roundContributions = new Map<string, number>()

/** Called by the server for every accepted clean, to attribute it to a player. */
export function recordContribution(address: string): void {
  if (phase !== 'playing' || !address) return
  roundContributions.set(address, (roundContributions.get(address) ?? 0) + 1)
}

// Fired when a round (= a shift) completes, with the final cleanliness fraction,
// a copy of the contribution tally, and how many players were present.
type ShiftCompleteHandler = (
  cleanedFraction: number,
  contributions: Map<string, number>,
  playersPresent: number,
  /** Seconds saved off the round clock by an early 100% close (0 = full round). */
  earlyCloseSeconds: number,
) => void
let onShiftComplete: ShiftCompleteHandler | undefined
export function setShiftCompleteHandler(h: ShiftCompleteHandler): void {
  onShiftComplete = h
}

// Fired the moment a new round begins — the point at which players who signed up
// during the previous intermission are promoted into the shift.
type RoundStartHandler = (roundNumber: number) => void
let onRoundStart: RoundStartHandler | undefined
export function setRoundStartHandler(h: RoundStartHandler): void {
  onRoundStart = h
}

// Fired when the spawn-in beat completes (mess + theme mask applied). Contracts
// roll HERE, not at round start — they filter by the disaster availability the
// spawn roller decides. Participation must NOT wait for this: promoting players
// 2.6s late flashed the spectate overlay at every enrolled player (live test).
type SpawnInHandler = (roundNumber: number) => void
let onSpawnIn: SpawnInHandler | undefined
export function setSpawnInHandler(h: SpawnInHandler): void {
  onSpawnIn = h
}

export function getPhase():       Phase  { return phase }
export function getRoundNumber(): number { return roundNumber }

function getRoundDurationMs(): number {
  return ROUND_DURATIONS_MS[Math.min(roundNumber, ROUND_DURATIONS_MS.length - 1)]
}

// ── Endless rounds (V2) ───────────────────────────────────────────────────────
// Rounds no longer stop at five. Every MILESTONE_EVERY-th round is a MILESTONE
// that keeps the celebration hold as a payoff beat, but play then continues into
// the next round instead of returning to the lobby.

// True on the last round of each milestone cycle (round 4, 9, 14, ... 0-indexed).
function isMilestoneRound(n: number): boolean {
  return (n + 1) % MILESTONE_EVERY === 0
}

// Active open-phase display window — longer for the finale victory hold.
function openDisplayMs(): number {
  return isFinale ? FINALE_DISPLAY_MS : OPEN_DISPLAY_MS
}

// How many cleaned items count as "the whole job" for the current headcount.
// Measured against the theme's ACTIVE set — masked items are neither demanded
// nor counted, or a themed round would open already part-"cleaned".
function activeItemCount(): number {
  return activeItems.size === 0 ? itemEntities.size : activeItems.size
}

// Average total upgrade levels across the active crew — installed by server.ts
// (it owns the progress records). 0 until installed / when nobody is cleaning.
let crewPower: (() => number) | undefined
export function setCrewPowerProvider(fn: () => number): void { crewPower = fn }

function demandedTotal(): number {
  const idx = Math.min(Math.max(playerCount - 1, 0), DEMAND_FACTORS.length - 1)
  // Crew-power scaling: a stronger crew is asked for more — but never more than
  // the round actually contains, and at half the slope of the respawn scaling
  // so upgrades stay a net gain (see config).
  const power  = crewPower?.() ?? 0
  const scaled = Math.round(activeItemCount() * DEMAND_FACTORS[idx] * (1 + DEMAND_POWER_PER_LEVEL * power))
  return Math.max(1, Math.min(activeItemCount(), scaled))
}

function countCleaned(): number {
  let n = 0
  for (const [id, e] of itemEntities) {
    if (isActiveItem(id) && ClutterSync.get(e).isCleaned) n++
  }
  return n
}

function computeOutcome(pct: number): Outcome {
  if (pct >= 1.0)              return 'perfect'
  if (pct >= OUTCOME_OPTIMAL)  return 'optimal'
  if (pct >= OUTCOME_ADEQUATE) return 'adequate'
  return 'suboptimal'
}

function syncGameState() {
  const now = Date.now()
  // Demand-scaled: clients render cleaned/total directly, so shipping the
  // scaled total here tunes every display and consequence at once. Cleaned is
  // capped so the bar can't read past 100% on an over-delivering solo shift.
  const demanded  = demandedTotal()
  // During the spawn-in beat everything is hidden — an empty club would read
  // as 100% clean and flash the bar full for the roulette's duration.
  const cleaned = spawningIn ? 0 : Math.min(countCleaned(), demanded)
  const secondsLeft = phase === 'playing'
    ? lastCallStartMs > 0
      ? Math.max(0, Math.ceil((LAST_CALL_MS - (now - lastCallStartMs)) / 1000))   // last-call countdown
      : roundStartMs === 0
      ? Math.ceil(getRoundDurationMs() / 1000)   // timer not yet started — show full duration
      : Math.max(0, Math.ceil((getRoundDurationMs() - (now - roundStartMs)) / 1000))
    : phase === 'open'
    ? Math.max(0, Math.ceil((openDisplayMs() - (now - openStartMs)) / 1000))
    : phase === 'lobby' && starting
    ? Math.max(0, Math.ceil((LOBBY_COUNTDOWN_MS - (now - startCountdownStartMs)) / 1000))
    : 0
  const lastCall = lastCallStartMs > 0

  // Diff before touching the mutable view: getMutable marks the component dirty
  // and re-broadcasts the FULL GameState to every peer even when nothing changed.
  // This runs on a 1s interval for the server's whole life (plus every accepted
  // clean), so the no-change case is the common one — an idle lobby used to
  // re-broadcast identical state once a second forever.
  // (binFills is owned by syncBinFull, not compared here.)
  const cur = GameState.get(gameStateEntity)
  if (cur.phase === phase && cur.cleanedCount === cleaned && cur.totalCount === demanded
      && cur.secondsLeft === secondsLeft && cur.roundNumber === roundNumber
      && cur.outcome === currentOutcome && cur.isFinale === isFinale
      && cur.playersIn === playerCount && cur.starting === starting
      && cur.theme === currentTheme && cur.lastCall === lastCall) return

  const gs = GameState.getMutable(gameStateEntity)
  gs.phase         = phase
  gs.cleanedCount  = cleaned
  gs.totalCount    = demanded
  gs.secondsLeft   = secondsLeft
  gs.roundNumber   = roundNumber
  gs.outcome       = currentOutcome
  gs.isFinale      = isFinale
  gs.playersIn     = playerCount
  gs.starting      = starting
  gs.theme         = currentTheme
  gs.lastCall      = lastCall
}

function clearAllRespawns() {
  for (const [id, t] of respawnTimers) { clearTimeout(t); respawnTimers.delete(id) }
}

function resetClutter() {
  for (const [, entity] of itemEntities) {
    ClutterSync.getMutable(entity).isCleaned = false
  }
}

// ── Spawn-in beat ─────────────────────────────────────────────────────────────
// A round opens on a CLEAN club while the roulette spins; the night's mess
// spawns in as the theme reveals ("have the roulette with no rubbish in the
// scene, then spawn the rubbish in to match" — playtest request). While
// `spawningIn` is true everything reads as hidden and the last-call check and
// cleanliness bar are suppressed — an empty club is 100% clean by accident.
const SPAWN_IN_DELAY_MS = 2_600   // roulette (~1.6s) + a breath
let spawningIn = false
let spawnInTimer: ReturnType<typeof setTimeout> | null = null

function hideAllClutter() {
  for (const [, entity] of itemEntities) {
    ClutterSync.getMutable(entity).isCleaned = true
  }
}

function triggerOpen() {
  roundTimer = null
  clearAllRespawns()
  nextRoundTriggered = false

  const pct = Math.min(1, countCleaned() / demandedTotal())
  currentOutcome = computeOutcome(pct)
  isFinale    = isMilestoneRound(roundNumber)   // milestone reached → celebration hold
  phase       = 'open'
  openStartMs = Date.now()
  syncGameState()

  console.log(`[ROUND] Round ${roundNumber} ended — outcome: ${currentOutcome} (${Math.round(pct * 100)}%)${isFinale ? ' [MILESTONE]' : ''}`)

  // A completed round IS a completed shift — this is the moment wages, XP and
  // promotions are awarded. Handed to the server with the per-player contribution
  // tally so rewards come from the server's own count, never a client's claim.
  const contributions = new Map(roundContributions)
  roundContributions.clear()
  onShiftComplete?.(pct, contributions, playerCount, earlyCloseS)
  lastCallStartMs = 0
  earlyCloseS     = 0

  // Auto-advance after the display window (longer for the finale victory hold)
  roundTimer = setTimeout(() => {
    if (!nextRoundTriggered) startNextRound(false)
  }, openDisplayMs())
}

function startNextRound(fullReset: boolean) {
  clearAllRespawns()
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null }

  // V2: a milestone no longer ends the session. The celebration plays during the
  // open phase and then play continues, so there is always a reason to start the
  // next shift. Only an empty scene or an admin reset returns to the lobby.
  if (fullReset) {
    roundNumber = 0
    console.log('[ROUND] Match starting — round 0')
  } else {
    // Deliberately unclamped — rounds continue indefinitely. Durations clamp to the
    // shortest entry, so difficulty plateaus rather than becoming impossible.
    roundNumber = roundNumber + 1
    console.log(`[ROUND] Starting round ${roundNumber}`)
  }

  isFinale        = false
  currentOutcome  = ''
  lastCallStartMs = 0
  earlyCloseS     = 0
  // Theme rolls at round START (clients need gs.theme for the roulette), but
  // the mess itself arrives after the spawn-in beat: the club opens CLEAN while
  // the wheel spins, then the night's clutter appears to match the reveal.
  currentTheme = rollTheme()
  if (currentTheme !== '') lastThemeId = currentTheme
  hideAllClutter()
  spawningIn = true
  if (spawnInTimer) clearTimeout(spawnInTimer)
  spawnInTimer = setTimeout(() => {
    spawnInTimer = null
    spawningIn   = false
    resetClutter()
    applyThemeMask()
    // Contracts land WITH the mess — the roller above just decided whether a
    // disaster contract is even possible this round.
    onSpawnIn?.(roundNumber)
    syncGameState()
  }, SPAWN_IN_DELAY_MS)
  phase = 'playing'
  // Participation promotes AT the phase flip — waiting for the spawn-in beat
  // left every enrolled player staring at the spectate overlay for 2.6s.
  onRoundStart?.(roundNumber)

  if (playerCount > 0) {
    // Players are present — start the countdown immediately
    roundStartMs = Date.now()
    roundTimer   = setTimeout(triggerOpen, getRoundDurationMs())
  } else {
    // Scene is empty — hold at full duration until someone enters
    roundStartMs = 0
    console.log('[ROUND] No players — round timer paused until first player enters')
  }

  syncGameState()
}

// Return to the lobby — the resting state between matches (boot, finale end,
// empty scene, admin reset).  Players gather here and press START to begin.
function goToLobby() {
  clearAllRespawns()
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null }
  if (startCountdownTimer) { clearTimeout(startCountdownTimer); startCountdownTimer = null }
  if (spawnInTimer) { clearTimeout(spawnInTimer); spawnInTimer = null }
  spawningIn = false
  roundNumber        = 0
  isFinale           = false
  currentOutcome     = ''
  currentTheme       = ''
  lastCallStartMs    = 0
  earlyCloseS        = 0
  activeItems.clear()   // classic lobby — resetClutter below reveals everything
  starting           = false
  nextRoundTriggered = false
  roundStartMs       = 0
  // Abandon any partial shift — an interrupted round pays nothing, so a player
  // can't farm rewards by triggering resets.
  roundContributions.clear()
  resetClutter()
  // Re-park the theme spawn slots (resetClutter just un-cleaned them) and reset
  // the active set to the full classic mix for the lobby.
  applyThemeMask()
  phase = 'lobby'
  syncGameState()
  console.log('[ROUND] → lobby')
}

// Any player presses START in the lobby: run a short shared countdown, then begin
// round 0.  Guarded so it only fires from the lobby, once, with players present.
let startHold: (() => boolean) | undefined
/** Server-installed predicate: while it returns true, the lobby will not auto-start. */
export function setStartHold(fn: () => boolean) { startHold = fn }

export function onStartMatch() {
  if (phase !== 'lobby' || starting || playerCount <= 0) return
  starting = true
  startCountdownStartMs = Date.now()
  syncGameState()
  console.log('[ROUND] Match countdown started')
  startCountdownTimer = setTimeout(() => {
    startCountdownTimer = null
    starting = false
    startNextRound(true)   // full reset to round 0; starts the round timer (players present)
  }, LOBBY_COUNTDOWN_MS)
}

// Returns baseMs divided by the scale factor for the current player count AND
// the crew's upgrade power: more players or a stronger crew → smaller delay →
// items respawn faster → more mess to handle. Power scaling is what keeps a
// veteran's round full — their throughput grew, so the club's mess grows with it.
function scaledRespawnMs(baseMs: number): number {
  const idx    = Math.min(Math.max(playerCount - 1, 0), RESPAWN_SCALE_FACTORS.length - 1)
  const factor = RESPAWN_SCALE_FACTORS[idx] * (1 + RESPAWN_POWER_PER_LEVEL * (crewPower?.() ?? 0))
  return Math.round(baseMs / factor)
}

/** Milliseconds left in the current round, or 0 when no round is running. */
function roundMsRemaining(): number {
  if (phase !== 'playing' || roundStartMs === 0) return 0
  return Math.max(0, getRoundDurationMs() - (Date.now() - roundStartMs))
}

/**
 * Whether a respawn scheduled `delayMs` from now should happen at all.
 *
 * Two reasons to decline:
 *  • we're inside the closing window, where the club is meant to converge on clean
 *    so the shift has a visible conclusion (see RESPAWN_CUTOFF_FRACTION);
 *  • the item would land after the round ends anyway, where clearAllRespawns would
 *    discard it — scheduling it just burns a timer.
 */
function respawnAllowed(delayMs: number): boolean {
  const remaining = roundMsRemaining()
  if (remaining === 0) return false
  // Round 0 is a warm-up: nothing respawns, so a match opens as a straight
  // "clean what's in front of you" round. New players get to see the club
  // actually getting cleaner before the mess starts fighting back, which is
  // where V2 read as harder than V1.
  if (roundNumber === 0) return false
  const cutoff = getRoundDurationMs() * RESPAWN_CUTOFF_FRACTION
  if (remaining <= cutoff) return false
  return delayMs < remaining - cutoff
}

export function onItemCleaned(def: (typeof CLUTTER_DEFS)[number]) {
  if (phase !== 'playing') return

  const delay = scaledRespawnMs(def.fast ? FAST_RESPAWN_MS : CLUTTER_RESPAWN_MS)
  // Stays cleaned for the rest of the round — the club is closing out.
  if (!respawnAllowed(delay)) { syncGameState(); return }
  const t = setTimeout(() => {
    respawnTimers.delete(def.id)
    const entity = itemEntities.get(def.id)!
    ClutterSync.getMutable(entity).isCleaned = false
    syncGameState()
  }, delay)
  respawnTimers.set(def.id, t)
  syncGameState()
}

// Scene items (glasses, bottles, rubbish, sticky patches) — same respawn timer as
// regular clutter. onRespawn callback is responsible for flipping isCleaned and
// restoring the entity's scale on the server.
export function onSceneItemCleaned(itemId: string, onRespawn: () => void, fast = false) {
  if (phase !== 'playing') return
  const delay = scaledRespawnMs(fast ? FAST_RESPAWN_MS : CLUTTER_RESPAWN_MS)
  // Stays cleaned for the rest of the round — the club is closing out.
  if (!respawnAllowed(delay)) { syncGameState(); return }
  const t = setTimeout(() => {
    respawnTimers.delete(itemId)
    onRespawn()
    syncGameState()
  }, delay)
  respawnTimers.set(itemId, t)
  syncGameState()
}

function logScaling() {
  const idx    = Math.min(Math.max(playerCount - 1, 0), RESPAWN_SCALE_FACTORS.length - 1)
  const factor = RESPAWN_SCALE_FACTORS[idx]
  console.log(`[ROUND] Respawn rate: ${factor.toFixed(2)}× (${Math.round(CLUTTER_RESPAWN_MS / factor / 1000)}s standard / ${Math.round(FAST_RESPAWN_MS / factor / 1000)}s fast)`)
}

export function onPlayerEnter() {
  playerCount++
  console.log(`[ROUND] Player entered — count: ${playerCount}`)
  logScaling()

  // If the round timer isn't running yet (server just started, or scene was
  // empty after a reset), kick it off now so the countdown only begins once
  // someone has actually made it into the scene.
  if (playerCount === 1 && roundTimer === null && phase === 'playing') {
    roundStartMs = Date.now()
    roundTimer   = setTimeout(triggerOpen, getRoundDurationMs())
    console.log('[ROUND] First player entered — round timer started')
  }
  syncGameState()   // update the live lobby count (playersIn)
}

export function onPlayerLeave() {
  playerCount = Math.max(0, playerCount - 1)
  console.log(`[ROUND] Player left — count: ${playerCount}`)
  if (playerCount === 0) {
    // Everyone left — return to the lobby (also cancels any in-flight countdown).
    goToLobby()
  } else {
    logScaling()
    syncGameState()   // update the live lobby count (playersIn)
  }
}

export function onAdminReset() {
  console.log('[ROUND] Admin reset triggered')
  goToLobby()
}

export function initRoundManager(
  entities: Map<string, Entity>,
  gsEntity: Entity,
  itemCategoryFor?: (itemId: string) => ItemCategory,
  itemNameFor?: (itemId: string) => string,
) {
  itemEntities    = entities
  gameStateEntity = gsEntity
  categoryFor     = itemCategoryFor
  nameFor         = itemNameFor

  // Boot into the lobby — players gather and press START to begin a match.
  goToLobby()

  setInterval(() => {
    // The club never closes. V1's lobby was a manual gate — press START, wait for
    // others — which in V2's endless loop is a dead end: a player who arrives (or
    // whose server restarted mid-session) sits looking at a button with nothing
    // else happening. Instead the lobby auto-starts the moment anyone is present,
    // so it's a brief "next shift starting" beat rather than a screen you can be
    // stranded on. The START button remains as a way to skip the wait.
    // startHold lets the server delay the auto-start (e.g. while a brand-new
    // player reads the career intro). START NOW still works — the hold only
    // gates the AUTOMATIC start, never a deliberate one.
    if (phase === 'lobby' && !starting && playerCount > 0 && !startHold?.()) onStartMatch()

    // 100% before the clock runs out → LAST CALL. Skill and upgrades finish
    // rounds early; without this, mastery buys idle time (playtest: "waiting
    // 20s for the round to end"). The grace window exists because cleanliness
    // counts at PICKUP — hands are full at the moment 100% lands, and an
    // instant end would void the bin run (and any deposits contract).
    if (phase === 'playing' && !spawningIn && lastCallStartMs === 0 && roundStartMs !== 0
        && countCleaned() >= demandedTotal()) {
      startLastCall()
    }

    if (phase === 'playing' || phase === 'open' || phase === 'lobby') syncGameState()
  }, 1_000)
}
