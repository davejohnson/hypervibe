import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.restoreAllMocks());
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Service } from '../../../domain/entities/service.entity.js';
import { isProviderEnvironmentVariablesAdapter } from '../../../domain/ports/provider-env-vars.port.js';
import { CloudRunAdapter } from '../gcp/cloudrun.adapter.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';

const now = new Date('2026-09-06T00:00:00.000Z');
const service: Service = {
  id: 'service-local',
  projectId: 'project-local',
  name: 'worker',
  buildConfig: { workloadKind: 'worker' },
  envVarSpec: {},
  createdAt: now,
  updatedAt: now,
};

function environment(provider: string): Environment {
  return {
    id: 'environment-local',
    projectId: 'project-local',
    name: 'staging',
    platformBindings: {
      provider,
      projectId: `${provider}-project`,
      environmentId: `${provider}-environment`,
      services: {
        worker: { serviceId: `${provider}-worker` },
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('provider environment-variable read port', () => {
  it('reads Cloud Run variables through the shared request using the exact native scope and lifetime identity', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({ projectId: 'cloudrun-project', region: 'us-west1', credentials: JSON.stringify({ type: 'service_account', project_id: 'cloudrun-project', private_key: 'synthetic-key', client_email: 'reader@cloudrun-project.iam.gserviceaccount.com' }) });
    Object.assign(adapter, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60000) });
    const target: Environment = { ...environment('cloudrun'), platformBindings: { provider: 'cloudrun', projectId: 'cloudrun-project', environmentId: 'us-west1', services: { worker: { serviceId: 'bound-worker', resourceUid: 'accepted-lifetime-uid' } } } };
    // Official v2 Service GET contract; reconstructed transport observation.
    // Logical service names alone never establish native resource identity.
    const native = { name: 'projects/cloudrun-project/locations/us-west1/services/bound-worker', uid: 'accepted-lifetime-uid', template: { containers: [{ image: 'registry/worker:retained', env: [{ name: 'KEY', value: 'cloudrun-value' }] }] } };
    const read = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(native));

    expect(isProviderEnvironmentVariablesAdapter(adapter)).toBe(true);
    await expect(adapter.readProviderEnvironmentVariables({ environment: target, service }))
      .resolves.toEqual({ success: true, variables: { KEY: 'cloudrun-value' } });
    expect(read).toHaveBeenCalledExactlyOnceWith(
      'https://run.googleapis.com/v2/projects/cloudrun-project/locations/us-west1/services/bound-worker',
      expect.objectContaining({ headers: { Authorization: 'Bearer synthetic-token' } }),
    );
    for (const request of [
      { environment: target, service: { ...service, name: 'unbound-worker' } },
      { environment: { ...target, platformBindings: { ...target.platformBindings, environmentId: 'another-region' } }, service },
    ]) await expect(adapter.readProviderEnvironmentVariables(request)).resolves.toMatchObject({ success: false });
    expect(read).toHaveBeenCalledTimes(1);
    native.uid = 'different-lifetime-uid';
    await expect(adapter.readProviderEnvironmentVariables({ environment: target, service })).resolves.toMatchObject({ success: false });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('normalizes Railway durable binding reads without broadening service identity', async () => {
    const adapter = new RailwayAdapter();
    const target = environment('railway');
    const read = vi.spyOn(adapter, 'getServiceVariables').mockResolvedValue({ KEY: 'railway-value' });

    expect(isProviderEnvironmentVariablesAdapter(adapter)).toBe(true);
    await expect(adapter.readProviderEnvironmentVariables({ environment: target, service }))
      .resolves.toEqual({ success: true, variables: { KEY: 'railway-value' } });
    expect(read).toHaveBeenCalledWith(
      'railway-project',
      'railway-worker',
      'railway-environment'
    );

    await expect(adapter.readProviderEnvironmentVariables({
      environment: target,
      service: { ...service, name: 'typo' },
    })).resolves.toEqual({
      success: false,
      error: 'Service typo is missing Railway bindings in staging',
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
