import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * apps/web — Vite 6 / React 19 build.
 *
 * Contract with the rest of the repo:
 *  - Source of truth for API + socket payloads is `@classroom/contracts`.
 *  - All transport, RTC and state hooks come from `@classroom/core-client`.
 *    Nothing in apps/web may import `mediasoup-client` or `socket.io-client`
 *    directly; that keeps the mobile app (apps/mobile) on the same code path.
 *  - Colours, spacing and type come from `@classroom/ui-tokens`, which emits
 *    the CSS custom properties consumed by components/Classroom/classroom.css.
 *  - Output is uploaded to S3 and served by CloudFront (deploy-web.yml):
 *    /assets/* is content-hashed and immutable, index.html is never cached.
 */

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Replaces %VITE_*% placeholders in index.html (CSP + preconnect origins). */
function htmlEnv(env: Record<string, string>): PluginOption {
  return {
    name: 'classroom-html-env',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replace(/%(VITE_[A-Z0-9_]+)%/g, (_m, key: string) => env[key] ?? ''),
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const isProd = mode === 'production';

  return {
    plugins: [react(), htmlEnv(env)],

    resolve: {
      alias: {
        '@': r('./src'),
        '@classroom/contracts': r('../../packages/contracts/src'),
        '@classroom/core-client': r('../../packages/core-client/src'),
        '@classroom/ui-tokens': r('../../packages/ui-tokens/src'),
      },
      // Yjs must be a single instance or awareness state silently splits in two.
      dedupe: ['react', 'react-dom', 'yjs'],
    },

    define: {
      __RELEASE_SHA__: JSON.stringify(process.env.RELEASE_SHA ?? 'dev'),
    },

    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        // docker-compose.dev.yml: api on 3000, collab/presence on the same host.
        '/api': { target: 'http://localhost:3000', changeOrigin: true },
        '/socket.io': { target: 'http://localhost:3000', ws: true },
        '/collab': { target: 'ws://localhost:3000', ws: true },
      },
    },

    build: {
      target: 'es2022',
      cssTarget: 'chrome111',
      // Maps are generated for the release upload step but are NOT referenced
      // by the shipped bundle, so they are never fetched by a browser.
      sourcemap: 'hidden',
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name].[hash].js',
          chunkFileNames: 'assets/[name].[hash].js',
          assetFileNames: 'assets/[name].[hash][extname]',
          manualChunks: {
            // mediasoup-client is only needed once a lesson actually starts.
            rtc: ['mediasoup-client'],
            collab: ['yjs', 'y-websocket', 'y-protocols'],
            vendor: ['react', 'react-dom'],
          },
        },
      },
    },

    esbuild: isProd ? { legalComments: 'none', drop: ['debugger'] } : undefined,

    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});