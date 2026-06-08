/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Block apps are pure SPAs — the host page hands the iframe everything it
// needs via BLOCK_INIT. No BFF, no server-side rendering. Build output is
// a single static bundle to be served from `iframe.src` in the manifest.
export default defineConfig({
  plugins: [react()],
  // Per-app subdomain (generate-from-model.civit.ai) under W12 — bundle
  // serves at root, no path prefix. Pre-W12 (hackathon block-host pattern
  // /generate-from-model/) required base = '/generate-from-model/', which
  // broke under the per-subdomain model: nginx redirected / → the prefix
  // and the redirect Location used the in-pod port:scheme (HTTP:8080),
  // causing a mixed-content block on the HTTPS iframe.
  base: '/',
  server: {
    // The starter dev harness simulates BLOCK_INIT from the same origin —
    // strict-port avoids the harness allowlist drifting when 5173 is busy.
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    // Single-file output keeps the iframe-loaded surface small.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  // Unit test config — vitest reads this same file. The block app has no
  // backing services, so jsdom + the SDK-mocking strategy in
  // src/test/test-utils.ts is enough to cover UI logic.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}', 'src/__tests__/**/*.{test,spec}.{ts,tsx}'],
  },
});
