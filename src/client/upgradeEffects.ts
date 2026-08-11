// Applies purchased upgrades to actual gameplay.
//
// The server owns the LEVELS; this module owns their EFFECTS. Everything here is
// derived from progressionStore, which is itself a read-only mirror of the server,
// so a client cannot grant itself a faster mop by editing local state — it would
// only desync from the server's own copy, which is what actually gates purchases.
//
// Effects are re-applied whenever the level changes rather than every frame: these
// are set-and-forget component writes, not per-tick work.

import { engine, AvatarLocomotionSettings } from '@dcl/sdk/ecs'
import { HOLD_DURATION_MS } from '../shared/config'
import { upgradeValue } from '../shared/progression'
import { upgradeLevel } from './progressionStore'

// Decentraland's default avatar locomotion, in metres per second. Upgrade levels are
// multipliers on these rather than absolute speeds, so if the platform ever retunes
// its defaults the upgrade stays proportional instead of silently becoming a nerf.
//
// Locomotion settings only apply while the player is inside the scene's bounds, so
// leaving the club restores normal movement automatically — no cleanup needed.
const DEFAULT_WALK = 1.5
const DEFAULT_JOG  = 8
const DEFAULT_RUN  = 10

let appliedSpeedLevel = -1

function applyMovementSpeed(): void {
  const level = upgradeLevel('movementSpeed')
  if (level === appliedSpeedLevel) return
  appliedSpeedLevel = level

  const mult = upgradeValue('movementSpeed', level)
  AvatarLocomotionSettings.createOrReplace(engine.PlayerEntity, {
    walkSpeed: DEFAULT_WALK * mult,
    jogSpeed:  DEFAULT_JOG  * mult,
    runSpeed:  DEFAULT_RUN  * mult,
  })
  console.log(`[UPGRADE] movement speed ×${mult.toFixed(2)} (level ${level})`)
}

/**
 * Hold-to-clean duration after the Mopping Speed upgrade, in ms.
 *
 * Read through this rather than importing HOLD_DURATION_MS directly, so every
 * consumer (progress bar, completion check, mopping emote) stays in lockstep — a
 * bar that fills at a different rate than the clean completes would feel broken.
 */
export function holdDurationMs(): number {
  return Math.round(HOLD_DURATION_MS * upgradeValue('moppingSpeed', upgradeLevel('moppingSpeed')))
}

/**
 * Restore movement to the player's UPGRADED baseline, not engine defaults.
 *
 * The sticky hazard slows the player by replacing AvatarLocomotionSettings, so
 * its restore path must come back through here. Deleting the component instead
 * would silently strip a purchased Movement Speed upgrade for the rest of the
 * session, because applyMovementSpeed only re-writes when the LEVEL changes.
 * This module is the single owner of that component.
 */
export function reapplyMovementSpeed(): void {
  appliedSpeedLevel = -1
  applyMovementSpeed()
}

export function initUpgradeEffects(): void {
  // Levels only change on purchase or on the join sync, so polling slowly is ample
  // and avoids a per-frame component write.
  let acc = 0
  engine.addSystem((dt: number) => {
    acc += dt
    if (acc < 0.5) return
    acc = 0
    applyMovementSpeed()
  })
}
