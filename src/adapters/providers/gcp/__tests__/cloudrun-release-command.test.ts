import { describe, expect, it } from 'vitest';
import {
  cloudRunMigrationJobName,
  cloudRunReleaseJobConfigurationMismatch,
  cloudRunReleaseCommandHash,
} from '../cloudrun-release-command.js';

describe('Cloud Run release command identities', () => {
  it('keeps readable short migration job names', () => {
    expect(cloudRunMigrationJobName('hypervibe-staging-web'))
      .toBe('hypervibe-staging-web-migration');
  });

  it('hashes the full service identity when truncation could collide', () => {
    const sharedPrefix = 'hypervibe-production-service-with-a-very-long-shared-prefix-';
    const first = cloudRunMigrationJobName(`${sharedPrefix}alpha`);
    const second = cloudRunMigrationJobName(`${sharedPrefix}bravo`);

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(second.length).toBeLessThanOrEqual(63);
    expect(first).toMatch(/-[0-9a-f]{10}-migration$/);
    expect(second).toMatch(/-[0-9a-f]{10}-migration$/);
  });

  it('hashes normalized command text without retaining the command', () => {
    const hash = cloudRunReleaseCommandHash('  npm run db:migrate  ');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(cloudRunReleaseCommandHash('npm run db:migrate'));
  });
});

describe('cloudRunReleaseJobConfigurationMismatch', () => {
  const resourceName = 'projects/example/locations/us-central1/jobs/example-web-migration';
  const expected = {
    template: {
      template: {
        containers: [{
          image: `us-central1-docker.pkg.dev/example/images/web@sha256:${'a'.repeat(64)}`,
          command: ['/bin/sh'],
          args: ['-lc', 'npm run db:migrate'],
          env: [{ name: 'DATABASE_URL', value: 'postgres://example' }],
          resources: { limits: { cpu: '1', memory: '512Mi' } },
          volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }],
        }],
        volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: ['example:us-central1:db'] } }],
        serviceAccount: 'runtime@example.iam.gserviceaccount.com',
        vpcAccess: { egress: 'PRIVATE_RANGES_ONLY' },
        maxRetries: 1,
        timeout: '3600s',
      },
    },
  };

  it('accepts the exact executable candidate while ignoring provider output fields and named-list order', () => {
    const observed = structuredClone(expected) as typeof expected & { name: string };
    observed.name = resourceName;
    observed.template.template.containers[0]!.env = [
      { name: 'SECOND', value: 'two' },
      ...observed.template.template.containers[0]!.env,
    ];
    const reorderedExpected = structuredClone(expected);
    reorderedExpected.template.template.containers[0]!.env = [
      ...reorderedExpected.template.template.containers[0]!.env,
      { name: 'SECOND', value: 'two' },
    ];

    expect(cloudRunReleaseJobConfigurationMismatch(
      observed,
      resourceName,
      reorderedExpected
    )).toBeNull();
  });

  it.each([
    ['identity', { name: 'projects/other/locations/us-central1/jobs/example-web-migration' }, 'resource identity'],
    ['image', { image: `us-central1-docker.pkg.dev/example/images/web@sha256:${'b'.repeat(64)}` }, 'container image'],
    ['command', { args: ['-lc', 'npm run stale:migrate'] }, 'container args'],
    ['environment', { env: [{ name: 'DATABASE_URL', value: 'postgres://stale' }] }, 'container env'],
    ['runtime identity', { serviceAccount: 'deploy@example.iam.gserviceaccount.com' }, 'task serviceAccount'],
    ['retry policy', { maxRetries: 2 }, 'task maxRetries'],
  ])('rejects stale %s configuration', (_label, change, mismatch) => {
    const observed = structuredClone(expected) as typeof expected & { name: string };
    observed.name = resourceName;
    if ('name' in change) {
      observed.name = change.name;
    } else if ('image' in change || 'args' in change || 'env' in change) {
      Object.assign(observed.template.template.containers[0]!, change);
    } else {
      Object.assign(observed.template.template, change);
    }

    expect(cloudRunReleaseJobConfigurationMismatch(observed, resourceName, expected)).toBe(mismatch);
  });

  it('rejects a provider-returned service-only cpuIdle setting on a job', () => {
    const observed = structuredClone(expected) as typeof expected & { name: string };
    observed.name = resourceName;
    (observed.template.template.containers[0]! as { resources: Record<string, unknown> }).resources = {
      limits: { cpu: '1', memory: '512Mi' },
      cpuIdle: false,
    };

    expect(cloudRunReleaseJobConfigurationMismatch(observed, resourceName, expected))
      .toBe('container resources.cpuIdle');
  });
});
