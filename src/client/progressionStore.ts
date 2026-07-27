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
import { UpgradeId } from '../shared/progression'
import { playMoneySound, playPromotionSound } from './soundManager'
import { promotionBurst } from './confettiSystem'

export type ShiftPayout = {
  money:  number
  xp:     number
  passed: boolean
  items:  number
}

export type CareerState = {
  money:      number
  xp:         number
  shifts:     number
  rank:       number
  title:      string
  nextTitle:  string | null
  fraction:   number
  upgrades:   Partial<Record<UpgradeId, number>>
  isGuest:    boolean
  lastShift:  ShiftPayout | null
  promotedTo: string | null
}

const EMPTY: CareerState = {
  money: 0, xp: 0, shifts: 0, rank: 0,
  title: 'Junior Janitor', nextTitle: 'Janitor', fraction: 0,
  upgrades: {}, isGuest: false, lastShift: null, promotedTo: null,
}

// null until the first progressUpdate lands, so the UI can distinguish "no career
// yet" from "career with zero money" and avoid flashing placeholder values.
let state: CareerState | null = null

/** Timestamp of the last payout, so the end-of-shift screen knows it is fresh. */
let lastPayoutMs = 0

export const getCareer      = (): CareerState | null => state
export const getCareerOrEmpty = (): CareerState => state ?? EMPTY
export const hasCareer      = (): boolean => state !== null
export const getLastPayoutMs = (): number => lastPayoutMs

export function upgradeLevel(id: UpgradeId): number {
  return state?.upgrades[id] ?? 0
}

/** Sends a purchase request. The server validates and replies with a progressUpdate. */
export function requestPurchase(id: UpgradeId): void {
  room.send('buyUpgrade', { upgradeId: id })
}

export function initProgressionStore(): void {
  room.onMessage('progressUpdate', (data) => {
    try {
      const next = JSON.parse(data.progressJson) as CareerState
      // A payout only accompanies a completed shift; purchases and joins send the
      // same message with lastShift null, which must NOT re-open the payout screen.
      if (next.lastShift) {
        lastPayoutMs = Date.now()
        // Wage hitting the wallet gets its own sound, not just a panel.
        if (next.lastShift.passed && next.lastShift.money > 0) playMoneySound()
      }
      // Promotion celebration — fanfare + a one-shot confetti burst. Fires for
      // shift-end promotions and admin rank grants alike.
      if (next.promotedTo) {
        playPromotionSound()
        promotionBurst()
      }
      state = next
    } catch (e) {
      console.log('[PROGRESS] failed to parse progressUpdate:', e)
    }
  })
}
