import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite configuration  (F5)  [EXT]
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 *   __RELEASE_SHA__  main.jsx passes it to CoreProvider, which stamps it onto
 *                    every request and error report. Without the define, the
 *                    app throws on boot with "__RELEASE_SHA__ is not defined".
 *
 *   manualChunks     the classroom pulls in mediasoup-client and the builder
 *                    pulls in dnd-kit. Somebody who only reads community
 *                    threads should download neither, which is why they get
 *                    their own chunks rather than landing in the main bundle.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],

  define: {
    __RELEASE_SHA__: JSON.stringify(process.env.RELEASE_SHA ?? 'local'),
  },

  server: {
    // 0.0.0.0, not localhost: the port is unreachable from outside the
    // container otherwise.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },

  preview: { host: '0.0.0.0', port: 5173 },

  build: {
    // Hashed assets are immutable for a year; index.html is never cached.
    // cdn.tf enforces the caching side of that.
    assetsDir: 'assets',
    sourcemap: mode !== 'production' ? true : 'hidden',
    rollupOptions: {
      output: {
        manualChunks: {
          rtc: ['mediasoup-client'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
}));