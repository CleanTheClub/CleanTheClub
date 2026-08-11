// Hides a scene entity named "clubGrunge" once the club is ≥50% clean.
// Driven by GameState (cleanedCount / totalCount) — same data source as the
// emission system — so it tracks round resets automatically.

import { engine, Entity, Name, VisibilityComponent } from '@dcl/sdk/ecs'
import { gameState } from './phaseGate'

const GRUNGE_ENTITY_NAME = 'clubGrunge'
const HIDE_THRESHOLD     = 0.5   // hide when pct >= this

export function initGrungeSystem(): void {
  let grunge: Entity | undefined
  let lastVisible: boolean | null = null
  let searchedForS = 0
  let gaveUp = false

  engine.addSystem((dt: number) => {
    // One-shot lookup with a 10s bail-out — without it a renamed/missing
    // entity meant a full engine Name scan every frame, forever.
    if (grunge === undefined) {
      if (gaveUp) return
      searchedForS += dt
      for (const [e] of engine.getEntitiesWith(Name)) {
        if (Name.get(e).value === GRUNGE_ENTITY_NAME) { grunge = e; break }
      }
      if (grunge === undefined) {
        if (searchedForS > 10) {
          gaveUp = true
          console.log(`[Grunge] gave up after 10s — "${GRUNGE_ENTITY_NAME}" not found (renamed in Creator Hub?)`)
        }
        return
      }
      console.log(`[Grunge] Found "${GRUNGE_ENTITY_NAME}" (entity ${grunge})`)
    }

    const gs = gameState()
    const pct = gs ? gs.cleanedCount / Math.max(1, gs.totalCount) : 0

    const visible = pct < HIDE_THRESHOLD
    if (visible === lastVisible) return
    lastVisible = visible
    VisibilityComponent.createOrReplace(grunge, { visible })
    console.log(`[Grunge] visible=${visible}  pct=${Math.round(pct * 100)}%`)
  })
}
