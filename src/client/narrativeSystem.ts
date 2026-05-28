// Triggers narrative toast pop-ups at key game moments.
// All placeholder text lives in the MESSAGES config block below — edit freely.
//
// TRIGGER TYPES
// ─────────────
//  round start   — fires when a new round begins (phase → 'playing')
//  milestone     — fires when cleanliness crosses a % threshold (once per round)
//  timer warning — fires when secondsLeft drops below a threshold (once per round)
//  round end     — fires when doors open (phase → 'open'), outcome-flavoured

import { engine, timers } from '@dcl/sdk/ecs'
import { GameState } from '../shared/schemas'
import { showNarrativeToast, triggerRoundStartIntro } from '../ui'
import { playPartyEmote } from './emoteManager'

// ─────────────────────────────────────────────────────────────────────────────
// ── Messages — edit these ────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// Round-start messages — indexed by roundNumber (0-based).
// Falls back to DEFAULT if the round index isn't listed.
const ROUND_START: Record<number, string> & { DEFAULT: string } = {
  0:         "The club's a mess, let's clean it!",
  1:         "Round 2: the crowd expects better!",
  2:         "Round 3: no excuses, make it shine!",
  3:         "Round 4: you're on fire, keep going!",
  4:         "Final round — give it everything you've got!",
  DEFAULT:   "New round: keep it up!",
}

// Cleanliness milestones — fires once per round when pct crosses the threshold.
// Keys are percentages (0–100). Add or remove entries freely.
const MILESTONES: { pct: number; text: string }[] = [
  { pct: 25, text: "Good start, keep it moving!" },
  { pct: 50, text: "Half clean, looking better already!" },
  { pct: 75, text: "Nearly clean, finish strong!" },
  { pct: 90, text: "Almost spotless, just a little more!" },
]

// Timer warnings — fires once per round when secondsLeft drops to or below the value.
// Multiple entries are fine; each fires independently.
const TIMER_WARNINGS: { seconds: number; text: string }[] = [
  { seconds: 60, text: "One minute left, hustle!" },
  { seconds: 30, text: "Thirty seconds! Hurry!" },
]

// Round-end messages, keyed by outcome string from GameState.
const ROUND_END: Record<string, string> = {
  optimal:    "Incredible, the club is immaculate!",
  adequate:   "Not bad! The doors are open but it smells...",
  suboptimal: "Yikes… The crowd isn't happy.",
  DEFAULT:    "Round over: doors are open!",
}

// Delay (ms) after phase changes before the narrative toast fires.
// A small gap lets the confetti / outcome banner land first.
const ROUND_END_DELAY_MS   = 3_000
const ROUND_START_DELAY_MS = 600

// ─────────────────────────────────────────────────────────────────────────────
// ── Init ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export function initNarrativeSystem(): void {
  let lastPhase       = ''
  let lastRoundNumber = -1

  // Milestone tracking — reset each round
  const firedMilestones = new Set<number>()
  // Timer-warning tracking — reset each round
  const firedWarnings   = new Set<number>()

  engine.addSystem(() => {
    let pct         = 0
    let phase       = 'playing'
    let roundNumber = 0
    let secondsLeft = 0
    let outcome     = ''

    for (const [, gs] of engine.getEntitiesWith(GameState)) {
      pct         = Math.min(1, gs.cleanedCount / Math.max(1, gs.totalCount))
      phase       = gs.phase
      roundNumber = gs.roundNumber
      secondsLeft = gs.secondsLeft
      outcome     = gs.outcome
      break
    }

    // ── Round transition ───────────────────────────────────────────────────────
    if (phase !== lastPhase) {
      const prev  = lastPhase
      lastPhase   = phase

      if (phase === 'playing' && prev !== '') {
        // New round started (not the very first tick)
        firedMilestones.clear()
        firedWarnings.clear()
        triggerRoundStartIntro()
      }

      if (phase === 'open') {
        // Doors opened — show outcome message after a short delay
        const text = ROUND_END[outcome] ?? ROUND_END.DEFAULT
        timers.setTimeout(() => showNarrativeToast(text), ROUND_END_DELAY_MS)
        // Party emote — fires slightly before the toast so the player is already
        // dancing when the outcome message pops up
        timers.setTimeout(() => playPartyEmote(), 500)
      }
    }

    // ── Round-number change → round start message ──────────────────────────────
    if (roundNumber !== lastRoundNumber) {
      const prev       = lastRoundNumber
      lastRoundNumber  = roundNumber

      if (prev !== -1 || phase === 'playing') {
        // Fire for every round including round 0 on first load
        const text = ROUND_START[roundNumber] ?? ROUND_START.DEFAULT
        timers.setTimeout(() => showNarrativeToast(text), ROUND_START_DELAY_MS)
      }
    }

    // ── Cleanliness milestones ─────────────────────────────────────────────────
    if (phase === 'playing') {
      const pctInt = Math.floor(pct * 100)
      for (const m of MILESTONES) {
        if (!firedMilestones.has(m.pct) && pctInt >= m.pct) {
          firedMilestones.add(m.pct)
          showNarrativeToast(m.text)
        }
      }

      // ── Timer warnings ───────────────────────────────────────────────────────
      for (const w of TIMER_WARNINGS) {
        if (!firedWarnings.has(w.seconds) && secondsLeft > 0 && secondsLeft <= w.seconds) {
          firedWarnings.add(w.seconds)
          showNarrativeToast(w.text)
        }
      }
    }
  })

  console.log('[Narrative] System ready')
}
