import { setupUi } from '../ui'
import { initCleaningSystem } from '../cleaningSystem'
import { initSoundManager } from './soundManager'
import { initEmoteManager } from './emoteManager'
import { initGlassSystem } from './glassSystem'
import { initCollectibleGroup } from './collectibleSystem'
import { discoverBottles, BOTTLE_ID_PREFIX } from '../shared/glassDiscovery'
import { initRubbishSystem } from './rubbishSystem'
import { initStinkSystem } from './stinkSystem'
import { initSparkleSystem } from './sparkleSystem'
import { initConfettiSystem } from './confettiSystem'
import { initEmissionSystem } from './emissionSystem'

export function initClient() {
  console.log('[CLIENT] started')
  initSoundManager()
  initEmoteManager()
  setupUi()
  initCleaningSystem()
  initGlassSystem()
  initCollectibleGroup({
    items:      discoverBottles(),
    idPrefix:   BOTTLE_ID_PREFIX,
    toastKind:  'bottles',
  })
  initRubbishSystem()
  initSparkleSystem()
  initStinkSystem()
  initConfettiSystem()
  initEmissionSystem()
}
