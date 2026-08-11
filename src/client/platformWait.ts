// Shared "is the platform known yet?" gate.
//
// getPlatform() is null until an async explorer round-trip lands, and
// isMobile() reports false for that unknown state — so anything that branches
// on platform (collider shapes, NPC caps, the mobile light) must wait. Four
// systems each carried their own copy of this wait; this is the one shared
// version. The timeout means a failed/slow platform call degrades to desktop
// behaviour instead of stalling forever — the clock starts at the FIRST call,
// so every consumer times out together.

import { getPlatform } from '@dcl/sdk/platform'

const TIMEOUT_MS = 5_000
let firstAskMs = 0
let loggedTimeout = false

/** True once the platform is known — or once the shared timeout has passed. */
export function platformSettled(): boolean {
  if (getPlatform() !== null) return true
  const now = Date.now()
  if (firstAskMs === 0) firstAskMs = now
  if (now - firstAskMs < TIMEOUT_MS) return false
  if (!loggedTimeout) {
    loggedTimeout = true
    console.log('[PLATFORM] unresolved after timeout — proceeding as desktop')
  }
  return true
}
