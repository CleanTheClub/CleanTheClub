import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// ONE alias, deliberately. `@dcl/sdk/server` is persistence.ts's only SDK
// dependency; everything else in it is plain TypeScript. Needing a SECOND alias
// would mean the module under test picked up a dependency it shouldn't have —
// `~system/*` has no runtime JS, and some SDK entry points fetch on import.
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
