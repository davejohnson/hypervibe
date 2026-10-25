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
