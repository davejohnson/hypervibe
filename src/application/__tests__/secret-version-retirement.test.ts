import { describe, expect, it } from 'vitest';
import { retireSupersededSecretVersions } from '../secret-version-retirement.js';

// #568: old secret versions are disabled only after every workload is seen on a
// newer one and still answering. Shapes follow Cloud Run v2 (template.containers[].env[]
// .valueSource.secretKeyRef, latestReadyRevision) and Secret Manager version names.
const secretId = 'hv-staging-stripe-secret-key';
const version = (n: number) => `projects/1/secrets/${secretId}/versions/${n}`;
const service = (pin: string, overrides: Record<string, unknown> = {}) => ({ state: 'present' as const, value: {
  uri: 'https://web.example', latestReadyRevision: 'web-2', latestCreatedRevision: 'web-2',
  template: { containers: [{ env: [{ name: 'STRIPE_SECRET_KEY', valueSource: { secretKeyRef: { secret: secretId, version: pin } } }, { name: 'PLAIN', value: 'x' }] }] }, ...overrides } });

function setup(options: { workload?: ReturnType<typeof service> | { state: 'unknown'; reason: string } | { state: 'absent' }; enabled?: number[] | undefined; health?: number } = {}) {
  const disabled: string[] = [];
  const enabled = 'enabled' in options ? options.enabled : [1, 2];
  return { disabled, run: () => retireSupersededSecretVersions({
    secretIds: [secretId],
    workloads: [{ name: 'web', kind: 'services', resource: 'web-abc', healthPath: '/health' }],
    readWorkload: async () => options.workload ?? service('2'),
    listEnabled: async () => enabled?.map(version),
    disable: async (name) => { disabled.push(name); return true; },
    checkHealth: async () => options.health ?? 200,
  }) };
}

describe('retiring superseded secret versions', () => {
  it('disables only versions older than the one every workload runs', async () => {
    const { run, disabled } = setup({ enabled: [1, 2] });
    expect(await run()).toEqual({ verified: true, disabled: 1 });
    expect(disabled).toEqual([version(1)]);
  });

  it('never disables the version in use when a newer one was written meanwhile', async () => {
    const { run, disabled } = setup({ enabled: [1, 2, 3] });
    expect(await run()).toEqual({ verified: true, disabled: 1 });
    expect(disabled).toEqual([version(1)]);
  });

  it.each([
    ['a workload cannot be read', { workload: { state: 'unknown' as const, reason: 'HTTP 503' } }],
    ['a workload is missing', { workload: { state: 'absent' as const } }],
    ['the new revision is not the ready one', { workload: service('2', { latestReadyRevision: 'web-1' }) }],
    ['a workload follows "latest" instead of a fixed version', { workload: service('latest') }],
    ['the app answers a server error', { health: 503 }],
    ['the app cannot be reached', { health: 0 }],
    ['enabled versions cannot be listed', { enabled: undefined }],
  ])('disables nothing when %s', async (_label, options) => {
    const { run, disabled } = setup(options);
    expect(await run()).toMatchObject({ verified: false, reason: expect.any(String) });
    expect(disabled).toEqual([]);
  });

  it('leaves a secret no workload references alone', async () => {
    const { run, disabled } = setup({ workload: service('2', { template: { containers: [{ env: [] }] } }) });
    expect(await run()).toEqual({ verified: true, disabled: 0 });
    expect(disabled).toEqual([]);
  });
});
