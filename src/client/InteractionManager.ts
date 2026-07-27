import { engine, Entity, Transform, pointerEventsSystem, PointerEvents, InputAction, inputSystem, timers } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, PICKUP_TOUCH_MS, InteractionType } from '../shared/config'
import { holdDurationMs } from './upgradeEffects'
import { GLASS_ID_PREFIX } from '../shared/glassDiscovery'
import { showCleanedToast, showNarrativeToast } from '../ui'
import { playHoverSound, playClickSound, playStickySound, stopStickySound, playCleanSound } from './soundManager'
import { playPickupEmote, playMoppingEmote, cancelEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { clicksAllowed, onPhaseChange, SYNC_POLL_S } from './phaseGate'

const pendingCleans     = new Set<string>()
const pendingVisualHide = new Set<string>()  // items awaiting delayed hide at touch moment
const lastState         = new Map<string, boolean>()

// Stored after sync so enable/disable can re-register handlers at any time
type ItemRef = { entity: Entity; type: InteractionType }
const itemRefs = new Map<string, ItemRef>()

type ActiveHold = { id: string; startMs: number }
let activeHold: ActiveHold | null = null

// ─── Open-phase gate ──────────────────────────────────────────────────────────
const OPEN_PHASE_TOAST_COOLDOWN_MS = 3_000
let lastOpenPhaseToastMs = 0

function getPhase(): string {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs.phase ?? 'playing'
  return 'playing'
}

function maybeShowOpenPhaseToast() {
  const now = Date.now()
  if (now - lastOpenPhaseToastMs < OPEN_PHASE_TOAST_COOLDOWN_MS) return
  lastOpenPhaseToastMs = now
  showNarrativeToast('Wait for the next round!')
}

function findClutterEntity(itemId: string): Entity | undefined {
  for (const [entity] of engine.getEntitiesWith(ClutterSync)) {
    if (ClutterSync.get(entity).itemId === itemId) return entity
  }
  return undefined
}

function tryClean(
  id: string,
  applyCleanState: (id: string, isCleaned: boolean) => void,
) {
  if (pendingCleans.has(id)) return
  const syncEnt = findClutterEntity(id)
  if (syncEnt && ClutterSync.get(syncEnt).isCleaned) return
  pendingCleans.add(id)
  disableClick(id)            // remove prompt immediately while pending
  applyCleanState(id, true)   // optimistic swap
  room.send('cleanItem', { itemId: id })
  showCleanedToast()
}

// ─── Enable / disable pointer interactions per item ───────────────────────────

function enableClick(id: string) {
  if (!clicksAllowed()) return  // pointer events only live during the 'playing' phase
  const ref = itemRefs.get(id)
  if (!ref) return
  const { entity, type } = ref

  pointerEventsSystem.onPointerHoverEnter({ entity }, () => playHoverSound())

  if (type === 'hold') {
    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Hold to Clean' } },
      () => {
        if (pendingCleans.has(id) || activeHold) return
        const syncEnt = findClutterEntity(id)
        if (syncEnt && ClutterSync.get(syncEnt).isCleaned) return
        if (getPhase() === 'open') { maybeShowOpenPhaseToast(); return }
        playStickySound()
        activeHold = { id, startMs: Date.now() }
        showHoldBarRef(id, true)
        updateHoldBarRef(id, 0)

        // Mopping emote — same step-to-item + emote logic as the pickup animation,
        // fired while the player holds to clean the sticky patch.
        const pos = Transform.getOrNull(entity)?.position
        // Emote runs for exactly the (possibly upgraded) hold duration so it stops
        // as the bar completes rather than looping past it.
        if (pos) playMoppingEmote(pos, holdDurationMs())
      }
    )
    // NOTE: no onPointerUp here on purpose. It gave the patch an extra pointer-event
    // entry that the quick items (bottles/rubbish) don't have, diverging the setup
    // and suppressing the hover outline + adding a stray "Interact" prompt. Release
    // is detected by the hold-progress system's inputSystem.isPressed poll instead,
    // so the pointer events now match the other mess items exactly (hover + down).
  } else {
    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean' } },
      () => {
        if (pendingCleans.has(id)) return
        const syncEnt = findClutterEntity(id)
        if (syncEnt && ClutterSync.get(syncEnt).isCleaned) return
        if (getPhase() === 'open') { maybeShowOpenPhaseToast(); return }

        playClickSound()
        playCleanSound()               // instant audio feedback on click
        pendingCleans.add(id)
        disableClick(id)
        showCleanedToast()

        const pos = Transform.getOrNull(entity)?.position
        if (pos) playPickupEmote(pos)

        // Delay visual hide + sparkle to sync with the emote hand-touch moment.
        // Guard: if cleanRejected arrives before the timer fires it clears
        // pendingVisualHide — the timer then bails out without hiding the item.
        pendingVisualHide.add(id)
        room.send('cleanItem', { itemId: id })

        timers.setTimeout(() => {
          // Always delete the pending-hide guard first so the ClutterSync watcher
          // can take over if it hasn't already (e.g. after re-entry clear).
          const wasPending = pendingVisualHide.has(id)
          pendingVisualHide.delete(id)
          // Hide + sparkle if:
          //   (a) normal path — still in the pending set (cleanRejected didn't fire), OR
          //   (b) onEnterSceneObservable wiped pendingVisualHide but the ClutterSync
          //       watcher already confirmed clean (lastState=true).
          // In case (b) applyCleanState is a no-op, but sparkle plays at the right moment.
          if (!wasPending && lastState.get(id) !== true) return
          applyCleanStateRef(id, true)
          if (pos) playSparkle(pos)
        }, PICKUP_TOUCH_MS)
      }
    )
  }
}

function disableClick(id: string) {
  const ref = itemRefs.get(id)
  if (!ref) return
  pointerEventsSystem.removeOnPointerDown(ref.entity)
  pointerEventsSystem.removeOnPointerHoverEnter(ref.entity)
  PointerEvents.deleteFrom(ref.entity)
}

// ─── Scene GLB entity swap ────────────────────────────────────────────────────
// Called by the deferred GLB setup system in cleaningSystem once the GltfContainer
// entity is ready and its collision mask has been set to CL_POINTER.
// Moves any already-registered pointer events from the placeholder entity to the
// real mesh entity, then re-enables click if the item is not already cleaned.
export function updateSceneHoldGltf(itemId: string, gltfEntity: Entity) {
  const ref = itemRefs.get(itemId)
  if (!ref || ref.entity === gltfEntity) return
  const old = ref.entity
  pointerEventsSystem.removeOnPointerDown(old)
  pointerEventsSystem.removeOnPointerHoverEnter(old)
  PointerEvents.deleteFrom(old)
  ref.entity = gltfEntity
  if (!pendingCleans.has(itemId)) {
    const syncEnt = findClutterEntity(itemId)
    if (!syncEnt || !ClutterSync.get(syncEnt).isCleaned) enableClick(itemId)
  }
}

// ─── Refs captured at init so enable/disable closures can call them ──────────
// (avoids threading callbacks through every helper)

let applyCleanStateRef: (id: string, isCleaned: boolean) => void = () => {}
let showHoldBarRef:     (id: string, visible: boolean) => void   = () => {}
let updateHoldBarRef:   (id: string, progress: number) => void   = () => {}
// Optional staggered spawn-in: when set, an uncleaned item is popped in by the
// spawn director (clicks enabled on pop-complete) instead of snapping visible.
let spawnInRef:         ((id: string, onPopped: () => void) => void) | null = null

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initInteractionManager(
  dirtyEntities:     Map<string, Entity>,
  applyCleanState:   (id: string, isCleaned: boolean) => void,
  showHoldBar:       (id: string, visible: boolean) => void,
  updateHoldBar:     (id: string, progress: number) => void,
  sceneHoldEntities?: Map<string, Entity>,
  spawnIn?: (id: string, onPopped: () => void) => void,
) {
  applyCleanStateRef = applyCleanState
  showHoldBarRef     = showHoldBar
  updateHoldBarRef   = updateHoldBar
  spawnInRef         = spawnIn ?? null

  // On scene (re-)entry clear all stale client state so the ClutterSync watcher
  // treats every item as freshly unseen and correctly re-enables uncleaned ones.
  onEnterSceneObservable.add(() => {
    if (activeHold) {
      showHoldBar(activeHold.id, false)
      stopStickySound()
      activeHold = null
    }
    pendingCleans.clear()
    pendingVisualHide.clear()
    lastState.clear()
  })

  // Populate item refs immediately — enable/disable can be called as soon as sync fires
  for (const def of CLUTTER_DEFS) {
    if (def.sceneGlb) continue   // click + visuals owned by a scene-discovery system
    itemRefs.set(def.id, { entity: dirtyEntities.get(def.id)!, type: def.type ?? 'quick' })
  }
  // Scene-discovered hold entities (e.g. StickyPatches from GLB) — type is always 'hold'
  if (sceneHoldEntities) {
    for (const [itemId, entity] of sceneHoldEntities) {
      itemRefs.set(itemId, { entity, type: 'hold' })
    }
  }

  // Frame system: drives hold progress + fires on completion
  engine.addSystem(() => {
    if (!activeHold) return
    const heldMs = Date.now() - activeHold.startMs

    // Robust release detection — poll whether the pointer is ACTUALLY still held.
    // onPointerUp only fires when the button is released over the entity, which can
    // be missed when the click's step-to-item move slides the cursor off the patch
    // (notably the first, distant patch). Without this, a single click would let
    // the hold auto-complete after the full hold duration. The 60 ms grace avoids a
    // press-edge race on the very first frame of the hold.
    if (heldMs > 60 && !inputSystem.isPressed(InputAction.IA_POINTER)) {
      const { id } = activeHold
      activeHold = null
      cancelEmote()
      stopStickySound()
      showHoldBar(id, false)
      updateHoldBar(id, 0)
      return
    }

    // Read live, not captured at hold-start: the Mopping Speed upgrade shortens
    // this, and the bar, the completion check and the emote must all agree.
    const progress = heldMs / holdDurationMs()
    updateHoldBar(activeHold.id, Math.min(1, progress))

    if (progress >= 1) {
      const { id } = activeHold
      activeHold = null
      showHoldBar(id, false)
      playCleanSound()
      const holdPos = Transform.getOrNull(itemRefs.get(id)!.entity)?.position
      if (holdPos) playSparkle(holdPos)
      tryClean(id, applyCleanState)
    }
  })

  // Enable clicks once server state is synced, then remove this one-shot system.
  const enableOnSync = () => {
    if (!isStateSyncronized()) return
    for (const def of CLUTTER_DEFS) {
      if (def.sceneGlb) continue
      enableClick(def.id)
    }
    // Scene-hold items (sticky patches) are NOT eagerly enabled here — the
    // ClutterSync watcher's appear branch routes them through the spawn director,
    // which enables clicks only once the patch has popped in (fully loaded).
    engine.removeSystem(enableOnSync)
  }
  engine.addSystem(enableOnSync)

  // Watch ClutterSync → apply authoritative state + manage click availability
  // (polled at SYNC_POLL_S, not every frame).
  let syncAcc = 0
  engine.addSystem((dt: number) => {
    syncAcc += dt
    if (syncAcc < SYNC_POLL_S) return
    syncAcc = 0
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      if (lastState.get(state.itemId) === state.isCleaned) continue
      lastState.set(state.itemId, state.isCleaned)

      pendingCleans.delete(state.itemId)

      if (state.isCleaned) {
        if (activeHold?.id === state.itemId) {
          showHoldBar(state.itemId, false)
          activeHold = null
        }
        disableClick(state.itemId)
        // If a pickup timer is pending, let it apply the visual at the touch moment.
        // For hold items the timer is never set, so this branch is a no-op for them.
        if (!pendingVisualHide.has(state.itemId)) {
          applyCleanState(state.itemId, true)
        }
      } else {
        // Round reset / first appearance — cancel any pending visual hide, then
        // stagger the pop-in: spawnInRef pops the patch in once its GLB + collider
        // are ready and enables clicks at that point (fixes round-1 click races and
        // adds a satisfying pop).  Falls back to instant restore if no director.
        pendingVisualHide.delete(state.itemId)
        if (spawnInRef) {
          spawnInRef(state.itemId, () => enableClick(state.itemId))
        } else {
          enableClick(state.itemId)
          applyCleanState(state.itemId, false)
        }
      }
    }
  })

  // ── Phase gate — sticky-patch pointer events only live during 'playing' ───────
  onPhaseChange((phase) => {
    if (phase === 'playing') {
      for (const [id] of itemRefs) {
        if (pendingCleans.has(id)) continue
        const syncEnt = findClutterEntity(id)
        if (syncEnt && ClutterSync.get(syncEnt).isCleaned) continue
        enableClick(id)
      }
    } else {
      // Leaving 'playing' (intermission/finale) — kill any in-progress hold so it
      // can't complete while cleaning is disabled, then turn off all pointer events.
      if (activeHold) {
        showHoldBarRef(activeHold.id, false)
        stopStickySound()
        activeHold = null
      }
      for (const [id] of itemRefs) disableClick(id)
    }
  })

  room.onMessage('cleanRejected', (data) => {
    if (data.itemId.startsWith(GLASS_ID_PREFIX)) return  // handled by glassSystem
    pendingCleans.delete(data.itemId)
    pendingVisualHide.delete(data.itemId)  // cancels timer if not yet fired
    if (activeHold?.id === data.itemId) {
      showHoldBar(data.itemId, false)
      activeHold = null
    }
    // Restore dirty visual immediately in case the timer already fired and hid the item.
    // lastState is then cleared so the ClutterSync watcher re-applies authoritative state
    // on its next tick (confirms item is still dirty, re-enables click).
    applyCleanStateRef(data.itemId, false)
    lastState.delete(data.itemId)
  })
}
