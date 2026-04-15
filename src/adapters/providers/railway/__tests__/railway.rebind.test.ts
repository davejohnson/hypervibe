import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

function makeEnv(bindings: Record<string, unknown>): Environment {
  return {
    id: 'env-local',
    projectId: 'proj-local',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeService(name: string): Service {
  return {
    id: `svc-${name}`,
    projectId: 'proj-local',
    name,
    buildConfig: {},
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RailwayAdapter stale binding recovery', () => {
  it('re-resolves stale service binding by name before variableCollectionUpsert', async () => {
    const request = vi.fn()
      // listProjectServices
      .mockResolvedValueOnce({
        project: {
          services: {
            edges: [{ node: { id: 'svc-new', name: 'web' } }],
          },
        },
      })
      // listProjectEnvironmentIds
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'env-new', name: 'staging' } }],
          },
        },
      })
      // variableCollectionUpsert
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const env = makeEnv({
      projectId: 'proj-railway',
      environmentId: 'env-stale',
      services: {
        web: { serviceId: 'svc-stale' },
      },
    });

    const receipt = await adapter.setEnvVars(env, makeService('web'), { DATABASE_URL: 'postgres://x' });

    expect(receipt.success).toBe(true);
    const upsertCall = request.mock.calls.find(([, vars]) => {
      const payload = vars as Record<string, unknown> | undefined;
      return Boolean(payload?.projectId && payload?.serviceId && payload?.environmentId && payload?.variables);
    });
    expect(upsertCall).toBeDefined();
    const upsertVars = upsertCall?.[1] as Record<string, unknown>;
    expect(upsertVars.serviceId).toBe('svc-new');
    expect(upsertVars.environmentId).toBe('env-new');
  });
});
