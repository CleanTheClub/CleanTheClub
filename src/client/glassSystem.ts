import { engine, Entity, VisibilityComponent, pointerEventsSystem, PointerEvents, InputAction } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { ClutterSync } from '../shared/schemas'
import { discoverGlasses, GLASS_ID_PREFIX, GlassDef } from '../shared/glassDiscovery'
import { room } from '../shared/messages'
import { showToast } from '../ui'
import { playHoverSound, playClickSound, playCleanSound } from './soundManager'
import { playPickupEmote } from './emoteManager'

const pendingCleans = new Set<string>()
const lastState     = new Map<string, boolean>()
let glasses: GlassDef[] = []

function countCollected(): number {
  let n = 0
  for (const { glassId } of glasses) {
    if (lastState.get(glassId) || pendingCleans.has(glassId)) n++
  }
  return n
}

function setGlassVisible(entity: Entity, visible: boolean) {
  VisibilityComponent.createOrReplace(entity, { visible })
}

function disableGlassClick(entity: Entity) {
  pointerEventsSystem.removeOnPointerDown(entity)
  pointerEventsSystem.removeOnPointerHoverEnter(entity)
  PointerEvents.deleteFrom(entity)
}

function enableGlassClick(entity: Entity, glassId: string) {
  pointerEventsSystem.onPointerHoverEnter({ entity }, () => playHoverSound())
  pointerEventsSystem.onPointerDown(
    { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Collect' } },
    () => {
      if (pendingCleans.has(glassId)) return
      pendingCleans.add(glassId)
      setGlassVisible(entity, false)
      disableGlassClick(entity)
      playClickSound()
      playCleanSound()
      playPickupEmote()
      room.send('cleanItem', { itemId: glassId })
      showToast(`Glasses collected: ${countCollected()} / ${glasses.length}`)
    }
  )
}

export function initGlassSystem() {
  glasses = discoverGlasses()
  if (glasses.length === 0) return

  let clicksEnabled = false
  engine.addSystem(() => {
    if (!isStateSyncronized() || clicksEnabled) return
    clicksEnabled = true
    // Watcher handles initial state; just ensure glasses start visible until watcher fires
    for (const { entity } of glasses) setGlassVisible(entity, true)
  })

  engine.addSystem(() => {
    for (const [syncEnt] of engine.getEntitiesWith(ClutterSync)) {
      const state = ClutterSync.get(syncEnt)
      if (!state.itemId.startsWith(GLASS_ID_PREFIX)) continue
      if (lastState.get(state.itemId) === state.isCleaned) continue
      lastState.set(state.itemId, state.isCleaned)
      pendingCleans.delete(state.itemId)

      const ref = glasses.find(g => g.glassId === state.itemId)
      if (!ref) continue

      setGlassVisible(ref.entity, !state.isCleaned)
      if (state.isCleaned) {
        disableGlassClick(ref.entity)
      } else {
        enableGlassClick(ref.entity, state.itemId)
      }
    }
  })

  room.onMessage('cleanRejected', (data) => {
    if (!data.itemId.startsWith(GLASS_ID_PREFIX)) return
    pendingCleans.delete(data.itemId)
    lastState.delete(data.itemId)
    showToast('Already collected!')
  })
}
