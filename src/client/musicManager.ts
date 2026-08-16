// Background music manager — switches tracks based on game phase.
//
//  playing/lobby  → janitor radio              (Stardust, muffled → bright with
//                                               the clean meter — see below)
//  open (normal)  → party wheel                (4 tracks, rotated per night)
//  open (finale)  → FinalRoundCelebration.mp3  (the big final celebration)
//
// The finale track plays INSTEAD of the party track by default.  Set
// FINALE_LAYER_PARTY = true to layer a party track underneath it instead.
// All tracks loop; only the relevant one(s) play at a time.

import { engine, Entity, Transform, AudioSource, EasingFunction } from '@dcl/sdk/ecs'
import { timers } from '@dcl/sdk/ecs'
import { gameState } from './phaseGate'
import { tweenValue } from './tween'

// ── Track paths ───────────────────────────────────────────────────────────────
const SND_FINALE = 'assets/scene/Sounds/FinalRoundCelebration.mp3'
// Janitor radio — round/lobby background. The same "Stardust" the club blasts
// at doors-open, but through the janitor's little radio: one muffled
// through-the-wall bake and one small-speaker bright bake of the SAME 64s
// section. The reactive system below crossfades muffled → bright and eases the
// volume up as the clean meter climbs, so your ears track the night's progress.
// (Replaces Town.mp3 market ambience, which read village-square, not
// after-hours club.)
const SND_RADIO_MUFFLED = 'assets/scene/Sounds/radioStardustMuffled.mp3'
const SND_RADIO_BRIGHT  = 'assets/scene/Sounds/radioStardustBright.mp3'
// Party wheel — the original party loop plus three ~42s sections cut from
// different parts of "Stardust" (CC0), fades baked in. Each open phase plays
// the NEXT one with a small pitch wobble, so intermissions stop sounding
// identical night after night (playtest: "boring the same all the time").
const PARTY_TRACKS = [
  'assets/scene/Sounds/partySound.mp3',
  'assets/scene/Sounds/partyStardustA.mp3',
  'assets/scene/Sounds/partyStardustB.mp3',
  'assets/scene/Sounds/partyStardustC.mp3',
]

// ── Volume ────────────────────────────────────────────────────────────────────
const VOL_PARTY  = 1.0
const VOL_FINALE = 1.0
const VOL_RADIO  = 1.0   // scaled by the clean fraction (see radioVol)

// When true, the party track keeps playing under the finale track (layered).
// When false (default), the finale track plays on its own.
const FINALE_LAYER_PARTY = false

// ─────────────────────────────────────────────────────────────────────────────

let finaleEntity: Entity

// One entity per party track; `currentParty` is whichever the open phase picked.
const partyPool: Entity[] = []
let partyIdx     = Math.floor(Math.random() * PARTY_TRACKS.length)
let currentParty: Entity | null = null

// ── Janitor radio state ───────────────────────────────────────────────────────
let radioMuffled: Entity
let radioBright:  Entity
let radioOn = false
let radioLayer: 'muffled' | 'bright' = 'muffled'

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

// NOTE: a fade writes the AudioSource every frame, which this explorer treats
// as a source re-apply — fine at track transitions (the music is changing
// anyway), but never use it on a steadily-playing track (see radioStart).
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

// ── Music mute (music only — SFX are soundManager's and unaffected) ──────────
let musicMuted = false
export const isMusicMuted = (): boolean => musicMuted

function play(entity: Entity) {
  if (musicMuted) return
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

/** Next clip off the party wheel, with a ±4% pitch wobble for extra variety. */
function playNextParty(): void {
  const e = partyPool[partyIdx % partyPool.length]
  partyIdx++
  currentParty = e
  AudioSource.getMutable(e).pitch = 0.97 + Math.random() * 0.08
  play(e)
}

function stopParty(): void {
  for (const e of partyPool) stop(e)
  currentParty = null
}

function fadeOutParty(): void {
  if (currentParty) fadeTo(currentParty, 0)
  currentParty = null
}

// ── Janitor radio ─────────────────────────────────────────────────────────────

/** Clean fraction while a round is live; the radio idles muffled otherwise. */
function cleanFrac(): number {
  const gs = gameState()
  if (!gs || gs.phase !== 'playing') return 0
  return gs.cleanedCount / Math.max(1, gs.totalCount)
}

/** Quiet when the club's a wreck, full radio by sparkling. */
const radioVol = (f: number) => VOL_RADIO * (0.55 + 0.45 * f)

function radioEnt(layer = radioLayer): Entity {
  return layer === 'bright' ? radioBright : radioMuffled
}

/**
 * WRITE-FREE while playing. Two prior designs stuttered ("music starts and
 * stops when I move or clean"): playing-toggle crossfades restarted the clip,
 * and after those were removed, the 1 Hz volume ride still did — on this
 * explorer ANY AudioSource component write re-applies the source. So the radio
 * now touches its AudioSource only at phase transitions and at the (rare,
 * hysteresis-guarded) layer swap; between those, zero writes. One layer plays
 * at a time — also the lightest possible footprint on mobile's audio voices.
 */
function radioStart(): void {
  radioOn = true
  if (musicMuted) return
  const f = cleanFrac()
  radioLayer = f >= 0.5 ? 'bright' : 'muffled'
  stop(radioEnt(radioLayer === 'bright' ? 'muffled' : 'bright'))
  const e = radioEnt()
  baseVol.set(e, radioVol(f))
  play(e)
}

function radioStop(): void {
  radioOn = false
  stop(radioMuffled)
  stop(radioBright)
}

/** Start whatever the current phase calls for — used when unmuting. */
function applyMusicForPhase(): void {
  const gs = gameState()
  if (gs?.phase === 'open') {
    if (gs.isFinale) play(finaleEntity)
    else playNextParty()
  } else {
    radioStart()
  }
}

/**
 * Owner-coronation sting — the finale celebration track takes over the rest of
 * this intermission (a NEW CLUB OWNER outranks the regular party wheel). Only
 * fires during 'open': a mid-round crowning (admin grant) keeps the radio — the
 * confetti and plate pop carry that moment. No restore logic needed: the phase
 * watcher below already stops the finale track when the next round starts.
 */
export function playOwnerSting(): void {
  if (musicMuted) return
  if (gameState()?.phase !== 'open') return
  stopParty()
  play(finaleEntity)
  console.log('[Music] → owner coronation (finale track for this intermission)')
}

/** Toggle background music (radio + party + finale). SFX untouched. */
export function toggleMusicMute(): boolean {
  musicMuted = !musicMuted
  if (musicMuted) {
    stopParty()
    stop(finaleEntity)
    stop(radioMuffled)
    stop(radioBright)
  } else {
    applyMusicForPhase()
  }
  console.log(`[Music] ${musicMuted ? 'muted' : 'unmuted'}`)
  return musicMuted
}

export function initMusicManager(): void {
  // All tracks are parented to the player entity, so they ride along for
  // free — the old approach wrote three Transforms EVERY FRAME to chase the
  // player's position for consistent volume.
  // `global: true` everywhere: constant volume regardless of avatar position.
  // Positional music parented to the player can lag the moving avatar and dip
  // with distance ("music cutting out when I move"). Desktop honours the flag;
  // a client that doesn't falls back to today's positional behaviour.
  radioMuffled = engine.addEntity()
  Transform.create(radioMuffled, { parent: engine.PlayerEntity })
  AudioSource.create(radioMuffled, {
    audioClipUrl: SND_RADIO_MUFFLED,
    playing:      true,   // radio's on from the moment you walk in (muffled — club starts dirty)
    loop:         true,
    volume:       radioVol(0),
    global:       true,
  })
  radioOn = true

  radioBright = engine.addEntity()
  Transform.create(radioBright, { parent: engine.PlayerEntity })
  AudioSource.create(radioBright, {
    audioClipUrl: SND_RADIO_BRIGHT,
    playing:      false,   // one radio layer at a time — see radioStart
    loop:         true,
    volume:       radioVol(1),
    global:       true,
  })

  for (const url of PARTY_TRACKS) {
    const e = engine.addEntity()
    Transform.create(e, { parent: engine.PlayerEntity })
    AudioSource.create(e, { audioClipUrl: url, playing: false, loop: true, volume: VOL_PARTY, global: true })
    baseVol.set(e, VOL_PARTY)
    partyPool.push(e)
  }

  finaleEntity = engine.addEntity()
  Transform.create(finaleEntity, { parent: engine.PlayerEntity })
  AudioSource.create(finaleEntity, {
    audioClipUrl: SND_FINALE,
    playing:      false,
    loop:         true,
    volume:       VOL_FINALE,
    global:       true,
  })

  // Remember each track's full volume so play() / fadeTo() can restore it.
  // (Party pool volumes were registered as the pool was built; radio volumes
  // are managed by the reactive system below.)
  baseVol.set(finaleEntity, VOL_FINALE)

  console.log('[Music] Manager ready — janitor radio on (muffled)')

  // ── Cleanliness-reactive radio ────────────────────────────────────────────
  // 1 Hz check, but it only ever WRITES on a layer swap (see radioStart's
  // write-free rule). Hysteresis (up at 55%, back down at 40%) because
  // respawns wobble the fraction — without it the boundary would flap. The
  // swap is a hard station-change: old layer stops, new one starts at its
  // level-appropriate volume. The continuous loudness ride was removed — its
  // per-second volume writes were restarting the clip.
  let radioAcc = 0
  engine.addSystem((dt: number) => {
    radioAcc += dt
    if (radioAcc < 1) return
    radioAcc = 0
    if (!radioOn || musicMuted) return
    const f = cleanFrac()
    const want: typeof radioLayer = radioLayer === 'bright'
      ? (f < 0.40 ? 'muffled' : 'bright')
      : (f >= 0.55 ? 'bright' : 'muffled')
    if (want === radioLayer) return
    stop(radioEnt())
    radioLayer = want
    const e = radioEnt()
    baseVol.set(e, radioVol(f))
    play(e)
    console.log(`[Music] radio ${want === 'bright' ? 'BRIGHTENS' : 'muffles'} (clean ${Math.round(f * 100)}%)`)
  })

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
        if (prev !== 'open') radioStop()
        if (gs.isFinale) {
          // Finale celebration track (optionally layered over a party track).
          if (!FINALE_LAYER_PARTY) stopParty()
          else if (prev !== 'open') playNextParty()
          play(finaleEntity)
          console.log('[Music] → Finale celebration track')
        } else {
          stop(finaleEntity)
          playNextParty()
          console.log(`[Music] → Party track ${(partyIdx - 1) % partyPool.length + 1}/${partyPool.length}`)
        }
      } else if (gs.phase === 'playing' && (prev === 'open' || prevFinale)) {
        // Back to a round.  Coming out of the finale we ease the celebration
        // music down and the ambience up so the payoff "breathes" out instead
        // of cutting; regular intermissions just hard-swap as before.
        if (prevFinale) {
          // Radio is stopped here (silenced on finale entry), so radioStart
          // with fadeIn retriggers it from 0 while the celebration ramps down.
          fadeOutParty()
          fadeTo(finaleEntity, 0)
          radioStart()
          console.log('[Music] → janitor radio (fading out finale)')
        } else {
          stopParty()
          stop(finaleEntity)
          radioStart()
          console.log('[Music] → janitor radio')
        }
      } else if (gs.phase === 'lobby' && prev === 'open') {
        // Returned to the lobby after a match (the finale now exits to 'lobby', not
        // 'playing', so the fade-out must happen here). Ease celebration down, Town up.
        if (prevFinale) {
          fadeOutParty()
          fadeTo(finaleEntity, 0)
          radioStart()
          console.log('[Music] → janitor radio (lobby — fading out finale)')
        } else {
          stopParty()
          stop(finaleEntity)
          radioStart()
          console.log('[Music] → janitor radio (lobby)')
        }
      }
      return
    }
  })
}
