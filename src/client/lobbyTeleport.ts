// Player repositioning around the match lifecycle:
//   • match → lobby : bring everyone back to the entrance to re-gather.
//   • lobby → match : nudge players who are STILL at the entrance onto the dance
//                     floor so they start in the action — but leave anyone who has
//                     already wandered into the club where they chose to be.
//
// Both are per-client (each client moves its own player) and fire once on the
// transition. Never fires on the initial boot lobby (players already spawn there).

import { engine, Transform } from '@dcl/sdk/ecs'
import { movePlayerTo } from '~system/RestrictedActions'
import { GameState } from '../shared/schemas'

// Centre of SpawnArea1 in scene.json, facing the centre of the scene.
const ENTRANCE_POS    = { x: 16, y: 0, z: 28.67 }
const ENTRANCE_TARGET = { x: 16, y: 1, z: 16 }

// On match start, players within this XZ distance of the entrance are considered
// "still at the door" and get moved onto the dance floor; anyone further in is left.
const ENTRANCE_RADIUS = 8
const DANCEFLOOR_POS    = { x: 14, y: 1, z: 16 }
const DANCEFLOOR_TARGET = { x: 16, y: 1, z: 8 }   // face deeper into the club

function nearEntrance(): boolean {
  const p = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!p) return false
  const dx = p.x - ENTRANCE_POS.x
  const dz = p.z - ENTRANCE_POS.z
  return Math.sqrt(dx * dx + dz * dz) <= ENTRANCE_RADIUS
}

export function initLobbyTeleport(): void {
  let lastPhase = ''
  engine.addSystem(() => {
    let phase = ''
    for (const [, gs] of engine.getEntitiesWith(GameState)) { phase = gs.phase; break }
    if (phase === '' || phase === lastPhase) return
    const prev = lastPhase
    lastPhase = phase

    // Match ended → re-gather at the entrance.
    if (phase === 'lobby' && (prev === 'playing' || prev === 'open')) {
      movePlayerTo({ newRelativePosition: ENTRANCE_POS, avatarTarget: ENTRANCE_TARGET })
    }

    // Match started → drop entrance-stayers onto the dance floor; leave wanderers.
    if (phase === 'playing' && prev === 'lobby' && nearEntrance()) {
      movePlayerTo({ newRelativePosition: DANCEFLOOR_POS, avatarTarget: DANCEFLOOR_TARGET })
    }
  })
}
