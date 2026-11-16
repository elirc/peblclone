/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The browser only ever talks to :5173. Vite forwards /api to the API server,
    // so cookies are same-origin in development exactly as they are in production
    // (where a reverse proxy does the same job). No CORS configuration needed.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
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
