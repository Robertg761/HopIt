import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Web test config. The only thing it adds over the CLI defaults is the `@/`
 * path alias so tests can import route handlers and libs the same way the app
 * does (matching tsconfig's `@/*` -> `src/*`). Test discovery still comes from
 * the `--dir src` flag in the `test:web` script.
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
