// Client-side mirror of this player's career state.
//
// READ-ONLY MIRROR. The server owns every value here; this module only caches the
// last progressUpdate so the UI can render without asking. Nothing in the client
// ever mutates money, XP or upgrade levels locally — a purchase sends a request and
// waits for the server's reply, so an optimistic client can never disagree with the
// wallet the server is actually keeping.
//
// The React-ECS renderer re-runs its ui() function continuously, so plain module
// state is enough to drive the UI — no subscription plumbing needed.

import { room } from '../shared/messages'
import { UpgradeId, AchievementState, JOB_TITLES } from '../shared/progression'
import { playMoneySound, playPromotionSound } from './soundManager'
import { promotionBurst, purchaseBurst, ownerCelebration } from './confettiSystem'

export type ShiftPayout = {
  money:  number
  xp:     number
  passed: boolean
  items:  number
  // Juice layer — all optional-shaped so an older server payload still parses.
  grade:         string
  tip:           number
  /** Early-close reward: the crew hit 100% and closed `earlySeconds` ahead. */
  earlyBonus?:   number
  earlySeconds?: number
  /** Disaster-spot finale bonus — this player landed the polish. */
  disasterBonus?: number
  /** Dumpster-run pay — banked per haul during the round. */
  haulBonus?: number
  contractLabel: string | null
  contractDone:  boolean
  contractBonus: number
  openingBonus:  boolean
  streakDays:    number
  streakXp:      number
  newBest:       boolean
}

/** The shift contract mirror — server-rolled goal + live progress. */
export type ContractState = {
  kind: string; target: number; progress: number
  money: number; xp: number; label: string
}

export type CareerState = {
  openingAvailable: boolean
  money:      number
  xp:         number
  shifts:     number
  rank:       number
  title:      string
  nextTitle:  string | null
  fraction:   number
  upgrades:   Partial<Record<UpgradeId, number>>
  isGuest:    boolean
  /** Personal best items-in-one-shift; optional-shaped for older payloads. */
  bestItems?: number
  lastShift:  ShiftPayout | null
  promotedTo: string | null
  /** Equipped flex carrier ('' = none) — server-validated. */
  flexGear?:  string
  /** Live achievement progress, server-computed. */
  achievements?: AchievementState[]
}

const EMPTY: CareerState = {
  openingAvailable: false,
  money: 0, xp: 0, shifts: 0, rank: 0,
  title: 'Junior Janitor', nextTitle: 'Janitor', fraction: 0,
  upgrades: {}, isGuest: false, lastShift: null, promotedTo: null,
}

// null until the first progressUpdate lands, so the UI can distinguish "no career
// yet" from "career with zero money" and avoid flashing placeholder values.
let state: CareerState | null = null

/** Timestamp of the last payout, so the end-of-shift screen knows it is fresh. */
let lastPayoutMs = 0

/** Items cleaned in the shift BEFORE the current payout — session-only, for the
 *  payout card's "+N vs last shift" improvement line. -1 until two payouts. */
let prevShiftItems = -1
export const getPrevShiftItems = (): number => prevShiftItems

/** Last server-CONFIRMED upgrade purchase — drives the shop row's flash. Diffed
 *  from progressUpdate rather than set on request, so a refused buy (stale
 *  money, rank gate) celebrates nothing. */
let lastPurchase: { id: UpgradeId; ms: number } | null = null
export const getLastPurchase = (): { id: UpgradeId; ms: number } | null => lastPurchase

/** Last promotion — title, post-promotion rank (for the tier colour) and when.
 *  Drives the transient PROMOTED banner. */
let lastPromotion: { title: string; rank: number; ms: number } | null = null
export const getLastPromotion = (): { title: string; rank: number; ms: number } | null => lastPromotion

export const getCareer      = (): CareerState | null => state
export const getCareerOrEmpty = (): CareerState => state ?? EMPTY
export const getLastPayoutMs = (): number => lastPayoutMs

export function upgradeLevel(id: UpgradeId): number {
  return state?.upgrades[id] ?? 0
}

export const getFlexGear = (): string => state?.flexGear ?? ''
export const getAchievements = (): AchievementState[] => state?.achievements ?? []

/** Sends a purchase request. The server validates and replies with a progressUpdate. */
export function requestPurchase(id: UpgradeId): void {
  room.send('buyUpgrade', { upgradeId: id })
}

let contract: ContractState | null = null
export const getContract = (): ContractState | null => contract

export function initProgressionStore(): void {
  room.onMessage('contractUpdate', (data) => {
    try {
      contract = data.contractJson ? (JSON.parse(data.contractJson) as ContractState) : null
    } catch {
      contract = null
    }
  })

  room.onMessage('progressUpdate', (data) => {
    try {
      const next = JSON.parse(data.progressJson) as CareerState
      // A payout only accompanies a completed shift; purchases and joins send the
      // same message with lastShift null, which must NOT re-open the payout screen.
      if (next.lastShift) {
        // Remember the outgoing payout's items before this one replaces it —
        // the card shows the delta between consecutive shifts.
        if (state?.lastShift) prevShiftItems = state.lastShift.items
        lastPayoutMs = Date.now()
        // Wage hitting the wallet gets its own sound, not just a panel.
        if (next.lastShift.passed && next.lastShift.money > 0) playMoneySound()
      }
      // Promotion celebration — fanfare + a one-shot confetti burst. Fires for
      // shift-end promotions and admin rank grants alike.
      if (next.promotedTo) {
        playPromotionSound()
        // The FINAL promotion is the career's summit — one full finale barrage
        // instead of the standard pop (playtest: "something special needs to
        // happen when I rank up to Club Owner").
        if (next.promotedTo === JOB_TITLES[JOB_TITLES.length - 1]) ownerCelebration()
        else promotionBurst()
        lastPromotion = { title: next.promotedTo, rank: next.rank, ms: Date.now() }
      }
      // Purchase celebration — a level ROSE versus the previous mirror (the join
      // sync has no previous state, so a returning player's levels stay quiet).
      // One purchase per server reply, so the first hit is the whole story.
      if (state !== null) {
        for (const id of Object.keys(next.upgrades) as UpgradeId[]) {
          if ((next.upgrades[id] ?? 0) > (state.upgrades[id] ?? 0)) {
            lastPurchase = { id, ms: Date.now() }
            playMoneySound()
            purchaseBurst()
            break
          }
        }
      }
      state = next
    } catch (e) {
      console.log('[PROGRESS] failed to parse progressUpdate:', e)
    }
  })
}
