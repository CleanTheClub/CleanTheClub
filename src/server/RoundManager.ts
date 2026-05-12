import { Entity } from '@dcl/sdk/ecs'
import { ClutterSync, GameState } from '../shared/schemas'
import {
  CLUTTER_DEFS,
  ROUND_DURATIONS_MS, OPEN_DISPLAY_MS, NEXT_ROUND_LOCK_MS,
  CLUTTER_RESPAWN_MS, FAST_RESPAWN_MS,
  OUTCOME_OPTIMAL, OUTCOME_ADEQUATE,
} from '../shared/config'

export type Phase   = 'playing' | 'open'
export type Outcome = '' | 'optimal' | 'adequate' | 'suboptimal'

let itemEntities:    Map<string, Entity>
let gameStateEntity: Entity
let phase:        Phase   = 'playing'
let roundNumber:  number  = 0
let roundStartMs  = 0
let openStartMs   = 0
let playerCount   = 0
let currentOutcome: Outcome = ''

// Guards against double-triggering the next round during the open phase
let nextRoundTriggered = false

let roundTimer: ReturnType<typeof setTimeout> | null = null
const respawnTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function getPhase():       Phase  { return phase }
export function getRoundNumber(): number { return roundNumber }

function getRoundDurationMs(): number {
  return ROUND_DURATIONS_MS[Math.min(roundNumber, ROUND_DURATIONS_MS.length - 1)]
}

function countCleaned(): number {
  let n = 0
  for (const [, e] of itemEntities) if (ClutterSync.get(e).isCleaned) n++
  return n
}

function computeOutcome(pct: number): Outcome {
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
    ? Math.max(0, Math.ceil((getRoundDurationMs() - (now - roundStartMs)) / 1000))
    : phase === 'open'
    ? Math.max(0, Math.ceil((OPEN_DISPLAY_MS - (now - openStartMs)) / 1000))
    : 0
  gs.roundNumber   = roundNumber
  gs.outcome       = currentOutcome
  gs.canStartEarly = phase === 'open' && (now - openStartMs) >= NEXT_ROUND_LOCK_MS
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
  phase       = 'open'
  openStartMs = Date.now()
  syncGameState()

  console.log(`[ROUND] Round ${roundNumber} ended — outcome: ${currentOutcome} (${Math.round(pct * 100)}%)`)

  // Auto-advance after full display window; can be short-circuited by onNextRoundRequest
  roundTimer = setTimeout(() => {
    if (!nextRoundTriggered) startNextRound(false)
  }, OPEN_DISPLAY_MS)

  // Flip canStartEarly once the lock expires
  setTimeout(syncGameState, NEXT_ROUND_LOCK_MS)
}

function startNextRound(fullReset: boolean) {
  clearAllRespawns()
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null }

  if (fullReset) {
    roundNumber = 0
    console.log('[ROUND] Full reset — back to round 0')
  } else {
    roundNumber = Math.min(roundNumber + 1, ROUND_DURATIONS_MS.length - 1)
    console.log(`[ROUND] Starting round ${roundNumber}`)
  }

  currentOutcome = ''
  resetClutter()
  phase        = 'playing'
  roundStartMs = Date.now()
  syncGameState()

  roundTimer = setTimeout(triggerOpen, getRoundDurationMs())
}

export function onItemCleaned(def: (typeof CLUTTER_DEFS)[number]) {
  if (phase !== 'playing') return

  const delay = def.fast ? FAST_RESPAWN_MS : CLUTTER_RESPAWN_MS
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

// Scene items (glasses, bottles, rubbish) stay collected all round — no respawn timer
export function onSceneItemCleaned() {
  if (phase !== 'playing') return
  syncGameState()
}

// Any player can request an early start — server guards against double-trigger
export function onNextRoundRequest() {
  if (nextRoundTriggered || phase !== 'open') return
  if ((Date.now() - openStartMs) < NEXT_ROUND_LOCK_MS) return
  nextRoundTriggered = true
  console.log('[ROUND] Early start requested by player')
  startNextRound(false)
}

export function onPlayerEnter() {
  playerCount++
  console.log(`[ROUND] Player entered — count: ${playerCount}`)
}

export function onPlayerLeave() {
  playerCount = Math.max(0, playerCount - 1)
  console.log(`[ROUND] Player left — count: ${playerCount}`)
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
  roundStartMs   = Date.now()
  phase          = 'playing'
  syncGameState()

  roundTimer = setTimeout(triggerOpen, getRoundDurationMs())

  setInterval(() => {
    if (phase === 'playing' || phase === 'open') syncGameState()
  }, 1_000)
}
