import { Entity, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { discoverStickyPatches } from './shared/glassDiscovery'
import { findGltfEntity, setupClickProxy } from './client/sceneItemHelpers'
import { initInteractionManager, updateSceneHoldGltf } from './client/InteractionManager'
import { requestSpawn, requestSetup } from './client/spawnDirector'
import { setHoldBarVisible, setHoldBarProgress } from './ui'

// Dirty entities are what players interact with (pointer events registered on these).
// Currently only sceneGlb items (sticky patches) live here; their visible meshes are
// the interactables and applyCleanState scales them to hide/show on clean state.
const dirtyEntities       = new Map<string, Entity>()
const originalDirtyScales = new Map<string, { x: number; y: number; z: number }>()
// Sticky patches whose GltfContainer + click collider are fully set up — gates the
// staggered spawn-in so an item never pops in (and becomes clickable) before ready.
const stickyReady         = new Set<string>()

// Swaps dirty visuals — driven by ClutterSync.isCleaned on all clients.
// Cleaned items vanish (scale = zero); restored items snap back to original scale.
export function applyCleanState(id: string, isCleaned: boolean) {
  const dirty = dirtyEntities.get(id)
  if (!dirty) return
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

// ─── Hold-to-clean progress bar ────────────────────────────────────────────────
// The bar is a screen-space UI element (see ui.tsx) so it can never be occluded
// by the avatar. Only one hold can be active at a time, so one shared bar.
export function showHoldBar(visible: boolean) {
  setHoldBarVisible(visible)
}
export function updateHoldBar(progress: number) {
  setHoldBarProgress(progress)
}

// ─── Staggered spawn-in (sticky patches) ───────────────────────────────────────
// Called by InteractionManager when a patch should appear (round reset / first
// sync, uncleaned).  Instead of snapping it visible + enabling clicks immediately,
// we hide it, then hand it to the spawn director: it pops in (springy scale) only
// once its GLB + collider are ready, and `onPopped` enables clicks at that point.
export function spawnInSticky(id: string, onPopped: () => void) {
  const ent = dirtyEntities.get(id)
  if (!ent) return  // not a sticky patch (other systems own their own items)

  const toScale = originalDirtyScales.get(id)
  if (!toScale) {
    // Unknown target scale (shouldn't happen — captured at discovery). Fall back
    // to the old instant behaviour so the item is never left invisible.
    applyCleanState(id, false)
    onPopped()
    return
  }

  // Hide immediately so it stays gone until the director pops it.
  const tr = Transform.getMutableOrNull(ent)
  if (tr) tr.scale = { x: 0.001, y: 0.001, z: 0.001 }

  requestSpawn({
    entity:  ent,
    toScale,
    isReady: () => stickyReady.has(id),
    onPopped,
  })
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initCleaningSystem() {
  // All current CLUTTER_DEFS are sceneGlb (visuals + clicks owned by scene-discovery
  // systems: collectibleSystem, rubbishSystem, restoreSystem), so no primitive
  // placeholder entities are created here.

  // Scene-discovered sticky patches — GLB entities that slot into the hold pipeline.
  // No primitives are created; the composite entity itself is the interactable.
  // The container entity is registered immediately; a deferred system then finds
  // the actual GltfContainer entity, sets CL_POINTER, and hands it to InteractionManager.
  const sceneHoldEntities = new Map<string, Entity>()  // itemId → container entity
  for (const { entity, itemId } of discoverStickyPatches()) {
    dirtyEntities.set(itemId, entity)
    sceneHoldEntities.set(itemId, entity)
    // Capture the authored scale now (before any clean zeroes it) so the spawn
    // director knows what size to pop the patch back to, then hide it immediately
    // so it only ever appears via the staggered pop-in (no load-time flicker).
    const t = Transform.getMutableOrNull(entity)
    if (t && t.scale.x > 0.01) {
      originalDirtyScales.set(itemId, { x: t.scale.x, y: t.scale.y, z: t.scale.z })
      t.scale = { x: 0.001, y: 0.001, z: 0.001 }
    }
  }

  initInteractionManager(dirtyEntities, applyCleanState, showHoldBar, updateHoldBar, sceneHoldEntities, spawnInSticky)

  // Staggered GLB setup — one patch at a time via the global director, gated on the
  // GltfContainer having streamed in (same throttling as the other mess systems).
  for (const [itemId, containerEntity] of sceneHoldEntities) {
    requestSetup({
      isReady: () => findGltfEntity(containerEntity) !== undefined,
      run: () => {
        const gltfEnt = findGltfEntity(containerEntity)
        if (!gltfEnt) return

        // Identical collision setup to the other mess items (glasses/bottles/rubbish):
        // visible-mesh CL_POINTER mask + a primitive box collider. Combined with the
        // matching pointer events (hover + down only — see InteractionManager), this
        // gives sticky patches the same white hover outline as every other item.
        const clickEnt = setupClickProxy(gltfEnt)

        // Tell InteractionManager to use the click entity for pointer events
        updateSceneHoldGltf(itemId, clickEnt)
        stickyReady.add(itemId)  // now safe for the spawn director to pop it in
        console.log(`[SCENE] StickyPatch "${itemId}" GLB entity ready → ${gltfEnt}`)
      },
    })
  }
}
