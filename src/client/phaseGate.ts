// Central game-phase gate.
//
// Pointer interactions should only be live while players can actually clean — i.e.
// during the 'playing' phase.  In any other phase (intermission / finale 'open')
// every item's clicks + hover feedback are disabled.
//
// Systems register a handler via onPhaseChange and react to transitions; they also
// call clicksAllowed() to guard their own enableClick so a mid-intermission state
// change (e.g. a round-reset) can't silently re-register pointer events.

import { engine } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { GameState } from '../shared/schemas'

// Authoritative ClutterSync watchers reconcile server state at this cadence rather
// than every frame.  Local cleaning feedback is optimistic/instant, so polling the
// authoritative state at 10 Hz (vs 60) is imperceptible and ~6× cheaper across the
// half-dozen systems that each scan every synced item.
export const SYNC_POLL_S = 0.1

type Handler = (phase: string) => void

const handlers: Handler[] = []
let lastPhase = ''
let systemAdded = false

export function currentPhase(): string {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs.phase ?? 'playing'
  return 'playing'
}

// Returns the synced GameState phase, or null if GameState hasn't arrived yet.
function syncedPhase(): string | null {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs.phase
  return null
}

// ── Mid-match lockout (client-side) ────────────────────────────────────────────
// A player who first syncs into a match already in progress (playing/open) is a
// "waiter" — they can't clean and see a "match in progress" screen until the match
// ends and the phase returns to 'lobby', at which point they join the next match.
let joinedMidMatch = false
let decided = false

export function isWaitingForMatch(): boolean {
  return joinedMidMatch
}

// Start the lockout watcher. Call once from initClient.
export function initPhaseGate(): void {
  engine.addSystem(() => {
    const phase = syncedPhase()
    if (phase === null) return   // GameState not synced yet

    // Decide once authoritative state has arrived: in a match already → waiter.
    if (!decided && isStateSyncronized()) {
      decided = true
      joinedMidMatch = phase !== 'lobby'
    }
    // Any return to the lobby clears the wait — they join the next match normally.
    if (phase === 'lobby') joinedMidMatch = false
  })
}

// True only while players can clean: the playing phase AND not a mid-match waiter.
export function clicksAllowed(): boolean {
  return currentPhase() === 'playing' && !joinedMidMatch
}

// Subscribe to phase transitions. The handler fires once per change with the new
// phase. Registering also starts the watcher system (idempotent).
export function onPhaseChange(handler: Handler): void {
  handlers.push(handler)
  if (!systemAdded) {
    systemAdded = true
    engine.addSystem(() => {
      const p = currentPhase()
      if (p === lastPhase) return
      lastPhase = p
      for (const h of handlers) h(p)
    })
  }
}
