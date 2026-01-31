import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    passWithNoTests: true,
    maxWorkers: 1,
    minWorkers: 1,
    // Retry flaky e2e tests once before failing
    retry: 1,
    // Ensure consistent test ordering
    sequence: {
      shuffle: false,
    },
  },
});
