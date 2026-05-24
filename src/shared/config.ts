// Set to true for fast timers during local testing
export const DEBUG = false

const _ROUND_DURATIONS_MS  = [3 * 60_000, 2.5 * 60_000, 2 * 60_000, 1.5 * 60_000, 60_000]
const _DEBUG_DURATIONS_MS  = [30_000, 25_000, 20_000, 15_000, 10_000]
export const ROUND_DURATIONS_MS = DEBUG ? _DEBUG_DURATIONS_MS : _ROUND_DURATIONS_MS

export const OPEN_DISPLAY_MS    = DEBUG ? 20_000 : 20_000   // celebration window
export const NEXT_ROUND_LOCK_MS = DEBUG ? 5_000  :  8_000   // min before early-start unlocks
export const CLUTTER_RESPAWN_MS = DEBUG ? 10_000 : 90_000
export const FAST_RESPAWN_MS    = DEBUG ? 5_000  : 45_000
export const HOLD_DURATION_MS   = DEBUG ? 500    : 1_500   // hold-to-clean duration
export const PICKUP_EMOTE_MS    = 1_500                    // match PickUp_Anim_emote.glb clip length
export const PICKUP_TOUCH_MS   = 800                       // ms from click → hand touches item (tune to match anim)

// Restoration meter thresholds
export const TRANSFORM_DIM    = 0.3
export const TRANSFORM_MID    = 0.6
export const TRANSFORM_BRIGHT = 0.8

// Outcome thresholds (evaluated when time expires)
export const OUTCOME_OPTIMAL  = 0.8
export const OUTCOME_ADEQUATE = 0.5

// Wallet addresses that can see the admin reset panel (lowercase)
export const ADMIN_ADDRESSES: string[] = [
  '0x8967ad851ccbd4c1a2d57a128d3c606fcab29bad',
]

export type InteractionType = 'quick' | 'hold' | 'collect' | 'reset'

export type ClutterDef = {
  id: string
  position: { x: number; y: number; z: number }
  scale?: { x: number; y: number; z: number }
  fast?: boolean
  type?: InteractionType   // defaults to 'quick'
  // When true, no primitive entity is created and no InteractionManager click is
  // registered — a scene-side system (e.g. restoreSystem) owns the visuals and
  // click handling, but the server still tracks the itemId via ClutterSync.
  sceneGlb?: boolean
  // Optional world-space position for the stink emitter — use when the GLB origin
  // doesn't match where the mesh actually sits in the scene (e.g. origin at floor
  // level but mesh on an upper floor). Falls back to `position` if not set.
  stinkPos?: { x: number; y: number; z: number }
}

export const CLUTTER_DEFS: ClutterDef[] = [
  // Reset items — visuals & click owned by restoreSystem; server tracks via these ids
  { id: 'test_reset', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 5.28, y: 7.41, z: 24.07 } },
  { id: 'stool_2',       position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 8.51,  y: 7.41, z: 27.14 } },
  { id: 'chaise_cushion', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 24.86, y: 7.3,  z: 13.66 } },
]
