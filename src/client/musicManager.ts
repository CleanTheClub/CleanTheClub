// Background music manager — switches tracks based on game phase.
//
//  playing        → Town.mp3                   (background cleaning atmosphere)
//  open (normal)  → partySound.mp3             (regular intermission celebration)
//  open (finale)  → FinalRoundCelebration.mp3  (the big final celebration)
//  playing        → Town.mp3                   (new round — back to work)
//
// The finale track plays INSTEAD of the party track by default.  Set
// FINALE_LAYER_PARTY = true to layer the party track underneath it instead.
// All tracks loop; only the relevant one(s) play at a time.

import { engine, Entity, Transform, AudioSource, EasingFunction } from '@dcl/sdk/ecs'
import { timers } from '@dcl/sdk/ecs'
import { gameState } from './phaseGate'
import { tweenValue } from './tween'

// ── Track paths ───────────────────────────────────────────────────────────────
const SND_TOWN   = 'assets/asset-packs/ambient_sound_-_market/Town.mp3'
const SND_PARTY  = 'assets/scene/Sounds/partySound.mp3'
const SND_FINALE = 'assets/scene/Sounds/FinalRoundCelebration.mp3'

// ── Volume ────────────────────────────────────────────────────────────────────
const VOL_TOWN   = 1.0
const VOL_PARTY  = 1.0
const VOL_FINALE = 1.0

// When true, the party track keeps playing under the finale track (layered).
// When false (default), the finale track plays on its own.
const FINALE_LAYER_PARTY = false

// ─────────────────────────────────────────────────────────────────────────────

let townEntity:   Entity
let partyEntity:  Entity
let finaleEntity: Entity

// ── Fade engine (built on tweenValue) ─────────────────────────────────────────
// Each track can ease its AudioSource volume toward a target.  A fade-out that
// reaches 0 stops the track; a fade-in starts it immediately (at volume 0) then
// ramps up.  This drives the gentle "fade back into round mode" transition out
// of the finale.  We track each entity's active tween so a new transition can
// cancel one still in flight, and remember each track's full volume so play()
// can restore it after a fade-out left the volume at 0.
const FADE_S = 2.0

const baseVol     = new Map<Entity, number>()
const activeFades = new Map<Entity, (dt: number) => void>()

function cancelFade(entity: Entity) {
  const sys = activeFades.get(entity)
  if (sys) { engine.removeSystem(sys); activeFades.delete(entity) }
}

function fadeTo(entity: Entity, targetVol: number, durationS = FADE_S) {
  cancelFade(entity)
  const src = AudioSource.getMutable(entity)
  // Starting a fade-in from silence — retrigger and begin at volume 0.
  if (targetVol > 0 && !src.playing) {
    src.playing = false
    src.volume  = 0
    timers.setTimeout(() => { AudioSource.getMutable(entity).playing = true }, 0)
  }
  const from = src.volume ?? 0
  const sys = tweenValue(
    from,
    targetVol,
    durationS,
    (v) => { AudioSource.getMutable(entity).volume = v },
    () => {
      if (targetVol <= 0) AudioSource.getMutable(entity).playing = false
      activeFades.delete(entity)
    },
    EasingFunction.EF_EASEOUTSINE,
  )
  activeFades.set(entity, sys)
}

function play(entity: Entity) {
  // false → true toggle is the standard DCL AudioSource retrigger pattern.
  // Restore full volume in case a previous fade-out left it at 0.
  cancelFade(entity)
  const src = AudioSource.getMutable(entity)
  src.volume  = baseVol.get(entity) ?? 1
  src.playing = false
  timers.setTimeout(() => { AudioSource.getMutable(entity).playing = true }, 0)
}

function stop(entity: Entity) {
  cancelFade(entity)
  AudioSource.getMutable(entity).playing = false
}

export function initMusicManager(): void {
  // All three tracks are parented to the player entity, so they ride along for
  // free — the old approach wrote three Transforms EVERY FRAME to chase the
  // player's position for consistent volume.
  townEntity = engine.addEntity()
  Transform.create(townEntity, { parent: engine.PlayerEntity })
  AudioSource.create(townEntity, {
    audioClipUrl: SND_TOWN,
    playing:      true,
    loop:         true,
    volume:       VOL_TOWN,
  })

  partyEntity = engine.addEntity()
  Transform.create(partyEntity, { parent: engine.PlayerEntity })
  AudioSource.create(partyEntity, {
    audioClipUrl: SND_PARTY,
    playing:      false,
    loop:         true,
    volume:       VOL_PARTY,
  })

  finaleEntity = engine.addEntity()
  Transform.create(finaleEntity, { parent: engine.PlayerEntity })
  AudioSource.create(finaleEntity, {
    audioClipUrl: SND_FINALE,
    playing:      false,
    loop:         true,
    volume:       VOL_FINALE,
  })

  // Remember each track's full volume so play() / fadeTo() can restore it.
  baseVol.set(townEntity,   VOL_TOWN)
  baseVol.set(partyEntity,  VOL_PARTY)
  baseVol.set(finaleEntity, VOL_FINALE)

  console.log('[Music] Manager ready — Town playing')

  // Phase watcher — also reacts to the finale flag so the doors-open celebration
  // music depends on whether this is a regular intermission or the finale.
  let lastPhase  = ''
  let lastFinale = false
  engine.addSystem(() => {
    const gs = gameState()
    if (!gs) return
    {
      if (gs.phase === lastPhase && gs.isFinale === lastFinale) return
      const prev       = lastPhase
      const prevFinale = lastFinale
      lastPhase  = gs.phase
      lastFinale = gs.isFinale

      if (gs.phase === 'open') {
        // Entering the open phase, or the finale flag flipped while already open.
        if (prev !== 'open') stop(townEntity)
        if (gs.isFinale) {
          // Finale celebration track (optionally layered over the party track).
          if (!FINALE_LAYER_PARTY) stop(partyEntity)
          else if (prev !== 'open') play(partyEntity)
          play(finaleEntity)
          console.log('[Music] → Finale celebration track')
        } else {
          stop(finaleEntity)
          play(partyEntity)
          console.log('[Music] → Party track')
        }
      } else if (gs.phase === 'playing' && (prev === 'open' || prevFinale)) {
        // Back to a round.  Coming out of the finale we ease the celebration
        // music down and the ambience up so the payoff "breathes" out instead
        // of cutting; regular intermissions just hard-swap as before.
        if (prevFinale) {
          // Town is stopped here (silenced on finale entry), so fadeTo retriggers
          // it from volume 0 and ramps up while the celebration tracks ramp down.
          fadeTo(partyEntity,  0)
          fadeTo(finaleEntity, 0)
          fadeTo(townEntity,   VOL_TOWN)
          console.log('[Music] → Town track (fading out finale)')
        } else {
          stop(partyEntity)
          stop(finaleEntity)
          play(townEntity)
          console.log('[Music] → Town track')
        }
      } else if (gs.phase === 'lobby' && prev === 'open') {
        // Returned to the lobby after a match (the finale now exits to 'lobby', not
        // 'playing', so the fade-out must happen here). Ease celebration down, Town up.
        if (prevFinale) {
          fadeTo(partyEntity,  0)
          fadeTo(finaleEntity, 0)
          fadeTo(townEntity,   VOL_TOWN)
          console.log('[Music] → Town track (lobby — fading out finale)')
        } else {
          stop(partyEntity)
          stop(finaleEntity)
          play(townEntity)
          console.log('[Music] → Town track (lobby)')
        }
      }
      return
    }
  })
}
