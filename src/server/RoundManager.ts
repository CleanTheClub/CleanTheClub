import { Entity } from '@dcl/sdk/ecs'
import { ClutterSync, GameState } from '../shared/schemas'
import {
  CLUTTER_DEFS, TOTAL_CLUTTER,
  OPEN_THRESHOLD, OPEN_SUSTAIN_MS,
  ROUND_DURATION_MS, CLUTTER_RESPAWN_MS, FAST_RESPAWN_MS,
} from '../shared/config'

export type Phase = 'playing' | 'opening' | 'open'

let itemEntities: Map<string, Entity>
let gameStateEntity: Entity
let phase: Phase = 'playing'
let sustainTimer: ReturnType<typeof setTimeout> | null = null
let roundTimer:   ReturnType<typeof setTimeout> | null = null
let roundStartMs  = 0
const respawnTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function getPhase(): Phase { return phase }

function countCleaned(): number {
  let n = 0
  for (const [, e] of itemEntities) if (ClutterSync.get(e).isCleaned) n++
  return n
}

function syncGameState() {
  const gs = GameState.getMutable(gameStateEntity)
  gs.phase = phase
  gs.cleanedCount = countCleaned()
  gs.totalCount = TOTAL_CLUTTER
  gs.secondsLeft = phase === 'playing'
    ? Math.max(0, Math.ceil((ROUND_DURATION_MS - (Date.now() - roundStartMs)) / 1000))
    : 0
}

function checkThreshold() {
  if (phase !== 'playing') return
  const pct = TOTAL_CLUTTER > 0 ? countCleaned() / TOTAL_CLUTTER : 0
  if (pct >= OPEN_THRESHOLD && !sustainTimer) {
    phase = 'opening'
    syncGameState()
    sustainTimer = setTimeout(triggerOpen, OPEN_SUSTAIN_MS)
  } else if (pct < OPEN_THRESHOLD && sustainTimer) {
    clearTimeout(sustainTimer)
    sustainTimer = null
    phase = 'playing'
    syncGameState()
  }
}

function triggerOpen() {
  phase = 'open'
  sustainTimer = null
  syncGameState()
  setTimeout(resetRound, 15_000)
}

function resetRound() {
  if (roundTimer)   { clearTimeout(roundTimer);   roundTimer = null }
  if (sustainTimer) { clearTimeout(sustainTimer); sustainTimer = null }
  for (const [id, t] of respawnTimers) { clearTimeout(t); respawnTimers.delete(id) }

  for (const [, entity] of itemEntities) {
    const cs = ClutterSync.getMutable(entity)
    cs.isCleaned = false
    cs.cleanedAt = 0
    cs.cleanedBy = ''
  }

  phase = 'playing'
  roundStartMs = Date.now()
  syncGameState()
  roundTimer = setTimeout(resetRound, ROUND_DURATION_MS)
}

export function onItemCleaned(def: (typeof CLUTTER_DEFS)[number]) {
  const delay = def.fast ? FAST_RESPAWN_MS : CLUTTER_RESPAWN_MS
  const t = setTimeout(() => {
    respawnTimers.delete(def.id)
    const entity = itemEntities.get(def.id)!
    const cs = ClutterSync.getMutable(entity)
    cs.isCleaned = false
    cs.cleanedAt = 0
    cs.cleanedBy = ''
    if (phase !== 'open') checkThreshold()
    syncGameState()
  }, delay)
  respawnTimers.set(def.id, t)
  checkThreshold()
  syncGameState()
}

export function initRoundManager(
  entities: Map<string, Entity>,
  gsEntity: Entity
) {
  itemEntities    = entities
  gameStateEntity = gsEntity

  roundStartMs = Date.now()
  roundTimer   = setTimeout(resetRound, ROUND_DURATION_MS)

  setInterval(() => {
    if (phase === 'playing') syncGameState()
  }, 1_000)
}
