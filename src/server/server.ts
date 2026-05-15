import { engine, Entity, Transform } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { onEnterSceneObservable, onLeaveSceneObservable } from '@dcl/sdk/observables'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, ADMIN_ADDRESSES } from '../shared/config'
import { SCENE_ITEM_PREFIXES, discoverGlasses, discoverBottles, discoverRubbish, discoverStickyPatches } from '../shared/glassDiscovery'
import { initRoundManager, onItemCleaned, onSceneItemCleaned, onPlayerEnter, onPlayerLeave, onAdminReset, onNextRoundRequest, getPhase } from './RoundManager'

export function initServer() {
  console.log('[SERVER] started')

  const itemEntities    = new Map<string, Entity>()
  const sceneItemScales = new Map<string, { x: number; y: number; z: number }>()
  let enumId = 1

  // CLUTTER_DEFS items — new entities created by the server
  for (const def of CLUTTER_DEFS) {
    const entity = engine.addEntity()
    ClutterSync.create(entity, { itemId: def.id, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [ClutterSync.componentId], enumId++)
    itemEntities.set(def.id, entity)
  }

  // Scene-placed groups — ClutterSync added to existing composite entities.
  // Each group is discovered deterministically (sorted entity ID) so enumIds
  // are consistent across server restarts and client discovery.
  for (const { entity, itemId } of [
    ...discoverGlasses(),
    ...discoverBottles(),
    ...discoverRubbish(),
    ...discoverStickyPatches(),
  ]) {
    ClutterSync.create(entity, { itemId, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [ClutterSync.componentId], enumId++)
    itemEntities.set(itemId, entity)

    // Record original scale so we can restore it after round reset
    const tf = Transform.getOrNull(entity)
    sceneItemScales.set(itemId, tf
      ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z }
      : { x: 1, y: 1, z: 1 })
  }

  const gameStateEntity = engine.addEntity()
  GameState.create(gameStateEntity, {
    phase: 'playing',
    cleanedCount: 0,
    totalCount: itemEntities.size,
    secondsLeft: 0,
    roundNumber: 0,
    outcome: '',
  })
  syncEntity(gameStateEntity, [GameState.componentId], enumId)

  // Restores original Transform scales for all scene items (called on round reset)
  function restoreSceneItemScales() {
    for (const [itemId, origScale] of sceneItemScales) {
      const e = itemEntities.get(itemId)
      if (!e) continue
      const tf = Transform.getMutableOrNull(e)
      if (tf) tf.scale = { x: origScale.x, y: origScale.y, z: origScale.z }
    }
  }

  initRoundManager(itemEntities, gameStateEntity, restoreSceneItemScales)

  onEnterSceneObservable.add(() => onPlayerEnter())
  onLeaveSceneObservable.add(() => onPlayerLeave())

  room.onMessage('cleanItem', (data, context) => {
    if (!context) return
    if (getPhase() === 'open') {
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      return
    }
    const entity = itemEntities.get(data.itemId)
    if (!entity || ClutterSync.get(entity).isCleaned) {
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      return
    }
    const now = Date.now()
    const cs = ClutterSync.getMutable(entity)
    cs.isCleaned = true
    cs.cleanedAt = now
    cs.cleanedBy = context.from

    const isSceneItem = SCENE_ITEM_PREFIXES.some(p => data.itemId.startsWith(p))
    if (isSceneItem) {
      // Hide the item by collapsing its scale — server is HOST so CRDT propagates to all clients
      const tf = Transform.getMutableOrNull(entity)
      if (tf) tf.scale = { x: 0.001, y: 0.001, z: 0.001 }
      // Scene items (glasses, bottles, rubbish) stay cleaned for the whole round — no respawn
      onSceneItemCleaned()
    } else {
      const def = CLUTTER_DEFS.find(d => d.id === data.itemId)!
      onItemCleaned(def)
    }
  })

  room.onMessage('startNextRound', (_data, _context) => {
    onNextRoundRequest()
  })

  room.onMessage('adminReset', (_data, context) => {
    if (!context) return
    if (!ADMIN_ADDRESSES.includes(context.from.toLowerCase())) {
      console.log(`[SERVER] adminReset rejected — not an admin: ${context.from}`)
      return
    }
    onAdminReset()
  })
}
