import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite configuration  (F5)  [EXT]
 *
 * The dev proxy is the part that matters.
 *
 * In development the API and the SPA are two processes on two ports. Calling
 * one from the other makes the request cross-origin, and three separate
 * problems follow from that: the browser demands a CORS preflight the API has
 * to be configured to answer, the refresh cookie is SameSite=strict and will
 * not be sent cross-site, and in a Codespace the API port has to be made public
 * or GitHub's auth proxy answers with a login page instead of JSON.
 *
 * Proxying removes all three rather than solving them one at a time. The
 * browser only ever talks to the Vite origin; Vite forwards to the API
 * server-side, where none of those rules apply. It is also closer to
 * production, where CloudFront and the ALB sit behind one domain.
 *
 * Which is why VITE_API_URL is empty: an empty base means httpClient builds
 * relative paths, and a relative path is same-origin by definition.
 */

/** Everything app.js mounts, plus the health probes and the socket upgrade. */
const API_PATHS = [
  '/auth',
  '/profiles',
  '/billing',
  '/rooms',
  '/classroom',
  '/courses',
  '/progress',
  '/community',
  '/media',
  '/assignments',
  '/messaging',
  '/internal',
  '/healthz',
  '/readyz',
  '/startupz',
];

export default defineConfig(({ mode }) => {
  const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

  const proxy = Object.fromEntries(
    API_PATHS.map((path) => [
      path,
      {
        target: apiTarget,
        changeOrigin: true,
        // The API's hostGuard checks the Host header; changeOrigin rewrites it
        // to the target's, which is what keeps a misrouted request from being
        // rejected here for the wrong reason.
      },
    ]),
  );

  // Socket.IO needs the upgrade forwarded, not just the handshake.
  proxy['/socket.io'] = {
    target: apiTarget,
    changeOrigin: true,
    ws: true,
  };

  return {
    plugins: [react()],

    define: {
      // main.jsx passes this to CoreProvider, which stamps it onto every
      // request and error report. Without the define the app throws on boot
      // with "__RELEASE_SHA__ is not defined".
      __RELEASE_SHA__: JSON.stringify(process.env.RELEASE_SHA ?? 'local'),
    },

    server: {
      // 0.0.0.0, not localhost: the port is unreachable from outside the
      // container otherwise.
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy,
      // Codespaces serves the dev server over an https tunnel, so the HMR
      // socket has to be told to use wss on 443 rather than ws on 5173.
      hmr: process.env.CODESPACE_NAME
        ? {
            protocol: 'wss',
            host: `${process.env.CODESPACE_NAME}-5173.app.github.dev`,
            clientPort: 443,
          }
        : undefined,
      // The tunnel hostname is not localhost, and Vite 6 rejects unknown hosts
      // unless they are listed.
      allowedHosts: process.env.CODESPACE_NAME
        ? [`${process.env.CODESPACE_NAME}-5173.app.github.dev`]
        : undefined,
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
            // The classroom pulls in mediasoup; somebody who only reads
            // community threads should not download it.
            rtc: ['mediasoup-client'],
            react: ['react', 'react-dom', 'react-router-dom'],
          },
        },
      },
    },
  };
});