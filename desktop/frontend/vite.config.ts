/// <reference types="vitest/config" />
import {defineConfig} from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Pinned so Wails' "frontend:dev:serverUrl: auto" stays deterministic.
  server: {port: 5173, strictPort: true},
  test: {
    // The pure .test.ts modules keep the default node environment and their
    // near-zero startup; a render test opts into a DOM per file with a
    // `// @vitest-environment jsdom` docblock. Vitest 4 removed
    // environmentMatchGlobs, and a projects split is more configuration than
    // two test files earn.
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    environmentOptions: {
      jsdom: {
        // App.tsx reads navigator.userAgent at MODULE scope for isWindows and
        // isMac, so this cannot be stubbed from a test body. jsdom's default UA
        // says "jsdom", which makes isWindows false and dead-codes the whole
        // IsPackaged / ContextMenuEnabled branch of the mount effect. Floe
        // Desktop ships Windows-only.
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    },
    restoreMocks: true,
  },
})
