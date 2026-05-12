// Quick-click-to-clean system for the Rubbish group.
// Children of the "Rubbish" entity disappear on click and stay gone until round reset.

import { engine, Entity, Transform, GltfContainer, ColliderLayer, pointerEventsSystem, PointerEvents, InputAction } from '@dcl/sdk/ecs'
import { ClutterSync } from '../shared/schemas'
import { discoverRubbish, RUBBISH_ID_PREFIX } from '../shared/glassDiscovery'
import { room } from '../shared/messages'
import { showCleanedToast } from '../ui'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'

const pendingCleans = new Set<string>()
const lastState     = new Map<string, boolean>()

type GltfRecord = {
  containerEntity: Entity
  gltfEntity:      Entity
  src:             string
  originalScale:   { x: number; y: number; z: number }
}
const gltfRecords = new Map<string, GltfRecord>()

let items: ReturnType<typeof discoverRubbish> = []

function findGltfEntity(containerEntity: Entity): Entity | undefined {
  if (GltfContainer.getOrNull(containerEntity)) return containerEntity
  for (const [e] of engine.getEntitiesWith(GltfContainer)) {
    if (Transform.getOrNull(e)?.parent === containerEntity) return e
  }
  return undefined
}

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

function enableClick(itemId: string, fallbackEntity: Entity) {
  const rec = gltfRecords.get(itemId)
  const target = rec?.gltfEntity ?? fallbackEntity
  pointerEventsSystem.onPointerHoverEnter({ entity: target }, () => playHoverSound())
  pointerEventsSystem.onPointerDown(
    { entity: target, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean' } },
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
      showCleanedToast()
    }
  )
}

export function initRubbishSystem() {
  items = discoverRubbish()
  if (items.length === 0) return

  // One-shot setup: find each item's GltfContainer entity, store src, set collision mask.
  // After populating each record we immediately re-apply any clean state that arrived
  // from the server before setup completed — prevents items staying visible when the
  // state watcher fired before gltfRecords was populated.
  const needsSetup = new Set(items.map(i => i.itemId))
  const setupSystem = () => {
    for (const { entity, itemId } of items) {
      if (!needsSetup.has(itemId)) continue
      const gltfEnt = findGltfEntity(entity)
      if (!gltfEnt) continue

      GltfContainer.getMutable(gltfEnt).visibleMeshesCollisionMask = ColliderLayer.CL_POINTER

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

  // Authoritative state watcher — drives hide/show and click registration.
  engine.addSystem(() => {
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      if (!state.itemId.startsWith(RUBBISH_ID_PREFIX)) continue
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
    if (!data.itemId.startsWith(RUBBISH_ID_PREFIX)) return
    pendingCleans.delete(data.itemId)
    lastState.delete(data.itemId)
    // silently drop — server rejection needs no feedback
  })
}
