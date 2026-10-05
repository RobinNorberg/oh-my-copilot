import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    setupFiles: ['src/__tests__/setup/clear-copilot-home.ts'],

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
