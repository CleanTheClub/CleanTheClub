import {
  engine, Entity,
  MeshRenderer, MeshCollider, ColliderLayer,
  Transform, VisibilityComponent,
  Billboard, BillboardMode,
  Material,
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { CLUTTER_DEFS, InteractionType } from './shared/config'
import { initInteractionManager } from './client/InteractionManager'

// Dirty entities are what players interact with (pointer events registered on these)
const dirtyEntities = new Map<string, Entity>()
const cleanEntities = new Map<string, Entity>()

// Per hold-type item: independent billboard + two plane meshes
type HoldBar = { bg: Entity; fill: Entity }
const holdBars = new Map<string, HoldBar>()

const BAR_WIDTH  = 0.8
const BAR_HEIGHT = 0.1

// Placeholder clean color — same shape, neutral light tone
// Replace per-type when real GLBs are ready
const CLEAN_COLOR = Color4.create(0.88, 0.94, 0.88, 1)

// Swaps dirty/clean visuals — driven by ClutterSync.isCleaned on all clients
export function applyCleanState(id: string, isCleaned: boolean) {
  const dirty = dirtyEntities.get(id)
  const clean = cleanEntities.get(id)
  if (dirty) VisibilityComponent.createOrReplace(dirty, { visible: !isCleaned })
  if (clean) VisibilityComponent.createOrReplace(clean, { visible:  isCleaned })
}

export function showHoldBar(id: string, visible: boolean) {
  const bar = holdBars.get(id)
  if (!bar) return
  VisibilityComponent.createOrReplace(bar.bg,   { visible })
  VisibilityComponent.createOrReplace(bar.fill, { visible })
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

function createHoldBar(def: (typeof CLUTTER_DEFS)[number]): HoldBar {
  const pivot = engine.addEntity()
  Billboard.create(pivot, { billboardMode: BillboardMode.BM_ALL })
  Transform.create(pivot, {
    position: Vector3.create(def.position.x, def.position.y + 1.4, def.position.z),
  })

  const bg = engine.addEntity()
  MeshRenderer.setPlane(bg)
  Material.setPbrMaterial(bg, { albedoColor: Color4.create(0.08, 0.08, 0.08, 0.88) })
  Transform.create(bg, {
    parent: pivot,
    position: Vector3.create(0, 0, 0),
    scale:    Vector3.create(BAR_WIDTH, BAR_HEIGHT, 0.01),
  })
  VisibilityComponent.create(bg, { visible: false })

  const fill = engine.addEntity()
  MeshRenderer.setPlane(fill)
  Material.setPbrMaterial(fill, { albedoColor: Color4.create(0.2, 0.9, 0.35, 1) })
  Transform.create(fill, {
    parent: pivot,
    position: Vector3.create(-BAR_WIDTH / 2, 0, -0.002),
    scale:    Vector3.create(0.001, BAR_HEIGHT, 0.01),
  })
  VisibilityComponent.create(fill, { visible: false })

  return { bg, fill }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initCleaningSystem() {
  for (const def of CLUTTER_DEFS) {
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
      holdBars.set(def.id, createHoldBar(def))
    }
  }

  initInteractionManager(dirtyEntities, applyCleanState, showHoldBar, updateHoldBar)
}
