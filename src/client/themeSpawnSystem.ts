// Click wiring for themed-round extra spawns (theme_* slots).
//
// The SERVER owns these entities entirely — it creates them at boot, and each
// themed round places models at sampled anchors by writing Transform +
// GltfContainer, which replicate over CRDT along with ClutterSync. So this
// system never spawns or moves anything: it discovers the replicated slot
// entities and gives them the same click behaviour scene rubbish has
// (guards, sounds, emote, carry stream, local shrink for instant feedback).
//
// Visibility is server-driven (scale ~0 when parked or cleaned), which also
// covers late joiners for free. The local shrinkAndHide below is only the
// instant-response layer in front of the server's authoritative hide.

import { engine, Entity, Transform, GltfContainer, pointerEventsSystem, PointerEvents, InputAction } from '@dcl/sdk/ecs'
import { ClutterSync, GameState } from '../shared/schemas'
import { THEME_SLOT_PREFIX, DISASTER_PREFIX, DISASTER_BONUS, PICKUP_TOUCH_MS } from '../shared/config'
import { registerDisasterHold } from './InteractionManager'
import { purchaseBurst } from './confettiSystem'
import { classifyRubbish } from '../shared/glassDiscovery'
import { room } from '../shared/messages'
import { showCleanedToast, showNarrativeToast } from '../ui'
import { playHoverSound, playCleanSound, playMissSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { shrinkAndHide, cancelShrink } from './itemFx'
import { clicksAllowed, onPhaseChange, withinReach, POINTER_MAX_DIST, SYNC_POLL_S } from './phaseGate'
import { isCarryFull, shouldNudgeToBin, triggerBinNudge, noteCarriedModel, pulseCarryBox } from './carrySystem'
import { registerSpreeHit } from './spreeSystem'

const slotEntities  = new Map<string, Entity>()
const pendingCleans = new Set<string>()
const lastState     = new Map<string, boolean>()

// Disaster PILE bits share the quick-click flow with themed extras; the stain
// and polish stages are HOLDS, registered into InteractionManager instead.
const isQuickThemedId = (id: string): boolean =>
  id.startsWith(THEME_SLOT_PREFIX) || (id.startsWith(DISASTER_PREFIX) && id.includes('pile'))

// Finale detection — the polish stage flipping to cleaned means the whole
// disaster is done; every client celebrates (the polisher also gets the
// skill-check PERFECT flash and the wallet pop from their progressUpdate).
let polishWasCleaned: boolean | undefined
// Last GltfContainer src seen per slot — the server delivers each round's model
// slightly after the round starts (delete-then-recreate, see the roller), so
// click wiring re-registers when the model lands, keeping hover text truthful.
const lastSrc       = new Map<string, string>()

function getPhase(): string {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs.phase ?? 'playing'
  return 'playing'
}

// Toast throttles mirror rubbishSystem's (the miss blip plays every time).
const TOAST_COOLDOWN_MS = 3_000
let lastFullToastMs = 0
let lastTooFarToastMs = 0
let lastOpenToastMs = 0

function disableClick(itemId: string) {
  const entity = slotEntities.get(itemId)
  if (!entity) return
  pointerEventsSystem.removeOnPointerDown(entity)
  pointerEventsSystem.removeOnPointerHoverEnter(entity)
  PointerEvents.deleteFrom(entity)
}

function enableClick(itemId: string) {
  if (!clicksAllowed()) return
  const entity = slotEntities.get(itemId)
  if (!entity) return
  // No model yet (the server delete-recreates GltfContainers ~150ms into the
  // round) → no pointer events yet. PointerEvents on a collider-less entity
  // trips the explorer's "Missing MeshCollider" warning (playtest console);
  // the src watcher below wires the click the moment the model lands.
  const src = GltfContainer.getOrNull(entity)?.src
  if (!src) return
  const stream = classifyRubbish(src)
  pointerEventsSystem.onPointerHoverEnter({ entity }, () => playHoverSound())
  pointerEventsSystem.onPointerDown(
    {
      entity,
      opts: {
        button: InputAction.IA_POINTER,
        hoverText: stream === 'recycle' ? 'Clean (Recycling)' : 'Clean (General)',
        maxDistance: POINTER_MAX_DIST,
      },
    },
    () => {
      const now = Date.now()
      if (getPhase() === 'open') {
        if (now - lastOpenToastMs > TOAST_COOLDOWN_MS) {
          lastOpenToastMs = now
          showNarrativeToast('Wait for the next round!')
        }
        return
      }
      if (isCarryFull()) {
        playMissSound()
        pulseCarryBox()
        if (now - lastFullToastMs > TOAST_COOLDOWN_MS) {
          lastFullToastMs = now
          showNarrativeToast('Hands full! Empty them at a bin')
        }
        return
      }
      if (pendingCleans.has(itemId)) return
      const pos = Transform.getOrNull(entity)?.position
      if (!withinReach(pos)) {
        playMissSound()
        if (now - lastTooFarToastMs > TOAST_COOLDOWN_MS) {
          lastTooFarToastMs = now
          showNarrativeToast('Too far away — get closer!')
        }
        return
      }
      pendingCleans.add(itemId)
      noteCarriedModel(GltfContainer.getOrNull(entity)?.src)
      registerSpreeHit()
      if (shouldNudgeToBin()) {
        triggerBinNudge()
        showNarrativeToast('Hands fill up — empty them at a bin!')
      }
      disableClick(itemId)
      playCleanSound()
      if (pos) playPickupEmote(pos)
      room.send('cleanItem', { itemId })
      showCleanedToast()
      // Instant local feedback; the server's authoritative scale collapse lands
      // right behind it. Sparkle on completion, like scene rubbish.
      shrinkAndHide(entity, PICKUP_TOUCH_MS / 1000, () => {
        if (pos) playSparkle(pos)
      })
    },
  )
}

export function initThemeSpawnSystem() {
  // ── Authoritative state watcher — discovers replicated slots + follows their
  // cleaned state. Same poll cadence as the other item systems. ────────────────
  let syncAcc = 0
  engine.addSystem((dt: number) => {
    syncAcc += dt
    if (syncAcc < SYNC_POLL_S) return
    syncAcc = 0
    for (const [entity] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(entity)

      // Disaster hold stages: hand to the InteractionManager (idempotent) and
      // watch the polish for the all-clients finale celebration. Registration
      // waits for the GltfContainer — pointer events before the model exists
      // trip the explorer's "Missing MeshCollider" warning; the next poll
      // (SYNC_POLL_S) picks it up once the model lands.
      if (state.itemId.startsWith(DISASTER_PREFIX) && !state.itemId.includes('pile')) {
        if (GltfContainer.getOrNull(entity)?.src) registerDisasterHold(state.itemId, entity)
        if (state.itemId.endsWith('_polish')) {
          if (polishWasCleaned === false && state.isCleaned) {
            showNarrativeToast(`DISASTER CLEARED! +$${DISASTER_BONUS} on the payout!`)
            purchaseBurst()
            const pos = Transform.getOrNull(entity)?.position
            if (pos) playSparkle(pos)
          }
          polishWasCleaned = state.isCleaned
        }
        continue
      }

      if (!isQuickThemedId(state.itemId)) continue
      slotEntities.set(state.itemId, entity)

      // Model swap (new round's GltfContainer landed) — re-wire a live slot so
      // its hover text matches the model now standing there.
      const src = GltfContainer.getOrNull(entity)?.src ?? ''
      if (src !== lastSrc.get(state.itemId)) {
        lastSrc.set(state.itemId, src)
        if (state.isCleaned === false && !pendingCleans.has(state.itemId)) {
          disableClick(state.itemId)
          enableClick(state.itemId)
        }
      }

      if (lastState.get(state.itemId) === state.isCleaned) continue
      lastState.set(state.itemId, state.isCleaned)
      pendingCleans.delete(state.itemId)

      if (state.isCleaned) {
        disableClick(state.itemId)
      } else {
        // A slot waking for a new round: the server has already placed and
        // scaled it; clear any leftover local shrink before wiring the click.
        cancelShrink(entity)
        enableClick(state.itemId)
      }
    }
  })

  // ── Phase gate — pointer events only live while players can clean ────────────
  onPhaseChange((phase) => {
    if (phase === 'playing') {
      let live = 0
      for (const [itemId] of slotEntities) {
        if (pendingCleans.has(itemId)) continue
        if (lastState.get(itemId) === true) continue
        // Re-register from scratch: a slot that stayed live across rounds gets
        // no isCleaned change event, but its MODEL may have changed — this
        // re-reads the src so the hover text can't describe last round's item.
        disableClick(itemId)
        enableClick(itemId)
        live++
      }
      // Theme included so SceneLog alone can tell a classic round (0 live is
      // CORRECT) from a themed round with broken spawns (0 live is a bug) —
      // the server-side roll/tally lines never reach the in-game log. Slot
      // count distinguishes "slots dormant" from "slots never replicated".
      // Live count reads the COMPONENT, not lastState: the watcher poll may not
      // have run yet at the phase flip, which logged a themed round as "0
      // extras" while bottles were visibly spawning (playtest).
      let theme = ''
      for (const [, gs] of engine.getEntitiesWith(GameState)) { theme = gs.theme; break }
      let liveNow = 0
      for (const [, entity] of slotEntities) {
        if (ClutterSync.getOrNull(entity)?.isCleaned === false) liveNow++
      }
      console.log(`[THEME] round start (theme '${theme || 'classic'}') — ${liveNow} extras live (${live} wired now), ${slotEntities.size} slots known`)
    } else {
      for (const [itemId] of slotEntities) disableClick(itemId)
    }
  })

  room.onMessage('cleanRejected', (data) => {
    if (!isQuickThemedId(data.itemId)) return   // disaster HOLDS are InteractionManager's
    pendingCleans.delete(data.itemId)
    const entity = slotEntities.get(data.itemId)
    if (entity) {
      cancelShrink(entity)
      // Live slots stand at unit scale; the server never shrank it (rejected).
      const tf = Transform.getMutableOrNull(entity)
      if (tf) tf.scale = { x: 1, y: 1, z: 1 }
    }
    lastState.delete(data.itemId)
  })

  console.log('[THEME] spawn system ready')
}
