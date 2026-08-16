import { engine, Entity, Transform, EasingFunction } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { tweenValue } from './tween'

// ─── Shrink-and-hide ────────────────────────────────────────────────────────────
// Animates an item's scale from its CURRENT value down to ~0 over `durationS`.
// This replaces the old "wait N ms then snap-hide" pattern, which in first person
// read as lag because nothing moved until the item vanished.  The item now reacts
// on the very first frame.
//
// We use EF_EASEOUTCUBIC (monotonic, fast start) rather than an anticipation curve:
// an overshoot/back curve briefly scales the item ABOVE its real size, which on a
// dense pile (rubbish) balloons it into its neighbours and reads as a flickering
// duplicate.  EF_EASEOUTCUBIC shrinks promptly without ever growing.
//
// onComplete fires once at the end — callers use it for the sparkle + bookkeeping.
// The entity is left at a hidden (near-zero) scale.  Re-calling on the same entity
// cancels the previous shrink; cancelShrink aborts without firing onComplete.

const HIDDEN_SCALE = 0.001
const active = new Map<Entity, (dt: number) => void>()

export function shrinkAndHide(
  entity: Entity,
  durationS: number,
  onComplete?: () => void,
  easing: EasingFunction = EasingFunction.EF_EASEOUTCUBIC,
): void {
  cancelShrink(entity)

  const t = Transform.getOrNull(entity)
  if (!t) {
    onComplete?.()
    return
  }
  const from = { x: t.scale.x, y: t.scale.y, z: t.scale.z }

  const sys = tweenValue(
    1,
    0,
    durationS,
    (k) => {
      const tr = Transform.getMutableOrNull(entity)
      if (tr) tr.scale = { x: from.x * k, y: from.y * k, z: from.z * k }
    },
    () => {
      active.delete(entity)
      const tr = Transform.getMutableOrNull(entity)
      if (tr) tr.scale = { x: HIDDEN_SCALE, y: HIDDEN_SCALE, z: HIDDEN_SCALE }
      onComplete?.()
    },
    easing,
  )
  active.set(entity, sys)
}

// Stops an in-flight shrink (e.g. when the server rejects the clean). Does NOT
// restore scale — the caller decides whether to restore the item to full size.
// DOES restore a suck's original position, or a rejected vacuum clean would
// leave the item standing wherever the tween had dragged it.
export function cancelShrink(entity: Entity): void {
  const sys = active.get(entity)
  if (sys) {
    engine.removeSystem(sys)
    active.delete(entity)
  }
  restoreSuckOrigin(entity)
}

// ─── Suck-to-player (vacuum pickup) ────────────────────────────────────────────
// The vacuum doesn't pluck items — it INHALES them: the item lifts off with a
// spin, then accelerates into the nozzle while shrinking, like dust caught in
// the airstream (feedback 2026-08-15: the straight-line version wanted "más
// gracia" — the arc + spin are what read as being CAUGHT rather than dragged).
//
// The item's ORIGINAL position AND rotation are captured and restored the
// moment it finishes (it's invisible by then) — these composite entities are
// reused for respawns, and an item that respawned wherever the player had been
// standing (or mid-spin) would be a far worse bug than any visual polish.
// Same restore on cancel (rejected clean).
const SUCK_ARC_M    = 0.35   // peak lift of the flight arc, metres
const SUCK_SPIN_DEG = 540    // total yaw while in flight
const suckOrigins = new Map<Entity, {
  pos: { x: number; y: number; z: number }
  rot: Quaternion
}>()

function restoreSuckOrigin(entity: Entity): void {
  const orig = suckOrigins.get(entity)
  if (!orig) return
  suckOrigins.delete(entity)
  const tr = Transform.getMutableOrNull(entity)
  if (tr) {
    tr.position = { x: orig.pos.x, y: orig.pos.y, z: orig.pos.z }
    tr.rotation = orig.rot
  }
}

export function suckAndHide(
  entity: Entity,
  durationS: number,
  onComplete?: () => void,
): void {
  cancelShrink(entity)

  const t = Transform.getOrNull(entity)
  if (!t) { onComplete?.(); return }
  const from      = { x: t.scale.x, y: t.scale.y, z: t.scale.z }
  const start     = { x: t.position.x, y: t.position.y, z: t.position.z }
  const startRot  = Quaternion.create(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w)
  suckOrigins.set(entity, { pos: start, rot: startRot })

  const sys = tweenValue(
    0,
    1,
    durationS,
    (k) => {
      const tr = Transform.getMutableOrNull(entity)
      if (!tr) return
      // Chase the player's LIVE position — they keep moving mid-suck.
      const p = Transform.getOrNull(engine.PlayerEntity)?.position ?? start
      const target = { x: p.x, y: p.y + 0.6, z: p.z }   // roughly nozzle height
      // sin(kπ) arc on top of the straight-line lerp: up and over into the
      // nozzle. With the eased k the peak lands late in the flight, so the item
      // visibly lifts off before it dives — the "caught by the airstream" beat.
      const lift = Math.sin(k * Math.PI) * SUCK_ARC_M
      tr.position = {
        x: start.x + (target.x - start.x) * k,
        y: start.y + (target.y - start.y) * k + lift,
        z: start.z + (target.z - start.z) * k,
      }
      // Accelerating yaw sells the swirl; restored with the origin on finish.
      tr.rotation = Quaternion.multiply(
        startRot,
        Quaternion.fromEulerDegrees(0, k * SUCK_SPIN_DEG, 0),
      )
      const s = 1 - k
      tr.scale = { x: from.x * s, y: from.y * s, z: from.z * s }
    },
    () => {
      active.delete(entity)
      const tr = Transform.getMutableOrNull(entity)
      if (tr) tr.scale = { x: HIDDEN_SCALE, y: HIDDEN_SCALE, z: HIDDEN_SCALE }
      restoreSuckOrigin(entity)   // invisible now — put it back for the respawn
      onComplete?.()
    },
    // Ease-IN: starts slow, accelerates into the nozzle — reads as suction.
    EasingFunction.EF_EASEINCUBIC,
  )
  active.set(entity, sys)
}

// ─── Pop-in ─────────────────────────────────────────────────────────────────────
// Springy "appear" — scales an entity from ~0 up to `toScale` with EF_EASEOUTBACK
// (a small overshoot before settling) so items pop into the club satisfyingly when
// the round starts.  Used by spawnDirector to stagger item spawn-in.  Cancels any
// in-flight shrink/pop on the same entity first; onComplete fires once it settles.
export function popIn(
  entity: Entity,
  toScale: { x: number; y: number; z: number },
  durationS: number,
  onComplete?: () => void,
  easing: EasingFunction = EasingFunction.EF_EASEOUTBACK,
): void {
  cancelShrink(entity)

  const tr0 = Transform.getMutableOrNull(entity)
  if (!tr0) {
    onComplete?.()
    return
  }
  tr0.scale = { x: 0.001, y: 0.001, z: 0.001 }  // start hidden so the pop reads cleanly

  const sys = tweenValue(
    0,
    1,
    durationS,
    (k) => {
      const tr = Transform.getMutableOrNull(entity)
      if (tr) tr.scale = { x: toScale.x * k, y: toScale.y * k, z: toScale.z * k }
    },
    () => {
      active.delete(entity)
      const tr = Transform.getMutableOrNull(entity)
      if (tr) tr.scale = { x: toScale.x, y: toScale.y, z: toScale.z }
      onComplete?.()
    },
    easing,
  )
  active.set(entity, sys)
}
