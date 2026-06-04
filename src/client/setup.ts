import { setupUi, resetIntro } from '../ui'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { initCleaningSystem } from '../cleaningSystem'
import { initSoundManager } from './soundManager'
import { initEmoteManager } from './emoteManager'
import { initGlassSystem } from './glassSystem'
import { initCollectibleGroup } from './collectibleSystem'
import { discoverBottles, BOTTLE_ID_PREFIX } from '../shared/glassDiscovery'
import { initRubbishSystem } from './rubbishSystem'
import { initRestoreSystem } from './restoreSystem'
import { initStinkSystem } from './stinkSystem'
import { initSparkleSystem } from './sparkleSystem'
import { initConfettiSystem } from './confettiSystem'
import { initEmissionSystem } from './emissionSystem'
import { initGrungeSystem } from './grungeSystem'
import { initNarrativeSystem } from './narrativeSystem'
import { initStickyHazardSystem } from './stickyHazardSystem'
import { initMusicManager } from './musicManager'
import { initLeaderboardSystem } from './leaderboardSystem'
import { initNpcCrowdSystem } from './npcCrowdSystem'
import { initPhaseGate } from './phaseGate'

export function initClient() {
  console.log('[CLIENT] started')
  initPhaseGate()  // start the mid-match lockout watcher
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
  initRestoreSystem([
    {
      itemId:         'test_reset',
      nameDirty:      'dirtyBarStool',
      nameAnim:       'cleanBarStoolAnim',
      nameClean:      'cleanBarStool',
      animClip:       'restore',
      animDurationMs: 500,
      hoverText:      'Clean',
    },
    {
      itemId:         'stool_2',
      nameDirty:      'dirtyBarStool_2',
      nameAnim:       'cleanBarStoolAnim_2',
      nameClean:      'cleanBarStool_2',
      animClip:       'restore',
      animDurationMs: 500,
      hoverText:      'Clean',
    },
    {
      itemId:         'chaise_cushion',
      nameDirty:      'dirtyChaiseCushion',
      nameAnim:       'cleanChaiseCushionAnim',
      nameClean:      'cleanChaiseCushion',
      animClip:       'restore',
      animDurationMs: 500,
      hoverText:      'Clean',
    },
    {
      itemId:         'sofa_cushion_1',
      nameDirty:      'dirtySofaCushion',
      nameAnim:       'SofaCushionAnim_1',
      nameClean:      'cleanSofaCushion',
      animClip:       'restore2',
      animDurationMs: 1000,  // 30 frames @ 30 fps
      hoverText:      'Clean',
    },
    {
      itemId:         'sofa_cushion_2',
      nameDirty:      'dirtySofaCushion2',
      nameAnim:       'SofaCushionAnim_2',
      nameClean:      'cleanSofaCushion2',
      animClip:       'restore3',
      animDurationMs: 1000,  // 30 frames @ 30 fps
      hoverText:      'Clean',
    },
    {
      itemId:         'sofa_cushion_3',
      nameDirty:      'dirtySofaCushion3',
      nameAnim:       'SofaCushionAnim_3',
      nameClean:      'cleanSofaCushion3',
      animClip:       'restore4',
      animDurationMs: 1000,  // 30 frames @ 30 fps
      hoverText:      'Clean',
    },
  ])
  initSparkleSystem()
  initStinkSystem()
  initConfettiSystem()
  initEmissionSystem()
  initGrungeSystem()
  initNarrativeSystem()
  initStickyHazardSystem()
  initLeaderboardSystem()
  initNpcCrowdSystem()
}
