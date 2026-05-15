import { setupUi, resetIntro } from '../ui'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { initCleaningSystem } from '../cleaningSystem'
import { initSoundManager } from './soundManager'
import { initEmoteManager } from './emoteManager'
import { initGlassSystem } from './glassSystem'
import { initCollectibleGroup } from './collectibleSystem'
import { discoverBottles, BOTTLE_ID_PREFIX } from '../shared/glassDiscovery'
import { initRubbishSystem } from './rubbishSystem'
import { initBarStoolSystem } from './barStoolSystem'
import { initStinkSystem } from './stinkSystem'
import { initSparkleSystem } from './sparkleSystem'
import { initConfettiSystem } from './confettiSystem'
import { initEmissionSystem } from './emissionSystem'
import { initGrungeSystem } from './grungeSystem'
import { initNarrativeSystem } from './narrativeSystem'
import { initMusicManager } from './musicManager'

export function initClient() {
  console.log('[CLIENT] started')
  initSoundManager()
  initMusicManager()
  initEmoteManager()
  setupUi()
  onEnterSceneObservable.add(() => resetIntro())
  initCleaningSystem()
  initGlassSystem()
  initCollectibleGroup({
    items:      discoverBottles(),
    idPrefix:   BOTTLE_ID_PREFIX,
    toastKind:  'bottles',
  })
  initRubbishSystem()
  initBarStoolSystem()
  initSparkleSystem()
  initStinkSystem()
  initConfettiSystem()
  initEmissionSystem()
  initGrungeSystem()
  initNarrativeSystem()
}
