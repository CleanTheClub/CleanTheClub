// Sticky patch hazard — slows the player to a crawl when they walk over an
// uncleaned sticky patch, then restores normal speed after SLOW_DURATION_MS.
//
// Uses AvatarLocomotionSettings on engine.PlayerEntity (local-only, no sync).
// The squelch sound fires once on contact. Effect clears automatically on
// round end so the player is never left permanently slow.

import { engine, Transform, AvatarLocomotionSettings, timers } from '@dcl/sdk/ecs'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { GameState } from '../shared/schemas'
import { discoverStickyPatches } from '../shared/glassDiscovery'
import { playSquelchSound } from './soundManager'

// ── Config ────────────────────────────────────────────────────
const SLOW_DURATION_MS = 4_000   // how long the player stays slowed
const DETECT_RADIUS    = 0.9     // XZ contact distance in metres
const EXIT_RADIUS      = 1.2     // must move this far away before patch can re-trigger
const MAX_Y_DIFF       = 2.0     // max vertical distance — prevents upper-floor false positives

// Slowed speeds — defaults: jog=8, walk=1.5, run=10
const SLOW_JOG_SPEED  = 0.4
const SLOW_WALK_SPEED = 0.2
const SLOW_RUN_SPEED  = 0.4
// ─────────────────────────────────────────────────────────────

export function initStickyHazardSystem(): void {
  const patches = discoverStickyPatches()

  // ⚠️  Position assumption: sticky patch Transforms are in LOCAL space relative
  // to the 'StickyPatches' parent entity. We compare them directly against the
  // player's WORLD position. This is only correct while the parent sits at world
  // origin (0,0,0) with no rotation or scale — which is standard for Creator Hub
  // group containers. If the parent is ever repositioned in Creator Hub, detection
  // will silently break. The startup check below logs a warning if that happens.
  if (patches.length > 0) {
    const parentId = Transform.getOrNull(patches[0].entity)?.parent
    if (parentId) {
      const parentTf = Transform.getOrNull(parentId)
      if (parentTf) {
        const p = parentTf.position
        if (Math.abs(p.x) > 0.01 || Math.abs(p.y) > 0.01 || Math.abs(p.z) > 0.01) {
          console.log(`[StickyHazard] WARNING: StickyPatches parent is not at world origin (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) — position detection will be incorrect!`)
        }
      }
    }
  }

  let isSlowed = false
  const occupiedPatches = new Set<string>()  // patches the player hasn't left yet

  function restoreSpeed(): void {
    isSlowed = false
    AvatarLocomotionSettings.deleteFrom(engine.PlayerEntity)
  }

  // On scene re-entry the slow timer may have been cancelled (fired while the player
  // was outside the parcel) and AvatarLocomotionSettings can persist on PlayerEntity.
  // Reset everything so the player starts fresh with normal movement speed.
  onEnterSceneObservable.add(() => {
    occupiedPatches.clear()
    if (isSlowed) restoreSpeed()
  })

  engine.addSystem(() => {
    // ── Release on round end ──────────────────────────────────
    let phase = 'playing'
    for (const [, gs] of engine.getEntitiesWith(GameState)) {
      phase = gs.phase; break
    }
    if (phase !== 'playing') {
      if (isSlowed) restoreSpeed()
      return
    }

    // ── Skip if already slowed ────────────────────────────────
    const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position
    if (!playerPos) return

    for (const { entity, itemId } of patches) {
      // Skip cleaned patches — server sets scale to 0.001 when cleaned
      const tf = Transform.getOrNull(entity)
      if (!tf || tf.scale.x < 0.01) continue

      const patchPos = tf.position

      // Y check first — cheap early-out that prevents upper-floor false positives
      if (Math.abs(playerPos.y - patchPos.y) > MAX_Y_DIFF) {
        occupiedPatches.delete(itemId)
        continue
      }

      const dx = playerPos.x - patchPos.x
      const dz = playerPos.z - patchPos.z
      const dist = Math.sqrt(dx * dx + dz * dz)

      if (dist > EXIT_RADIUS) {
        // Player has left — allow re-trigger next time they step on it
        occupiedPatches.delete(itemId)
        continue
      }

      if (dist > DETECT_RADIUS) continue  // in exit buffer, not yet triggered

      // Player is on the patch — only trigger if they weren't already on it
      if (occupiedPatches.has(itemId)) continue
      occupiedPatches.add(itemId)

      if (isSlowed) continue  // already slowed by another patch, mark occupied but don't re-apply

      // ── Contact! ─────────────────────────────────────────────
      isSlowed = true
      playSquelchSound()

      AvatarLocomotionSettings.createOrReplace(engine.PlayerEntity, {
        jogSpeed:  SLOW_JOG_SPEED,
        walkSpeed: SLOW_WALK_SPEED,
        runSpeed:  SLOW_RUN_SPEED,
      })

      timers.setTimeout(restoreSpeed, SLOW_DURATION_MS)
      break
    }
  })

  console.log('[StickyHazard] System ready')
}
