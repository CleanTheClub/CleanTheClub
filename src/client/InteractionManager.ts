import { engine, Entity, Transform, pointerEventsSystem, PointerEvents, InputAction } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { room } from '../shared/messages'
import { ClutterSync } from '../shared/schemas'
import { CLUTTER_DEFS, HOLD_DURATION_MS, InteractionType } from '../shared/config'
import { GLASS_ID_PREFIX } from '../shared/glassDiscovery'
import { showCleanedToast } from '../ui'
import { playHoverSound, playClickSound, playStickySound, playCleanSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'

const pendingCleans = new Set<string>()
const lastState     = new Map<string, boolean>()

// Stored after sync so enable/disable can re-register handlers at any time
type ItemRef = { entity: Entity; type: InteractionType }
const itemRefs = new Map<string, ItemRef>()

type ActiveHold = { id: string; startMs: number }
let activeHold: ActiveHold | null = null

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
        playStickySound()
        activeHold = { id, startMs: Date.now() }
        showHoldBarRef(id, true)
        updateHoldBarRef(id, 0)
      }
    )
    pointerEventsSystem.onPointerUp(
      { entity, opts: { button: InputAction.IA_POINTER } },
      () => {
        if (activeHold?.id !== id) return
        activeHold = null
        showHoldBarRef(id, false)
        updateHoldBarRef(id, 0)
      }
    )
  } else {
    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean' } },
      () => {
        playClickSound()
        playCleanSound()
        if (type === 'quick' || type === 'collect') {
          const pos = Transform.getOrNull(entity)?.position
          if (pos) { playPickupEmote(pos); playSparkle(pos) }
        }
        tryClean(id, applyCleanStateRef)
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

// ─── Refs captured at init so enable/disable closures can call them ──────────
// (avoids threading callbacks through every helper)

let applyCleanStateRef: (id: string, isCleaned: boolean) => void = () => {}
let showHoldBarRef:     (id: string, visible: boolean) => void   = () => {}
let updateHoldBarRef:   (id: string, progress: number) => void   = () => {}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initInteractionManager(
  dirtyEntities:   Map<string, Entity>,
  applyCleanState: (id: string, isCleaned: boolean) => void,
  showHoldBar:     (id: string, visible: boolean) => void,
  updateHoldBar:   (id: string, progress: number) => void,
) {
  applyCleanStateRef = applyCleanState
  showHoldBarRef     = showHoldBar
  updateHoldBarRef   = updateHoldBar

  // Populate item refs immediately — enable/disable can be called as soon as sync fires
  for (const def of CLUTTER_DEFS) {
    itemRefs.set(def.id, { entity: dirtyEntities.get(def.id)!, type: def.type ?? 'quick' })
  }

  // Frame system: drives hold progress + fires on completion
  engine.addSystem(() => {
    if (!activeHold) return
    const progress = (Date.now() - activeHold.startMs) / HOLD_DURATION_MS
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

  // Enable clicks once server state is synced — ClutterSync watcher will
  // immediately disable any already-cleaned items on the first frame
  let registered = false
  engine.addSystem(() => {
    if (!isStateSyncronized() || registered) return
    registered = true
    for (const def of CLUTTER_DEFS) enableClick(def.id)
  })

  // Watch ClutterSync → apply authoritative state + manage click availability
  engine.addSystem(() => {
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
      } else {
        enableClick(state.itemId)
      }

      applyCleanState(state.itemId, state.isCleaned)
    }
  })

  room.onMessage('cleanRejected', (data) => {
    if (data.itemId.startsWith(GLASS_ID_PREFIX)) return  // handled by glassSystem
    pendingCleans.delete(data.itemId)
    if (activeHold?.id === data.itemId) {
      showHoldBar(data.itemId, false)
      activeHold = null
    }
    // Invalidate lastState so the watcher re-applies authoritative ClutterSync state
    // next frame — avoids manually guessing dirty/clean and fighting with the watcher
    lastState.delete(data.itemId)
    // silently drop — server rejection needs no feedback
  })
}
