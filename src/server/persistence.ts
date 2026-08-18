// Server-side persisted documents.
//
// Generalises the dual-backend pattern the leaderboard already proved in production
// so progression data reuses it rather than reinventing it — including the wipe
// guards, which exist because of real data loss.
//
// WHY NOT JUST DCL Storage:
// The docs state storage persists at the LOCATION level and survives redeploys. This
// scene observed the opposite in production on a WORLD (cleantheclub.dcl.eth): after
// a republish the server read a fresh, empty bucket and never saw the previous
// deploy's data — 90s of retried reads all 404'd while the owner CLI read it
// instantly, i.e. storage behaved as if scoped per DEPLOY (content hash). Retrying
// can't fix a scope problem. The leaderboard's workaround was an external store.
//
// That discrepancy is UNRESOLVED and worth re-testing before trusting it (deploy →
// write → redeploy → read). Until then every persisted document goes through this
// module, so if DCL Storage turns out to be fixed, switching back is deleting the
// external branch in ONE file rather than auditing every call site.
//
// Backend selection is per document, via server EnvVars:
//   <PREFIX>_BIN_ID + <PREFIX>_BIN_KEY set → jsonbin.io (survives redeploys)
//   otherwise                              → DCL Storage (fine on LAND)

import { Storage, EnvVar } from '@dcl/sdk/server'
import { REQUIRE_EXTERNAL_STORE } from '../shared/config'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const READ_RETRY_MS  = 4_000    // gap between read attempts
const READ_WINDOW_MS = 30_000   // total time to keep trying before giving up

// Log a warning once a stored document passes this size. Not a hard limit —
// just an early signal that the playerbase has outgrown "one document holds
// everyone", well before an external store starts rejecting the write.
const SIZE_WARN_BYTES = 100 * 1024

export type DocStatus = {
  /** 'pending' until the first backend resolution. */
  backend: 'jsonbin' | 'storage' | 'pending'
  loadConfirmed: boolean
  /** True once the load has DEFINITIVELY failed (retry window exhausted, or
   *  external store required but unconfigured) — drives the player-facing
   *  "progress not saving" warning, distinct from a load still in flight. */
  loadFailed?: boolean
  /** null until a save has been attempted. */
  lastSaveOk: boolean | null
  lastSaveMs: number
}

export type PersistedDoc<T> = {
  /** Loads once; concurrent callers share the same in-flight promise. */
  ensureLoaded(): Promise<T | null>
  /**
   * Persists `value`. Refuses to write before a confirmed read (wipe guard).
   * Writes are SERIALIZED: overlapping calls (shift end racing a player-leave
   * checkpoint) queue in order instead of racing two full-document PUTs where
   * the older snapshot could land last. Resolves true only when the value hit
   * the backend — callers use false to keep their dirty flag set for a retry.
   */
  save(value: T): Promise<boolean>
  /** Live health snapshot — surfaced in-world so failures can't stay silent. */
  status(): DocStatus
  /**
   * Registers a callback for a load that succeeds AFTER the initial retry
   * window gave up (background recovery — fired at most once, with the stored
   * value). Incident 2026-08-17: a ~15s-per-attempt jsonbin outage exhausted
   * the 30s window and condemned the whole server session to empty careers,
   * even though connectivity returned minutes later. The background loop keeps
   * trying forever; when it lands, the caller merges and pushes the restored
   * state to everyone connected.
   */
  onLateLoad(cb: (value: T | null) => void): void
}

/**
 * @param key       storage key / logical document name
 * @param envPrefix EnvVar prefix for the external-store credentials
 * @param isEmpty   guard: a value this reports as empty is never written over
 *                  existing data. Overwriting good data with an empty document is
 *                  the exact signature of the wipes this protects against.
 */
export function createPersistedDoc<T>(
  key: string,
  envPrefix: string,
  isEmpty: (value: T) => boolean,
): PersistedDoc<T> {
  let loadPromise: Promise<T | null> | null = null
  let loadConfirmed = false
  let loadFailed = false
  let lastSaveOk: boolean | null = null
  let lastSaveMs = 0

  // ── Backend resolution (once per document) ──────────────────────────────────
  let binCfg: { id: string; key: string } | null = null
  let binCfgLoaded = false
  async function getBinCfg(): Promise<{ id: string; key: string } | null> {
    if (binCfgLoaded) return binCfg
    try {
      const id  = await EnvVar.get(`${envPrefix}_BIN_ID`)
      const bk  = await EnvVar.get(`${envPrefix}_BIN_KEY`)
      binCfg = id && bk ? { id, key: bk } : null
      // Cache ONLY a clean answer. A clean-but-empty read ("no vars set") is a
      // definitive configuration fact; an ERROR is a transient EnvVar-service
      // blip — and caching that null used to lock the ENTIRE server session
      // into the DCL Storage fallback off one bad read at boot, exactly when
      // the platform is coldest. Plausible root cause of the 2026-08-17 wipe
      // scare. Left uncached, the load retry loop re-asks every attempt.
      binCfgLoaded = true
    } catch (e) {
      console.log(`[STORE:${key}] EnvVar read ERROR (transient? will retry):`, e)
      binCfg = null
      return null
    }
    console.log(binCfg
      ? `[STORE:${key}] persistence: external store (jsonbin)`
      : `[STORE:${key}] persistence: DCL Storage (no ${envPrefix}_BIN_* env vars)`)
    return binCfg
  }

  // Returns the parsed document, or null when the read could not be COMPLETED.
  // null means "unknown" (keep retrying, never overwrite); a genuinely empty
  // document must come back as a real value, not null.
  async function read(): Promise<T | null> {
    const cfg = await getBinCfg()
    // INCIDENT GUARD (2026-08-17): with credentials missing this used to fall
    // back to DCL Storage — whose per-deploy bucket reads empty after every
    // republish — so a publish without EnvVars looked like a full career wipe
    // and quietly diverged new progress into an unreachable bucket. Refusing
    // outright keeps saves blocked (loadConfirmed never sets) and the failure
    // visible until the credentials are restored. See REQUIRE_EXTERNAL_STORE.
    if (!cfg && REQUIRE_EXTERNAL_STORE) {
      throw new Error(`external store REQUIRED but ${envPrefix}_BIN_* EnvVars are missing — refusing DCL Storage fallback`)
    }
    if (cfg) {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${cfg.id}/latest`, {
        headers: { 'X-Master-Key': cfg.key },
      })
      if (res.status === 404) return null            // empty/new bin — nothing stored yet
      if (!res.ok) throw new Error(`jsonbin read ${res.status}`)
      const json: any = await res.json()
      return (json?.record ?? null) as T | null
    }
    const raw = await Storage.get<string>(key)
    return raw ? (JSON.parse(raw) as T) : null
  }

  // The FIRST write of each server session is VERSIONED: jsonbin keeps the
  // previous document as a recoverable version, so every deploy leaves one
  // point-in-time snapshot behind ("data must always be saved and not
  // overwritten" — incident 2026-08-17). Subsequent writes overwrite in place
  // as before, so versions accumulate per deploy, not per shift.
  let versionedThisSession = false

  async function write(value: T): Promise<void> {
    const cfg = await getBinCfg()
    if (cfg) {
      const versionThis = !versionedThisSession
      const put = (versioned: boolean) => fetch(`https://api.jsonbin.io/v3/b/${cfg.id}`, {
        method: 'PUT',
        headers: {
          'X-Master-Key':     cfg.key,
          'Content-Type':     'application/json',
          'X-Bin-Versioning': versioned ? 'true' : 'false',
        },
        body: JSON.stringify(value),
      })
      let res = await put(versionThis)
      // The versioned snapshot write is BEST-EFFORT: a plan/bin that refuses
      // versioning (403) must not poison every later save — before this
      // fallback, the failed first write left versionedThisSession false, so
      // EVERY save retried versioned and 403'd forever (field logs 2026-08-18:
      // "jsonbin write 403" on each checkpoint). One refusal disables the
      // snapshot for the session and the save goes through plain.
      if (!res.ok && versionThis && res.status === 403) {
        console.log(`[STORE:${key}] versioned write 403 — plan/bin refuses versioning; retrying unversioned (no recovery snapshot this session)`)
        versionedThisSession = true
        res = await put(false)
      }
      if (!res.ok) throw new Error(`jsonbin write ${res.status}`)
      if (versionThis && !versionedThisSession) {
        versionedThisSession = true
        console.log(`[STORE:${key}] first save this session — previous document kept as a jsonbin version (recovery point)`)
      }
      return
    }
    // Storage.set resolves FALSE on failure (rate cap, size) rather than
    // throwing — ignoring it silently loses the write (official guidance).
    const ok = await Storage.set(key, JSON.stringify(value))
    if (!ok) throw new Error('Storage.set rejected the write')
  }

  async function load(): Promise<T | null> {
    const deadline = Date.now() + READ_WINDOW_MS
    let attempt = 0
    while (true) {
      attempt++
      try {
        const value = await read()
        // A settled read — including a confirmed-absent document — tells us what is
        // stored, which is all the save guard needs.
        console.log(`[STORE:${key}] loaded on attempt ${attempt}${value === null ? ' (empty)' : ''}`)
        loadConfirmed = true
        return value
      } catch (e) {
        console.log(`[STORE:${key}] load attempt ${attempt} failed:`, e)
        // Give up → loadConfirmed stays false → saves stay blocked, so a transient
        // outage can never cause us to overwrite good data with a fresh empty doc.
        // Give up on the FOREGROUND load only: the background loop below keeps
        // trying for the session's whole life, so a passing outage heals.
        if (Date.now() >= deadline) {
          loadFailed = true
          startBackgroundRetry()
          throw e
        }
      }
      await sleep(READ_RETRY_MS)
    }
  }

  // ── Background recovery (see onLateLoad) ────────────────────────────────────
  let lateLoadCb: ((value: T | null) => void) | null = null
  let bgRetryStarted = false
  const BG_RETRY_MS = 60_000
  function startBackgroundRetry(): void {
    if (bgRetryStarted) return
    bgRetryStarted = true
    const loop = async () => {
      while (true) {
        await sleep(BG_RETRY_MS)
        try {
          const value = await read()
          loadConfirmed = true
          loadFailed = false
          console.log(`[STORE:${key}] LATE load succeeded — store back online, restoring stored data`)
          lateLoadCb?.(value)
          return
        } catch (e) {
          console.log(`[STORE:${key}] background retry failed (trying again in ${BG_RETRY_MS / 1000}s):`, e)
        }
      }
    }
    loop()
  }

  async function doSave(value: T): Promise<boolean> {
    if (!loadConfirmed) {
      console.log(`[STORE:${key}] skipping save — load not yet confirmed`)
      return false
    }
    if (isEmpty(value)) {
      console.log(`[STORE:${key}] skipping save — document is empty (wipe guard)`)
      return false
    }
    try {
      const body = JSON.stringify(value)
      // Size watch. These documents hold one record per player forever, so they
      // grow with the playerbase rather than with activity — fine at hundreds,
      // a problem at thousands (external stores cap request size, and every
      // shift end rewrites the WHOLE document). Warn early enough to act
      // before a write starts failing in production.
      if (body.length >= SIZE_WARN_BYTES) {
        console.log(`[STORE:${key}] WARNING: document is ${Math.round(body.length / 1024)}KB ` +
          `(warn at ${Math.round(SIZE_WARN_BYTES / 1024)}KB) — consider pruning inactive records`)
      }
      await write(value)
      lastSaveOk = true
      lastSaveMs = Date.now()
      console.log(`[STORE:${key}] saved OK (${Math.round(body.length / 1024)}KB)`)
      return true
    } catch (e) {
      lastSaveOk = false
      lastSaveMs = Date.now()
      console.log(`[STORE:${key}] ERROR: save failed:`, e)
      return false
    }
  }

  // Write serialization — each save waits for the previous one to settle, so
  // two checkpoints can never have PUTs in flight simultaneously (last-write-
  // wins on the backend would otherwise let the OLDER snapshot land last).
  let saveChain: Promise<boolean> = Promise.resolve(true)

  return {
    ensureLoaded(): Promise<T | null> {
      if (!loadPromise) loadPromise = load()
      return loadPromise
    },


    save(value: T): Promise<boolean> {
      saveChain = saveChain.then(() => doSave(value))
      return saveChain
    },

    onLateLoad(cb: (value: T | null) => void): void {
      lateLoadCb = cb
    },

    status(): DocStatus {
      return {
        backend: !binCfgLoaded ? 'pending' : binCfg ? 'jsonbin' : 'storage',
        loadConfirmed,
        loadFailed,
        lastSaveOk,
        lastSaveMs,
      }
    },
  }
}
