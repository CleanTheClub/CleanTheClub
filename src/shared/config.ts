// Set to true for fast timers during local testing
export const DEBUG = false

const _ROUND_DURATIONS_MS  = [3 * 60_000, 2.5 * 60_000, 2 * 60_000, 1.5 * 60_000]
const _DEBUG_DURATIONS_MS  = [30_000, 25_000, 20_000, 15_000]
export const ROUND_DURATIONS_MS = DEBUG ? _DEBUG_DURATIONS_MS : _ROUND_DURATIONS_MS

export const OPEN_DISPLAY_MS    = DEBUG ? 20_000 : 60_000   // celebration window
export const NEXT_ROUND_LOCK_MS = DEBUG ? 5_000  : 15_000   // min before early-start unlocks
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
}

export const CLUTTER_DEFS: ClutterDef[] = [
  // Main scene items
  { id: 'mess_1', position: { x: 4,  y: 0.5, z: 4  } },
  { id: 'mess_2', position: { x: 24, y: 0.5, z: 4  } },
  { id: 'mess_3', position: { x: 4,  y: 0.5, z: 20 } },
  { id: 'mess_4', position: { x: 12, y: 0.5, z: 8  }, fast: true },
  { id: 'mess_5', position: { x: 16, y: 0.5, z: 12 }, fast: true },

  // Test row — one of each interaction type, near spawn
  { id: 'test_quick',   position: { x: 8,  y: 0.5, z: 26 }, type: 'quick'   },
  { id: 'test_hold',    position: { x: 12, y: 0.5, z: 26 }, type: 'hold'    },
  { id: 'test_collect', position: { x: 16, y: 0.5, z: 26 }, type: 'collect' },
  { id: 'test_reset',   position: { x: 20, y: 0.5, z: 26 }, type: 'reset'   },
]

export const TOTAL_CLUTTER = CLUTTER_DEFS.length
