// NPC crowd — a celebration crowd that ONLY appears during the final celebration
// (the finale "victory hold" after the last round).  During normal rounds and
// regular intermissions the club is empty of NPCs; when the finale begins the
// crowd spawns in, dances / sits, and is removed again when the finale ends.
//
// SIT SPOTS: the scene contains smart items named "Sit Spot_1" … "Sit Spot_33".
// Their transforms are discovered at runtime (by Name) so sitters land at the real
// seat positions/facings.  Seated NPCs use the same default emotes the smart item
// plays for players: sittingChair1 / sittingChair2.
//
// DANCERS: placed at the explicit floor coordinates in DANCER_DEFS below.
//
// Avatars are clothed via base-wearable URNs and given varied skin / hair colours.

import { engine, Entity, Transform, AvatarShape, Name } from '@dcl/sdk/ecs'
import { Quaternion, Color3 } from '@dcl/sdk/math'
import { GameState } from '../shared/schemas'

// ─────────────────────────────────────────────────────────────────────────────
// ── Config — edit freely ──────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const FEMALE = 'urn:decentraland:off-chain:base-avatars:BaseFemale'
const MALE   = 'urn:decentraland:off-chain:base-avatars:BaseMale'
const BASE   = 'urn:decentraland:off-chain:base-avatars:'

// Dancers only appear during the finale, so they go straight to the wildest dance.
// Swap for a custom emote URN if you ship a bespoke animation.
const DANCE_EMOTE = 'tik'
// Re-trigger interval (ms) to keep the dance emote looping.
const DANCE_LOOP_MS = 2_000

// Seated poses — the SAME default emotes the "Sit Spot" smart item plays for
// players.  Set once and held (re-triggering would reset the pose).
const SIT_EMOTES = ['sittingChair1', 'sittingChair2']

const SIT_SPOT_PREFIX = 'Sit Spot_'
// Cap how many sit spots get occupied (the scene has 33).  Mind the avatar budget.
const MAX_SITTERS = 16
// Give up looking for sit spots after this long (they stream in with the scene).
const SIT_DISCOVERY_TIMEOUT_MS = 10_000
// Rotate through these body shapes for variety as sitters are placed.
const SITTER_BODY_CYCLE = [FEMALE, MALE]

// ── Gradual spawn / pop animation ──────────────────────────────────────────────
// Avatars are created one at a time on a stagger (spreads the load — avoids the
// frame spike from instantiating the whole crowd at once) and each one "pops" in
// with a springy scale-up.  On finale end they pop back out and are removed.
const SPAWN_STAGGER_MS = 140    // gap between each avatar appearing
const POP_IN_MS        = 380    // scale-up pop duration
const POP_OUT_MS       = 260    // scale-down duration when leaving
const DESPAWN_STAGGER_MS = 60   // gap between each avatar starting its pop-out

// ── Outfits ──────────────────────────────────────────────────────────────────
// Each outfit is a set of base-wearable URNs (hair + upper + lower + feet).
// Unspecified slots (eyes/eyebrows/mouth) fall back to defaults.  Cycled per NPC.
const OUTFITS: string[][] = [
  [BASE + 'cornrows',        BASE + 'green_hoodie',          BASE + 'brown_pants',  BASE + 'sneakers'],
  [BASE + 'standard_hair',   BASE + 'blue_tshirt',           BASE + 'f_jeans',      BASE + 'bun_shoes'],
  [BASE + 'curly_hair',      BASE + 'black_top',             BASE + 'oxford_pants', BASE + 'sport_black_shoes'],
  [BASE + 'modern_hair',     BASE + 'sleeveless_punk_shirt', BASE + 'basketball_shorts', BASE + 'sneakers'],
  [BASE + 'shoulder_hair',   BASE + 'f_sweater',             BASE + 'brown_pants',  BASE + 'bun_shoes'],
  [BASE + 'casual_hair_01',  BASE + 'red_tshirt',            BASE + 'jean_shorts',  BASE + 'sport_black_shoes'],
]

// ── Colour variation (any colour goes) ─────────────────────────────────────────
const SKIN_TONES: Color3[] = [
  Color3.create(0.95, 0.78, 0.66),
  Color3.create(0.88, 0.69, 0.55),
  Color3.create(0.74, 0.57, 0.43),
  Color3.create(0.60, 0.46, 0.36),
  Color3.create(0.45, 0.33, 0.24),
  Color3.create(0.32, 0.22, 0.16),
]
const HAIR_COLORS: Color3[] = [
  Color3.create(0.09, 0.07, 0.05),  // black
  Color3.create(0.28, 0.16, 0.06),  // brown
  Color3.create(0.80, 0.62, 0.28),  // blonde
  Color3.create(0.55, 0.13, 0.07),  // auburn
  Color3.create(0.62, 0.62, 0.66),  // silver
  Color3.create(0.85, 0.30, 0.55),  // fun pink
]

type DancerDef = {
  position:  { x: number; y: number; z: number }
  rotationY?: number
  bodyShape?: string
  name?:      string
}

// Dance-floor layout — real spots from the scene.  rotationY faces roughly toward
// the dance-floor centre for a coherent cluster.
const DANCER_DEFS: DancerDef[] = [
  { position: { x: 15.75, y: 0.92, z: 13.25 }, rotationY:   5, bodyShape: FEMALE, name: 'Nova' },
  { position: { x: 13.25, y: 0.92, z: 16.25 }, rotationY:  95, bodyShape: MALE,   name: 'Rex'  },
  { position: { x: 14.25, y: 0.92, z: 18.25 }, rotationY: 142, bodyShape: FEMALE, name: 'Lux'  },
  { position: { x: 18.52, y: 0.92, z: 17.20 }, rotationY: 245, bodyShape: MALE,   name: 'Dex'  },
  { position: { x: 19.15, y: 0.92, z: 15.45 }, rotationY: 280, bodyShape: FEMALE, name: 'Mira' },
  { position: { x: 16.00, y: 2.35, z:  5.38 }, rotationY:   0, bodyShape: MALE,   name: 'Zara' },
  { position: { x:  9.52, y: 0.82, z:  8.19 }, rotationY:  40, bodyShape: FEMALE, name: 'Kai'  },
  { position: { x: 22.50, y: 0.82, z:  8.19 }, rotationY: 320, bodyShape: MALE,   name: 'Echo' },
  { position: { x: 21.13, y: 1.16, z: 26.41 }, rotationY: 206, bodyShape: FEMALE, name: 'Jet'  },
]

// ─────────────────────────────────────────────────────────────────────────────
// ── Specs (computed once) → spawned only during the finale ─────────────────────
// ─────────────────────────────────────────────────────────────────────────────

type NpcKind = 'dancer' | 'sitter'
type NpcSpec = {
  kind:      NpcKind
  name:      string
  bodyShape: string
  position:  { x: number; y: number; z: number }
  rotation:  Quaternion
  emote:     string        // dance emote (dancers) or held sit pose (sitters)
  wearables: string[]
  skinColor: Color3
  hairColor: Color3
}

type PopState = 'in' | 'idle' | 'out'
type NpcRuntime = {
  entity:  Entity
  spec:    NpcSpec
  stamp:   number     // last expressionTriggerTimestamp written
  popState: PopState
  popMs:    number    // elapsed ms in the current pop phase
}

const specs: NpcSpec[] = []
const live:  NpcRuntime[] = []

// Spawn queue — specs waiting to pop in, drained on the SPAWN_STAGGER_MS cadence.
let spawnQueue: NpcSpec[] = []
let spawnAccMs = 0

function buildSpec(
  kind: NpcKind,
  index: number,
  name: string,
  bodyShape: string,
  position: { x: number; y: number; z: number },
  rotation: Quaternion,
  emote: string,
): NpcSpec {
  return {
    kind, name, bodyShape, position, rotation, emote,
    wearables: OUTFITS[index % OUTFITS.length],
    skinColor: SKIN_TONES[index % SKIN_TONES.length],
    hairColor: HAIR_COLORS[(index * 2 + 1) % HAIR_COLORS.length],
  }
}

// easeOutBack — overshoots slightly past 1.0 then settles, giving a springy "pop".
function easeOutBack(t: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  const p  = t - 1
  return 1 + c3 * p * p * p + c1 * p * p
}

function createNpc(spec: NpcSpec) {
  const entity = engine.addEntity()
  // Start invisible-small; the pop-in system scales it up.
  Transform.create(entity, {
    position: spec.position,
    rotation: spec.rotation,
    scale:    { x: 0.001, y: 0.001, z: 0.001 },
  })
  AvatarShape.create(entity, {
    id:                         `npc-${spec.kind}-${spec.name}`,
    name:                       spec.name,
    bodyShape:                  spec.bodyShape,
    wearables:                  spec.wearables,
    emotes:                     [],
    skinColor:                  spec.skinColor,
    hairColor:                  spec.hairColor,
    eyeColor:                   Color3.create(0.3, 0.22, 0.15),
    expressionTriggerId:        spec.emote,
    expressionTriggerTimestamp: 1,
  })
  live.push({ entity, spec, stamp: 1, popState: 'in', popMs: 0 })
}

// Begin a gradual spawn — queue all specs; the spawn system drains them on a stagger.
function beginSpawn() {
  // Clear any leftover avatars instantly (shouldn't normally happen).
  for (const npc of live) engine.removeEntity(npc.entity)
  live.length = 0
  spawnQueue = specs.slice()
  spawnAccMs = 0
  console.log(`[NPC] Finale crowd spawning gradually — ${spawnQueue.length} avatars`)
}

// Begin a graceful exit — stop queuing new spawns and pop everyone back out.
function beginDespawn() {
  spawnQueue = []
  let delay = 0
  for (const npc of live) {
    // Negative popMs acts as a stagger delay before the pop-out starts.
    npc.popState = 'out'
    npc.popMs    = -delay
    delay += DESPAWN_STAGGER_MS
  }
  console.log('[NPC] Finale crowd fading out')
}

function isFinaleNow(): boolean {
  for (const [, gs] of engine.getEntitiesWith(GameState)) {
    return gs.phase === 'open' && gs.isFinale
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Init ──────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export function initNpcCrowdSystem(): void {
  // ── Dancer specs — fixed floor coordinates ───────────────────────────────────
  for (let i = 0; i < DANCER_DEFS.length; i++) {
    const d = DANCER_DEFS[i]
    specs.push(buildSpec(
      'dancer', i,
      d.name ?? `Dancer ${i + 1}`,
      d.bodyShape ?? FEMALE,
      d.position,
      Quaternion.fromEulerDegrees(0, d.rotationY ?? 0, 0),
      DANCE_EMOTE,
    ))
  }

  // ── Sitter specs — discovered from the scene's "Sit Spot" smart items ────────
  const usedSpots = new Set<string>()
  const startMs   = Date.now()

  const discoverSitSpots = () => {
    if (usedSpots.size < MAX_SITTERS) {
      const found: { name: string; entity: Entity }[] = []
      for (const [e] of engine.getEntitiesWith(Name)) {
        const n = Name.get(e).value
        if (!n.startsWith(SIT_SPOT_PREFIX) || usedSpots.has(n)) continue
        found.push({ name: n, entity: e })
      }
      found.sort((a, b) => {
        const ai = parseInt(a.name.slice(SIT_SPOT_PREFIX.length), 10) || 0
        const bi = parseInt(b.name.slice(SIT_SPOT_PREFIX.length), 10) || 0
        return ai - bi
      })

      for (const { name, entity } of found) {
        if (usedSpots.size >= MAX_SITTERS) break
        const tf = Transform.getOrNull(entity)
        if (!tf) continue   // transform not streamed in yet — retry next tick
        usedSpots.add(name)
        const idx = DANCER_DEFS.length + (usedSpots.size - 1)   // continue colour/outfit cycle
        const sIdx = usedSpots.size - 1
        specs.push(buildSpec(
          'sitter', idx,
          `Guest ${sIdx + 1}`,
          SITTER_BODY_CYCLE[sIdx % SITTER_BODY_CYCLE.length],
          { x: tf.position.x, y: tf.position.y, z: tf.position.z },
          { x: tf.rotation.x, y: tf.rotation.y, z: tf.rotation.z, w: tf.rotation.w },
          SIT_EMOTES[sIdx % SIT_EMOTES.length],
        ))
      }
    }

    if (usedSpots.size >= MAX_SITTERS || Date.now() - startMs > SIT_DISCOVERY_TIMEOUT_MS) {
      console.log(`[NPC] Crowd ready — ${DANCER_DEFS.length} dancers + ${usedSpots.size} sitters (spawn on finale)`)
      engine.removeSystem(discoverSitSpots)
      // If the finale somehow started while we were still discovering, spawn now.
      if (isFinaleNow()) beginSpawn()
    }
  }
  engine.addSystem(discoverSitSpots)

  // ── Finale presence + gradual spawn / pop animation / dancer loop ────────────
  let present     = false
  let sinceLoopMs = 0

  engine.addSystem((dt: number) => {
    const dtMs   = dt * 1_000
    const finale = isFinaleNow()

    // Enter / leave the finale.
    if (finale && !present) { present = true;  beginSpawn();   sinceLoopMs = 0 }
    if (!finale && present) { present = false; beginDespawn() }

    // ── Drain the spawn queue on a stagger (only while present) ────────────────
    if (present && spawnQueue.length > 0) {
      spawnAccMs += dtMs
      while (spawnAccMs >= SPAWN_STAGGER_MS && spawnQueue.length > 0) {
        spawnAccMs -= SPAWN_STAGGER_MS
        createNpc(spawnQueue.shift()!)
      }
    }

    // ── Pop animation (in / out) + cleanup ─────────────────────────────────────
    for (let i = live.length - 1; i >= 0; i--) {
      const npc = live[i]
      npc.popMs += dtMs

      if (npc.popState === 'in') {
        const t = Math.min(1, npc.popMs / POP_IN_MS)
        const s = Math.max(0.001, easeOutBack(t))
        Transform.getMutable(npc.entity).scale = { x: s, y: s, z: s }
        if (t >= 1) { npc.popState = 'idle'; npc.popMs = 0 }
      } else if (npc.popState === 'out') {
        if (npc.popMs < 0) continue   // still in its stagger delay
        const t = Math.min(1, npc.popMs / POP_OUT_MS)
        const s = Math.max(0.001, 1 - t)
        Transform.getMutable(npc.entity).scale = { x: s, y: s, z: s }
        if (t >= 1) { engine.removeEntity(npc.entity); live.splice(i, 1) }
      }
    }

    // ── Keep dancers looping by re-triggering the dance emote periodically ─────
    if (present) {
      sinceLoopMs += dtMs
      if (sinceLoopMs >= DANCE_LOOP_MS) {
        sinceLoopMs = 0
        for (const npc of live) {
          if (npc.spec.kind !== 'dancer' || npc.popState === 'out') continue
          npc.stamp += 1
          const shape = AvatarShape.getMutable(npc.entity)
          shape.expressionTriggerId        = npc.spec.emote
          shape.expressionTriggerTimestamp = npc.stamp
        }
      }
    }
  })
}
