import { Entity, GltfContainer, MeshCollider, ColliderLayer } from '@dcl/sdk/ecs'

// Returns the entity that holds the GltfContainer for a scene item.
// In our scenes, every interactable's "container" entity IS the GltfContainer entity
// (Creator Hub places assets flat, not nested). Returns undefined if the entity
// has no GltfContainer yet (still loading) — the caller should retry next frame.
export function findGltfEntity(containerEntity: Entity): Entity | undefined {
  return GltfContainer.getOrNull(containerEntity) ? containerEntity : undefined
}

// Makes a scene-discovered GLB entity reliably clickable:
// 1. Defensively asserts CL_POINTER on the GLB's visible mesh layer (no-op if already set).
//    We intentionally do NOT touch invisibleMeshesCollisionMask — many asset-pack GLBs
//    ship with a fat invisible bounding-cylinder for physics; adding CL_POINTER to that
//    layer makes raycasts hit the invisible shell, killing the hover outline.
// 2. Adds a primitive box collider on the SAME entity as a guaranteed pointer target.
//    The box is a unit cube scaled by the entity's Transform, so it tracks the item's
//    Creator Hub scale automatically. PointerEvents stays on this entity, GltfContainer
//    renders the GLB, so the hover outline still appears on the real visible shape.
export function setupClickProxy(gltfEnt: Entity): void {
  const g = GltfContainer.getMutable(gltfEnt)
  g.visibleMeshesCollisionMask = (g.visibleMeshesCollisionMask ?? 0) | ColliderLayer.CL_POINTER
  MeshCollider.setBox(gltfEnt, ColliderLayer.CL_POINTER)
}
