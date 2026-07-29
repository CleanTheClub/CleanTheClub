import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // ── Client → Server ─────────────────────────────────────────
  cleanItem:        Schemas.Map({ itemId: Schemas.String }),
  adminReset:       Schemas.Map({ dummy: Schemas.Boolean }),  // admin only
  /** Admin testing tool — grant yourself money and/or XP. Admin-gated server-side. */
  adminGrant:       Schemas.Map({ money: Schemas.Int, xp: Schemas.Int }),
  startNextRound:   Schemas.Map({ dummy: Schemas.Boolean }),  // any player (no-op)
  startMatch:       Schemas.Map({ dummy: Schemas.Boolean }),  // any player — start a match from the lobby
  /** Sent on join so the server can map address → display name for the leaderboard. */
  registerPlayer:   Schemas.Map({ displayName: Schemas.String }),
  /**
   * Sent immediately on client start (no async wait) to wake a cold server ASAP,
   * then every ~5s as the presence heartbeat the server counts players by.
   */
  ping:             Schemas.Map({ dummy: Schemas.Boolean }),
  /** Request to buy the next level of an upgrade. Server validates and pays. */
  buyUpgrade:       Schemas.Map({ upgradeId: Schemas.String }),
  /** Opt in to the next shift. Takes effect when the next round starts. */
  signUpNext:       Schemas.Map({ dummy: Schemas.Boolean }),
  /** Withdraw a pending sign-up (back to spectating). */
  cancelSignUp:     Schemas.Map({ dummy: Schemas.Boolean }),
  /**
   * Empty carried rubbish into a bin. binType is 'general' or 'recycle' — the
   * bin only accepts its own stream, so only that type's count resets.
   */
  depositRubbish:   Schemas.Map({ binType: Schemas.String }),
  /** Empty on the spot via the Portable Bin upgrade (limited uses per shift). */
  portableEmpty:    Schemas.Map({ dummy: Schemas.Boolean }),

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
   * Everyone's career rank, broadcast to ALL clients so each can render a career
   * plate above every avatar. Required because the scene hides the explorer's
   * own nametags (AMT_HIDE_NAMETAGS) and the plate takes their place — a
   * local-only plate would leave every other player nameless.
   * JSON array of { a: address, n: displayName, t: title, r: rank }.
   */
  ranksUpdate:      Schemas.Map({ rosterJson: Schemas.String }),
  /**
   * This player's shift contract — a server-rolled mini-goal for the current
   * round ("Mop 3 sticky patches"), with live progress. JSON for shape freedom:
   * { label, kind, progress, target, money, xp }. Sent at round start and on
   * every progress tick; null-ish (empty string) when no contract is active.
   */
  contractUpdate:   Schemas.Map({ contractJson: Schemas.String }),
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
  /**
   * This player's rubbish carry state. Server-authoritative: capacity comes from
   * the carryCapacity upgrade level and the count is only ever changed by the
   * server (accepted rubbish cleans increment it, deposits reset it) — the client
   * mirror exists purely to drive the HUD chip and pre-empt doomed pickups.
   */
  carriedUpdate: Schemas.Map({
    /** Sorted streams: general waste and recyclables are carried separately. */
    carriedGeneral: Schemas.Int,
    carriedRecycle: Schemas.Int,
    /** Capacity applies to the TOTAL load across both streams. */
    capacity:       Schemas.Int,
    /** Portable Bin self-empties remaining this shift (0 = none / not owned). */
    portableLeft:   Schemas.Int,
  }),
}

export const room = registerMessages(Messages)
