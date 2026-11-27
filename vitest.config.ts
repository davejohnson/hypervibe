import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

// The few files that build real images, pack and install the package or run
// OpenTofu take most of the test time. CI runs them in their own job
// (HYPERVIBE_TEST_GROUP=heavy) beside the rest (HYPERVIBE_TEST_GROUP=fast).
// A plain `npm test` runs everything. A file missing from this list, or renamed,
// simply runs with the fast group, so nothing can be skipped by mistake.
const heavyTests = [
  'src/__tests__/backup-runner-image.test.ts',
  'src/adapters/providers/gcp/__tests__/gcp-transfer-bucket-image.test.ts',
  'src/__tests__/macos-package-smoke.test.ts',
  'src/__tests__/packaged-mcp.test.ts',
  'src/adapters/dns/tofu/__tests__/dns-provider-validation.test.ts',
  'src/adapters/engine/opentofu/__tests__/build-token-config.test.ts',
  'src/adapters/engine/opentofu/__tests__/cloud-run-scaling-plan.test.ts',
  'src/adapters/engine/opentofu/__tests__/database-backup-preservation.test.ts',
  'src/adapters/engine/opentofu/__tests__/engine-ci-config.test.ts',
  'src/adapters/engine/opentofu/__tests__/opentofu.engine.live.test.ts',
  'src/interfaces/cli/__tests__/install.test.ts',
];
const group = process.env.HYPERVIBE_TEST_GROUP;
if (group && group !== 'fast' && group !== 'heavy') throw new Error('HYPERVIBE_TEST_GROUP must be "fast" or "heavy".');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    globalSetup: ['scripts/build-bucket-workers.mjs'],
    include: group === 'heavy' ? heavyTests : ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: group === 'fast' ? [...configDefaults.exclude, ...heavyTests] : configDefaults.exclude,
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
