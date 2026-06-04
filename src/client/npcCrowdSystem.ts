// NPC crowd — a club crowd that fills the venue between rounds and goes full
// during the finale celebration.
//
// PRESENCE MODEL (by phase):
//   • playing            → club empty (players are cleaning)
//   • open, not finale   → a ~1/4 "resident" crowd hangs out (intermission vibe)
//   • open, finale       → the FULL crowd appears to celebrate
// Avatars are POOLED: each is created once then recycled (scaled in/out) on every
// transition instead of being destroyed and re-instantiated — far gentler on load.
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
const DANCE_EMOTE = 'tik'
// Re-trigger interval (ms) to keep the dance emote looping.
const DANCE_LOOP_MS = 2_000

// Seated poses — the SAME default emotes the "Sit Spot" smart item plays for
// players.  Set once and held (re-triggering would reset the pose).
const SIT_EMOTES = ['sittingChair1', 'sittingChair2']

const SIT_SPOT_PREFIX = 'Sit Spot_'
const MAX_SITTERS = 16
const SIT_DISCOVERY_TIMEOUT_MS = 10_000
const SITTER_BODY_CYCLE = [FEMALE, MALE]

// Fraction of the crowd that stays as "residents" between rounds (open, non-finale).
const RESIDENT_FRACTION = 0.25

// ── Pop / fade animation ───────────────────────────────────────────────────────
// Avatars pop in one at a time on a stagger (spreads the instantiation load) with a
// springy scale-up, and scale back down to leave.  When the FULL finale crowd
// leaves, the pop-outs are spread across FADE_OUT_TOTAL_MS so the club empties
// gradually rather than vanishing at once.
const SPAWN_STAGGER_MS         = 140    // gap between each avatar popping IN
const POP_IN_MS                = 380    // scale-up pop duration
const POP_OUT_MS               = 700    // scale-down duration when leaving (gentler)
const RESIDENT_POP_OUT_STAGGER_MS = 80  // quick exit for the small resident set
const FADE_OUT_TOTAL_MS        = 12_000 // window the FULL finale crowd fades out over

// ── Names (consistent themed clubgoer names for ALL npcs) ──────────────────────
const NAMES: string[] = [
  'Nova', 'Rex', 'Lux', 'Dex', 'Mira', 'Zara', 'Kai', 'Echo', 'Jet', 'Vega',
  'Cleo', 'Ash', 'Onyx', 'Ria', 'Milo', 'Suki', 'Bex', 'Cass', 'Niko', 'Indie',
  'Roux', 'Tam', 'Wren', 'Zane', 'Lia', 'Fox', 'Sol', 'Juno', 'Pax', 'Remy',
]
const nameFor = (i: number) => NAMES[i % NAMES.length]

// ── Outfits ──────────────────────────────────────────────────────────────────
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
}

// Dance-floor layout — real spots from the scene.
const DANCER_DEFS: DancerDef[] = [
  { position: { x: 15.75, y: 0.92, z: 13.25 }, rotationY:   5, bodyShape: FEMALE },
  { position: { x: 13.25, y: 0.92, z: 16.25 }, rotationY:  95, bodyShape: MALE   },
  { position: { x: 14.25, y: 0.92, z: 18.25 }, rotationY: 142, bodyShape: FEMALE },
  { position: { x: 18.52, y: 0.92, z: 17.20 }, rotationY: 245, bodyShape: MALE   },
  { position: { x: 19.15, y: 0.92, z: 15.45 }, rotationY: 280, bodyShape: FEMALE },
  { position: { x: 16.00, y: 2.35, z:  5.38 }, rotationY:   0, bodyShape: MALE   },
  { position: { x:  9.52, y: 0.82, z:  8.19 }, rotationY:  40, bodyShape: FEMALE },
  { position: { x: 22.50, y: 0.82, z:  8.19 }, rotationY: 320, bodyShape: MALE   },
  { position: { x: 21.13, y: 1.16, z: 26.41 }, rotationY: 206, bodyShape: FEMALE },
]

// ─────────────────────────────────────────────────────────────────────────────
// ── Specs + pooled runtime ─────────────────────────────────────────────────────
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

type PopPhase = 'hidden' | 'in' | 'idle' | 'out'
type Npc = {
  spec:     NpcSpec
  resident: boolean
  entity:   Entity | null   // null until first created; reused (pooled) thereafter
  phase:    PopPhase
  popMs:    number          // elapsed in current pop; negative = pre-stagger delay
  stamp:    number          // last expressionTriggerTimestamp written
}

const specs: NpcSpec[] = []
const roster: Npc[] = []
let rosterReady = false

function buildSpec(
  kind: NpcKind,
  index: number,
  bodyShape: string,
  position: { x: number; y: number; z: number },
  rotation: Quaternion,
  emote: string,
): NpcSpec {
  return {
    kind,
    name:      nameFor(index),
    bodyShape,
    position,
    rotation,
    emote,
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

// Instantiate the avatar entity for an NPC that is popping in. Entities are created
// fresh each appearance and destroyed when hidden (see the pop-out path) — this
// avoids the floating-nametag problem (a hidden-but-alive AvatarShape keeps its tag)
// and the out-of-bounds-unload problem (parking far off-scene). Creation is
// staggered, so there's no instantiation spike.
function ensureEntity(npc: Npc) {
  if (npc.entity !== null) return
  const spec = npc.spec
  const entity = engine.addEntity()
  Transform.create(entity, {
    position: { x: spec.position.x, y: spec.position.y, z: spec.position.z },
    rotation: spec.rotation,
    scale:    { x: 0.001, y: 0.001, z: 0.001 },  // pop-in scales it up
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
  npc.entity = entity
  npc.stamp  = 1
}

// Re-fire the held emote (used when a pooled avatar pops back in so it resumes its
// dance/sit pose instead of standing idle).
function retriggerEmote(npc: Npc) {
  if (npc.entity === null) return
  npc.stamp += 1
  const shape = AvatarShape.getMutable(npc.entity)
  shape.expressionTriggerId        = npc.spec.emote
  shape.expressionTriggerTimestamp = npc.stamp
}

function getPhase(): { phase: string; finale: boolean } {
  for (const [, gs] of engine.getEntitiesWith(GameState)) {
    return { phase: gs.phase, finale: gs.isFinale }
  }
  return { phase: 'playing', finale: false }
}

// Whether a given NPC should be present right now.
function wantsPresent(npc: Npc, phase: string, finale: boolean): boolean {
  if (phase !== 'open') return false   // empty club during active rounds
  if (finale) return true              // full crowd celebrates at the finale
  return npc.resident                  // ~1/4 hang out during normal intermissions
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
        const idx  = DANCER_DEFS.length + (usedSpots.size - 1)   // continue cycles
        const sIdx = usedSpots.size - 1
        specs.push(buildSpec(
          'sitter', idx,
          SITTER_BODY_CYCLE[sIdx % SITTER_BODY_CYCLE.length],
          { x: tf.position.x, y: tf.position.y, z: tf.position.z },
          { x: tf.rotation.x, y: tf.rotation.y, z: tf.rotation.z, w: tf.rotation.w },
          SIT_EMOTES[sIdx % SIT_EMOTES.length],
        ))
      }
    }

    if (usedSpots.size >= MAX_SITTERS || Date.now() - startMs > SIT_DISCOVERY_TIMEOUT_MS) {
      buildRoster()
      console.log(`[NPC] Crowd ready — ${DANCER_DEFS.length} dancers + ${usedSpots.size} sitters (${roster.filter(n => n.resident).length} residents)`)
      engine.removeSystem(discoverSitSpots)
    }
  }
  engine.addSystem(discoverSitSpots)

  // ── Presence + pop animation + dancer loop ───────────────────────────────────
  let lastKey    = ''
  let sinceLoopMs = 0

  engine.addSystem((dt: number) => {
    if (!rosterReady) return
    const dtMs = dt * 1_000
    const { phase, finale } = getPhase()

    // React only on phase/finale transitions.
    const key = `${phase}|${finale}`
    if (key !== lastKey) {
      lastKey = key
      applyPresence(phase, finale)
    }

    // Empty club (everyone hidden) — nothing to animate or loop.
    if (!roster.some(n => n.phase !== 'hidden')) return

    // ── Pop animation (in / out) ───────────────────────────────────────────────
    for (const npc of roster) {
      if (npc.phase === 'hidden' || npc.phase === 'idle') continue
      npc.popMs += dtMs
      if (npc.popMs < 0) continue   // still in its stagger delay (no entity yet for 'in')

      if (npc.phase === 'in') {
        // Create the avatar the moment its pop-in begins (deferred from the entering
        // diff so no entity — and no nametag — exists during the stagger wait).
        if (npc.entity === null) { ensureEntity(npc); retriggerEmote(npc) }
        const t = Math.min(1, npc.popMs / POP_IN_MS)
        const s = Math.max(0.001, easeOutBack(t))
        if (npc.entity !== null) Transform.getMutable(npc.entity).scale = { x: s, y: s, z: s }
        if (t >= 1) { npc.phase = 'idle'; npc.popMs = 0 }
      } else if (npc.phase === 'out') {
        if (npc.entity === null) { npc.phase = 'hidden'; continue }
        const t = Math.min(1, npc.popMs / POP_OUT_MS)
        const s = Math.max(0.001, 1 - t)
        Transform.getMutable(npc.entity).scale = { x: s, y: s, z: s }
        if (t >= 1) {
          engine.removeEntity(npc.entity)   // destroy — no lingering nametag, no off-scene unload
          npc.entity = null
          npc.phase  = 'hidden'
        }
      }
    }

    // ── Keep visible dancers looping by re-triggering the dance emote ──────────
    sinceLoopMs += dtMs
    if (sinceLoopMs >= DANCE_LOOP_MS) {
      sinceLoopMs = 0
      for (const npc of roster) {
        if (npc.spec.kind !== 'dancer') continue
        if (npc.phase !== 'in' && npc.phase !== 'idle') continue
        retriggerEmote(npc)
      }
    }
  })
}

// Build the pooled roster once the spec list is final; mark ~1/4 as residents,
// spread evenly across the crowd (every Nth) for a varied intermission mix.
function buildRoster() {
  const stride = Math.max(1, Math.round(1 / RESIDENT_FRACTION))  // 0.25 → every 4th
  for (let i = 0; i < specs.length; i++) {
    roster.push({ spec: specs[i], resident: i % stride === 0, entity: null, phase: 'hidden', popMs: 0, stamp: 1 })
  }
  rosterReady = true
}

// Diff the desired presence against current state and start staggered pop-ins /
// pop-outs.  A large exit (the full finale crowd leaving) is spread across
// FADE_OUT_TOTAL_MS; a small one (residents leaving) exits quickly.
function applyPresence(phase: string, finale: boolean) {
  const entering: Npc[] = []
  const leaving:  Npc[] = []
  for (const npc of roster) {
    const want  = wantsPresent(npc, phase, finale)
    const shown = npc.phase === 'in' || npc.phase === 'idle'
    if (want && !shown) entering.push(npc)
    else if (!want && shown) leaving.push(npc)
  }

  entering.forEach((npc, i) => {
    npc.phase = 'in'
    npc.popMs = -i * SPAWN_STAGGER_MS   // stagger; the entity is created when its pop-in starts
  })

  // Big exit → gradual fade window; small exit → quick.
  const stagger = leaving.length > roster.filter(n => n.resident).length
    ? FADE_OUT_TOTAL_MS / Math.max(1, leaving.length)
    : RESIDENT_POP_OUT_STAGGER_MS
  leaving.forEach((npc, i) => {
    npc.phase = 'out'
    npc.popMs = -i * stagger
  })
}
