import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function makeEnv(bindings: Record<string, unknown>): Environment {
  return {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'staging',
    platformBindings: bindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RailwayAdapter datastore bootstrap vars', () => {
  it('sets required postgres bootstrap vars after service-backed datastore creation', async () => {
    const request = vi.fn()
      // resolveRailwayEnvironmentId -> listProjectEnvironments
      .mockResolvedValueOnce({
        project: {
          environments: {
            edges: [{ node: { id: 'rail-env-1', name: 'staging' } }],
          },
        },
      })
      // serviceCreate
      .mockResolvedValueOnce({
        serviceCreate: { id: 'rail-svc-db-1', name: 'postgres-db' },
      })
      // variableCollectionUpsert
      .mockResolvedValueOnce({
        variableCollectionUpsert: true,
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.ensureComponent('postgres', makeEnv({ projectId: 'rail-proj-1' }));

    expect(result.receipt.success).toBe(true);
    const upsertVars = request.mock.calls[2]?.[1]?.variables as Record<string, string>;
    expect(upsertVars).toBeDefined();
    expect(typeof upsertVars.POSTGRES_PASSWORD).toBe('string');
    expect(upsertVars.POSTGRES_PASSWORD.length).toBeGreaterThan(0);
    expect(upsertVars.POSTGRES_USER).toBe('postgres');
    expect(upsertVars.POSTGRES_DB).toBe('postgres');
    expect(typeof upsertVars.DATABASE_URL).toBe('string');
  });
});
