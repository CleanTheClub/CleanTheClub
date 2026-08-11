// Sparkle burst system — fires a pop of gold sparkles when an item is cleaned.
// Follows the Living Garden pattern: pre-allocated pool of billboard plane entities
// driven by a manual ECS physics system. No ParticleSystem component.

import {
  engine, Entity,
  MeshRenderer, Material, MaterialTransparencyMode,
  Transform, Billboard, BillboardMode,
} from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'

const SPARKLE_SRC    = 'assets/scene/Particles/sparkle.png'
const BURST_COUNT    = 10    // sparkles claimed per clean event
const BURST_POOL_SIZE = 14   // pool slots — handles 1 simultaneous burst + buffer
const SPARKLE_SIZE   = 0.22  // peak world-space diameter (m)
const SPEED_MIN      = 1.6   // m/s
const SPEED_MAX      = 3.8   // m/s
const GRAVITY        = 4.5   // m/s² downward
const LIFE_BASE_MS   = 1_100
const LIFE_VARY_MS   = 350
const SPAWN_Y        = 0.4   // metres above the item's position
// Scale curve breakpoints (fraction of lifetime)
const POP_IN   = 0.2
const HOLD_END = 0.5

interface BurstSlot {
  entity:    Entity
  active:    boolean
  pos:       { x: number; y: number; z: number }
  vel:       { x: number; y: number; z: number }
  lifeMs:    number
  maxLifeMs: number
}

const pool: BurstSlot[] = []
// In-flight count — lets the physics system skip the pool scan while idle.
let activeSparkles = 0

function makeSparkleEntity(): Entity {
  const e = engine.addEntity()
  MeshRenderer.setPlane(e)
  Material.setPbrMaterial(e, {
    texture:          Material.Texture.Common({ src: SPARKLE_SRC }),
    alphaTexture:     Material.Texture.Common({ src: SPARKLE_SRC }),
    albedoColor:      Color4.create(1.0, 0.95, 0.75, 1),  // warm cream-gold
    emissiveColor:    { r: 1.0, g: 0.85, b: 0.4 },        // gold glow
    emissiveIntensity: 1.8,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
  })
  Billboard.create(e, { billboardMode: BillboardMode.BM_ALL })
  Transform.create(e, {
    position: { x: 0, y: -100, z: 0 },
    scale:    { x: 0.001, y: 0.001, z: 0.001 },
  })
  return e
}

export function initSparkleSystem(): void {
  for (let i = 0; i < BURST_POOL_SIZE; i++) {
    pool.push({
      entity:    makeSparkleEntity(),
      active:    false,
      pos:       { x: 0, y: 0, z: 0 },
      vel:       { x: 0, y: 0, z: 0 },
      lifeMs:    0,
      maxLifeMs: 0,
    })
  }

  engine.addSystem((dt: number) => {
    if (activeSparkles === 0) return   // idle guard, same pattern as confetti
    for (const s of pool) {
      if (!s.active) continue

      s.lifeMs += dt * 1_000
      s.vel.y  -= GRAVITY * dt
      s.pos.x  += s.vel.x * dt
      s.pos.y  += s.vel.y * dt
      s.pos.z  += s.vel.z * dt

      if (s.lifeMs >= s.maxLifeMs) {
        s.active = false
        activeSparkles--
        Transform.getMutable(s.entity).scale = { x: 0.001, y: 0.001, z: 0.001 }
        continue
      }

      const t = Math.min(s.lifeMs / s.maxLifeMs, 1)
      let sc: number
      if (t < POP_IN) {
        const u = t / POP_IN
        sc = SPARKLE_SIZE * (1 - (1 - u) * (1 - u))   // ease in
      } else if (t < HOLD_END) {
        sc = SPARKLE_SIZE
      } else {
        sc = SPARKLE_SIZE * (1 - (t - HOLD_END) / (1 - HOLD_END))   // linear fade
      }

      const tf    = Transform.getMutable(s.entity)
      tf.position = { x: s.pos.x, y: s.pos.y, z: s.pos.z }
      tf.scale    = { x: sc, y: sc, z: sc }
    }
  })

  console.log(`[Sparkles] Pool ready — ${BURST_POOL_SIZE} slots`)
}

/** Fire a gold sparkle burst centred on `pos` (world position of the cleaned item). */
export function playSparkle(pos: { x: number; y: number; z: number }): void {
  let claimed = 0
  for (const s of pool) {
    if (claimed >= BURST_COUNT) break
    if (s.active) continue

    const azimuth   = Math.random() * Math.PI * 2
    const elevation = (25 + Math.random() * 65) * (Math.PI / 180)
    const speed     = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN)

    s.active    = true
    activeSparkles++
    s.lifeMs    = 0
    s.maxLifeMs = LIFE_BASE_MS + Math.random() * LIFE_VARY_MS
    s.pos       = { x: pos.x, y: pos.y + SPAWN_Y, z: pos.z }
    s.vel       = {
      x: Math.cos(azimuth) * Math.cos(elevation) * speed,
      y: Math.sin(elevation) * speed,
      z: Math.sin(azimuth)  * Math.cos(elevation) * speed,
    }
    Transform.getMutable(s.entity).position = { ...s.pos }
    claimed++
  }
}
