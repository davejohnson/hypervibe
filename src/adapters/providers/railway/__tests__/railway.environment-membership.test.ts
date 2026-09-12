import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import { serviceInstanceInventory } from './service-instance-inventory.fixture.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

const projectId = 'project-shared';
const environmentId = 'environment-staging';
const productionId = 'environment-production';

function makeFixture(kind: 'postgres' | 'redis' | 'web', inventoryOverride?: (after: unknown) => unknown) {
  const baseName = kind === 'web' ? 'web' : `${kind}-db`;
  const services = new Map([
    ['service-production', { name: baseName, environments: [productionId] }],
  ]);
  let volume: Record<string, unknown> | undefined;
  const mutations: Array<{ operation: string; variables: Record<string, any> }> = [];
  const request = vi.fn(async (query: string, variables: Record<string, any>) => {
    const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
    if (/\bmutation\b/.test(query)) mutations.push({ operation: operation!, variables });
    if (operation === 'GetEnvironments') {
      return { project: { environments: { edges: [
        { node: { id: productionId, name: 'production' } },
        { node: { id: environmentId, name: 'staging' } },
      ] } } };
    }
    if (operation === 'GetProjectServicesConnection') {
      return { project: { services: { edges: [...services].map(([id, service]) => ({
        node: { id, name: service.name },
      })) } } };
    }
    if (operation === 'GetServiceInstanceInventory') {
      expect(services.has(variables.serviceId)).toBe(true);
      if (inventoryOverride) return inventoryOverride(variables.after);
      return serviceInstanceInventory(projectId, variables.serviceId, services.get(variables.serviceId)!.environments);
    }
    if (operation === 'GetServiceEnvironmentInstance') {
      const service = services.get(variables.serviceId);
      if (!service?.environments.includes(variables.environmentId)) {
        // Actual Railway missing-instance response: not null or NOT_FOUND.
        throw Object.assign(new Error('ServiceInstance not found'), {
          response: { status: 200, errors: [{
            message: 'ServiceInstance not found',
            path: ['serviceInstance'],
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          }] },
        });
      }
      return { serviceInstance: {
        id: `instance-${variables.serviceId}`,
        serviceId: variables.serviceId,
        environmentId: variables.environmentId,
        deletedAt: null,
      } };
    }
    if (operation === 'CreateService') {
      expect(variables.input).toMatchObject({ projectId, environmentId, name: `${baseName}-staging` });
      services.set('service-staging', { name: variables.input.name, environments: [environmentId] });
      return { serviceCreate: { id: 'service-staging', name: variables.input.name } };
    }
    if (query.includes('variableCollectionUpsert(')) return { variableCollectionUpsert: true };
    if (query.includes('volumeInstances(')) {
      return { environment: { id: environmentId, volumeInstances: {
        edges: volume ? [{ node: volume }] : [],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } };
    }
    if (query.includes('volumeCreate(')) {
      volume = {
        id: 'volume-instance-staging',
        serviceId: variables.input.serviceId,
        environmentId,
        mountPath: variables.input.mountPath,
        deletedAt: null,
        isPendingDeletion: false,
        volume: { id: 'volume-staging', projectId },
      };
      return { volumeCreate: { id: 'volume-staging' } };
    }
    if (query.includes('serviceInstanceRedeploy(')) return { serviceInstanceRedeploy: true };
    throw new Error(`Unexpected Railway operation: ${operation}`);
  });
  const adapter = new RailwayAdapter();
  (adapter as unknown as { client: { request: typeof request } }).client = { request };
  const environment: Environment = {
    id: 'local-environment', projectId: 'local-project', name: 'staging',
    platformBindings: { projectId, environmentId }, createdAt: new Date(), updatedAt: new Date(),
  };
  const provision = async () => {
    if (kind !== 'web') return adapter.ensureComponent(kind, environment);
    return adapter.deploy({
      id: 'local-web', projectId: 'local-project', name: 'web', buildConfig: {}, envVarSpec: {},
      createdAt: new Date(), updatedAt: new Date(),
    }, environment, {});
  };
  return { provision, services, mutations, request };
}

describe('Railway creation beside production-only services', () => {
  it.each(['postgres', 'redis', 'web'] as const)('creates staging %s when the base-name service exists only in production', async (kind) => {
    const fixture = makeFixture(kind);
    const result = await fixture.provision();

    expect(result.receipt.success).toBe(true);
    expect(fixture.services.get('service-production')).toEqual({
      name: kind === 'web' ? 'web' : `${kind}-db`, environments: [productionId],
    });
    expect(fixture.services.get('service-staging')?.environments).toEqual([environmentId]);
    expect(fixture.mutations.filter(({ operation }) => operation === 'CreateService')).toHaveLength(1);
    for (const { variables } of fixture.mutations) {
      expect(variables.input?.environmentId ?? variables.environmentId).toBe(environmentId);
      expect(variables.input?.serviceId ?? variables.serviceId).not.toBe('service-production');
    }
    expect(fixture.request.mock.calls.some(([query, variables]) =>
      query.includes('GetServiceEnvironmentInstance') && variables.serviceId === 'service-production'
    )).toBe(false);
  });

  it('finishes pagination before proving a candidate absent from staging', async () => {
    const fixture = makeFixture('postgres', (after) => ({ service: {
      id: 'service-production', projectId,
      serviceInstances: {
        edges: [{ node: after
          ? { id: 'instance-staging', environmentId }
          : { id: 'instance-production', environmentId: productionId } }],
        pageInfo: { hasNextPage: !after, endCursor: after ? null : 'page-two' },
      },
    } }));
    fixture.services.get('service-production')!.environments.push(environmentId);

    const result = await fixture.provision();

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('will not mutate or adopt');
    expect(fixture.mutations).toEqual([]);
    expect(fixture.request.mock.calls.filter(([query]) => query.includes('GetServiceInstanceInventory'))
      .map(([, variables]) => variables.after)).toEqual([null, 'page-two']);
  });

  it.each([
    ['unavailable inventory', () => { throw new Error('inventory unavailable'); }, 'inventory unavailable'],
    ['missing service', () => ({ service: null }), 'service disappeared'],
    ['wrong project', () => ({ service: {
      id: 'service-production', projectId: 'unrelated-project',
      serviceInstances: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } }), 'partial or mismatched'],
    ['incomplete pagination', () => ({ service: {
      id: 'service-production', projectId,
      serviceInstances: { edges: [], pageInfo: { hasNextPage: true, endCursor: null } },
    } }), 'pagination cursor'],
  ] as const)('blocks creation on %s', async (_name, inventory, error) => {
    const fixture = makeFixture('postgres', inventory);

    await expect(fixture.provision()).rejects.toThrow(error);
    expect(fixture.mutations).toEqual([]);
  });

  it('blocks ambiguous services when both candidate names have staging instances', async () => {
    const fixture = makeFixture('postgres');
    fixture.services.get('service-production')!.environments.push(environmentId);
    fixture.services.set('service-existing-staging', {
      name: 'postgres-db-staging', environments: [environmentId],
    });

    await expect(fixture.provision()).rejects.toThrow('Multiple Railway services match');
    expect(fixture.mutations).toEqual([]);
  });

  it('keeps a failed exact-instance read unknown when inventory lists the target', async () => {
    const fixture = makeFixture('postgres', () => ({ service: {
      id: 'service-production', projectId,
      serviceInstances: {
        edges: [{ node: { id: 'instance-staging', environmentId } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    } }));

    await expect(fixture.provision()).rejects.toThrow('ServiceInstance not found');
    expect(fixture.mutations).toEqual([]);
  });
});
