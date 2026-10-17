import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the site from /<repo>/. The deploy workflow sets
// BASE_PATH accordingly; locally a relative base works for dev and preview.
const base = process.env.BASE_PATH || './';

export default defineConfig({
  base,
  build: { target: 'es2022', sourcemap: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeManifestIcons: false,
      manifest: {
        name: 'RunForm – running form analysis',
        short_name: 'RunForm',
        description: 'On-device running gait analysis from video',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#1d4ed8',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Precache the app shell AND the pose models + MediaPipe WASM so the app
        // works fully offline after the first load.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,wasm,task}'],
        // The heavy model is ~30 MB and each WASM binary ~13 MB.
        maximumFileSizeToCacheInBytes: 64 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
