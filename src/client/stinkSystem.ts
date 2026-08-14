// Stink particle system — green wafting particles above all dirty items.
// Pool-limited: at most MAX_STINK_EMITTERS emitter entities are created.
// Emitters live at independent world-space positions (NOT parented to scene
// entities) so they are unaffected when items are hidden via scale = zero.
//
// If particles ever vanish in a DEPLOYED build again (2026-08-03 incident):
// test a minimal diagnostic emitter FIRST before blaming this config — last
// time it was a stale explorer build, not the ParticleSystem.

import {
  engine, Entity, Transform,
  ParticleSystem,
} from '@dcl/sdk/ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { onLocalEnterScene } from './localPlayer'
import { CLUTTER_DEFS } from '../shared/config'
import { discoverGlasses, discoverBottles, discoverRubbish, discoverStickyPatches } from '../shared/glassDiscovery'
import { gameState } from './phaseGate'
import { onClutterPoll, clutterEntry } from './clutterWatcher'

import { PSB_ALPHA, PS_PLAYING, PS_STOPPED } from './particleEnums'

// ── Pool config ───────────────────────────────────────────────────────────────
// The cap bounds CONCURRENTLY-DIRTY items, not items overall: emitters recycle
// (cleaned item → freed → reassigned to a still-dirty one). The old design
// allocated once at init, first-come-for-life — with 98 scene items plus the
// restore props the pool was exhausted before themed extras could ever join,
// which is why paparazzi-night spawns had no stink (playtest, mobile). At round
// start more than 100 items can be dirty at once; the tail goes stinkless
// briefly and picks up emitters as cleaning frees them.
const MAX_STINK_EMITTERS = 100  // hard cap on emitter ENTITIES (recycled)
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


// ── Public init ───────────────────────────────────────────────────────────────
export function initStinkSystem() {
  // On scene (re-)entry clear lastCleaned so the per-frame watcher re-evaluates
  // every item's clean state on the next tick.  Without this, brief leaves and
  // re-entries leave lastCleaned stale: items that were cleaned before leaving
  // never get their emitters re-paused (or re-resumed) when state changes while
  // the player is away.
  onLocalEnterScene(() => {
    lastCleaned.clear()
    console.log('[STINK] re-entered — lastCleaned cleared')
  })

  // Authored world positions for scene items — their ClutterSync entities are
  // logical (no Transform), so positions are captured here once.
  // CLUTTER_DEFS positions come from config (GLB origins may be local 0,0,0).
  const itemPosFor = new Map<string, { x: number; y: number; z: number }>()
  for (const def of CLUTTER_DEFS) {
    itemPosFor.set(def.id, def.stinkPos ?? def.position)
  }
  for (const { entity, itemId } of [...discoverGlasses(), ...discoverBottles(), ...discoverRubbish(), ...discoverStickyPatches()]) {
    const pos = Transform.getOrNull(entity)?.position
    if (pos) itemPosFor.set(itemId, pos)
    else console.log(`[STINK] No Transform for ${itemId} at init — skipping`)
  }

  // Recyclable pool: freed emitters (paused + sunk) queue here for reuse.
  const freeEmitters: Entity[] = []
  let created = 0
  let starvedLogged = false

  function acquireEmitter(pos: { x: number; y: number; z: number }): Entity | null {
    const recycled = freeEmitters.pop()
    if (recycled) {
      resumeEmitter(recycled)
      const tf = Transform.getMutableOrNull(recycled)
      if (tf) tf.position = Vector3.create(pos.x, pos.y + STINK_Y_OFFSET, pos.z)
      return recycled
    }
    if (created >= MAX_STINK_EMITTERS) {
      if (!starvedLogged) {
        starvedLogged = true
        console.log(`[STINK] pool cap ${MAX_STINK_EMITTERS} hit — tail items go stinkless until cleans free emitters`)
      }
      return null
    }
    created++
    return createEmitter(pos)
  }

  function releaseEmitter(itemId: string): void {
    const e = emitterFor.get(itemId)
    if (!e) return
    emitterFor.delete(itemId)
    pauseEmitter(e)
    freeEmitters.push(e)
  }

  // Poll watcher. Transitions maintain needStink (the set of currently-dirty
  // items); a separate assignment sweep then matches that set against the pool
  // EVERY poll, not just on the transition — an item starved at round start
  // must pick up an emitter later when a clean frees one, and a dynamic item
  // (theme_*/dis_*) must get one once its server-written Transform arrives /
  // unparks from the locked ~0.001 scale. Assigning only on the isCleaned edge
  // made both starvations permanent (review finding).
  // Skips pool work during party mode (phase = 'open') — stink is frozen then.
  const needStink = new Set<string>()
  let partyMode = false

  onClutterPoll((entries) => {
    for (const { itemId, isCleaned } of entries) {
      if (lastCleaned.get(itemId) === isCleaned) continue
      lastCleaned.set(itemId, isCleaned)
      if (isCleaned) {
        needStink.delete(itemId)
        if (!partyMode) releaseEmitter(itemId)
      } else {
        needStink.add(itemId)
      }
    }

    if (partyMode) return

    // Assignment sweep — cheap (≤ ~130 set entries, most already assigned).
    for (const itemId of needStink) {
      if (emitterFor.has(itemId)) continue
      if (freeEmitters.length === 0 && created >= MAX_STINK_EMITTERS) break
      let pos = itemPosFor.get(itemId)
      if (!pos) {
        // Dynamic item: position lives on its sync entity. The scale gate
        // skips stages the server parks at ~0.001 (locked disaster stain) —
        // stink over an invisible spot reads as a bug. Re-checked every sweep,
        // so it gets its emitter the moment the server unparks it.
        const entry = clutterEntry(itemId)
        const t = entry ? Transform.getOrNull(entry.entity) : null
        if (!t || t.scale.x < 0.01) continue
        pos = t.position
      }
      const e = acquireEmitter(pos)
      if (e) emitterFor.set(itemId, e)
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
      // stale. Release every assignment and clear the cache; the watcher's next
      // tick re-acquires emitters for exactly the items that are dirty NOW
      // (including this round's fresh theme spawns).
      lastCleaned.clear()
      for (const itemId of [...emitterFor.keys()]) releaseEmitter(itemId)
      console.log('[STINK] Round started — pool released for reassignment')
    }
  })
}
