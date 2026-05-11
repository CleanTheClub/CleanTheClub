export const ROUND_DURATION_MS  = 5 * 60_000   // 5 min to clean before opening
export const OPEN_THRESHOLD     = 0.8           // 80% clean triggers opening countdown
export const OPEN_SUSTAIN_MS    = 10_000        // sustain threshold for 10s to open
export const CLUTTER_RESPAWN_MS = 90_000        // standard respawn (bottles, cups)
export const FAST_RESPAWN_MS    = 45_000        // fast respawn (spills, stains)

export type ClutterDef = {
  id: string
  position: { x: number; y: number; z: number }
  scale?: { x: number; y: number; z: number }
  fast?: boolean
}

export const CLUTTER_DEFS: ClutterDef[] = [
  { id: 'mess_1', position: { x: 4,  y: 0.5, z: 4  } },
  { id: 'mess_2', position: { x: 24, y: 0.5, z: 4  } },
  { id: 'mess_3', position: { x: 4,  y: 0.5, z: 20 } },
  { id: 'mess_4', position: { x: 12, y: 0.5, z: 8  }, fast: true },
  { id: 'mess_5', position: { x: 16, y: 0.5, z: 12 }, fast: true },
]

export const TOTAL_CLUTTER = CLUTTER_DEFS.length
