import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // ── Client → Server ─────────────────────────────────────────
  cleanItem:        Schemas.Map({ itemId: Schemas.String }),
  adminReset:       Schemas.Map({ dummy: Schemas.Boolean }),  // admin only
  startNextRound:   Schemas.Map({ dummy: Schemas.Boolean }),  // any player (no-op)
  startMatch:       Schemas.Map({ dummy: Schemas.Boolean }),  // any player — start a match from the lobby
  /** Sent on join so the server can map address → display name for the leaderboard. */
  registerPlayer:   Schemas.Map({ displayName: Schemas.String }),
  /** Sent immediately on client start (no async wait) to wake a cold server ASAP. */
  ping:             Schemas.Map({ dummy: Schemas.Boolean }),
  /** Request to buy the next level of an upgrade. Server validates and pays. */
  buyUpgrade:       Schemas.Map({ upgradeId: Schemas.String }),
  /** Opt in to the next shift. Takes effect when the next round starts. */
  signUpNext:       Schemas.Map({ dummy: Schemas.Boolean }),
  /** Withdraw a pending sign-up (back to spectating). */
  cancelSignUp:     Schemas.Map({ dummy: Schemas.Boolean }),

  // ── Server → Client ─────────────────────────────────────────
  cleanRejected:    Schemas.Map({ itemId: Schemas.String }),
  /** Top-10 all-time leaderboard — sent to all on clean, to joining player on join. */
  leaderboardUpdate: Schemas.Map({ entriesJson: Schemas.String }),
  /**
   * This player's own career state — money, XP, title, upgrade levels — sent only
   * to the owning player. Also carries the last shift's payout so the end-of-shift
   * screen can show what was just earned, and any promotion to celebrate.
   *
   * Sent point-to-point rather than synced as a component: progression is private
   * per player, and a synced component would replicate everyone's wallet to
   * everyone. JSON keeps the shape free to evolve without a schema migration —
   * it stays far inside the ~13KB message cap since it describes one player.
   */
  progressUpdate:   Schemas.Map({ progressJson: Schemas.String }),
  /**
   * Whether this player is cleaning this shift, and whether they're queued for the
   * next one. Server-authoritative: participation gates whether cleans are accepted,
   * so the client must not decide it for itself.
   *
   * `active`   — participating in the CURRENT round; cleaning is enabled.
   * `signedUp` — queued to become active when the next round starts.
   */
  participationUpdate: Schemas.Map({
    active:   Schemas.Boolean,
    signedUp: Schemas.Boolean,
  }),
}

export const room = registerMessages(Messages)
