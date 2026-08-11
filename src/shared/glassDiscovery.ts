import { engine, Entity, Name, Transform } from '@dcl/sdk/ecs'

// ── ID prefixes — one per scene group ────────────────────────────────────────
export const GLASS_ID_PREFIX   = 'glass_'
export const BOTTLE_ID_PREFIX  = 'bottle_'
export const RUBBISH_ID_PREFIX = 'rubbish_'
export const STICKY_ID_PREFIX  = 'sticky_'

// All scene-item prefixes — used server-side to route cleanItem messages
export const SCENE_ITEM_PREFIXES = [GLASS_ID_PREFIX, BOTTLE_ID_PREFIX, RUBBISH_ID_PREFIX, STICKY_ID_PREFIX]

// ── Rubbish sorting (recycling) ──────────────────────────────────────────────
// Every rubbish item is either general waste or recyclable, classified from its
// scene Name. SHARED so the server (which enforces deposits and carry counts)
// and the client (bins, hover text, chip) can never disagree about a type.
export type RubbishType = 'general' | 'recycle'

// Name fragments that mark an item recyclable: paper (napkins, polaroids) and
// glass (broken bottles/glasses, drink cups). Only ever applied to items in the
// Rubbish group, so the glass_/bottle_ collectible groups are unaffected.
const RECYCLE_NAME_PARTS = ['napkin', 'polaroid', 'bottle', 'glass', 'drink']

export function classifyRubbish(name: string): RubbishType {
  const n = name.toLowerCase()
  return RECYCLE_NAME_PARTS.some((p) => n.includes(p)) ? 'recycle' : 'general'
}

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
export const LOOSE_STICKY_NAMES:  string[] = []

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

// Convenience wrappers — merge parent-group children with any loose named
// entities. MEMOIZED (project cleanup): five systems call these at init, and
// each un-cached call was a full engine Name + Transform scan plus a duplicate
// "[SCENE] discovered N items" log line. The composite is static after load,
// so the first result is the result.
const discoveryCache = new Map<string, SceneItemDef[]>()
function cached(key: string, compute: () => SceneItemDef[]): SceneItemDef[] {
  let hit = discoveryCache.get(key)
  if (!hit) {
    hit = compute()
    // An empty result may just mean we ran before the composite finished
    // loading — don't cache it, let the next caller retry.
    if (hit.length > 0) discoveryCache.set(key, hit)
  }
  return hit
}
export const discoverGlasses = () => cached('glasses', () => [
  ...discoverChildren('Glasses', GLASS_ID_PREFIX),
  ...discoverByName(LOOSE_GLASS_NAMES, GLASS_ID_PREFIX),
])
export const discoverBottles = () => cached('bottles', () => [
  ...discoverChildren('Bottles', BOTTLE_ID_PREFIX),
  ...discoverByName(LOOSE_BOTTLE_NAMES, BOTTLE_ID_PREFIX),
])
export const discoverRubbish = () => cached('rubbish', () => [
  ...discoverChildren('Rubbish', RUBBISH_ID_PREFIX),
  ...discoverByName(LOOSE_RUBBISH_NAMES, RUBBISH_ID_PREFIX),
])
export const discoverStickyPatches = () => cached('sticky', () => [
  ...discoverChildren('StickyPatches', STICKY_ID_PREFIX),
  ...discoverByName(LOOSE_STICKY_NAMES, STICKY_ID_PREFIX),
])

// Legacy type alias — keeps glassSystem.ts import happy during migration
export type GlassDef = SceneItemDef & { glassId: string }
