import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Pinned so Wails' "frontend:dev:serverUrl: auto" stays deterministic.
  server: {port: 5173, strictPort: true},
})
