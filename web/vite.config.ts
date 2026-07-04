import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// D2: the generated declarations in ../ts reach the app via the @quantize alias (mirrors the
// tsconfig path mapping so the runtime/bundler resolver agrees with the type checker).
// D3: dev connectivity is a Vite proxy — the client uses relative /v1 URLs; NO backend CORS.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@quantize': fileURLToPath(new URL('../ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setup.ts',
  },
})
