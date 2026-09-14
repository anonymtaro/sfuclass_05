/**
 * Shared Vitest base  (F7)
 *
 * Usage in a workspace:
 *
 *   import { defineConfig, mergeConfig } from 'vitest/config';
 *   import base from '@classroom/config-presets/vitest/base';
 *   export default mergeConfig(base, defineConfig({ test: { setupFiles: [...] } }));
 *
 * Two decisions worth knowing about:
 *
 *   `pool: 'forks'` — the server tests touch a real Postgres and a real Redis,
 *   and thread-based isolation shares module state in ways that make a
 *   connection pool behave differently under test than in production.
 *
 *   No global mocks of fetch or timers. Everything in core-client takes its
 *   dependencies as arguments precisely so tests can pass a fake instead of
 *   monkey-patching a global.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    // Slow enough for a container to start, short enough that a hung test
    // fails the build rather than the job timeout.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: 'forks',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.turbo/**'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './coverage/junit.xml' },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      exclude: ['**/*.d.ts', '**/dist/**', '**/*.config.*', '**/__tests__/**'],
      // No global threshold. A number that is met by testing getters teaches
      // the wrong lesson; the CI gate is the contract and smoke suites.
      thresholds: undefined,
    },
  },
});