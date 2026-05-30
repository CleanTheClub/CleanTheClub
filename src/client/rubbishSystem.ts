// Quick-click-to-clean system for the Rubbish group.

import { engine, Entity, Transform, pointerEventsSystem, PointerEvents, InputAction, timers } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { ClutterSync, GameState } from '../shared/schemas'
import { discoverRubbish, RUBBISH_ID_PREFIX } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from '../shared/sceneItemHelpers'
import { room } from '../shared/messages'
import { showCleanedToast, showNarrativeToast } from '../ui'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { PICKUP_TOUCH_MS } from '../shared/config'

const pendingCleans     = new Set<string>()
const pendingVisualHide = new Set<string>()
const lastState         = new Map<string, boolean>()

// ── Open-phase cleaning gate ───────────────────────────────────────────────────
// Cleaning is disabled while the club is in the 'open' (intermission) phase so
// players get a clear round → intermission → round cadence.  Mirrors the gate in
// collectibleSystem.ts / InteractionManager.ts.
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
      if (getPhase() === 'open') { maybeShowOpenPhaseToast(); return }
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
        // Always delete the pending-hide guard first so the ClutterSync watcher
        // can take over if it hasn't already (e.g. after re-entry clear).
        const wasPending = pendingVisualHide.has(itemId)
        pendingVisualHide.delete(itemId)
        // Hide + sparkle if:
        //   (a) normal path — we were still in the pending set, OR
        //   (b) onEnterSceneObservable wiped pendingVisualHide but the ClutterSync
        //       watcher already confirmed clean (lastState=true) so this is a
        //       guaranteed-safe visual update.
        // In case (b) setVisible is a no-op (watcher already hid the item), but
        // the sparkle still plays at the correct emote-touch moment.
        if (!wasPending && lastState.get(itemId) !== true) return
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
        // ClutterSync watcher already processed authoritative state — apply it now.
        setVisible(itemId, !knownCleaned)
        if (knownCleaned) disableClick(itemId)
        else              enableClick(itemId)
      } else if (isStateSyncronized()) {
        // State is fully synced but watcher hasn't seen this item yet (rare race).
        // Enable as a safe default; watcher corrects if item is already cleaned.
        enableClick(itemId)
      }
      // else: CRDT not yet complete — do NOT enable clicks.  The ClutterSync watcher
      // will call enableClick / disableClick once the authoritative state arrives.
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
