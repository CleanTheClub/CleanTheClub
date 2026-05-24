// Generic system for scene-item groups that are collected (hidden) on click.
// Each call to initCollectibleGroup handles one named group (Glasses, Bottles, …).

import { engine, Entity, Transform, pointerEventsSystem, PointerEvents, InputAction, timers } from '@dcl/sdk/ecs'
import { ClutterSync, GameState } from '../shared/schemas'
import { SceneItemDef } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from '../shared/sceneItemHelpers'
import { room } from '../shared/messages'
import { showCollectionToast, showNarrativeToast } from '../ui'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { PICKUP_TOUCH_MS } from '../shared/config'

export type CollectibleConfig = {
  items:     SceneItemDef[]
  idPrefix:  string
  toastKind: 'glasses' | 'bottles' | null
}

function getPhase(): string {
  for (const [, gs] of engine.getEntitiesWith(GameState)) return gs.phase ?? 'playing'
  return 'playing'
}

const OPEN_PHASE_TOAST_COOLDOWN_MS = 3_000
let lastOpenPhaseToastMs = 0
function maybeShowOpenPhaseToast() {
  const now = Date.now()
  if (now - lastOpenPhaseToastMs < OPEN_PHASE_TOAST_COOLDOWN_MS) return
  lastOpenPhaseToastMs = now
  showNarrativeToast('Wait for the next round!')
}

export function initCollectibleGroup(cfg: CollectibleConfig) {
  const { items, idPrefix, toastKind } = cfg
  if (items.length === 0) return

  const pendingCleans     = new Set<string>()
  const pendingVisualHide = new Set<string>()
  const lastState         = new Map<string, boolean>()

  type GltfRecord = {
    containerEntity: Entity
    gltfEntity:      Entity
    originalScale:   { x: number; y: number; z: number }
  }
  const gltfRecords = new Map<string, GltfRecord>()

  function setVisible(itemId: string, visible: boolean) {
    const rec = gltfRecords.get(itemId)
    if (!rec) return
    const tf = Transform.getMutable(rec.containerEntity)
    tf.scale = visible
      ? { x: rec.originalScale.x, y: rec.originalScale.y, z: rec.originalScale.z }
      : { x: 0.001, y: 0.001, z: 0.001 }
  }

  function disableClick(itemId: string) {
    const rec = gltfRecords.get(itemId)
    if (!rec) return
    pointerEventsSystem.removeOnPointerDown(rec.gltfEntity)
    pointerEventsSystem.removeOnPointerHoverEnter(rec.gltfEntity)
    PointerEvents.deleteFrom(rec.gltfEntity)
  }

  function enableClick(itemId: string) {
    const rec = gltfRecords.get(itemId)
    if (!rec) return
    const { gltfEntity, containerEntity } = rec
    pointerEventsSystem.onPointerHoverEnter({ entity: gltfEntity }, () => playHoverSound())
    pointerEventsSystem.onPointerDown(
      { entity: gltfEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean' } },
      () => {
        if (pendingCleans.has(itemId)) return
        if (getPhase() === 'open') { maybeShowOpenPhaseToast(); return }
        pendingCleans.add(itemId)
        const pos = Transform.getOrNull(containerEntity)?.position
        disableClick(itemId)
        playClickSound()
        playCleanSound()
        if (pos) playPickupEmote(pos)
        room.send('cleanItem', { itemId })
        if (toastKind !== null) showCollectionToast(toastKind, countCollected(), items.length)

        pendingVisualHide.add(itemId)
        timers.setTimeout(() => {
          if (!pendingVisualHide.has(itemId)) return
          pendingVisualHide.delete(itemId)
          setVisible(itemId, false)
          if (pos) playSparkle(pos)
        }, PICKUP_TOUCH_MS)
      }
    )
  }

  function countCollected(): number {
    let n = 0
    for (const { itemId } of items) {
      if (lastState.get(itemId) || pendingCleans.has(itemId)) n++
    }
    return n
  }

  // ── Authoritative state watcher ───────────────────────────────────────────────
  engine.addSystem(() => {
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      if (!state.itemId.startsWith(idPrefix)) continue
      if (lastState.get(state.itemId) === state.isCleaned) continue
      lastState.set(state.itemId, state.isCleaned)
      pendingCleans.delete(state.itemId)

      if (state.isCleaned) {
        disableClick(state.itemId)
        if (!pendingVisualHide.has(state.itemId)) setVisible(state.itemId, false)
      } else {
        pendingVisualHide.delete(state.itemId)
        setVisible(state.itemId, true)
        enableClick(state.itemId)
      }
    }
  })

  // ── One-shot setup ────────────────────────────────────────────────────────────
  const needsSetup = new Set(items.map(i => i.itemId))
  const setupStartMs = Date.now()
  const setupSystem = () => {
    for (const { entity, itemId } of items) {
      if (!needsSetup.has(itemId)) continue
      const gltfEnt = findGltfEntity(entity)
      if (!gltfEnt) continue

      const tf = Transform.getOrNull(entity)
      const originalScale = tf
        ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z }
        : { x: 1, y: 1, z: 1 }

      setupClickProxy(gltfEnt)

      gltfRecords.set(itemId, { containerEntity: entity, gltfEntity: gltfEnt, originalScale })
      needsSetup.delete(itemId)

      const knownCleaned = lastState.get(itemId)
      if (knownCleaned !== undefined) {
        setVisible(itemId, !knownCleaned)
        if (knownCleaned) disableClick(itemId)
        else              enableClick(itemId)
      } else {
        enableClick(itemId)
      }
    }

    if (needsSetup.size === 0) { engine.removeSystem(setupSystem); return }
    if (Date.now() - setupStartMs > 10_000) {
      for (const id of needsSetup) console.log(`[COLLECT:${idPrefix}] WARNING "${id}" not found after 10 s`)
      engine.removeSystem(setupSystem)
    }
  }
  engine.addSystem(setupSystem)

  room.onMessage('cleanRejected', (data) => {
    if (!data.itemId.startsWith(idPrefix)) return
    pendingCleans.delete(data.itemId)
    pendingVisualHide.delete(data.itemId)
    setVisible(data.itemId, true)
    lastState.delete(data.itemId)
  })
}
