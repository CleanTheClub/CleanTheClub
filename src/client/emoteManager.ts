import { triggerSceneEmote } from '~system/RestrictedActions'
import { PICKUP_EMOTE_MS } from '../shared/config'

const PICKUP_EMOTE_SRC = 'assets/scene/Emotes/PickUp_Anim_emote.glb'
let emoteTimer: ReturnType<typeof setTimeout> | null = null

export function playPickupEmote() {
  if (emoteTimer) { clearTimeout(emoteTimer); emoteTimer = null }
  triggerSceneEmote({ src: PICKUP_EMOTE_SRC, loop: false })
  emoteTimer = setTimeout(() => {
    triggerSceneEmote({ src: '', loop: false })
    emoteTimer = null
  }, PICKUP_EMOTE_MS)
}
