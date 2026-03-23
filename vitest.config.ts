import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'bun:test': fileURLToPath(new URL('./test/vitest-bun-shim.ts', import.meta.url)),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    setupFiles: ['./test/vitest.setup.ts'],
  },
})
