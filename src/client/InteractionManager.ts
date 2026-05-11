import { engine, Entity, pointerEventsSystem, InputAction } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { room } from '../shared/messages'
import { ClutterSync } from '../shared/schemas'
import { CLUTTER_DEFS } from '../shared/config'
import { showToast } from '../ui'

const pendingCleans = new Set<string>()
const lastState     = new Map<string, boolean>()

function findClutterEntity(itemId: string): Entity | undefined {
  for (const [entity] of engine.getEntitiesWith(ClutterSync)) {
    if (ClutterSync.get(entity).itemId === itemId) return entity
  }
  return undefined
}

export function initInteractionManager(
  visualEntities: Map<string, Entity>,
  setVisible: (entity: Entity, visible: boolean) => void
) {
  // Register pointer events once server state is synced
  let registered = false
  engine.addSystem(() => {
    if (!isStateSyncronized() || registered) return
    registered = true

    for (const def of CLUTTER_DEFS) {
      const entity = visualEntities.get(def.id)!
      const id = def.id
      pointerEventsSystem.onPointerDown(
        { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Clean' } },
        () => {
          if (pendingCleans.has(id)) return
          const syncEnt = findClutterEntity(id)
          if (syncEnt && ClutterSync.get(syncEnt).isCleaned) return
          pendingCleans.add(id)
          setVisible(entity, false)
          room.send('cleanItem', { itemId: id })
          showToast('Cleaning...')
        }
      )
    }
  })

  // Watch ClutterSync changes and apply to visuals
  engine.addSystem(() => {
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      if (lastState.get(state.itemId) === state.isCleaned) continue
      lastState.set(state.itemId, state.isCleaned)

      const visual = visualEntities.get(state.itemId)
      if (!visual) continue

      pendingCleans.delete(state.itemId)
      setVisible(visual, !state.isCleaned)
    }
  })

  room.onMessage('cleanRejected', (data) => {
    pendingCleans.delete(data.itemId)
    const visual = visualEntities.get(data.itemId)
    if (visual) setVisible(visual, true)
    showToast('Already cleaned!')
  })
}
