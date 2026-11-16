/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

// Ports come from the repo-root .env (the same file the API reads), so the two
// processes cannot disagree about where each other lives.
const env = loadEnv('development', path.resolve(import.meta.dirname, '../..'), '');
const webPort = Number(new URL(env.WEB_ORIGIN ?? 'http://localhost:5173').port || 5173);
const apiPort = Number(env.PORT ?? 4000);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    strictPort: true,
    // The browser only ever talks to :5173. Vite forwards /api to the API server,
    // so cookies are same-origin in development exactly as they are in production
    // (where a reverse proxy does the same job). No CORS configuration needed.
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
  },
});
