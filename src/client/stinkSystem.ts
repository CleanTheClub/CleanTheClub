// Stink particle system — green wafting particles above all dirty items.
// Pool-limited: at most MAX_STINK_EMITTERS emitter entities are created.
// Emitters live at independent world-space positions (NOT parented to scene
// entities) so they are unaffected when items are hidden via scale = zero.
//
// HISTORY (2026-08-03/04): briefly ported to billboarded mesh planes when
// particles vanished from a deployed build — but the Foundation confirmed the
// component works, a minimal diagnostic emitter rendered fine locally, and the
// mesh wisps rendered oversized/white next to the original. Restored to the
// original ParticleSystem implementation; the deployed disappearance remains
// unexplained (suspect: stale explorer build that day) — if it recurs, check a
// minimal emitter FIRST before blaming this config.

import {
  engine, Entity, Transform,
  ParticleSystem,
} from '@dcl/sdk/ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { CLUTTER_DEFS } from '../shared/config'
import { discoverGlasses, discoverBottles, discoverRubbish, discoverStickyPatches } from '../shared/glassDiscovery'
import { gameState } from './phaseGate'
import { onClutterPoll } from './clutterWatcher'

// ── Particle enum values ──────────────────────────────────────────────────────
// These are 'const enum' in @dcl/ecs internals — not re-exported from @dcl/sdk/ecs.
// Values are stable and documented in PBParticleSystem_BlendMode/PlaybackState.
// PBParticleSystem_BlendMode:     PSB_ALPHA = 0 | PSB_ADD = 1 | PSB_MULTIPLY = 2
// PBParticleSystem_PlaybackState: PS_PLAYING = 0 | PS_PAUSED = 1 | PS_STOPPED = 2
const PSB_ALPHA  = 0
const PS_PLAYING = 0
const PS_STOPPED = 2

// ── Pool config ───────────────────────────────────────────────────────────────
const MAX_STINK_EMITTERS = 100  // hard cap on emitter entities (scene currently has ~83 items)
const PARTICLES_PER_ITEM = 5   // maxParticles per emitter → ≤ 500 total
const STINK_Y_OFFSET     = 0.6 // metres above the item's Transform position

// ── Internal maps ─────────────────────────────────────────────────────────────
const emitterFor  = new Map<string, Entity>()
const lastCleaned = new Map<string, boolean>()

// ── Particle emitter factory ──────────────────────────────────────────────────
function createEmitter(pos: { x: number; y: number; z: number }): Entity {
  const e = engine.addEntity()

  Transform.create(e, {
    position: Vector3.create(pos.x, pos.y + STINK_Y_OFFSET, pos.z),
  })

  ParticleSystem.create(e, {
    shape: ParticleSystem.Shape.Cone({ angle: 30, radius: 0.15 }),

    // Emission
    rate:         2,
    maxParticles: PARTICLES_PER_ITEM,

    // Lifetime — single number (seconds), NOT a FloatRange
    lifetime: 2.5,

    // Motion — upward drift via negative gravity multiplier (−1 × −9.81 = +9.81 m/s²)
    // and a gentle constant upward force
    gravity:          -0.04,
    additionalForce:  Vector3.create(0, 0.15, 0),

    // Initial velocity magnitude (cone shape directs this upward)
    initialVelocitySpeed: { start: 0.2, end: 0.4 },

    // Size (2.5× scale for visibility)
    initialSize:  { start: 0.5,  end: 1.0  },
    sizeOverTime: { start: 0.88, end: 3.0  },

    // Colour: bright green → faded transparent green over lifetime
    initialColor: {
      start: Color4.create(0.3, 0.9, 0.05, 0.9),
      end:   Color4.create(0.5, 1.0, 0.2,  0.8),
    },
    colorOverTime: {
      start: Color4.create(0.2, 0.75, 0.05, 0.45),
      end:   Color4.create(0.1, 0.5,  0.05, 0.0),
    },

    texture:   { src: 'assets/scene/Particles/stink_waft.png' },
    billboard: true,
    blendMode: PSB_ALPHA,
    loop:         true,
    prewarm:      true,
    active:       true,
    playbackState: PS_PLAYING,
  })

  return e
}

// ── Emitter state helpers ─────────────────────────────────────────────────────
// PS_STOPPED should clear existing particles per the docs, but the current
// explorer keeps rendering them (field report: stink persisted after pickup).
// So pausing ALSO drops the emitter 500m underground — particles simulate in
// emitter-local space (PSS_LOCAL default), so they vanish with it, whatever
// the playback state does. The paused-set keeps the shift idempotent: party
// mode blanket-pauses every emitter, including ones already paused by cleans,
// and without the guard those would sink twice and resume misplaced.
const PAUSE_SINK_M = 500
const pausedEmitters = new Set<Entity>()

function pauseEmitter(e: Entity) {
  if (pausedEmitters.has(e)) return
  pausedEmitters.add(e)
  const ps = ParticleSystem.getMutableOrNull(e)
  if (ps) {
    ps.active        = false
    ps.playbackState = PS_STOPPED
  }
  const tf = Transform.getMutableOrNull(e)
  if (tf) tf.position = { ...tf.position, y: tf.position.y - PAUSE_SINK_M }
}

function resumeEmitter(e: Entity) {
  if (!pausedEmitters.has(e)) return
  pausedEmitters.delete(e)
  const ps = ParticleSystem.getMutableOrNull(e)
  if (ps) {
    ps.active        = true
    ps.playbackState = PS_PLAYING
  }
  const tf = Transform.getMutableOrNull(e)
  if (tf) tf.position = { ...tf.position, y: tf.position.y + PAUSE_SINK_M }
}

// ── Public registration — for sceneGlb items whose position is discovered at runtime ──
// Call once after the scene entity's Transform is available (e.g. after GLB discovery).
// Safe to call before or after initStinkSystem — the per-frame watcher picks it up automatically.
export function registerStinkEmitter(itemId: string, pos: { x: number; y: number; z: number }) {
  if (emitterFor.has(itemId)) return   // already registered
  if (emitterFor.size >= MAX_STINK_EMITTERS) {
    console.log(`[STINK] Pool full — cannot register emitter for "${itemId}"`)
    return
  }
  const emitter = createEmitter(pos)
  emitterFor.set(itemId, emitter)
  // Respect current clean state if already known
  const cleaned = lastCleaned.get(itemId)
  if (cleaned === true) pauseEmitter(emitter)
  console.log(`[STINK] Registered scene GLB emitter for "${itemId}"`)
}

// ── Public init ───────────────────────────────────────────────────────────────
export function initStinkSystem() {
  // On scene (re-)entry clear lastCleaned so the per-frame watcher re-evaluates
  // every item's clean state on the next tick.  Without this, brief leaves and
  // re-entries leave lastCleaned stale: items that were cleaned before leaving
  // never get their emitters re-paused (or re-resumed) when state changes while
  // the player is away.
  onEnterSceneObservable.add(() => {
    lastCleaned.clear()
    console.log('[STINK] onEnterSceneObservable — lastCleaned cleared')
  })

  let allocated = 0

  function tryAllocate(itemId: string, pos: { x: number; y: number; z: number }) {
    if (allocated >= MAX_STINK_EMITTERS) return
    emitterFor.set(itemId, createEmitter(pos))
    allocated++
  }

  // CLUTTER_DEFS — positions come from config.
  // sceneGlb items use the world-space position stored in def.position directly —
  // their GLB origin may be at local (0,0,0) but the correct world coords are in config.
  for (const def of CLUTTER_DEFS) {
    tryAllocate(def.id, def.stinkPos ?? def.position)
  }

  // Scene-placed groups — read world Transform at init time
  for (const { entity, itemId } of [...discoverGlasses(), ...discoverBottles(), ...discoverRubbish(), ...discoverStickyPatches()]) {
    const pos = Transform.getOrNull(entity)?.position
    if (pos) {
      tryAllocate(itemId, pos)
    } else {
      console.log(`[STINK] No Transform for ${itemId} at init — skipping`)
    }
  }

  console.log(`[STINK] Allocated ${allocated} emitters (pool cap: ${MAX_STINK_EMITTERS})`)

  // Per-frame watcher — mirrors isCleaned state → emitter on/off.
  // Skips updates during party mode (phase = 'open') — stink is frozen then.
  let partyMode = false

  onClutterPoll((entries) => {
    for (const { itemId, isCleaned } of entries) {
      if (lastCleaned.get(itemId) === isCleaned) continue
      lastCleaned.set(itemId, isCleaned)

      if (partyMode) continue   // don't toggle emitters during open phase

      const emitter = emitterFor.get(itemId)
      if (!emitter) continue

      if (isCleaned) {
        pauseEmitter(emitter)
      } else {
        resumeEmitter(emitter)
      }
    }
  })

  // Phase watcher — freeze all stink during party mode, resume on new round.
  let lastPhase = ''
  engine.addSystem(() => {
    const gs = gameState()
    if (!gs || gs.phase === lastPhase) return
    const prev = lastPhase
    lastPhase  = gs.phase
    partyMode  = gs.phase === 'open'

    if (gs.phase === 'open') {
      // Party mode — pause every emitter regardless of clean state
      for (const emitter of emitterFor.values()) pauseEmitter(emitter)
      console.log('[STINK] Party mode — all emitters paused')
    } else if (prev === 'open') {
      // New round started — ClutterSync changes that arrived during party mode
      // were skipped by the watcher (partyMode guard), so lastCleaned can be
      // stale. Clear it entirely and resume every emitter; the watcher will
      // re-pause any that are genuinely still cleaned on its first tick.
      lastCleaned.clear()
      for (const emitter of emitterFor.values()) resumeEmitter(emitter)
      console.log('[STINK] Round started — all emitters resumed')
    }
  })
}
