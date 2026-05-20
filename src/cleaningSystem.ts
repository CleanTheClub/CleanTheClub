import {
  engine, Entity,
  MeshRenderer, MeshCollider, ColliderLayer,
  Transform, VisibilityComponent,
  Billboard, BillboardMode,
  Material,
} from '@dcl/sdk/ecs'
import { discoverStickyPatches } from './shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from './shared/sceneItemHelpers'
import { updateSceneHoldGltf } from './client/InteractionManager'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { CLUTTER_DEFS, InteractionType } from './shared/config'
import { initInteractionManager } from './client/InteractionManager'

// Dirty entities are what players interact with (pointer events registered on these)
const dirtyEntities    = new Map<string, Entity>()
const cleanEntities    = new Map<string, Entity>()
const originalDirtyScales = new Map<string, { x: number; y: number; z: number }>()

// Per hold-type item: independent billboard + two plane meshes
type HoldBar = { bg: Entity; fill: Entity }
const holdBars = new Map<string, HoldBar>()

const BAR_WIDTH         = 0.8
const BAR_HEIGHT        = 0.18    // taller → easier to see
const BAR_Y_OFFSET      = 1.1     // metres above item origin (was 1.4; -0.3 m lower)
const BAR_BG_COLOR      = Color4.create(0.05, 0.05, 0.05, 0.92)
const BAR_FILL_COLOR    = Color4.create(0.15, 1.00, 0.40, 1)
const CLEAN_COLOR = Color4.create(0.88, 0.94, 0.88, 1)

// Swaps dirty visuals — driven by ClutterSync.isCleaned on all clients.
// Cleaned items vanish (scale = zero); restored items snap back to original scale.
// The "clean" placeholder entities are kept but never shown — real GLBs will replace them.
export function applyCleanState(id: string, isCleaned: boolean) {
  const dirty = dirtyEntities.get(id)
  if (dirty) {
    // Stash original scale on first call so round-resets can restore it
    if (!originalDirtyScales.has(id)) {
      const t = Transform.getOrNull(dirty)
      if (t) originalDirtyScales.set(id, { x: t.scale.x, y: t.scale.y, z: t.scale.z })
    }
    const t = Transform.getMutable(dirty)
    if (isCleaned) {
      t.scale = Vector3.Zero()
    } else {
      const orig = originalDirtyScales.get(id) ?? { x: 1, y: 1, z: 1 }
      t.scale = { x: orig.x, y: orig.y, z: orig.z }
    }
  }
  // Clean placeholder always hidden — items just disappear when cleaned
  const clean = cleanEntities.get(id)
  if (clean) VisibilityComponent.createOrReplace(clean, { visible: false })
}

export function showHoldBar(id: string, visible: boolean) {
  const bar = holdBars.get(id)
  if (!bar) return
  // Only toggle the background track — the fill stays in the render pipeline always
  // (emissive shader stays compiled). Its width is controlled by updateHoldBar.
  VisibilityComponent.createOrReplace(bar.bg, { visible })
  if (!visible) {
    // Collapse the fill to imperceptible width so it doesn't glow when hidden
    const t = Transform.getMutable(bar.fill)
    t.scale.x    = 0.001
    t.position.x = -BAR_WIDTH / 2
  }
}

export function updateHoldBar(id: string, progress: number) {
  const bar = holdBars.get(id)
  if (!bar) return
  const p = Math.max(0.001, Math.min(1, progress))
  const t = Transform.getMutable(bar.fill)
  t.scale.x    = p * BAR_WIDTH
  t.position.x = -BAR_WIDTH / 2 + (p * BAR_WIDTH) / 2
}

// ─── Visual config per type ───────────────────────────────────────────────────

type VisualConfig = {
  color:    Color4.Mutable
  scale:    { x: number; y: number; z: number }
  mesh:     (e: Entity) => void
  collider: (e: Entity) => void
}

function getVisualConfig(type: InteractionType): VisualConfig {
  switch (type) {
    case 'quick':
      return {
        color:    Color4.create(1, 0.55, 0.1, 1),
        scale:    { x: 0.55, y: 0.55, z: 0.55 },
        mesh:     (e) => MeshRenderer.setBox(e),
        collider: (e) => MeshCollider.setBox(e, ColliderLayer.CL_POINTER),
      }
    case 'hold':
      return {
        color:    Color4.create(0.6, 0.15, 0.9, 1),
        scale:    { x: 0.9, y: 0.15, z: 0.9 },
        mesh:     (e) => MeshRenderer.setSphere(e),
        collider: (e) => MeshCollider.setSphere(e, ColliderLayer.CL_POINTER),
      }
    case 'collect':
      return {
        color:    Color4.create(0.1, 0.8, 0.9, 1),
        scale:    { x: 0.35, y: 0.75, z: 0.35 },
        mesh:     (e) => MeshRenderer.setCylinder(e, 0.5, 0.5),
        collider: (e) => MeshCollider.setCylinder(e, 0.5, 0.5, ColliderLayer.CL_POINTER),
      }
    case 'reset':
      return {
        color:    Color4.create(0.2, 0.88, 0.35, 1),
        scale:    { x: 1.4, y: 0.22, z: 0.9 },
        mesh:     (e) => MeshRenderer.setBox(e),
        collider: (e) => MeshCollider.setBox(e, ColliderLayer.CL_POINTER),
      }
  }
}

// ─── Hold bar ────────────────────────────────────────────────────────────────

function createHoldBar(pos: { x: number; y: number; z: number }): HoldBar {
  const pivot = engine.addEntity()
  Billboard.create(pivot, { billboardMode: BillboardMode.BM_ALL })
  Transform.create(pivot, {
    position: Vector3.create(pos.x, pos.y + BAR_Y_OFFSET, pos.z),
  })

  const bg = engine.addEntity()
  MeshRenderer.setPlane(bg)
  Material.setPbrMaterial(bg, { albedoColor: BAR_BG_COLOR })
  Transform.create(bg, {
    parent: pivot,
    position: Vector3.create(0, 0, 0),
    scale:    Vector3.create(BAR_WIDTH, BAR_HEIGHT, 0.01),
  })
  VisibilityComponent.create(bg, { visible: false })

  const fill = engine.addEntity()
  MeshRenderer.setPlane(fill)
  Transform.create(fill, {
    parent: pivot,
    position: Vector3.create(-BAR_WIDTH / 2, 0, -0.002),
    scale:    Vector3.create(0.001, BAR_HEIGHT, 0.01),
  })
  // Basic (unlit) material — renders at full brightness regardless of scene lighting.
  // PBR emissive is too lighting-dependent for a UI-style progress bar.
  Material.setBasicMaterial(fill, { diffuseColor: BAR_FILL_COLOR })
  // Fill is NOT hidden via VisibilityComponent — it stays in the render pipeline
  // at all times so the emissive shader is compiled and active from round 1.
  // Visibility is controlled purely by scale.x (0.001 = imperceptible, set by updateHoldBar).

  return { bg, fill }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initCleaningSystem() {
  for (const def of CLUTTER_DEFS) {
    if (def.sceneGlb) continue   // visuals owned by a scene-discovery system
    const type = def.type ?? 'quick'
    const cfg  = getVisualConfig(type)
    const pos  = Vector3.create(def.position.x, def.position.y, def.position.z)
    const scl  = def.scale
      ? Vector3.create(def.scale.x, def.scale.y, def.scale.z)
      : Vector3.create(cfg.scale.x, cfg.scale.y, cfg.scale.z)

    // Dirty entity — visible by default, has pointer collider
    const dirty = engine.addEntity()
    cfg.mesh(dirty)
    cfg.collider(dirty)
    Material.setPbrMaterial(dirty, { albedoColor: cfg.color })
    Transform.create(dirty, { position: pos, scale: scl })
    dirtyEntities.set(def.id, dirty)

    // Clean entity — hidden by default, same shape, neutral color
    const clean = engine.addEntity()
    cfg.mesh(clean)
    Material.setPbrMaterial(clean, { albedoColor: CLEAN_COLOR })
    Transform.create(clean, { position: pos, scale: scl })
    VisibilityComponent.create(clean, { visible: false })
    cleanEntities.set(def.id, clean)

    if (type === 'hold') {
      holdBars.set(def.id, createHoldBar(def.position))
    }
  }

  // Scene-discovered sticky patches — GLB entities that slot into the hold pipeline.
  // No primitives are created; the composite entity itself is the interactable.
  // The container entity is registered immediately; a deferred system then finds
  // the actual GltfContainer entity, sets CL_POINTER, and hands it to InteractionManager.
  const sceneHoldEntities = new Map<string, Entity>()  // itemId → container entity
  for (const { entity, itemId } of discoverStickyPatches()) {
    dirtyEntities.set(itemId, entity)
    sceneHoldEntities.set(itemId, entity)
    const tf = Transform.getOrNull(entity)
    if (tf) holdBars.set(itemId, createHoldBar(tf.position))
  }

  initInteractionManager(dirtyEntities, applyCleanState, showHoldBar, updateHoldBar, sceneHoldEntities)

  // Deferred GLB setup — mirrors collectibleSystem's setupSystem.
  // Runs every frame until each patch's GltfContainer has loaded, then removes itself.
  if (sceneHoldEntities.size > 0) {
    const needsGltfSetup = new Set(sceneHoldEntities.keys())
    const stickyGltfSetup = () => {
      for (const [itemId, containerEntity] of sceneHoldEntities) {
        if (!needsGltfSetup.has(itemId)) continue
        const gltfEnt = findGltfEntity(containerEntity)
        if (!gltfEnt) continue
        needsGltfSetup.delete(itemId)

        const proxyEnt = setupClickProxy(gltfEnt, 2.0)

        // Tell InteractionManager to use the proxy entity for pointer events
        updateSceneHoldGltf(itemId, proxyEnt)
        console.log(`[SCENE] StickyPatch "${itemId}" GLB entity ready → ${gltfEnt}`)
      }
      if (needsGltfSetup.size === 0) engine.removeSystem(stickyGltfSetup)
    }
    engine.addSystem(stickyGltfSetup)
  }
}
