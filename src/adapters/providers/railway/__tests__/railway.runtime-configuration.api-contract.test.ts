import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { projectId, stagingId, railwayHttpFixture } from './railway-http.fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Reconstructed transport against the pinned official Railway SDL's distinct
// deploymentSnapshot and variables endpoints. Values and timing are synthetic.
// Snapshot configuration is not an observation inside the application process.
async function setup() {
  const fixture = await railwayHttpFixture();
  const service = fixture.addService('staging-worker', 'worker', stagingId);
  const instance = service.instances.get(stagingId)!;
  instance.latestDeployment = { id: 'successful-redeploy', status: 'SUCCESS' };
  instance.activeDeployments = [{ id: 'successful-redeploy' }];
  fixture.environment.platformBindings.services = { worker: { serviceId: service.id, workloadKind: 'worker' } };
  fixture.variables.set(`${service.id}/${stagingId}`, { DATABASE_URL: 'intended-url', POSTGRES_DB_URL: 'intended-url' });
  fixture.deployments.set('successful-redeploy', { id: 'successful-redeploy', projectId, environmentId: stagingId, serviceId: service.id, snapshotId: 'snapshot-old' });
  fixture.deploymentSnapshots.set('successful-redeploy', { id: 'snapshot-old', variables: { DATABASE_URL: 'old-url', POSTGRES_DB_URL: 'old-url' } });
  return fixture;
}

describe('Railway deployed configuration boundary', () => {
  it('includes every retained credential key discovered by rotation in runtime observation', async () => {
    const fixture = await setup();
    fixture.deploymentSnapshots.get('successful-redeploy')!.variables = { DATABASE_URL: '${{Postgres.DATABASE_URL}}', CUSTOM_DATABASE_URL: '${{Postgres.DATABASE_URL}}' };
    const read = vi.fn(async () => ({ state: 'verified', envVarHashes: { DATABASE_URL: hashEnvValue('old-url'), CUSTOM_DATABASE_URL: hashEnvValue('old-url') },
      instanceIds: ['instance-1'], authentication: 'unchecked' }));
    (fixture.adapter as any).railwayRuntimeEvidence = { read };
    const result = await fixture.adapter.observe(fixture.environment, { runtimeConfigurationKeys: { worker: ['CUSTOM_DATABASE_URL', 'DATABASE_URL'] } } as any);
    expect(read).toHaveBeenCalledWith(expect.anything(), { keys: ['CUSTOM_DATABASE_URL', 'DATABASE_URL'] });
    expect(result.services.find(item => item.name === 'worker')!.deployment?.envVarHashes?.CUSTOM_DATABASE_URL).toBe(hashEnvValue('old-url'));
  });

  it('preserves selected credential evidence for a workload with no database URL', async () => {
    const fixture = await setup();
    fixture.variables.set(`staging-worker/${stagingId}`, { API_TOKEN: 'intended-token' });
    fixture.deploymentSnapshots.get('successful-redeploy')!.variables = { API_TOKEN: 'deployed-token' };
    const result = await fixture.adapter.observe(fixture.environment, { runtimeConfigurationKeys: { worker: ['API_TOKEN'] } });
    expect(result.services.find(item => item.name === 'worker')!.deployment).toMatchObject({ configurationState: 'resolved',
      envVarHashes: { API_TOKEN: hashEnvValue('deployed-token') } });
    expect(fixture.mutations).toEqual([]);
  });

  // Reconstructed counterexample from preserved Invoice Perfect notes (the
  // historical observation was not revalidated here): an exact snapshot retains
  // raw ${{Postgres.DATABASE_URL}} references. Resolving those against today's
  // variables would conceal the stale password in deployed process environments.
  // The native runtime reader is independently exercised by its SSH/program
  // boundary tests; this transport test verifies the observation integration.
  it('uses exact-instance runtime evidence for raw snapshot references while keeping current values separate', async () => {
    const fixture = await setup();
    fixture.deploymentSnapshots.get('successful-redeploy')!.variables = {
      DATABASE_URL: '${{Postgres.DATABASE_URL}}', POSTGRES_DB_URL: '${{Postgres.DATABASE_URL}}',
    };
    const read = vi.fn(async () => ({ state: 'verified', envVarHashes: { DATABASE_URL: hashEnvValue('old-url'), POSTGRES_DB_URL: hashEnvValue('old-url') },
      instanceIds: ['instance-1', 'instance-2'], authentication: 'unchecked' }));
    (fixture.adapter as any).railwayRuntimeEvidence = { read };
    const result = await fixture.adapter.observe(fixture.environment, { databaseEnvAliases: { worker: { POSTGRES_DB_URL: 'DATABASE_URL' } } });
    const worker = result.services.find(item => item.name === 'worker')!;
    expect(worker.envVarHashes.POSTGRES_DB_URL).toBe(hashEnvValue('intended-url'));
    expect(worker.deployment).toMatchObject({ configurationState: 'resolved', configurationEvidence: 'runtime-instances',
      configurationInstanceIds: ['instance-1', 'instance-2'], envVarHashes: { POSTGRES_DB_URL: hashEnvValue('old-url') } });
    expect(read).toHaveBeenCalledWith({ projectId, environmentId: stagingId, serviceId: 'staging-worker', deploymentId: 'successful-redeploy' },
      { keys: ['DATABASE_URL', 'POSTGRES_DB_URL'] });
    expect(fixture.mutations).toEqual([]); expect(fixture.contractErrors).toEqual([]);
  });

  it('does not invoke the runtime reader when the selected snapshot values are resolved', async () => {
    const fixture = await setup();
    const read = vi.fn(async () => ({ state: 'unknown', authentication: 'unchecked' }));
    (fixture.adapter as any).railwayRuntimeEvidence = { read };
    const result = await fixture.adapter.observe(fixture.environment);
    expect(result.services.find(item => item.name === 'worker')!.deployment).toMatchObject({ configurationState: 'resolved', configurationEvidence: 'deployment-snapshot' });
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves selected resolved snapshot evidence when an unrelated variable remains a raw reference', async () => {
    const fixture = await setup();
    fixture.deploymentSnapshots.get('successful-redeploy')!.variables = { DATABASE_URL: 'old-url', POSTGRES_DB_URL: 'old-url', OTHER_SETTING: '${{shared.OTHER_SETTING}}' };
    const read = vi.fn(); (fixture.adapter as any).railwayRuntimeEvidence = { read };
    const result = await fixture.adapter.observe(fixture.environment);
    expect(result.services.find(item => item.name === 'worker')!.deployment).toMatchObject({ configurationState: 'resolved', configurationEvidence: 'deployment-snapshot' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'partial-keys', 'missing-instances', 'duplicate-instances'])('keeps %s runtime evidence unknown rather than resolving raw snapshots using current configuration', async kind => {
    const fixture = await setup();
    fixture.deploymentSnapshots.get('successful-redeploy')!.variables = { DATABASE_URL: '${{Postgres.DATABASE_URL}}' };
    const evidence: Record<string, unknown> = { state: 'verified', envVarHashes: { DATABASE_URL: hashEnvValue('old-url'), POSTGRES_DB_URL: hashEnvValue('old-url') }, instanceIds: ['instance-1'], authentication: 'unchecked' };
    if (kind === 'unknown') evidence.state = 'unknown';
    if (kind === 'partial-keys') evidence.envVarHashes = {};
    if (kind === 'missing-instances') delete evidence.instanceIds;
    if (kind === 'duplicate-instances') evidence.instanceIds = ['instance-1', 'instance-1'];
    (fixture.adapter as any).railwayRuntimeEvidence = { read: vi.fn(async () => evidence) };
    const result = await fixture.adapter.observe(fixture.environment);
    const worker = result.services.find(item => item.name === 'worker')!;
    expect(worker.deployment?.configurationState).toBe('unknown');
    expect(worker.deployment?.envVarHashes).toBeUndefined();
  });

  it('keeps current resolved configuration distinct from an exact successful deployment snapshot', async () => {
    const fixture = await setup();
    const result = await fixture.adapter.observe(fixture.environment);
    const worker = result.services.find(item => item.name === 'worker')!;
    expect(worker.envVarHashes.POSTGRES_DB_URL).toBe(hashEnvValue('intended-url'));
    expect(worker.envVarState).toBe('resolved');
    expect(worker.deployment).toMatchObject({ id: 'successful-redeploy', configurationState: 'resolved', envVarHashes: { POSTGRES_DB_URL: hashEnvValue('old-url') } });
    expect(JSON.stringify(result)).not.toContain('old-url');
    expect(fixture.contractErrors).toEqual([]);
    expect(fixture.mutations).toEqual([]);
  });

  it.each(['wrong-environment', 'wrong-service', 'wrong-snapshot', 'unresolved', 'malformed', 'missing'])('preserves unknown deployed evidence for %s', async kind => {
    const fixture = await setup();
    const deployment = fixture.deployments.get('successful-redeploy')!;
    if (kind === 'wrong-environment') deployment.environmentId = 'production';
    if (kind === 'wrong-service') deployment.serviceId = 'production-worker';
    if (kind === 'wrong-snapshot') deployment.snapshotId = 'different-snapshot';
    if (kind === 'unresolved') fixture.deploymentSnapshots.get('successful-redeploy')!.variables = { DATABASE_URL: '${{Postgres.DATABASE_URL}}' };
    if (kind === 'malformed') fixture.deploymentSnapshots.get('successful-redeploy')!.variables = { DATABASE_URL: { secret: 'hidden' } };
    if (kind === 'missing') fixture.deploymentSnapshots.delete('successful-redeploy');
    const result = await fixture.adapter.observe(fixture.environment);
    const worker = result.services.find(item => item.name === 'worker')!;
    expect(worker.deployment?.configurationState).toBe('unknown');
    expect(worker.deployment?.envVarHashes).toBeUndefined();
    expect(fixture.contractErrors).toEqual([]);
    expect(fixture.mutations).toEqual([]);
  });
});
