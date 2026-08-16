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
import { getPlatform, isMobile } from '@dcl/sdk/platform'
import { platformSettled } from './platformWait'
import { gameState } from './phaseGate'

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

// ── Crowd size vs the client's avatar budget ──────────────────────────────────
// Every NPC is a real AvatarShape and competes with actual players for the
// explorer's avatar-rendering budget, which is far tighter on mobile. At the
// desktop sizes (9 dancers + 16 sitters = 25 avatars) a phone can exhaust that
// budget on NPCs alone, and real players stop being drawn — reported as "user
// cannot see other players after some rounds of clean the club" on iOS.
//
// Players must always win that contest, so mobile gets a much smaller crowd.
// The club still reads as populated; there are simply fewer extras.
const MAX_SITTERS_DESKTOP = 16
const MAX_SITTERS_MOBILE  = 4
const MAX_DANCERS_MOBILE  = 4

const SIT_DISCOVERY_TIMEOUT_MS = 10_000
const SITTER_BODY_CYCLE = [FEMALE, MALE]

// Fraction of the crowd that stays as "residents" between rounds (open, non-finale).
const RESIDENT_FRACTION = 0.25

// ── Pop / fade animation ───────────────────────────────────────────────────────
// Avatars pop in one at a time on a stagger (spreads the instantiation load) with a
// springy scale-up, and scale back down to leave.  When the FULL finale crowd
// leaves, the pop-outs are spread across FADE_OUT_TOTAL_MS so the club empties
// gradually rather than vanishing at once.
const SPAWN_STAGGER_MS         = 140    // gap between each avatar dropping IN
const POP_IN_MS                = 450    // drop-in duration
const POP_OUT_MS               = 500    // lift-out duration when leaving
const RESIDENT_POP_OUT_STAGGER_MS = 80  // quick exit for the small resident set
const FADE_OUT_TOTAL_MS        = 12_000 // window the FULL finale crowd leaves over
// Avatars stay at scale 1 ALWAYS (DCL's avatar renderer doesn't compose entity scale
// cleanly across the body/hair/nametag, which deforms hair). Reveal via POSITION
// instead: drop in from this height, lift back up to it on exit.
const DROP_HEIGHT = 1.0

// ── Names (consistent themed clubgoer names for ALL npcs) ──────────────────────
const NAMES: string[] = [
  'Rave', 'VIP', 'Lux', 'Hype', 'Feisty', 'Party', 'DJ', 'Echo', 'Jet', 'Riot',
  'Neon', 'Ace', 'Onyx', 'Legend', 'Flash', 'Glitz', 'Bex', 'CatLover', 'Moonwalker', 'Dancebot',
  'Glowbug', 'Shuffler', 'Cleaner', 'Blaze', 'Flirt', 'Fox', 'Menace', 'Trouble', 'Bandit', 'Mayhem',
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
// Dancers are always pushed to `specs` before any sitter, so counting them is
// enough to index sitters correctly regardless of the per-platform dancer cap.
const dancerCount = () => specs.filter((s) => s.kind === 'dancer').length
let rosterReady     = false
let rosterJustBuilt = false   // true for one tick after buildRoster; seeds lastKey without spawning

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

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)  // soft landing for the drop-in
const easeInCubic  = (t: number) => t * t * t               // accelerating lift for the exit

// Create a fresh avatar entity for `spec` at world height `y`. Each gets a unique id.
// Per-session nonce so avatar ids never collide with a previously-cached identity in
// the explorer. Without this, ids like `npc-dancer-Rave-1` repeat every deploy, and the
// explorer shows the CACHED (old) nametag for any id it has seen before — which is why
// renamed NPCs appear as a mix of old and new names until a full client restart.
const NPC_SESSION_NONCE = Math.floor(Math.random() * 1e9).toString(36)
let npcIdCounter = 0
function createAvatarEntity(spec: NpcSpec, y: number): Entity {
  const entity = engine.addEntity()
  Transform.create(entity, {
    position: { x: spec.position.x, y, z: spec.position.z },
    rotation: spec.rotation,
    scale:    { x: 1, y: 1, z: 1 },   // avatars stay at scale 1 always
  })
  AvatarShape.create(entity, {
    id:                         `npc-${NPC_SESSION_NONCE}-${spec.kind}-${spec.name}-${++npcIdCounter}`,
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
  return entity
}

// Instantiate the avatar entity for an NPC that is dropping in. Entities are created
// fresh each appearance and destroyed when hidden (see the pop-out path) — this
// avoids the floating-nametag problem (a hidden-but-alive AvatarShape keeps its tag)
// and the out-of-bounds-unload problem (parking far off-scene). Creation is
// staggered, so there's no instantiation spike.
function ensureEntity(npc: Npc) {
  if (npc.entity !== null) return
  npc.entity = createAvatarEntity(npc.spec, npc.spec.position.y + DROP_HEIGHT)  // start above the spot
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

// ── Coronation cheer ──────────────────────────────────────────────────────────
// Someone just made CLUB OWNER: every visible DANCER claps for a beat. Sitters
// keep their pose on purpose — an expression replaces the held sit emote and
// would leave them standing in their seats. No manual restore needed: the
// dance-loop re-trigger below resumes the dance once the cheer window closes
// (it skips writes while cheering so it can't stomp the applause mid-clap).
const CHEER_EMOTE = 'clap'
const CHEER_MS    = 8_000
let cheerUntilMs  = 0

export function crowdCheer(): void {
  cheerUntilMs = Date.now() + CHEER_MS
  let cheering = 0
  for (const npc of roster) {
    if (npc.spec.kind !== 'dancer') continue
    if (npc.phase !== 'in' && npc.phase !== 'idle') continue
    if (npc.entity === null) continue
    npc.stamp += 1
    const shape = AvatarShape.getMutable(npc.entity)
    shape.expressionTriggerId        = CHEER_EMOTE
    shape.expressionTriggerTimestamp = npc.stamp
    cheering++
  }
  console.log(`[NPC] coronation cheer — ${cheering} dancers applaud`)
}

function getPhase(): { phase: string; finale: boolean } {
  const gs = gameState()
  return gs ? { phase: gs.phase, finale: gs.isFinale } : { phase: 'playing', finale: false }
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
  // ── Sitter specs — discovered from the scene's "Sit Spot" smart items ────────
  const usedSpots = new Set<string>()
  const startMs   = Date.now()
  let dancersBuilt = false
  let maxSitters   = MAX_SITTERS_DESKTOP

  const discoverSitSpots = () => {
    // Crowd size depends on the platform, which resolves asynchronously — build
    // nothing until it is known, or a phone would get the full desktop crowd.
    if (!platformSettled()) return

    // ── Dancer specs — fixed floor coordinates ─────────────────────────────────
    if (!dancersBuilt) {
      dancersBuilt = true
      maxSitters   = isMobile() ? MAX_SITTERS_MOBILE : MAX_SITTERS_DESKTOP
      const maxDancers = isMobile() ? MAX_DANCERS_MOBILE : DANCER_DEFS.length
      for (let i = 0; i < Math.min(maxDancers, DANCER_DEFS.length); i++) {
        const d = DANCER_DEFS[i]
        specs.push(buildSpec(
          'dancer', i,
          d.bodyShape ?? FEMALE,
          d.position,
          Quaternion.fromEulerDegrees(0, d.rotationY ?? 0, 0),
          DANCE_EMOTE,
        ))
      }
    }

    if (usedSpots.size < maxSitters) {
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
        if (usedSpots.size >= maxSitters) break
        const tf = Transform.getOrNull(entity)
        if (!tf) continue   // transform not streamed in yet — retry next tick
        usedSpots.add(name)
        // Index off the dancers ACTUALLY built (fewer on mobile), not the full
        // DANCER_DEFS list, so the name/outfit cycles stay contiguous and unique.
        const idx  = dancerCount() + (usedSpots.size - 1)   // continue cycles
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

    if (usedSpots.size >= maxSitters || Date.now() - startMs > SIT_DISCOVERY_TIMEOUT_MS) {
      buildRoster()
      console.log(`[NPC] Crowd ready (${getPlatform() ?? 'unknown'}) — ${dancerCount()} dancers + ${usedSpots.size} sitters (${roster.filter(n => n.resident).length} residents)`)
      engine.removeSystem(discoverSitSpots)
    }
  }
  engine.addSystem(discoverSitSpots)

  // ── Presence + pop animation + dancer loop ───────────────────────────────────
  let lastKey    = ''
  let sinceLoopMs = 0
  // Long enough to sit well clear of FADE_OUT_TOTAL_MS transitions, short enough
  // that a stranded avatar is never on screen for long.
  let sinceReconcileMs = 0
  const RECONCILE_MS   = 15_000

  engine.addSystem((dt: number) => {
    if (!rosterReady) return
    const dtMs = dt * 1_000
    const { phase, finale } = getPhase()

    // React only on phase/finale transitions.
    const key = `${phase}|${finale}`
    if (key !== lastKey) {
      lastKey = key
      // First tick after roster builds: seed lastKey so we only respond to
      // transitions from here on, not to whatever transient state the server
      // happened to be in at roster-build time.
      if (!rosterJustBuilt) applyPresence(phase, finale)
      rosterJustBuilt = false
    }

    // ── Drift reconcile ────────────────────────────────────────────────────────
    // Presence is otherwise driven purely by phase-transition edges, so a single
    // missed or interrupted transition strands an avatar in the club forever —
    // and a stranded AvatarShape keeps its floating nametag, which is what put a
    // permanent "Party" clubgoer next to the scoreboard. Re-asserting the desired
    // state on a timer makes that self-healing: applyPresence only acts on
    // mismatches, so this is a no-op whenever the crowd is already correct.
    sinceReconcileMs += dtMs
    if (sinceReconcileMs >= RECONCILE_MS) {
      sinceReconcileMs = 0
      applyPresence(phase, finale)
      // Invariant: a hidden NPC must not still own an entity. Runs before the
      // all-hidden early-return below, which would otherwise skip the cleanup in
      // exactly the case where a stray avatar is the only thing left alive.
      for (const npc of roster) {
        if (npc.phase === 'hidden' && npc.entity !== null) {
          console.log(`[NPC] reclaiming stranded avatar "${npc.spec.name}"`)
          engine.removeEntity(npc.entity)
          npc.entity = null
        }
      }
    }

    // Empty club (everyone hidden) — nothing to animate or loop.
    if (!roster.some(n => n.phase !== 'hidden')) return

    // ── Pop animation (in / out) ───────────────────────────────────────────────
    for (const npc of roster) {
      if (npc.phase === 'hidden' || npc.phase === 'idle') continue
      npc.popMs += dtMs
      if (npc.popMs < 0) continue   // still in its stagger delay (no entity yet for 'in')

      const spec = npc.spec
      if (npc.phase === 'in') {
        // Create the avatar the moment its drop-in begins (deferred from the entering
        // diff so no entity — and no nametag — exists during the stagger wait).
        if (npc.entity === null) { ensureEntity(npc); retriggerEmote(npc) }
        const t = Math.min(1, npc.popMs / POP_IN_MS)
        const y = spec.position.y + DROP_HEIGHT * (1 - easeOutCubic(t))  // +1m → spot
        if (npc.entity !== null) {
          Transform.getMutable(npc.entity).position = { x: spec.position.x, y, z: spec.position.z }
        }
        if (t >= 1) { npc.phase = 'idle'; npc.popMs = 0 }
      } else if (npc.phase === 'out') {
        if (npc.entity === null) { npc.phase = 'hidden'; continue }
        const t = Math.min(1, npc.popMs / POP_OUT_MS)
        const y = spec.position.y + DROP_HEIGHT * easeInCubic(t)         // spot → +1m, then gone
        Transform.getMutable(npc.entity).position = { x: spec.position.x, y, z: spec.position.z }
        if (t >= 1) {
          engine.removeEntity(npc.entity)   // destroy — no lingering nametag, no off-scene unload
          npc.entity = null
          npc.phase  = 'hidden'
        }
      }
    }

    // ── Keep visible dancers looping by re-triggering the dance emote ──────────
    // Paused while a coronation cheer plays (the re-trigger would cut the clap
    // short); the accumulated timer then fires promptly after the window, so
    // the dance resumes without a manual restore pass.
    sinceLoopMs += dtMs
    if (sinceLoopMs >= DANCE_LOOP_MS && Date.now() >= cheerUntilMs) {
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
  rosterReady     = true
  rosterJustBuilt = true
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
