// Generic system for scene-item groups that are collected (hidden) on click.
// Each call to initCollectibleGroup handles one named group (Glasses, Bottles, …).

import { engine, Entity, Transform, GltfContainer, ColliderLayer, pointerEventsSystem, PointerEvents, InputAction } from '@dcl/sdk/ecs'
import { ClutterSync } from '../shared/schemas'
import { SceneItemDef } from '../shared/glassDiscovery'
import { room } from '../shared/messages'
import { showCollectionToast } from '../ui'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'

export type CollectibleConfig = {
  items:     SceneItemDef[]
  idPrefix:  string
  toastKind: 'glasses' | 'bottles' | null
}

export function initCollectibleGroup(cfg: CollectibleConfig) {
  const { items, idPrefix, toastKind } = cfg
  if (items.length === 0) return

  const pendingCleans = new Set<string>()
  const lastState     = new Map<string, boolean>()

  // containerEntity = the entity discovered by discoverChildren (direct child of the group).
  // gltfEntity      = the entity that actually holds GltfContainer (self or one level deeper).
  // We hide by scaling containerEntity to zero — this collapses the entire sub-tree
  // in world-space regardless of how many levels deep the GltfContainer lives, and it
  // mirrors the approach that already works for primitive shapes in cleaningSystem.ts.
  type GltfRecord = {
    containerEntity: Entity
    gltfEntity:      Entity
    src:             string
    originalScale:   { x: number; y: number; z: number }
  }
  const gltfRecords = new Map<string, GltfRecord>()

  function findGltfEntity(containerEntity: Entity): Entity | undefined {
    if (GltfContainer.getOrNull(containerEntity)) return containerEntity
    for (const [e] of engine.getEntitiesWith(GltfContainer)) {
      if (Transform.getOrNull(e)?.parent === containerEntity) return e
    }
    return undefined
  }

  // One-shot setup — runs every frame until all items are ready, then removes itself.
  // Captures the original scale so we can restore it on round reset.
  // Applies any clean state that arrived before the record was ready (timing catch-up).
  const needsSetup = new Set(items.map(i => i.itemId))
  const setupSystem = () => {
    for (const { entity, itemId } of items) {
      if (!needsSetup.has(itemId)) continue
      const gltfEnt = findGltfEntity(entity)
      if (!gltfEnt) continue

      // Set pointer collision mask on the GltfContainer entity
      GltfContainer.getMutable(gltfEnt).visibleMeshesCollisionMask = ColliderLayer.CL_POINTER

      // Capture original scale from the container entity (the composite child we'll scale)
      const tf = Transform.getOrNull(entity)
      const originalScale = tf
        ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z }
        : { x: 1, y: 1, z: 1 }

      gltfRecords.set(itemId, {
        containerEntity: entity,
        gltfEntity:      gltfEnt,
        src:             GltfContainer.get(gltfEnt).src,
        originalScale,
      })
      needsSetup.delete(itemId)

      // Timing catch-up: apply authoritative state if watcher fired before we were ready.
      const knownCleaned = lastState.get(itemId)
      if (knownCleaned !== undefined) {
        setVisible(itemId, !knownCleaned)
        if (knownCleaned) disableClick(itemId)
        else             enableClick(itemId, entity)
      }
    }
    if (needsSetup.size === 0) engine.removeSystem(setupSystem)
  }
  engine.addSystem(setupSystem)

  // ── Visibility ────────────────────────────────────────────────────────────────
  // Scale the container entity to zero (hide) or restore its original scale (show).
  // Scaling the container collapses its entire world-space sub-tree — no VisibilityComponent
  // needed, and no CRDT authority conflicts since we own the scale value after first write.
  function setVisible(itemId: string, visible: boolean) {
    const rec = gltfRecords.get(itemId)
    if (!rec) return
    const tf = Transform.getMutable(rec.containerEntity)
    tf.scale = visible
      ? { x: rec.originalScale.x, y: rec.originalScale.y, z: rec.originalScale.z }
      : { x: 0.001, y: 0.001, z: 0.001 }
  }

  // ── Pointer events ────────────────────────────────────────────────────────────
  // Registered on gltfEntity so clicks land on the actual mesh surface.
  function disableClick(itemId: string) {
    const rec = gltfRecords.get(itemId)
    if (!rec) return
    pointerEventsSystem.removeOnPointerDown(rec.gltfEntity)
    pointerEventsSystem.removeOnPointerHoverEnter(rec.gltfEntity)
    PointerEvents.deleteFrom(rec.gltfEntity)
  }

  function enableClick(itemId: string, fallbackEntity: Entity) {
    const rec = gltfRecords.get(itemId)
    const target = rec?.gltfEntity ?? fallbackEntity
    pointerEventsSystem.onPointerHoverEnter({ entity: target }, () => playHoverSound())
    pointerEventsSystem.onPointerDown(
      { entity: target, opts: { button: InputAction.IA_POINTER, hoverText: 'Collect' } },
      () => {
        if (pendingCleans.has(itemId)) return
        pendingCleans.add(itemId)
        const pos = Transform.getOrNull(rec?.containerEntity ?? target)?.position
        setVisible(itemId, false)
        disableClick(itemId)
        playClickSound()
        playCleanSound()
        if (pos) { playPickupEmote(pos); playSparkle(pos) }
        room.send('cleanItem', { itemId })
        if (toastKind !== null) {
          showCollectionToast(toastKind, countCollected(), items.length)
        }
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

      const ref = items.find(i => i.itemId === state.itemId)
      if (!ref) continue

      setVisible(state.itemId, !state.isCleaned)
      if (state.isCleaned) {
        disableClick(state.itemId)
      } else {
        enableClick(state.itemId, ref.entity)
      }
    }
  })

  room.onMessage('cleanRejected', (data) => {
    if (!data.itemId.startsWith(idPrefix)) return
    pendingCleans.delete(data.itemId)
    lastState.delete(data.itemId)
    // silently drop — server rejection needs no feedback
  })
}
