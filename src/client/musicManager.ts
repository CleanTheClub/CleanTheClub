// Background music manager — switches tracks based on game phase.
//
//  playing → Town.mp3      (background cleaning atmosphere)
//  open    → Party.mp3     (celebration — doors open)
//  playing → Town.mp3      (new round — back to work)
//
// Drop your party track at the path defined by SND_PARTY below.
// Both tracks loop continuously; only one plays at a time.

import { engine, Entity, Transform, AudioSource } from '@dcl/sdk/ecs'
import { timers } from '@dcl/sdk/ecs'
import { GameState } from '../shared/schemas'

// ── Track paths ───────────────────────────────────────────────────────────────
const SND_TOWN  = 'assets/asset-packs/ambient_sound_-_market/Town.mp3'
const SND_PARTY = 'assets/scene/Sounds/partySound.mp3'

// ── Volume ────────────────────────────────────────────────────────────────────
const VOL_TOWN  = 1.0
const VOL_PARTY = 1.0

// ── Position — centre of the parcel, slightly elevated ───────────────────────
const MUSIC_POS = { x: 16, y: 3, z: 16 }

// ─────────────────────────────────────────────────────────────────────────────

let townEntity:  Entity
let partyEntity: Entity

function play(entity: Entity) {
  // false → true toggle is the standard DCL AudioSource retrigger pattern
  AudioSource.getMutable(entity).playing = false
  timers.setTimeout(() => { AudioSource.getMutable(entity).playing = true }, 0)
}

function stop(entity: Entity) {
  AudioSource.getMutable(entity).playing = false
}

export function initMusicManager(): void {
  townEntity = engine.addEntity()
  Transform.create(townEntity, { position: MUSIC_POS })
  AudioSource.create(townEntity, {
    audioClipUrl: SND_TOWN,
    playing:      true,
    loop:         true,
    volume:       VOL_TOWN,
  })

  partyEntity = engine.addEntity()
  Transform.create(partyEntity, { position: MUSIC_POS })
  AudioSource.create(partyEntity, {
    audioClipUrl: SND_PARTY,
    playing:      false,
    loop:         true,
    volume:       VOL_PARTY,
  })

  console.log('[Music] Manager ready — Town playing')

  // Keep both music entities at the player's position so volume stays
  // consistent regardless of where in the scene the player is standing.
  engine.addSystem(() => {
    const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? MUSIC_POS
    Transform.getMutable(townEntity).position  = { x: pos.x, y: pos.y, z: pos.z }
    Transform.getMutable(partyEntity).position = { x: pos.x, y: pos.y, z: pos.z }
  })

  // Phase watcher
  let lastPhase = ''
  engine.addSystem(() => {
    for (const [, gs] of engine.getEntitiesWith(GameState)) {
      if (gs.phase === lastPhase) return
      const prev = lastPhase
      lastPhase  = gs.phase

      if (gs.phase === 'open' && prev === 'playing') {
        stop(townEntity)
        play(partyEntity)
        console.log('[Music] → Party track')
      } else if (gs.phase === 'playing' && prev === 'open') {
        stop(partyEntity)
        play(townEntity)
        console.log('[Music] → Town track')
      }
      return
    }
  })
}
