import { Entity, GltfContainer, MeshCollider, ColliderLayer } from '@dcl/sdk/ecs'

// Returns the entity that holds the GltfContainer for a scene item.
// In our scenes, every interactable's "container" entity IS the GltfContainer entity
// (Creator Hub places assets flat, not nested). Returns undefined if the entity
// has no GltfContainer yet (still loading) — the caller should retry next frame.
export function findGltfEntity(containerEntity: Entity): Entity | undefined {
  return GltfContainer.getOrNull(containerEntity) ? containerEntity : undefined
}

// Makes a scene-discovered GLB entity reliably clickable:
// 1. Asserts CL_POINTER on the visible mesh layer for the hover outline.
// 2. Adds a primitive box collider as a guaranteed pointer target — the box is a
//    unit cube scaled by the entity's Transform, so sizing is controlled via
//    Creator Hub scale. We intentionally do NOT touch invisibleMeshesCollisionMask.
export function setupClickProxy(gltfEnt: Entity): Entity {
  const g = GltfContainer.getMutable(gltfEnt)
  g.visibleMeshesCollisionMask = (g.visibleMeshesCollisionMask ?? 0) | ColliderLayer.CL_POINTER
  MeshCollider.setBox(gltfEnt, ColliderLayer.CL_POINTER)
  return gltfEnt
}
