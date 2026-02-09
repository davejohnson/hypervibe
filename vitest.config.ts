import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Run tests sequentially to avoid state bleeding
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/agent/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
    testTimeout: 10000,
  },
});
