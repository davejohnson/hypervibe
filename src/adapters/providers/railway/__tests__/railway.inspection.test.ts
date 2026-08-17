import { describe, expect, it, vi } from 'vitest';
import type { RailwayAdapter } from '../railway.adapter.js';
import { inspectRailwayResources } from '../railway-inspection.driver.js';

describe('Railway abandoned-environment inspection', () => {
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
