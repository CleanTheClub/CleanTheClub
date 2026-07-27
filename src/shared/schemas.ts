import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

export const ClutterSync = engine.defineComponent('partypad:ClutterSync', {
  itemId:    Schemas.String,
  isCleaned: Schemas.Boolean,
  cleanedAt: Schemas.Int64,
  cleanedBy: Schemas.String,
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
})

ClutterSync.validateBeforeChange((v) => v.senderAddress === AUTH_SERVER_PEER_ID)
GameState.validateBeforeChange((v) => v.senderAddress === AUTH_SERVER_PEER_ID)
