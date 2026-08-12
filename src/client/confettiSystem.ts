// Room-filling confetti, fired when the club doors open (phase → 'open').
//
// Built on the platform's ParticleSystem: NINE emitters on a ceiling grid, one
// per cannon. It used to be a pool of 700 individually-materialed planes driven
// by a hand-written physics system — which cost 700 of the scene's ~972
// materials, 72% of the budget, against a mobile HARD LIMIT OF 500. That breach
// is what made phones give up after a couple of rounds. Nine emitters cost nine
// materials, so full density is affordable on every device again.
//
// It also removed the per-second re-burst timer chain (emitters simply run while
// the celebration is on) and the per-frame pool scan.

import { engine, Entity, Transform, ParticleSystem } from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { gameState } from './phaseGate'
import { PSB_ALPHA } from './particleEnums'

// ── Cannon grid ───────────────────────────────────────────────────────────────
const CANNON_Y      = 18.0                // ceiling height (metres)
const CANNON_GRID_X = [7, 14, 21]
const CANNON_GRID_Z = [7, 15, 22]

// ── Piece look ────────────────────────────────────────────────────────────────
// No texture: an untextured quad IS a confetti piece. Billboarded so a piece is
// never edge-on and invisible; the spin below carries the tumble instead.
const SIZE_MIN = 0.20
const SIZE_MAX = 0.34
const LIFETIME_S = 5.5                    // ~4s to fall 18m, plus a beat on the floor
const SPIN_DEG_PER_S = { x: 40, y: 120, z: 300 }

// ── Motion ────────────────────────────────────────────────────────────────────
// gravity is a MULTIPLIER of -9.81, so a POSITIVE value falls (the stink
// emitters use a negative one to drift upward). 0.18 ≈ 1.8 m/s² — the gentle
// float the hand-rolled version was tuned to.
const GRAVITY = 0.18
const SPREAD_ANGLE = 32                   // cone half-angle, degrees
const SPREAD_RADIUS = 1.0                 // metres at the mouth
const SPEED_MIN = 0.3
const SPEED_MAX = 1.5

// ── Emission rates (particles per second, per cannon) ─────────────────────────
// Bumped across the board (playtest: "weak confetti is not visible, higher is
// much more visible, just bump things up"). The carried-over per-burst counts
// were tuned for 700 planes dumped at once; as a continuous per-second rate the
// weak end read as a few stray flecks across a whole nightclub.
//
// The LADDER still has to read at a glance — a poor shift should look poorer
// than a good one — so the steps widen rather than flatten.
const RATE_SUBOPTIMAL = 8
const RATE_ADEQUATE   = 13
const RATE_OPTIMAL    = 20
const RATE_FINALE     = 28
// rate x lifetime, with headroom: 28/s over 5.5s ≈ 154 live per cannon.
const MAX_PARTICLES_PER_CANNON = 180

// One-shot bursts (promotion, purchase) emit for this long, then close.
const ONE_SHOT_MS = 900

const PALETTE: Color4[] = [
  Color4.create(1.00, 0.20, 0.25, 1),  // red
  Color4.create(1.00, 0.82, 0.10, 1),  // gold
  Color4.create(0.20, 0.65, 1.00, 1),  // sky blue
  Color4.create(0.20, 0.90, 0.35, 1),  // lime
  Color4.create(0.90, 0.20, 0.90, 1),  // magenta
  Color4.create(1.00, 0.50, 0.10, 1),  // orange
  Color4.create(0.95, 0.95, 0.95, 1),  // silver
]

type Outcome = '' | 'perfect' | 'optimal' | 'adequate' | 'suboptimal'

const CANNONS: { x: number; y: number; z: number }[] = []
for (const z of CANNON_GRID_Z) for (const x of CANNON_GRID_X) CANNONS.push({ x, y: CANNON_Y, z })

// Which cannons fire, by outcome — a weak shift stays a sprinkle over the
// middle of the room, a strong one fills it.
function cannonsFor(outcome: Outcome, finale: boolean): { idx: number[]; rate: number } {
  if (finale) return { idx: [0, 1, 2, 3, 4, 5, 6, 7, 8], rate: RATE_FINALE }
  switch (outcome) {
    case 'perfect':
    case 'optimal':  return { idx: [0, 1, 2, 3, 4, 5, 6, 7, 8], rate: RATE_OPTIMAL }
    case 'adequate': return { idx: [1, 3, 4, 5, 7, 0, 8],       rate: RATE_ADEQUATE }
    default:         return { idx: [1, 3, 4, 5, 7],             rate: RATE_SUBOPTIMAL }
  }
}

const emitters: Entity[] = []
let oneShotTimer: ReturnType<typeof setTimeout> | null = null

/** Emitting or idle. Rate 0 rather than inactive, so pieces already in the air finish falling. */
function setRate(i: number, rate: number): void {
  const e = emitters[i]
  if (e === undefined) return
  const ps = ParticleSystem.getMutableOrNull(e)
  if (ps && ps.rate !== rate) ps.rate = rate
}

function allIdle(): void {
  for (let i = 0; i < emitters.length; i++) setRate(i, 0)
}

function fire(outcome: Outcome, finale: boolean): void {
  const { idx, rate } = cannonsFor(outcome, finale)
  const live = new Set(idx)
  for (let i = 0; i < emitters.length; i++) setRate(i, live.has(i) ? rate : 0)
}

/** Fires briefly then closes — for moments with no phase change to bracket them. */
function oneShot(outcome: Outcome): void {
  fire(outcome, false)
  if (oneShotTimer) clearTimeout(oneShotTimer)
  oneShotTimer = setTimeout(() => { oneShotTimer = null; allIdle() }, ONE_SHOT_MS)
}

/**
 * One-shot celebratory burst for a career promotion. Deliberately not the
 * looping celebration: a promotion lands during the intermission (or from an
 * admin grant mid-round), where a loop would either double up with the round's
 * own celebration or never be stopped.
 */
export function promotionBurst(): void { oneShot('perfect') }

/** Smaller nod for an upgrade purchase — same no-loop reasoning. */
export function purchaseBurst(): void { oneShot('suboptimal') }

export function launchCelebration(outcome: Outcome, finale = false): void {
  const resolved = (outcome === '' ? 'suboptimal' : outcome) as Outcome
  if (oneShotTimer) { clearTimeout(oneShotTimer); oneShotTimer = null }
  fire(resolved, finale)
  console.log(`[Confetti] Launch — outcome: "${resolved}"${finale ? ' [FINALE]' : ''}`)
}

function stopCelebration(): void {
  allIdle()
  console.log('[Confetti] Celebration stopped')
}

/** Admin test hook — stop emitting; pieces already falling finish their arc. */
export function stopCelebrationNow(): void { stopCelebration() }

export function initConfettiSystem(): void {
  for (let i = 0; i < CANNONS.length; i++) {
    const c = CANNONS[i]
    const e = engine.addEntity()
    // Rotated to aim the emission cone at the floor.
    Transform.create(e, {
      position: { x: c.x, y: c.y, z: c.z },
      rotation: Quaternion.fromEulerDegrees(180, 0, 0),
    })
    // Each cannon draws from a different pair of palette colours, so the room
    // still gets the whole palette even though one emitter can only range
    // between a start and an end colour.
    const a = PALETTE[i % PALETTE.length]
    const b = PALETTE[(i + 3) % PALETTE.length]
    ParticleSystem.create(e, {
      shape: ParticleSystem.Shape.Cone({ angle: SPREAD_ANGLE, radius: SPREAD_RADIUS }),
      rate: 0,                       // idle until a celebration starts
      maxParticles: MAX_PARTICLES_PER_CANNON,
      lifetime: LIFETIME_S,
      gravity: GRAVITY,
      initialVelocitySpeed: { start: SPEED_MIN, end: SPEED_MAX },
      initialSize:  { start: SIZE_MIN, end: SIZE_MAX },
      sizeOverTime: { start: 1, end: 1 },
      // Tumble. This quaternion is per-axis angular VELOCITY (the runtime
      // converts it to Euler XYZ), not an orientation.
      rotationOverTime: Quaternion.fromEulerDegrees(
        SPIN_DEG_PER_S.x, SPIN_DEG_PER_S.y, SPIN_DEG_PER_S.z,
      ),
      initialColor: { start: a, end: b },
      // Hold colour, then fade out over the fall.
      colorOverTime: {
        start: Color4.create(1, 1, 1, 1),
        end:   Color4.create(1, 1, 1, 0),
      },
      billboard: true,
      blendMode: PSB_ALPHA,
      active: true,
    })
    emitters.push(e)
  }
  console.log(`[Confetti] ${emitters.length} emitters ready (replaced a 700-plane pool), ceiling Y = ${CANNON_Y}`)

  // ── Phase watcher ───────────────────────────────────────────────────────────
  let lastPhase = ''
  engine.addSystem(() => {
    const gs = gameState()
    if (!gs || gs.phase === lastPhase) return
    const prev = lastPhase
    lastPhase  = gs.phase
    if (gs.phase === 'open'    && prev === 'playing') launchCelebration(gs.outcome as Outcome, gs.isFinale)
    if (gs.phase === 'playing' && prev === 'open')    stopCelebration()
    // The finale exits 'open' → 'lobby' (not 'playing'), so stop here too.
    if (gs.phase === 'lobby'   && prev === 'open')    stopCelebration()
  })
}
