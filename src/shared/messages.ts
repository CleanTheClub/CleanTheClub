import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // ── Client → Server ─────────────────────────────────────────
  cleanItem:        Schemas.Map({ itemId: Schemas.String }),
  adminReset:       Schemas.Map({ dummy: Schemas.Boolean }),  // admin only
  startNextRound:   Schemas.Map({ dummy: Schemas.Boolean }),  // any player
  /** Sent on join so the server can map address → display name for the leaderboard. */
  registerPlayer:   Schemas.Map({ displayName: Schemas.String }),

  // ── Server → Client ─────────────────────────────────────────
  cleanRejected:    Schemas.Map({ itemId: Schemas.String }),
  /** Top-10 all-time leaderboard — sent to all on clean, to joining player on join. */
  leaderboardUpdate: Schemas.Map({ entriesJson: Schemas.String }),
}

export const room = registerMessages(Messages)
