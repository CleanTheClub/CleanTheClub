import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // ── Client → Server ─────────────────────────────────────────
  cleanItem:        Schemas.Map({ itemId: Schemas.String }),
  adminReset:       Schemas.Map({ dummy: Schemas.Boolean }),  // admin only
  /** Admin testing tool — grant yourself money and/or XP. Admin-gated server-side. */
  adminGrant:       Schemas.Map({ money: Schemas.Int, xp: Schemas.Int }),
  /**
   * Admin testing tool — pin the round theme. Sticky: every following round uses
   * this theme until changed; themeId '' returns to normal random rolling.
   * Admin-gated server-side.
   */
  adminForceTheme:  Schemas.Map({ themeId: Schemas.String }),
  /**
   * Admin testing tool — SET a gear achievement's progress to a stage
   * ('zero' | 'half' | 'almost' | 'full') so pedestal texts, payout lines and
   * the equip flow can be walked through every state. Admin-gated server-side.
   */
  adminAchievement: Schemas.Map({ gear: Schemas.String, stage: Schemas.String }),
  startMatch:       Schemas.Map({ dummy: Schemas.Boolean }),  // any player — start a match from the lobby
  /** Sent on join so the server can map address → display name for the leaderboard. */
  registerPlayer:   Schemas.Map({ displayName: Schemas.String }),
  /**
   * Sent immediately on client start (no async wait) to wake a cold server ASAP,
   * then every ~5s as the presence heartbeat the server counts players by.
   */
  ping:             Schemas.Map({ dummy: Schemas.Boolean }),
  /**
   * DESKTOP-only deliberate-exit announcement (walked out / teleported away) —
   * the server ejects the sender from the round immediately, no reconnect
   * grace. Mobile never sends this: its suspends must keep riding the presence
   * timeout + grace. Best-effort — a torn-down runtime that fails to send just
   * falls back to the timeout.
   */
  leavingScene:     Schemas.Map({ dummy: Schemas.Boolean }),
  /** Equip ('Disco_Ball' …) or clear ('') a flex carry container. The server
   *  re-checks the achievement, so an unearned equip is refused. */
  equipGear:        Schemas.Map({ gear: Schemas.String }),
  /** Request to buy the next level of an upgrade. Server validates and pays. */
  buyUpgrade:       Schemas.Map({ upgradeId: Schemas.String }),
  /**
   * Client-reported UNLOADABLE item: its GLB never reached FINISHED despite
   * the watchdog's forced reloads, so this client sees stink + a tap target
   * with no mesh. The server clears the item from the round — no pay, no
   * stats — rather than leaving mess nobody can see ("why don't we just
   * remove unloaded items from rounds?"). Rate-limited and capped per client
   * per round server-side, so a crafted client can't farm round completion.
   */
  ghostItem:        Schemas.Map({ itemId: Schemas.String }),
  /**
   * CLUB OWNER privilege — pick the NEXT round's theme ('' = classic). Server
   * validates rank (top of the ladder), phase (intermission only) and that no
   * owner has picked yet this intermission (first click wins the night).
   */
  ownerPickTheme:   Schemas.Map({ themeId: Schemas.String }),
  /** Opt in to the next shift. Takes effect when the next round starts. */
  signUpNext:       Schemas.Map({ dummy: Schemas.Boolean }),
  /** Withdraw a pending sign-up (back to spectating). */
  cancelSignUp:     Schemas.Map({ dummy: Schemas.Boolean }),
  /**
   * Empty carried rubbish into a bin. binType is 'general' or 'recycle' — the
   * bin only accepts its own stream, so only that type's count resets.
   */
  depositRubbish:   Schemas.Map({ binType: Schemas.String, binName: Schemas.String }),
  /** Empty on the spot via the Portable Bin upgrade (limited uses per shift). */
  portableEmpty:    Schemas.Map({ dummy: Schemas.Boolean }),
  /** Pick up an overflowing BIN itself (empty hands only) — the named bin
   *  vanishes from its station into the player's hands. */
  takeFullBag:      Schemas.Map({ binType: Schemas.String, binName: Schemas.String }),
  /** Empty the hauled bin into a dumpster — stream unlocks; the empty bin is
   *  still in hand and must be carried home. */
  dumpsterEmpty:    Schemas.Map({ dummy: Schemas.Boolean }),
  /** Set the emptied bin back at its station — completes the round trip and
   *  banks the haul bonus. */
  returnBin:        Schemas.Map({ dummy: Schemas.Boolean }),
  /**
   * Career-storage health for the admin panel: backend in use, load state,
   * last save result. JSON of persistence.ts DocStatus. Sent on join and after
   * every save attempt — a silent persistence failure cost real careers once.
   */
  storageStatus:    Schemas.Map({ statusJson: Schemas.String }),
  /**
   * PUBLIC carry state, broadcast to everyone on every change: remote clients
   * attach a carry box (or hauled bin) to that player's hand. Without it, other
   * players saw the carry EMOTE with visibly empty hands (live test).
   */
  carryPublic:      Schemas.Map({
    address:   Schemas.String,
    total:     Schemas.Int,
    capacity:  Schemas.Int,
    hauling:   Schemas.String,
    haulStage: Schemas.String,
    /** Carry container model NAME (Janitor Gear) — server-resolved from this
     *  player's upgrades, so remote clients can't be told to render gear the
     *  player hasn't bought. Empty = fall back to the default box. */
    gear:      Schemas.String,
    // Which station bin the haul took — clients hide/show that bin themselves.
    // (The server's old Transform write on the bin never replicated: composite
    // entities aren't syncEntity'd, so remote players saw the bin stay put.)
    haulBinName: Schemas.String,
  }),

  // ── Server → Client ─────────────────────────────────────────
  cleanRejected:    Schemas.Map({ itemId: Schemas.String }),
  /**
   * Broadcast when a player reaches CLUB OWNER (top of the ladder) — the whole
   * room celebrates: toast, crowd cheer, coronation sting on every client.
   * The new owner's own client additionally runs the full confetti barrage via
   * its progressUpdate path.
   */
  ownerCrowned:     Schemas.Map({ address: Schemas.String, displayName: Schemas.String }),
  /** Broadcast when an owner's theme pick is accepted — announces the night. */
  ownerThemePicked: Schemas.Map({ themeTitle: Schemas.String, displayName: Schemas.String }),
  /** Point-to-point verdict on an ownerPickTheme request (reason shown on refusal). */
  ownerPickResult:  Schemas.Map({ ok: Schemas.Boolean, reason: Schemas.String }),
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
    /** '' | 'general' | 'recycle' — this player is hauling that stream's BIN
     *  (hands are the bin: pickups blocked meanwhile). */
    hauling:        Schemas.String,
    /** '' | 'out' (full bin → dumpster) | 'back' (empty bin → its station). */
    haulStage:      Schemas.String,
    /** Scene Name of the bin being hauled — the return spot. */
    haulBinName:    Schemas.String,
  }),
}

export const room = registerMessages(Messages)
