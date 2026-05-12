import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

export const ClutterSync = engine.defineComponent('partypad:ClutterSync', {
  itemId:    Schemas.String,
  isCleaned: Schemas.Boolean,
  cleanedAt: Schemas.Int64,
  cleanedBy: Schemas.String,
})

export const GameState = engine.defineComponent('partypad:GameState', {
  phase:        Schemas.String,   // 'playing' | 'open'
  cleanedCount: Schemas.Int,
  totalCount:   Schemas.Int,
  secondsLeft:  Schemas.Int,
  roundNumber:   Schemas.Int,      // 0-indexed; caps at 3 for minimum duration
  outcome:       Schemas.String,   // '' | 'optimal' | 'adequate' | 'suboptimal'
  canStartEarly: Schemas.Boolean,  // true once NEXT_ROUND_LOCK_MS has elapsed during open phase
})

ClutterSync.validateBeforeChange((v) => v.senderAddress === AUTH_SERVER_PEER_ID)
GameState.validateBeforeChange((v) => v.senderAddress === AUTH_SERVER_PEER_ID)
