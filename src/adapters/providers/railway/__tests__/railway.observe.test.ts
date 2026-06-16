import { describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

function makeEnvironment(platformBindings: Record<string, unknown>): Environment {
  return {
    id: 'env-local',
    projectId: 'proj-local',
    name: 'production',
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const projectDetailsResponse = {
  project: {
    id: 'rail-project-1',
    name: 'billforge',
    environments: {
      edges: [
        { node: { id: 'env-prod', name: 'production' } },
        { node: { id: 'env-staging', name: 'staging' } },
      ],
    },
    services: {
      edges: [
        {
          node: {
            id: 'svc-web',
            name: 'web',
            repoTriggers: { edges: [] },
            serviceInstances: {
              edges: [
                {
                  node: {
                    environmentId: 'env-prod',
                    domains: {
                      serviceDomains: [{ domain: 'web-production.up.railway.app' }],
                      customDomains: [{ domain: 'usebillforge.com' }],
                    },
                    startCommand: 'npm start',
                    healthcheckPath: '/health',
                  },
                },
              ],
            },
          },
        },
        {
          node: {
            id: 'svc-pg',
            name: 'postgres-db',
            repoTriggers: { edges: [] },
            serviceInstances: { edges: [] },
          },
        },
      ],
    },
    plugins: {
      edges: [{ node: { id: 'plugin-redis', name: 'Redis' } }],
    },
  },
};

describe('RailwayAdapter observe', () => {
  it('observes services, hashes env vars, and classifies databases', async () => {
    const request = vi.fn()
      // getProjectDetails
      .mockResolvedValueOnce(projectDetailsResponse)
      // getServiceInstanceDetails for web
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm run start:prod',
          healthcheckPath: '/healthz',
          cronSchedule: null,
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      // fetchServiceVariables for web
      .mockResolvedValueOnce({
        variables: {
          DATABASE_URL: 'postgres://user:hunter2@db.internal:5432/app',
          API_KEY: 'value',
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.provider).toBe('railway');
    expect(result.projectExists).toBe(true);
    expect(result.projectId).toBe('rail-project-1');
    expect(result.environmentId).toBe('env-prod');
    expect(result.partial).toBe(false);
    expect(result.warnings).toEqual([]);

    expect(result.services).toHaveLength(1);
    const web = result.services[0];
    expect(web).toMatchObject({
      name: 'web',
      externalId: 'svc-web',
      workloadKind: 'web',
      url: 'https://web-production.up.railway.app',
      customDomains: ['usebillforge.com'],
      config: {
        startCommand: 'npm run start:prod',
        healthCheckPath: '/healthz',
      },
      status: 'running',
    });
    expect(web.envVarKeys.sort()).toEqual(['API_KEY', 'DATABASE_URL']);

    expect(result.databases).toEqual([
      {
        provider: 'railway',
        engine: 'postgres',
        externalId: 'svc-pg',
        name: 'postgres-db',
        status: 'unknown',
      },
      {
        provider: 'railway',
        engine: 'redis',
        externalId: 'plugin-redis',
        name: 'Redis',
        status: 'unknown',
      },
    ]);
  });

  it('marks workloadKind cron when the service instance has a cron schedule', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm run report',
          cronSchedule: '0 * * * *',
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.workloadKind).toBe('cron');
    expect(result.services[0]?.config.cronSchedule).toBe('0 * * * *');
  });

  it('surfaces the linked repo and branch as the service source', async () => {
    const withTrigger = structuredClone(projectDetailsResponse);
    (withTrigger.project.services.edges[0].node as { repoTriggers: unknown }).repoTriggers = {
      edges: [{ node: { repository: 'dave/seq-planner', branch: 'main' } }],
    };
    const request = vi.fn()
      .mockResolvedValueOnce(withTrigger)
      .mockResolvedValueOnce({
        serviceInstance: { startCommand: 'npm start', latestDeployment: { status: 'SUCCESS' } },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.source).toEqual({ repo: 'dave/seq-planner', branch: 'main' });
  });

  it('uses ServiceInstance.source as primary and cached binding branch when repoTriggers are absent', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: {
          source: { repo: 'dave/seq-planner' },
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({
        projectId: 'rail-project-1',
        environmentId: 'env-prod',
        services: {
          web: {
            serviceId: 'svc-web',
            source: { repo: 'https://github.com/dave/seq-planner.git', branch: 'main' },
          },
        },
      })
    );

    expect(result.services[0]?.source).toEqual({ repo: 'dave/seq-planner', branch: 'main' });
  });

  it('marks a service with no deployments as status empty', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm start',
          healthcheckPath: '/health',
          cronSchedule: null,
          latestDeployment: null,
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.status).toBe('empty');
  });

  it('maps preDeployCommand back to config.releaseCommand', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: {
          startCommand: 'npm start',
          preDeployCommand: ['npx prisma migrate deploy'],
          latestDeployment: { status: 'SUCCESS' },
        },
      })
      .mockResolvedValueOnce({ variables: {} });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.services[0]?.config.releaseCommand).toBe('npx prisma migrate deploy');
  });

  it('returns projectExists false without calling Railway when no project is bound', async () => {
    const request = vi.fn();

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(makeEnvironment({}));

    expect(result).toMatchObject({
      provider: 'railway',
      projectExists: false,
      services: [],
      databases: [],
      partial: false,
      warnings: [],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('formats structured build logs from Railway', async () => {
    const request = vi.fn().mockResolvedValue({
      buildLogs: [
        { timestamp: '2026-06-16T21:00:00Z', severity: 'error', message: 'Failed to pull image from registry' },
        { timestamp: '2026-06-16T21:00:01Z', severity: 'info', message: 'Check image credentials' },
      ],
    });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const logs = await adapter.getBuildLogs('dep-1');

    expect(request.mock.calls[0][0]).toContain('buildLogs(deploymentId: $deploymentId)');
    expect(request.mock.calls[0][0]).toContain('message');
    expect(logs).toContain('2026-06-16T21:00:00Z error Failed to pull image from registry');
    expect(logs).toContain('2026-06-16T21:00:01Z info Check image credentials');
  });

  it('returns projectExists false when the project query fails', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('Project not found'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(makeEnvironment({ projectId: 'rail-project-gone' }));

    expect(result.projectExists).toBe(false);
    expect(result.projectId).toBe('rail-project-gone');
    expect(result.services).toEqual([]);
  });

  it('sets partial true with warnings when a sub-query fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      // getServiceInstanceDetails fails
      .mockRejectedValueOnce(new Error('serviceInstance query exploded'))
      // fetchServiceVariables fails
      .mockRejectedValueOnce(new Error('variables query exploded'));

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    expect(result.projectExists).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('web');
    // Service is still reported, falling back to project-level instance data.
    expect(result.services[0]).toMatchObject({
      name: 'web',
      status: 'unknown',
      config: {
        startCommand: 'npm start',
        healthCheckPath: '/health',
      },
      envVarKeys: [],
      envVarHashes: {},
    });
  });

  it('hashes env var values and never exposes raw values', async () => {
    const secret = 'postgres://user:hunter2@db.internal:5432/app';
    const request = vi.fn()
      .mockResolvedValueOnce(projectDetailsResponse)
      .mockResolvedValueOnce({
        serviceInstance: { latestDeployment: { status: 'SUCCESS' } },
      })
      .mockResolvedValueOnce({
        variables: {
          DATABASE_URL: secret,
          API_KEY: 'value',
        },
      });

    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client = { request };

    const result = await adapter.observe(
      makeEnvironment({ projectId: 'rail-project-1', environmentId: 'env-prod' })
    );

    const web = result.services[0];
    expect(web?.envVarHashes['API_KEY']).toBe(hashEnvValue('value'));
    expect(web?.envVarHashes['DATABASE_URL']).toBe(hashEnvValue(secret));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('hunter2');
  });

  it('throws when not connected', async () => {
    const adapter = new RailwayAdapter();
    await expect(adapter.observe(makeEnvironment({ projectId: 'rail-project-1' }))).rejects.toThrow(
      'Not connected'
    );
  });
});
