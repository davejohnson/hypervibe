import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Keep passing tests quiet while retaining failures, logs, and CI annotations.
    reporters: process.env.GITHUB_ACTIONS === 'true' ? ['minimal', 'github-actions'] : ['minimal'],
    // Run tests sequentially to avoid state bleeding
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
    testTimeout: 10000,
  },
});
