// Scene asset preloading via the platform's AssetLoad component.
//
// WHAT BELONGS HERE: assets that are NOT placed in the scene composite (so the
// engine never loads them at boot) but are needed INSTANTLY the first time
// gameplay asks for them. Everything the composite places is already resident —
// preloading it again would only burn memory. That rules out every themed spawn
// model: all 24 are placed props, so they cost nothing to "warm".
//
// AssetLoad replaces the old trick of parking hidden entities that hold a
// GltfContainer purely to stop the engine evicting the asset (the engine drops
// a GLB once nothing references it). AssetLoad states that outright: once
// loaded, the asset stays. Which also means it is NOT free — every entry here
// is resident for the whole session, so keep the list short and justified.

import { engine, Entity, AssetLoad, AssetLoadLoadingState, LoadingState } from '@dcl/sdk/ecs'

const PRELOAD_ASSETS: string[] = [
  // Emotes: each plays on a beat where a stall is obvious — the first pickup,
  // the first mop, the round-end dance, the carry pose. None is placed in the
  // scene, so without this the first use of each pays the full stream cost.
  'assets/scene/Emotes/PickUp_Anim_emote.glb',
  'assets/scene/Emotes/Mopping_emote.glb',
  'assets/scene/Emotes/PartyPhone_emote.glb',
  'assets/scene/Emotes/Carry_emote.glb',
  // The full Janitor Gear ladder. None of these are placed in the scene any
  // more (they used to sit parked in the composite purely to stay loaded, at
  // ~13k placed triangles); AssetLoad is the supported way to keep them
  // resident. Each appears the INSTANT a gear swap lands — a purchase
  // mid-shift, or another player's carry visual — so a stream stall would sit
  // exactly on the reward moment.
  'assets/scene/Models/Box_Wearable/Box_Wearable.glb',
  'assets/scene/Models/Milk_Crate/Milk_Crate.glb',
  'assets/scene/Models/Janitor_Caddy/Janitor_Caddy.glb',
  'assets/scene/Models/Gold_Wheelie_Bin/Gold_Wheelie_Bin.glb',
  'assets/scene/Models/Vacuum/Vacuum.glb',
]

let preloadEntity: Entity | null = null

/** (Re)issues the preload request, forcing a re-fetch if assets were evicted. */
function requestPreload(): void {
  if (preloadEntity === null) preloadEntity = engine.addEntity()
  AssetLoad.createOrReplace(preloadEntity, { assets: PRELOAD_ASSETS })
}

export function initPreload(): void {
  requestPreload()

  // Report once when everything has settled, and name anything that failed —
  // a typo'd path would otherwise fail silently and only show up as a stall
  // months later.
  let acc = 0
  const watch = (dt: number) => {
    acc += dt
    if (acc < 1) return
    acc = 0
    let done = 0
    const failed: string[] = []
    for (const [, states] of engine.getEntitiesWith(AssetLoadLoadingState)) {
      for (const s of states) {
        if (s.currentState === LoadingState.FINISHED) done++
        else if (s.currentState === LoadingState.NOT_FOUND || s.currentState === LoadingState.FINISHED_WITH_ERROR) {
          failed.push(`${s.asset} (${s.currentState === LoadingState.NOT_FOUND ? 'NOT_FOUND' : 'ERROR'})`)
        }
      }
    }
    if (done + failed.length < PRELOAD_ASSETS.length) return   // still streaming
    if (failed.length > 0) console.log(`[PRELOAD] FAILED: ${failed.join(', ')}`)
    console.log(`[PRELOAD] ${done}/${PRELOAD_ASSETS.length} assets resident`)
    engine.removeSystem(watch)
  }
  engine.addSystem(watch)
}

/**
 * Re-issue the preload after a mobile app-switch.
 *
 * AssetLoad keeps assets resident against ENGINE eviction, but a suspended
 * mobile client can still have its memory reclaimed by the OS — which is the
 * failure the emote re-warm was built for. Replacing the component forces the
 * runtime to fetch again.
 */
export function repreload(): void {
  if (preloadEntity === null) return
  AssetLoad.deleteFrom(preloadEntity)
  requestPreload()
}
