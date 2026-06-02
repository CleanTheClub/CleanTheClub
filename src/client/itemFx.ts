import { engine, Entity, Transform, EasingFunction } from '@dcl/sdk/ecs'
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
export function cancelShrink(entity: Entity): void {
  const sys = active.get(entity)
  if (sys) {
    engine.removeSystem(sys)
    active.delete(entity)
  }
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
