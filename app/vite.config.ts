import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Project Pages uses the repository name as its URL prefix. Override
// VITE_BASE_PATH with '/' when deploying to a user/organization site or custom domain.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_')
  const runtimeEnv = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }).process?.env
  return {
    plugins: [react()],
    base:
      mode === 'production'
        ? runtimeEnv?.VITE_BASE_PATH || env.VITE_BASE_PATH || '/forex-price-simulator/'
        : '/',
    server: {
      port: 3001,
    },
  }
})
