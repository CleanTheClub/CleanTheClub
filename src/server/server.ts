import { engine, Entity } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { onEnterSceneObservable, onLeaveSceneObservable } from '@dcl/sdk/observables'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, ADMIN_ADDRESSES } from '../shared/config'
import { GLASS_ID_PREFIX, discoverGlasses } from '../shared/glassDiscovery'
import { initRoundManager, onItemCleaned, onGlassCleaned, onPlayerEnter, onPlayerLeave, onAdminReset, onNextRoundRequest, getPhase } from './RoundManager'

export function initServer() {
  console.log('[SERVER] started')

  const itemEntities = new Map<string, Entity>()
  let enumId = 1

  for (const def of CLUTTER_DEFS) {
    const entity = engine.addEntity()
    ClutterSync.create(entity, { itemId: def.id, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [ClutterSync.componentId], enumId++)
    itemEntities.set(def.id, entity)
  }

  // Discover glasses and add ClutterSync to their existing scene entities
  const glassDefs = discoverGlasses()
  for (const { entity, glassId } of glassDefs) {
    ClutterSync.create(entity, { itemId: glassId, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [ClutterSync.componentId], enumId++)
    itemEntities.set(glassId, entity)
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

  initRoundManager(itemEntities, gameStateEntity)

  // Player presence tracking for auto-reset
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

    if (data.itemId.startsWith(GLASS_ID_PREFIX)) {
      // Glasses stay collected for the whole round — no respawn timer
      onGlassCleaned()
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
