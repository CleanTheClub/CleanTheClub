// Career progression model — job titles, XP, economy and upgrades.
//
// PURE DATA + MATH ONLY. No I/O, no engine calls, no server imports: this module is
// shared by both runtimes. The server is the sole authority that AWARDS money and XP
// (see playerProgress.ts); the client imports the same tables purely to DISPLAY
// titles, costs and progress bars, so the two can never disagree about what a given
// XP total means.
//
// All numbers here are explicitly balancing placeholders — the GDD marks XP
// requirements and upgrade costs as "subject to balancing", and weeks 2-3 of the
// plan exist to tune them against real playtests.

// ── Economy ───────────────────────────────────────────────────────────────────
// Two award sources, per the GDD:
//   • Base wage       — flat, for completing a shift to the required standard.
//   • Performance bonus — scales with how far ABOVE the standard the player cleaned,
//                        so thoroughness pays without punishing a bare pass.
export const BASE_WAGE = 100

// Paid on the fraction cleaned ABOVE the required standard, normalised so a
// perfect shift pays the full bonus. At the default thresholds a bare pass earns
// the wage alone; a 100% clean earns wage + full bonus.
export const MAX_PERFORMANCE_BONUS = 150

// XP mirrors the money split but on a smaller scale, so career progress is steady
// while spending power ramps faster.
export const BASE_XP = 40
export const MAX_PERFORMANCE_XP = 60

// Teamwork bonus — GDD lists this as "scope permitting". Applied per OTHER player
// who was present for the shift, capped so a full lobby can't trivialise the curve.
export const TEAMWORK_XP_PER_PLAYER = 10
export const TEAMWORK_XP_MAX = 40

/**
 * Money and XP for one completed shift.
 *
 * `cleanedFraction` is the shift's final cleanliness (0..1) and `passMark` the
 * standard required to be paid at all — both come from the server's own count, never
 * from the client. A shift below the pass mark earns nothing, which is what makes
 * the required standard meaningful.
 */
export function shiftRewards(
  cleanedFraction: number,
  passMark: number,
  otherPlayers = 0,
): { money: number; xp: number; passed: boolean } {
  // Below the standard: DOCKED pay proportional to effort rather than nothing.
  // A zero payout on a near-miss read as a bug in playtests ("shift failed, no
  // income?") and is brutal for solo/mobile sessions; half-rate pay keeps every
  // shift worth something while leaving a clear gap to a real pass.
  if (cleanedFraction < passMark) {
    const effort = cleanedFraction / Math.max(0.0001, passMark)   // 0..1 toward the standard
    return {
      money:  Math.round(BASE_WAGE * 0.5 * effort),
      xp:     Math.round(BASE_XP   * 0.5 * effort),
      passed: false,
    }
  }

  // How far above the pass mark, as a 0..1 fraction of the available headroom.
  const headroom = Math.max(0.0001, 1 - passMark)
  const over     = Math.min(1, (cleanedFraction - passMark) / headroom)

  const teamwork = Math.min(TEAMWORK_XP_MAX, otherPlayers * TEAMWORK_XP_PER_PLAYER)
  return {
    money:  Math.round(BASE_WAGE + MAX_PERFORMANCE_BONUS * over),
    xp:     Math.round(BASE_XP   + MAX_PERFORMANCE_XP    * over) + teamwork,
    passed: true,
  }
}

// ── Job titles ────────────────────────────────────────────────────────────────
// The GDD's twelve-rung career ladder, in order. Index === rank.
export const JOB_TITLES: string[] = [
  'Junior Janitor',
  'Janitor',
  'Cleaner',
  'Senior Cleaner',
  'Cleaning Specialist',
  'Shift Supervisor',
  'Operations Supervisor',
  'Assistant Manager',
  'Floor Manager',
  'Night Manager',
  'General Manager',
  'Club Owner',
]

// Cumulative XP required to HOLD each title. Index matches JOB_TITLES.
//
// Shaped against the GDD's player-journey beats, assuming a decent shift pays
// roughly 80-100 XP:
//   • promotions come fast early (rungs 1-3 inside the first few shifts) so a new
//     player feels the ladder immediately;
//   • ~20 shifts lands mid-ladder, matching "I'm getting much faster";
//   • Club Owner is a genuine long haul without being unreachable.
export const TITLE_XP: number[] = [
  0,      // Junior Janitor
  150,    // Janitor
  400,    // Cleaner
  800,    // Senior Cleaner
  1_400,  // Cleaning Specialist
  2_200,  // Shift Supervisor
  3_300,  // Operations Supervisor
  4_800,  // Assistant Manager
  6_800,  // Floor Manager
  9_500,  // Night Manager
  13_000, // General Manager
  18_000, // Club Owner
]

/** Rank index (0..JOB_TITLES.length-1) for a given lifetime XP total. */
export function rankForXp(xp: number): number {
  let rank = 0
  for (let i = 0; i < TITLE_XP.length; i++) {
    if (xp >= TITLE_XP[i]) rank = i
  }
  return rank
}

export const titleForXp = (xp: number): string => JOB_TITLES[rankForXp(xp)]

/**
 * Progress towards the NEXT promotion, for the GDD's title + progress bar:
 *   Night Manager
 *   █████████░ 95%
 *
 * At max rank returns fraction 1 and a null next title — the UI should show the
 * ladder as complete rather than a bar that can never fill.
 */
export function titleProgress(xp: number): {
  rank: number
  title: string
  nextTitle: string | null
  fraction: number
  xpIntoRank: number
  xpForNextRank: number
} {
  const rank  = rankForXp(xp)
  const title = JOB_TITLES[rank]
  if (rank >= JOB_TITLES.length - 1) {
    return { rank, title, nextTitle: null, fraction: 1, xpIntoRank: 0, xpForNextRank: 0 }
  }
  const floor = TITLE_XP[rank]
  const next  = TITLE_XP[rank + 1]
  const span  = Math.max(1, next - floor)
  return {
    rank,
    title,
    nextTitle:     JOB_TITLES[rank + 1],
    fraction:      Math.max(0, Math.min(1, (xp - floor) / span)),
    xpIntoRank:    xp - floor,
    xpForNextRank: span,
  }
}

// ── Upgrades ──────────────────────────────────────────────────────────────────
// Per the GDD: a SMALL set of upgrades, each improvable several times, rather than
// many one-shot unlocks. Keeps the shop readable and leaves room to extend later.
//
// `levelValues[0]` is the baseline every player starts with, so level N always maps
// to levelValues[N] and an un-upgraded player needs no special-casing.
// `costs[i]` is the price to go from level i to level i+1.
// `minRank`, when set, gates the upgrade behind a job title (GDD: "some upgrades
// will require unlocking a certain Job Title").

export type UpgradeId = 'movementSpeed' | 'moppingSpeed' | 'carryCapacity' | 'portableBin' | 'vacuum'

export type UpgradeDef = {
  id: UpgradeId
  name: string
  description: string
  levelValues: number[]
  costs: number[]
  minRank?: number
  /** False while the mechanic it depends on doesn't exist yet — hidden in the shop. */
  implemented: boolean
}

export const UPGRADES: UpgradeDef[] = [
  {
    id: 'movementSpeed',
    name: 'Movement Speed',
    description: 'Get around the club faster.',
    // Multipliers on the default avatar locomotion speeds. Applied via the SDK's
    // AvatarLocomotionSettings component (walkSpeed/jogSpeed/runSpeed).
    levelValues: [1.0, 1.12, 1.24, 1.36, 1.5],
    costs:       [200, 450, 900, 1_600],
    implemented: true,
  },
  {
    id: 'moppingSpeed',
    name: 'Mopping Speed',
    description: 'Clean sticky patches in less time.',
    // Multiplier on HOLD_DURATION_MS — higher level = shorter hold.
    levelValues: [1.0, 0.88, 0.78, 0.68, 0.6],
    costs:       [250, 500, 1_000, 1_800],
    implemented: true,
  },
  {
    id: 'carryCapacity',
    name: 'Carry Capacity',
    description: 'Hold more rubbish before emptying.',
    // Total pieces held across both streams before a bin trip. Round numbers on
    // purpose — "8" read as arbitrary in playtests; a 10-…-30 ladder in steps of
    // 5 is legible at a glance and starts a touch easier (glasses/bottles count
    // toward the load since they joined the carry loop).
    levelValues: [10, 15, 20, 25, 30],
    costs:       [300, 650, 1_300, 2_400],
    minRank:     2,   // Cleaner
    implemented: true,
  },
  {
    id: 'portableBin',
    name: 'Portable Bin',
    description: 'Empty your hands on the spot — limited uses each shift.',
    // Level = on-the-spot empties per shift (no trip to a big bag needed).
    levelValues: [0, 1, 2, 3],
    costs:       [1_200, 2_500, 4_500],
    minRank:     5,   // Shift Supervisor
    implemented: true,
  },
  {
    id: 'vacuum',
    name: 'Vacuum',
    description: 'Sweep up several pieces of mess at once.',
    // Level = EXTRA rubbish pieces swept per click (nearest first, within the
    // server's sweep radius, never past remaining carry space).
    levelValues: [0, 1, 2, 3],
    costs:       [2_000, 4_000, 7_500],
    minRank:     7,   // Assistant Manager
    implemented: true,
  },
]

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = UPGRADES.reduce(
  (acc, u) => { acc[u.id] = u; return acc },
  {} as Record<string, UpgradeDef>,
)

/** Max level an upgrade can reach (levelValues[0] is the baseline, so length - 1). */
export const maxLevel = (def: UpgradeDef): number => def.levelValues.length - 1

/** Effective value of an upgrade at `level`, clamped so bad data can't crash play. */
export function upgradeValue(id: UpgradeId, level: number): number {
  const def = UPGRADE_BY_ID[id]
  if (!def) return 1
  const lvl = Math.max(0, Math.min(maxLevel(def), Math.floor(level)))
  return def.levelValues[lvl]
}

/** Cost to buy the next level, or null if maxed. */
export function nextUpgradeCost(id: UpgradeId, level: number): number | null {
  const def = UPGRADE_BY_ID[id]
  if (!def || level >= maxLevel(def)) return null
  return def.costs[level]
}

export type PurchaseRefusal = 'unknown' | 'maxed' | 'locked' | 'funds'

/**
 * Whether a purchase is allowed. Server-side authority: the client may render the
 * shop however it likes, but only this decides, and it is called with the SERVER's
 * copy of money/xp/levels.
 */
export function canPurchase(
  id: UpgradeId,
  level: number,
  money: number,
  xp: number,
): { ok: true; cost: number } | { ok: false; reason: PurchaseRefusal } {
  const def = UPGRADE_BY_ID[id]
  if (!def || !def.implemented) return { ok: false, reason: 'unknown' }
  const cost = nextUpgradeCost(id, level)
  if (cost === null) return { ok: false, reason: 'maxed' }
  if (def.minRank !== undefined && rankForXp(xp) < def.minRank) return { ok: false, reason: 'locked' }
  if (money < cost) return { ok: false, reason: 'funds' }
  return { ok: true, cost }
}
