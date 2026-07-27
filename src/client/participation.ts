// Whether this player is cleaning the current shift, or spectating until they
// sign up for the next one.
//
// SERVER-AUTHORITATIVE MIRROR. The server decides participation and enforces it
// when accepting cleans; this only caches the answer so the UI and pointer gating
// can react. Nothing here grants participation locally — doing so would just
// produce cleanRejected replies for every click.
//
// Defaults to NOT active: until the server has told us otherwise, showing the
// sign-up prompt is the safe failure mode. Claiming to be active and letting the
// player clean would mean every click bouncing off the server instead.

import { room } from '../shared/messages'

let active   = false
let signedUp = false
let known    = false   // has any participationUpdate arrived yet?

export const isActive     = (): boolean => active
export const isSignedUp   = (): boolean => signedUp
export const isKnown      = (): boolean => known

/** Opt in to the next shift. The server confirms with a participationUpdate. */
export function signUpForNextShift(): void {
  room.send('signUpNext', { dummy: true })
}

export function cancelSignUp(): void {
  room.send('cancelSignUp', { dummy: true })
}

export function initParticipation(): void {
  room.onMessage('participationUpdate', (data) => {
    active   = data.active
    signedUp = data.signedUp
    known    = true
  })
}
