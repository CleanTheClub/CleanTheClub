import { engine, Transform, GltfContainer, timers, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { movePlayerTo, triggerSceneEmote, stopEmote } from '~system/RestrictedActions'
import { isMobile } from '@dcl/sdk/platform'
import { PICKUP_EMOTE_MS, MOPPING_EMOTE_MS } from '../shared/config'

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
const CARRY_POSE_SRC  = 'assets/scene/Emotes/Carry_emote.glb'
let carryPoseWanted = false
const PARTY_EMOTE_MS    = 9_700  // match clip duration exactly
const INTERACT_DISTANCE = 1.5   // metres — how close player steps to the item
const EMOTE_TRIGGER_MS  = 200   // ms — delay after movePlayerTo before emote fires
// If the player is already within INTERACT_DISTANCE + this slack, skip movePlayerTo
// entirely. Most cleans happen with the player standing right on top of the item, so
// the "step" was a sub-metre nudge that bought nothing and cost a camera swing —
// and, for hold items, could slide the cursor off the patch mid-hold (see the
// release-detection note in InteractionManager).
const REPOSITION_SLACK  = 0.75  // metres

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
    stopEmote({})
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
    if (!emoteActive) stopEmote({})
  }
}

function reassertCarryPose() {
  if (!carryPoseWanted || emoteActive) return
  triggerSceneEmote({ src: CARRY_POSE_SRC, loop: true, mask: AM_UPPER_BODY })
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

// Pre-warm the emote GLBs so the FIRST time each one is triggered it plays instantly
// instead of stalling while the asset loads. The pickup emote stays warm naturally
// (it fires on every quick item), but the mopping emote only plays on sticky patches,
// so a player's first mop used to pay the full load cost — that "loading" stutter.
//
// We instantiate each GLB on a hidden entity (tiny scale, far underground), which
// loads the asset. Crucially these entities are kept ALIVE for the whole session:
// the engine evicts a GLB once nothing references it, so an earlier "load then remove"
// warm-up got unloaded again long before the first real mop (which only happens after
// the lobby + countdown, 15s+ in) — leaving it cold exactly when it mattered. Holding
// a permanent reference keeps the asset resident so every mop is instant.
const EMOTE_WARMUP_DELAY_MS = 3_000   // wait out the initial scene-item load spike first
function warmUpEmotes() {
  timers.setTimeout(() => {
    for (const src of [MOPPING_EMOTE_SRC, PICKUP_EMOTE_SRC, PARTY_EMOTE_SRC, CARRY_POSE_SRC]) {
      const e = engine.addEntity()
      Transform.create(e, { position: { x: 0, y: -100, z: 0 }, scale: { x: 0.001, y: 0.001, z: 0.001 } })
      GltfContainer.create(e, { src })
      // Never removed — the reference keeps the GLB loaded for the session.
    }
  }, EMOTE_WARMUP_DELAY_MS)
}

// Call once from initClient so the watch system runs every frame
export function initEmoteManager() {
  engine.addSystem(emoteWatchSystem)
  engine.addSystem(carryPoseKeeper)
  warmUpEmotes()
}

// Fires the party emote on the local player at round end.
// No movement — player dances where they stand.
// Cancels immediately if the player moves (same emoteWatchSystem guard).
export function playPartyEmote() {
  if (emoteActive) stopPickupEmote()
  emoteActive = true
  triggerSceneEmote({ src: PARTY_EMOTE_SRC, loop: false })
  timers.setTimeout(() => stopPickupEmote(), PARTY_EMOTE_MS)
}

// Shared "step to item, face it, then fire a one-shot emote" helper.
// targetPos — world-space position of the item being interacted with.
// Player is stepped to INTERACT_DISTANCE away from it, facing it, then the emote at
// `src` fires after `triggerDelayMs` and is cleared after `durationMs`.
// triggerDelayMs lets the player finish stepping over to a DISTANT item before the
// animation plays (pickup). For the mopping emote the player is already standing on
// the patch, so it passes 0 to fire immediately — no perceived delay.
// Like the pickup emote it also auto-cancels the moment the player moves
// (handled by the shared emoteWatchSystem).
function playStepEmote(
  targetPos: { x: number; y: number; z: number },
  src:       string,
  durationMs: number,
  triggerDelayMs: number = EMOTE_TRIGGER_MS,
) {
  if (emoteActive) stopPickupEmote()

  // Step-to-item is DESKTOP ONLY. Two mobile problems killed it there:
  //  • avatarTarget re-aims the avatar, and the mobile third-person camera
  //    follows avatar facing — every clean wrenched the view around ("camera
  //    gets rotated when cleaning constantly");
  //  • the enlarged mobile tap targets make DISTANT grabs routine (including
  //    items poking through thin walls or on the other floor), and teleporting
  //    the avatar toward those spots can drop it inside geometry — the physics
  //    resolver then ejects it, reported as "often teleported outside the club".
  // Mobile simply plays the emote where the player stands.
  let stepped = false
  const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position
  if (playerPos && !isMobile()) {
    const dx  = playerPos.x - targetPos.x
    const dz  = playerPos.z - targetPos.z
    const len = Math.sqrt(dx * dx + dz * dz)

    // Only step to the item when the player is genuinely too far away to be
    // "at" it — otherwise leave them exactly where they put themselves.
    if (len > INTERACT_DISTANCE + REPOSITION_SLACK) {
      const nx = len > 0.001 ? dx / len : 0
      const nz = len > 0.001 ? dz / len : 1
      const newRelativePosition = {
        x: targetPos.x + nx * INTERACT_DISTANCE,
        y: playerPos.y,
        z: targetPos.z + nz * INTERACT_DISTANCE,
      }
      // avatarTarget turn-to-face is fine here: desktop mouse-look is decoupled
      // from avatar facing, so the camera stays under the player's control.
      movePlayerTo({ newRelativePosition, avatarTarget: targetPos })
      stepped = true
    }
  }

  emoteActive = true

  const fire = () => {
    if (!emoteActive) return
    triggerSceneEmote({ src, loop: false })
    timers.setTimeout(() => stopPickupEmote(), durationMs)
  }
  // The delay exists solely to let a movePlayerTo step land before the arms
  // move — when no step happened (mobile always; desktop already-in-range,
  // the common case), it was 200ms of pure lag. Fire instantly instead.
  const delay = stepped ? triggerDelayMs : 0
  if (delay <= 0) fire()
  else timers.setTimeout(fire, delay)
}

// Fires the pickup emote — quick-clean items (rubbish, bottles, glasses, clutter).
export function playPickupEmote(targetPos: { x: number; y: number; z: number }) {
  playStepEmote(targetPos, PICKUP_EMOTE_SRC, PICKUP_EMOTE_MS)
}

// Fires the mopping emote — hold-to-clean sticky patches. The player is already on
// the patch, so it fires immediately (triggerDelayMs = 0) for an instant response.
export function playMoppingEmote(targetPos: { x: number; y: number; z: number }, durationMs = MOPPING_EMOTE_MS) {
  playStepEmote(targetPos, MOPPING_EMOTE_SRC, durationMs, 0)
}
