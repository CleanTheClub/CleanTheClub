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
  /**
   * 'pending'    — no resolution attempted yet (boot).
   * 'jsonbin'    — external store resolved and in use.
   * 'storage'    — DCL Storage fallback in use (only when REQUIRE_EXTERNAL_STORE is off).
   * 'unresolved' — attempted, but the BIN_* pair did not resolve. Distinct from
   *                'pending': it is a live fault, not a boot state. Unset vars
   *                and a failing EnvVar read are indistinguishable here by
   *                design (see getBinCfg), so the log is the tie-breaker.
   */
  backend: 'jsonbin' | 'storage' | 'pending' | 'unresolved'
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

  // ── Backend resolution ──────────────────────────────────────────────────────
  // Cache ONLY a POSITIVE resolution. `EnvVar.get` does not throw when the
  // storage-service read fails — it logs and returns '' (@dcl/sdk/src/server/
  // env-var.ts: `if (error) { console.error(...); return '' }`, and the typings
  // say "or empty string if not found"). So '' is genuinely ambiguous: the var
  // may be unset for this world, OR the read may have just failed.
  //
  // The 2026-08-17 fix tried to keep a transient blip out of the cache by moving
  // the latch inside a try/catch. That catch is unreachable for service failures,
  // so the latch closed anyway and pinned the WHOLE server session to a null
  // config: `read()` then threw under REQUIRE_EXTERNAL_STORE, and every
  // foreground retry AND the forever background loop re-read the cached null
  // instead of re-asking. One bad read at boot — exactly when the platform is
  // coldest — blocked every save until the next deploy restarted the process,
  // which reads to players as "the deploy wiped my career".
  //
  // Never caching the negative is what makes those retry loops able to heal. The
  // cost is two EnvVar fetches per attempt while unresolved (8 across the 30s
  // window, then one pair a minute); once resolved it is cached for good.
  let binCfg: { id: string; key: string } | null = null
  let binCfgAttempted = false
  async function getBinCfg(): Promise<{ id: string; key: string } | null> {
    if (binCfg) return binCfg
    binCfgAttempted = true

    let id = ''
    let bk = ''
    try {
      id = await EnvVar.get(`${envPrefix}_BIN_ID`)
      bk = await EnvVar.get(`${envPrefix}_BIN_KEY`)
    } catch (e) {
      // Only reachable off-server (assertIsServer), but a throw must behave
      // exactly like an unreadable value: report it, cache nothing, re-ask.
      console.log(`[STORE:${key}] EnvVar read threw (will re-ask):`, e)
      return null
    }

    if (id && bk) {
      binCfg = { id, key: bk }
      console.log(`[STORE:${key}] persistence: external store (jsonbin)`)
      return binCfg
    }

    // Half-configured is always a deploy mistake, never a transient read: both
    // values live in the same place, so one arriving without the other means the
    // pair was set wrong. Its own line, because waiting will not fix it.
    if (id || bk) {
      const present = id ? `${envPrefix}_BIN_ID` : `${envPrefix}_BIN_KEY`
      const missing = id ? `${envPrefix}_BIN_KEY` : `${envPrefix}_BIN_ID`
      console.log(`[STORE:${key}] WARNING: ${present} resolved but ${missing} did not — the ` +
        `${envPrefix}_BIN_* pair is half-configured. Set BOTH and republish (see DEPLOY.md).`)
    } else {
      console.log(`[STORE:${key}] ${envPrefix}_BIN_* unresolved — either unset for this world, or the ` +
        `EnvVar read failed. The SDK logs "Failed to fetch environment variable" immediately above when ` +
        `it was a failed read; nothing above means genuinely unset. Will re-ask (see DEPLOY.md).`)
    }
    return null
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
      if (res.status === 404) {
        // A 404 means jsonbin holds no document at this id. That is correct and
        // expected on a brand-new bin — but it is ALSO exactly what a mistyped
        // or re-pointed BIN_ID looks like, and the two are indistinguishable
        // from here. Either way the load counts as settled-empty, so the next
        // save writes this session's records as the WHOLE document: a re-point
        // silently replaces the careers it can no longer see. Loud in the boot
        // log, because the only recovery is the OLD bin's version history.
        console.log(`[STORE:${key}] WARNING: jsonbin 404 for the configured ${envPrefix}_BIN_ID — ` +
          `treating this document as EMPTY. Expected only on a brand-new bin. If it should have had ` +
          `data, stop the world and check ${envPrefix}_BIN_ID before the next save overwrites from ` +
          `an empty base (see DEPLOY.md).`)
        return null
      }
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
        backend: binCfg ? 'jsonbin'
          : !binCfgAttempted ? 'pending'
          // With the external store required there IS no DCL Storage fallback —
          // read() refuses instead — so an unresolved pair must not report as
          // 'storage', which would claim a backend that is never used.
          : REQUIRE_EXTERNAL_STORE ? 'unresolved'
          : 'storage',
        loadConfirmed,
        loadFailed,
        lastSaveOk,
        lastSaveMs,
      }
    },
  }
}
