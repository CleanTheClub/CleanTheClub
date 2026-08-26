import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fake, resetFake } from '../stubs/dclSdkServer'

// REQUIRE_EXTERNAL_STORE is read inside read() on every attempt, so a getter here
// lets a test flip the policy without reloading the module.
const cfg = vi.hoisted(() => ({ requireExternalStore: true }))
vi.mock('../../src/shared/config', () => ({
  get REQUIRE_EXTERNAL_STORE() { return cfg.requireExternalStore },
}))

import { createPersistedDoc } from '../../src/server/persistence'

// ── Harness ───────────────────────────────────────────────────────────────────

type FetchCall = { url: string; init?: any }
let fetchCalls: FetchCall[] = []
let fetchImpl: (url: string, init?: any) => Promise<any>

const jsonRes = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
})

const puts = () => fetchCalls.filter((c) => c.init?.method === 'PUT')
const versioningHeaders = () => puts().map((c) => c.init.headers['X-Bin-Versioning'])

/** Credentials the fake EnvVar service will hand out. Obviously not real. */
const withCredentials = (): void => {
  fake.envVars.set('PROGRESS_BIN_ID', 'test-bin-id')
  fake.envVars.set('PROGRESS_BIN_KEY', 'test-master-key')
}

const makeDoc = <T,>(isEmpty: (v: T) => boolean = (v) => !v) =>
  createPersistedDoc<T>('testDoc', 'PROGRESS', isEmpty)

/**
 * Marks a promise as expected-to-reject the moment it is created.
 *
 * `expect(p).rejects` only attaches a handler after the awaits in between, and a
 * rejection observed before that point is reported as an unhandled rejection.
 * Attaching a no-op catch up front keeps the assertion working while making the
 * intent explicit.
 */
const expectRejection = <T,>(p: Promise<T>): Promise<T> => {
  p.catch(() => {})
  return p
}

/** Flushes pending microtasks without moving the clock. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// Retry constants from persistence.ts, restated so the intent of each advance is
// legible: READ_RETRY_MS 4s, READ_WINDOW_MS 30s, BG_RETRY_MS 60s.
const PAST_ONE_RETRY = 4_000
const PAST_THE_WINDOW = 35_000
const PAST_ONE_BG_RETRY = 60_000

beforeEach(() => {
  resetFake()
  cfg.requireExternalStore = true
  fetchCalls = []
  fetchImpl = async () => jsonRes(200, { record: null })
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    return fetchImpl(String(url), init)
  }) as any
  // The module logs heavily by design (the boot log is a documented contract in
  // DEPLOY.md). Silenced so the test output stays readable.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.useFakeTimers()
})

afterEach(() => {
  // The background retry loop runs forever by design (persistence.ts keeps
  // trying for the session's whole life). Without clearing it, a later test's
  // clock advance fires an earlier test's loop against the wrong fetch stub.
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createPersistedDoc', () => {
  describe('when nothing has been attempted yet', () => {
    it('should report a pending backend and no save history', () => {
      const status = makeDoc().status()

      expect(status.backend).toBe('pending')
      expect(status.loadConfirmed).toBe(false)
      expect(status.lastSaveOk).toBeNull()
    })
  })

  describe('when the external store credentials resolve', () => {
    it('should load the stored document from the external store', async () => {
      withCredentials()
      fetchImpl = async () => jsonRes(200, { record: { players: { '0xa': 1 } } })

      const doc = makeDoc<any>()

      await expect(doc.ensureLoaded()).resolves.toEqual({ players: { '0xa': 1 } })
      expect(doc.status().backend).toBe('jsonbin')
      expect(doc.status().loadConfirmed).toBe(true)
    })

    it('should resolve the credentials once and reuse them for later writes', async () => {
      withCredentials()
      fetchImpl = async (url) =>
        url.endsWith('/latest') ? jsonRes(200, { record: { a: 1 } }) : jsonRes(200, {})

      const doc = makeDoc<any>()
      await doc.ensureLoaded()
      const afterLoad = fake.envVarCalls.length
      await doc.save({ a: 2 })

      expect(afterLoad).toBe(2)                          // one BIN_ID + one BIN_KEY
      expect(fake.envVarCalls.length).toBe(afterLoad)    // the save re-asked nothing
    })
  })

  // ── The regression this suite exists for ────────────────────────────────────
  // EnvVar.get returns '' for BOTH "unset" and "read failed", so a transient blip
  // at boot used to be cached as a definitive "no credentials" for the entire
  // server session: read() then threw under REQUIRE_EXTERNAL_STORE, and every
  // retry — foreground and the forever background loop alike — reused the cached
  // null instead of re-asking. Saves stayed blocked until the next deploy, which
  // players experienced as "the deploy wiped my career".
  describe('when the credential read transiently fails', () => {
    it('should not cache the failure, and should recover on the next attempt', async () => {
      withCredentials()
      fake.failEnvVarsOnce = 2   // both reads of the first attempt come back ''
      fetchImpl = async () => jsonRes(200, { record: { survived: true } })

      const doc = makeDoc<any>()
      const loading = doc.ensureLoaded()
      await vi.advanceTimersByTimeAsync(PAST_ONE_RETRY)

      await expect(loading).resolves.toEqual({ survived: true })
      expect(doc.status().backend).toBe('jsonbin')
      expect(doc.status().loadConfirmed).toBe(true)
    })

    it('should re-ask the EnvVar service on the retry rather than latching', async () => {
      withCredentials()
      fake.failEnvVarsOnce = 2

      const doc = makeDoc<any>()
      const loading = doc.ensureLoaded()
      await vi.advanceTimersByTimeAsync(PAST_ONE_RETRY)
      await loading

      // Two reads for the failed attempt, two more for the successful retry.
      expect(fake.envVarCalls).toEqual([
        'PROGRESS_BIN_ID', 'PROGRESS_BIN_KEY',
        'PROGRESS_BIN_ID', 'PROGRESS_BIN_KEY',
      ])
    })

    it('should never fall back to DCL Storage while the external store is required', async () => {
      withCredentials()
      fake.failEnvVarsOnce = 2
      fetchImpl = async () => jsonRes(200, { record: { survived: true } })

      const doc = makeDoc<any>()
      const loading = doc.ensureLoaded()
      await vi.advanceTimersByTimeAsync(PAST_ONE_RETRY)
      await loading

      expect(fake.storage.size).toBe(0)
    })
  })

  describe('when the credentials are genuinely unset', () => {
    it('should refuse the DCL Storage fallback and fail the load', async () => {
      const doc = makeDoc<any>()
      const loading = expectRejection(doc.ensureLoaded())
      await vi.advanceTimersByTimeAsync(PAST_THE_WINDOW)

      await expect(loading).rejects.toThrow(/external store REQUIRED/)
      expect(fake.storage.size).toBe(0)
      expect(fetchCalls).toHaveLength(0)
    })

    it('should report an unresolved backend rather than claiming DCL Storage', async () => {
      const doc = makeDoc<any>()
      const loading = expectRejection(doc.ensureLoaded())
      await vi.advanceTimersByTimeAsync(PAST_THE_WINDOW)
      await loading.catch(() => {})

      // 'storage' would assert a backend that is never actually used, since the
      // fallback is refused. 'pending' would imply nothing was tried yet.
      expect(doc.status().backend).toBe('unresolved')
      expect(doc.status().loadFailed).toBe(true)
      expect(doc.status().loadConfirmed).toBe(false)
    })

    it('should keep saves blocked, so nothing can be overwritten', async () => {
      const doc = makeDoc<any>()
      const loading = expectRejection(doc.ensureLoaded())
      await vi.advanceTimersByTimeAsync(PAST_THE_WINDOW)
      await loading.catch(() => {})

      await expect(doc.save({ players: { '0xa': 1 } })).resolves.toBe(false)
      expect(puts()).toHaveLength(0)
    })
  })

  describe('when only one half of the credential pair resolves', () => {
    it('should refuse rather than reading a half-configured store', async () => {
      fake.envVars.set('PROGRESS_BIN_ID', 'test-bin-id')   // no matching key

      const doc = makeDoc<any>()
      const loading = expectRejection(doc.ensureLoaded())
      await vi.advanceTimersByTimeAsync(PAST_THE_WINDOW)

      await expect(loading).rejects.toThrow(/external store REQUIRED/)
      expect(fetchCalls).toHaveLength(0)
    })
  })

  describe('when the external store is not required (local preview)', () => {
    it('should fall back to DCL Storage', async () => {
      cfg.requireExternalStore = false
      fake.storage.set('testDoc', JSON.stringify({ a: 1 }))

      const doc = makeDoc<any>()

      await expect(doc.ensureLoaded()).resolves.toEqual({ a: 1 })
      expect(doc.status().backend).toBe('storage')
    })

    it('should treat a rejected Storage.set as a failed save', async () => {
      cfg.requireExternalStore = false
      fake.storage.set('testDoc', JSON.stringify({ a: 1 }))
      fake.storageSetOk = false

      const doc = makeDoc<any>()
      await doc.ensureLoaded()

      // Storage.set resolves false rather than throwing; ignoring it would lose
      // the write silently.
      await expect(doc.save({ a: 2 })).resolves.toBe(false)
      expect(doc.status().lastSaveOk).toBe(false)
    })
  })

  describe('when the stored document does not exist yet', () => {
    it('should treat a 404 as a settled-empty document and allow saves', async () => {
      withCredentials()
      fetchImpl = async (url) =>
        url.endsWith('/latest') ? jsonRes(404, {}) : jsonRes(200, {})

      const doc = makeDoc<any>((v) => !v || Object.keys(v).length === 0)

      await expect(doc.ensureLoaded()).resolves.toBeNull()
      expect(doc.status().loadConfirmed).toBe(true)
      await expect(doc.save({ a: 1 })).resolves.toBe(true)
    })
  })

  describe('the wipe guards', () => {
    it('should refuse to save before a load has been confirmed', async () => {
      withCredentials()

      const doc = makeDoc<any>()

      await expect(doc.save({ a: 1 })).resolves.toBe(false)
      expect(puts()).toHaveLength(0)
    })

    it('should refuse to save a document the caller reports as empty', async () => {
      withCredentials()
      fetchImpl = async (url) =>
        url.endsWith('/latest') ? jsonRes(200, { record: [{ keep: true }] }) : jsonRes(200, {})

      const doc = makeDoc<any[]>((v) => !v || v.length === 0)
      await doc.ensureLoaded()

      await expect(doc.save([])).resolves.toBe(false)
      expect(puts()).toHaveLength(0)
    })

    it('should return false on a failed write so the caller keeps its dirty flag', async () => {
      withCredentials()
      fetchImpl = async (url) =>
        url.endsWith('/latest') ? jsonRes(200, { record: { a: 0 } }) : jsonRes(500, {})

      const doc = makeDoc<any>()
      await doc.ensureLoaded()

      await expect(doc.save({ a: 1 })).resolves.toBe(false)
      expect(doc.status().lastSaveOk).toBe(false)
    })
  })

  describe('when two saves overlap', () => {
    it('should serialize them so the older snapshot cannot land last', async () => {
      withCredentials()
      const order: string[] = []
      let releaseFirst: (() => void) | null = null
      const firstInFlight = new Promise<void>((r) => { releaseFirst = r })

      fetchImpl = async (url, init) => {
        if (url.endsWith('/latest')) return jsonRes(200, { record: { n: 0 } })
        const n = JSON.parse(init.body).n
        order.push(`start:${n}`)
        if (n === 1) await firstInFlight
        order.push(`end:${n}`)
        return jsonRes(200, {})
      }

      const doc = makeDoc<any>()
      await doc.ensureLoaded()

      const first = doc.save({ n: 1 })
      const second = doc.save({ n: 2 })
      await tick()

      // The second PUT must not have been issued while the first is in flight —
      // last-write-wins on the backend would otherwise let n:1 land after n:2.
      expect(order).toEqual(['start:1'])

      releaseFirst!()
      await Promise.all([first, second])

      expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
    })
  })

  describe('the per-session version snapshot', () => {
    it('should request versioning on the first write only', async () => {
      withCredentials()
      fetchImpl = async (url) =>
        url.endsWith('/latest') ? jsonRes(200, { record: { a: 0 } }) : jsonRes(200, {})

      const doc = makeDoc<any>()
      await doc.ensureLoaded()
      await doc.save({ a: 1 })
      await doc.save({ a: 2 })

      expect(versioningHeaders()).toEqual(['true', 'false'])
    })

    // Field logs 2026-08-18: a bin that refuses versioning 403'd, the flag was
    // left unset, and so EVERY later save retried versioned and 403'd forever.
    it('should fall back to an unversioned write when versioning is refused, once', async () => {
      withCredentials()
      fetchImpl = async (url, init) => {
        if (url.endsWith('/latest')) return jsonRes(200, { record: { a: 0 } })
        return init.headers['X-Bin-Versioning'] === 'true' ? jsonRes(403, {}) : jsonRes(200, {})
      }

      const doc = makeDoc<any>()
      await doc.ensureLoaded()

      await expect(doc.save({ a: 1 })).resolves.toBe(true)
      await expect(doc.save({ a: 2 })).resolves.toBe(true)

      // One refusal, one unversioned retry, then never versioned again.
      expect(versioningHeaders()).toEqual(['true', 'false', 'false'])
    })
  })

  describe('when the store recovers after the retry window has been exhausted', () => {
    it('should heal through the late-load callback', async () => {
      withCredentials()
      let failing = true
      fetchImpl = async (url) => {
        if (!url.endsWith('/latest')) return jsonRes(200, {})
        return failing ? jsonRes(500, {}) : jsonRes(200, { record: { recovered: true } })
      }

      const doc = makeDoc<any>()
      const onLate = vi.fn()
      doc.onLateLoad(onLate)

      const loading = expectRejection(doc.ensureLoaded())
      await vi.advanceTimersByTimeAsync(PAST_THE_WINDOW)
      await expect(loading).rejects.toThrow(/jsonbin read 500/)
      expect(doc.status().loadFailed).toBe(true)

      failing = false
      await vi.advanceTimersByTimeAsync(PAST_ONE_BG_RETRY)

      expect(onLate).toHaveBeenCalledWith({ recovered: true })
      expect(doc.status().loadFailed).toBe(false)
      expect(doc.status().loadConfirmed).toBe(true)
    })

    it('should allow saves again once the late load lands', async () => {
      withCredentials()
      let failing = true
      fetchImpl = async (url) => {
        if (!url.endsWith('/latest')) return jsonRes(200, {})
        return failing ? jsonRes(500, {}) : jsonRes(200, { record: { a: 0 } })
      }

      const doc = makeDoc<any>()
      const loading = expectRejection(doc.ensureLoaded())
      await vi.advanceTimersByTimeAsync(PAST_THE_WINDOW)
      await loading.catch(() => {})

      await expect(doc.save({ a: 1 })).resolves.toBe(false)

      failing = false
      await vi.advanceTimersByTimeAsync(PAST_ONE_BG_RETRY)

      await expect(doc.save({ a: 1 })).resolves.toBe(true)
    })
  })

  describe('when several callers load concurrently', () => {
    it('should share one read rather than issuing one per caller', async () => {
      withCredentials()
      fetchImpl = async () => jsonRes(200, { record: { a: 1 } })

      const doc = makeDoc<any>()
      await Promise.all([doc.ensureLoaded(), doc.ensureLoaded(), doc.ensureLoaded()])

      expect(fetchCalls.filter((c) => c.url.endsWith('/latest'))).toHaveLength(1)
    })
  })
})
