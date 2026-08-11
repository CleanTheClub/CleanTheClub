// Cleaning sprees — rapid consecutive cleans build a combo with a rising chime.
//
// Pure moment-to-moment juice: no payout attached (the sound ladder and the
// on-screen counter ARE the reward), so it needs no server involvement and no
// anti-cheat surface. Every accepting click path calls registerSpreeHit().
//
// FRENZY: during the round's final seconds each clean counts double toward the
// spree, turning the wind-down into a rush.

import { gameState } from './phaseGate'
import { flashSpree } from '../ui'
import { playSpreeSound } from './soundManager'

const WINDOW_MS      = 2_500   // max gap between cleans that keeps a spree alive
const MIN_SHOW       = 3       // sprees announce from ×3 — pairs happen by accident
export const FRENZY_LAST_S = 20

let count  = 0
let lastMs = 0

function inFrenzy(): boolean {
  const gs = gameState()
  return gs ? gs.phase === 'playing' && (gs.secondsLeft ?? 999) <= FRENZY_LAST_S : false
}

export function registerSpreeHit(): void {
  const now = Date.now()
  const inc = inFrenzy() ? 2 : 1
  count  = now - lastMs <= WINDOW_MS ? count + inc : inc
  lastMs = now
  if (count >= MIN_SHOW) {
    flashSpree(count)
    playSpreeSound(count)
  }
}
