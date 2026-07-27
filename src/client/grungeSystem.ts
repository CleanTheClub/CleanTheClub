// Hides a scene entity named "clubGrunge" once the club is ≥50% clean.
// Driven by GameState (cleanedCount / totalCount) — same data source as the
// emission system — so it tracks round resets automatically.

import { engine, Entity, Name, VisibilityComponent } from '@dcl/sdk/ecs'
import { GameState } from '../shared/schemas'

const GRUNGE_ENTITY_NAME = 'clubGrunge'
const HIDE_THRESHOLD     = 0.5   // hide when pct >= this

export function initGrungeSystem(): void {
  let grunge: Entity | undefined
  let lastVisible: boolean | null = null

  engine.addSystem(() => {
    // One-shot lookup — keep trying each frame until the scene entity loads.
    if (grunge === undefined) {
      for (const [e] of engine.getEntitiesWith(Name)) {
        if (Name.get(e).value === GRUNGE_ENTITY_NAME) { grunge = e; break }
      }
      if (grunge === undefined) return
      console.log(`[Grunge] Found "${GRUNGE_ENTITY_NAME}" (entity ${grunge})`)
    }

    let pct = 0
    for (const [, gs] of engine.getEntitiesWith(GameState)) {
      pct = gs.cleanedCount / Math.max(1, gs.totalCount)
      break
    }

    const visible = pct < HIDE_THRESHOLD
    if (visible === lastVisible) return
    lastVisible = visible
    VisibilityComponent.createOrReplace(grunge, { visible })
    console.log(`[Grunge] visible=${visible}  pct=${Math.round(pct * 100)}%`)
  })
}
