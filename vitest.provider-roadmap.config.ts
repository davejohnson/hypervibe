import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    include: ['test/provider-conformance/**/*.roadmap.ts'],
    fileParallelism: false,
    testTimeout: 10000,
  },
});
