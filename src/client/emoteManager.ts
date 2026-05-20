import { engine, Transform, timers, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { movePlayerTo, triggerSceneEmote } from '~system/RestrictedActions'
import { PICKUP_EMOTE_MS } from '../shared/config'

const PICKUP_EMOTE_SRC  = 'assets/scene/Emotes/PickUp_Anim_emote.glb'
const PARTY_EMOTE_SRC   = 'assets/scene/Emotes/PartyPhone_emote.glb'
const PARTY_EMOTE_MS    = 9_700  // match clip duration exactly
const INTERACT_DISTANCE = 1.5   // metres — how close player steps to the item
const EMOTE_TRIGGER_MS  = 200   // ms — delay after movePlayerTo before emote fires

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
  triggerSceneEmote({ src: '', loop: false })
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

// Call once from initClient so the watch system runs every frame
export function initEmoteManager() {
  engine.addSystem(emoteWatchSystem)
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

// targetPos — world-space position of the item being collected.
// Player is stepped to INTERACT_DISTANCE away from it, facing it,
// then the emote fires after EMOTE_TRIGGER_MS.
export function playPickupEmote(targetPos: { x: number; y: number; z: number }) {
  if (emoteActive) stopPickupEmote()

  const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position
  if (playerPos) {
    const dx  = playerPos.x - targetPos.x
    const dz  = playerPos.z - targetPos.z
    const len = Math.sqrt(dx * dx + dz * dz)
    const nx  = len > 0.001 ? dx / len : 0
    const nz  = len > 0.001 ? dz / len : 1
    movePlayerTo({
      newRelativePosition: {
        x: targetPos.x + nx * INTERACT_DISTANCE,
        y: playerPos.y,
        z: targetPos.z + nz * INTERACT_DISTANCE,
      },
      avatarTarget: targetPos,
    })
  }

  emoteActive = true

  timers.setTimeout(() => {
    if (!emoteActive) return
    triggerSceneEmote({ src: PICKUP_EMOTE_SRC, loop: false })
    timers.setTimeout(() => {
      stopPickupEmote()
    }, PICKUP_EMOTE_MS)
  }, EMOTE_TRIGGER_MS)
}
