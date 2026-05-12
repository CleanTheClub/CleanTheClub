// Stink particle system — green wafting particles above all dirty items.
// Pool-limited: at most MAX_STINK_EMITTERS emitter entities are created.
// Emitters live at independent world-space positions (NOT parented to scene
// entities) so they are unaffected when items are hidden via scale = zero.

import {
  engine, Entity, Transform,
  ParticleSystem,
} from '@dcl/sdk/ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { ClutterSync } from '../shared/schemas'
import { CLUTTER_DEFS } from '../shared/config'
import { discoverGlasses, discoverBottles, discoverRubbish } from '../shared/glassDiscovery'

// ── Particle enum values ──────────────────────────────────────────────────────
// These are 'const enum' in @dcl/ecs internals — not re-exported from @dcl/sdk/ecs.
// Values are stable and documented in PBParticleSystem_BlendMode/PlaybackState.
// PBParticleSystem_BlendMode:     PSB_ALPHA = 0 | PSB_ADD = 1 | PSB_MULTIPLY = 2
// PBParticleSystem_PlaybackState: PS_PLAYING = 0 | PS_PAUSED = 1 | PS_STOPPED = 2
const PSB_ALPHA  = 0
const PS_PLAYING = 0
const PS_STOPPED = 2

// ── Pool config ───────────────────────────────────────────────────────────────
const MAX_STINK_EMITTERS = 50   // hard cap on emitter entities
const PARTICLES_PER_ITEM = 5   // maxParticles per emitter → ≤ 250 total
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
function pauseEmitter(e: Entity) {
  const ps = ParticleSystem.getMutableOrNull(e)
  if (!ps) return
  ps.active        = false
  ps.playbackState = PS_STOPPED
}

function resumeEmitter(e: Entity) {
  const ps = ParticleSystem.getMutableOrNull(e)
  if (!ps) return
  ps.active        = true
  ps.playbackState = PS_PLAYING
}

// ── Public init ───────────────────────────────────────────────────────────────
export function initStinkSystem() {
  let allocated = 0

  function tryAllocate(itemId: string, pos: { x: number; y: number; z: number }) {
    if (allocated >= MAX_STINK_EMITTERS) return
    emitterFor.set(itemId, createEmitter(pos))
    allocated++
  }

  // CLUTTER_DEFS — positions come from config (same coords used by cleaningSystem)
  for (const def of CLUTTER_DEFS) {
    tryAllocate(def.id, def.position)
  }

  // Scene-placed groups — read world Transform at init time
  for (const { entity, itemId } of [...discoverGlasses(), ...discoverBottles(), ...discoverRubbish()]) {
    const pos = Transform.getOrNull(entity)?.position
    if (pos) {
      tryAllocate(itemId, pos)
    } else {
      console.log(`[STINK] No Transform for ${itemId} at init — skipping`)
    }
  }

  console.log(`[STINK] Allocated ${allocated} emitters (pool cap: ${MAX_STINK_EMITTERS})`)

  // Per-frame watcher — mirrors isCleaned state → emitter on/off
  engine.addSystem(() => {
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      const { itemId, isCleaned } = state

      if (lastCleaned.get(itemId) === isCleaned) continue
      lastCleaned.set(itemId, isCleaned)

      const emitter = emitterFor.get(itemId)
      if (!emitter) continue

      if (isCleaned) {
        pauseEmitter(emitter)
      } else {
        resumeEmitter(emitter)
      }
    }
  })
}
