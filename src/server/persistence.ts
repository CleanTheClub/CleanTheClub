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

// Per-ATTEMPT deadlines. Without these READ_WINDOW_MS is not a 30s window at
// all: the deadline below is only checked BETWEEN attempts, so the real total is
// the sum of however long each attempt took. Worse, the runtime's fetch has no
// documented timeout, and a request that never settles is far worse than one
// that fails — read() would never return, so the retry loop would never reach
// its deadline, the background retry would never start, loadPromise would never
// settle, and every caller awaiting a load (registerPlayer among them) would
// hang for the server's whole life with loadFailed still false, i.e. no
// "progress not saving" warning. Silent, which is the one thing this module is
// built to avoid.
const READ_TIMEOUT_MS  = 10_000   // a healthy read answers in well under a second
const WRITE_TIMEOUT_MS = 15_000   // writes carry the whole document

/**
 * Rejects if `work` has not settled within `ms`.
 *
 * The losing request keeps running — there is no reliable cancellation in the
 * scene runtime — so this trades a possibly-leaked socket for a caller that
 * always gets an answer. That is the right way round: a leaked socket costs
 * nothing here, a wedged load costs every save for the rest of the session.
 */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

// Log a warning once a stored document passes this size. Not a hard limit —
// just an early signal that the playerbase has outgrown "one document holds
// everyone", well before an external store starts rejecting the write.
const SIZE_WARN_BYTES = 100 * 1024

export type DocStatus = {
  /**
   * 'pending' = not attempted yet; 'unresolved' = attempted and the BIN_* pair
   * didn't resolve (a live fault, not a boot state); 'storage' only when
   * REQUIRE_EXTERNAL_STORE is off. Unset vars and a failed read look identical
   * here by design (see getBinCfg) — the log is the tie-breaker.
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
  // Serialized size of the last document we know the backend holds. Only used
  // for logging: the isEmpty guard is binary, so it catches a 100% loss but not
  // a 90% one, and a delta in the log is the cheapest way to make a truncated
  // read visible before it becomes a truncated write.
  let lastKnownBytes: number | null = null

  // ── Backend resolution ──────────────────────────────────────────────────────
  // Cache ONLY a positive resolution. `EnvVar.get` returns '' both when a var is
  // unset and when the read FAILS — it swallows the error (@dcl/sdk/src/server/
  // env-var.ts) — so '' is never a definitive answer. The 2026-08-17 fix latched
  // on it anyway, pinning the session to a null config: every retry, foreground
  // and background alike, reused it and saves stayed blocked until the next
  // deploy. Not caching the negative is what lets a session heal. Costs two
  // EnvVar fetches per attempt while unresolved; free once resolved.
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
      // Only reachable off-server, but a throw must behave like an unreadable
      // value: report it, cache nothing, re-ask.
      console.error(`[STORE:${key}] EnvVar read threw (will re-ask):`, e)
      return null
    }

    if (id && bk) {
      binCfg = { id, key: bk }
      console.log(`[STORE:${key}] persistence: external store (jsonbin)`)
      return binCfg
    }

    // Half-configured is a deploy mistake, not a transient read — both values
    // live in the same place. Its own line, because waiting won't fix it.
    if (id || bk) {
      const present = id ? `${envPrefix}_BIN_ID` : `${envPrefix}_BIN_KEY`
      const missing = id ? `${envPrefix}_BIN_KEY` : `${envPrefix}_BIN_ID`
      console.error(`[STORE:${key}] WARNING: ${present} resolved but ${missing} did not — the ` +
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
        // Correct on a brand-new bin — but also exactly what a mistyped or
        // re-pointed BIN_ID looks like, and the two are indistinguishable here.
        // Either way the load settles empty and the next save overwrites the
        // whole document, so a re-point replaces careers it can't see. Loud,
        // because the only recovery is the old bin's version history.
        console.error(`[STORE:${key}] WARNING: jsonbin 404 for the configured ${envPrefix}_BIN_ID — ` +
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

  const readOnce  = () => withDeadline(read(), READ_TIMEOUT_MS, `[STORE:${key}] read`)
  const writeOnce = (v: T) => withDeadline(write(v), WRITE_TIMEOUT_MS, `[STORE:${key}] write`)

  async function load(): Promise<T | null> {
    // Proves the load STARTED. Without it the absence of any [STORE:] line is
    // ambiguous — storage never reached, or the server never got this far? That
    // is the first question after a bad deploy (see DEPLOY.md).
    console.log(`[STORE:${key}] load starting — up to ${READ_WINDOW_MS / 1000}s, ` +
      `${READ_TIMEOUT_MS / 1000}s per attempt`)
    const deadline = Date.now() + READ_WINDOW_MS
    let attempt = 0
    while (true) {
      attempt++
      try {
        const value = await readOnce()
        // A settled read — including a confirmed-absent document — tells us what is
        // stored, which is all the save guard needs.
        lastKnownBytes = value === null ? 0 : JSON.stringify(value).length
        console.log(`[STORE:${key}] loaded on attempt ${attempt}` +
          `${value === null ? ' (empty)' : ` (${Math.round(lastKnownBytes / 1024)}KB)`}`)
        loadConfirmed = true
        return value
      } catch (e) {
        console.error(`[STORE:${key}] load attempt ${attempt} failed:`, e)
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
          const value = await readOnce()
          loadConfirmed = true
          loadFailed = false
          lastKnownBytes = value === null ? 0 : JSON.stringify(value).length
          // ensureLoaded memoises, rejections included, so without this every
          // later caller keeps getting the old failure long after the store came
          // back — logging "progression will not persist" and "joining without
          // leaderboard" on every join for the rest of the session. Re-running
          // the callers' .then(apply…) is harmless: those merges are latched.
          loadPromise = Promise.resolve(value)
          console.log(`[STORE:${key}] LATE load succeeded — store back online, restoring stored data`)
          lateLoadCb?.(value)
          return
        } catch (e) {
          console.error(`[STORE:${key}] background retry failed (trying again in ${BG_RETRY_MS / 1000}s):`, e)
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
        console.error(`[STORE:${key}] WARNING: document is ${Math.round(body.length / 1024)}KB ` +
          `(warn at ${Math.round(SIZE_WARN_BYTES / 1024)}KB) — consider pruning inactive records`)
      }
      // A sharp shrink is the signature of a partial read that is about to
      // become a partial write. The isEmpty guard cannot catch it (the document
      // is not empty), so at minimum it must be impossible to miss in the log.
      if (lastKnownBytes !== null && lastKnownBytes > 0 && body.length < lastKnownBytes / 2) {
        console.error(`[STORE:${key}] WARNING: document SHRANK from ` +
          `${Math.round(lastKnownBytes / 1024)}KB to ${Math.round(body.length / 1024)}KB ` +
          `(${Math.round((1 - body.length / lastKnownBytes) * 100)}% smaller). Expected only after ` +
          `deliberate pruning — otherwise the load may have been partial. Check before the next save.`)
      }
      await writeOnce(value)
      lastSaveOk = true
      lastSaveMs = Date.now()
      const was = lastKnownBytes === null ? '' : `, was ${Math.round(lastKnownBytes / 1024)}KB`
      lastKnownBytes = body.length
      console.log(`[STORE:${key}] saved OK (${Math.round(body.length / 1024)}KB${was})`)
      return true
    } catch (e) {
      lastSaveOk = false
      lastSaveMs = Date.now()
      console.error(`[STORE:${key}] ERROR: save failed:`, e)
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
          // read() refuses the fallback when the store is required, so reporting
          // 'storage' here would claim a backend that is never used.
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
