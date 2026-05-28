import { Entity, GltfContainer, MeshCollider, ColliderLayer } from '@dcl/sdk/ecs'

// Returns the entity that holds the GltfContainer for a scene item.
// In our scenes, every interactable's "container" entity IS the GltfContainer entity
// (Creator Hub places assets flat, not nested). Returns undefined if the entity
// has no GltfContainer yet (still loading) — the caller should retry next frame.
export function findGltfEntity(containerEntity: Entity): Entity | undefined {
  return GltfContainer.getOrNull(containerEntity) ? containerEntity : undefined
}

// Makes a scene-discovered GLB entity reliably clickable:
// 1. visibleMeshesCollisionMask |= CL_POINTER — needed for the hover outline;
//    Creator Hub sets this per-model, this is a safety-net no-op if already set.
// 2. MeshCollider.setBox — guarantees a hittable collider regardless of whether
//    the GLB's visible mesh geometry registers pointer raycasts reliably.
//    Size = entity Transform scale, so tune click feel via Creator Hub scale.
export function setupClickProxy(gltfEnt: Entity): Entity {
  const g = GltfContainer.getOrNull(gltfEnt)
  if (g) {
    GltfContainer.getMutable(gltfEnt).visibleMeshesCollisionMask =
      (g.visibleMeshesCollisionMask ?? 0) | ColliderLayer.CL_POINTER
  }
  MeshCollider.setBox(gltfEnt, ColliderLayer.CL_POINTER)
  return gltfEnt
}
