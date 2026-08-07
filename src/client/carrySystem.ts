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

import { engine, Entity, Name, Transform, pointerEventsSystem, InputAction, TextShape, Billboard, GltfContainer, AvatarAttach, AvatarAnchorPointType, ParticleSystem, MeshCollider } from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { GameState } from '../shared/schemas'
import { RubbishType } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from '../shared/sceneItemHelpers'
import { DUMPSTER_PREFIX, BIN_STREAM_CAPACITY, BIN_STINK_FRACTION, themeModelSrc } from '../shared/config'
import { requestSetup } from './spawnDirector'
import { POINTER_MAX_DIST } from './phaseGate'
import { playHoverSound, playDepositSound, playMissSound } from './soundManager'
import { playSparkle } from './sparkleSystem'
import { getCareerOrEmpty } from './progressionStore'
import { playPickupEmote, setCarryPose } from './emoteManager'

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
const ITEM_MINI_SCALE   = 0.21
// Fixed jumble — offsets climb up out of the bag, rotations vary per slot so
// the pile reads as a pile rather than a printed stack.
const ITEM_SLOTS = [
  { pos: { x:  0.04, y: 0.16, z:  0.02 }, rot: { x: 10, y:   0, z:  15 } },
  { pos: { x: -0.05, y: 0.19, z: -0.03 }, rot: { x: -8, y:  60, z: -20 } },
  { pos: { x:  0.02, y: 0.22, z: -0.04 }, rot: { x: 20, y: 130, z:   5 } },
  { pos: { x: -0.03, y: 0.25, z:  0.03 }, rot: { x: -15, y: 200, z: 25 } },
  { pos: { x:  0.05, y: 0.28, z: -0.01 }, rot: { x:  5, y: 270, z: -12 } },
  { pos: { x: -0.04, y: 0.31, z:  0.00 }, rot: { x: -20, y: 330, z: 18 } },
]

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

function refreshCarriedBag(): void {
  const total = carriedGeneral + carriedRecycle
  // Dumpster haul: the hands hold the overflowing BIN BAG itself — carry pose,
  // box at max size, a bag riding it, permanent stink. Reads physically.
  const haulDisplay = hauling !== ''
  // Upper-body carry pose tracks whether the hands are full.
  setCarryPose(haulDisplay || total > 0)
  if (!haulDisplay && total <= 0) {
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

    if (SHOW_CARRY_CONTAINER) {
      bagEntity = engine.addEntity()
      Transform.create(bagEntity, { parent: carryRig, position: BAG_OFFSET })
      GltfContainer.create(bagEntity, { src: BAG_MODEL })
    }
  }

  // Container scales with how full the hands are — a full load looks heavier.
  // Origin is at the box base on the vertical axis (prop-authored), so scaling
  // grows it in place; the offset no longer needs to move with size.
  const frac = haulDisplay ? 1 : Math.min(1, total / Math.max(1, capacity))
  const size = BAG_MIN + (BAG_MAX - BAG_MIN) * frac
  const bagTf = bagEntity && Transform.getMutableOrNull(bagEntity)
  if (bagTf) bagTf.scale = { x: size, y: size, z: size }

  // Stink cloud appears exactly at capacity, disappears the moment space frees.
  // A hauled FULL bin stinks all the way out; the emptied bin rides home clean.
  const full = (haulDisplay && haulStage === 'out') || (!haulDisplay && total >= capacity)
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
      blendMode: 0,   // PSB_ALPHA (const enum not re-exported)
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
  // vanished from its station).
  const visible = haulDisplay
    ? [themeModelSrc(hauling === 'recycle' ? 'Bin_Recycling' : 'Bin_General')]
    : carriedModels.slice(-MAX_VISIBLE_ITEMS)
  for (let i = 0; i < MAX_VISIBLE_ITEMS; i++) {
    const src = visible[i]
    if (src) {
      if (!slotEntities[i]) {
        const slot = engine.addEntity()
        const def = ITEM_SLOTS[i]
        Transform.create(slot, {
          parent:   carryRig ?? undefined,
          position: { x: BAG_OFFSET.x + def.pos.x, y: BAG_OFFSET.y + def.pos.y, z: BAG_OFFSET.z + def.pos.z },
          rotation: Quaternion.fromEulerDegrees(def.rot.x, def.rot.y, def.rot.z),
          scale:    { x: ITEM_MINI_SCALE, y: ITEM_MINI_SCALE, z: ITEM_MINI_SCALE },
        })
        slotEntities[i] = slot
      }
      const cur = GltfContainer.getOrNull(slotEntities[i])
      if (cur?.src !== src) GltfContainer.createOrReplace(slotEntities[i], { src })
    } else if (slotEntities[i] && GltfContainer.getOrNull(slotEntities[i])) {
      GltfContainer.deleteFrom(slotEntities[i])
    }
  }
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
export const isCarryFull       = (): boolean => known && (hauling !== '' || carriedGeneral + carriedRecycle >= capacity)

/** Bin fill levels from GameState — club-wide, server-owned. */
function binFillClient(type: RubbishType): number {
  for (const [, gs] of engine.getEntitiesWith(GameState)) {
    return type === 'general' ? gs.binFillGeneral : gs.binFillRecycle
  }
  return 0
}
function binStreamFullClient(type: RubbishType): boolean {
  return binFillClient(type) >= BIN_STREAM_CAPACITY
}
/** Fullest stream, 0..1 — drives the station piles and stink. */
function binMaxFillFrac(): number {
  return Math.min(1, Math.max(binFillClient('general'), binFillClient('recycle')) / BIN_STREAM_CAPACITY)
}

/** Portable Bin: empty on the spot (both streams). Server re-validates. */
export function requestPortableEmpty(): void {
  if (!known || getCarried() === 0 || portableLeft === 0) return
  playDepositSound()
  recordDeposit(getCarried())
  room.send('portableEmpty', { dummy: true })
}

export function initCarrySystem(): void {
  room.onMessage('carriedUpdate', (data) => {
    carriedGeneral = data.carriedGeneral
    carriedRecycle = data.carriedRecycle
    capacity       = data.capacity
    portableLeft   = data.portableLeft
    hauling        = data.hauling === 'general' || data.hauling === 'recycle' ? data.hauling : ''
    haulStage      = data.haulStage === 'out' || data.haulStage === 'back' ? data.haulStage : ''
    haulBinName    = data.haulBinName ?? ''
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
          { entity: clickEnt, opts: { button: InputAction.IA_POINTER, hoverText: BIN_HOVER[type], maxDistance: POINTER_MAX_DIST } },
          () => {
            if (!known) return
            // Overflowed stream: the bin dispenses its FULL BAG instead of
            // taking deposits — empty hands shoulder it (the persistent FULL
            // marker above the station carries the instruction).
            if (binStreamFullClient(type)) {
              if (hauling !== '' || getCarried() > 0) { playMissSound(); return }
              playDepositSound(type)   // bin-grab thunk
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
            room.send('depositRubbish', { binType: type })
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
          { entity: clickEnt, opts: { button: InputAction.IA_POINTER, hoverText: 'Dumpster', maxDistance: POINTER_MAX_DIST } },
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
  const fullMarkers = stationMarkerAnchors.map((p) =>
    makeMarker(p, 'BINS FULL — EMPTY HANDS,\nGRAB THE BAG!', Color4.create(1, 0.45, 0.25, 1)))
  const dumpMarkers = dumpsterPositions.map((p) =>
    makeMarker(p, 'EMPTY THE BAG HERE', Color4.create(1, 0.82, 0.25, 1)))

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
      blendMode: 0,
      loop: true,
      prewarm: true,
      active: true,
    })
    return e
  }

  // Return-leg click target + marker at the hauled bin's empty station spot.
  let returnTarget: Entity | null = null
  let returnMarker: Entity | null = null

  let markerAcc = 0
  engine.addSystem((dt: number) => {
    markerAcc += dt
    if (markerAcc < 0.5) return
    markerAcc = 0
    const anyFull = binStreamFullClient('general') || binStreamFullClient('recycle')
    const showFull = anyFull && hauling === ''   // once someone hauls, the shout stops
    for (const m of fullMarkers) {
      const tf = Transform.getMutable(m)
      tf.scale = showFull ? { x: 1, y: 1, z: 1 } : { x: 0.001, y: 0.001, z: 0.001 }
    }
    for (const m of dumpMarkers) {
      const tf = Transform.getMutable(m)
      // Dumpsters call only while the FULL bin is out; the return leg points home.
      tf.scale = haulStage === 'out' ? { x: 1, y: 1, z: 1 } : { x: 0.001, y: 0.001, z: 0.001 }
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
          { entity: returnTarget, opts: { button: InputAction.IA_POINTER, hoverText: 'Put the bin back', maxDistance: POINTER_MAX_DIST } },
          () => {
            if (haulStage !== 'back') return
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
    const frac = binMaxFillFrac()
    const stinky = frac >= BIN_STINK_FRACTION
    for (let i = 0; i < stationMarkerAnchors.length; i++) {
      if (stinky && stationStinks[i] === null) {
        stationStinks[i] = makeStationStink(stationMarkerAnchors[i])
      } else if (!stinky && stationStinks[i] !== null) {
        engine.removeEntity(stationStinks[i]!)
        stationStinks[i] = null
      }
      if (stationStinks[i] !== null) {
        ParticleSystem.getMutable(stationStinks[i]!).rate = Math.round(1 + 7 * frac)
      }
    }
  })

  // ── Bin fill pulse — per-frame breathing, per STREAM: amplitude grows with
  // that stream's fill, so a swelling general bin next to a still recycling
  // bin tells you exactly what needs emptying.
  engine.addSystem(() => {
    const now = Date.now()
    for (const b of binVisuals) {
      const frac = Math.min(1, binFillClient(b.type) / BIN_STREAM_CAPACITY)
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
