import { engine, Entity, Transform, AudioSource } from '@dcl/sdk/ecs'
import { timers } from '@dcl/sdk/ecs'

const SND_HOVER  = 'assets/scene/Sounds/hover.mp3'
const SND_CLICK  = 'assets/scene/Sounds/click.mp3'
const SND_STICKY = 'assets/scene/Sounds/stickySound.mp3'
const SND_CLEAN  = 'assets/scene/Sounds/cleanSound.mp3'

const VOL_HOVER  = 0.7
const VOL_CLICK  = 0.9
const VOL_STICKY = 0.9
const VOL_CLEAN  = 0.9

const INIT_POS = { x: 8, y: 1, z: 8 }

let hoverEntity:  Entity
let clickEntity:  Entity
let stickyEntity: Entity
let cleanEntity:  Entity

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
}

export function playHoverSound()  { playAt(hoverEntity)  }
export function playClickSound()  { playAt(clickEntity)  }
export function playStickySound() { playAt(stickyEntity) }
export function playCleanSound()  { playAt(cleanEntity)  }
