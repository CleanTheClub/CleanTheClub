import { Entity } from '@dcl/sdk/ecs'
import { ClutterSync, GameState } from '../shared/schemas'
import {
  CLUTTER_DEFS,
  ROUND_DURATIONS_MS, OPEN_DISPLAY_MS, FINALE_DISPLAY_MS,
  CLUTTER_RESPAWN_MS, FAST_RESPAWN_MS, RESPAWN_SCALE_FACTORS,
  OUTCOME_OPTIMAL, OUTCOME_ADEQUATE,
} from '../shared/config'

export type Phase   = 'playing' | 'open'
export type Outcome = '' | 'perfect' | 'optimal' | 'adequate' | 'suboptimal'

let itemEntities:    Map<string, Entity>
let gameStateEntity: Entity
let phase:        Phase   = 'playing'
let roundNumber:  number  = 0
let roundStartMs  = 0
let openStartMs   = 0
let playerCount   = 0
let currentOutcome: Outcome = ''

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
    : 0
  gs.roundNumber   = roundNumber
  gs.outcome       = currentOutcome
  gs.canStartEarly = false   // early start disabled — intermission is no longer skippable
  gs.isFinale      = isFinale
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

  if (fullReset) {
    roundNumber = 0
    console.log('[ROUND] Full reset — back to round 0')
  } else if (isFinale) {
    // Final round's victory hold just finished — loop the game back to round 1.
    roundNumber = 0
    console.log('[ROUND] Finale complete — looping back to round 0')
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
    syncGameState()
    console.log('[ROUND] First player entered — round timer started')
  }
}

export function onPlayerLeave() {
  playerCount = Math.max(0, playerCount - 1)
  console.log(`[ROUND] Player left — count: ${playerCount}`)
  if (playerCount > 0) logScaling()
  if (playerCount === 0) {
    nextRoundTriggered = true   // block any in-flight startNextRound messages
    if (roundTimer) { clearTimeout(roundTimer); roundTimer = null }
    startNextRound(true)
  }
}

export function onAdminReset() {
  console.log('[ROUND] Admin reset triggered')
  nextRoundTriggered = true
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null }
  startNextRound(true)
}

export function initRoundManager(
  entities: Map<string, Entity>,
  gsEntity: Entity,
  restoreScales?: () => void,
) {
  itemEntities    = entities
  gameStateEntity = gsEntity
  onRestoreScales = restoreScales

  roundNumber    = 0
  currentOutcome = ''
  isFinale       = false
  roundStartMs   = 0       // timer hasn't started — waits for first player enter
  phase          = 'playing'
  syncGameState()
  // roundTimer intentionally not started here — onPlayerEnter starts it

  setInterval(() => {
    if (phase === 'playing' || phase === 'open') syncGameState()
  }, 1_000)
}
