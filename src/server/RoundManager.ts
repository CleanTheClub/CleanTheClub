import { Entity } from '@dcl/sdk/ecs'
import { ClutterSync, GameState } from '../shared/schemas'
import {
  CLUTTER_DEFS,
  ROUND_DURATIONS_MS, OPEN_DISPLAY_MS, FINALE_DISPLAY_MS,
  CLUTTER_RESPAWN_MS, FAST_RESPAWN_MS, RESPAWN_SCALE_FACTORS,
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

export function getPhase():       Phase  { return phase }
export function getRoundNumber(): number { return roundNumber }

function getRoundDurationMs(): number {
  return ROUND_DURATIONS_MS[Math.min(roundNumber, ROUND_DURATIONS_MS.length - 1)]
}

// The final round is the last entry in ROUND_DURATIONS_MS.
function isFinalRound(n: number): boolean {
  return n >= ROUND_DURATIONS_MS.length - 1
}

// Active open-phase display window — longer for the finale victory hold.
function openDisplayMs(): number {
  return isFinale ? FINALE_DISPLAY_MS : OPEN_DISPLAY_MS
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
  gs.cleanedCount = countCleaned()
  gs.totalCount   = itemEntities.size
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

  const total = itemEntities.size
  const pct = total > 0 ? countCleaned() / total : 0
  currentOutcome = computeOutcome(pct)
  isFinale    = isFinalRound(roundNumber)   // final round just ended → victory hold
  phase       = 'open'
  openStartMs = Date.now()
  syncGameState()

  console.log(`[ROUND] Round ${roundNumber} ended — outcome: ${currentOutcome} (${Math.round(pct * 100)}%)${isFinale ? ' [FINALE]' : ''}`)

  // Auto-advance after the display window (longer for the finale victory hold)
  roundTimer = setTimeout(() => {
    if (!nextRoundTriggered) startNextRound(false)
  }, openDisplayMs())
}

function startNextRound(fullReset: boolean) {
  clearAllRespawns()
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null }

  // Finale victory hold just finished → return to the lobby (don't auto-loop).
  // The next match only begins when a player presses START again.
  if (!fullReset && isFinale) {
    goToLobby()
    return
  }

  if (fullReset) {
    roundNumber = 0
    console.log('[ROUND] Match starting — round 0')
  } else {
    roundNumber = Math.min(roundNumber + 1, ROUND_DURATIONS_MS.length - 1)
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

export function onItemCleaned(def: (typeof CLUTTER_DEFS)[number]) {
  if (phase !== 'playing') return

  const delay = scaledRespawnMs(def.fast ? FAST_RESPAWN_MS : CLUTTER_RESPAWN_MS)
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
    if (phase === 'playing' || phase === 'open' || phase === 'lobby') syncGameState()
  }, 1_000)
}
