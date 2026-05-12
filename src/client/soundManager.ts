import { engine, Entity, Transform, AudioSource } from '@dcl/sdk/ecs'
import { timers } from '@dcl/sdk/ecs'

const SND_HOVER         = 'assets/scene/Sounds/hover.mp3'
const SND_CLICK         = 'assets/scene/Sounds/click.mp3'
const SND_STICKY        = 'assets/scene/Sounds/stickySound.mp3'
const SND_CLEAN         = 'assets/scene/Sounds/cleanSound.mp3'
const SND_NOTIFICATION  = 'assets/scene/Sounds/notificationSound.mp3'

const VOL_HOVER  = 0.7
const VOL_CLICK  = 0.9
const VOL_STICKY = 0.9
const VOL_CLEAN  = 0.9

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
let cleanEntity:        Entity
let notificationEntity: Entity

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

  cleanEntity = engine.addEntity()
  Transform.create(cleanEntity,  { position: INIT_POS })
  AudioSource.create(cleanEntity,  { audioClipUrl: SND_CLEAN,  playing: false, loop: false, volume: VOL_CLEAN  })

  notificationEntity = engine.addEntity()
  Transform.create(notificationEntity, { position: INIT_POS })
  AudioSource.create(notificationEntity, { audioClipUrl: SND_NOTIFICATION, playing: false, loop: false, volume: 0.7, pitch: 1.0 })
}

export function playHoverSound()  { playAt(hoverEntity)  }
export function playClickSound()  { playAt(clickEntity)  }
export function playStickySound() { playAt(stickyEntity) }
export function playCleanSound()  { playAt(cleanEntity)  }

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
