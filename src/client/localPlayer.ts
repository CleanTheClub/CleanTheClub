// Own-identity resolution + local-only scene-entry events, shared by every
// client system.
//
// onEnterSceneObservable fires for EVERY avatar that walks in, but subscribers
// here use it to reset local caches after a reload / mobile app-resume — and
// treating a remote arrival as "we re-entered" wiped live state on every
// client whenever anybody entered (cancelled in-progress holds, re-queued
// every sticky pop-in; live two-player test). onLocalEnterScene filters that
// centrally, so subscribers can't forget the guard.
//
// getUserData is retried (rejects and empty answers both happen on mobile —
// same hardening the carry system needed): an unresolved address would
// silently disable every re-entry reset for the whole session.

import { timers } from '@dcl/sdk/ecs'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { getUserData } from '~system/UserIdentity'

const RESOLVE_ATTEMPTS = 10

let ownAddress: string | null = null
const addressWaiters: Array<(addr: string) => void> = []

function resolveOwnAddress(attempt: number): void {
  getUserData({})
    .then((res) => {
      const addr = (res.data?.userId ?? '').toLowerCase()
      if (!addr) { scheduleRetry(attempt); return }
      ownAddress = addr
      for (const w of addressWaiters) w(addr)
      addressWaiters.length = 0
    })
    .catch((e) => {
      console.log('[LOCAL] getUserData failed:', e)
      scheduleRetry(attempt)
    })
}

function scheduleRetry(attempt: number): void {
  if (attempt < RESOLVE_ATTEMPTS) {
    timers.setTimeout(() => resolveOwnAddress(attempt + 1), 1_000)
  } else {
    console.log('[LOCAL] own address never resolved — re-entry resets inactive this session')
  }
}

export function initLocalPlayer(): void {
  resolveOwnAddress(0)
}

/** Runs cb with the (lowercased) own address — immediately if already known. */
export function onOwnAddress(cb: (addr: string) => void): void {
  if (ownAddress) cb(ownAddress)
  else addressWaiters.push(cb)
}

/** True only when the entering avatar is the local player. Unknown-own-address
 *  counts as NOT local: a remote arrival must never wipe state, and our own
 *  boot entry needs no reset because init has just built everything fresh. */
export function isLocalEnter(userId: string | undefined): boolean {
  if (!userId || !ownAddress) return false
  return userId.toLowerCase() === ownAddress
}

/** Subscribe to the LOCAL player's scene (re-)entries only. */
export function onLocalEnterScene(cb: () => void): void {
  onEnterSceneObservable.add((p) => {
    if (isLocalEnter(p.userId)) cb()
  })
}
