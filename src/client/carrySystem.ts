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

import { engine, Entity, Name, Transform, pointerEventsSystem, InputAction, TextShape, Billboard, GltfContainer, GltfContainerLoadingState, LoadingState, AvatarAttach, AvatarAnchorPointType } from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { RubbishType } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from '../shared/sceneItemHelpers'
import { requestSetup } from './spawnDirector'
import { POINTER_MAX_DIST } from './phaseGate'
import { playHoverSound, playDepositSound, playMissSound } from './soundManager'
import { playSparkle } from './sparkleSystem'
import { getCareerOrEmpty } from './progressionStore'
import { playPickupEmote, setCarryPose } from './emoteManager'
import { promotionBurst } from './confettiSystem'

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

// ── Bin load watchdog ─────────────────────────────────────────────────────────
// Field report: "sometimes one of the recycling bins isn't visible / usable."
// Discovery is deterministic (Name comes from the composite), but the pointer
// wiring waits for the bin's GLB to finish loading — so a failed load leaves
// that bin both invisible AND unwired, with nothing ever retrying it. This
// watchdog polls each bin's GltfContainerLoadingState and, on a failed load,
// forces a reload by removing and re-adding the GltfContainer (the same
// component-rebuild trick as the require-cache bust in Roblox: the renderer
// re-fetches the asset from scratch). Logs every state change so the next
// repro tells us WHICH failure mode this is rather than leaving us guessing.
const BIN_WATCH_INTERVAL_S = 5
const BIN_RELOAD_LIMIT     = 3   // per bin per session — never loop a hopeless asset
type BinWatch = { entity: Entity; name: string; lastState: number; reloads: number }
const binWatch: BinWatch[] = []
let binWatchAcc = 0
const LOAD_STATE_NAME: Record<number, string> = {
  0: 'UNKNOWN', 1: 'LOADING', 2: 'NOT_FOUND', 3: 'FINISHED_WITH_ERROR', 4: 'FINISHED',
}

function binWatchdogSystem(dt: number): void {
  binWatchAcc += dt
  if (binWatchAcc < BIN_WATCH_INTERVAL_S) return
  binWatchAcc = 0
  for (const w of binWatch) {
    const st = GltfContainerLoadingState.getOrNull(w.entity)?.currentState
    if (st === undefined || st === w.lastState) continue
    console.log(`[CARRY] bin '${w.name}' load state → ${LOAD_STATE_NAME[st] ?? st}`)
    w.lastState = st
    const failed = st === LoadingState.FINISHED_WITH_ERROR || st === LoadingState.NOT_FOUND
    if (failed && w.reloads < BIN_RELOAD_LIMIT) {
      w.reloads++
      const src = GltfContainer.getOrNull(w.entity)?.src
      if (!src) continue
      console.log(`[CARRY] bin '${w.name}' failed to load — forcing reload ${w.reloads}/${BIN_RELOAD_LIMIT}`)
      GltfContainer.deleteFrom(w.entity)
      GltfContainer.create(w.entity, { src })
    }
  }
}

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
// Container OFF for now — you see just the items you grabbed. Bag+items read
// as clutter ("why both?"), and the better container story is PROGRESSION:
// when per-tier carrier models exist (basket → bag → trolley as Strength
// levels), the container returns as a visible status/capacity signal — new
// players immediately understand "I fill this thing", veterans wear their
// upgrade. Flip to true to bring the bag back meanwhile.
const SHOW_CARRY_CONTAINER = false
const BAG_MODEL  = 'assets/scene/Models/bigRubbishBag/bigRubbishBag.glb'
const BAG_MIN    = 0.10
const BAG_MAX    = 0.22
const BAG_OFFSET = { x: 0, y: -0.05, z: 0 }

const MAX_VISIBLE_ITEMS = 6
const ITEM_MINI_SCALE   = 0.16
// Fixed jumble — offsets climb up out of the bag, rotations vary per slot so
// the pile reads as a pile rather than a printed stack.
const ITEM_SLOTS = [
  { pos: { x:  0.04, y: 0.04, z:  0.02 }, rot: { x: 10, y:   0, z:  15 } },
  { pos: { x: -0.05, y: 0.08, z: -0.03 }, rot: { x: -8, y:  60, z: -20 } },
  { pos: { x:  0.02, y: 0.13, z: -0.04 }, rot: { x: 20, y: 130, z:   5 } },
  { pos: { x: -0.03, y: 0.17, z:  0.03 }, rot: { x: -15, y: 200, z: 25 } },
  { pos: { x:  0.05, y: 0.21, z: -0.01 }, rot: { x:  5, y: 270, z: -12 } },
  { pos: { x: -0.04, y: 0.25, z:  0.00 }, rot: { x: -20, y: 330, z: 18 } },
]

let carryAnchor: Entity | null = null
let bagEntity: Entity | null = null
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
  // Upper-body carry pose tracks whether the hands are full.
  setCarryPose(total > 0)
  if (total <= 0) {
    if (carryAnchor) {
      engine.removeEntityWithChildren(carryAnchor)
      carryAnchor = null
      bagEntity = null
      slotEntities.length = 0
    }
    carriedModels.length = 0
    return
  }

  // Server count is authoritative — drop oldest decorations past it.
  while (carriedModels.length > total) carriedModels.shift()

  if (!carryAnchor) {
    // Unscaled anchor on the hand; bag and minis are children so the bag can
    // grow without inflating the items riding on it.
    carryAnchor = engine.addEntity()
    Transform.create(carryAnchor, {})
    AvatarAttach.create(carryAnchor, { anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND })

    if (SHOW_CARRY_CONTAINER) {
      bagEntity = engine.addEntity()
      Transform.create(bagEntity, { parent: carryAnchor, position: BAG_OFFSET })
      GltfContainer.create(bagEntity, { src: BAG_MODEL })
    }
  }

  // Bag scales with how full the hands are — a nearly-full load looks heavier.
  const frac = Math.min(1, total / Math.max(1, capacity))
  const size = BAG_MIN + (BAG_MAX - BAG_MIN) * frac
  const bagTf = bagEntity && Transform.getMutableOrNull(bagEntity)
  if (bagTf) bagTf.scale = { x: size, y: size, z: size }

  // Newest items on top of the pile; slots are reused, never re-created.
  const visible = carriedModels.slice(-MAX_VISIBLE_ITEMS)
  for (let i = 0; i < MAX_VISIBLE_ITEMS; i++) {
    const src = visible[i]
    if (src) {
      if (!slotEntities[i]) {
        const slot = engine.addEntity()
        const def = ITEM_SLOTS[i]
        Transform.create(slot, {
          parent:   carryAnchor,
          position: def.pos,
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

function refreshMarkers(): void {
  refreshCarriedBag()
}

let carriedGeneral = 0
let carriedRecycle = 0
let capacity     = 5      // matches the un-upgraded baseline until the server answers
let portableLeft = 0      // Portable Bin self-empties remaining this shift
let known        = false  // no carriedUpdate yet — hide the chip rather than guess

// Last deposit (time + size), read by ui.tsx for the "+N BINNED!" flash — a
// getter rather than a ui import, which would cycle.
let lastDepositMs    = -1
let lastDepositCount = 0
let lastDepositType: RubbishType = 'general'
export const getLastDeposit = () => ({ ms: lastDepositMs, count: lastDepositCount, type: lastDepositType })

// Big loads earn a confetti pop on top of the sparkle — daring a fuller bag
// should feel better than trickling deposits.
const BIG_DEPOSIT = 8

function recordDeposit(count: number, type: RubbishType = 'general'): void {
  lastDepositMs    = Date.now()
  lastDepositCount = count
  lastDepositType  = type
  if (count >= BIG_DEPOSIT) promotionBurst()
}

export const getCarried        = (): number => carriedGeneral + carriedRecycle
export const getCarriedGeneral = (): number => carriedGeneral
export const getCarriedRecycle = (): number => carriedRecycle
export const getCarryCapacity  = (): number => capacity
export const getPortableLeft   = (): number => portableLeft
export const isCarryKnown      = (): boolean => known
export const isCarryFull       = (): boolean => known && carriedGeneral + carriedRecycle >= capacity

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
    binWatch.push({ entity, name: n, lastState: -1, reloads: 0 })

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
  engine.addSystem(nudgeSystem)
  engine.addSystem(binWatchdogSystem)
  console.log(`[CARRY] wired ${found} bin models across ${binPositions.length} stations`)
}
