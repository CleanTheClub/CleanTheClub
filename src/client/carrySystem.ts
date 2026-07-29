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

import { engine, Entity, Name, Transform, pointerEventsSystem, InputAction, TextShape, Billboard } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { RubbishType } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from '../shared/sceneItemHelpers'
import { requestSetup } from './spawnDirector'
import { POINTER_MAX_DIST } from './phaseGate'
import { playHoverSound, playDepositSound, playMissSound } from './soundManager'
import { playSparkle } from './sparkleSystem'
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

// ONE floating marker per station (the two bins share an origin, so per-type
// markers would overlap in mid-air). Its job is findability, not type teaching:
// shown while the player carries anything at all.
const stationMarkers: Entity[] = []
const stationKeys = new Set<string>()   // rounded position → already has a marker

function ensureStationMarker(pos: { x: number; y: number; z: number }): void {
  const key = `${Math.round(pos.x)}|${Math.round(pos.y)}|${Math.round(pos.z)}`
  if (stationKeys.has(key)) return
  stationKeys.add(key)

  const marker = engine.addEntity()
  Transform.create(marker, {
    position: { x: pos.x, y: pos.y + 2.4, z: pos.z },
    scale: { x: 0, y: 0, z: 0 },   // hidden until the first carriedUpdate says otherwise
  })
  TextShape.create(marker, {
    text: 'EMPTY BINS',
    fontSize: 3,
    textColor: Color4.create(1, 0.82, 0.25, 1),
    outlineColor: Color4.Black(),
    outlineWidth: 0.15,
  })
  Billboard.create(marker, {})
  stationMarkers.push(marker)
}

function refreshMarkers(): void {
  const s = carriedGeneral + carriedRecycle > 0 ? 1 : 0
  for (const m of stationMarkers) {
    Transform.getMutable(m).scale = { x: s, y: s, z: s }
  }
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
export const getLastDeposit = () => ({ ms: lastDepositMs, count: lastDepositCount })

// Big loads earn a confetti pop on top of the sparkle — daring a fuller bag
// should feel better than trickling deposits.
const BIG_DEPOSIT = 8

function recordDeposit(count: number): void {
  lastDepositMs    = Date.now()
  lastDepositCount = count
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
    if (stationPos) ensureStationMarker(stationPos)

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
            recordDeposit(inStream)
            room.send('depositRubbish', { binType: type })
          },
        )
      },
    })
  }
  console.log(`[CARRY] wired ${found} bin models across ${stationMarkers.length} stations`)
}
