import {
  engine, Entity, Transform, GltfContainer, GltfContainerLoadingState,
  LoadingState, Name, MeshCollider, ColliderLayer, PointerEvents } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { ClutterSync } from '../shared/schemas'
import { MODEL_SIZE_M } from '../shared/config'

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
// Multiplies the model's MEASURED size (MODEL_SIZE_M) — small items get small
// boxes (popcorns 1.93m apart stay well clear of each other) and big ones get
// full coverage. The floor keeps tiny props from becoming untappable slivers.
const MOBILE_TAP_SCALE = 1.4
const MOBILE_TAP_MIN_M = 0.55

// ── Tap proxy vs hover outline ────────────────────────────────────────────────
// OFF (2026-08-11 playtest): "hover outline is visible on some items on mobile
// but not all — we want it visible on all".
//
// The proxy WAS the reason. The explorer highlights whatever the pointer ray
// HITS, and a proxy box has no renderable, so proxied items could never glow —
// while theme/disaster spawns, which never used a proxy, always did. That split
// also broke the one-rule-per-item-TYPE principle: the same model behaved
// differently depending on where it came from.
//
// RE-ENABLED (2026-08-15) after the definitive A/B/C: three identical bags
// outside the club with (8) mesh-mask only, (9) box only, (10) mesh+box. On
// mobile, ONLY the box regions were tappable — the mesh-mask bag was near-dead
// and the boxed bags responded exactly where the box volume was (their base:
// the old proxy was origin-centred, half of it underground). Conclusion: the
// MOBILE client's pointer raycast against GLB mesh colliders is unreliable;
// primitive MeshCollider boxes work. Same class of mobile-client gap as
// LightSource / AvatarLocomotionSettings. The earlier fixes (maxDistance from
// the camera boom, reach-gate entity, scenery pointer sweep) were all real,
// but none of them could make a mesh collider hittable on a client that can't
// hit mesh colliders.
//
// Cost, accepted knowingly: proxied items lose the hover outline on MOBILE
// (the ray hits the box, which has nothing to outline). Desktop is unaffected
// — no proxy there, mesh path + outline as before.
//
// The proxy is now sized from MODEL_SIZE_M and LIFTED half its height, so the
// box wraps the whole mesh instead of the bottom half (the "only at the base
// of the bag" repro).
const USE_MOBILE_TAP_PROXY = true

// ── Blender-baked placements ──────────────────────────────────────────────────
// 20 of the scene's GLBs (MainStructure, Elevator, the cushions, stools, chaise,
// graffiti…) share one Transform position — the scene anchor — with their real
// placement baked into the mesh inside the GLB. For those entities the local
// origin is NOT under the visible mesh, so anything we attach at the origin
// (tap proxy, glow disc) would render at the middle of the dance floor: the
// "stray point lights" cluster, plus tap targets that clean a cushion from
// across the room. There is no runtime API for mesh bounds, so these items are
// forced onto the mesh-only path — which also gives them the native outline.
// The real fix is re-exporting those GLBs with origins under their meshes;
// this guard then becomes a no-op.
const BAKE_ANCHOR   = { x: 16, y: 0, z: 16 }
const BAKE_EPSILON  = 0.25

function hasBakedOffset(ent: Entity): boolean {
  const p = Transform.getOrNull(ent)?.position
  if (!p) return false
  return Math.abs(p.x - BAKE_ANCHOR.x) < BAKE_EPSILON &&
         Math.abs(p.y - BAKE_ANCHOR.y) < BAKE_EPSILON &&
         Math.abs(p.z - BAKE_ANCHOR.z) < BAKE_EPSILON
}

// ── GLB load watchdog (all interactive items) ─────────────────────────────────
// Field reports: a bin, then the ground-floor keys — invisible but (on mobile)
// still clickable, because the tap proxy is an independent collider that
// outlives a failed mesh load. A GLB whose fetch fails once stays failed: the
// explorer never retries. So every item routed through setupClickProxy gets
// watched: on FINISHED_WITH_ERROR / NOT_FOUND the GltfContainer is removed and
// re-added, forcing a re-fetch. Capped per entity so a truly broken asset
// can't reload-loop. Every state change is logged with the entity Name so the
// next field report comes with its own diagnosis attached.
const GLB_WATCH_INTERVAL_S = 5
const GLB_RELOAD_LIMIT     = 3
const GLB_STATE_NAME: Record<number, string> = {
  0: 'UNKNOWN', 1: 'LOADING', 2: 'NOT_FOUND', 3: 'FINISHED_WITH_ERROR', 4: 'FINISHED',
}
type GlbWatch = { entity: Entity; lastState: number; reloads: number; stateAgeS: number; lastSrc: string }
const glbWatch: GlbWatch[] = []
const glbWatched = new Set<Entity>()
let glbWatchAcc = 0
let glbWatchSystemAdded = false

/**
 * Exported (2026-08-15): theme slot + disaster entities need this watch too.
 * They never route through setupClickProxy (pointer events bind straight to
 * the replicated entity), so a failed/wedged slot GLB load had NO retry — and
 * slots delete-recreate their GltfContainer EVERY round, multiplying the load
 * opportunities that can fail on a memory-pressed phone. This was the "keys
 * invisible but stink visible" report: themed keys spawns were unwatched.
 */
export function watchGlb(entity: Entity): void {
  if (glbWatched.has(entity)) return
  glbWatched.add(entity)
  glbWatch.push({ entity, lastState: -1, reloads: 0, stateAgeS: 0, lastSrc: '' })
  if (!glbWatchSystemAdded) {
    glbWatchSystemAdded = true
    engine.addSystem(glbWatchdogSystem)
  }
}

// A load can also WEDGE without erroring: state sits at LOADING (or UNKNOWN)
// forever, which the error-only reload never touched — leaving that item
// missing for the session with a clean-looking log. Field case: one specific
// ground-floor recycling bin, repeatedly. Anything not FINISHED after
// GLB_STUCK_S gets the same forced reload as an outright failure.
const GLB_STUCK_S = 20

// Recreates run one tick after the delete. A same-tick delete+create with
// identical fields coalesces into an in-place PUT the renderer may treat as a
// no-op (same reason server.ts staggers its bin resets: "never a same-tick
// src swap"); the one-frame gap makes the delete real, so the create forces
// an actual re-fetch.
type GlbProps = Parameters<typeof GltfContainer.create>[1]
const pendingGlbRecreate: Array<{ entity: Entity; props: GlbProps }> = []

function glbWatchdogSystem(dt: number): void {
  if (pendingGlbRecreate.length > 0) {
    for (const r of pendingGlbRecreate) GltfContainer.createOrReplace(r.entity, r.props)
    pendingGlbRecreate.length = 0
  }
  glbWatchAcc += dt
  if (glbWatchAcc < GLB_WATCH_INTERVAL_S) return
  const tick = glbWatchAcc
  glbWatchAcc = 0
  for (const w of glbWatch) {
    // A NEW src on a watched entity (theme slots swap models every round) is a
    // brand-new load — it gets a fresh reload budget and a fresh stuck clock,
    // or a slot that ever exhausted its 3 reloads would stay unwatched for the
    // rest of the session across every later round's model.
    const srcNow = GltfContainer.getOrNull(w.entity)?.src ?? ''
    if (srcNow !== w.lastSrc) {
      w.lastSrc   = srcNow
      w.reloads   = 0
      w.stateAgeS = 0
    }
    const st = GltfContainerLoadingState.getOrNull(w.entity)?.currentState
    if (st === w.lastState) {
      w.stateAgeS += tick
    } else if (st !== undefined) {
      // Quiet on the happy path: every watched GLB reaching FINISHED at boot
      // flooded ~110 log lines that buried real signals (project cleanup).
      // Deviations and post-reload recoveries still log.
      if (st !== LoadingState.FINISHED || w.reloads > 0) {
        const label = Name.getOrNull(w.entity)?.value ?? `entity ${w.entity}`
        console.log(`[GLB] '${label}' load state → ${GLB_STATE_NAME[st] ?? st}`)
      }
      w.lastState = st
      w.stateAgeS = 0
    }
    if (st === undefined || st === LoadingState.FINISHED) continue
    if (w.reloads >= GLB_RELOAD_LIMIT) continue

    const failed = st === LoadingState.FINISHED_WITH_ERROR || st === LoadingState.NOT_FOUND
    const stuck  = (st === LoadingState.LOADING || st === LoadingState.UNKNOWN) && w.stateAgeS >= GLB_STUCK_S
    if (failed || stuck) {
      w.reloads++
      const g = GltfContainer.getOrNull(w.entity)
      if (!g?.src) continue
      const label = Name.getOrNull(w.entity)?.value ?? `entity ${w.entity}`
      console.log(`[GLB] '${label}' ${failed ? 'failed to load' : `stuck ${GLB_STATE_NAME[st]} ${Math.round(w.stateAgeS)}s`} — forcing reload ${w.reloads}/${GLB_RELOAD_LIMIT}`)
      // ALL fields preserved, not just src — recreating with {src} alone
      // dropped the visibleMeshesCollisionMask applyPointerMask had set, so a
      // reloaded item came back unclickable.
      pendingGlbRecreate.push({ entity: w.entity, props: { ...g } })
      GltfContainer.deleteFrom(w.entity)
      w.stateAgeS = 0
    }
  }
}

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
  pointerInteractive.add(gltfEnt)   // exempt from the scenery pointer sweep
  const mut = GltfContainer.getMutable(gltfEnt)
  const mask = g.visibleMeshesCollisionMask ?? 0
  mut.visibleMeshesCollisionMask =
    clear ? (mask & ~ColliderLayer.CL_POINTER) : (mask | ColliderLayer.CL_POINTER)
  // A GLB's authored _collider meshes default to PHYSICS+POINTER. An invisible
  // collider that wins the pointer ray has nothing to outline — which is why
  // some items never highlighted (playtest: "do I need to remove mesh
  // colliders?" — no: keep the collider for physics, strip its POINTER layer
  // so the ray lands on the visible mesh or the mobile proxy instead).
  mut.invisibleMeshesCollisionMask = ColliderLayer.CL_PHYSICS
  return true
}


// ── Scenery pointer sweep ─────────────────────────────────────────────────────
// Creator Hub authors PHYSICS+POINTER onto many scenery colliders — the twelve
// "Floor - Concrete" hulls, the bin stands, graffiti, sofa hulls. An invisible
// collider that carries CL_POINTER absorbs the pointer ray BEFORE it reaches an
// item lying on/near it, so taps only landed where the item poked past the hull
// (playtest: "I have to try multiple angles until I hit a spot I can
// interact with"). This strips CL_POINTER from every GLB that is not
// interactive, keeping physics intact.
//
// What survives untouched:
//  • anything that went through applyPointerMask (items, bins, dumpsters,
//    pedestal gear, restore props) — registered in `pointerInteractive`, and
//    applyPointerMask sets its masks explicitly anyway, so even an item swept
//    BEFORE its pop-in wiring self-heals;
//  • entities with authored PointerEvents (the Creator Hub sit spots);
//  • server-synced entities (ClutterSync) — client writes to those trip the
//    validateBeforeChange guard.
const pointerInteractive = new Set<Entity>()

export function sweepSceneryPointerColliders(): void {
  let swept = 0
  for (const [entity, g] of engine.getEntitiesWith(GltfContainer)) {
    if (pointerInteractive.has(entity)) continue
    if (PointerEvents.getOrNull(entity)) continue
    if (ClutterSync.getOrNull(entity)) continue
    // Undefined mask = renderer default, which is PHYSICS+POINTER for invisible
    // meshes and none for visible ones.
    const invisible = g.invisibleMeshesCollisionMask ?? (ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER)
    const visible   = g.visibleMeshesCollisionMask ?? 0
    const strippedInv = invisible & ~ColliderLayer.CL_POINTER
    const strippedVis = visible & ~ColliderLayer.CL_POINTER
    if (strippedInv === g.invisibleMeshesCollisionMask && strippedVis === visible) continue
    const mut = GltfContainer.getMutable(entity)
    mut.invisibleMeshesCollisionMask = strippedInv
    if (strippedVis !== visible) mut.visibleMeshesCollisionMask = strippedVis
    swept++
  }
  console.log(`[POINTER] swept ${swept} scenery GLBs — CL_POINTER stripped (physics kept)`)
}

// Creates the invisible, enlarged mobile tap target as a child of the item, so it
// inherits the item's position and scale (including being scaled away to nothing
// when the item is hidden — a cleaned item must not stay tappable).
//
// The emissive glow disc that used to accompany every proxy is GONE (playtest
// 2026-08-07): it existed to make items findable in mobile's darker render, a
// job the player point light now does — and each disc cost a plane + PBR
// material + per-hover material writes on the platform least able to afford it.
function createMobileTapTarget(gltfEnt: Entity): Entity {
  // Sized from the measured model table and lifted half a height, so the box
  // WRAPS the mesh (origin-at-base convention) instead of straddling the
  // floor. Unmeasured models get a conservative default.
  const src  = GltfContainer.getOrNull(gltfEnt)?.src ?? ''
  const name = src.slice(src.lastIndexOf('/') + 1).replace('.glb', '')
  const s    = Math.max(MOBILE_TAP_MIN_M, (MODEL_SIZE_M[name] ?? 0.7) * MOBILE_TAP_SCALE)
  const proxy = engine.addEntity()
  Transform.create(proxy, {
    parent:   gltfEnt,
    position: { x: 0, y: s * 0.45, z: 0 },
    scale:    { x: s, y: s, z: s },
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
// 2. On MOBILE ONLY, an enlarged child box as the tap target (see addBox).
//
// addBox now means "use an enlarged tap proxy on mobile" — desktop is always
// mesh-only so the hover outline is never suppressed (see the note in the body).
// Pass false for items whose GLB origin is offset from the visible mesh, where a
// child box at the entity origin would float away from what the player sees.
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
  const useMobileProxy = USE_MOBILE_TAP_PROXY && isMobile() && addBox && !hasBakedOffset(gltfEnt)

  watchGlb(gltfEnt)

  if (!applyPointerMask(gltfEnt, useMobileProxy)) {
    // Bounded: a GLB that never loads must not leak a per-frame system forever
    // (the watchdog handles the reload story; 30s covers any honest stream).
    let waitedS = 0
    const waitForGltf = (dt: number) => {
      waitedS += dt
      if (applyPointerMask(gltfEnt, useMobileProxy) || waitedS > 30) engine.removeSystem(waitForGltf)
    }
    engine.addSystem(waitForGltf)
  }
  if (useMobileProxy) return createMobileTapTarget(gltfEnt)

  // Mesh only — never a box (see USE_MOBILE_TAP_PROXY above). The box's other
  // job, being hittable before the mesh finishes streaming, is already covered:
  // every caller registers through requestSetup, which waits for the
  // GltfContainer, and items pop in via the spawn director.
  return gltfEnt
}
