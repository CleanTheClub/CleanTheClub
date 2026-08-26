// Controllable stand-in for `@dcl/sdk/server`, wired up by vitest.config.ts.
//
// It reproduces the REAL SDK's semantics, not convenient ones — the bug this
// suite guards comes straight out of two of them:
//   - EnvVar.get never throws on a failed read; it returns ''. So an unset var
//     and a failed read are the same observable value (`failEnvVarsOnce`).
//   - Storage.set resolves false rather than throwing, and drops the HTTP status.

export type FakeState = {
  /** Values EnvVar.get should return. Anything absent resolves to ''. */
  envVars: Map<string, string>
  /** Every key asked for, in order — proves caching behaviour. */
  envVarCalls: string[]
  /** Next N EnvVar reads return '' regardless of envVars — a failed read. */
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
      return ''            // what the real SDK does on a failed read
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
