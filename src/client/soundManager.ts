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

const VOL_HOVER   = 0.7
const VOL_CLICK   = 0.9
const VOL_STICKY  = 0.9
const VOL_CLEAN   = 0.9
const VOL_SQUELCH = 2.0

const INIT_POS = { x: 8, y: 1, z: 8 }

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

// Moves the sound entity to the player's current position then retriggers playback.
// The false→true toggle via setTimeout is the standard DCL retrigger pattern.
function playAt(entity: Entity) {
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? INIT_POS
  Transform.getMutable(entity).position = pos
  AudioSource.getMutable(entity).playing = false
  timers.setTimeout(() => { AudioSource.getMutable(entity).playing = true }, 0)
}

export function initSoundManager() {
  hoverEntity = engine.addEntity()
  Transform.create(hoverEntity,  { position: INIT_POS })
  AudioSource.create(hoverEntity,  { audioClipUrl: SND_HOVER,  playing: false, loop: false, volume: VOL_HOVER  })

  clickEntity = engine.addEntity()
  Transform.create(clickEntity,  { position: INIT_POS })
  AudioSource.create(clickEntity,  { audioClipUrl: SND_CLICK,  playing: false, loop: false, volume: VOL_CLICK  })

  stickyEntity = engine.addEntity()
  Transform.create(stickyEntity, { position: INIT_POS })
  AudioSource.create(stickyEntity, { audioClipUrl: SND_STICKY, playing: false, loop: false, volume: VOL_STICKY })

  for (let i = 0; i < CLEAN_POOL_SIZE; i++) {
    const e = engine.addEntity()
    Transform.create(e, { position: INIT_POS })
    AudioSource.create(e, { audioClipUrl: SND_CLEAN, playing: false, loop: false, volume: VOL_CLEAN })
    cleanPool.push(e)
  }

  squelchEntity = engine.addEntity()
  Transform.create(squelchEntity, { position: INIT_POS })
  AudioSource.create(squelchEntity, { audioClipUrl: SND_SQUELCH, playing: false, loop: false, volume: VOL_SQUELCH })

  notificationEntity = engine.addEntity()
  Transform.create(notificationEntity, { position: INIT_POS })
  AudioSource.create(notificationEntity, { audioClipUrl: SND_NOTIFICATION, playing: false, loop: false, volume: 0.7, pitch: 1.0 })

  moneyEntity = engine.addEntity()
  Transform.create(moneyEntity, { position: INIT_POS })
  AudioSource.create(moneyEntity, { audioClipUrl: SND_MONEY, playing: false, loop: false, volume: 1.0 })

  promotionEntity = engine.addEntity()
  Transform.create(promotionEntity, { position: INIT_POS })
  AudioSource.create(promotionEntity, { audioClipUrl: SND_PROMOTION, playing: false, loop: false, volume: 1.0 })

  depositEntity = engine.addEntity()
  Transform.create(depositEntity, { position: INIT_POS })
  AudioSource.create(depositEntity, { audioClipUrl: SND_DEPOSIT, playing: false, loop: false, volume: 1.0 })

  errorEntity = engine.addEntity()
  Transform.create(errorEntity, { position: INIT_POS })
  AudioSource.create(errorEntity, { audioClipUrl: SND_ERROR, playing: false, loop: false, volume: 0.8 })

  crowdEntity = engine.addEntity()
  Transform.create(crowdEntity, { position: INIT_POS })
  AudioSource.create(crowdEntity, { audioClipUrl: SND_CROWD, playing: false, loop: false, volume: 0.9 })
}

export function playSquelchSound() { playAt(squelchEntity) }
export function playHoverSound()  { playAt(hoverEntity) }
export function playClickSound()  { playAt(clickEntity) }
export function playStickySound() { playAt(stickyEntity) }
export function stopStickySound() { AudioSource.getMutable(stickyEntity).playing = false }
export function playCleanSound()  {
  // Grab the next entity in the pool — guaranteed to not be mid-play from a
  // recent call, so the false→true retrigger always fires correctly.
  const e = cleanPool[cleanIdx % CLEAN_POOL_SIZE]
  // Random ±9% pitch per play. The identical sample dozens of times per round
  // read as grating; small variance makes repetition feel organic instead.
  AudioSource.getMutable(e).pitch = 0.91 + Math.random() * 0.18
  playAt(e)
  cleanIdx++
}

/**
 * Skill-check hit chime — the notification ding pitched up, rising further with
 * each consecutive PERFECT so a streak climbs audibly. Caps at +8 so a monster
 * streak stays musical rather than becoming a squeak.
 */
export function playPerfectSound(streak: number) {
  const src = AudioSource.getMutable(notificationEntity)
  src.pitch  = 1.15 + 0.08 * Math.min(Math.max(1, streak), 8)
  src.volume = 0.9
  playAt(notificationEntity)
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
  const src = AudioSource.getMutable(depositEntity)
  src.pitch = stream === 'general' ? 0.85 : stream === 'recycle' ? 1.18 : 1.0
  playAt(depositEntity)
}

/** Crowd cheer at cleanliness milestones. Silent until Sounds/crowdCheer.mp3 exists. */
export function playCrowdSound()     { playAt(crowdEntity) }

/**
 * Cleaning-spree chime — the notification ding climbing in pitch with the
 * combo, quieter than real notifications so a spree hums rather than shouts.
 */
export function playSpreeSound(combo: number) {
  const src = AudioSource.getMutable(notificationEntity)
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
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? INIT_POS
  Transform.getMutable(notificationEntity).position = pos
  const src = AudioSource.getMutable(notificationEntity)
  src.pitch   = pitch
  src.volume  = volume
  src.playing = false
  timers.setTimeout(() => { AudioSource.getMutable(notificationEntity).playing = true }, 0)
}
