// Controllable stand-in for `@dcl/sdk/server`, wired up by the alias in
// vitest.config.ts.
//
// It reproduces the REAL SDK's semantics, not a convenient version of them —
// that is the whole point, because the bug this suite guards against comes
// directly from one of those semantics being surprising:
//
//   EnvVar.get NEVER THROWS on a failed read. It catches internally, logs, and
//   returns ''. @dcl/sdk/src/server/env-var.ts:
//       if (error) { console.error(`Failed to fetch ...`); return '' }
//   and the typings say "or empty string if not found". So an unset variable and
//   a failed read are the SAME observable value, and code cannot tell them apart.
//   `failEnvVarsOnce` below exists to exercise exactly that.
//
//   Storage.set resolves FALSE on failure rather than throwing, and discards the
//   HTTP status — so 404/413/429/500 are indistinguishable to the caller.

export type FakeState = {
  /** Values EnvVar.get should return. Anything absent resolves to ''. */
  envVars: Map<string, string>
  /** Every key EnvVar.get was asked for, in order. Proves caching behaviour. */
  envVarCalls: string[]
  /**
   * Number of remaining EnvVar reads that should behave like a FAILED read,
   * i.e. return '' regardless of envVars. Decremented per call.
   */
  failEnvVarsOnce: number
  /** Backing store for the DCL Storage fallback path. */
  storage: Map<string, string>
  /** When false, Storage.set resolves false (rate cap / size / server error). */
  storageSetOk: boolean
}

export const fake: FakeState = {
  envVars: new Map(),
  envVarCalls: [],
  failEnvVarsOnce: 0,
  storage: new Map(),
  storageSetOk: true,
}

export function resetFake(): void {
  fake.envVars = new Map()
  fake.envVarCalls = []
  fake.failEnvVarsOnce = 0
  fake.storage = new Map()
  fake.storageSetOk = true
}

export const EnvVar = {
  async get(key: string): Promise<string> {
    fake.envVarCalls.push(key)
    if (fake.failEnvVarsOnce > 0) {
      fake.failEnvVarsOnce--
      return ''            // exactly what the real SDK does on a failed read
    }
    return fake.envVars.get(key) ?? ''
  },
}

export const Storage = {
  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = fake.storage.get(key)
    return (raw === undefined ? null : (raw as unknown as T))
  },
  async set(key: string, value: unknown): Promise<boolean> {
    if (!fake.storageSetOk) return false
    fake.storage.set(key, String(value))
    return true
  },
  async delete(key: string): Promise<boolean> {
    return fake.storage.delete(key)
  },
}
