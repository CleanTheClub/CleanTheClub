// Rubbish carrying — client mirror + big-bag deposit clicks.
//
// READ-ONLY MIRROR of the server's carry state (same contract as
// progressionStore): the server owns the count and capacity, this module caches
// the last carriedUpdate so the HUD chip can render and rubbishSystem can
// pre-empt pickups that the server would refuse anyway.
//
// Deliberately does NOT import from ../ui — ui.tsx imports this module for the
// chip, and a toast import back the other way would create a cycle. Deposit
// feedback is the sparkle + sound + the chip zeroing itself.

import { engine, Entity, Name, Transform, pointerEventsSystem, InputAction, TextShape, Billboard, GltfContainer, AvatarAttach, AvatarAnchorPointType, ParticleSystem, MeshCollider, PlayerIdentityData, ColliderLayer } from '@dcl/sdk/ecs'
import { onOwnAddress } from './localPlayer'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { RubbishType } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from './sceneItemHelpers'
import { DUMPSTER_PREFIX, BIN_CAPACITY, BIN_STINK_FRACTION, themeModelSrc, MODEL_SIZE_M, ITEM_MINI_TARGET_M } from '../shared/config'
import { carryGearModel, GEAR_DEFAULT } from '../shared/progression'
import { requestSetup } from './spawnDirector'
import { pointerMaxDist, gameState } from './phaseGate'
import { playHoverSound, playDepositSound, playMissSound } from './soundManager'
import { playSparkle } from './sparkleSystem'
import { getCareerOrEmpty, upgradeLevel, getFlexGear } from './progressionStore'
import { setCarryPose } from './emoteManager'
import { PSB_ALPHA } from './particleEnums'

// REAL bin models, discovered by name prefix — the placeholder cubes are gone.
// The scene ships four stations (two per floor), each pairing a Bin_General_N
// and a Bin_Recycling_N at a SHARED entity origin (the meshes are offset inside
// the GLBs, on a common stand). That shared origin means origin-centred box
// colliders would overlap — so pointer events bind to the bins' own visible
// meshes instead (setupClickProxy with addBox=false), which also gives the
// hover outline on the exact bin you're aiming at.
const BIN_PREFIXES: Array<{ prefix: string; type: RubbishType }> = [
  { prefix: 'Bin_General',   type: 'general' },
  { prefix: 'Bin_Recycling', type: 'recycle' },
]

// Hover prompts stay per-type — the painted bin labels plus these prompts do
// the type teaching now that real art is in place.
const BIN_HOVER: Record<RubbishType, string> = {
  general: 'Empty general waste',
  recycle: 'Empty recycling',
}

// ── Bin locations ─────────────────────────────────────────────────────────────
// Recorded at discovery so the first-pickup nudge can point at the nearest one.
const binPositions: Array<{ x: number; y: number; z: number }> = []
// Discovered bin models + authored scales, for the per-stream fill pulse and
// the haul return spot (found by Name).
const binVisuals: Array<{ name: string; entity: Entity; type: RubbishType; base: { x: number; y: number; z: number } }> = []

// ── First-pickup nudge ────────────────────────────────────────────────────────
// The permanent "EMPTY BINS" text over every station is gone: it was scaffolding
// from when bins were placeholder cubes, and floating text over real, labelled,
// colour-coded props reads as debug UI.
//
// What a new player genuinely cannot guess is that rubbish FILLS YOUR HANDS and
// needs a trip. So the signpost is now a single teaching moment: on a brand-new
// player's first pickup, one marker appears over the nearest bin, then fades.
// Never shown again — a veteran's screen stays clean.
const NUDGE_SECONDS = 9
let nudgeEntity: Entity | null = null
let nudgeUntilMs = 0
let nudgeDone    = false

/** True only for a player who has never completed a shift, once per session. */
export function shouldNudgeToBin(): boolean {
  return !nudgeDone && getCareerOrEmpty().shifts === 0 && binPositions.length > 0
}

/** Spawns the one-time marker over whichever bin is closest to the player. */
export function triggerBinNudge(): void {
  if (!shouldNudgeToBin()) return
  nudgeDone = true

  const p = Transform.getOrNull(engine.PlayerEntity)?.position
  let best = binPositions[0]
  if (p) {
    let bestD = Infinity
    for (const b of binPositions) {
      const dx = b.x - p.x, dy = b.y - p.y, dz = b.z - p.z
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) { bestD = d; best = b }
    }
  }

  nudgeEntity = engine.addEntity()
  Transform.create(nudgeEntity, { position: { x: best.x, y: best.y + 2.4, z: best.z } })
  TextShape.create(nudgeEntity, {
    text: 'EMPTY HERE',
    fontSize: 4,
    textColor: Color4.create(1, 0.82, 0.25, 1),
    outlineColor: Color4.Black(),
    outlineWidth: 0.2,
  })
  Billboard.create(nudgeEntity, {})
  nudgeUntilMs = Date.now() + NUDGE_SECONDS * 1000
}

function nudgeSystem(): void {
  if (!nudgeEntity) return
  const left = nudgeUntilMs - Date.now()
  if (left <= 0) {
    engine.removeEntity(nudgeEntity)
    nudgeEntity = null
    return
  }
  // Fade out over the final second rather than vanishing.
  if (left < 1000) {
    const ts = TextShape.getMutableOrNull(nudgeEntity)
    if (ts) {
      const a = left / 1000
      ts.textColor    = Color4.create(1, 0.82, 0.25, a)
      ts.outlineColor = Color4.create(0, 0, 0, a)
    }
  }
}

// ── Carried haul (visible in hand) ────────────────────────────────────────────
// The bag hangs off the player's hand while carrying, growing with the load —
// and the ACTUAL picked-up items ride on top of it, so the armful you see is
// the armful you collected. LOCAL ONLY: other players don't see it, because
// carry counts are sent point-to-point and broadcasting per pickup would undo
// the request diet.
//
// Mechanics: pickup handlers report each item's model src (noteCarriedModel);
// the newest MAX_VISIBLE_ITEMS of those render as minis parented to the hand
// anchor. The queue is trimmed to the SERVER's carried total on every update,
// so a rejected clean (full hands, phase gate) self-corrects — the server
// count is the truth, the srcs are just decoration on it.
// Container ON — the user's Box_Wearable (torn cardboard tier-1 carrier).
// Longer-term plan stands: per-Strength tier models (box → bag → trolley) as a
// visible capacity/status signal.
//
// Model is PROP-AUTHORED: origin at the box's base, centred (min-y 0.000).
const SHOW_CARRY_CONTAINER = true
const BAG_MODEL  = 'assets/scene/Models/Box_Wearable/Box_Wearable.glb'

/**
 * Props attached to a HAND must not collide with anything. Scene props ship
 * real colliders (the bins are clickable; Vacuum.glb has a Vacuum_collider
 * mesh), and by default a GltfContainer's visible meshes get CL_PHYSICS and
 * its invisible ones get CL_PHYSICS too — so the moment a bin was in hand its
 * collider shoved the player around and movement felt stuck (playtest).
 *
 * CL_CUSTOM1 is a layer nothing in this scene uses: no physics against the
 * player, and no pointer either (so a held prop can't eat clicks meant for the
 * world). Preferred over CL_NONE, which the docs flag as having known issues.
 */
// Per-gear position nudge, in metres, added to BAG_OFFSET.
//
// The rig assumes the Box_Wearable convention: origin at the base, centred on
// X/Z. Two gear models were authored off that — Janitor_Caddy's mesh sits
// 0.428m forward of its origin and Gold_Wheelie_Bin 0.058m below — so without
// this they'd hang in front of / through the hand. MEASURED, not eyeballed
// (negated mesh-bbox centre). Delete an entry once its GLB is re-exported with
// a centred base origin.
const GEAR_FIT: Record<string, { x: number; y: number; z: number }> = {
  Janitor_Caddy:    { x: 0.015, y: 0,     z: -0.428 },
  Gold_Wheelie_Bin: { x: 0.001, y: 0.058, z: 0.033 },
  Gold_Dustpan:     { x: 0,     y: 0.052, z: 0.094 },
}
const NO_FIT = { x: 0, y: 0, z: 0 }
const gearFitFor = (src: string) =>
  GEAR_FIT[src.slice(src.lastIndexOf('/') + 1).replace('.glb', '')] ?? NO_FIT

const HELD_PROP_COLLIDERS = {
  visibleMeshesCollisionMask:   ColliderLayer.CL_CUSTOM1,
  invisibleMeshesCollisionMask: ColliderLayer.CL_CUSTOM1,
}

/**
 * This player's carry container. Derived from their own upgrade mirror rather
 * than a message: it's cosmetic-only, the server resolves it independently for
 * everyone else (carryPublic.gear), and reading it locally means the swap lands
 * the instant a purchase confirms. Hold-test overrides it for the fitting room.
 */
function gearContainerSrc(): string {
  // EVERY upgrade the ladder reads — passing only `vacuum` (a leftover from when
  // the ladder was vacuum-only) meant the owner stayed on the cardboard box
  // while the server, which sees the whole record, showed everyone else the
  // right gear: "my carry box upgraded globally but not locally" (playtest).
  // flexGear (pedestal showpieces) overrides the ladder; it's mirrored from the
  // server, which validated the achievement, so this stays a pure read.
  const name = carryGearModel({
    carryCapacity: upgradeLevel('carryCapacity'),
    portableBin:   upgradeLevel('portableBin'),
    vacuum:        upgradeLevel('vacuum'),
  }, getFlexGear())
  return name === GEAR_DEFAULT ? BAG_MODEL : themeModelSrc(name)
}

/**
 * What is actually in the player's hand right now.
 *
 * On the OUT leg the full bin REPLACES the container outright — it used to ride
 * on top of the box as a mini, which read as "carrying a bin inside a box".
 * Once it's tipped into the dumpster (stage 'back') the hands go back to the
 * normal container, so the walk home looks like ordinary work.
 */
function heldContainerSrc(holdTestSrc: string | null): string {
  if (holdTestSrc) return holdTestSrc
  // The bin stays in hand for BOTH legs — out to the dumpster and back to its
  // station. The carry box only returns once the bin is docked (returnBin
  // clears `hauling`), which is what actually reads as finishing the trip.
  if (hauling !== '') {
    return themeModelSrc(hauling === 'recycle' ? 'Bin_Recycling' : 'Bin_General')
  }
  return gearContainerSrc()
}
// Box is 0.41m wide at scale 1 — carried size is right as authored.
const BAG_MIN    = 0.85
const BAG_MAX    = 1.1
// LEFT-HAND AvatarAttach — the only zero-lag option (a scene-tick follower
// reads the player transform a frame behind the renderer's smoothing, so the
// box dragged ~10cm at walk speed; renderer-side attachment can't lag).
//
// COUNTER-ROTATION, computed not guessed: the Avatar_LeftHand world rotation
// in the carry pose was composed from Carry_emote.glb itself (skeleton rest
// transforms x first-keyframe animation rotations, root-to-hand). This
// quaternion is its exact inverse — verified to map the box's up-axis to
// world-up in that pose. Recompute if the carry emote's arm pose is re-
// authored (scripts: compose chain at t=0, conjugate, normalise).
// In the countered frame, BAG_OFFSET is avatar-intuitive again:
// x = left/right, y = up, z = forward (palm sits ~6cm beyond the wrist bone).
const BAG_OFFSET      = { x: 0, y: 0.10, z: 0.06 }

// ── Full-container cue ────────────────────────────────────────────────────────
// A full box REEKS: at capacity a stink cloud wafts out of the opening — the
// same green waft as dirty items, so the language is already taught. (Replaced
// an amber pulse shell: the stink reads diegetically as "gross, empty me".)
const FULL_STINK_TEXTURE = 'assets/scene/Particles/stink_waft.png'
const RIG_COUNTER_ROT = { x: 0.5328, y: -0.5063, z: -0.3442, w: -0.5843 }
// Residual fix: the runtime avatar skeleton's bone REST axes differ from the
// emote GLB's (the explorer retargets), leaving one CONSTANT rotation after
// the computed counter — screenshots show a ~90° roll. Tuned here, in the
// countered (avatar-ish) frame.
// Residual between the computed counter-rotation and the runtime skeleton's
// bone rest axes — dialled in with the (since removed) live tuner, 2026-08-04.
const RIG_FINE_TUNE_DEG = { x: -30, y: 0, z: 210 }

const MAX_VISIBLE_ITEMS = 6
// Fallback only — used when a model isn't in MODEL_SIZE_M (see miniScaleFor).
const ITEM_MINI_SCALE   = 0.21
// Fixed jumble — offsets climb up out of the bag, rotations vary per slot so
// the pile reads as a pile rather than a printed stack.
// Normalises a carried item to ITEM_MINI_TARGET_M along its longest axis, so
// props authored at different mesh scales all read the same size in the hand.
const warnedUnmeasured = new Set<string>()
function miniScaleFor(src: string): number {
  const name = src.slice(src.lastIndexOf('/') + 1).replace('.glb', '')
  const native = MODEL_SIZE_M[name]
  if (!native || native <= 0) {
    if (!warnedUnmeasured.has(name)) {
      warnedUnmeasured.add(name)
      console.log(`[CARRY] '${name}' has no MODEL_SIZE_M entry — mini uses the flat fallback scale (regenerate the table)`)
    }
    return ITEM_MINI_SCALE
  }
  return ITEM_MINI_TARGET_M / native
}

const ITEM_SLOTS = [
  { pos: { x:  0.04, y: 0.16, z:  0.02 }, rot: { x: 10, y:   0, z:  15 } },
  { pos: { x: -0.05, y: 0.19, z: -0.03 }, rot: { x: -8, y:  60, z: -20 } },
  { pos: { x:  0.02, y: 0.22, z: -0.04 }, rot: { x: 20, y: 130, z:   5 } },
  { pos: { x: -0.03, y: 0.25, z:  0.03 }, rot: { x: -15, y: 200, z: 25 } },
  { pos: { x:  0.05, y: 0.28, z: -0.01 }, rot: { x:  5, y: 270, z: -12 } },
  { pos: { x: -0.04, y: 0.31, z:  0.00 }, rot: { x: -20, y: 330, z: 18 } },
]

// Per-gear pile fit, metres, added to every ITEM_SLOTS position. ITEM_SLOTS is
// tuned for containers with WALLS (the pile pokes out of the box/crate/caddy
// opening); open flex gear needs the pile moved to its actual resting surface
// (KJ screenshots 2026-08-16: bags hovered at shoulder height off the dustpan).
// Offsets DERIVED FROM MESH BBOXES (scripts: GLB accessor min/max), not eyed:
//   Gold_Platter  flat plate, rim y≈0.03            → drop to just above it
//   Gold_Dustpan  pan floor y≈0.03, tray centre z≈+0.14 past the GEAR_FIT
//                 shift (handle runs back/up)       → drop AND push forward
//   Disco_Ball    open bowl, rim y≈0.21             → nestle slightly in
// Ice_Bucket keeps the box-tuned pile on purpose — it has walls, and minis
// poking out of the bucket mouth is the same read as the box.
const MINI_PILE_FIT: Record<string, { x: number; y: number; z: number }> = {
  Gold_Platter: { x: 0, y: -0.13, z: 0 },
  Gold_Dustpan: { x: 0, y: -0.09, z: 0.20 },
  Disco_Ball:   { x: 0, y: -0.03, z: 0 },
}
const NO_PILE_FIT = { x: 0, y: 0, z: 0 }
let appliedPileFitKey = ''

const pileFitFor = (src: string) =>
  MINI_PILE_FIT[src.slice(src.lastIndexOf('/') + 1).replace('.glb', '')] ?? NO_PILE_FIT

let carryAnchor: Entity | null = null
let carryRig: Entity | null = null
let bagEntity: Entity | null = null
let fullStinkEntity: Entity | null = null

// ── Refusal bounce ────────────────────────────────────────────────────────────
// When a pickup is refused for full hands, the whole carried load does one
// quick bulge — the box itself says "no room". Pulses the RIG, so the box and
// the item pile jiggle together. One bump (sine half-wave), ~0.35s.
const REFUSE_PULSE_S   = 0.35
const REFUSE_PULSE_AMP = 0.22
let refusePulseT = -1   // -1 = idle; else elapsed seconds

/** Called by the pickup systems when a clean is pre-empted for full hands. */
export function pulseCarryBox(): void {
  if (carryRig) refusePulseT = 0
}

function refusePulseSystem(dt: number): void {
  if (refusePulseT < 0) return
  const tf = carryRig && Transform.getMutableOrNull(carryRig)
  if (!tf) { refusePulseT = -1; return }
  refusePulseT += dt
  if (refusePulseT >= REFUSE_PULSE_S) {
    tf.scale = { x: 1, y: 1, z: 1 }
    refusePulseT = -1
    return
  }
  const k = 1 + REFUSE_PULSE_AMP * Math.sin((refusePulseT / REFUSE_PULSE_S) * Math.PI)
  tf.scale = { x: k, y: k, z: k }
}
const slotEntities: Entity[] = []
const carriedModels: string[] = []

/** Pickup handlers report the model of each item as it's grabbed. */
export function noteCarriedModel(src: string | undefined): void {
  if (!src) return
  carriedModels.push(src)
  if (carriedModels.length > 24) carriedModels.shift()   // hard bound, safety only
}

// ── Admin hold-test ───────────────────────────────────────────────────────────
// Preview a model riding the carry rig — same left-hand attach, counter-
// rotation, pose and emote as the box. Local-only visual, for auditing
// candidate carry props ("test holding them").
//
// Resolved by MODELS PATH first (assets/scene/Models/<name>/<name>.glb), so it
// keeps working for gear models that are no longer PLACED in the scene — the
// gear set used to sit parked in the composite purely to stay loaded, and the
// preload list now does that job instead. A placed-entity Name lookup remains
// as the fallback for auditing arbitrary scene props.
let holdTestSrc: string | null = null
export function setCarryHoldTest(name: string | null): void {
  holdTestSrc = null
  if (name) {
    holdTestSrc = themeModelSrc(name)
    if (!MODEL_SIZE_M[name]) {
      // Not a known models-folder GLB — try a placed entity with that Name.
      let placed: string | null = null
      for (const [entity] of engine.getEntitiesWith(Name)) {
        if (Name.get(entity).value !== name) continue
        const gltfEnt = findGltfEntity(entity) ?? entity
        placed = GltfContainer.getOrNull(gltfEnt)?.src ?? null
        break
      }
      if (placed) holdTestSrc = placed
      else console.log(`[CARRY] hold-test: '${name}' not in MODEL_SIZE_M and no placed GLB by that Name — trying the models path anyway`)
    }
  }
  // Tear the rig down so the container model swaps cleanly on rebuild.
  if (carryAnchor) {
    engine.removeEntityWithChildren(carryAnchor)
    carryAnchor = null
    carryRig = null
    bagEntity = null
    fullStinkEntity = null
    slotEntities.length = 0
  }
  refreshCarriedBag()
}

// ── Mop-time gear stow ────────────────────────────────────────────────────────
// While a mop hold is active the held container (most visibly the Vacuum) is
// STOWED — the mop emote is a two-handed animation, and a vacuum glued to the
// left hand through it read as a glitch. Scale-hide on the anchor, NOT a rig
// teardown: teardown would drop and re-stream the gear GLB every single patch
// (and mobile has form on evicting GLBs — see the emote rewarm notes), while a
// 0.001 scale is the same cheap trick the hauled station bins use. The
// carriedModels queue, fill scale and stink emitter all survive untouched, so
// un-stowing is exact. LOCAL-ONLY, like the rig itself for the local player.
//
// InteractionManager drives this every frame from the hold state machine
// (stowed ⇔ a hold is active), so EVERY exit path — skill hit, miss, run to
// 100%, cleanRejected, phase change, scene re-entry — restores the gear
// without needing its own call. The setter diffs, so per-frame calls are free.
let mopStowed = false
export function setCarryStowedForMop(on: boolean): void {
  if (mopStowed === on) return
  mopStowed = on
  applyMopStow()
}
function applyMopStow(): void {
  if (!carryAnchor) return
  const tf = Transform.getMutableOrNull(carryAnchor)
  if (!tf) return
  tf.scale = mopStowed ? { x: 0.001, y: 0.001, z: 0.001 } : { x: 1, y: 1, z: 1 }
}

function refreshCarriedBag(): void {
  const total = carriedGeneral + carriedRecycle
  const holdTest = holdTestSrc !== null
  // Dumpster haul: the hands hold the overflowing BIN BAG itself — carry pose,
  // box at max size, a bag riding it, permanent stink. Reads physically.
  const haulDisplay = hauling !== ''
  // Upper-body carry pose tracks whether the hands are full.
  setCarryPose(holdTest || haulDisplay || total > 0)
  if (!holdTest && !haulDisplay && total <= 0) {
    if (carryAnchor) {
      engine.removeEntityWithChildren(carryAnchor)
      carryAnchor = null
      carryRig = null
      bagEntity = null
      fullStinkEntity = null
      slotEntities.length = 0
    }
    carriedModels.length = 0
    return
  }

  // Server count is authoritative — drop oldest decorations past it.
  // (Not while hauling: carried is 0 then, and the bag mini is forced below.)
  if (!haulDisplay) while (carriedModels.length > total) carriedModels.shift()

  if (!carryAnchor) {
    // Unscaled anchor on the hand; bag and minis are children so the bag can
    // grow without inflating the items riding on it.
    carryAnchor = engine.addEntity()
    Transform.create(carryAnchor, {})
    AvatarAttach.create(carryAnchor, { anchorPointId: AvatarAnchorPointType.AAPT_LEFT_HAND })

    // Shared rig carries the counter-rotation so box + pile tip together.
    carryRig = engine.addEntity()
    Transform.create(carryRig, {
      parent:   carryAnchor,
      rotation: currentRigRotation(),
    })

    if (SHOW_CARRY_CONTAINER || holdTest) {
      bagEntity = engine.addEntity()
      Transform.create(bagEntity, { parent: carryRig, position: BAG_OFFSET })
      GltfContainer.create(bagEntity, { src: heldContainerSrc(holdTestSrc), ...HELD_PROP_COLLIDERS })
    }
  }

  // Container model follows the player's GEAR, so a mid-shift Vacuum purchase
  // swaps the prop immediately instead of waiting for the next hands-empty
  // teardown. Diffed — createOrReplace on an unchanged src would re-stream the
  // GLB every refresh.
  if (bagEntity) {
    const want = heldContainerSrc(holdTestSrc)
    if (GltfContainer.getOrNull(bagEntity)?.src !== want) {
      GltfContainer.createOrReplace(bagEntity, { src: want, ...HELD_PROP_COLLIDERS })
      // Off-convention origins get corrected here, so every gear model sits in
      // the hand the same way the starter box does.
      const fit = gearFitFor(want)
      Transform.getMutable(bagEntity).position = {
        x: BAG_OFFSET.x + fit.x, y: BAG_OFFSET.y + fit.y, z: BAG_OFFSET.z + fit.z,
      }
    }
  }

  // Container scales with how full the hands are — a full load looks heavier.
  // Origin is at the box base on the vertical axis (prop-authored), so scaling
  // grows it in place; the offset no longer needs to move with size.
  // A hauled bin shows at native scale; the container otherwise grows with load.
  const binInHand = hauling !== ''
  const vacMode = !holdTest && !binInHand && usingVacuum()
  const frac = binInHand ? 1 : Math.min(1, total / Math.max(1, capacity))
  // Hold-test shows the auditioned model at its native scale — judge it raw.
  // The vacuum swells noticeably more than the box — the machine IS the pile.
  const size = holdTest || binInHand ? 1
    : vacMode ? 0.9 + 0.5 * frac
    : BAG_MIN + (BAG_MAX - BAG_MIN) * frac
  const bagTf = bagEntity && Transform.getMutableOrNull(bagEntity)
  if (bagTf) bagTf.scale = { x: size, y: size, z: size }

  // Stink cloud appears exactly at capacity, disappears the moment space frees.
  // A hauled FULL bin stinks all the way out; the emptied bin rides home clean.
  // Hold-test props never stink — it's a fitting room, not a shift.
  const full = !holdTest && ((haulDisplay && haulStage === 'out')
    || (!haulDisplay && (vacMode ? frac >= BIN_STINK_FRACTION : total >= capacity)))
  if (full && !fullStinkEntity && carryRig) {
    fullStinkEntity = engine.addEntity()
    Transform.create(fullStinkEntity, {
      parent:   carryRig,
      position: { x: BAG_OFFSET.x, y: BAG_OFFSET.y + 0.30, z: BAG_OFFSET.z },
    })
    ParticleSystem.create(fullStinkEntity, {
      shape: ParticleSystem.Shape.Cone({ angle: 25, radius: 0.12 }),
      rate: 5,
      maxParticles: 8,
      lifetime: 1.6,
      gravity: -0.04,
      initialVelocitySpeed: { start: 0.15, end: 0.3 },
      initialSize:  { start: 0.22, end: 0.35 },
      sizeOverTime: { start: 0.9, end: 2.2 },
      initialColor: {
        start: Color4.create(0.3, 0.9, 0.05, 0.85),
        end:   Color4.create(0.5, 1.0, 0.2,  0.75),
      },
      colorOverTime: {
        start: Color4.create(0.2, 0.75, 0.05, 0.4),
        end:   Color4.create(0.1, 0.5,  0.05, 0.0),
      },
      texture:   { src: FULL_STINK_TEXTURE },
      billboard: true,
      blendMode: PSB_ALPHA,
      loop: true,
      prewarm: true,
      active: true,
    })
  } else if (!full && fullStinkEntity) {
    engine.removeEntity(fullStinkEntity)
    fullStinkEntity = null
  }

  // Newest items on top of the pile; slots are reused, never re-created.
  // While hauling the single decoration is the BIN itself (the one that
  // vanished from its station). Hold-test shows the audited model alone.
  // No minis while hauling (the bin IS the held prop) — and none on the
  // vacuum: sucked rubbish is INSIDE it, so the machine swells instead.
  const visible = holdTest || haulDisplay || vacMode ? [] : carriedModels.slice(-MAX_VISIBLE_ITEMS)
  // Gear changed to/from a fitted container → re-seat the recycled slots at
  // the new pile position (positions are otherwise only written at creation).
  const pileFit = pileFitFor(heldContainerSrc(holdTestSrc))
  const pileFitKey = `${pileFit.x}|${pileFit.y}|${pileFit.z}`
  if (pileFitKey !== appliedPileFitKey) {
    appliedPileFitKey = pileFitKey
    for (let i = 0; i < MAX_VISIBLE_ITEMS; i++) {
      const s = slotEntities[i]
      if (!s) continue
      const def = ITEM_SLOTS[i]
      Transform.getMutable(s).position = {
        x: BAG_OFFSET.x + def.pos.x + pileFit.x,
        y: BAG_OFFSET.y + def.pos.y + pileFit.y,
        z: BAG_OFFSET.z + def.pos.z + pileFit.z,
      }
    }
  }
  for (let i = 0; i < MAX_VISIBLE_ITEMS; i++) {
    const src = visible[i]
    if (src) {
      if (!slotEntities[i]) {
        const slot = engine.addEntity()
        const def = ITEM_SLOTS[i]
        Transform.create(slot, {
          parent:   carryRig ?? undefined,
          position: {
            x: BAG_OFFSET.x + def.pos.x + pileFit.x,
            y: BAG_OFFSET.y + def.pos.y + pileFit.y,
            z: BAG_OFFSET.z + def.pos.z + pileFit.z,
          },
          rotation: Quaternion.fromEulerDegrees(def.rot.x, def.rot.y, def.rot.z),
          scale:    { x: ITEM_MINI_SCALE, y: ITEM_MINI_SCALE, z: ITEM_MINI_SCALE },
        })
        slotEntities[i] = slot
      }
      const cur = GltfContainer.getOrNull(slotEntities[i])
      if (cur?.src !== src) {
        GltfContainer.createOrReplace(slotEntities[i], { src, ...HELD_PROP_COLLIDERS })
        // Slots are recycled between items, so the scale has to follow the model.
        const ms = miniScaleFor(src)
        Transform.getMutable(slotEntities[i]).scale = { x: ms, y: ms, z: ms }
      }
    } else if (slotEntities[i] && GltfContainer.getOrNull(slotEntities[i])) {
      GltfContainer.deleteFrom(slotEntities[i])
    }
  }

  // A refresh can REBUILD the anchor (fresh Transform, scale 1) while a mop
  // hold is mid-flight — e.g. a carriedUpdate landing during the hold — so the
  // stow is re-applied after every rebuild, not only from the setter.
  applyMopStow()
}

function currentRigRotation(): Quaternion {
  return Quaternion.multiply(
    RIG_COUNTER_ROT as Quaternion,
    Quaternion.fromEulerDegrees(RIG_FINE_TUNE_DEG.x, RIG_FINE_TUNE_DEG.y, RIG_FINE_TUNE_DEG.z),
  )
}

function refreshMarkers(): void {
  refreshCarriedBag()
}


let carriedGeneral = 0
let carriedRecycle = 0
let capacity     = 5      // matches the un-upgraded baseline until the server answers
let portableLeft = 0      // Portable Bin self-empties remaining this shift
let known        = false  // no carriedUpdate yet — hide the chip rather than guess
let hauling: '' | 'general' | 'recycle' = ''   // stream of the bin in hand
let haulStage: '' | 'out' | 'back' = ''        // full bin → dumpster | empty bin → home
let haulBinName = ''                            // which bin (its return spot)

// Last deposit (time + size), read by ui.tsx for the "+N BINNED!" flash — a
// getter rather than a ui import, which would cycle.
let lastDepositMs    = -1
let lastDepositCount = 0
let lastDepositType: RubbishType = 'general'
export const getLastDeposit = () => ({ ms: lastDepositMs, count: lastDepositCount, type: lastDepositType })

// No confetti on deposits — REMOVED after two rounds of playtest confusion
// ("random confetti bursts", then "confetti when I deposit? weird"). The
// deposit's own feedback is the "+N BINNED!" flash + sound; confetti now only
// fires for LABELED moments (PERFECT streaks, promotions, purchases, disaster
// clears), so a burst always has a visible reason on screen.
function recordDeposit(count: number, type: RubbishType = 'general'): void {
  lastDepositMs    = Date.now()
  lastDepositCount = count
  lastDepositType  = type
}

export const getCarried        = (): number => carriedGeneral + carriedRecycle
export const getCarriedGeneral = (): number => carriedGeneral
export const getCarriedRecycle = (): number => carriedRecycle
export const getCarryCapacity  = (): number => capacity
export const getPortableLeft   = (): number => portableLeft
export const isCarryKnown      = (): boolean => known
export const getHauling        = (): '' | 'general' | 'recycle' => hauling
export const getHaulStage      = (): '' | 'out' | 'back' => haulStage
// The dumpster bag counts as full hands — every pickup gate reads this.
/**
 * Client-side haul state, for the admin readout. Mobile can't be attached to a
 * console and preview has no auth server, so the only way to see this state on
 * a phone is to render it — server truth vs what our visuals believe.
 */
export const getHaulDebug = () => ({
  hauling, haulStage, haulBinName,
  carried: carriedGeneral + carriedRecycle,
  ownKnown: ownAddress !== '',
  ghosts: remoteCarries.size,
})

/** True while the player's ACTIVE container is the Vacuum (not hauling a bin,
 *  not a flex showpiece). Vacuum changes the pickup FEEL: no bend-down emote,
 *  no item pile on top — rubbish is sucked, so the machine itself swells,
 *  pulses and reeks with the load instead. */
export function usingVacuum(): boolean {
  if (hauling !== '') return false
  return carryGearModel({
    carryCapacity: upgradeLevel('carryCapacity'),
    portableBin:   upgradeLevel('portableBin'),
    vacuum:        upgradeLevel('vacuum'),
  }, getFlexGear()) === 'Vacuum'
}

export const isCarryFull       = (): boolean => known && (hauling !== '' || carriedGeneral + carriedRecycle >= capacity)

// Per-bin fill levels, parsed from GameState's packed "name:count" string.
// Memoised on the raw string so the split runs once per server change rather
// than once per bin per tick.
let fillsRaw = '\u0000'
const fills = new Map<string, number>()
function binFillMap(): Map<string, number> {
  const raw = gameState()?.binFills ?? ''
  if (raw === fillsRaw) return fills
  fillsRaw = raw
  fills.clear()
  if (raw !== '') {
    for (const pair of raw.split(',')) {
      const i = pair.lastIndexOf(':')
      if (i > 0) fills.set(pair.slice(0, i), Number(pair.slice(i + 1)) || 0)
    }
  }
  return fills
}
const binFillClient = (name: string): number  => binFillMap().get(name) ?? 0
const binFullClient = (name: string): boolean => binFillClient(name) >= BIN_CAPACITY
/** Fullest single bin, 0..1 — drives the station piles and stink. */
function binMaxFillFrac(): number {
  let max = 0
  for (const [, n] of binFillMap()) if (n > max) max = n
  return Math.min(1, max / BIN_CAPACITY)
}

/** Portable Bin: empty on the spot (both streams). Server re-validates. */
export function requestPortableEmpty(): void {
  if (!known || getCarried() === 0 || portableLeft === 0) return
  playDepositSound()
  recordDeposit(getCarried())
  room.send('portableEmpty', { dummy: true })
}

// ── Remote carry visuals ──────────────────────────────────────────────────────
// What OTHER players carry, attached to THEIR avatars (avatarId form of
// AvatarAttach — the same trick as career plates). Without this, remote
// viewers saw the carry emote play over visibly empty hands (live test).
type RemoteCarry = { anchor: Entity; bag: Entity; lastSrc: string }
const remoteCarries = new Map<string, RemoteCarry>()

// address → station bin name that player is currently hauling ('' = none).
// Station-bin visibility is CLIENT-owned: the server's old Transform write on
// the bin entity never replicated (composite entities aren't synced), so the
// hauled bin used to stay visibly at its station for everyone. Each client now
// hides/restores bins from its own haul state + these broadcast remote hauls.
const remoteHauls = new Map<string, string>()
let ownAddress = ''

function removeRemoteCarry(address: string): void {
  remoteHauls.delete(address)
  const rc = remoteCarries.get(address)
  if (!rc) return
  engine.removeEntityWithChildren(rc.anchor)
  remoteCarries.delete(address)
}

function updateRemoteCarry(address: string, total: number, capacity: number, hauling: string, haulStage: string, gear: string): void {
  const show = total > 0 || hauling !== ''
  if (!show) { removeRemoteCarry(address); return }

  let rc = remoteCarries.get(address)
  if (!rc) {
    const anchor = engine.addEntity()
    Transform.create(anchor, {})
    AvatarAttach.create(anchor, { avatarId: address, anchorPointId: AvatarAnchorPointType.AAPT_LEFT_HAND })
    const rig = engine.addEntity()
    Transform.create(rig, { parent: anchor, rotation: currentRigRotation() })
    const bag = engine.addEntity()
    Transform.create(bag, { parent: rig, position: BAG_OFFSET })
    rc = { anchor, bag, lastSrc: '' }
    remoteCarries.set(address, rc)
  }
  // The bin is in hand for the whole round trip; gear (box, or the Vacuum once
  // bought) shows only when not hauling.
  const binOut = hauling !== ''
  const src = binOut
    ? themeModelSrc(hauling === 'recycle' ? 'Bin_Recycling' : 'Bin_General')
    : themeModelSrc(gear || GEAR_DEFAULT)
  if (rc.lastSrc !== src) {
    GltfContainer.createOrReplace(rc.bag, { src, ...HELD_PROP_COLLIDERS })
    const fit = gearFitFor(src)
    Transform.getMutable(rc.bag).position = {
      x: BAG_OFFSET.x + fit.x, y: BAG_OFFSET.y + fit.y, z: BAG_OFFSET.z + fit.z,
    }
    rc.lastSrc = src
  }
  const frac = binOut ? 1 : Math.min(1, total / Math.max(1, capacity))
  const size = binOut ? 1 : BAG_MIN + (BAG_MAX - BAG_MIN) * frac
  Transform.getMutable(rc.bag).scale = { x: size, y: size, z: size }
}

export function initCarrySystem(): void {
  // Own address, to skip self in the public carry broadcasts (the local rig
  // already renders our own hands). Resolution + retries live in localPlayer.
  onOwnAddress((addr) => {
    ownAddress = addr
    console.log(`[CARRY] own address resolved (${ownAddress.slice(0, 8)}…)`)
    // Any carryPublic that arrived BEFORE the address landed was treated as
    // another player's and rendered as a remote prop attached to our OWN
    // avatar — and it stuck to the hand forever (local teardown never touches
    // remoteCarries; every later message is skipped by the self-check).
    removeRemoteCarry(ownAddress)
  })

  room.onMessage('carryPublic', (data) => {
    const addr = data.address.toLowerCase()
    // Until we know our OWN address we cannot tell our broadcast from anyone
    // else's — and mistaking ours for a stranger's attaches a bin to our own
    // avatar that local teardown never touches (it lives in remoteCarries), so
    // it stays in hand forever. Briefly missing another player's box is the far
    // cheaper failure, so skip entirely until getUserData has answered.
    // Desktop resolves this fast; mobile is where it bites.
    if (ownAddress === '' || addr === ownAddress) return
    const mid = data.haulStage === 'out' || data.haulStage === 'back'
    remoteHauls.set(addr, mid ? (data.haulBinName ?? '') : '')
    updateRemoteCarry(addr, data.total, data.capacity, data.hauling, data.haulStage, data.gear ?? '')
  })

  // Sweep for departed players every few seconds — their avatar is gone but
  // the attach entity would linger otherwise.
  let remoteSweepAcc = 0
  engine.addSystem((dt: number) => {
    remoteSweepAcc += dt
    if (remoteSweepAcc < 5) return
    remoteSweepAcc = 0
    if (remoteCarries.size === 0) return
    const present = new Set<string>()
    for (const [, data] of engine.getEntitiesWith(PlayerIdentityData)) {
      present.add(data.address.toLowerCase())
    }
    for (const [addr] of remoteCarries) {
      if (!present.has(addr)) removeRemoteCarry(addr)
    }
  })
  room.onMessage('carriedUpdate', (data) => {
    carriedGeneral = data.carriedGeneral
    carriedRecycle = data.carriedRecycle
    capacity       = data.capacity
    portableLeft   = data.portableLeft
    const prevStage = haulStage
    hauling        = data.hauling === 'general' || data.hauling === 'recycle' ? data.hauling : ''
    haulStage      = data.haulStage === 'out' || data.haulStage === 'back' ? data.haulStage : ''
    haulBinName    = data.haulBinName ?? ''
    if (prevStage !== haulStage) {
      console.log(`[HAUL] server says stage '${prevStage || 'none'}' -> '${haulStage || 'none'}' (bin='${haulBinName || '-'}', carried=${data.carriedGeneral + data.carriedRecycle})`)
    }
    known          = true
    refreshMarkers()
  })

  // Discover the placed bin models by name prefix. ('Bins_Stand' and the 'Bins'
  // group match neither prefix, so the dressing stays inert.)
  let found = 0
  for (const [entity] of engine.getEntitiesWith(Name)) {
    const n = Name.get(entity).value
    const def = BIN_PREFIXES.find((b) => n.startsWith(b.prefix))
    if (!def) continue
    found++
    const type = def.type
    const stationPos = Transform.getOrNull(entity)?.position
    if (stationPos) binPositions.push({ x: stationPos.x, y: stationPos.y, z: stationPos.z })
    // Authored scale captured for the fill-pulse (the bin breathes around it).
    const binTf = Transform.getOrNull(entity)
    binVisuals.push({
      name: n, entity, type,
      base: binTf ? { x: binTf.scale.x, y: binTf.scale.y, z: binTf.scale.z } : { x: 1, y: 1, z: 1 },
    })

    requestSetup({
      isReady: () => findGltfEntity(entity) !== undefined,
      run: () => {
        const gltfEnt = findGltfEntity(entity)
        if (!gltfEnt) return
        // addBox=false: the paired bins share an origin, so origin-centred boxes
        // would overlap — the visible meshes themselves are the click targets
        // (and give the hover outline on the exact bin being aimed at).
        const clickEnt = setupClickProxy(gltfEnt, false)
        pointerEventsSystem.onPointerHoverEnter({ entity: clickEnt }, () => playHoverSound())
        pointerEventsSystem.onPointerDown(
          // Slightly longer reach than items — bins are destinations you walk
          // at, and cutting the prompt at 4m felt unresponsive on approach.
          { entity: clickEnt, opts: { button: InputAction.IA_POINTER, hoverText: BIN_HOVER[type], maxDistance: pointerMaxDist() } },
          () => {
            if (!known) return
            // Overflowed stream: the bin dispenses its FULL BAG instead of
            // taking deposits — empty hands shoulder it (the persistent FULL
            // marker above the station carries the instruction).
            if (binFullClient(n)) {
              // Already hauling a bin — hands are literally full of bin.
              if (hauling !== '') { playMissSound(); return }
              playDepositSound(type)   // bin-grab thunk
              // Whatever we're carrying is tipped in as the bag comes up (the
              // server does the same), so flash it like a normal deposit.
              const armful = getCarried()
              if (armful > 0) recordDeposit(armful, type)
              room.send('takeFullBag', { binType: type, binName: n })
              return
            }
            const inStream = type === 'general' ? carriedGeneral : carriedRecycle
            if (inStream === 0) {
              // Wrong bin (or empty hands): a soft "nope" — the chip's colours
              // show where the load actually belongs.
              if (getCarried() > 0) playMissSound()
              return
            }
            playDepositSound(type)
            const p = Transform.getOrNull(entity)?.position
            if (p) playSparkle({ x: p.x, y: p.y + 1.2, z: p.z })
            recordDeposit(inStream, type)
            room.send('depositRubbish', { binType: type, binName: n })
          },
        )
      },
    })
  }
  // ── Dumpsters — the haul destination outside the club ────────────────────────
  let dumpsters = 0
  const dumpsterPositions: Array<{ x: number; y: number; z: number }> = []
  for (const [entity] of engine.getEntitiesWith(Name)) {
    if (!Name.get(entity).value.startsWith(DUMPSTER_PREFIX)) continue
    dumpsters++
    const p = Transform.getOrNull(entity)?.position
    if (p) dumpsterPositions.push({ x: p.x, y: p.y, z: p.z })
    requestSetup({
      isReady: () => findGltfEntity(entity) !== undefined,
      run: () => {
        const gltfEnt = findGltfEntity(entity)
        if (!gltfEnt) return
        const clickEnt = setupClickProxy(gltfEnt, false)
        pointerEventsSystem.onPointerHoverEnter({ entity: clickEnt }, () => playHoverSound())
        pointerEventsSystem.onPointerDown(
          { entity: clickEnt, opts: { button: InputAction.IA_POINTER, hoverText: 'Dumpster', maxDistance: pointerMaxDist() } },
          () => {
            // Only a FULL bin dumps here; the return leg belongs at the station.
            if (hauling === '' || haulStage !== 'out') { playMissSound(); return }
            playDepositSound(hauling)
            const p2 = Transform.getOrNull(entity)?.position
            if (p2) playSparkle({ x: p2.x, y: p2.y + 1.5, z: p2.z })
            recordDeposit(1, hauling)
            room.send('dumpsterEmpty', { dummy: true })
          },
        )
      },
    })
  }

  // ── Haul-state markers — billboards carry the instructions, since this module
  // can't import ui toasts (cycle). One per bin station when a stream overflows;
  // one per dumpster while YOU are hauling. Toggled by a slow poll.
  const stationKeys = new Set<string>()
  const stationMarkerAnchors: Array<{ x: number; y: number; z: number }> = []
  for (const p of binPositions) {
    const key = `${Math.round(p.x)}:${Math.round(p.z)}`
    if (stationKeys.has(key)) continue
    stationKeys.add(key)
    stationMarkerAnchors.push(p)
  }
  const makeMarker = (p: { x: number; y: number; z: number }, text: string, color: Color4): Entity => {
    const e = engine.addEntity()
    Transform.create(e, { position: { x: p.x, y: p.y + 2.4, z: p.z }, scale: { x: 0.001, y: 0.001, z: 0.001 } })
    TextShape.create(e, { text, fontSize: 3, textColor: color, outlineColor: Color4.Black(), outlineWidth: 0.15 })
    Billboard.create(e, { billboardMode: 2 })   // BM_Y — yaw only, like nametags
    return e
  }
  // Bin names AT each station, parallel to stationMarkerAnchors — fills are
  // per-bin now, so each station reports only its own.
  const stationBinNames: string[][] = stationMarkerAnchors.map((a) => {
    const key = `${Math.round(a.x)}:${Math.round(a.z)}`
    return binVisuals
      .filter((b) => {
        const p = Transform.getOrNull(b.entity)?.position
        return !!p && `${Math.round(p.x)}:${Math.round(p.z)}` === key
      })
      .map((b) => b.name)
  })
  const fullMarkers = stationMarkerAnchors.map((p) =>
    makeMarker(p, 'BIN FULL —\nTAKE IT OUT!', Color4.create(1, 0.45, 0.25, 1)))
  const dumpMarkers = dumpsterPositions.map((p) =>
    makeMarker(p, 'EMPTY THE BIN HERE', Color4.create(1, 0.82, 0.25, 1)))

  // ── Station fill visuals — the BINS are the gauge: each bin breathe-pulses
  // harder as ITS stream fills (general bins track general, recycling track
  // recycling), and station stink ramps from a waft to a plume. (A junk-bag
  // pile on the lids "just didn't read" — playtest.)
  const STATION_STINK_Y = 1.55
  // Stink emitters are CREATED/REMOVED on threshold crossings, never paused —
  // a paused emitter leaves live particles sinking through the floor (the
  // party-mode stink lesson).
  const stationStinks: Array<Entity | null> = stationMarkerAnchors.map(() => null)
  const makeStationStink = (p: { x: number; y: number; z: number }): Entity => {
    const e = engine.addEntity()
    Transform.create(e, { position: { x: p.x, y: p.y + STATION_STINK_Y, z: p.z } })
    ParticleSystem.create(e, {
      shape: ParticleSystem.Shape.Cone({ angle: 25, radius: 0.18 }),
      rate: 4,
      maxParticles: 8,
      lifetime: 1.8,
      gravity: -0.04,
      initialVelocitySpeed: { start: 0.15, end: 0.3 },
      initialSize:  { start: 0.28, end: 0.4 },
      sizeOverTime: { start: 0.9, end: 2.2 },
      initialColor: {
        start: Color4.create(0.3, 0.9, 0.05, 0.85),
        end:   Color4.create(0.5, 1.0, 0.2,  0.75),
      },
      colorOverTime: {
        start: Color4.create(0.2, 0.75, 0.05, 0.4),
        end:   Color4.create(0.1, 0.5,  0.05, 0.0),
      },
      texture:   { src: FULL_STINK_TEXTURE },
      billboard: true,
      blendMode: PSB_ALPHA,
      loop: true,
      prewarm: true,
      active: true,
    })
    return e
  }

  // Return-leg click target + marker at the hauled bin's empty station spot.
  let returnTarget: Entity | null = null
  let returnMarker: Entity | null = null
  // Whether any bin is currently scale-pulsing (one restore pass on idle).
  let binsPulsed = false
  // Station bins currently hidden because someone (us or a remote player) is
  // hauling them. Recomputed on the 0.5s cadence; the fill-pulse skips these.
  const hiddenBins = new Set<string>()
  // Marker visibility change-guards — the old version rewrote every marker's
  // Transform each 0.5s tick whether or not anything changed.
  const lastStationFull: boolean[] = []
  let lastShowDump = false

  let markerAcc = 0
  engine.addSystem((dt: number) => {
    markerAcc += dt
    if (markerAcc < 0.5) return
    markerAcc = 0

    // ── Station-bin visibility (own haul + broadcast remote hauls) ─────────
    const hauledNow = new Set<string>()
    if (haulStage !== '' && haulBinName !== '') hauledNow.add(haulBinName)
    for (const [, binName] of remoteHauls) if (binName !== '') hauledNow.add(binName)
    for (const b of binVisuals) {
      const shouldHide = hauledNow.has(b.name)
      if (shouldHide === hiddenBins.has(b.name)) continue
      const tf = Transform.getMutableOrNull(b.entity)
      if (!tf) continue
      if (shouldHide) {
        hiddenBins.add(b.name)
        tf.scale = { x: 0.001, y: 0.001, z: 0.001 }
      } else {
        hiddenBins.delete(b.name)
        tf.scale = { x: b.base.x, y: b.base.y, z: b.base.z }
      }
    }
    // A station shouts only if a bin AT THAT STATION is full — a blanket
    // "BINS FULL" would send players to stations that are perfectly fine.
    for (let i = 0; i < fullMarkers.length; i++) {
      const show = hauling === '' && stationBinNames[i].some((n) => binFullClient(n))
      if (show === lastStationFull[i]) continue
      lastStationFull[i] = show
      Transform.getMutable(fullMarkers[i]).scale =
        show ? { x: 1, y: 1, z: 1 } : { x: 0.001, y: 0.001, z: 0.001 }
    }
    // Dumpsters call only while the FULL bin is out; the return leg points home.
    const showDump = haulStage === 'out'
    if (showDump !== lastShowDump) {
      lastShowDump = showDump
      for (const m of dumpMarkers) {
        Transform.getMutable(m).scale = showDump ? { x: 1, y: 1, z: 1 } : { x: 0.001, y: 0.001, z: 0.001 }
      }
    }
    // Return leg: a marker + click target appear at the hauled bin's empty spot.
    if (haulStage === 'back' && haulBinName !== '') {
      const home = binVisuals.find((b) => b.name === haulBinName)
      const p = home && Transform.getOrNull(home.entity)?.position
      if (p && returnTarget === null) {
        returnTarget = engine.addEntity()
        Transform.create(returnTarget, { position: { x: p.x, y: p.y + 0.7, z: p.z } })
        MeshCollider.setBox(returnTarget)
        Transform.getMutable(returnTarget).scale = { x: 1.4, y: 1.4, z: 1.4 }
        pointerEventsSystem.onPointerDown(
          { entity: returnTarget, opts: { button: InputAction.IA_POINTER, hoverText: 'Put the bin back', maxDistance: pointerMaxDist() } },
          () => {
            if (haulStage !== 'back') {
              console.log(`[HAUL] return click IGNORED — haulStage='${haulStage}' (expected 'back')`)
              return
            }
            console.log(`[HAUL] -> returnBin for '${haulBinName}'`)
            playDepositSound()
            room.send('returnBin', { dummy: true })
          },
        )
        returnMarker = makeMarker(p, 'PUT THE BIN\nBACK HERE', Color4.create(0.4, 0.95, 0.5, 1))
        Transform.getMutable(returnMarker).scale = { x: 1, y: 1, z: 1 }
      }
    } else if (returnTarget !== null) {
      pointerEventsSystem.removeOnPointerDown(returnTarget)
      engine.removeEntity(returnTarget)
      returnTarget = null
      if (returnMarker) { engine.removeEntity(returnMarker); returnMarker = null }
    }
    // Stink from BIN_STINK_FRACTION, RAMPING with fill: a faint waft at a third
    // full, a plume at overflow. Rate mutation on a live emitter is safe —
    // only pausing has the sinking-particles problem.
    for (let i = 0; i < stationMarkerAnchors.length; i++) {
      // Each station reeks according to ITS OWN fullest bin.
      let frac = 0
      for (const n of stationBinNames[i]) {
        frac = Math.max(frac, Math.min(1, binFillClient(n) / BIN_CAPACITY))
      }
      const stinky = frac >= BIN_STINK_FRACTION
      if (stinky && stationStinks[i] === null) {
        stationStinks[i] = makeStationStink(stationMarkerAnchors[i])
      } else if (!stinky && stationStinks[i] !== null) {
        engine.removeEntity(stationStinks[i]!)
        stationStinks[i] = null
      }
      if (stationStinks[i] !== null) {
        const rate = Math.round(1 + 7 * frac)
        // Mutate only on change — getMutable marks the component dirty.
        if (ParticleSystem.get(stationStinks[i]!).rate !== rate) {
          ParticleSystem.getMutable(stationStinks[i]!).rate = rate
        }
      }
    }
  })

  // ── Bin fill pulse — breathing per STREAM: amplitude grows with that
  // stream's fill, so a swelling general bin next to a still recycling bin
  // tells you exactly what needs emptying. Stepped at 20 Hz — invisible on a
  // ~2.5s breathe cycle, and it cuts ~8 dirty Transforms/frame to a third.
  let pulseAcc = 0
  engine.addSystem((dt: number) => {
    pulseAcc += dt
    if (pulseAcc < 0.05) return
    pulseAcc = 0
    // ONE GameState read per tick, not one per bin. Idle short-circuit AFTER
    // one restore pass, so a round reset can't freeze a mid-pulse scale.
    const maxFrac = binMaxFillFrac()
    if (maxFrac <= 0) {
      if (binsPulsed) {
        binsPulsed = false
        for (const b of binVisuals) {
          if (hiddenBins.has(b.name)) continue   // hauled bins stay hidden
          const tf = Transform.getMutableOrNull(b.entity)
          if (tf) tf.scale = { x: b.base.x, y: b.base.y, z: b.base.z }
        }
      }
      return
    }
    binsPulsed = true
    const now = Date.now()
    for (const b of binVisuals) {
      if (hiddenBins.has(b.name)) continue   // hauled bins stay hidden
      const frac = Math.min(1, binFillClient(b.name) / BIN_CAPACITY)
      const tf = Transform.getMutableOrNull(b.entity)
      if (!tf) continue
      if (frac <= 0) {
        tf.scale = { x: b.base.x, y: b.base.y, z: b.base.z }
        continue
      }
      // Up to ±6% at overflow, breathing faster as it fills.
      const k = 1 + (0.06 * frac) * Math.sin(now / (400 - 200 * frac))
      tf.scale = { x: b.base.x * k, y: b.base.y * k, z: b.base.z * k }
    }
  })

  engine.addSystem(nudgeSystem)
  engine.addSystem(refusePulseSystem)
  console.log(`[CARRY] wired ${found} bin models across ${binPositions.length} stations, ${dumpsters} dumpsters`)
}
