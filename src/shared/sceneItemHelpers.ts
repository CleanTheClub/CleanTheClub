import { engine, Entity, Transform, GltfContainer, MeshCollider, ColliderLayer } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'

// ── Mobile tap targets ────────────────────────────────────────────────────────
// Touch input has no cursor and no hover state: the player aims with a fingertip
// at whatever is under it, with none of the pixel precision a mouse gives. Item
// colliders sized exactly to the mesh are therefore much harder to hit on phones
// than on desktop — reported repeatedly as "hitbox of the objects in the middle of
// the dance floor cannot be clicked always" on iOS.
//
// On mobile only, each item gets an invisible child collider scaled up around it,
// and pointer events are bound to THAT instead of the mesh. Desktop is untouched,
// so the hover outline there is unaffected.
//
// Tuning note: this multiplies the item's own box, so it scales with the item and
// stays correct when an item is hidden by scaling its container to ~0.
//
// Kept deliberately modest. MeshCollider.setBox sizes the box from the entity's
// Transform scale, and the dance-floor items are scale 1 — so they ALREADY have a
// 1m cube collider, and "target too small" is a weak explanation for the reported
// misses there. Meanwhile popcorn_2 and popcorn_3 sit only 1.93m apart, so a 2x
// box (2m) would overlap and let a tap clean the wrong item. At 1.4 the boxes stay
// clear of each other (they would need to be <1.4m apart to overlap) while still
// helping genuinely small items, of which the scene has plenty (rubbish scales run
// down to 0.3).
//
// If device testing shows taps are still unreliable on the dance floor, the cause
// is likely NOT collider size — look at the raised floor (items sit at y~0.95, i.e.
// at the player's feet, where a third-person mobile camera aims poorly) before
// raising this value.
const MOBILE_TAP_SCALE = 1.4

// Returns the entity that holds the GltfContainer for a scene item.
// In our scenes, every interactable's "container" entity IS the GltfContainer entity
// (Creator Hub places assets flat, not nested). Returns undefined if the entity
// has no GltfContainer yet (still loading) — the caller should retry next frame.
export function findGltfEntity(containerEntity: Entity): Entity | undefined {
  return GltfContainer.getOrNull(containerEntity) ? containerEntity : undefined
}

// Sets visibleMeshesCollisionMask |= CL_POINTER on the GLB. Returns false if the
// GltfContainer hasn't streamed in yet so the caller can retry.
//
// When a mobile tap-target proxy replaces the mesh as the pointer collider, the
// mask is CLEARED instead. The mesh — which has no PointerEvents of its own —
// would otherwise sit inside the proxy and absorb the raycast first, making taps
// strictly WORSE than before. The mask exists purely to drive the hover outline,
// which mobile never renders, so nothing is lost there.
function applyPointerMask(gltfEnt: Entity, clear: boolean): boolean {
  const g = GltfContainer.getOrNull(gltfEnt)
  if (!g) return false
  const mask = g.visibleMeshesCollisionMask ?? 0
  GltfContainer.getMutable(gltfEnt).visibleMeshesCollisionMask =
    clear ? (mask & ~ColliderLayer.CL_POINTER) : (mask | ColliderLayer.CL_POINTER)
  return true
}

// Creates the invisible, enlarged mobile tap target as a child of the item, so it
// inherits the item's position and scale (including being scaled away to nothing
// when the item is hidden — a cleaned item must not stay tappable).
function createMobileTapTarget(gltfEnt: Entity): Entity {
  const proxy = engine.addEntity()
  Transform.create(proxy, {
    parent: gltfEnt,
    scale:  { x: MOBILE_TAP_SCALE, y: MOBILE_TAP_SCALE, z: MOBILE_TAP_SCALE },
  })
  MeshCollider.setBox(proxy, ColliderLayer.CL_POINTER)
  return proxy
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
//
// RETURN VALUE: the entity pointer events must be bound to. On desktop that is
// gltfEnt itself; on mobile it is the enlarged tap-target child. Callers MUST use
// the returned entity rather than assuming gltfEnt, or mobile taps will be bound
// to an entity that no longer carries a pointer collider.
export function setupClickProxy(gltfEnt: Entity, addBox = true): Entity {
  // The mobile proxy is a child box at the entity's LOCAL origin, so it is only
  // safe where a box at that origin is already known to land correctly — exactly
  // what addBox encodes. Items that opt out (baked GLB offsets, e.g. the bar
  // stools) would get a tap target floating away from the mesh, so they keep the
  // visible-mesh collider on mobile too.
  const useMobileProxy = isMobile() && addBox

  if (!applyPointerMask(gltfEnt, useMobileProxy)) {
    const waitForGltf = () => {
      if (applyPointerMask(gltfEnt, useMobileProxy)) engine.removeSystem(waitForGltf)
    }
    engine.addSystem(waitForGltf)
  }
  if (useMobileProxy) return createMobileTapTarget(gltfEnt)
  if (addBox) MeshCollider.setBox(gltfEnt, ColliderLayer.CL_POINTER)
  return gltfEnt
}
