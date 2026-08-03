import { Entity } from '@dcl/sdk/ecs'
import { ClutterSync, GameState } from '../shared/schemas'
import {
  CLUTTER_DEFS,
  ROUND_DURATIONS_MS, OPEN_DISPLAY_MS, FINALE_DISPLAY_MS, MILESTONE_EVERY,
  CLUTTER_RESPAWN_MS, FAST_RESPAWN_MS, RESPAWN_SCALE_FACTORS, RESPAWN_CUTOFF_FRACTION,
  DEMAND_FACTORS,
  OUTCOME_OPTIMAL, OUTCOME_ADEQUATE,
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

// Guards against double-triggering the next round during the open phase
let nextRoundTriggered = false

let roundTimer: ReturnType<typeof setTimeout> | null = null
const respawnTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ── Per-shift contribution tally ──────────────────────────────────────────────
// address → items cleaned during the CURRENT round. Counted incrementally rather
// than tallied from ClutterSync at round end, because items respawn mid-round and
// clear their cleanedBy — a snapshot at the end would undercount badly.
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
function demandedTotal(): number {
  const idx = Math.min(Math.max(playerCount - 1, 0), DEMAND_FACTORS.length - 1)
  return Math.max(1, Math.round(itemEntities.size * DEMAND_FACTORS[idx]))
}

function countCleaned(): number {
  let n = 0
  for (const [, e] of itemEntities) if (ClutterSync.get(e).isCleaned) n++
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
  const gs  = GameState.getMutable(gameStateEntity)
  gs.phase        = phase
  // Demand-scaled: clients render cleaned/total directly, so shipping the
  // scaled total here tunes every display and consequence at once. Cleaned is
  // capped so the bar can't read past 100% on an over-delivering solo shift.
  const demanded  = demandedTotal()
  gs.cleanedCount = Math.min(countCleaned(), demanded)
  gs.totalCount   = demanded
  gs.secondsLeft  = phase === 'playing'
    ? roundStartMs === 0
      ? Math.ceil(getRoundDurationMs() / 1000)   // timer not yet started — show full duration
      : Math.max(0, Math.ceil((getRoundDurationMs() - (now - roundStartMs)) / 1000))
    : phase === 'open'
    ? Math.max(0, Math.ceil((openDisplayMs() - (now - openStartMs)) / 1000))
    : phase === 'lobby' && starting
    ? Math.max(0, Math.ceil((LOBBY_COUNTDOWN_MS - (now - startCountdownStartMs)) / 1000))
    : 0
  gs.roundNumber   = roundNumber
  gs.outcome       = currentOutcome
  gs.canStartEarly = false   // early start disabled — intermission is no longer skippable
  gs.isFinale      = isFinale
  gs.playersIn     = playerCount
  gs.starting      = starting
}

function clearAllRespawns() {
  for (const [id, t] of respawnTimers) { clearTimeout(t); respawnTimers.delete(id) }
}

let onRestoreScales: (() => void) | undefined

function resetClutter() {
  for (const [, entity] of itemEntities) {
    const cs = ClutterSync.getMutable(entity)
    cs.isCleaned = false
    cs.cleanedAt = 0
    cs.cleanedBy = ''
  }
  onRestoreScales?.()
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
  onShiftComplete?.(pct, contributions, playerCount)

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

  isFinale       = false
  currentOutcome = ''
  resetClutter()
  phase = 'playing'

  if (playerCount > 0) {
    // Players are present — start the countdown immediately
    roundStartMs = Date.now()
    roundTimer   = setTimeout(triggerOpen, getRoundDurationMs())
  } else {
    // Scene is empty — hold at full duration until someone enters
    roundStartMs = 0
    console.log('[ROUND] No players — round timer paused until first player enters')
  }

  // Promote anyone who signed up during the intermission BEFORE syncing state, so
  // the first frame of the round already reflects who is cleaning.
  onRoundStart?.(roundNumber)

  syncGameState()
}

// Return to the lobby — the resting state between matches (boot, finale end,
// empty scene, admin reset).  Players gather here and press START to begin.
function goToLobby() {
  clearAllRespawns()
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null }
  if (startCountdownTimer) { clearTimeout(startCountdownTimer); startCountdownTimer = null }
  roundNumber        = 0
  isFinale           = false
  currentOutcome     = ''
  starting           = false
  nextRoundTriggered = false
  roundStartMs       = 0
  // Abandon any partial shift — an interrupted round pays nothing, so a player
  // can't farm rewards by triggering resets.
  roundContributions.clear()
  resetClutter()
  phase = 'lobby'
  syncGameState()
  console.log('[ROUND] → lobby')
}

// Any player presses START in the lobby: run a short shared countdown, then begin
// round 0.  Guarded so it only fires from the lobby, once, with players present.
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

// Returns baseMs divided by the scale factor for the current player count.
// More players → smaller delay → items respawn faster → more mess to handle.
function scaledRespawnMs(baseMs: number): number {
  const idx    = Math.min(Math.max(playerCount - 1, 0), RESPAWN_SCALE_FACTORS.length - 1)
  const factor = RESPAWN_SCALE_FACTORS[idx]
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
    const cs = ClutterSync.getMutable(entity)
    cs.isCleaned = false
    cs.cleanedAt = 0
    cs.cleanedBy = ''
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

// Early start is intentionally disabled — players asked for a fixed
// round → intermission → round cadence with no way to skip the intermission
// (the intermission is the payoff moment).  The intermission always runs its
// full countdown; this handler is now a no-op kept for message compatibility.
export function onNextRoundRequest() {
  // no-op: intermission is no longer skippable
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
  restoreScales?: () => void,
) {
  itemEntities    = entities
  gameStateEntity = gsEntity
  onRestoreScales = restoreScales

  // Boot into the lobby — players gather and press START to begin a match.
  goToLobby()

  setInterval(() => {
    // The club never closes. V1's lobby was a manual gate — press START, wait for
    // others — which in V2's endless loop is a dead end: a player who arrives (or
    // whose server restarted mid-session) sits looking at a button with nothing
    // else happening. Instead the lobby auto-starts the moment anyone is present,
    // so it's a brief "next shift starting" beat rather than a screen you can be
    // stranded on. The START button remains as a way to skip the wait.
    if (phase === 'lobby' && !starting && playerCount > 0) onStartMatch()

    if (phase === 'playing' || phase === 'open' || phase === 'lobby') syncGameState()
  }, 1_000)
}
