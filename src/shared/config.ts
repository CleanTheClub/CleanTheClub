// Set to true for fast timers during local testing
export const DEBUG = false

// V2: every round runs the SAME duration (per the GDD — the old shrinking table
// 3:00→1:00 was a V1 finale-pressure mechanic that no longer fits the endless
// loop). Difficulty comes from respawn scaling, not a shrinking clock. Single
// entry: getRoundDurationMs clamps to the last index, so all rounds read it.
const _ROUND_DURATIONS_MS  = [2.5 * 60_000]
const _DEBUG_DURATIONS_MS  = [30_000]
export const ROUND_DURATIONS_MS = DEBUG ? _DEBUG_DURATIONS_MS : _ROUND_DURATIONS_MS

// Every Nth round is a MILESTONE (longer celebration hold). Explicit — it used
// to be derived from the duration table's length, which broke the moment the
// table stopped having five entries.
export const MILESTONE_EVERY = 5

export const OPEN_DISPLAY_MS    = DEBUG ? 20_000 : 20_000   // normal intermission window
// Longer celebration hold after every MILESTONE round (each 5th). V2 loops
// forever, so this is a recurring payoff beat, not a game-over — 90s per cycle
// dragged ("round 5 big celebration doesn't match our V2 path"); 30s lets the
// crowd + confetti + music land and then gets everyone back to work.
export const FINALE_DISPLAY_MS  = DEBUG ? 30_000 : 30_000   // milestone celebration window
export const NEXT_ROUND_LOCK_MS = DEBUG ? 5_000  :  8_000   // min before early-start unlocks
export const CLUTTER_RESPAWN_MS = DEBUG ? 10_000 : 120_000  // base respawn (was 90s — eased)
export const FAST_RESPAWN_MS    = DEBUG ? 5_000  : 60_000   // fast respawn (was 45s — eased)

// Respawn speed scales up with player count so the mess volume stays
// challenging regardless of group size.  Index = (playerCount − 1), clamped
// to the last entry for any count beyond the array length.
//
// factor > 1 → items respawn faster  (scaledMs = baseMs / factor)
// factor < 1 → items respawn slower  (easier)
//
// Second eased pass (mobile playtest: "too hard with 1 person") — solo and duo
// now get substantially more breathing room; larger groups barely change.
//  1 player  → 0.50× (240 s / 120 s — solo breathing room)
//  2 players → 0.95× (126 s /  63 s)
//  3 players → 1.30× ( 92 s /  46 s)
//  4 players → 1.60× ( 75 s /  38 s)
//  5+ players → 1.80× ( 67 s /  33 s)
export const RESPAWN_SCALE_FACTORS = [0.50, 0.95, 1.30, 1.60, 1.80]

// ── Closing window — let the club actually finish clean ───────────────────────
// Playtest feedback: "when you finally finish cleaning a floor they respawn and the
// game seems endless... the total percentage completed is difficult to guess until
// the end." The problem isn't respawn SPEED, it's that the club can never visibly
// REACH clean, so a shift has no felt conclusion and the cleanliness bar just
// jitters instead of climbing.
//
// For the last stretch of every round, no new mess is scheduled. The bar then
// converges honestly on the final score, players can see themselves finishing, and
// the celebration lands on a club that is actually clean rather than one that
// re-dirtied a second before the doors opened.
//
// Scaled as a FRACTION of the round rather than a fixed duration, so it stays
// proportionate as rounds get shorter (3 min down to 1 min, and shorter still if
// the duration table is ever extended).
export const RESPAWN_CUTOFF_FRACTION = 0.25   // final 25% of a round spawns nothing
export const HOLD_DURATION_MS   = DEBUG ? 500    : 2_500   // hold-to-clean duration (lined up with mop emote)
export const PICKUP_EMOTE_MS    = 1_500                    // match PickUp_Anim_emote.glb clip length
// The mopping emote now fires immediately on hold-start (no step delay — the player
// is already on the patch), so it runs for the FULL hold duration and stops exactly
// as the bar completes and the patch poofs. Keep MOPPING_EMOTE_MS == HOLD_DURATION_MS.
export const MOPPING_EMOTE_MS   = 2_000                    // = HOLD_DURATION_MS (fires at t=0)
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
  { id: 'test_reset',     position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 5.28,  y: 7.41, z: 24.07 } },
  { id: 'stool_2',        position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 8.51,  y: 7.41, z: 27.14 } },
  { id: 'chaise_cushion', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 24.86, y: 7.3,  z: 13.66 } },
  { id: 'sofa_cushion_1', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 12.19, y: 8.81, z: 28.47 } },
  { id: 'sofa_cushion_2', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 16.6,  y: 7.2,  z: 22.72 } },
  { id: 'sofa_cushion_3', position: { x: 16, y: 0, z: 16 }, type: 'reset', sceneGlb: true, stinkPos: { x: 25.45, y: 7.2,  z: 23.31 } },
]
