// Quick-click-to-clean system for the Rubbish group.

import { engine, Entity, Name, Transform, pointerEventsSystem, PointerEvents, InputAction, GltfContainer, VisibilityComponent } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { onLocalEnterScene } from './localPlayer'
import { discoverRubbish, RUBBISH_ID_PREFIX, RubbishType, classifyRubbish } from '../shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from './sceneItemHelpers'
import { room } from '../shared/messages'
import { showCleanedToast, showNarrativeToast } from '../ui'
import { playHoverSound, playCleanSound, playMissSound, playVacuumSound } from './soundManager'
import { playPickupEmote } from './emoteManager'
import { playSparkle } from './sparkleSystem'
import { shrinkAndHide, suckAndHide, cancelShrink } from './itemFx'
import { requestSetup } from './spawnDirector'
import { clicksAllowed, onPhaseChange, withinReach, pointerMaxDist, currentPhase } from './phaseGate'
import { onClutterPoll } from './clutterWatcher'
import { startPopRhythm } from './InteractionManager'
import { POP_NAME_PART } from '../shared/config'
import { isCarryFull, shouldNudgeToBin, triggerBinNudge, noteCarriedModel, pulseCarryBox, usingVacuum } from './carrySystem'
import { registerSpreeHit } from './spreeSystem'
import { PICKUP_TOUCH_MS } from '../shared/config'

const pendingCleans     = new Set<string>()
const pendingVisualHide = new Set<string>()
const lastState         = new Map<string, boolean>()

const OPEN_PHASE_TOAST_COOLDOWN_MS = 3_000
let lastOpenPhaseToastMs = 0
function maybeShowOpenPhaseToast() {
  const now = Date.now()
  if (now - lastOpenPhaseToastMs < OPEN_PHASE_TOAST_COOLDOWN_MS) return
  lastOpenPhaseToastMs = now
  showNarrativeToast('Wait for the next round!')
}

// Full-hands pickups are pre-empted here (no message sent, no shrink-then-restore
// flicker); the server enforces the same capacity for crafted messages. The miss
// blip plays on EVERY attempt (playtest: repeated errors need audible feedback);
// only the toast is throttled.
const FULL_TOAST_COOLDOWN_MS = 3_000
let lastFullToastMs = 0
function maybeShowFullToast() {
  playMissSound()
  const now = Date.now()
  if (now - lastFullToastMs < FULL_TOAST_COOLDOWN_MS) return
  lastFullToastMs = now
  showNarrativeToast('Hands full! Empty them at a bin')
}

let lastTooFarToastMs = 0
function maybeShowTooFarToast() {
  playMissSound()
  const now = Date.now()
  if (now - lastTooFarToastMs < FULL_TOAST_COOLDOWN_MS) return
  lastTooFarToastMs = now
  showNarrativeToast('Too far away — get closer!')
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

// ── Vacuum sweep visuals ──────────────────────────────────────────────────────
// A vacuum click also cleans up to N NEARBY pieces SERVER-side (the sweep).
// Those confirmations land through the ClutterSync watcher, which used to
// snap-hide them — the clicked item flew into the nozzle while its swept
// neighbours just blinked out (feedback: swept items should "move to the
// vacuum"). The watcher can't know WHO cleaned an item, so sweep-suck is
// inferred: we're wearing the vacuum, we clicked a clean within the last
// moment, and the item is within sweep range of us. A neighbour cleaned by
// another player in that same instant would false-positive — it flies to us
// instead of blinking out, which at nozzle-height and sub-half-second reads
// fine either way.
const SWEEP_SUCK_WINDOW_MS = 1_500   // click → server → CRDT → poll, with slack
const SWEEP_SUCK_RANGE_M   = 8       // sweep radius (3m) + click reach, generous
const SWEEP_SUCK_S         = 0.45
let lastVacuumClickMs = -1

function shouldSuckSweep(rec: GltfRecord): boolean {
  if (Date.now() - lastVacuumClickMs > SWEEP_SUCK_WINDOW_MS) return false
  if (!usingVacuum()) return false
  const p = Transform.getOrNull(engine.PlayerEntity)?.position
  const ip = Transform.getOrNull(rec.containerEntity)?.position
  if (!p || !ip) return false
  const dx = p.x - ip.x, dy = p.y - ip.y, dz = p.z - ip.z
  return dx * dx + dy * dy + dz * dz <= SWEEP_SUCK_RANGE_M * SWEEP_SUCK_RANGE_M
}

// itemId → recycling stream, so the hover prompt teaches the sort before pickup.
const rubbishTypes = new Map<string, RubbishType>()
// Scene popcorn — collected via the Rhythm Pop minigame, same as spawned popcorn
// (one interaction rule per item TYPE, regardless of where the item came from).
const popcornIds = new Set<string>()

function setVisible(itemId: string, visible: boolean) {
  const rec = gltfRecords.get(itemId)
  if (!rec) return
  // VisibilityComponent, not just a zeroed scale: a 0.001-scaled entity is
  // still RENDERED (and still counts toward the scene's triangle budget), which
  // is dead weight for the ~110 base items a themed round masks out for its
  // whole duration. visible:false skips it in the renderer while the entity
  // stays in the engine, so waking it costs no reload (the documented way to
  // hide scene content). Scale is still zeroed so the pickup shrink reads.
  //
  // VISIBLE = component DELETED, never {visible:true}: on mobile a visibility
  // write that lands while a GLB is (re)streaming — the watchdog force-reloads
  // failed items — can miss the meshes that arrive after it, leaving the model
  // hidden with a "true" on record ("seems like a visibility toggle"). An
  // absent component is the renderer default and has nothing to mis-apply.
  if (visible) {
    if (VisibilityComponent.getOrNull(rec.containerEntity)) VisibilityComponent.deleteFrom(rec.containerEntity)
  } else {
    VisibilityComponent.createOrReplace(rec.containerEntity, { visible: false })
  }
  const tf = Transform.getMutable(rec.containerEntity)
  if (visible) {
    // Restore only from a banked scale — the server never writes these
    // Transforms (it only flips ClutterSync.isCleaned), so a zeroed scale is
    // ours to undo. Null means the authored scale was already ≤0.01: nothing
    // to restore.
    if (rec.originalScale !== null) tf.scale = rec.originalScale
  } else {
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
  // Invariant: clickable implies visible. Cheap insurance against any path that
  // restores an item without going through setVisible.
  VisibilityComponent.createOrReplace(rec.containerEntity, { visible: true })
  const { clickEntity, containerEntity } = rec
  pointerEventsSystem.onPointerHoverEnter({ entity: clickEntity }, () => playHoverSound())
  pointerEventsSystem.onPointerDown(
    {
      entity: clickEntity,
      opts: {
        button: InputAction.IA_POINTER,
        hoverText: rubbishTypes.get(itemId) === 'recycle' ? 'Clean (Recycling)' : 'Clean (General)',
        // Camera-based prompt range; the player-based withinReach gate on click
        // is the true accept distance.
        maxDistance: pointerMaxDist(),
      },
    },
    () => {
      if (currentPhase() === 'open') { maybeShowOpenPhaseToast(); return }
      if (isCarryFull()) { maybeShowFullToast(); pulseCarryBox(); return }
      if (pendingCleans.has(itemId)) return
      const pos = Transform.getOrNull(containerEntity)?.position
      if (!withinReach(pos)) { maybeShowTooFarToast(); return }
      // Popcorn detours through the Rhythm Pop beats; the clean itself then
      // runs the identical path below (re-checked — the item may have been
      // cleaned by someone else, or the round ended, while the beats played).
      if (popcornIds.has(itemId)) {
        startPopRhythm(itemId, (hits) => {
          if (hits === 0) return   // blank run — popcorn stays, click to retry
          if (pendingCleans.has(itemId) || lastState.get(itemId) === true) return
          if (currentPhase() === 'open' || isCarryFull()) return
          performClean()
        })
        return
      }
      performClean()

      function performClean() {
      if (!rec) return   // narrowing doesn't cross the function boundary
      pendingCleans.add(itemId)
      noteCarriedModel(GltfContainer.getOrNull(containerEntity)?.src)
      registerSpreeHit()
      // Arms the sweep-suck window: neighbours the server sweeps off this
      // click fly to the nozzle instead of blinking out (see shouldSuckSweep).
      if (usingVacuum()) lastVacuumClickMs = Date.now()
      // First pickup of a brand-new career: point at the nearest bin once, so
      // "my hands fill up and I have to walk somewhere" is taught rather than
      // discovered by hitting the capacity wall.
      if (shouldNudgeToBin()) {
        triggerBinNudge()
        showNarrativeToast('Hands fill up — empty them at a bin!')
      }
      disableClick(itemId)
      // Vacuum slurps, hands get the generic clean ding. (The slurp's ONLY
      // call site used to be InteractionManager's quick-click branch — dead
      // since every CLUTTER_DEFS entry went sceneGlb — so the sound never
      // played anywhere: "i cant hear the vacuum sound".)
      if (usingVacuum()) playVacuumSound()
      else playCleanSound()
      // Vacuum pickups skip the bend-down emote — the machine does the work.
      if (pos && !usingVacuum()) playPickupEmote(pos)
      room.send('cleanItem', { itemId })
      showCleanedToast()

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
      // Vacuum INHALES the item toward the player; hands pluck it in place.
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
    }
  )
}

export function initRubbishSystem() {
  items = discoverRubbish()
  if (items.length === 0) return

  // Classify each item's recycling stream from its scene Name — the same shared
  // classifier the server uses, so the hover text can never lie about the sort.
  for (const { entity, itemId } of items) {
    const name = Name.getOrNull(entity)?.value ?? ''
    rubbishTypes.set(itemId, classifyRubbish(name))
    if (name.toLowerCase().includes(POP_NAME_PART)) popcornIds.add(itemId)
  }

  // On scene (re-)entry clear stale state so the ClutterSync watcher re-applies
  // authoritative state and re-enables clicks on any newly-uncleaned items.
  onLocalEnterScene(() => {
    pendingCleans.clear()
    pendingVisualHide.clear()
    lastState.clear()
  })

  // ── Authoritative state watcher — rides the shared ClutterSync poll ───────────
  onClutterPoll((entries) => {
    for (const { itemId, isCleaned } of entries) {
      if (!itemId.startsWith(RUBBISH_ID_PREFIX)) continue
      if (lastState.get(itemId) === isCleaned) continue
      lastState.set(itemId, isCleaned)
      pendingCleans.delete(itemId)

      if (isCleaned) {
        disableClick(itemId)
        if (!pendingVisualHide.has(itemId)) {
          const rec = gltfRecords.get(itemId)
          if (rec && shouldSuckSweep(rec)) {
            // Server-swept neighbour of our own vacuum click: inhale it like
            // the clicked item instead of snap-hiding. Safe here because the
            // server never writes scene-rubbish Transforms (only the
            // ClutterSync flag), so nothing fights the tween; suckAndHide
            // restores position+rotation for the respawn, and setVisible on
            // completion parks scale + VisibilityComponent exactly as the
            // snap path would have.
            suckAndHide(rec.containerEntity, SWEEP_SUCK_S, () => setVisible(itemId, false))
          } else {
            setVisible(itemId, false)
          }
        }
      } else {
        pendingVisualHide.delete(itemId)
        setVisible(itemId, true)
        enableClick(itemId)
      }
    }
  })

  // ── Staggered setup — one item at a time via the global director ──────────────
  // Throttled globally so rubbish (the largest group) doesn't set up all at once.
  for (const { entity, itemId } of items) {
    requestSetup({
      isReady: () => findGltfEntity(entity) !== undefined,
      run: () => {
        const gltfEnt = findGltfEntity(entity)
        if (!gltfEnt) return

        const tf = Transform.getOrNull(entity)
        const rawScale = tf ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z } : null
        const originalScale = (rawScale && rawScale.x > 0.01) ? rawScale : null

        const clickEnt = setupClickProxy(gltfEnt)
        gltfRecords.set(itemId, { containerEntity: entity, gltfEntity: gltfEnt, clickEntity: clickEnt, originalScale })

        const knownCleaned = lastState.get(itemId)
        if (knownCleaned !== undefined) {
          setVisible(itemId, !knownCleaned)
          if (knownCleaned) disableClick(itemId)
          else              enableClick(itemId)   // no-op unless we're in 'playing'
        } else if (isStateSyncronized()) {
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
    if (!data.itemId.startsWith(RUBBISH_ID_PREFIX)) return
    pendingCleans.delete(data.itemId)
    pendingVisualHide.delete(data.itemId)
    const rec = gltfRecords.get(data.itemId)
    if (rec) cancelShrink(rec.containerEntity)  // stop an in-flight shrink before restoring
    setVisible(data.itemId, true)
    lastState.delete(data.itemId)
  })
}
