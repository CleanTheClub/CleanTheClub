import { engine, Entity } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, TOTAL_CLUTTER } from '../shared/config'
import { initRoundManager, onItemCleaned, getPhase } from './RoundManager'

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

  const gameStateEntity = engine.addEntity()
  GameState.create(gameStateEntity, {
    phase: 'playing',
    cleanedCount: 0,
    totalCount: TOTAL_CLUTTER,
    secondsLeft: 0,
  })
  syncEntity(gameStateEntity, [GameState.componentId], enumId)

  initRoundManager(itemEntities, gameStateEntity)

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

    const def = CLUTTER_DEFS.find(d => d.id === data.itemId)!
    onItemCleaned(def)
  })
}
