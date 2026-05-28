// Quick-click-to-clean system for the Rubbish group.

import { engine, Entity, Transform, pointerEventsSystem, PointerEvents, InputAction, timers } from '@dcl/sdk/ecs'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { ClutterSync } from '../shared/schemas'
import { discoverRubbish, RUBBISH_ID_PREFIX } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from '../shared/sceneItemHelpers'
import { room } from '../shared/messages'
import { showCleanedToast } from '../ui'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { PICKUP_TOUCH_MS } from '../shared/config'

const pendingCleans     = new Set<string>()
const pendingVisualHide = new Set<string>()
const lastState         = new Map<string, boolean>()

type GltfRecord = {
  containerEntity: Entity
  gltfEntity:      Entity
  clickEntity:     Entity   // enlarged proxy (or gltfEntity itself when multiplier=1)
  // null = joined while this item was already cleaned; captured on first setVisible(false).
  originalScale:   { x: number; y: number; z: number } | null
}
const gltfRecords = new Map<string, GltfRecord>()

let items: ReturnType<typeof discoverRubbish> = []

function setVisible(itemId: string, visible: boolean) {
  const rec = gltfRecords.get(itemId)
  if (!rec) return
  const tf = Transform.getMutable(rec.containerEntity)
  if (visible) {
    if (rec.originalScale !== null) {
      tf.scale = rec.originalScale
    }
    // If originalScale is still null the server's CRDT will restore the real scale.
  } else {
    if (rec.originalScale === null) {
      const curr = Transform.getOrNull(rec.containerEntity)
      if (curr && curr.scale.x > 0.01) {
        rec.originalScale = { x: curr.scale.x, y: curr.scale.y, z: curr.scale.z }
      }
    }
    tf.scale = { x: 0.001, y: 0.001, z: 0.001 }
  }
}

function disableClick(itemId: string) {
  const rec = gltfRecords.get(itemId)
  if (!rec) return
  pointerEventsSystem.removeOnPointerDown(rec.clickEntity)
  pointerEventsSystem.removeOnPointerHoverEnter(rec.clickEntity)
  PointerEvents.deleteFrom(rec.clickEntity)
}

function enableClick(itemId: string) {
  const rec = gltfRecords.get(itemId)
  if (!rec) return
  const { clickEntity, containerEntity } = rec
  pointerEventsSystem.onPointerHoverEnter({ entity: clickEntity }, () => playHoverSound())
  pointerEventsSystem.onPointerDown(
    { entity: clickEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean' } },
    () => {
      if (pendingCleans.has(itemId)) return
      pendingCleans.add(itemId)
      const pos = Transform.getOrNull(containerEntity)?.position
      disableClick(itemId)
      playClickSound()
      playCleanSound()
      if (pos) playPickupEmote(pos)
      room.send('cleanItem', { itemId })
      showCleanedToast()

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

export function initRubbishSystem() {
  items = discoverRubbish()
  if (items.length === 0) return

  // On scene (re-)entry clear stale state so the ClutterSync watcher re-applies
  // authoritative state and re-enables clicks on any newly-uncleaned items.
  onEnterSceneObservable.add(() => {
    pendingCleans.clear()
    pendingVisualHide.clear()
    lastState.clear()
  })

  // ── Authoritative state watcher ───────────────────────────────────────────────
  engine.addSystem(() => {
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      if (!state.itemId.startsWith(RUBBISH_ID_PREFIX)) continue
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
      const rawScale = tf ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z } : null
      const originalScale = (rawScale && rawScale.x > 0.01) ? rawScale : null

      const clickEnt = setupClickProxy(gltfEnt)

      gltfRecords.set(itemId, { containerEntity: entity, gltfEntity: gltfEnt, clickEntity: clickEnt, originalScale })
      needsSetup.delete(itemId)
      console.log(`[RUBBISH] "${itemId}" ready → gltf ${gltfEnt}`)

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
      for (const id of needsSetup) console.log(`[RUBBISH] WARNING "${id}" not found after 10 s`)
      engine.removeSystem(setupSystem)
    }
  }
  engine.addSystem(setupSystem)

  room.onMessage('cleanRejected', (data) => {
    if (!data.itemId.startsWith(RUBBISH_ID_PREFIX)) return
    pendingCleans.delete(data.itemId)
    pendingVisualHide.delete(data.itemId)
    setVisible(data.itemId, true)
    lastState.delete(data.itemId)
  })
}
