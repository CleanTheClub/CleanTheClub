import { engine, Entity, Transform, executeTask } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import { onEnterSceneObservable, onLeaveSceneObservable } from '@dcl/sdk/observables'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, ADMIN_ADDRESSES } from '../shared/config'
import { SCENE_ITEM_PREFIXES, discoverGlasses, discoverBottles, discoverRubbish, discoverStickyPatches } from '../shared/glassDiscovery'
import { initRoundManager, onItemCleaned, onSceneItemCleaned, onPlayerEnter, onPlayerLeave, onAdminReset, onNextRoundRequest, getPhase } from './RoundManager'

// ── Leaderboard ───────────────────────────────────────────────
interface LeaderboardEntry { displayName: string; total: number }
const leaderboard = new Map<string, LeaderboardEntry>()  // address → entry

// Single-promise guard — ensures loadLeaderboard() only ever runs once,
// even if ensureLeaderboardLoaded() is called concurrently by multiple handlers.
let leaderboardLoadPromise: Promise<void> | null = null

function ensureLeaderboardLoaded(): Promise<void> {
  if (!leaderboardLoadPromise) leaderboardLoadPromise = loadLeaderboard()
  return leaderboardLoadPromise
}

async function loadLeaderboard(): Promise<void> {
  try {
    const raw = await Storage.get<string>('leaderboard')
    if (!raw) {
      console.log('[SERVER] No leaderboard data — starting fresh')
    } else {
      const records: Array<{ address: string; displayName: string; total: number }> = JSON.parse(raw)
      for (const r of records) leaderboard.set(r.address, { displayName: r.displayName, total: r.total })
      console.log(`[SERVER] Loaded leaderboard: ${leaderboard.size} players`)
    }
  } catch (e) {
    // Reject the promise so all callers that await ensureLeaderboardLoaded() also
    // fail — preventing any save that would overwrite good data with an empty map.
    console.log('[SERVER] ERROR: leaderboard load failed — saves blocked to prevent data loss:', e)
    throw e
  }
}

async function saveLeaderboard(): Promise<void> {
  const records = [...leaderboard.entries()].map(([address, e]) => ({ address, ...e }))
  console.log(`[SERVER] Saving leaderboard: ${records.length} players`)
  await Storage.set('leaderboard', JSON.stringify(records))
}

function leaderboardJson(): string {
  return JSON.stringify(
    [...leaderboard.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map(e => ({ displayName: e.displayName, count: e.total }))
  )
}

function broadcastLeaderboard(to?: string[]): void {
  const entriesJson = leaderboardJson()
  if (to) {
    room.send('leaderboardUpdate', { entriesJson }, { to })
  } else {
    room.send('leaderboardUpdate', { entriesJson })
  }
}

// Trailing debounce — collapses rapid back-to-back cleanItem score updates
// into a single save+broadcast after LB_DEBOUNCE_MS of quiet.
const LB_DEBOUNCE_MS = 4_000
let lbDebounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleLbUpdate(): void {
  if (lbDebounceTimer !== null) clearTimeout(lbDebounceTimer)
  lbDebounceTimer = setTimeout(() => {
    lbDebounceTimer = null
    executeTask(async () => {
      // Always wait for the load to complete before saving — prevents overwriting
      // good stored data with an empty map on a cold server start where a player
      // cleans an item within the first 4 seconds (before Storage.get resolves).
      try {
        await ensureLeaderboardLoaded()
      } catch {
        console.log('[SERVER] Leaderboard load failed — skipping save to prevent data loss')
        return
      }
      await saveLeaderboard()
      broadcastLeaderboard()
    })
  }, LB_DEBOUNCE_MS)
}

export function initServer() {
  console.log('[SERVER] started')

  const itemEntities    = new Map<string, Entity>()
  const sceneItemScales = new Map<string, { x: number; y: number; z: number }>()
  let enumId = 1

  // CLUTTER_DEFS items — new entities created by the server
  for (const def of CLUTTER_DEFS) {
    const entity = engine.addEntity()
    ClutterSync.create(entity, { itemId: def.id, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [ClutterSync.componentId], enumId++)
    itemEntities.set(def.id, entity)
  }

  // Scene-placed groups — ClutterSync added to existing composite entities.
  // Each group is discovered deterministically (sorted entity ID) so enumIds
  // are consistent across server restarts and client discovery.
  for (const { entity, itemId } of [
    ...discoverGlasses(),
    ...discoverBottles(),
    ...discoverRubbish(),
    ...discoverStickyPatches(),
  ]) {
    ClutterSync.create(entity, { itemId, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(entity, [ClutterSync.componentId], enumId++)
    itemEntities.set(itemId, entity)

    // Record original scale so we can restore it after round reset
    const tf = Transform.getOrNull(entity)
    sceneItemScales.set(itemId, tf
      ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z }
      : { x: 1, y: 1, z: 1 })
  }

  const gameStateEntity = engine.addEntity()
  GameState.create(gameStateEntity, {
    phase: 'playing',
    cleanedCount: 0,
    totalCount: itemEntities.size,
    secondsLeft: 0,
    roundNumber: 0,
    outcome: '',
  })
  syncEntity(gameStateEntity, [GameState.componentId], enumId)

  // Restores original Transform scales for all scene items (called on round reset)
  function restoreSceneItemScales() {
    for (const [itemId, origScale] of sceneItemScales) {
      const e = itemEntities.get(itemId)
      if (!e) continue
      const tf = Transform.getMutableOrNull(e)
      if (tf) tf.scale = { x: origScale.x, y: origScale.y, z: origScale.z }
    }
  }

  initRoundManager(itemEntities, gameStateEntity, restoreSceneItemScales)

  // Load persisted leaderboard from Storage (async — data arrives soon after startup).
  // ensureLeaderboardLoaded() guarantees only one load ever runs, even if registerPlayer
  // fires concurrently before this completes.
  executeTask(async () => {
    await ensureLeaderboardLoaded()
  })

  // Track which session IDs are currently counted as "in scene".
  // Guards against double-counting when both onEnterSceneObservable AND
  // registerPlayer fire for the same player (the normal walk-in path), and
  // ensures teleport-in players (who skip the boundary event) are still counted
  // once registerPlayer arrives.
  const activeSessions = new Set<string>()

  function playerEntered(sessionId: string) {
    if (activeSessions.has(sessionId)) return
    activeSessions.add(sessionId)
    onPlayerEnter()
  }

  function playerLeft(sessionId: string) {
    if (!activeSessions.has(sessionId)) return
    activeSessions.delete(sessionId)
    onPlayerLeave()
  }

  onEnterSceneObservable.add((player) => {
    playerEntered(player.userId)
  })
  onLeaveSceneObservable.add((player) => {
    playerLeft(player.userId)
  })

  room.onMessage('cleanItem', (data, context) => {
    if (!context) return
    if (getPhase() === 'open') {
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      return
    }
    const entity = itemEntities.get(data.itemId)
    if (!entity || ClutterSync.getOrNull(entity)?.isCleaned) {
      room.send('cleanRejected', { itemId: data.itemId }, { to: [context.from] })
      return
    }
    const now = Date.now()
    const cs = ClutterSync.getMutable(entity)
    cs.isCleaned = true
    cs.cleanedAt = now
    cs.cleanedBy = context.from

    // Update all-time leaderboard score for this player.
    // Only runs after the leaderboard has loaded (leaderboardLoadPromise resolved).
    // scheduleLbUpdate() debounces rapid back-to-back saves — one disk write per burst.
    if (leaderboardLoadPromise !== null) {
      const address = context.from
      const entry = leaderboard.get(address)
      if (entry) {
        entry.total += 1
      } else {
        leaderboard.set(address, { displayName: address.slice(0, 8) + '…', total: 1 })
      }
      scheduleLbUpdate()
    }

    const isSceneItem = SCENE_ITEM_PREFIXES.some(p => data.itemId.startsWith(p))
    if (isSceneItem) {
      // Hide the item by collapsing its scale — server is HOST so CRDT propagates to all clients
      const tf = Transform.getMutableOrNull(entity)
      if (tf) tf.scale = { x: 0.001, y: 0.001, z: 0.001 }
      // Decay: restore the item after CLUTTER_RESPAWN_MS, same as regular clutter.
      // The callback flips isCleaned and restores the original scale so clients
      // pick it up via ClutterSync and re-enable clicks automatically.
      const itemId = data.itemId
      onSceneItemCleaned(itemId, () => {
        const e = itemEntities.get(itemId)
        if (!e) return
        const cs = ClutterSync.getMutable(e)
        cs.isCleaned = false
        cs.cleanedAt = 0
        cs.cleanedBy = ''
        const orig = sceneItemScales.get(itemId)
        if (orig) {
          const t2 = Transform.getMutableOrNull(e)
          if (t2) t2.scale = { x: orig.x, y: orig.y, z: orig.z }
        }
      })
    } else {
      const def = CLUTTER_DEFS.find(d => d.id === data.itemId)
      if (!def) {
        console.log(`[SERVER] cleanItem: unknown itemId '${data.itemId}' — skipped`)
        return
      }
      onItemCleaned(def)
    }
  })

  // No-op: client sends this immediately on join (before getUserData) to wake a cold server.
  room.onMessage('ping', (_data, _context) => {})

  room.onMessage('startNextRound', (_data, _context) => {
    onNextRoundRequest()
  })

  room.onMessage('registerPlayer', (data, context) => {
    if (!context) return
    const address = context.from

    // Fallback enter-trigger for players who teleport directly into the scene
    // and skip the parcel-boundary crossing that fires onEnterSceneObservable.
    playerEntered(address)

    executeTask(async () => {
      // ensureLeaderboardLoaded() returns the in-flight Promise if already loading,
      // so concurrent registerPlayer calls never start a second disk read.
      await ensureLeaderboardLoaded()
      const existing = leaderboard.get(address)
      if (existing) {
        existing.displayName = data.displayName
      } else {
        leaderboard.set(address, { displayName: data.displayName, total: 0 })
      }
      // Persist the updated display name; broadcast top-10 only to this player.
      await saveLeaderboard()
      broadcastLeaderboard([address])
      console.log(`[SERVER] registerPlayer: ${data.displayName} (${address})`)
    })
  })

  room.onMessage('adminReset', (_data, context) => {
    if (!context) return
    if (!ADMIN_ADDRESSES.includes(context.from.toLowerCase())) {
      console.log(`[SERVER] adminReset rejected — not an admin: ${context.from}`)
      return
    }
    onAdminReset()
  })
}
