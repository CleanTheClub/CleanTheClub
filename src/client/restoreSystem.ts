// Restore-style scene interaction backed by 3 GLBs per prop:
//   dirty<Name>        — visible until the player clicks it
//   clean<Name>Anim    — plays the restore animation immediately on click
//   clean<Name>        — final restored state, visible once the anim completes
//
// A single init call handles all restore props via an array of RestoreDef configs.
// One discover system + one ClutterSync watcher covers every prop — no per-item systems.
//
// To add a new restore prop:
//   1. Place the 3 GLBs in Creator Hub with unique Name values
//   2. Add a sceneGlb:true entry to CLUTTER_DEFS in config.ts (with correct stinkPos)
//   3. Add a RestoreDef entry to the array in setup.ts

import {
  engine, Entity, Name,
  VisibilityComponent, Animator,
  pointerEventsSystem, PointerEvents, InputAction,
  Transform, timers,
} from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { ClutterSync, GameState } from '../shared/schemas'
import { room } from '../shared/messages'
import { setupClickProxy } from '../shared/sceneItemHelpers'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playSparkle } from './sparkleSystem'
import { showCleanedToast, showNarrativeToast } from '../ui'

// ── Public config type ───────────────────────────────────────────────────────
export type RestoreDef = {
  itemId:         string
  nameDirty:      string   // Name component value of the dirty GLB
  nameAnim:       string   // Name component value of the anim GLB
  nameClean:      string   // Name component value of the clean GLB
  animClip:       string   // Animation clip name inside the anim GLB
  animDurationMs: number   // Clip duration in ms — swap to clean GLB after this
  hoverText?:     string   // Prompt shown on hover (default: 'Clean')
}

// ── Per-item runtime state ───────────────────────────────────────────────────
type ItemState = {
  def:                  RestoreDef
  dirtyEnt:             Entity | undefined
  animEnt:              Entity | undefined
  cleanEnt:             Entity | undefined
  allFound:             boolean
  pendingClean:         boolean
  pendingAnimSwapTimer: number | undefined
  lastSyncCleaned:      boolean | null
}

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

// ── Visibility helpers ───────────────────────────────────────────────────────
function setVisible(entity: Entity | undefined, visible: boolean) {
  if (entity === undefined) return
  VisibilityComponent.createOrReplace(entity, { visible })
}

function showDirty(s: ItemState) {
  setVisible(s.dirtyEnt, true)
  setVisible(s.animEnt,  false)
  setVisible(s.cleanEnt, false)
  if (s.dirtyEnt !== undefined) enableClick(s)
}

function hideAnimEntity(s: ItemState) {
  if (s.animEnt === undefined) return
  // Reset the Animator back to a clean resting state before hiding.
  // Leaving the animation mid-frame can prevent VisibilityComponent from
  // fully clearing the render in some DCL contexts.
  Animator.createOrReplace(s.animEnt, {
    states: [{ clip: s.def.animClip, playing: false, loop: false }],
  })
  setVisible(s.animEnt, false)
}

function showAnimAndScheduleClean(s: ItemState) {
  setVisible(s.dirtyEnt, false)
  setVisible(s.animEnt,  true)
  setVisible(s.cleanEnt, false)
  if (s.animEnt !== undefined) Animator.playSingleAnimation(s.animEnt, s.def.animClip, true)

  if (s.pendingAnimSwapTimer !== undefined) timers.clearTimeout(s.pendingAnimSwapTimer)
  s.pendingAnimSwapTimer = timers.setTimeout(() => {
    s.pendingAnimSwapTimer = undefined
    hideAnimEntity(s)
    setVisible(s.cleanEnt, true)
    // Sparkle burst when the clean model appears
    const pos = s.dirtyEnt !== undefined ? Transform.getOrNull(s.dirtyEnt)?.position : undefined
    if (pos) playSparkle(pos)
  }, s.def.animDurationMs)
}

// spark=false suppresses the sparkle on initial scene load (item was already clean)
function showCleanInstant(s: ItemState, spark = true) {
  if (s.pendingAnimSwapTimer !== undefined) {
    timers.clearTimeout(s.pendingAnimSwapTimer)
    s.pendingAnimSwapTimer = undefined
  }
  // Defensive: ensure the (now-invisible) dirty mesh can never be clicked while clean.
  // Covers the join-race where discovery calls showDirty/enableClick and the ClutterSync
  // watcher corrects to clean in the same frame without otherwise removing the handler.
  // disableClick is a safe no-op when no handler is registered.
  disableClick(s)
  setVisible(s.dirtyEnt, false)
  hideAnimEntity(s)
  setVisible(s.cleanEnt, true)
  if (spark) {
    const pos = s.dirtyEnt !== undefined ? Transform.getOrNull(s.dirtyEnt)?.position : undefined
    if (pos) playSparkle(pos)
  }
}

// ── Click registration ───────────────────────────────────────────────────────
function enableClick(s: ItemState) {
  const entity    = s.dirtyEnt!
  const hoverText = s.def.hoverText ?? 'Clean'

  pointerEventsSystem.onPointerHoverEnter({ entity }, () => playHoverSound())
  pointerEventsSystem.onPointerDown(
    { entity, opts: { button: InputAction.IA_POINTER, hoverText } },
    () => {
      if (getPhase() === 'open') { maybeShowOpenPhaseToast(); return }
      if (s.pendingClean) return
      s.pendingClean = true
      disableClick(s)

      playClickSound()
      playCleanSound()
      const pos = Transform.getOrNull(entity)?.position
      if (pos) playSparkle(pos)
      showCleanedToast()

      showAnimAndScheduleClean(s)
      room.send('cleanItem', { itemId: s.def.itemId })
    },
  )
}

function disableClick(s: ItemState) {
  if (s.dirtyEnt === undefined) return
  pointerEventsSystem.removeOnPointerDown(s.dirtyEnt)
  pointerEventsSystem.removeOnPointerHoverEnter(s.dirtyEnt)
  PointerEvents.deleteFrom(s.dirtyEnt)
}

// ── Init ─────────────────────────────────────────────────────────────────────
export function initRestoreSystem(defs: RestoreDef[]): void {
  if (defs.length === 0) return

  // Build a Map of runtime state, one entry per def
  const states = new Map<string, ItemState>()
  for (const def of defs) {
    states.set(def.itemId, {
      def,
      dirtyEnt: undefined, animEnt: undefined, cleanEnt: undefined,
      allFound: false, pendingClean: false,
      pendingAnimSwapTimer: undefined, lastSyncCleaned: null,
    })
  }

  // On scene (re-)entry reset all pending state so the ClutterSync watcher
  // treats each prop as unseen and correctly re-shows dirty/clean on next tick.
  onEnterSceneObservable.add(() => {
    for (const s of states.values()) {
      s.pendingClean = false
      s.lastSyncCleaned = null
      if (s.pendingAnimSwapTimer !== undefined) {
        timers.clearTimeout(s.pendingAnimSwapTimer)
        s.pendingAnimSwapTimer = undefined
      }
    }
  })

  // ── One-shot discovery system — removed once all props are found ─────────────
  // Builds a reverse lookup: Name value → itemId + slot ('dirty'|'anim'|'clean')
  type Slot = 'dirty' | 'anim' | 'clean'
  const nameIndex = new Map<string, { itemId: string; slot: Slot }>()
  for (const def of defs) {
    nameIndex.set(def.nameDirty, { itemId: def.itemId, slot: 'dirty' })
    nameIndex.set(def.nameAnim,  { itemId: def.itemId, slot: 'anim'  })
    nameIndex.set(def.nameClean, { itemId: def.itemId, slot: 'clean' })
  }

  let remaining = defs.length   // items still waiting for all 3 GLBs
  const discoverStartMs = Date.now()

  const discoverSystem = () => {
    for (const [e] of engine.getEntitiesWith(Name)) {
      const n     = Name.get(e).value
      const entry = nameIndex.get(n)
      if (!entry) continue

      const s = states.get(entry.itemId)!
      if (entry.slot === 'dirty' && s.dirtyEnt === undefined) {
        s.dirtyEnt = e
        // Dirty starts visible — correct default, no change needed
      }
      if (entry.slot === 'anim' && s.animEnt === undefined) {
        s.animEnt = e
        setVisible(e, false)   // hide immediately — only shown during animation
      }
      if (entry.slot === 'clean' && s.cleanEnt === undefined) {
        s.cleanEnt = e
        setVisible(e, false)   // hide immediately — only shown once cleaned
      }

      if (!s.allFound && s.dirtyEnt !== undefined && s.animEnt !== undefined && s.cleanEnt !== undefined) {
        s.allFound = true
        remaining--
        console.log(`[Restore] "${s.def.itemId}" discovered — dirty=${s.dirtyEnt} anim=${s.animEnt} clean=${s.cleanEnt}`)

        // setupClickProxy enables CL_POINTER on the GLB's own meshes (clickable +
        // hover outline) and self-defers if the GltfContainer hasn't streamed in
        // yet, retrying until it has — so a slow-loading cushion is never left
        // permanently un-clickable (the round-1 sofa-cushion bug).
        setupClickProxy(s.dirtyEnt)
        Animator.createOrReplace(s.animEnt, {
          states: [{ clip: s.def.animClip, playing: false, loop: false }],
        })

        if (s.lastSyncCleaned === true) {
          showCleanInstant(s, false)  // no sparkle on load
        } else if (s.lastSyncCleaned === false || isStateSyncronized()) {
          // Either ClutterSync confirmed dirty, or CRDT is complete — safe to show dirty.
          showDirty(s)
        }
        // else: lastSyncCleaned=null AND CRDT not yet complete — do NOT show dirty or enable
        // clicks.  The ClutterSync watcher will call showDirty / showCleanInstant once the
        // authoritative isCleaned value arrives (it checks allFound=true so it will proceed).
      }
    }

    if (remaining === 0) {
      engine.removeSystem(discoverSystem)
    } else if (Date.now() - discoverStartMs > 10_000) {
      for (const [itemId, s] of states) {
        if (!s.allFound) {
          console.log(`[Restore] WARNING "${itemId}" not fully discovered after 10 s — dirty=${s.dirtyEnt} anim=${s.animEnt} clean=${s.cleanEnt}`)
        }
      }
      engine.removeSystem(discoverSystem)
    }
  }
  engine.addSystem(discoverSystem)

  // ── Authoritative ClutterSync watcher — one system covers all restore props ──
  engine.addSystem(() => {
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      const s     = states.get(state.itemId)
      if (!s) continue
      if (s.lastSyncCleaned === state.isCleaned) continue
      s.lastSyncCleaned = state.isCleaned
      if (!s.allFound) continue   // initial sync handled once discovery completes

      s.pendingClean = false
      if (state.isCleaned) {
        if (s.pendingAnimSwapTimer === undefined) showCleanInstant(s)
      } else {
        showDirty(s)
      }
    }
  })

  // ── cleanRejected — one handler covers all restore props ─────────────────────
  room.onMessage('cleanRejected', (data) => {
    const s = states.get(data.itemId)
    if (!s) return
    s.pendingClean = false
    if (s.pendingAnimSwapTimer !== undefined) {
      timers.clearTimeout(s.pendingAnimSwapTimer)
      s.pendingAnimSwapTimer = undefined
    }
    if (s.allFound) showDirty(s)
  })
}
