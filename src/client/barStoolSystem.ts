// Restore-style scene interaction backed by 3 GLBs:
//   dirtyBarStool        — visible until the player clicks it
//   cleanBarStoolAnim    — plays the restore animation immediately on click
//   cleanBarStool        — final restored state, visible once the anim completes
//
// Server side: identical to the existing `test_reset` ClutterDef (sceneGlb: true).
// The server tracks isCleaned + respawns on the same timer as other reset items;
// this client just listens to ClutterSync('test_reset') and drives GLB visibility.

import {
  engine, Entity, Name,
  VisibilityComponent, Animator,
  pointerEventsSystem, PointerEvents, InputAction,
  Transform, timers,
} from '@dcl/sdk/ecs'
import { ClutterSync } from '../shared/schemas'
import { room } from '../shared/messages'
import { setupClickProxy } from '../shared/sceneItemHelpers'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playSparkle } from './sparkleSystem'
import { showCleanedToast } from '../ui'
import { registerStinkEmitter } from './stinkSystem'

// ── Config ──────────────────────────────────────────────────────────────────
const ITEM_ID = 'test_reset'

const NAME_DIRTY = 'dirtyBarStool'
const NAME_ANIM  = 'cleanBarStoolAnim'
const NAME_CLEAN = 'cleanBarStool'

// Name of the animation clip inside cleanBarStoolAnim.glb. If the GLB was
// authored in Blender, this is usually 'Action' or whatever the NLA strip was
// named. Update here if your clip is named differently — Animator will silently
// no-op if the name doesn't match.
const ANIM_CLIP = 'restore'

// How long the restore animation plays before the final clean GLB takes over.
// Tune to match the actual clip length.
const ANIM_DURATION_MS = 2000

const HOVER_TEXT = 'Clean'

// ── State ───────────────────────────────────────────────────────────────────
let dirtyEnt: Entity | undefined
let animEnt:  Entity | undefined
let cleanEnt: Entity | undefined

let pendingClean        = false   // optimistic: click sent, awaiting server ack
let pendingAnimSwapTimer: number | undefined
let lastSyncCleaned: boolean | null = null

// ── Visibility helpers ──────────────────────────────────────────────────────
function setVisible(entity: Entity | undefined, visible: boolean) {
  if (entity === undefined) return
  VisibilityComponent.createOrReplace(entity, { visible })
}

function showDirty() {
  setVisible(dirtyEnt, true)
  setVisible(animEnt,  false)
  setVisible(cleanEnt, false)
  if (dirtyEnt !== undefined) enableClick(dirtyEnt)
}

function showAnimAndScheduleClean() {
  setVisible(dirtyEnt, false)
  setVisible(animEnt,  true)
  setVisible(cleanEnt, false)
  if (animEnt !== undefined) Animator.playSingleAnimation(animEnt, ANIM_CLIP, true)

  if (pendingAnimSwapTimer !== undefined) timers.clearTimeout(pendingAnimSwapTimer)
  pendingAnimSwapTimer = timers.setTimeout(() => {
    pendingAnimSwapTimer = undefined
    setVisible(animEnt,  false)
    setVisible(cleanEnt, true)
  }, ANIM_DURATION_MS)
}

function showCleanInstant() {
  if (pendingAnimSwapTimer !== undefined) {
    timers.clearTimeout(pendingAnimSwapTimer)
    pendingAnimSwapTimer = undefined
  }
  setVisible(dirtyEnt, false)
  setVisible(animEnt,  false)
  setVisible(cleanEnt, true)
}

// ── Click registration ──────────────────────────────────────────────────────
function enableClick(entity: Entity) {
  pointerEventsSystem.onPointerHoverEnter({ entity }, () => playHoverSound())
  pointerEventsSystem.onPointerDown(
    { entity, opts: { button: InputAction.IA_POINTER, hoverText: HOVER_TEXT } },
    () => {
      if (pendingClean) return
      pendingClean = true
      disableClick(entity)

      playClickSound()
      playCleanSound()
      // Intentionally no playPickupEmote — restore-type items don't move or rotate the player
      const pos = Transform.getOrNull(entity)?.position
      if (pos) playSparkle(pos)
      showCleanedToast()

      // Optimistic visual: swap to anim immediately, send the request, swap to clean after anim
      showAnimAndScheduleClean()
      room.send('cleanItem', { itemId: ITEM_ID })
    },
  )
}

function disableClick(entity: Entity) {
  pointerEventsSystem.removeOnPointerDown(entity)
  pointerEventsSystem.removeOnPointerHoverEnter(entity)
  PointerEvents.deleteFrom(entity)
}

// ── Init ────────────────────────────────────────────────────────────────────
export function initBarStoolSystem(): void {
  // One-shot scene discovery — three GLBs, found by Name component
  let allFound = false
  const discoverSystem = () => {
    if (allFound) return
    if (dirtyEnt === undefined || animEnt === undefined || cleanEnt === undefined) {
      for (const [e] of engine.getEntitiesWith(Name)) {
        const n = Name.get(e).value
        if (dirtyEnt === undefined && n === NAME_DIRTY) dirtyEnt = e
        else if (animEnt  === undefined && n === NAME_ANIM)  animEnt  = e
        else if (cleanEnt === undefined && n === NAME_CLEAN) cleanEnt = e
      }
    }
    if (dirtyEnt === undefined || animEnt === undefined || cleanEnt === undefined) return

    allFound = true
    console.log(`[BarStool] discovered  dirty=${dirtyEnt}  anim=${animEnt}  clean=${cleanEnt}`)

    // Register stink emitter at the dirty GLB's actual world position
    const dirtyPos = Transform.getOrNull(dirtyEnt)?.position
    if (dirtyPos) registerStinkEmitter(ITEM_ID, dirtyPos)

    // Click target: dirty GLB. setupClickProxy guarantees a reliable raycast hit
    // and asserts CL_POINTER on the visible mesh layer.
    setupClickProxy(dirtyEnt)

    // Animator on the anim GLB — one non-looping clip we trigger on each restore.
    Animator.createOrReplace(animEnt, {
      states: [{ clip: ANIM_CLIP, playing: false, loop: false }],
    })

    // Initial visibility derived from current server state (default: dirty visible)
    if (lastSyncCleaned === true) showCleanInstant()
    else                          showDirty()

    engine.removeSystem(discoverSystem)
  }
  engine.addSystem(discoverSystem)

  // Authoritative ClutterSync watcher — handles round resets and any
  // confirmation that arrives without an optimistic local swap (e.g. on join).
  engine.addSystem(() => {
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      if (state.itemId !== ITEM_ID) continue
      if (lastSyncCleaned === state.isCleaned) return
      lastSyncCleaned = state.isCleaned
      if (!allFound) return                // visuals not ready yet; initial sync handled in discover

      pendingClean = false
      if (state.isCleaned) {
        // If we already kicked off the animation locally, let it finish into clean.
        // Otherwise (joined late, another client cleaned it), jump straight to clean.
        if (pendingAnimSwapTimer === undefined) showCleanInstant()
      } else {
        // Respawn — back to dirty for the new round/cycle
        showDirty()
      }
      return
    }
  })

  room.onMessage('cleanRejected', (data) => {
    if (data.itemId !== ITEM_ID) return
    pendingClean = false
    // Cancel any in-flight anim → clean swap and put dirty back
    if (pendingAnimSwapTimer !== undefined) {
      timers.clearTimeout(pendingAnimSwapTimer)
      pendingAnimSwapTimer = undefined
    }
    if (allFound) showDirty()
  })
}
