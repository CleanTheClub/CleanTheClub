import { engine, Schemas, Transform, GltfContainer, Entity } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

// Deliberately minimal: every field here is re-broadcast to all peers on every
// change. cleanedAt/cleanedBy used to live here but were read by nothing —
// attribution is tallied server-side (recordContribution), so they were pure
// CRDT payload on every clean and every respawn.
export const ClutterSync = engine.defineComponent('partypad:ClutterSync', {
  itemId:    Schemas.String,
  isCleaned: Schemas.Boolean,
})

export const GameState = engine.defineComponent('partypad:GameState', {
  phase:        Schemas.String,   // 'lobby' | 'playing' | 'open'
  cleanedCount: Schemas.Int,
  totalCount:   Schemas.Int,
  secondsLeft:  Schemas.Int,
  roundNumber:   Schemas.Int,      // 0-indexed; final round = ROUND_DURATIONS_MS.length - 1
  outcome:       Schemas.String,   // '' | 'perfect' | 'optimal' | 'adequate' | 'suboptimal'
  canStartEarly: Schemas.Boolean,  // true once NEXT_ROUND_LOCK_MS has elapsed during open phase
  isFinale:      Schemas.Boolean,  // true during the open phase that follows the final round (victory hold)
  playersIn:     Schemas.Int,      // live player count — shown in the lobby
  starting:      Schemas.Boolean,  // true during the lobby pre-match countdown (secondsLeft is the countdown)
  theme:         Schemas.String,   // '' = classic round, else a ThemeId from THEME_DEFS
  lastCall:      Schemas.Boolean,  // true during the 100%-early-close grace window (secondsLeft counts it down)
  binFillGeneral: Schemas.Int,     // deposits into the general stream this round (visual fill + full at BIN_STREAM_CAPACITY)
  binFillRecycle: Schemas.Int,     // ditto for the recycling stream
})

ClutterSync.validateBeforeChange((v) => v.senderAddress === AUTH_SERVER_PEER_ID)
GameState.validateBeforeChange((v) => v.senderAddress === AUTH_SERVER_PEER_ID)

// Theme slots and disaster stages sync Transform + GltfContainer alongside
// ClutterSync. Those two core components were previously unguarded, so a
// crafted client could move, hide, or re-model every themed spawn for the
// whole room. Same server-only rule, scoped to our game entities (anything
// carrying ClutterSync) so ordinary synced Transforms elsewhere — if we ever
// add any — aren't silently caught by a blanket rule.
const serverOnlyOnGameEntities = (v: { entity: Entity; senderAddress: string }): boolean =>
  !ClutterSync.has(v.entity) || v.senderAddress === AUTH_SERVER_PEER_ID
Transform.validateBeforeChange(serverOnlyOnGameEntities)
GltfContainer.validateBeforeChange(serverOnlyOnGameEntities)
