// Room-filling confetti celebration fired when the club doors open (phase → 'open').
// Uses the Living Garden pattern: pre-allocated pool of plane entities driven by a
// manual ECS physics system — no ParticleSystem component.
//
// Celebration loops continuously throughout the open phase, re-bursting every
// LOOP_INTERVAL_MS. Pool size is calculated to hold the steady-state piece count.
//
// DEBUG_CONFETTI = true → fires an optimal burst immediately on init for tuning.
// Set it false before shipping.

import {
  engine, Entity,
  MeshRenderer, Material, MaterialTransparencyMode,
  Transform,
  timers,
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { GameState } from '../shared/schemas'

// ─────────────────────────────────────────────────────────────────────────────
// ── Config — all tunables in one place ───────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const DEBUG_CONFETTI = false      // fire immediately on init; set false to ship

// ── Pool ─────────────────────────────────────────────────────────────────────
// Must comfortably hold: (pieces_per_burst) × (LIFE_MAX_MS / LOOP_INTERVAL_MS)
// Finale steady state: 12 pieces/cannon × 9 cannons × (8 000 ms / 1 000 ms) = 864 → 1000 is safe
const POOL_SIZE = 1000

// ── Piece appearance ──────────────────────────────────────────────────────────
const PIECE_W           = 0.22   // width  (metres)
const PIECE_H           = 0.34   // height (metres)
const PIECE_DEPTH       = 0.002  // Z thickness of the plane
const EMISSIVE_FACTOR   = 0.40   // albedo × factor → emissive colour
const EMISSIVE_INTENSITY = 0.60

// ── Cannon positions ──────────────────────────────────────────────────────────
const CANNON_Y           = 18.0  // ceiling height (metres) — adjust to match scene
const CANNON_GRID_X      = [7, 14, 21]   // X coords of the 3 × 3 cannon grid
const CANNON_GRID_Z      = [7, 15, 22]   // Z coords

// ── Physics ───────────────────────────────────────────────────────────────────
const GRAVITY            = 1.8   // m/s² — gentle float from 18 m (≈4 s to floor)
const SPEED_H_MIN        = 0.3   // horizontal launch speed (m/s)
const SPEED_H_MAX        = 1.5
const SPEED_V_MIN        = 0.5   // initial downward speed from cannon (m/s)
const SPEED_V_MAX        = 1.5

// ── Flutter ───────────────────────────────────────────────────────────────────
const FLUTTER_FREQ       = 0.6   // Hz — sinusoidal sideways drift
const FLUTTER_AMP        = 0.40  // metres amplitude

// ── Spin ──────────────────────────────────────────────────────────────────────
const SPIN_Z_MIN         = 80    // roll speed (deg/s)
const SPIN_Z_MAX         = 380
const SPIN_Y_FACTOR      = 0.4   // yaw is this fraction of roll speed

// ── Lifetime & fade ───────────────────────────────────────────────────────────
const LIFE_MIN_MS        = 5_000  // milliseconds
const LIFE_MAX_MS        = 8_000
const FADE_START_FRAC    = 0.80  // fraction of lifetime when fade-out begins

// ── Spawn ─────────────────────────────────────────────────────────────────────
const SPAWN_JITTER       = 1.0   // random radius around each cannon origin (metres)

// ── Celebration loop ──────────────────────────────────────────────────────────
const LOOP_INTERVAL_MS   = 1_000  // ms between continuous bursts during open phase
const FIRST_BURST_DELAY_MS = 0    // ms before the very first burst (0 = instant)

// ── Outcome burst sizes (pieces per cannon per burst) ─────────────────────────
// Optimal:    8 × 9 cannons = 72/burst — steady-state ~288 active
// Adequate:   5 × 5 cannons = 25/burst
// Suboptimal: 3 × 3 cannons =  9/burst
const OPTIMAL_PER_CANNON    = 8
const ADEQUATE_PER_CANNON   = 5
const SUBOPTIMAL_PER_CANNON = 3
// Finale victory hold — maximum celebration regardless of the round's outcome.
// 12 × 9 cannons = 108/burst → steady-state ~864 active (POOL_SIZE 1000 covers it).
const FINALE_PER_CANNON     = 12

// ─────────────────────────────────────────────────────────────────────────────
// ── Colour palette ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const PALETTE: Color4[] = [
  Color4.create(1.00, 0.20, 0.25, 1),  // 0  red
  Color4.create(1.00, 0.82, 0.10, 1),  // 1  gold
  Color4.create(0.20, 0.65, 1.00, 1),  // 2  sky blue
  Color4.create(0.20, 0.90, 0.35, 1),  // 3  lime green
  Color4.create(0.90, 0.20, 0.90, 1),  // 4  magenta
  Color4.create(1.00, 0.50, 0.10, 1),  // 5  orange
  Color4.create(0.95, 0.95, 0.95, 1),  // 6  white / silver
]

// ─────────────────────────────────────────────────────────────────────────────
// ── Burst config ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

type Outcome = '' | 'perfect' | 'optimal' | 'adequate' | 'suboptimal'
type BurstCfg = { countPerCannon: number; cannonIndices: number[]; paletteSize: number }

// Build the 3×3 cannon grid from the config arrays above
const CANNONS: { x: number; y: number; z: number }[] = []
for (const z of CANNON_GRID_Z) for (const x of CANNON_GRID_X) CANNONS.push({ x, y: CANNON_Y, z })

// finale=true overrides the outcome with the maximum celebration (victory hold).
function getBurstCfg(outcome: Outcome, finale = false): BurstCfg {
  if (finale) {
    return { countPerCannon: FINALE_PER_CANNON, cannonIndices: [0,1,2,3,4,5,6,7,8], paletteSize: 7 }
  }
  switch (outcome) {
    case 'perfect':
    case 'optimal':
      return { countPerCannon: OPTIMAL_PER_CANNON,    cannonIndices: [0,1,2,3,4,5,6,7,8], paletteSize: 7 }
    case 'adequate':
      return { countPerCannon: ADEQUATE_PER_CANNON,   cannonIndices: [1,3,4,5,7],          paletteSize: 5 }
    case 'suboptimal':
    default:
      return { countPerCannon: SUBOPTIMAL_PER_CANNON, cannonIndices: [1,4,7],              paletteSize: 3 }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Pool ──────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

interface Slot {
  idx:         number   // index into `pool` (for O(1) return to the free list)
  entity:      Entity
  colorIdx:    number
  active:      boolean
  pos:         { x: number; y: number; z: number }
  vel:         { x: number; y: number; z: number }
  age:         number   // seconds since spawn
  lifeMs:      number   // elapsed ms
  maxLifeMs:   number
  spinZ:       number   // roll  (degrees)
  spinZVel:    number
  spinY:       number   // yaw   (degrees)
  spinYVel:    number
  flutterOff:  number   // phase offset for flutter sine
}

const pool: Slot[] = []
// Free-list of inactive slot indices — O(1) allocation per piece instead of an
// O(n) scan of the whole pool (matters at the finale: ~108 pieces/burst, every 1s).
const freeStack: number[] = []

function makeEntity(colorIdx: number): Entity {
  const c = PALETTE[colorIdx]
  const e = engine.addEntity()
  MeshRenderer.setPlane(e)
  Material.setPbrMaterial(e, {
    albedoColor:       Color4.create(c.r, c.g, c.b, 1),
    emissiveColor:     { r: c.r * EMISSIVE_FACTOR, g: c.g * EMISSIVE_FACTOR, b: c.b * EMISSIVE_FACTOR },
    emissiveIntensity: EMISSIVE_INTENSITY,
    transparencyMode:  MaterialTransparencyMode.MTM_OPAQUE,
    castShadows:       false,
  })
  Transform.create(e, {
    position: { x: 0, y: -200, z: 0 },
    scale:    { x: 0.001, y: 0.001, z: 0.001 },
  })
  return e
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Burst + loop ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

let celebrationActive = false
// Number of pieces currently in flight. Lets the physics system skip its 1000-slot
// scan entirely whenever no confetti is active (i.e. all of the 'playing' phase).
let activeCount = 0

function fireBurst(cfg: BurstCfg): void {
  let spawned = 0
  for (const ci of cfg.cannonIndices) {
    const origin = CANNONS[ci]
    for (let i = 0; i < cfg.countPerCannon; i++) {
      const freeIdx = freeStack.pop()
      if (freeIdx === undefined) { console.log('[Confetti] Pool exhausted — skipping remaining pieces'); return }
      const slot = pool[freeIdx]

      const azimuth = Math.random() * Math.PI * 2
      const speedH  = SPEED_H_MIN + Math.random() * (SPEED_H_MAX - SPEED_H_MIN)
      const speedV  = SPEED_V_MIN + Math.random() * (SPEED_V_MAX - SPEED_V_MIN)
      const jX      = (Math.random() - 0.5) * 2 * SPAWN_JITTER
      const jZ      = (Math.random() - 0.5) * 2 * SPAWN_JITTER

      slot.active     = true
      activeCount++
      slot.lifeMs     = 0
      slot.age        = 0
      slot.maxLifeMs  = LIFE_MIN_MS + Math.random() * (LIFE_MAX_MS - LIFE_MIN_MS)
      slot.pos        = { x: origin.x + jX, y: origin.y, z: origin.z + jZ }
      slot.vel        = { x: Math.cos(azimuth) * speedH, y: -speedV, z: Math.sin(azimuth) * speedH }
      slot.spinZ      = Math.random() * 360
      slot.spinZVel   = (SPIN_Z_MIN + Math.random() * (SPIN_Z_MAX - SPIN_Z_MIN)) * (Math.random() < 0.5 ? 1 : -1)
      slot.spinY      = Math.random() * 360
      slot.spinYVel   = slot.spinZVel * SPIN_Y_FACTOR * (Math.random() < 0.5 ? 1 : -1)
      slot.flutterOff = Math.random() * Math.PI * 2

      const tf = Transform.getMutable(slot.entity)
      tf.position = { x: slot.pos.x, y: slot.pos.y, z: slot.pos.z }
      tf.scale    = { x: PIECE_W, y: PIECE_H, z: PIECE_DEPTH }
      spawned++
    }
  }
  console.log(`[Confetti] Burst — ${spawned} pieces`)
}

function scheduleNextBurst(cfg: BurstCfg): void {
  if (!celebrationActive) return
  timers.setTimeout(() => {
    if (!celebrationActive) return
    fireBurst(cfg)
    scheduleNextBurst(cfg)
  }, LOOP_INTERVAL_MS)
}

export function launchCelebration(outcome: Outcome, finale = false): void {
  const resolved = (outcome === '' ? 'suboptimal' : outcome) as Outcome
  const cfg = getBurstCfg(resolved, finale)
  console.log(`[Confetti] Launch — outcome: "${resolved}"${finale ? ' [FINALE]' : ''}, looping every ${LOOP_INTERVAL_MS}ms`)

  celebrationActive = true

  if (FIRST_BURST_DELAY_MS === 0) {
    fireBurst(cfg)
    scheduleNextBurst(cfg)
  } else {
    timers.setTimeout(() => {
      if (!celebrationActive) return
      fireBurst(cfg)
      scheduleNextBurst(cfg)
    }, FIRST_BURST_DELAY_MS)
  }
}

function stopCelebration(): void {
  celebrationActive = false  // scheduleNextBurst checks this and exits the loop
  console.log('[Confetti] Celebration stopped')
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Init ──────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export function initConfettiSystem(): void {
  for (let i = 0; i < POOL_SIZE; i++) {
    pool.push({
      idx:        i,
      entity:     makeEntity(i % PALETTE.length),
      colorIdx:   i % PALETTE.length,
      active:     false,
      pos:        { x: 0, y: 0, z: 0 },
      vel:        { x: 0, y: 0, z: 0 },
      age:        0, lifeMs: 0, maxLifeMs: 0,
      spinZ: 0, spinZVel: 0, spinY: 0, spinYVel: 0, flutterOff: 0,
    })
    freeStack.push(i)
  }
  console.log(`[Confetti] Pool ready — ${POOL_SIZE} slots, ceiling Y = ${CANNON_Y}`)

  // ── Physics system ──────────────────────────────────────────────────────────
  engine.addSystem((dt: number) => {
    if (activeCount === 0) return   // no confetti in flight — skip the pool scan
    for (const s of pool) {
      if (!s.active) continue

      s.age    += dt
      s.lifeMs += dt * 1_000

      if (s.lifeMs >= s.maxLifeMs) {
        s.active = false
        activeCount--
        freeStack.push(s.idx)   // return to the free list for reuse
        const tf = Transform.getMutable(s.entity)
        tf.scale    = { x: 0.001, y: 0.001, z: 0.001 }
        tf.position = { x: 0, y: -200, z: 0 }
        continue
      }

      s.vel.y -= GRAVITY * dt

      const flutter = Math.sin(s.age * FLUTTER_FREQ * Math.PI * 2 + s.flutterOff) * FLUTTER_AMP
      s.pos.x += (s.vel.x + flutter)         * dt
      s.pos.y +=  s.vel.y                    * dt
      s.pos.z += (s.vel.z + flutter * 0.55)  * dt

      s.spinZ += s.spinZVel * dt
      s.spinY += s.spinYVel * dt

      const t     = s.lifeMs / s.maxLifeMs
      const alpha = t > FADE_START_FRAC
        ? 1 - (t - FADE_START_FRAC) / (1 - FADE_START_FRAC)
        : 1

      const tf    = Transform.getMutable(s.entity)
      tf.position = { x: s.pos.x, y: s.pos.y, z: s.pos.z }
      tf.scale    = { x: PIECE_W * alpha, y: PIECE_H * alpha, z: PIECE_DEPTH }
      tf.rotation = Quaternion.fromEulerDegrees(0, s.spinY, s.spinZ)
    }
  })

  // ── Phase watcher ───────────────────────────────────────────────────────────
  let lastPhase = ''
  engine.addSystem(() => {
    for (const [, gs] of engine.getEntitiesWith(GameState)) {
      if (gs.phase === lastPhase) continue
      const prev = lastPhase
      lastPhase  = gs.phase
      console.log(`[Confetti] Phase: "${prev}" → "${gs.phase}"`)
      if (gs.phase === 'open'    && prev === 'playing') launchCelebration(gs.outcome as Outcome, gs.isFinale)
      if (gs.phase === 'playing' && prev === 'open')    stopCelebration()
    }
  })

  // ── Debug burst ─────────────────────────────────────────────────────────────
  if (DEBUG_CONFETTI) {
    console.log('[Confetti] DEBUG — firing optimal burst in 500ms')
    timers.setTimeout(() => launchCelebration('optimal'), 500)
  }
}
