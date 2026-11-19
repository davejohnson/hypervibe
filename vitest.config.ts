import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Keep passing tests quiet while retaining failures, logs, and CI annotations.
    reporters: process.env.GITHUB_ACTIONS === 'true' ? ['minimal', 'github-actions', './src/test/slowest-reporter.ts'] : ['minimal'],
    // Isolated processes keep cwd, environment, and module state separate.
    // Bound concurrency because some files also spawn compilers and containers.
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    maxWorkers: Math.min(4, availableParallelism()),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
    testTimeout: 10000,
  },
});
