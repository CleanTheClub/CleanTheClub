import { setupUi, resetIntro } from '../ui'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
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
import { engine, Transform, LightSource } from '@dcl/sdk/ecs'
import { Color3 } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { platformKnown } from './platformWait'

// ── Mobile player light ───────────────────────────────────────────────────────
// The mobile renderer resolves the club much darker than desktop (playtest:
// "it's too dark"). One warm point light rides the local player. Platform
// resolves asynchronously, so a one-shot system waits for it.
function initMobilePlayerLight(): void {
  // Waits for a REAL platform answer rather than the shared degrade-to-desktop
  // gate: an unknown platform means "no light", not "desktop", so timing out
  // here silently costs mobile players the light entirely.
  let waitedS = 0
  const waitForPlatform = (dt: number) => {
    waitedS += dt
    if (!platformKnown()) {
      if (waitedS > 30) {
        console.log('[LIGHT] platform never resolved — skipping mobile player light')
        engine.removeSystem(waitForPlatform)
      }
      return
    }
    engine.removeSystem(waitForPlatform)
    if (!isMobile()) return
    const light = engine.addEntity()
    Transform.create(light, { parent: engine.PlayerEntity, position: { x: 0, y: 1.8, z: 0 } })
    LightSource.create(light, {
      active: true,
      color: Color3.create(1, 0.93, 0.82),   // warm club glow, not a torch
      // Candelas (engine default is a blinding 16000) — a soft personal fill.
      // TUNE by eye on a real phone.
      intensity: 1200,
      range: 10,
      type: LightSource.Type.Point({}),
    })
    console.log('[LIGHT] mobile player light attached')
  }
  engine.addSystem(waitForPlatform)
}
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
import { initWallArtSystem } from './wallArtSystem'

export function initClient() {
  console.log('[CLIENT] started')
  // Registered before setupUi so the first progressUpdate can't arrive between the
  // UI mounting and the listener existing.
  initProgressionStore()
  initParticipation()   // server-owned: are we cleaning this shift or spectating?
  initUpgradeEffects()   // applies purchased upgrades once levels arrive
  initCarrySystem()   // server-owned rubbish carry count + big-bag deposit clicks
  initRankBadgeSystem()   // career-tier medallion above the player's head
  initWallArtSystem()   // swaps the template's NFT frames for local posters
  initPhaseGate()  // start the mid-match lockout watcher
  initLobbyTeleport()  // return players to the entrance when a match ends
  initSoundManager()
  initMusicManager()
  initPreload()
  initGearPedestals()
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
  initThemeSpawnSystem()   // click wiring for server-placed themed extras (theme_* slots)
  initMobilePlayerLight()  // mobile renders the club too dark — see above
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
}
