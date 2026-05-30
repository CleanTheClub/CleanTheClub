import { engine, Entity, GltfContainer, MeshCollider, ColliderLayer } from '@dcl/sdk/ecs'

// Returns the entity that holds the GltfContainer for a scene item.
// In our scenes, every interactable's "container" entity IS the GltfContainer entity
// (Creator Hub places assets flat, not nested). Returns undefined if the entity
// has no GltfContainer yet (still loading) — the caller should retry next frame.
export function findGltfEntity(containerEntity: Entity): Entity | undefined {
  return GltfContainer.getOrNull(containerEntity) ? containerEntity : undefined
}

// Sets visibleMeshesCollisionMask |= CL_POINTER on the GLB. Returns false if the
// GltfContainer hasn't streamed in yet so the caller can retry.
function applyPointerMask(gltfEnt: Entity): boolean {
  const g = GltfContainer.getOrNull(gltfEnt)
  if (!g) return false
  GltfContainer.getMutable(gltfEnt).visibleMeshesCollisionMask =
    (g.visibleMeshesCollisionMask ?? 0) | ColliderLayer.CL_POINTER
  return true
}

// Makes a scene-discovered GLB entity reliably clickable:
// 1. visibleMeshesCollisionMask |= CL_POINTER — needed for the hover outline;
//    Creator Hub sets this per-model, this is a safety-net no-op if already set.
//    If the GltfContainer hasn't loaded yet a one-shot system retries until it
//    has, so an item is never left un-clickable due to a late-arriving component
//    (this was the cause of the occasional un-clickable sofa cushion on round 1).
// 2. MeshCollider.setBox — guarantees a hittable collider regardless of whether
//    the GLB's visible mesh geometry registers pointer raycasts reliably.
//    Size = entity Transform scale, so tune click feel via Creator Hub scale.
//
// addBox defaults to true (every tall item relies on it for clicks). Pass false
// for flat floor items (sticky patches): the box is centered at the entity origin
// and sits ABOVE a flat mesh, so the ray hits the box (invisible, no renderable)
// instead of the mesh — which makes them clickable but suppresses the hover
// outline. With addBox=false the visible mesh itself is the pointer collider, so
// the engine has a renderable to highlight on hover.
export function setupClickProxy(gltfEnt: Entity, addBox = true): Entity {
  if (!applyPointerMask(gltfEnt)) {
    const waitForGltf = () => {
      if (applyPointerMask(gltfEnt)) engine.removeSystem(waitForGltf)
    }
    engine.addSystem(waitForGltf)
  }
  if (addBox) MeshCollider.setBox(gltfEnt, ColliderLayer.CL_POINTER)
  return gltfEnt
}
