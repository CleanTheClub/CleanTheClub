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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const READ_RETRY_MS  = 4_000    // gap between read attempts
const READ_WINDOW_MS = 30_000   // total time to keep trying before giving up

// Log a warning once a stored document passes this size. Not a hard limit —
// just an early signal that the playerbase has outgrown "one document holds
// everyone", well before an external store starts rejecting the write.
const SIZE_WARN_BYTES = 100 * 1024

export type PersistedDoc<T> = {
  /** Loads once; concurrent callers share the same in-flight promise. */
  ensureLoaded(): Promise<T | null>
  /** True once a read has SETTLED, so we know what is actually stored. */
  isLoadConfirmed(): boolean
  /** Persists `value`. Refuses to write before a confirmed read (wipe guard). */
  save(value: T): Promise<void>
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

  // ── Backend resolution (once per document) ──────────────────────────────────
  let binCfg: { id: string; key: string } | null = null
  let binCfgLoaded = false
  async function getBinCfg(): Promise<{ id: string; key: string } | null> {
    if (binCfgLoaded) return binCfg
    binCfgLoaded = true
    try {
      const id  = await EnvVar.get(`${envPrefix}_BIN_ID`)
      const bk  = await EnvVar.get(`${envPrefix}_BIN_KEY`)
      binCfg = id && bk ? { id, key: bk } : null
    } catch (e) {
      console.log(`[STORE:${key}] EnvVar read failed — using DCL Storage:`, e)
      binCfg = null
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

  async function write(value: T): Promise<void> {
    const cfg = await getBinCfg()
    if (cfg) {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${cfg.id}`, {
        method: 'PUT',
        headers: {
          'X-Master-Key':     cfg.key,
          'Content-Type':     'application/json',
          'X-Bin-Versioning': 'false',   // overwrite in place, don't pile up versions
        },
        body: JSON.stringify(value),
      })
      if (!res.ok) throw new Error(`jsonbin write ${res.status}`)
      return
    }
    await Storage.set(key, JSON.stringify(value))
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
        if (Date.now() >= deadline) throw e
      }
      await sleep(READ_RETRY_MS)
    }
  }

  return {
    ensureLoaded(): Promise<T | null> {
      if (!loadPromise) loadPromise = load()
      return loadPromise
    },

    isLoadConfirmed: () => loadConfirmed,

    async save(value: T): Promise<void> {
      if (!loadConfirmed) {
        console.log(`[STORE:${key}] skipping save — load not yet confirmed`)
        return
      }
      if (isEmpty(value)) {
        console.log(`[STORE:${key}] skipping save — document is empty (wipe guard)`)
        return
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
        console.log(`[STORE:${key}] saved OK (${Math.round(body.length / 1024)}KB)`)
      } catch (e) {
        console.log(`[STORE:${key}] ERROR: save failed:`, e)
      }
    },
  }
}
