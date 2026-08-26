import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Unit tests for the server-side storage layer.
//
// ONE alias, deliberately. `@dcl/sdk/server` is the only SDK dependency
// persistence.ts has (`import { Storage, EnvVar }`) — everything else in that
// file is plain TypeScript: the retry loop, the wipe guards, the save chain, the
// status machine. Pointing that single import at a controllable fake is enough to
// test the whole thing, and it keeps the seam visible rather than reaching for a
// mock framework per test.
//
// The pure career logic under src/server/careers/ needs NO alias at all:
// record.ts, merge.ts, boardIndex.ts and migration.ts import nothing but each
// other and shared/progression.ts, which has no imports of its own.
//
// That split is the constraint worth keeping. If a test ever needs a SECOND
// alias — `@dcl/sdk/ecs`, or anything under `~system/` — the module under test
// has picked up a dependency it should not have: `~system/*` modules are
// type-only declarations with no runtime JS at all, and several SDK entry points
// perform network calls at import time. Extract the logic instead of stubbing
// more of the platform.
export default defineConfig({
  resolve: {
    alias: {
      '@dcl/sdk/server': fileURLToPath(new URL('./test/stubs/dclSdkServer.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.spec.ts'],
  },
})
