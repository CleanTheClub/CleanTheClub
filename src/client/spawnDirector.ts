// Staggered, sequential bring-up + spawn-in for scene items.
//
// At scene load / round start, ~80 items (glasses, bottles, rubbish, sticky
// patches, restore items) all want to set up + appear at once.  Doing it in one
// frame spikes the frame time (collider creation + pointer registration) AND races
// the streaming of their GltfContainers — leaving items briefly un-clickable.
//
// This director serialises the work GLOBALLY across every system:
//   • SETUP queue  — heavy one-time work (setupClickProxy + pointer handlers).
//                    At most ONE ready task runs per SETUP_STAGGER_S, so the cost
//                    is smeared over time instead of spiking.  "Wait till ready":
//                    a task only runs once its isReady() reports the GLB streamed.
//   • SPAWN queue  — the springy visual pop-in (sticky patches), one per SPAWN_S.
//
// Ready-order: we run the first READY task and skip any not-ready yet, so one slow
// loader never blocks the rest of the queue.

import { engine, Entity } from '@dcl/sdk/ecs'
import { platformSettled } from './platformWait'
import { popIn } from './itemFx'

type SetupReq = {
  isReady: () => boolean
  run:     () => void
}
type SpawnReq = {
  entity:    Entity
  toScale:   { x: number; y: number; z: number }
  isReady:   () => boolean
  onPopped?: () => void
  /** Checked just before the pop runs — a queued spawn whose item was cleaned
   *  in the meantime must be dropped, not popped back into view. */
  isCancelled?: () => boolean
}

// Tunables — raise SETUP_STAGGER_S if loading still spikes (slower, gentler).
const SETUP_STAGGER_S = 0.07   // seconds between successive item set-ups
const SPAWN_STAGGER_S = 0.12   // seconds between successive pops
const POP_S           = 0.45   // pop tween duration

// Setup decides pointer-collider shape per platform (see setupClickProxy) —
// hold the setup queue until the shared platform gate settles.

const setupQueue: SetupReq[] = []
const spawnQueue: SpawnReq[] = []
let setupAcc     = SETUP_STAGGER_S   // let the first ready task run promptly
let spawnAcc     = SPAWN_STAGGER_S
let systemAdded  = false

function platformReady(_dt: number): boolean {
  return platformSettled()
}

function ensureSystem(): void {
  if (systemAdded) return
  systemAdded = true
  engine.addSystem(directorTick)
}

// Queue a one-time, GLB-gated setup task (collider + pointer handlers, etc.).
export function requestSetup(req: SetupReq): void {
  setupQueue.push(req)
  ensureSystem()
}

// Queue a staggered visual pop-in (scale 0 → toScale) once isReady() is true.
export function requestSpawn(req: SpawnReq): void {
  // Dedupe by entity so a re-trigger (e.g. scene re-entry) can't double-enqueue.
  if (spawnQueue.some((q) => q.entity === req.entity)) return
  spawnQueue.push(req)
  ensureSystem()
}

function runFirstReady<T extends { isReady: () => boolean }>(q: T[]): T | undefined {
  for (let i = 0; i < q.length; i++) {
    if (q[i].isReady()) return q.splice(i, 1)[0]
  }
  return undefined
}

function directorTick(dt: number): void {
  // ── Setup queue (priority — the heavy work we most want to spread) ───────────
  if (setupQueue.length > 0 && platformReady(dt)) {
    setupAcc += dt
    if (setupAcc >= SETUP_STAGGER_S) {
      const task = runFirstReady(setupQueue)
      if (task) {
        setupAcc = 0
        task.run()
        return   // one action per tick keeps the work strictly serial
      }
    }
  }

  // ── Spawn queue (visual pops) ────────────────────────────────────────────────
  if (spawnQueue.length > 0) {
    // Cancelled requests leave the queue without popping (cleaned while queued).
    for (let i = spawnQueue.length - 1; i >= 0; i--) {
      if (spawnQueue[i].isCancelled?.()) spawnQueue.splice(i, 1)
    }
    spawnAcc += dt
    if (spawnAcc >= SPAWN_STAGGER_S) {
      const req = runFirstReady(spawnQueue)
      if (req) {
        spawnAcc = 0
        popIn(req.entity, req.toScale, POP_S, req.onPopped)
      }
    }
  }
}
