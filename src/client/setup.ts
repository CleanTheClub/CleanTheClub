import { setupUi, resetIntro } from '../ui'
import { initLocalPlayer, onLocalEnterScene } from './localPlayer'
import { initCleaningSystem } from '../cleaningSystem'
import { initSoundManager } from './soundManager'
import { initEmoteManager } from './emoteManager'
import { initPreload } from './preload'
import { initGearPedestals } from './gearPedestals'
import { initGlassSystem } from './glassSystem'
import { initCollectibleGroup } from './collectibleSystem'
import { discoverBottles, BOTTLE_ID_PREFIX } from '../shared/glassDiscovery'
import { initRubbishSystem } from './rubbishSystem'
import { initThemeSpawnSystem } from './themeSpawnSystem'
import { sweepSceneryPointerColliders } from './sceneItemHelpers'

// ── Mobile player light: REMOVED (2026-08-16) ─────────────────────────────────
// The full story, for whoever considers re-adding one: mobile renders the club
// darker than desktop, so a warm LightSource rode the local player. It never
// rendered on device — not parented, not world-space-followed, not at the
// engine-max 16000cd — the mobile explorer simply does not draw LightSource
// (same silently-unimplemented class as AvatarLocomotionSettings and
// mesh-collider raycasts). Mobile visibility is now handled where the mobile
// renderer actually cooperates: higher emissive floors on the club's own neon
// during dirty phases (see emissionSystem's mobile levels).
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
import { initLobbyTeleport } from './lobbyTeleport'
import { initProgressionStore } from './progressionStore'
import { initUpgradeEffects } from './upgradeEffects'
import { initParticipation } from './participation'
import { initCarrySystem } from './carrySystem'
import { initRankBadgeSystem } from './rankBadgeSystem'
import { initSpectateSystem } from './spectateSystem'
import { initWallArtSystem } from './wallArtSystem'

export function initClient() {
  console.log('[CLIENT] started')
  initLocalPlayer()   // resolve own address first — the scene-enter guards need it
  // Registered before setupUi so the first progressUpdate can't arrive between the
  // UI mounting and the listener existing.
  initProgressionStore()
  initParticipation()   // server-owned: are we cleaning this shift or spectating?
  initUpgradeEffects()   // applies purchased upgrades once levels arrive
  initCarrySystem()   // server-owned rubbish carry count + big-bag deposit clicks
  initRankBadgeSystem()   // career-tier medallion above the player's head
  initSpectateSystem()   // waiting players can watch the shift through a live camera
  initWallArtSystem()   // swaps the template's NFT frames for local posters
  initPhaseGate()  // start the mid-match lockout watcher
  initLobbyTeleport()  // return players to the entrance when a match ends
  initSoundManager()
  initMusicManager()
  initPreload()
  initGearPedestals()
  initEmoteManager()
  setupUi()
  onLocalEnterScene(() => resetIntro())
  initCleaningSystem()
  initGlassSystem()
  initCollectibleGroup({
    items:      discoverBottles(),
    idPrefix:   BOTTLE_ID_PREFIX,
    toastKind:  'bottles',
  })
  initRubbishSystem()
  initThemeSpawnSystem()   // click wiring for server-placed themed extras (theme_* slots)
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
      addBox:         true,  // GLB origin is centred — box collider hittable from frame 1
    },
    {
      itemId:         'sofa_cushion_2',
      nameDirty:      'dirtySofaCushion2',
      nameAnim:       'SofaCushionAnim_2',
      nameClean:      'cleanSofaCushion2',
      animClip:       'restore3',
      animDurationMs: 1000,  // 30 frames @ 30 fps
      hoverText:      'Clean',
      addBox:         true,  // GLB origin is centred — box collider hittable from frame 1
    },
    {
      itemId:         'sofa_cushion_3',
      nameDirty:      'dirtySofaCushion3',
      nameAnim:       'SofaCushionAnim_3',
      nameClean:      'cleanSofaCushion3',
      animClip:       'restore4',
      animDurationMs: 1000,  // 30 frames @ 30 fps
      hoverText:      'Clean',
      addBox:         true,  // GLB origin is centred — box collider hittable from frame 1
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
  // LAST: every interactive system above has registered its pointer entities,
  // so anything left holding CL_POINTER is scenery shadowing item taps.
  sweepSceneryPointerColliders()

  // (The three-bag mobile tap experiment that used to run here is retired —
  // it proved the mobile client can't reliably raycast GLB mesh colliders,
  // and the fix now lives in sceneItemHelpers' restored, properly-sized tap
  // proxies. The bags outside are ordinary rubbish items again; delete them
  // in Creator Hub whenever.)
}
