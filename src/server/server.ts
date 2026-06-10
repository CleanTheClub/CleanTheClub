import { engine, Entity, Transform, executeTask } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'
import { Storage, EnvVar } from '@dcl/sdk/server'
import { onEnterSceneObservable, onLeaveSceneObservable } from '@dcl/sdk/observables'
import { room } from '../shared/messages'
import { ClutterSync, GameState } from '../shared/schemas'
import { CLUTTER_DEFS, ADMIN_ADDRESSES } from '../shared/config'
import { SCENE_ITEM_PREFIXES, discoverGlasses, discoverBottles, discoverRubbish, discoverStickyPatches } from '../shared/glassDiscovery'
import { initRoundManager, onItemCleaned, onSceneItemCleaned, onPlayerEnter, onPlayerLeave, onAdminReset, onNextRoundRequest, onStartMatch, getPhase } from './RoundManager'

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

// True once we've confirmed (via a settled read) what's actually in storage. Until
// then we must NOT save — a write before a confirmed read can overwrite good data.
let leaderboardLoadConfirmed = false

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type LbRecord = { address: string; displayName: string; total: number }

// ── Persistence backend ───────────────────────────────────────────────────────
// Decentraland Worlds have a server-storage bug: `Storage` is scoped per DEPLOY
// (content hash), not per location, so after a republish the server reads a fresh,
// EMPTY bucket and can never see the previous deploy's data (the owner CLI can,
// because it reads the latest deploy's bucket). Confirmed in production: 90s of
// retried reads all 404'd while the CLI read the data instantly. Retrying can't fix
// a scope problem — the data simply isn't in the bucket the server is allowed to read.
//
// Fix: persist to an EXTERNAL store the server can read consistently across deploys.
// When LEADERBOARD_BIN_ID + LEADERBOARD_BIN_KEY are set (server EnvVars), we use
// jsonbin.io; otherwise we fall back to DCL `Storage` (which works fine on LAND).
let binCfg: { id: string; key: string } | null = null
let binCfgLoaded = false
async function getBinCfg(): Promise<{ id: string; key: string } | null> {
  if (!binCfgLoaded) {
    binCfgLoaded = true
    try {
      const id  = await EnvVar.get('LEADERBOARD_BIN_ID')
      const key = await EnvVar.get('LEADERBOARD_BIN_KEY')
      binCfg = id && key ? { id, key } : null
    } catch (e) {
      console.log('[SERVER] EnvVar read failed — using DCL Storage for leaderboard:', e)
      binCfg = null
    }
    console.log(binCfg
      ? '[SERVER] Leaderboard persistence: external store (jsonbin)'
      : '[SERVER] Leaderboard persistence: DCL Storage (no LEADERBOARD_BIN_* env vars)')
  }
  return binCfg
}

// Read stored records. Returns [] for a confirmed-empty store, or null when the read
// couldn't be completed (treated as "unknown" → keep retrying, never overwrite).
async function loadRecords(): Promise<LbRecord[] | null> {
  const cfg = await getBinCfg()
  if (cfg) {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${cfg.id}/latest`, {
      headers: { 'X-Master-Key': cfg.key },
    })
    if (res.status === 404) return []                       // empty/new bin
    if (!res.ok) throw new Error(`jsonbin read ${res.status}`)
    const json: any = await res.json()
    const rec = json?.record
    return Array.isArray(rec) ? (rec as LbRecord[]) : []
  }
  // DCL Storage fallback — Storage.get returns null on not-found (404).
  const raw = await Storage.get<string>('leaderboard')
  return raw ? (JSON.parse(raw) as LbRecord[]) : null
}

async function saveRecords(records: LbRecord[]): Promise<void> {
  const cfg = await getBinCfg()
  if (cfg) {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${cfg.id}`, {
      method: 'PUT',
      headers: {
        'X-Master-Key':     cfg.key,
        'Content-Type':     'application/json',
        'X-Bin-Versioning': 'false',   // overwrite in place, don't pile up versions
      },
      body: JSON.stringify(records),
    })
    if (!res.ok) throw new Error(`jsonbin write ${res.status}`)
    return
  }
  await Storage.set('leaderboard', JSON.stringify(records))
}

// ── Load / save ───────────────────────────────────────────────────────────────
// We still retry the read (network resilience + the DCL-Storage fallback's cold
// start), but with the external store a 404 means "empty bin" and confirms instantly,
// so this no longer stalls a fresh deploy. We only keep retrying a genuinely failed
// (thrown) or null read, never overwriting before a settled read.
const READ_RETRY_MS  = 4_000    // gap between read attempts
const READ_WINDOW_MS = 30_000   // total time we'll keep trying before giving up
async function loadLeaderboard(): Promise<void> {
  const deadline = Date.now() + READ_WINDOW_MS
  let attempt = 0
  while (true) {
    attempt++
    try {
      const records = await loadRecords()
      if (records !== null) {
        for (const r of records) leaderboard.set(r.address, { displayName: r.displayName, total: r.total })
        console.log(`[SERVER] Loaded leaderboard: ${leaderboard.size} players (attempt ${attempt})`)
        leaderboardLoadConfirmed = true
        return
      }
      // null = read couldn't be completed (DCL-Storage 404). Keep trying to the deadline.
      if (Date.now() >= deadline) {
        console.log(`[SERVER] No leaderboard data after ${attempt} attempts — starting fresh`)
        leaderboardLoadConfirmed = true
        return
      }
    } catch (e) {
      console.log(`[SERVER] leaderboard load attempt ${attempt} failed:`, e)
      if (Date.now() >= deadline) throw e   // give up → saves stay blocked (no wipe)
    }
    await sleep(READ_RETRY_MS)
  }
}

async function saveLeaderboard(): Promise<void> {
  // Never persist before a confirmed read, and never overwrite stored data with an
  // empty map — both are wipe signatures, not legitimate saves.
  if (!leaderboardLoadConfirmed) {
    console.log('[SERVER] Skipping save — leaderboard load not yet confirmed')
    return
  }
  if (leaderboard.size === 0) {
    console.log('[SERVER] Skipping save — leaderboard is empty (guarding against wipe)')
    return
  }
  const records = [...leaderboard.entries()].map(([address, e]) => ({ address, ...e }))
  console.log(`[SERVER] Saving leaderboard: ${records.length} players`)
  try {
    await saveRecords(records)
    console.log(`[SERVER] Saved leaderboard OK (${records.length} players)`)
  } catch (e) {
    console.log('[SERVER] ERROR: leaderboard SAVE failed:', e)
  }
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

  // Scene-placed groups — discovered deterministically (sorted entity ID) so the
  // itemId (= prefix + composite entity id) and enumIds are consistent across server
  // restarts and client discovery.
  //
  // IMPORTANT: we sync a SEPARATE logical entity per item, NOT the visual composite
  // entity. Calling syncEntity on a static composite entity replicates the whole
  // entity (Transform + GltfContainer) to clients as a networked copy, which renders
  // ON TOP of the client's own local composite copy — the "duplicate model" bug.
  // The client bridges ClutterSync ↔ its local visual entity by itemId, so a logical
  // sync entity (ClutterSync only, no visuals) is all that needs to cross the wire.
  for (const { entity, itemId } of [
    ...discoverGlasses(),
    ...discoverBottles(),
    ...discoverRubbish(),
    ...discoverStickyPatches(),
  ]) {
    const syncEnt = engine.addEntity()
    ClutterSync.create(syncEnt, { itemId, isCleaned: false, cleanedAt: 0, cleanedBy: '' })
    syncEntity(syncEnt, [ClutterSync.componentId], enumId++)
    itemEntities.set(itemId, syncEnt)

    // Record original scale (read from the visual composite entity) for round reset
    const tf = Transform.getOrNull(entity)
    sceneItemScales.set(itemId, tf
      ? { x: tf.scale.x, y: tf.scale.y, z: tf.scale.z }
      : { x: 1, y: 1, z: 1 })
  }

  const gameStateEntity = engine.addEntity()
  GameState.create(gameStateEntity, {
    phase: 'lobby',   // boot into the lobby; initRoundManager re-affirms this
    cleanedCount: 0,
    totalCount: itemEntities.size,
    secondsLeft: 0,
    roundNumber: 0,
    outcome: '',
    playersIn: 0,
    starting: false,
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
    if (getPhase() !== 'playing') {   // reject during lobby/countdown and intermission
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

  // Any player can start a match from the lobby (begins the shared countdown).
  room.onMessage('startMatch', (_data, _context) => {
    onStartMatch()
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
      // NOTE: no save here on purpose. Writing the whole leaderboard on every join is
      // unnecessary churn and an extra wipe surface; the display name persists on the
      // player's next score change (scheduleLbUpdate). Just broadcast the current top-10.
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
