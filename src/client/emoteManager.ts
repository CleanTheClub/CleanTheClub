import { engine, Transform, timers, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { triggerSceneEmote, stopEmote } from '~system/RestrictedActions'
import { isMobile } from '@dcl/sdk/platform'
import { PICKUP_EMOTE_MS, MOPPING_EMOTE_MS } from '../shared/config'
import { repreload } from './preload'

// Every emote RPC is fire-and-forget, and an unhandled rejection inside a
// pointer callback kills the whole scene ("scene error" + reload prompt). The
// mobile explorer CAN reject these — it evicts emote GLBs after an app suspend
// (see the rewarm notes below) — so a retried mop after a resume was a crash.
// All call sites go through these caught wrappers.
type EmoteOpts = Parameters<typeof triggerSceneEmote>[0]
function fireEmote(opts: EmoteOpts): void {
  triggerSceneEmote(opts).catch((e) => console.log('[EMOTE] trigger failed:', e))
}
function fireStopEmote(): void {
  stopEmote({}).catch((e) => console.log('[EMOTE] stop failed:', e))
}

const PICKUP_EMOTE_SRC  = 'assets/scene/Emotes/PickUp_Anim_emote.glb'
const MOPPING_EMOTE_SRC = 'assets/scene/Emotes/Mopping_emote.glb'
const PARTY_EMOTE_SRC   = 'assets/scene/Emotes/PartyPhone_emote.glb'

// ── Carry pose (upper-body masked, survives locomotion) ───────────────────────
// triggerSceneEmote accepts mask: AvatarMask.AM_UPPER_BODY — animation LAYERING:
// the emote drives arms/torso while locomotion keeps the legs, so a masked loop
// is the long-sought "bent arms while walking". AvatarMask isn't re-exported on
// the public SDK surface yet (const enum in generated pb typings), hence the
// literal below.
const AM_UPPER_BODY   = 0
// Real carry clip (1s loop, left arm posed under the box to match the
// left-hand attach; replaces the PartyPhone placeholder).
// Carry fused with the stock idle (scripts/one-off: fuse_emote.py): the
// carrying LEFT arm keeps Carry_emote's keys UNCHANGED (so carrySystem's
// computed hand counter-rotation stays valid), while head/torso/right arm/legs
// come from the explorer's idle — the free arm and body idle naturally instead
// of holding a stiff two-armed pose. 1s carry loop tiled twice into the 2s
// idle cycle, seam-free.
const CARRY_POSE_SRC  = 'assets/scene/Emotes/CarryIdle_emote.glb'
let carryPoseWanted = false
const PARTY_EMOTE_MS    = 9_700  // match clip duration exactly
// (Step-to-item constants removed with the mechanic — see playStepEmote.)

let emoteActive = false

const EMOTE_STOP_ACTIONS = [
  InputAction.IA_FORWARD,
  InputAction.IA_BACKWARD,
  InputAction.IA_LEFT,
  InputAction.IA_RIGHT,
  InputAction.IA_JUMP,
] as const

function stopPickupEmote() {
  if (!emoteActive) return
  emoteActive = false
  carryLoopLive = false
  if (carryPoseWanted) {
    // Do NOT stopEmote() first: both calls are async, and when the stop lands
    // after the fresh trigger it kills the new loop — which the stillness
    // keeper then restarts, reading as a visible double-trigger. Triggering
    // the carry loop directly replaces the one-shot atomically.
    reassertCarryPose()
  } else {
    // stopEmote(), not the old empty-src hack: an empty src does NOT cancel a
    // masked LOOPING emote — the explorer keeps the loop registered and
    // resumes it after a one-shot ends (field-verified).
    fireStopEmote()
  }
}

/**
 * Hold or release the carry pose. Driven by the carry system: hands full → on,
 * hands empty → off. The masked loop persists through walking; one-shot emotes
 * (pickup, mop, party) temporarily replace it and stopPickupEmote re-asserts it.
 */
export function setCarryPose(active: boolean) {
  if (carryPoseWanted === active) return
  carryPoseWanted = active
  if (active) reassertCarryPose()
  else {
    carryLoopLive = false
    // Kill the loop for real (see stopPickupEmote). If a one-shot is mid-play
    // (the deposit dump), let it finish — its own stop clears the loop too and
    // reassert is a no-op once wanted is false.
    if (!emoteActive) fireStopEmote()
  }
}

function reassertCarryPose() {
  if (!carryPoseWanted || emoteActive) return
  fireEmote({ src: CARRY_POSE_SRC, loop: true, mask: AM_UPPER_BODY })
  carryLoopLive = true
}

// ── Mobile fallback: re-assert on stop ────────────────────────────────────────
// Device-verified (2026-08-03): the DESKTOP explorer honours the upper-body mask
// through locomotion, but the MOBILE explorer still cancels the emote on
// movement. Until that lands, mobile gets the next best thing: the pose snaps
// back every time the player stops moving. Walk = swinging arms, stop = laden.
// Harmless on desktop (the loop stays live there, so this never fires).
let carryLoopLive = false
let stillForS = 0
let lastPos: { x: number; y: number; z: number } | null = null
const REASSERT_AFTER_STILL_S = 0.25
const MOVE_EPSILON_M = 0.02

function carryPoseKeeper(dt: number): void {
  if (!carryPoseWanted) { lastPos = null; return }
  const p = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!p) return
  const moved = lastPos
    ? Math.abs(p.x - lastPos.x) + Math.abs(p.y - lastPos.y) + Math.abs(p.z - lastPos.z) > MOVE_EPSILON_M
    : false
  lastPos = { x: p.x, y: p.y, z: p.z }
  if (moved) {
    // Locomotion cancels the loop on mobile — remember it needs restoring.
    if (isMobile()) carryLoopLive = false
    stillForS = 0
    return
  }
  stillForS += dt
  if (!carryLoopLive && stillForS >= REASSERT_AFTER_STILL_S) reassertCarryPose()
}

// Public cancel — stops whatever scene emote is playing (e.g. when a hold-to-clean
// is released before completing).  Also pre-empts a pending (delayed) emote trigger,
// since playStepEmote checks emoteActive before firing.
export function cancelEmote() {
  stopPickupEmote()
}

// Persistent per-frame system — cancels the emote the moment the player moves
function emoteWatchSystem(): void {
  if (!emoteActive) return
  for (const action of EMOTE_STOP_ACTIONS) {
    if (inputSystem.isTriggered(action, PointerEventType.PET_DOWN)) {
      stopPickupEmote()
      return
    }
  }
}

// Emote GLB residency is now the platform's job — see client/preload.ts, which
// lists these four in its AssetLoad set. That replaces the old trick of parking
// four hidden entities underground purely to hold a GltfContainer reference so
// the engine wouldn't evict the asset before the first mop.

// A mobile app-switch SUSPENDS the client without reloading the scene; the OS
// can flush asset memory meanwhile, and the resident references above don't
// force a re-fetch on resume — so the mop emote silently stopped playing until
// a full reload (playtest). A huge wall-clock gap between frames IS the resume
// signal; delete-and-recreate the warm-up GltfContainers to force re-fetches
// (same trick as the bin load watchdog).
const RESUME_GAP_MS = 5_000
let lastFrameWallMs = 0
function emoteRewarmOnResume() {
  const now  = Date.now()
  const prev = lastFrameWallMs
  lastFrameWallMs = now
  if (prev === 0) return                    // first frame — nothing to measure
  const gap = now - prev
  if (gap < RESUME_GAP_MS) return
  console.log(`[EMOTE] app resumed after ${Math.round(gap / 1000)}s — re-issuing preload`)
  // AssetLoad guards against ENGINE eviction, but a suspended app can still
  // have its memory reclaimed by the OS — re-request so the fetch happens again.
  repreload()
  // The carry LOOP also died in the suspend, but the keeper believes it's live
  // (staleness is only detected via movement, and nothing moved while frozen).
  // Mark it stale now — and again once the re-fetched GLB has had time to land,
  // in case the first re-assert fired against a still-cold asset (a cold
  // triggerSceneEmote no-ops silently).
  carryLoopLive = false
  timers.setTimeout(() => { carryLoopLive = false }, 3_000)
}

// Call once from initClient so the watch system runs every frame
export function initEmoteManager() {
  engine.addSystem(emoteWatchSystem)
  engine.addSystem(carryPoseKeeper)
  engine.addSystem(emoteRewarmOnResume)
}

// Fires the party emote on the local player at round end.
// No movement — player dances where they stand.
// Cancels immediately if the player moves (same emoteWatchSystem guard).
export function playPartyEmote() {
  if (emoteActive) stopPickupEmote()
  emoteActive = true
  fireEmote({ src: PARTY_EMOTE_SRC, loop: false })
  timers.setTimeout(() => stopPickupEmote(), PARTY_EMOTE_MS)
}

// Shared one-shot interaction emote — plays WHERE THE PLAYER STANDS, always.
// Step-to-item (movePlayerTo toward the clicked item) is fully retired: mobile
// lost it first (fat-tap teleports into geometry + camera wrench), and desktop
// players reported the same class of problem — moved into puddles or past
// their destination, worst while still holding a movement key (feedback §5).
// Nobody's avatar moves except by their own input; the reach gate in phaseGate
// is what now enforces "get closer to interact".
// targetPos is kept for the callers' sake (positions still gate reach + FX).
// Like the pickup emote it also auto-cancels the moment the player moves
// (handled by the shared emoteWatchSystem).
function playStepEmote(
  _targetPos: { x: number; y: number; z: number },
  src:       string,
  durationMs: number,
) {
  if (emoteActive) stopPickupEmote()
  emoteActive = true
  fireEmote({ src, loop: false })
  timers.setTimeout(() => stopPickupEmote(), durationMs)
}

// Fires the pickup emote — quick-clean items (rubbish, bottles, glasses, clutter).
export function playPickupEmote(targetPos: { x: number; y: number; z: number }) {
  playStepEmote(targetPos, PICKUP_EMOTE_SRC, PICKUP_EMOTE_MS)
}

// Fires the mopping emote — hold-to-clean sticky patches. The player is already on
// the patch, so it fires immediately (triggerDelayMs = 0) for an instant response.
export function playMoppingEmote(targetPos: { x: number; y: number; z: number }, durationMs = MOPPING_EMOTE_MS) {
  playStepEmote(targetPos, MOPPING_EMOTE_SRC, durationMs)
}
