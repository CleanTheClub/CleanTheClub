// Generic system for scene-item groups that are collected (hidden) on click.
// Each call to initCollectibleGroup handles one named group (Glasses, Bottles, …).

import { Entity, Transform, pointerEventsSystem, PointerEvents, InputAction, GltfContainer, VisibilityComponent, timers } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { onLocalEnterScene } from './localPlayer'
import { SceneItemDef } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from './sceneItemHelpers'
import { room } from '../shared/messages'
import { showCollectionToast, showNarrativeToast } from '../ui'
import { playHoverSound, playCleanSound, playMissSound } from './soundManager'
import { isCarryFull, shouldNudgeToBin, triggerBinNudge, noteCarriedModel, pulseCarryBox, usingVacuum } from './carrySystem'
import { registerSpreeHit } from './spreeSystem'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { shrinkAndHide, suckAndHide, cancelShrink } from './itemFx'
import { requestSetup } from './spawnDirector'
import { clicksAllowed, onPhaseChange, withinReach, pointerMaxDist, currentPhase } from './phaseGate'
import { onClutterPoll } from './clutterWatcher'
import { PICKUP_TOUCH_MS } from '../shared/config'

export type CollectibleConfig = {
  items:     SceneItemDef[]
  idPrefix:  string
  toastKind: 'glasses' | 'bottles' | null
}

const OPEN_PHASE_TOAST_COOLDOWN_MS = 3_000
let lastOpenPhaseToastMs = 0
function maybeShowOpenPhaseToast() {
  const now = Date.now()
  if (now - lastOpenPhaseToastMs < OPEN_PHASE_TOAST_COOLDOWN_MS) return
  lastOpenPhaseToastMs = now
  showNarrativeToast('Wait for the next round!')
}

// Module-level (shared by the glasses AND bottles groups) so the cooldowns don't
// double-fire when both groups are being clicked. Miss blip on every attempt;
// only the toast is throttled.
let lastFullToastMs = 0
function maybeShowFullToast() {
  playMissSound()
  const now = Date.now()
  if (now - lastFullToastMs < OPEN_PHASE_TOAST_COOLDOWN_MS) return
  lastFullToastMs = now
  showNarrativeToast('Hands full! Empty them at a bin')
}

let lastTooFarToastMs = 0
function maybeShowTooFarToast() {
  playMissSound()
  const now = Date.now()
  if (now - lastTooFarToastMs < OPEN_PHASE_TOAST_COOLDOWN_MS) return
  lastTooFarToastMs = now
  showNarrativeToast('Too far away — get closer!')
}

export function initCollectibleGroup(cfg: CollectibleConfig) {
  const { items, idPrefix, toastKind } = cfg
  if (items.length === 0) return

  const pendingCleans     = new Set<string>()
  const pendingVisualHide = new Set<string>()
  const lastState         = new Map<string, boolean>()

  // On scene (re-)entry clear stale state so the ClutterSync watcher re-applies
  // authoritative state and re-enables clicks on any newly-uncleaned items.
  onLocalEnterScene(() => {
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
    // See rubbishSystem.setVisible — hidden means NOT RENDERED, not just tiny.
    VisibilityComponent.createOrReplace(rec.containerEntity, { visible })
    const tf = Transform.getMutable(rec.containerEntity)
    if (visible) {
      // Restore only from a banked scale — the server never writes these
      // Transforms (it only flips ClutterSync.isCleaned), so a zeroed scale is
      // ours to undo. Null means the authored scale was already ≤0.01: nothing
      // to restore.
      if (rec.originalScale !== null) tf.scale = rec.originalScale
    } else {
      // Capture real scale before hiding if we haven't yet (item was cleaned on join).
      if (rec.originalScale === null) {
        const curr = Transform.getOrNull(rec.containerEntity)
        if (curr && curr.scale.x > 0.01) {
          rec.originalScale = { x: curr.scale.x, y: curr.scale.y, z: curr.scale.z }
        }
      }
      // Unconditional: hidden must also mean a vanishing collider — visibility
      // stops the render, not the CL_POINTER mesh collider.
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
    // Invariant: clickable implies visible (see rubbishSystem).
    VisibilityComponent.createOrReplace(rec.containerEntity, { visible: true })
    const { clickEntity, containerEntity } = rec
    pointerEventsSystem.onPointerHoverEnter({ entity: clickEntity }, () => playHoverSound())
    pointerEventsSystem.onPointerDown(
      // Glasses and bottles are glass — they fill the recycling pouch, and the
      // prompt says so, so the carry chip's green number can't be a mystery.
      { entity: clickEntity, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean (Recycling)', maxDistance: pointerMaxDist() } },
      () => {
        if (pendingCleans.has(itemId)) return
        if (currentPhase() === 'open') { maybeShowOpenPhaseToast(); return }
        if (isCarryFull()) { maybeShowFullToast(); pulseCarryBox(); return }
        const pos = Transform.getOrNull(containerEntity)?.position
        if (!withinReach(pos)) { maybeShowTooFarToast(); return }
        pendingCleans.add(itemId)
        noteCarriedModel(GltfContainer.getOrNull(containerEntity)?.src)
        registerSpreeHit()
        // First pickup of a brand-new career: point at the nearest bin once, so
        // "my hands fill up and I have to walk somewhere" is taught rather than
        // discovered by hitting the capacity wall.
        if (shouldNudgeToBin()) {
          triggerBinNudge()
          showNarrativeToast('Hands fill up — empty them at a bin!')
        }
        disableClick(itemId)
        playCleanSound()
        if (pos && !usingVacuum()) playPickupEmote(pos)
        room.send('cleanItem', { itemId })
        if (toastKind !== null) showCollectionToast(toastKind, countCollected(), reachableTotal())

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
        ;(usingVacuum() ? suckAndHide : shrinkAndHide)(containerEntity, PICKUP_TOUCH_MS / 1000, () => {
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

  // Items the round's theme mask pre-cleaned (e.g. the special drinks on a
  // classic round) read as collected in ClutterSync without anyone touching
  // them, which inflated the counter (first pickup showed 7/23). Baseline them
  // out: snapshot shortly after round start — the delay lets the reset + mask
  // replicate — and count/total against the reachable rest.
  const maskedBaseline = new Set<string>()
  onPhaseChange((phase) => {
    if (phase !== 'playing') return
    timers.setTimeout(() => {
      if (currentPhase() !== 'playing') return   // round already moved on
      maskedBaseline.clear()
      for (const { itemId } of items) {
        if (lastState.get(itemId) === true) maskedBaseline.add(itemId)
      }
    }, 1_200)
  })

  function reachableTotal(): number {
    return items.length - maskedBaseline.size
  }

  function countCollected(): number {
    let n = 0
    for (const { itemId } of items) {
      if (maskedBaseline.has(itemId)) continue
      if (lastState.get(itemId) || pendingCleans.has(itemId)) n++
    }
    return n
  }

  // ── Authoritative state watcher — rides the shared ClutterSync poll ───────────
  onClutterPoll((entries) => {
    for (const { itemId, isCleaned } of entries) {
      if (!itemId.startsWith(idPrefix)) continue
      if (lastState.get(itemId) === isCleaned) continue
      lastState.set(itemId, isCleaned)
      pendingCleans.delete(itemId)

      if (isCleaned) {
        disableClick(itemId)
        if (!pendingVisualHide.has(itemId)) setVisible(itemId, false)
      } else {
        pendingVisualHide.delete(itemId)
        setVisible(itemId, true)
        enableClick(itemId)
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
