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

import { engine, Entity, Transform, GltfContainer, GltfContainerLoadingState, LoadingState, pointerEventsSystem, PointerEvents, InputAction, TextShape, Billboard, BillboardMode, VisibilityComponent } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { ClutterSync } from '../shared/schemas'
import { THEME_SLOT_PREFIX, DISASTER_PREFIX, DISASTER_BONUS, PICKUP_TOUCH_MS, POP_NAME_PART } from '../shared/config'
import { registerDisasterHold, unregisterDynamicHold, startPopRhythm } from './InteractionManager'
import { purchaseBurst } from './confettiSystem'
import { classifyRubbish } from '../shared/glassDiscovery'
import { room } from '../shared/messages'
import { showCleanedToast, showNarrativeToast } from '../ui'
import { playHoverSound, playCleanSound, playMissSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { shrinkAndHide, cancelShrink } from './itemFx'
import { clicksAllowed, onPhaseChange, withinReach, POINTER_MAX_DIST, currentPhase, gameState } from './phaseGate'
import { onClutterPoll, ClutterEntry } from './clutterWatcher'
import { isCarryFull, shouldNudgeToBin, triggerBinNudge, noteCarriedModel, pulseCarryBox } from './carrySystem'
import { registerSpreeHit } from './spreeSystem'

const slotEntities  = new Map<string, Entity>()
const pendingCleans = new Set<string>()
const lastState     = new Map<string, boolean>()
// Slots with live pointer wiring. Wiring requires the GLB to be LOADED — the
// explorer logs a "Missing MeshCollider" warning for PointerEvents on an
// entity with no collider yet (playtest console) — so the watcher retries
// unwired live slots each poll until enableClick's load gate passes.
const wiredSlots    = new Set<string>()
// Visibility we last WROTE per slot. Tracked separately from lastState because
// the cleaned-state change guard below skips unchanged slots — and a slot whose
// state doesn't change across a round boundary then keeps whatever visibility it
// had. A disaster stage left live at round end stayed visible and clickable
// while the server parked it at ~0 scale: "tiny bin bags are visible and
// interactable where a disaster zone was last round" (playtest).
const slotVisible   = new Map<string, boolean>()

function slotModelLoaded(entity: Entity): boolean {
  return GltfContainerLoadingState.getOrNull(entity)?.currentState === LoadingState.FINISHED
}

// Disaster PILE bits share the quick-click flow with themed extras; the stain
// and polish stages are HOLDS, registered into InteractionManager instead.
const isQuickThemedId = (id: string): boolean =>
  id.startsWith(THEME_SLOT_PREFIX) || (id.startsWith(DISASTER_PREFIX) && id.includes('pile'))

// Finale detection — the polish stage flipping to cleaned means the whole
// disaster is done; every client celebrates (the polisher also gets the
// skill-check PERFECT flash and the wallet pop from their progressUpdate).
let polishWasCleaned: boolean | undefined

// Slots whose CURRENT model is a sticky patch (spring cleaning) — those are
// HOLDS owned by the InteractionManager, not quick clicks. Membership follows
// the model, so a slot switches modes cleanly between rounds.
const holdSlots = new Set<string>()

// ── Disaster beacon ───────────────────────────────────────────────────────────
// Playtest: "wasn't clear where the disaster zone was" — the pile read as three
// more bags. A floating billboard label marks the spot while ANY stage remains,
// and a toast announces it the moment it appears.
let disasterMarker: Entity | null = null
let disasterWasLive = false

function updateDisasterMarker(live: boolean, at: { x: number; y: number; z: number } | null) {
  // Announce on the rising edge regardless of distance — the toast is the
  // "it exists" beat; the floating text is only the wayfinder.
  if (live && !disasterWasLive) {
    showNarrativeToast('DISASTER ZONE spotted — big mess, big pay. Clear it!')
  }
  disasterWasLive = live

  // The beacon earns its keep AT A DISTANCE (wayfinding); within ~7m the pile
  // itself is visible and floating text is noise ("adding vs distracting").
  let show = live && at !== null
  if (show && at) {
    const p = Transform.getOrNull(engine.PlayerEntity)?.position
    if (p) {
      const dx = p.x - at.x
      const dz = p.z - at.z
      if (dx * dx + dz * dz < 49) show = false
    }
  }

  if (show && at) {
    if (disasterMarker === null) {
      disasterMarker = engine.addEntity()
      TextShape.create(disasterMarker, {
        text: 'DISASTER ZONE',
        // 2.5, was 4 — the big version clipped into walls (playtest).
        fontSize: 2.5,
        textColor: Color4.create(1, 0.82, 0.25, 1),
        outlineColor: Color4.Black(),
        outlineWidth: 0.15,
      })
      Billboard.create(disasterMarker, { billboardMode: BillboardMode.BM_Y })
    }
    const tf = Transform.getOrNull(disasterMarker)
    const pos = { x: at.x, y: at.y + 2.3, z: at.z }
    if (!tf) Transform.create(disasterMarker, { position: pos })
    else Transform.getMutable(disasterMarker).position = pos
  } else if (disasterMarker !== null) {
    engine.removeEntity(disasterMarker)
    disasterMarker = null
  }
}
// Last GltfContainer src seen per slot — the server delivers each round's model
// slightly after the round starts (delete-then-recreate, see the roller), so
// click wiring re-registers when the model lands, keeping hover text truthful.
const lastSrc       = new Map<string, string>()

// Toast throttles mirror rubbishSystem's (the miss blip plays every time).
const TOAST_COOLDOWN_MS = 3_000
let lastFullToastMs = 0
let lastTooFarToastMs = 0
let lastOpenToastMs = 0

function disableClick(itemId: string) {
  wiredSlots.delete(itemId)
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
  // Model not fully LOADED yet (the server delete-recreates GltfContainers
  // ~150ms into the round, then the mesh streams) → no pointer events yet:
  // PointerEvents without a collider trips the explorer's "Missing
  // MeshCollider" warning. The watcher retries each poll until this passes.
  const src = GltfContainer.getOrNull(entity)?.src
  if (!src || !slotModelLoaded(entity)) return
  wiredSlots.add(itemId)
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
      if (currentPhase() === 'open') {
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
      const srcNow = (GltfContainer.getOrNull(entity)?.src ?? '').toLowerCase()
      // Popcorn detours through Rhythm Pop — identical rule to scene popcorn.
      if (srcNow.includes(POP_NAME_PART)) {
        startPopRhythm(itemId, (hits) => {
          if (hits === 0) return   // blank run — popcorn stays, click to retry
          if (pendingCleans.has(itemId) || lastState.get(itemId) === true) return
          if (currentPhase() === 'open' || isCarryFull()) return
          performClean()
        })
        return
      }
      performClean()

      function performClean() {
      if (!entity) return   // narrowing doesn't cross the function boundary
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
      }
    },
  )
}

export function initThemeSpawnSystem() {
  // ── Authoritative state watcher — discovers replicated slots + follows their
  // cleaned state. Rides the shared ClutterSync poll (same cadence as before). ──
  onClutterPoll((entries: readonly ClutterEntry[]) => {
    let disasterLive = false
    let disasterAt: { x: number; y: number; z: number } | null = null
    for (const { entity, itemId, isCleaned } of entries) {
      // Any uncleaned disaster stage keeps the beacon up over the spot.
      if (itemId.startsWith(DISASTER_PREFIX) && !isCleaned) {
        disasterLive = true
        if (disasterAt === null) disasterAt = Transform.getOrNull(entity)?.position ?? null
      }

      // Disaster hold stages: hand to the InteractionManager (idempotent) and
      // watch the polish for the all-clients finale celebration. Registration
      // waits for the GltfContainer — pointer events before the model exists
      // trip the explorer's "Missing MeshCollider" warning; the next poll
      // picks it up once the model lands.
      if (itemId.startsWith(DISASTER_PREFIX) && !itemId.includes('pile')) {
        if (GltfContainer.getOrNull(entity)?.src && slotModelLoaded(entity)) registerDisasterHold(itemId, entity)
        if (itemId.endsWith('_polish')) {
          if (polishWasCleaned === false && isCleaned) {
            showNarrativeToast(`DISASTER CLEARED! +$${DISASTER_BONUS} on the payout!`)
            purchaseBurst()
            const pos = Transform.getOrNull(entity)?.position
            if (pos) playSparkle(pos)
          }
          polishWasCleaned = isCleaned
        }
        continue
      }

      if (!isQuickThemedId(itemId)) continue
      slotEntities.set(itemId, entity)

      // Model swap (new round's GltfContainer landed/changed): drop all stale
      // wiring — the idempotent per-poll blocks below re-wire once the new
      // model is LOADED. Sticky-patch models (spring cleaning) belong to the
      // HOLD pipeline; anything else is a quick click.
      const src = GltfContainer.getOrNull(entity)?.src ?? ''
      if (src !== lastSrc.get(itemId)) {
        lastSrc.set(itemId, src)
        disableClick(itemId)
        if (holdSlots.has(itemId)) {
          holdSlots.delete(itemId)
          unregisterDynamicHold(itemId)
        }
      }
      if (src.toLowerCase().includes('sticky')) {
        if (!holdSlots.has(itemId) && slotModelLoaded(entity)) {
          holdSlots.add(itemId)
          registerDisasterHold(itemId, entity)   // hold pipeline owns it
        }
        continue
      }
      // Live but unwired (fresh spawn, model still streaming, or a re-wire
      // after a swap) — retry; enableClick self-gates on the load state.
      if (isCleaned === false && !pendingCleans.has(itemId) && !wiredSlots.has(itemId)) {
        enableClick(itemId)
      }

      // Reconcile visibility EVERY poll (write only on an actual change), so a
      // parked slot can never be left showing regardless of state history.
      const wantVisible = !isCleaned
      if (slotVisible.get(itemId) !== wantVisible) {
        slotVisible.set(itemId, wantVisible)
        VisibilityComponent.createOrReplace(entity, { visible: wantVisible })
        if (!wantVisible) disableClick(itemId)   // parked means untappable too
      }

      if (lastState.get(itemId) === isCleaned) continue
      lastState.set(itemId, isCleaned)
      pendingCleans.delete(itemId)

      // Parked/cleaned slots stop RENDERING, not just shrink: 30 spawn slots
      // plus 5 disaster stages sit dormant through every classic round.
      if (isCleaned) {
        disableClick(itemId)
      } else {
        // A slot waking for a new round: the server has already placed and
        // scaled it; clear any leftover local shrink before wiring the click.
        cancelShrink(entity)
        enableClick(itemId)
      }
    }
    // Beacon only during active play — an unfinished disaster used to keep it
    // floating through the whole intermission.
    updateDisasterMarker(disasterLive && currentPhase() === 'playing', disasterAt)
  })

  // ── Phase gate — pointer events only live while players can clean ────────────
  onPhaseChange((phase) => {
    if (phase === 'playing') {
      let live = 0
      for (const [itemId] of slotEntities) {
        if (holdSlots.has(itemId)) continue   // the InteractionManager's phase gate covers holds
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
      const theme = gameState()?.theme ?? ''
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
