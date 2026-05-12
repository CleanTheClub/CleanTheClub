import { engine, Entity, Name, Transform } from '@dcl/sdk/ecs'

export const GLASS_ID_PREFIX = 'glass_'

export type GlassDef = { entity: Entity; glassId: string }

// Finds all children of the scene entity named 'Glasses'.
// Entity IDs are deterministic from the composite file, so both server
// and client discover the same list in the same order.
export function discoverGlasses(): GlassDef[] {
  let glassesParent: Entity | undefined
  for (const [entity] of engine.getEntitiesWith(Name)) {
    if (Name.get(entity).value === 'Glasses') {
      glassesParent = entity
      break
    }
  }
  if (glassesParent === undefined) {
    console.log('[GLASS] "Glasses" parent entity not found')
    return []
  }

  const result: GlassDef[] = []
  for (const [entity] of engine.getEntitiesWith(Transform)) {
    if (Transform.get(entity).parent === glassesParent) {
      result.push({ entity, glassId: `${GLASS_ID_PREFIX}${entity}` })
    }
  }
  result.sort((a, b) => a.entity - b.entity)
  console.log(`[GLASS] Discovered ${result.length} glasses`)
  return result
}
