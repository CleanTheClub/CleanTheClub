// TEMPORARY DIAGNOSTIC — finds GltfContainers sitting on top of each other.
//
// We suspect the "duplicate model on shrink" is a stray second GLB co-located with
// each mess item in the scene (the shrink just reveals it). This scans every
// GltfContainer's world position a few seconds after load (once GLBs have streamed)
// and logs any cluster of 2+ at the same spot, with their entity id + src so you can
// find and delete the extra in Creator Hub.
//
// NOTE: restore furniture legitimately stacks 3 GLBs per item (dirty / anim / clean)
// at the same origin — ignore those triples. Look for co-located PAIRS of the same
// glass / bottle / rubbish .glb.
//
// Remove the initDupeScan() call from initClient once diagnosed.

import { engine, Entity, Transform, GltfContainer } from '@dcl/sdk/ecs'

// Approximate world position by summing local positions up the parent chain.
// Ignores parent rotation/scale — fine for detecting co-located duplicates.
function worldPos(entity: Entity): { x: number; y: number; z: number } {
  let x = 0, y = 0, z = 0
  let cur: Entity | undefined = entity
  let guard = 0
  while (cur !== undefined && cur !== (0 as Entity) && guard++ < 64) {
    const t = Transform.getOrNull(cur)
    if (!t) break
    x += t.position.x
    y += t.position.y
    z += t.position.z
    cur = t.parent
  }
  return { x, y, z }
}

export function initDupeScan(delayS = 6): void {
  let acc = 0
  const scan = (dt: number) => {
    acc += dt
    if (acc < delayS) return
    engine.removeSystem(scan)

    const buckets = new Map<string, { entity: Entity; src: string; pos: { x: number; y: number; z: number } }[]>()
    for (const [entity] of engine.getEntitiesWith(GltfContainer)) {
      const src = GltfContainer.get(entity).src
      const pos = worldPos(entity)
      // ~0.33 m buckets so exact-overlap copies land together.
      const key = `${Math.round(pos.x * 3)}|${Math.round(pos.y * 3)}|${Math.round(pos.z * 3)}`
      const arr = buckets.get(key) ?? []
      arr.push({ entity, src, pos })
      buckets.set(key, arr)
    }

    let clusters = 0
    for (const [, arr] of buckets) {
      if (arr.length < 2) continue
      clusters++
      const p = arr[0].pos
      console.log(`[DUPE] ${arr.length} GLBs at ~(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}):`)
      for (const a of arr) console.log(`[DUPE]    entity ${a.entity}  src=${a.src}`)
    }
    console.log(`[DUPE] Scan complete — ${clusters} co-located cluster(s)`)
  }
  engine.addSystem(scan)
}
