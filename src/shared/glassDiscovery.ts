import { engine, Entity, Name, Transform } from '@dcl/sdk/ecs'

// ── ID prefixes — one per scene group ────────────────────────────────────────
export const GLASS_ID_PREFIX   = 'glass_'
export const BOTTLE_ID_PREFIX  = 'bottle_'
export const RUBBISH_ID_PREFIX = 'rubbish_'

// All scene-item prefixes — used server-side to route cleanItem messages
export const SCENE_ITEM_PREFIXES = [GLASS_ID_PREFIX, BOTTLE_ID_PREFIX, RUBBISH_ID_PREFIX]

export type SceneItemDef = { entity: Entity; itemId: string }

// Generic: finds all children of the named parent entity, sorted by entity ID
// (deterministic from the composite file, so server and client agree on order).
export function discoverChildren(parentName: string, idPrefix: string): SceneItemDef[] {
  let parent: Entity | undefined
  for (const [entity] of engine.getEntitiesWith(Name)) {
    if (Name.get(entity).value === parentName) { parent = entity; break }
  }
  if (parent === undefined) {
    console.log(`[SCENE] "${parentName}" parent entity not found`)
    return []
  }

  const result: SceneItemDef[] = []
  for (const [entity] of engine.getEntitiesWith(Transform)) {
    if (Transform.get(entity).parent === parent) {
      result.push({ entity, itemId: `${idPrefix}${entity}` })
    }
  }
  result.sort((a, b) => a.entity - b.entity)
  console.log(`[SCENE] "${parentName}": discovered ${result.length} items`)
  return result
}

// ── Loose (unparented) named entities ────────────────────────────────────────
// Entities placed directly in the scene without a parent group.
// Add names here as you place more loose items in Creator Hub.

export const LOOSE_BOTTLE_NAMES: string[] = [
  'Bottle_Test',
]

export const LOOSE_GLASS_NAMES:   string[] = []
export const LOOSE_RUBBISH_NAMES: string[] = []

// Finds scene entities by their Name component value.
// Uses entity ID as the unique itemId suffix — consistent across server and client.
export function discoverByName(names: string[], idPrefix: string): SceneItemDef[] {
  if (names.length === 0) return []
  const nameSet = new Set(names)
  const result: SceneItemDef[] = []
  for (const [entity] of engine.getEntitiesWith(Name)) {
    if (nameSet.has(Name.get(entity).value)) {
      result.push({ entity, itemId: `${idPrefix}${entity}` })
      console.log(`[SCENE] "${Name.get(entity).value}" (entity ${entity}) → ${idPrefix}${entity}`)
    }
  }
  return result
}

// Convenience wrappers — merge parent-group children with any loose named entities
export const discoverGlasses = () => [
  ...discoverChildren('Glasses', GLASS_ID_PREFIX),
  ...discoverByName(LOOSE_GLASS_NAMES, GLASS_ID_PREFIX),
]
export const discoverBottles = () => [
  ...discoverChildren('Bottles', BOTTLE_ID_PREFIX),
  ...discoverByName(LOOSE_BOTTLE_NAMES, BOTTLE_ID_PREFIX),
]
export const discoverRubbish = () => [
  ...discoverChildren('Rubbish', RUBBISH_ID_PREFIX),
  ...discoverByName(LOOSE_RUBBISH_NAMES, RUBBISH_ID_PREFIX),
]

// Legacy type alias — keeps glassSystem.ts import happy during migration
export type GlassDef = SceneItemDef & { glassId: string }
