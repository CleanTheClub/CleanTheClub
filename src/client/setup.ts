import { setupUi, resetIntro } from '../ui'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { executeTask } from '@dcl/sdk/ecs'
import { getUserData } from '~system/UserIdentity'
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
import { initMusicManager } from './musicManager'
import { setupLeaderboardBoard, updateLeaderboardDisplay } from './leaderboardSystem'
import { room } from '../shared/messages'

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
  ])
  initSparkleSystem()
  initStinkSystem()
  initConfettiSystem()
  initEmissionSystem()
  initGrungeSystem()
  initNarrativeSystem()

  // ── Leaderboard ──────────────────────────────────────────────
  setupLeaderboardBoard()

  // Handle leaderboard updates from server
  room.onMessage('leaderboardUpdate', (data) => {
    try {
      const entries = JSON.parse(data.entriesJson)
      updateLeaderboardDisplay(entries)
    } catch {
      console.log('[CLIENT] Failed to parse leaderboardUpdate')
    }
  })

  // Register display name so leaderboard shows real names
  executeTask(async () => {
    try {
      const { data } = await getUserData({})
      if (data?.displayName) {
        room.send('registerPlayer', { displayName: data.displayName })
      }
    } catch {
      console.log('[CLIENT] Could not get user data for leaderboard registration')
    }
  })
}
