// Generic system for scene-item groups that are collected (hidden) on click.
// Each call to initCollectibleGroup handles one named group (Glasses, Bottles, …).

import { engine, Entity, Transform, pointerEventsSystem, PointerEvents, InputAction } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { ClutterSync, GameState } from '../shared/schemas'
import { SceneItemDef } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from '../shared/sceneItemHelpers'
import { room } from '../shared/messages'
import { showCollectionToast, showNarrativeToast } from '../ui'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { shrinkAndHide, cancelShrink } from './itemFx'
import { requestSetup } from './spawnDirector'
import { clicksAllowed, onPhaseChange, SYNC_POLL_S } from './phaseGate'
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
    // Entity that carries the pointer events. On desktop this is the GLB entity
    // itself; on mobile it is the enlarged tap-target proxy setupClickProxy returns.
    clickEntity:     Entity
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
    pointerEventsSystem.removeOnPointerDown(rec.clickEntity)
    pointerEventsSystem.removeOnPointerHoverEnter(rec.clickEntity)
    PointerEvents.deleteFrom(rec.clickEntity)
  }

  function enableClick(itemId: string) {
    if (!clicksAllowed()) return  // pointer events only live during the 'playing' phase
    const rec = gltfRecords.get(itemId)
    if (!rec) return
    const { clickEntity, containerEntity } = rec
    pointerEventsSystem.onPointerHoverEnter({ entity: clickEntity }, () => playHoverSound())
    pointerEventsSystem.onPointerDown(
      { entity: clickEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean' } },
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
        // Capture the real (full) scale now, before the shrink starts, so respawn
        // can restore it (setVisible(true) reads rec.originalScale).
        if (rec.originalScale === null) {
          const curr = Transform.getOrNull(containerEntity)
          if (curr && curr.scale.x > 0.01) {
            rec.originalScale = { x: curr.scale.x, y: curr.scale.y, z: curr.scale.z }
          }
        }
        // Shrink immediately (instant visual response, no frozen wait) and land
        // "gone" at the emote's hand-touch moment.  Sparkle + the pending-hide
        // bookkeeping fire on completion, preserving the original guard logic.
        shrinkAndHide(containerEntity, PICKUP_TOUCH_MS / 1000, () => {
          const wasPending = pendingVisualHide.has(itemId)
          pendingVisualHide.delete(itemId)
          // cleanRejected wiped the guard and the item isn't confirmed clean →
          // restore it (it has already shrunk away).  Otherwise it stays hidden
          // (the tween left it at near-zero scale) and the sparkle plays.
          if (!wasPending && lastState.get(itemId) !== true) {
            setVisible(itemId, true)
            return
          }
          if (pos) playSparkle(pos)
        })
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

  // ── Authoritative state watcher (polled at SYNC_POLL_S, not every frame) ──────
  let syncAcc = 0
  engine.addSystem((dt: number) => {
    syncAcc += dt
    if (syncAcc < SYNC_POLL_S) return
    syncAcc = 0
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

  // ── Staggered setup — one item at a time via the global director ──────────────
  // Each item's heavy bring-up (setupClickProxy + first state apply) is queued and
  // run only once its GLB has streamed in, throttled globally so the whole scene's
  // ~80 items don't set up in one frame (the load spike).
  for (const { entity, itemId } of items) {
    requestSetup({
      isReady: () => findGltfEntity(entity) !== undefined,
      run: () => {
        const gltfEnt = findGltfEntity(entity)
        if (!gltfEnt) return

        const tf = Transform.getOrNull(entity)
        // If the item is already cleaned (scale ≈ 0) when we join, don't record 0.001 as
        // the original scale — that would keep the item invisible after every respawn.
        // originalScale stays null and is captured the first time we call setVisible(false).
        const rawScale = tf ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z } : null
        const originalScale = (rawScale && rawScale.x > 0.01) ? rawScale : null

        const clickEnt = setupClickProxy(gltfEnt)
        gltfRecords.set(itemId, { containerEntity: entity, clickEntity: clickEnt, originalScale })

        const knownCleaned = lastState.get(itemId)
        if (knownCleaned !== undefined) {
          // ClutterSync watcher already processed authoritative state — apply it now.
          setVisible(itemId, !knownCleaned)
          if (knownCleaned) disableClick(itemId)
          else              enableClick(itemId)   // no-op unless we're in 'playing'
        } else if (isStateSyncronized()) {
          // State synced but watcher hasn't seen this item yet (rare race).
          enableClick(itemId)
        }
        // else: CRDT not complete — the ClutterSync watcher will enable/disable later.
      },
    })
  }

  // ── Phase gate — pointer events only live while players can clean ─────────────
  onPhaseChange((phase) => {
    if (phase === 'playing') {
      for (const { itemId } of items) {
        if (pendingCleans.has(itemId)) continue
        if (lastState.get(itemId) === true) continue   // already cleaned
        enableClick(itemId)
      }
    } else {
      for (const { itemId } of items) disableClick(itemId)
    }
  })

  room.onMessage('cleanRejected', (data) => {
    if (!data.itemId.startsWith(idPrefix)) return
    pendingCleans.delete(data.itemId)
    pendingVisualHide.delete(data.itemId)
    const rec = gltfRecords.get(data.itemId)
    if (rec) cancelShrink(rec.containerEntity)  // stop an in-flight shrink before restoring
    setVisible(data.itemId, true)
    lastState.delete(data.itemId)
  })
}
