import { engine, Entity, Transform, AudioSource, timers } from '@dcl/sdk/ecs'

const SND_HOVER         = 'assets/scene/Sounds/hover.mp3'
const SND_CLICK         = 'assets/scene/Sounds/click.mp3'
const SND_STICKY        = 'assets/scene/Sounds/stickySound.mp3'
const SND_CLEAN         = 'assets/scene/Sounds/cleanSound.mp3'
const SND_NOTIFICATION  = 'assets/scene/Sounds/notificationSound.mp3'
const SND_SQUELCH       = 'assets/scene/Sounds/squelch.mp3'
// Progression feedback — files pending (drop them in and they just work; a
// missing clip is silent, never an error). moneySound: coin/cash register jingle
// (~1s). promotionSound: short fanfare (~2s).
const SND_MONEY         = 'assets/scene/Sounds/moneySound.mp3'
const SND_PROMOTION     = 'assets/scene/Sounds/promotionSound.mp3'
// Bin deposit thunk — file pending (drop it in and it just works; a missing clip
// is silent, never an error). Something like a bag-drop / lid-clunk, ~0.5s.
const SND_DEPOSIT       = 'assets/scene/Sounds/depositSound.mp3'
// Error buzz for blocked actions (hands full / too far / skill-check miss) —
// file pending. Short dull "uh-uh", ~0.3s, clearly distinct from the toast ding.
const SND_ERROR         = 'assets/scene/Sounds/errorSound.mp3'
// Crowd cheer sting for cleanliness milestones (25/50/75%) — file pending.
// A short "small crowd woo", ~1.5s.
const SND_CROWD         = 'assets/scene/Sounds/crowdCheer.mp3'
// Vacuum slurp (~1s) — replaces the clean sound on click while the Vacuum
// gear is in hand. Popcorn pop (~0.3s) — the Rhythm Pop's own sample.
const SND_VACUUM        = 'assets/scene/Sounds/vacuumSound.mp3'
const SND_POPCORN       = 'assets/scene/Sounds/PopcornSound_Short.mp3'

const VOL_HOVER   = 0.7
const VOL_CLICK   = 0.9
const VOL_STICKY  = 0.9
const VOL_CLEAN   = 0.42   // fires dozens of times a round — keep it well under
                           // the deposit thunk (twice lowered on playtest feedback)
const VOL_SQUELCH = 2.0


// ── Notification sound — one entity, pitch+volume swapped per toast kind ──────
// cleaned:         light & quick    (high pitch, low volume)
// glasses/bottles: standard collect (neutral pitch, medium volume)
// narrative:       urgent & weighty (low pitch, full volume) — bypasses cooldown

type ToastKind = 'cleaned' | 'glasses' | 'bottles' | 'narrative'

const NOTIFICATION_SETTINGS: Record<ToastKind, { pitch: number; volume: number }> = {
  cleaned:   { pitch: 1.3, volume: 0.5 },
  glasses:   { pitch: 1.0, volume: 0.7 },
  bottles:   { pitch: 1.0, volume: 0.7 },
  narrative: { pitch: 0.8, volume: 1.0 },
}

const NOTIFICATION_COOLDOWN_MS = 400
let lastNotificationMs = 0

let hoverEntity:        Entity
let clickEntity:        Entity
let stickyEntity:       Entity
let squelchEntity:      Entity
let notificationEntity: Entity
let moneyEntity:        Entity
let promotionEntity:    Entity
let depositEntity:      Entity
let errorEntity:        Entity
let crowdEntity:        Entity

// Pool of 3 clean-sound entities, round-robined on each play call.
// A single entity can't retrigger while playing=true — the false→true toggle
// no-ops if the previous sound hasn't finished. Cycling entities avoids this.
const CLEAN_POOL_SIZE = 3
const cleanPool: Entity[] = []
let   cleanIdx  = 0

// Same problem, same cure: the Rhythm Pop beats land 700ms apart and the
// notification clip runs longer, so the 2nd and 3rd pops silently no-op'd on
// the single shared entity (playtest: "the 2nd popcorn click has no sound").
const POP_POOL_SIZE = 3
const popPool: Entity[] = []
let   popIdx    = 0

// Vacuum clip runs ~1s and vacuum clicking peaks at several per second —
// pooled for the same retrigger reason as the clean sound.
const VACUUM_POOL_SIZE = 3
const vacuumPool: Entity[] = []
let   vacuumIdx = 0

// Popcorn pops land 700ms apart on the rhythm beats — same cure again.
const POPCORN_POOL_SIZE = 3
const popcornPool: Entity[] = []
let   popcornIdx = 0

// Retriggers playback. Every SFX entity is PARENTED to the player (positional
// audio at zero distance ≈ global, and it works on every client — true
// `global:` audio is DCL 2.0 desktop-only), so there is no per-play position
// write. The false→true toggle via setTimeout is the standard DCL retrigger.
function playAt(entity: Entity, pitch?: number) {
  // Null-safe: a throw inside a pointer/timer callback kills the whole scene,
  // and sounds are fired from every interaction path.
  const src = AudioSource.getMutableOrNull(entity)
  if (!src) return
  if (pitch !== undefined) src.pitch = pitch
  src.playing = false
  timers.setTimeout(() => {
    const s = AudioSource.getMutableOrNull(entity)
    if (s) s.playing = true
  }, 0)
}

export function initSoundManager() {
  hoverEntity = engine.addEntity()
  Transform.create(hoverEntity,  { parent: engine.PlayerEntity })
  AudioSource.create(hoverEntity,  { audioClipUrl: SND_HOVER,  playing: false, loop: false, volume: VOL_HOVER  })

  clickEntity = engine.addEntity()
  Transform.create(clickEntity,  { parent: engine.PlayerEntity })
  AudioSource.create(clickEntity,  { audioClipUrl: SND_CLICK,  playing: false, loop: false, volume: VOL_CLICK  })

  stickyEntity = engine.addEntity()
  Transform.create(stickyEntity, { parent: engine.PlayerEntity })
  AudioSource.create(stickyEntity, { audioClipUrl: SND_STICKY, playing: false, loop: false, volume: VOL_STICKY })

  for (let i = 0; i < CLEAN_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { parent: engine.PlayerEntity })
    AudioSource.create(e, { audioClipUrl: SND_CLEAN, playing: false, loop: false, volume: VOL_CLEAN })
    cleanPool.push(e)
  }

  squelchEntity = engine.addEntity()
  Transform.create(squelchEntity, { parent: engine.PlayerEntity })
  AudioSource.create(squelchEntity, { audioClipUrl: SND_SQUELCH, playing: false, loop: false, volume: VOL_SQUELCH })

  notificationEntity = engine.addEntity()
  Transform.create(notificationEntity, { parent: engine.PlayerEntity })
  AudioSource.create(notificationEntity, { audioClipUrl: SND_NOTIFICATION, playing: false, loop: false, volume: 0.7, pitch: 1.0 })

  for (let i = 0; i < POP_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { parent: engine.PlayerEntity })
    AudioSource.create(e, { audioClipUrl: SND_NOTIFICATION, playing: false, loop: false, volume: 0.9 })
    popPool.push(e)
  }

  moneyEntity = engine.addEntity()
  Transform.create(moneyEntity, { parent: engine.PlayerEntity })
  AudioSource.create(moneyEntity, { audioClipUrl: SND_MONEY, playing: false, loop: false, volume: 1.0 })

  promotionEntity = engine.addEntity()
  Transform.create(promotionEntity, { parent: engine.PlayerEntity })
  AudioSource.create(promotionEntity, { audioClipUrl: SND_PROMOTION, playing: false, loop: false, volume: 1.0 })

  depositEntity = engine.addEntity()
  Transform.create(depositEntity, { parent: engine.PlayerEntity })
  AudioSource.create(depositEntity, { audioClipUrl: SND_DEPOSIT, playing: false, loop: false, volume: 1.0 })

  errorEntity = engine.addEntity()
  Transform.create(errorEntity, { parent: engine.PlayerEntity })
  AudioSource.create(errorEntity, { audioClipUrl: SND_ERROR, playing: false, loop: false, volume: 0.8 })

  crowdEntity = engine.addEntity()
  Transform.create(crowdEntity, { parent: engine.PlayerEntity })
  AudioSource.create(crowdEntity, { audioClipUrl: SND_CROWD, playing: false, loop: false, volume: 0.9 })

  for (let i = 0; i < VACUUM_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { parent: engine.PlayerEntity })
    AudioSource.create(e, { audioClipUrl: SND_VACUUM, playing: false, loop: false, volume: 0.8 })
    vacuumPool.push(e)
  }

  for (let i = 0; i < POPCORN_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { parent: engine.PlayerEntity })
    AudioSource.create(e, { audioClipUrl: SND_POPCORN, playing: false, loop: false, volume: 0.9 })
    popcornPool.push(e)
  }
}

export function playSquelchSound() { playAt(squelchEntity) }
export function playHoverSound()  { playAt(hoverEntity) }
export function playClickSound()  { playAt(clickEntity) }
export function playStickySound() { playAt(stickyEntity) }
export function stopStickySound() {
  const s = AudioSource.getMutableOrNull(stickyEntity)
  if (s) s.playing = false
}
export function playCleanSound()  {
  // Grab the next entity in the pool — guaranteed to not be mid-play from a
  // recent call, so the false→true retrigger always fires correctly.
  const e = cleanPool[cleanIdx % CLEAN_POOL_SIZE]
  // Random ±9% pitch per play. The identical sample dozens of times per round
  // read as grating; small variance makes repetition feel organic instead.
  playAt(e, 0.91 + Math.random() * 0.18)
  cleanIdx++
}

/** Vacuum slurp — the click sound while the Vacuum gear is in hand. Same
 *  ±9% pitch wobble as the clean sound, for the same anti-grating reason. */
export function playVacuumSound() {
  const e = vacuumPool[vacuumIdx % VACUUM_POOL_SIZE]
  playAt(e, 0.91 + Math.random() * 0.18)
  vacuumIdx++
}

/** Popcorn pop for Rhythm Pop hits — ascending pitch with each hit in the
 *  run (same scheme the notification chime used), on popcorn's own sample. */
export function playPopcornSound(hit: number) {
  const e = popcornPool[popcornIdx % POPCORN_POOL_SIZE]
  popcornIdx++
  playAt(e, 1.0 + 0.1 * Math.min(Math.max(1, hit), 8) + Math.random() * 0.04)
}

/**
 * Skill-check hit chime — the notification ding pitched up, rising further with
 * each consecutive PERFECT so a streak climbs audibly. Caps at +8 so a monster
 * streak stays musical rather than becoming a squeak.
 */
export function playPerfectSound(streak: number) {
  // Round-robin so consecutive beats never fight over one entity.
  const e = popPool[popIdx % POP_POOL_SIZE]
  popIdx++
  const src = AudioSource.getMutableOrNull(e)
  if (!src) return
  src.pitch  = 1.15 + 0.08 * Math.min(Math.max(1, streak), 8)
  src.volume = 0.9
  playAt(e)
}

/**
 * Blocked-action buzz (hands full, too far, skill-check miss). Its own file so
 * it can't be mistaken for the notification ding it used to be a pitched-down
 * version of. Silent until Sounds/errorSound.mp3 is added.
 */
export function playMissSound() { playAt(errorEntity) }

/**
 * Rubbish deposited in a bin. Pitch distinguishes the streams by ear —
 * general lands low, recycling rings brighter — so a deposit confirms WHICH
 * pouch emptied without looking at the chip. No arg (portable bin) = neutral.
 */
export function playDepositSound(stream?: 'general' | 'recycle') {
  const src = AudioSource.getMutableOrNull(depositEntity)
  if (!src) return
  src.pitch = stream === 'general' ? 0.85 : stream === 'recycle' ? 1.18 : 1.0
  playAt(depositEntity)
}

/** Crowd cheer at cleanliness milestones. Silent until Sounds/crowdCheer.mp3 exists.
 *  Random pitch so a party that cheers many times a night never sounds like a
 *  looped sample — same trick as the clean sound. */
/**
 * Crowd cheer for cleanliness milestones. `level` (0..1, fraction of the club
 * clean) scales the crowd's excitement — louder and higher-pitched as the
 * night gets cleaner, so the 90% cheer lands bigger than the 25% one instead
 * of all four being identical (playtest ask). A small random wobble keeps
 * repeats from sounding canned.
 */
export function playCrowdSound(level = 0.5) {
  const s = AudioSource.getMutableOrNull(crowdEntity)
  // Tamed from 0.55+0.45 (playtest: milestone cheers read as aggressive —
  // they land mid-flow, over music AND clean sfx). Still scales with level,
  // topping out at 0.68 instead of full volume.
  if (s) s.volume = 0.38 + 0.3 * level
  playAt(crowdEntity, 0.82 + 0.28 * level + Math.random() * 0.06)
}

/**
 * Cleaning-spree chime — the notification ding climbing in pitch with the
 * combo, quieter than real notifications so a spree hums rather than shouts.
 */
export function playSpreeSound(combo: number) {
  const src = AudioSource.getMutableOrNull(notificationEntity)
  if (!src) return
  src.pitch  = 1.0 + 0.05 * Math.min(combo, 14)
  src.volume = 0.45
  playAt(notificationEntity)
}

/** Wage paid at shift end. Silent until Sounds/moneySound.mp3 is added. */
export function playMoneySound()     { playAt(moneyEntity) }
/** Career promotion fanfare. Silent until Sounds/promotionSound.mp3 is added. */
export function playPromotionSound() { playAt(promotionEntity) }

export function playToastSound(kind: ToastKind) {
  const now = Date.now()
  const isNarrative = kind === 'narrative'
  if (!isNarrative && now - lastNotificationMs < NOTIFICATION_COOLDOWN_MS) return
  lastNotificationMs = now

  const { pitch, volume } = NOTIFICATION_SETTINGS[kind]
  const src = AudioSource.getMutableOrNull(notificationEntity)
  if (!src) return
  src.pitch   = pitch
  src.volume  = volume
  src.playing = false
  timers.setTimeout(() => { const s = AudioSource.getMutableOrNull(notificationEntity); if (s) s.playing = true }, 0)
}
