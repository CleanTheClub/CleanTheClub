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

import { engine, Entity, Transform, pointerEventsSystem, InputAction, TextShape, Billboard, MeshRenderer, MeshCollider, ColliderLayer, Material } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { room } from '../shared/messages'
import { RubbishType } from '../shared/glassDiscovery'
import { playHoverSound, playClickSound, playDepositSound, playMissSound } from './soundManager'
import { playSparkle } from './sparkleSystem'

// PLACEHOLDER deposit bins — glowing cubes spawned in code. The scene's bag
// props can't serve as bins: every bag mesh in the club (bigRubbishBag included)
// reads as collectible mess, so players clean them rather than deposit into them.
// When a real, visually distinct bin model lands in the scene, replace this table
// with name-prefix discovery of those props and delete the cube setup.
//
// Positions mirror the old bigRubbishBag spread (one per zone, both floors),
// nudged ~1m toward open floor so the cubes don't intersect the bag props.
// Sorted streams: gold cubes take general waste, green cubes take recycling —
// each floor gets both types so no stream ever forces a stair trip.
const BIN_POSITIONS: Array<{ x: number; y: number; z: number; type: RubbishType }> = [
  { x: 26.5, y: 0,   z: 12.2, type: 'general' },
  { x: 5.1,  y: 0,   z: 11.0, type: 'recycle' },
  { x: 26.6, y: 0,   z: 19.8, type: 'recycle' },
  { x: 4.8,  y: 0,   z: 19.8, type: 'general' },
  { x: 13.7, y: 0,   z: 22.1, type: 'general' },
  { x: 23.5, y: 7.3, z: 10.5, type: 'general' },
  { x: 10.0, y: 7.3, z: 28.3, type: 'recycle' },
]
const BIN_SIZE = { x: 1.2, y: 1.4, z: 1.2 }

const BIN_STYLE: Record<RubbishType, { emissive: Color4; text: string; textColor: Color4; hover: string }> = {
  general: {
    emissive:  Color4.create(1, 0.72, 0.15, 1),
    text:      'GENERAL\nWASTE',
    textColor: Color4.create(1, 0.82, 0.25, 1),
    hover:     'Empty general waste',
  },
  recycle: {
    emissive:  Color4.create(0.2, 1, 0.45, 1),
    text:      'RECYCLING',
    textColor: Color4.create(0.35, 1, 0.55, 1),
    hover:     'Empty recycling',
  },
}

// Floating markers above each deposit bin, shown only while the player carries
// something in that bin's stream — the moment the information matters and the
// only moment it isn't noise.
const markersByType: Record<RubbishType, Entity[]> = { general: [], recycle: [] }

function createBinMarker(pos: { x: number; y: number; z: number }, type: RubbishType): void {
  const style = BIN_STYLE[type]
  const marker = engine.addEntity()
  Transform.create(marker, {
    position: { x: pos.x, y: pos.y + 2.4, z: pos.z },
    scale: { x: 0, y: 0, z: 0 },   // hidden until the first carriedUpdate says otherwise
  })
  TextShape.create(marker, {
    text: style.text,
    fontSize: 3,
    textColor: style.textColor,
    outlineColor: Color4.Black(),
    outlineWidth: 0.15,
  })
  Billboard.create(marker, {})
  markersByType[type].push(marker)
}

function refreshMarkers(): void {
  for (const type of ['general', 'recycle'] as RubbishType[]) {
    const s = (type === 'general' ? carriedGeneral : carriedRecycle) > 0 ? 1 : 0
    for (const m of markersByType[type]) {
      Transform.getMutable(m).scale = { x: s, y: s, z: s }
    }
  }
}

let carriedGeneral = 0
let carriedRecycle = 0
let capacity     = 5      // matches the un-upgraded baseline until the server answers
let portableLeft = 0      // Portable Bin self-empties remaining this shift
let known        = false  // no carriedUpdate yet — hide the chip rather than guess

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

  // Spawn the placeholder cube bins — no GLB streaming to wait for, so setup is
  // immediate and every bin is clickable from the first frame.
  for (const pos of BIN_POSITIONS) {
    const style = BIN_STYLE[pos.type]
    const bin = engine.addEntity()
    Transform.create(bin, {
      position: { x: pos.x, y: pos.y + BIN_SIZE.y / 2, z: pos.z },
      scale: BIN_SIZE,
    })
    MeshRenderer.setBox(bin)
    MeshCollider.setBox(bin, ColliderLayer.CL_POINTER)
    // Glowing (gold = general, green = recycling) so it reads as "special
    // interactable", not more loose mess.
    Material.setPbrMaterial(bin, {
      albedoColor:       Color4.create(0.15, 0.1, 0.02, 1),
      emissiveColor:     style.emissive,
      emissiveIntensity: 1.2,
    })
    createBinMarker(pos, pos.type)

    pointerEventsSystem.onPointerHoverEnter({ entity: bin }, () => playHoverSound())
    pointerEventsSystem.onPointerDown(
      // Slightly longer reach than items — bins are destinations you walk at,
      // and cutting the prompt at 4m made them feel unresponsive on approach.
      { entity: bin, opts: { button: InputAction.IA_POINTER, hoverText: style.hover, maxDistance: 6 } },
      () => {
        if (!known) return
        const inStream = pos.type === 'general' ? carriedGeneral : carriedRecycle
        if (inStream === 0) {
          // Wrong bin (or empty hands): a soft "nope" — the markers + chip show
          // where the load actually belongs.
          if (getCarried() > 0) playMissSound()
          return
        }
        // Deliberately NO click sound here: click.mp3 also opens every rubbish
        // pickup, and layering it made deposits sound like collects. The deposit
        // thunk alone keeps the two actions audibly distinct.
        playDepositSound()
        playSparkle({ x: pos.x, y: pos.y + 1.2, z: pos.z })
        room.send('depositRubbish', { binType: pos.type })
      },
    )
  }
  console.log(`[CARRY] spawned ${BIN_POSITIONS.length} placeholder deposit bins (sorted streams)`)
}
