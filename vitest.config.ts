import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { IS_WIN, TIMING_SCALE } from './src/__tests__/helpers/platform.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    // Windows: process spawn and fs calls are several times slower, and one
    // fork per logical core starves the spawn-heavy suites (git fixtures, hook
    // scripts, worker launches) until they miss their own deadlines. Scale the
    // timeouts and cap the pool. POSIX keeps the vitest defaults.
    ...(IS_WIN ? {
      testTimeout: 30000 * TIMING_SCALE,
      hookTimeout: 10000 * TIMING_SCALE,
      maxWorkers: Math.min(16, Math.max(1, availableParallelism() - 1)),
    } : {}),
    setupFiles: ['src/__tests__/setup/clear-copilot-home.ts', 'src/__tests__/setup/stub-skill-list-probe.ts'],
    globalSetup: ['src/__tests__/setup/global-state-guard.ts'],
    // Test-only seams (for example the conditional-clear replacement hooks in
    // src/lib/mode-state-io.ts) run only when NODE_ENV is 'test'. Pin it so an
    // inherited NODE_ENV=production cannot silently disable them.
    env: {
      NODE_ENV: 'test',
    },

    include: [
      'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'tests/**/*.bench.ts',
      'tests/**/*.{test,spec}.ts',
    ],
    // tests/live/** drives real host binaries; run it with `npm run test:live`.
    exclude: ['node_modules', 'dist', '.omc', 'tests/live/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/**/*.{test,spec}.{js,ts}',
        '**/*.d.ts',
        '**/*.config.{js,ts}',
        '**/index.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
