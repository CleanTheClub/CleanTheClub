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
import { GameState } from '../shared/schemas'
import { isActive, isKnown } from './participation'

// Authoritative ClutterSync watchers reconcile server state at this cadence rather
// than every frame.  Local cleaning feedback is optimistic/instant, so polling the
// authoritative state at 10 Hz (vs 60) is imperceptible and ~6× cheaper across the
// half-dozen systems that each scan every synced item.
export const SYNC_POLL_S = 0.1

type Handler = (phase: string) => void

const handlers: Handler[] = []
// Composite gate key: phase PLUS participation. At match start the phase flips to
// 'playing' via CRDT before the participationUpdate message lands, so handlers
// that ran on the phase edge saw isActive()===false and enabled nothing — and
// nothing re-fired them when the answer arrived, leaving every item unclickable
// for the whole round. Keying the watcher on both re-fires the handlers the
// moment participation catches up.
let lastGateKey = ''
let systemAdded = false

export function currentPhase(): string {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs.phase ?? 'playing'
  return 'playing'
}

// ── Participation gate ─────────────────────────────────────────────────────────
// Participation used to be inferred client-side: whoever first synced mid-round was
// a "waiter" until the phase returned to 'lobby'. Two things broke that. Rounds now
// continue indefinitely, so 'lobby' may never come around — a waiter could be stuck
// forever. And the GDD calls for pre sign-up rather than auto sign-up, so joining
// must be a choice, not something that happens to a player.
//
// The server now owns it (see participation.ts): a player who arrives mid-round
// spectates until they sign up, and is promoted at the next round boundary.

/** True while this player is watching rather than cleaning. */
export function isWaitingForMatch(): boolean {
  // Before the server's first answer, treat an in-progress round as spectating so
  // the sign-up prompt shows. Suppressed in the lobby, which has its own screen.
  if (!isKnown()) return currentPhase() === 'playing'
  return !isActive()
}

// Kept for call-site compatibility. Participation now arrives by message, so there
// is no local watcher to start.
export function initPhaseGate(): void {}

// True only while this player can clean: the playing phase AND actually enrolled
// in the shift. The server enforces the same rule when accepting cleans; this just
// avoids offering pointer prompts that would be rejected.
export function clicksAllowed(): boolean {
  return currentPhase() === 'playing' && isActive()
}

// Subscribe to phase transitions. The handler fires once per change with the new
// phase. Registering also starts the watcher system (idempotent).
export function onPhaseChange(handler: Handler): void {
  handlers.push(handler)
  if (!systemAdded) {
    systemAdded = true
    engine.addSystem(() => {
      const p = currentPhase()
      const key = `${p}|${isActive()}`
      if (key === lastGateKey) return
      lastGateKey = key
      for (const h of handlers) h(p)
    })
  }
}
