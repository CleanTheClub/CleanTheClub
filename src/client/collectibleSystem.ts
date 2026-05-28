// Generic system for scene-item groups that are collected (hidden) on click.
// Each call to initCollectibleGroup handles one named group (Glasses, Bottles, …).

import { engine, Entity, Transform, pointerEventsSystem, PointerEvents, InputAction, timers } from '@dcl/sdk/ecs'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
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

  // On scene (re-)entry clear stale state so the ClutterSync watcher re-applies
  // authoritative state and re-enables clicks on any newly-uncleaned items.
  onEnterSceneObservable.add(() => {
    pendingCleans.clear()
    pendingVisualHide.clear()
    lastState.clear()
  })

  type GltfRecord = {
    containerEntity: Entity
    gltfEntity:      Entity
    // null = joined while this item was already cleaned; real scale not yet captured.
    // Captured the first time we call setVisible(false) and see a non-zero scale.
    originalScale:   { x: number; y: number; z: number } | null
  }
  const gltfRecords = new Map<string, GltfRecord>()

  function setVisible(itemId: string, visible: boolean) {
    const rec = gltfRecords.get(itemId)
    if (!rec) return
    const tf = Transform.getMutable(rec.containerEntity)
    if (visible) {
      if (rec.originalScale !== null) {
        tf.scale = rec.originalScale
      }
      // If originalScale is still null (joined while item was cleaned), don't write
      // 0.001 — the server's CRDT has already, or will shortly, restore the real scale.
    } else {
      // Capture real scale before hiding if we haven't yet (item was cleaned on join).
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
      // If the item is already cleaned (scale ≈ 0) when we join, don't record 0.001 as
      // the original scale — that would keep the item invisible after every respawn.
      // originalScale stays null and is captured the first time we call setVisible(false).
      const rawScale = tf ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z } : null
      const originalScale = (rawScale && rawScale.x > 0.01) ? rawScale : null

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
