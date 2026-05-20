import { engine, Entity, GltfContainer, MeshCollider, ColliderLayer, Transform } from '@dcl/sdk/ecs'

// Returns the entity that holds the GltfContainer for a scene item.
// In our scenes, every interactable's "container" entity IS the GltfContainer entity
// (Creator Hub places assets flat, not nested). Returns undefined if the entity
// has no GltfContainer yet (still loading) — the caller should retry next frame.
export function findGltfEntity(containerEntity: Entity): Entity | undefined {
  return GltfContainer.getOrNull(containerEntity) ? containerEntity : undefined
}

// Makes a scene-discovered GLB entity reliably clickable. Returns the entity that
// should receive PointerEvents (either gltfEnt itself, or an invisible child proxy).
//
// boxMultiplier = 1 (default): box collider placed directly on gltfEnt, same as before.
// boxMultiplier > 1: a child proxy entity is created with an enlarged box collider.
//   The proxy is parented to gltfEnt so it inherits scale-to-0 hides automatically,
//   and the caller registers pointer events on the returned proxy, not gltfEnt.
//
// visibleMeshesCollisionMask is always set on gltfEnt (hover outline on real mesh).
export function setupClickProxy(gltfEnt: Entity, boxMultiplier: number = 1): Entity {
  const g = GltfContainer.getMutable(gltfEnt)
  g.visibleMeshesCollisionMask = (g.visibleMeshesCollisionMask ?? 0) | ColliderLayer.CL_POINTER

  if (boxMultiplier === 1) {
    MeshCollider.setBox(gltfEnt, ColliderLayer.CL_POINTER)
    return gltfEnt
  }

  // Enlarged click box via an invisible child entity — inherits parent transforms so
  // hiding the parent (scale → 0.001) also collapses the proxy to near-zero.
  const proxy = engine.addEntity()
  Transform.create(proxy, {
    parent:   gltfEnt,
    position: { x: 0, y: 0, z: 0 },
    scale:    { x: boxMultiplier, y: boxMultiplier, z: boxMultiplier },
  })
  MeshCollider.setBox(proxy, ColliderLayer.CL_POINTER)
  return proxy
}
