// Spectate mode — lets a waiting player watch the shift instead of staring at
// a black scrim.
//
// While a round runs, non-enrolled players sit behind the full-screen waiting
// overlay with nothing to do but read the countdown. Spectate hands them a
// camera instead: a VirtualCamera orbits the cleaner being watched, with
// next/prev cycling through everyone actively cleaning. Watching real cleaning
// doubles as onboarding — a new player sees what the game IS before their first
// shift starts.
//
// Camera approach: VirtualCamera + MainCamera takeover (the only way scene code
// may drive the view; the camera is otherwise read-only). The rig is two
// entities — a camera whose Transform we move every frame, and a focus entity
// the camera looks at via lookAtEntity, held at chest height so the engine owns
// rotation smoothing and we only ever animate positions.
//
// The camera NEVER moves on its own: it holds a stable world-space angle and
// only translates to follow the target. An earlier version drifted in a slow
// automatic circle — motion the player didn't command, the textbook motion-
// sickness trigger, and it swept the camera through walls (playtest). Movement
// is player-commanded instead: ORBIT/ZOOM buttons step the angle and distance,
// and the position lerp turns each step into a short glide. Steps rather than
// drag because drag deltas fight the react-ecs UI and the mobile joystick, and
// a hold-to-rotate whose release event goes missing is the drift bug again.
//
// Wall handling: each frame a ray runs from the focus point out along the
// camera arm; if scene geometry is in the way the arm shortens to just in front
// of the hit (instantly — a camera inside a wall can't be eased out of), and
// relaxes back to full length smoothly once the path clears.
//
// Defensive shape copied from field-tested cinematic-camera code: the MainCamera
// assign is try/caught (explorers may refuse it), a one-shot probe ~1.5s in
// compares the real render camera against the virtual one and logs whether the
// takeover was honored, and every exit path funnels through one release function
// so the player can never be left trapped in a broken camera. Movement input is
// frozen with InputModifier while spectating (a hidden avatar walking blind into
// the club was worse), and released on every exit.

import {
  ColliderLayer, engine, Entity, InputModifier, MainCamera, PlayerIdentityData,
  RaycastQueryType, raycastSystem, timers, Transform, VirtualCamera,
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { currentPhase, gameState } from './phaseGate'
import { isActive } from './participation'
import { rankInfoFor } from './rankBadgeSystem'

// ── Tuning ────────────────────────────────────────────────────────────────────
const FOCUS_HEIGHT_M   = 1.4    // look-at point — chest, not feet
const CAM_ABOVE_FOCUS_M = 0.7   // camera rides this far above the focus point
// Player-commanded camera steps. 45° = 8 taps for a full circle; the position
// lerp below glides each step over ~half a second.
const ORBIT_STEP_RAD = Math.PI / 4
const RADIUS_DEFAULT_M = 4.0
const RADIUS_MIN_M     = 2.4
const RADIUS_MAX_M     = 7.2
const ZOOM_STEP_M      = 0.8
// Wall clamp: stop the arm this far short of the hit so the near plane never
// touches the surface, and never collapse closer than ARM_MIN (inside the
// target's head). Shortening is instant; re-extending eases (EXTEND_K).
const WALL_MARGIN_M = 0.35
const ARM_MIN_M     = 0.9
const EXTEND_K      = 1.5
// Exponential smoothing rates (higher = snappier). The camera chases its orbit
// point slower than the focus chases the avatar, so a sprinting cleaner reads
// as a cameraman keeping up rather than a rigid attachment.
const CAM_LERP_K   = 3.0
const FOCUS_LERP_K = 6.0
const ENGAGE_TRANSITION_S = 0.8   // fly-in/out between real and virtual camera
const RESCAN_S     = 0.5    // candidate roster scan cadence
const RAY_INTERVAL_S = 0.15 // wall-ray cadence — stale-tolerant, camArm eases
const NO_TARGET_GRACE_S = 8 // targets gone/unstreamed this long → give the camera back
                            // (was 3 — too short for a mobile avatar transform to stream in)
const GS_NULL_EXIT_S = 2    // GameState missing this long → bail out safely
const PROBE_AT_S   = 1.5    // after the fly-in; ~0 distance means honored

type TargetInfo = { name: string; title: string; rank: number }

// A remote avatar's Transform can exist while reading EXACTLY (0,0,0) — seen
// on mobile while the avatar streams in or comms hiccup: the component is
// there, the data hasn't arrived. (0,0,0) is the scene CORNER, so chasing it
// swept the whole rig to the edge of the scene, nowhere near the target
// (mobile live test). Exact float zero on all three axes never happens for a
// real standing player, so it's safe to treat as "no position yet".
type Pos = { x: number; y: number; z: number }
function validPos(p: Pos | null | undefined): Pos | null {
  if (!p) return null
  if (p.x === 0 && p.y === 0 && p.z === 0) return null
  return p
}

let camEntity:   Entity | null = null
let focusEntity: Entity | null = null

let spectating   = false
let probed       = false
let elapsed      = 0
let orbitAngle   = 0
let radius       = RADIUS_DEFAULT_M   // player-chosen zoom (before wall clamp)
let rayHitLen: number | null = null   // latest wall-ray hit distance, if any
let camArm       = RADIUS_DEFAULT_M   // smoothed actual arm length in use
let rescanAcc    = 0
let rayAcc       = 0
let noTargetFor  = 0
let gsNullFor    = 0

// Candidates are the OTHER players in the scene, preferred down to those the
// server flags as cleaning this round (roster `c`). If no flag has arrived yet
// (older server, broadcast in flight) everyone qualifies — a live camera on a
// bystander beats a dead button.
let candidates: Array<{ entity: Entity; address: string }> = []
let targetIdx  = 0
let targetEntity:  Entity | null = null
let targetAddress: string = ''

export function isSpectating(): boolean { return spectating }

/** How many players could be watched right now — drives the WATCH button.
 *  Reads the cached roster (refreshed on the system's 0.5s cadence): this is
 *  called from the UI render every frame, and a full entity scan + sort there
 *  was measurable GC churn on mobile. */
export function spectateTargetCount(): number {
  return candidates.length
}

/** Name/title of the player being watched, for the HUD chip. */
export function spectateTargetInfo(): TargetInfo | null {
  if (!spectating || !targetAddress) return null
  const info = rankInfoFor(targetAddress)
  if (info) return { name: info.name, title: info.title, rank: info.rank }
  return { name: `${targetAddress.slice(0, 6)}…`, title: '', rank: 0 }
}

function refreshCandidates(): void {
  const flagged: Array<{ entity: Entity; address: string }> = []
  const anyone:  Array<{ entity: Entity; address: string }> = []
  let flagsKnown = false

  for (const [entity, data] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
    if (entity === engine.PlayerEntity) continue
    // NO position filter here. It briefly lived here and starved the WATCH
    // button on mobile, where remote avatar transforms read the origin
    // sentinel for LONG stretches, not just streaming blips ("watch live not
    // working on mobile, fine on desktop"). Candidates are listable on
    // presence alone; only the CAMERA paths must refuse to chase an origin.
    const address = data.address.toLowerCase()
    const info = rankInfoFor(address)
    if (info?.cleaning !== undefined) flagsKnown = true
    anyone.push({ entity, address })
    if (info?.cleaning) flagged.push({ entity, address })
  }

  // Flags known but nobody flagged: trust presence over the roster — a flag
  // can be stale (reconnect re-enrol) or missing (cleaner without a display
  // name is skipped by the broadcast), and a live camera on a bystander beats
  // ejecting the spectator while someone is visibly cleaning.
  const list = flagsKnown && flagged.length > 0 ? flagged : anyone
  // Stable order so next/prev walks the same ring every time.
  list.sort((a, b) => (a.address < b.address ? -1 : 1))
  candidates = list

  // Keep the index pointing at the current target across roster churn.
  if (targetAddress) {
    const i = candidates.findIndex((c) => c.address === targetAddress)
    if (i >= 0) targetIdx = i
  }
  if (targetIdx >= candidates.length) targetIdx = 0
}

function setTarget(idx: number): void {
  const c = candidates[idx]
  if (!c) return
  targetIdx     = idx
  targetEntity  = c.entity
  targetAddress = c.address
  // Camera and focus keep their current positions — the per-frame lerp swoops
  // them across to the new target, which IS the transition.
}

export function nextSpectateTarget(dir: 1 | -1): void {
  if (!spectating) return
  refreshCandidates()
  if (candidates.length === 0) return
  setTarget((targetIdx + dir + candidates.length) % candidates.length)
}

/** Step the camera around the target by one notch — the lerp glides it there. */
export function stepSpectateOrbit(dir: 1 | -1): void {
  if (!spectating) return
  orbitAngle += dir * ORBIT_STEP_RAD
}

/** Step the camera closer to (-1) or further from (+1) the target. */
export function stepSpectateZoom(dir: 1 | -1): void {
  if (!spectating) return
  radius = Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, radius + dir * ZOOM_STEP_M))
}

/** Try to start spectating. False = nobody watchable RIGHT NOW (avatar still
 *  streaming, or no cleaners) — the caller says so instead of a dead button. */
export function enterSpectate(): boolean {
  if (spectating || !camEntity || !focusEntity) return false
  refreshCandidates()
  if (candidates.length === 0) return false

  setTarget(Math.min(targetIdx, candidates.length - 1))
  // Target position may not have streamed yet (mobile). Enter anyway from a
  // club-centre fallback — the per-frame chase swoops onto the real target the
  // moment its transform turns valid, and the (extended) no-target grace gives
  // it time before bailing. Refusing here was a dead WATCH button on phones.
  const tPos = validPos(Transform.getOrNull(targetEntity!)?.position) ?? { x: 16, y: 1.2, z: 16 }

  // Start the orbit on the side the spectator is already viewing from, so the
  // fly-in is a short hop rather than a swing around the room. Fallback only if
  // the camera transform hasn't replicated yet.
  const camNow = Transform.getOrNull(engine.CameraEntity)?.position
  orbitAngle = camNow
    ? Math.atan2(camNow.x - tPos.x, camNow.z - tPos.z)
    : Math.random() * Math.PI * 2
  radius = RADIUS_DEFAULT_M
  camArm = armLengthFor(radius)
  rayHitLen = null

  const focus = Vector3.create(tPos.x, tPos.y + FOCUS_HEIGHT_M, tPos.z)
  Transform.getMutable(focusEntity).position = focus
  Transform.getMutable(camEntity).position = Vector3.add(focus, armOffset(camArm))

  // A refused assign means no camera and therefore no mode — spectating stays
  // false and the waiting overlay is untouched.
  try {
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camEntity })
  } catch (err) {
    console.log(`[SPECTATE] MainCamera assign FAILED: ${err}`)
    return false
  }

  // Freeze locomotion: the avatar stays parked where the player left it instead
  // of wandering blind while the camera is elsewhere.
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: { $case: 'standard', standard: { disableAll: true } },
  })

  spectating  = true
  probed      = false
  elapsed     = 0
  noTargetFor = 0
  gsNullFor   = 0
  rayAcc      = RAY_INTERVAL_S   // first wall-ray fires immediately
  console.log(`[SPECTATE] enter — watching ${targetAddress} (${candidates.length} candidates)`)
  return true
}

export function exitSpectate(reason: string): void {
  if (!spectating) return
  spectating = false
  try {
    MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  } catch (err) {
    console.log(`[SPECTATE] MainCamera release FAILED: ${err}`)
  }
  InputModifier.deleteFrom(engine.PlayerEntity)
  if (focusEntity) {
    // Twice: registration is deferred one tick inside the raycast helper, so a
    // ray registered this frame could outlive an immediate removal.
    const fe = focusEntity
    raycastSystem.removeRaycasterEntity(fe)
    timers.setTimeout(() => raycastSystem.removeRaycasterEntity(fe), 100)
  }
  rayHitLen     = null
  targetEntity  = null
  targetAddress = ''
  console.log(`[SPECTATE] exit reason=${reason} after ${elapsed.toFixed(1)}s`)
}

// The camera arm runs from the focus point up-and-out to the camera: horizontal
// reach is the player's zoom radius, vertical rise is fixed. Wall clamping
// shortens the whole arm along its direction, so a pulled-in camera slides
// down the same sight line instead of hovering at full height over the target.
function armLengthFor(r: number): number {
  return Math.sqrt(r * r + CAM_ABOVE_FOCUS_M * CAM_ABOVE_FOCUS_M)
}

function armDir(): Vector3 {
  const full = armLengthFor(radius)
  return Vector3.create(
    (Math.sin(orbitAngle) * radius) / full,
    CAM_ABOVE_FOCUS_M / full,
    (Math.cos(orbitAngle) * radius) / full,
  )
}

function armOffset(len: number): Vector3 {
  return Vector3.scale(armDir(), len)
}

// ── Stray-camera watchdog ─────────────────────────────────────────────────────
// The scene ships a leftover template smart item — a "Fixed View Camera" plus a
// CameraFocus script on the Video Screen with maxDistance 150 — that swaps the
// player into a FIXED VirtualCamera on click. From 150m away, on mobile, a
// stray tap traps the player in a camera they cannot rotate, and escaping means
// hitting the same small target again (field report 2026-08-18: "camera got
// stuck, couldn't rotate, fixed itself after running outside and toggling
// first/third person").
//
// Spectate is the ONLY legitimate owner of MainCamera in this scene, so any
// MainCamera we did not set is a trap: clear it. Checked on the same cheap
// cadence as the roster rescan. The real fix is deleting that script in Creator
// Hub — this is the belt-and-braces so a player can never be stuck again.
function clearStrayCamera(): void {
  if (spectating) return
  const mc = MainCamera.getOrNull(engine.CameraEntity)
  if (!mc?.virtualCameraEntity) return
  console.log('[SPECTATE] stray VirtualCamera detected while not spectating — releasing the camera')
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
}

function spectateSystem(dt: number): void {
  // Candidate roster refresh runs whether or not the camera is live — the
  // waiting overlay's WATCH button reads the cached count.
  rescanAcc += dt
  if (rescanAcc >= RESCAN_S) {
    rescanAcc = 0
    refreshCandidates()
    clearStrayCamera()
  }

  if (!spectating || !camEntity || !focusEntity) return
  elapsed += dt

  // ── Watchdogs — every way this mode must end, checked every frame ───────────
  // Promoted into the shift: the round started and this player is cleaning now.
  if (isActive()) { exitSpectate('promoted'); return }
  // Club emptied back to the lobby screen, which expects the normal camera.
  if (currentPhase() === 'lobby') { exitSpectate('lobby'); return }
  // GameState gone (server redeploy / CRDT resync): the pre-sync UI branch
  // hides the STOP button in exactly that state, so without this exit the
  // player would be stuck behind the connecting scrim with input disabled.
  if (!gameState()) {
    gsNullFor += dt
    if (gsNullFor >= GS_NULL_EXIT_S) { exitSpectate('gamestate_lost'); return }
  } else {
    gsNullFor = 0
  }

  // One-shot probe: did the explorer actually honor the takeover? Purely a
  // diagnostic — the STOP button and watchdogs work either way.
  if (!probed && elapsed >= PROBE_AT_S) {
    probed = true
    const cam  = Transform.getOrNull(engine.CameraEntity)?.position
    const virt = Transform.getOrNull(camEntity)?.position
    if (cam && virt) {
      const d = Vector3.distance(cam, virt)
      console.log(`[SPECTATE] probe dist=${d.toFixed(2)} honored=${d < 2}`)
    }
  }

  // ── Target upkeep ────────────────────────────────────────────────────────────
  // Current target left the scene or stopped cleaning → move on, don't drop out.
  if (!candidates.some((c) => c.address === targetAddress)) {
    if (candidates.length > 0) setTarget(targetIdx % candidates.length)
    else targetEntity = null
  }

  const tPos = targetEntity ? validPos(Transform.getOrNull(targetEntity)?.position) : null
  if (!tPos) {
    // Nobody to watch — or the target's transform went degenerate (origin
    // sentinel, see validPos). Hold the last shot briefly (a cleaner may be
    // mid-respawn, mid-stream, or the roster mid-refresh) before giving the
    // camera back; the 0.5s roster rescan drops still-degenerate targets and
    // setTarget moves on to a live one.
    noTargetFor += dt
    if (noTargetFor >= NO_TARGET_GRACE_S) exitSpectate('no_targets')
    return
  }
  noTargetFor = 0

  // ── Camera motion ────────────────────────────────────────────────────────────
  // Focus first: the wall ray and the camera both hang off its smoothed position.
  const focusT = Transform.getMutable(focusEntity)
  // Frame-rate independent smoothing: same feel at 30 and 60 fps.
  const fk = 1 - Math.exp(-FOCUS_LERP_K * dt)
  focusT.position = Vector3.lerp(
    focusT.position,
    Vector3.create(tPos.x, tPos.y + FOCUS_HEIGHT_M, tPos.z),
    fk,
  )

  // Wall ray: focus → out along the arm. Re-registered on a short throttle —
  // each registration is a one-shot (create + auto-remove of two components),
  // so doing it per frame was pure churn, and the result is a frame stale and
  // eased by camArm anyway.
  const fullArm = armLengthFor(radius)
  const dir = armDir()
  rayAcc += dt
  if (rayAcc >= RAY_INTERVAL_S) {
    rayAcc = 0
    raycastSystem.registerGlobalDirectionRaycast(
      {
        entity: focusEntity,
        opts: {
          queryType:     RaycastQueryType.RQT_HIT_FIRST,
          direction:     dir,
          maxDistance:   fullArm + WALL_MARGIN_M,
          collisionMask: ColliderLayer.CL_PHYSICS,   // what players collide with = what the camera shouldn't pass
        },
      },
      (result) => {
        if (!spectating) return   // late result after exit — ignore
        rayHitLen = result.hits.length > 0 ? result.hits[0].length : null
      },
    )
  }

  // Shorten instantly (a camera inside a wall can't be eased back out of it),
  // relax back to full length smoothly once the path clears.
  const clamped = rayHitLen !== null
    ? Math.max(ARM_MIN_M, Math.min(fullArm, rayHitLen - WALL_MARGIN_M))
    : fullArm
  camArm = clamped < camArm
    ? clamped
    : camArm + (clamped - camArm) * (1 - Math.exp(-EXTEND_K * dt))

  const camT = Transform.getMutable(camEntity)
  const desired = Vector3.add(focusT.position, Vector3.scale(dir, camArm))
  const ck = 1 - Math.exp(-CAM_LERP_K * dt)
  camT.position = Vector3.lerp(camT.position, desired, ck)
}

// Client-only init (called from setup.ts). Entities must NOT be created at
// module scope — the bundle is shared and module-level engine calls would run
// on the server engine too.
export function initSpectateSystem(): void {
  focusEntity = engine.addEntity()
  Transform.create(focusEntity, { position: Vector3.create(16, 1.4, 16) })

  camEntity = engine.addEntity()
  Transform.create(camEntity, { position: Vector3.create(16, 3, 12) })
  VirtualCamera.create(camEntity, {
    lookAtEntity: focusEntity,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(ENGAGE_TRANSITION_S) },
  })

  engine.addSystem(spectateSystem)
}
