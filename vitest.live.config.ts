import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.ts';

// Live tests drive real host binaries (and, opt-in, paid model calls).
// The default config excludes tests/live/**; `npm run test:live` uses this one.
// Spread instead of mergeConfig: mergeConfig concatenates include/exclude arrays.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['tests/live/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.omc'],
    fileParallelism: false,
  },
});
