// One authoritative ClutterSync scan, shared by every consumer system.
//
// Seven systems (rubbish, glasses, bottles, theme spawns, holds, restore props,
// stink) each ran their own 10 Hz engine.getEntitiesWith(ClutterSync) loop over
// every synced item — ~8,700 component reads/sec, >95% discarded by a prefix
// check. This module scans ONCE per poll and hands each subscriber the same
// snapshot array; subscribers keep their own change detection (their lastState
// semantics differ — cleanRejected and scene re-entry deliberately reset them
// per consumer).

import { engine, Entity } from '@dcl/sdk/ecs'
import { ClutterSync } from '../shared/schemas'
import { SYNC_POLL_S } from './phaseGate'

export type ClutterEntry = { entity: Entity; itemId: string; isCleaned: boolean }

type PollSubscriber = (entries: readonly ClutterEntry[]) => void

const subscribers: PollSubscriber[] = []
const entries: ClutterEntry[] = []
const byId = new Map<string, ClutterEntry>()
let systemAdded = false

/** Latest snapshot entry for one item (fresh as of the last poll). */
export function clutterEntry(itemId: string): ClutterEntry | undefined {
  return byId.get(itemId)
}

/**
 * Subscribe to the shared poll. The callback receives EVERY synced item each
 * poll (not just changes) — filter by prefix and diff against your own state.
 * The first subscription starts the system, so this must only be called from
 * client init paths (a module-scope call would add the system on the server).
 */
export function onClutterPoll(cb: PollSubscriber): void {
  subscribers.push(cb)
  if (systemAdded) return
  systemAdded = true
  let acc = 0
  engine.addSystem((dt: number) => {
    acc += dt
    if (acc < SYNC_POLL_S) return
    acc = 0
    entries.length = 0
    byId.clear()
    for (const [entity] of engine.getEntitiesWith(ClutterSync)) {
      const s = ClutterSync.get(entity)
      const e = { entity, itemId: s.itemId, isCleaned: s.isCleaned }
      entries.push(e)
      byId.set(s.itemId, e)
    }
    for (const sub of subscribers) sub(entries)
  })
}
