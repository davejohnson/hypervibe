import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    include: ['test/provider-conformance/**/*.roadmap.ts'],
    reporters: process.env.GITHUB_ACTIONS === 'true' ? ['minimal', 'github-actions'] : ['minimal'],
    fileParallelism: false,
    testTimeout: 10000,
  },
});
