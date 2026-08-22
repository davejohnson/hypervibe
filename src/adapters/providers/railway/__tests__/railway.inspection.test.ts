import { describe, expect, it, vi } from 'vitest';
import type { RailwayAdapter } from '../railway.adapter.js';
import { inspectRailwayResources } from '../railway-inspection.driver.js';

describe('Railway abandoned-environment inspection', () => {
  it('inventories differently named PostgreSQL services with project scope', async () => {
    const adapter = {
      listProjects: vi.fn(async () => [{ id: 'railway-project', name: 'customer-platform' }]),
      getProjectDetails: vi.fn(async () => ({
        id: 'railway-project',
        name: 'customer-platform',
        environments: { edges: [{ node: { id: 'railway-production', name: 'production' } }] },
        services: {
          edges: [{
            node: {
              id: 'railway-db-service',
              name: 'primary-data',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'railway-production',
                    domains: { serviceDomains: [], customDomains: [] },
                    source: { image: 'postgres:17' },
                  },
                }],
              },
            },
          }],
        },
        plugins: { edges: [] },
        buckets: { edges: [] },
      })),
      getServiceVariables: vi.fn(async () => {
        throw new Error('database inventory must not read variables');
      }),
    } as unknown as RailwayAdapter;

    const inspected = await inspectRailwayResources(adapter, {
      resource: 'database',
      limit: 25,
    });

    expect(inspected).toMatchObject({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: 'railway-db-service',
        name: 'primary-data',
        engine: 'postgres',
        providerScope: { projectId: 'railway-project' },
      }],
      partial: false,
    });
  });

  it('inventories Redis services and object storage without reading variables', async () => {
    const adapter = {
      listProjects: vi.fn(async () => [{ id: 'railway-project', name: 'customer-platform' }]),
      getProjectDetails: vi.fn(async () => ({
        id: 'railway-project',
        name: 'customer-platform',
        environments: {
          edges: [{
            node: {
              id: 'railway-production',
              name: 'production',
              config: { buckets: { 'bucket-1': { region: 'iad' } } },
            },
          }],
        },
        services: {
          edges: [{
            node: {
              id: 'railway-cache-service',
              name: 'customer-sessions',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'railway-production',
                    domains: { serviceDomains: [], customDomains: [] },
                    source: { image: 'redis:8' },
                  },
                }],
              },
            },
          }],
        },
        plugins: { edges: [] },
        buckets: { edges: [{ node: { id: 'bucket-1', name: 'documents' } }] },
      })),
      getServiceVariables: vi.fn(async () => {
        throw new Error('stateful inventory must not read variables');
      }),
    } as unknown as RailwayAdapter;

    await expect(inspectRailwayResources(adapter, { resource: 'cache', limit: 25 }))
      .resolves.toMatchObject({
        resource: 'cache',
        caches: [{
          id: 'railway-cache-service',
          name: 'customer-sessions',
          providerScope: { projectId: 'railway-project' },
        }],
      });
    await expect(inspectRailwayResources(adapter, { resource: 'storage', limit: 25 }))
      .resolves.toMatchObject({
        resource: 'storage',
        storage: [{
          id: 'bucket-1',
          name: 'documents',
          providerScope: { projectId: 'railway-project' },
        }],
      });
    expect((adapter as unknown as { getServiceVariables: ReturnType<typeof vi.fn> }).getServiceVariables)
      .not.toHaveBeenCalled();
  });

  it('keeps legacy plugins visible but marks their undocumented teardown path unsupported', async () => {
    const adapter = {
      listProjects: vi.fn(async () => [{ id: 'railway-project', name: 'legacy-platform' }]),
      getProjectDetails: vi.fn(async () => ({
        id: 'railway-project',
        name: 'legacy-platform',
        environments: { edges: [] },
        services: { edges: [] },
        plugins: { edges: [{ node: { id: 'plugin-postgres', name: 'PostgreSQL' } }] },
        buckets: { edges: [] },
      })),
      getServiceVariables: vi.fn(),
    } as unknown as RailwayAdapter;

    await expect(inspectRailwayResources(adapter, { resource: 'database', limit: 25 }))
      .resolves.toMatchObject({
        observation: 'present',
        databases: [{
          id: 'plugin-postgres',
          resourceKind: 'legacy-plugin',
          cleanupSupported: false,
          providerScope: { projectId: 'railway-project' },
        }],
      });
  });

  it('selects the exact named environment without mutating shared project services', async () => {
    const adapter = {
      findProjectsByName: vi.fn(async () => [{ id: 'railway-project', name: 'app' }]),
      getProjectDetails: vi.fn(async () => ({
        id: 'railway-project',
        name: 'app',
        environments: {
          edges: [{ node: { id: 'railway-production', name: 'production', config: { buckets: {} } } }],
        },
        services: {
          edges: [{
            node: {
              id: 'railway-web',
              name: 'web',
              repoTriggers: { edges: [] },
              serviceInstances: {
                edges: [{
                  node: {
                    environmentId: 'railway-production',
                    domains: { serviceDomains: [], customDomains: [] },
                  },
                }],
              },
            },
          }],
        },
        plugins: { edges: [] },
        buckets: { edges: [] },
      })),
      getServiceVariables: vi.fn(async () => ({})),
    } as unknown as RailwayAdapter;

    const inspected = await inspectRailwayResources(adapter, {
      resource: 'environment',
      limit: 25,
      project: { id: 'project-local', name: 'app' },
      environment: { id: 'environment-local', projectId: 'project-local', name: 'production' },
    });

    expect(inspected).toMatchObject({
      observation: 'present',
      resource: 'environment',
      project: { id: 'railway-project', name: 'app' },
      environment: { id: 'railway-production', name: 'production' },
      services: [{ id: 'railway-web', name: 'web' }],
    });
  });
});
