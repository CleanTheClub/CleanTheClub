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

import { engine, Entity, Transform, GltfContainer, GltfContainerLoadingState, LoadingState, pointerEventsSystem, PointerEvents, InputAction, TextShape, Billboard, BillboardMode } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { ClutterSync, GameState } from '../shared/schemas'
import { THEME_SLOT_PREFIX, DISASTER_PREFIX, DISASTER_BONUS, PICKUP_TOUCH_MS, TAP_TAP_MODELS, POP_NAME_PART } from '../shared/config'
import { registerDisasterHold, unregisterDynamicHold, startPopRhythm } from './InteractionManager'
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
// Slots with live pointer wiring. Wiring requires the GLB to be LOADED — the
// explorer logs a "Missing MeshCollider" warning for PointerEvents on an
// entity with no collider yet (playtest console) — so the watcher retries
// unwired live slots each poll until enableClick's load gate passes.
const wiredSlots    = new Set<string>()

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

// Multi-tap progress per item (tap-tap popcorn). Cleared on phase change and
// when an item resolves either way.
const tapCounts = new Map<string, number>()

// ── Disaster beacon ───────────────────────────────────────────────────────────
// Playtest: "wasn't clear where the disaster zone was" — the pile read as three
// more bags. A floating billboard label marks the spot while ANY stage remains,
// and a toast announces it the moment it appears.
let disasterMarker: Entity | null = null
let disasterWasLive = false

function updateDisasterMarker(live: boolean, at: { x: number; y: number; z: number } | null) {
  if (live && at) {
    if (disasterMarker === null) {
      disasterMarker = engine.addEntity()
      TextShape.create(disasterMarker, {
        text: 'DISASTER ZONE',
        fontSize: 4,
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
    if (!disasterWasLive) {
      showNarrativeToast('DISASTER ZONE spotted — big mess, big pay. Clear it!')
    }
  } else if (disasterMarker !== null) {
    engine.removeEntity(disasterMarker)
    disasterMarker = null
  }
  disasterWasLive = live
}
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
      const srcNow = (GltfContainer.getOrNull(entity)?.src ?? '').toLowerCase()
      // Popcorn detours through Rhythm Pop — identical rule to scene popcorn.
      if (srcNow.includes(POP_NAME_PART)) {
        startPopRhythm(itemId, () => {
          if (pendingCleans.has(itemId) || lastState.get(itemId) === true) return
          if (getPhase() === 'open' || isCarryFull()) return
          performClean()
        })
        return
      }
      // Tap-tap models: the first taps are pops, the LAST tap cleans.
      const tapEntry = Object.entries(TAP_TAP_MODELS).find(([frag]) => srcNow.includes(frag))
      if (tapEntry && tapEntry[1] > 1) {
        const taps = (tapCounts.get(itemId) ?? 0) + 1
        if (taps < tapEntry[1]) {
          tapCounts.set(itemId, taps)
          playCleanSound()   // pop! (random-pitched, so tap-tap-tap sings)
          return
        }
        tapCounts.delete(itemId)
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
  // cleaned state. Same poll cadence as the other item systems. ────────────────
  let syncAcc = 0
  engine.addSystem((dt: number) => {
    syncAcc += dt
    if (syncAcc < SYNC_POLL_S) return
    syncAcc = 0
    let disasterLive = false
    let disasterAt: { x: number; y: number; z: number } | null = null
    for (const [entity] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(entity)

      // Any uncleaned disaster stage keeps the beacon up over the spot.
      if (state.itemId.startsWith(DISASTER_PREFIX) && !state.isCleaned) {
        disasterLive = true
        if (disasterAt === null) disasterAt = Transform.getOrNull(entity)?.position ?? null
      }

      // Disaster hold stages: hand to the InteractionManager (idempotent) and
      // watch the polish for the all-clients finale celebration. Registration
      // waits for the GltfContainer — pointer events before the model exists
      // trip the explorer's "Missing MeshCollider" warning; the next poll
      // (SYNC_POLL_S) picks it up once the model lands.
      if (state.itemId.startsWith(DISASTER_PREFIX) && !state.itemId.includes('pile')) {
        if (GltfContainer.getOrNull(entity)?.src && slotModelLoaded(entity)) registerDisasterHold(state.itemId, entity)
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

      // Model swap (new round's GltfContainer landed/changed): drop all stale
      // wiring — the idempotent per-poll blocks below re-wire once the new
      // model is LOADED. Sticky-patch models (spring cleaning) belong to the
      // HOLD pipeline; anything else is a quick click.
      const src = GltfContainer.getOrNull(entity)?.src ?? ''
      if (src !== lastSrc.get(state.itemId)) {
        lastSrc.set(state.itemId, src)
        tapCounts.delete(state.itemId)
        disableClick(state.itemId)
        if (holdSlots.has(state.itemId)) {
          holdSlots.delete(state.itemId)
          unregisterDynamicHold(state.itemId)
        }
      }
      if (src.toLowerCase().includes('sticky')) {
        if (!holdSlots.has(state.itemId) && slotModelLoaded(entity)) {
          holdSlots.add(state.itemId)
          registerDisasterHold(state.itemId, entity)   // hold pipeline owns it
        }
        continue
      }
      // Live but unwired (fresh spawn, model still streaming, or a re-wire
      // after a swap) — retry; enableClick self-gates on the load state.
      if (state.isCleaned === false && !pendingCleans.has(state.itemId) && !wiredSlots.has(state.itemId)) {
        enableClick(state.itemId)
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
    updateDisasterMarker(disasterLive, disasterAt)
  })

  // ── Phase gate — pointer events only live while players can clean ────────────
  onPhaseChange((phase) => {
    tapCounts.clear()
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
