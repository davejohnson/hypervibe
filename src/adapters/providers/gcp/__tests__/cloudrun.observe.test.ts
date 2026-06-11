import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

async function connectedAdapter(): Promise<CloudRunAdapter> {
  const adapter = new CloudRunAdapter();
  await adapter.connect({
    projectId: 'gcp-project',
    region: 'us-central1',
    credentials: JSON.stringify({
      type: 'service_account',
      project_id: 'gcp-project',
      private_key_id: 'key-id',
      private_key: 'dummy',
      client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      client_id: 'client-id',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  });
  (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
  (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
  return adapter;
}

function environmentWith(platformBindings: Record<string, unknown>): Environment {
  const now = new Date();
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings,
    createdAt: now,
    updatedAt: now,
  };
}

const webService = {
  name: 'projects/gcp-project/locations/us-central1/services/gcp-project-web',
  uid: 'uid-1',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  uri: 'https://gcp-project-web.run.app',
  labels: { 'infraprint-environment': 'production', 'infraprint-service': 'web' },
  terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
  template: {
    containers: [{
      image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-web:main',
      env: [
        { name: 'DATABASE_URL', value: 'postgres://super-secret' },
        { name: 'SECRET_VALUE', valueSource: { secretKeyRef: { secret: 'secret', version: 'latest' } } },
      ],
      startupProbe: { httpGet: { path: '/healthz' } },
    }],
  },
};

const strayService = {
  name: 'projects/gcp-project/locations/us-central1/services/other-web',
  uid: 'uid-2',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  uri: 'https://other-web.run.app',
  labels: { 'infraprint-environment': 'staging', 'infraprint-service': 'web' },
  terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
  template: { containers: [{ image: 'other' }] },
};

const cronJob = {
  name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  labels: {
    'infraprint-environment': 'production',
    'infraprint-service': 'cron',
    'infraprint-resource': 'scheduled-job',
  },
  terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
  template: {
    template: {
      containers: [{
        image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron:main',
        command: ['/bin/sh'],
        args: ['-lc', 'npm run cron'],
        env: [{ name: 'DATABASE_URL', value: 'postgres://super-secret' }],
      }],
    },
  },
};

const batchJob = {
  name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-batch',
  generation: '1',
  observedGeneration: '1',
  reconciling: false,
  labels: { 'infraprint-environment': 'production', 'infraprint-service': 'batch' },
  terminalCondition: {
    type: 'Ready',
    state: 'CONDITION_FAILED',
    reason: 'ContainerMissing',
    message: 'image not found',
  },
  template: {
    template: {
      containers: [{
        image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/production-batch:main',
        command: ['/bin/sh'],
        args: ['-lc', 'npm run batch'],
        env: [],
      }],
    },
  },
};

describe('CloudRunAdapter.observe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('observes live services, scheduled jobs, and plain jobs with hashed env vars', async () => {
    const adapter = await connectedAdapter();

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && method === 'GET') {
        return Response.json({ services: [webService, strayService] });
      }
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs?') && method === 'GET') {
        return Response.json({ jobs: [cronJob, batchJob] });
      }
      if (url.endsWith('/services/gcp-project-web:getIamPolicy') && method === 'GET') {
        return Response.json({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.endsWith('/jobs/gcp-project-cron-schedule') && method === 'GET') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
          schedule: '*/5 * * * *',
          timeZone: 'Etc/UTC',
          state: 'ENABLED',
        });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.endsWith('/jobs/gcp-project-batch-schedule') && method === 'GET') {
        return new Response('not found', { status: 404 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
      environmentId: 'us-central1',
      services: {
        web: { serviceId: 'gcp-project-web' },
        cron: {
          serviceId: 'gcp-project-cron-schedule',
          jobName: 'gcp-project-cron',
          resourceType: 'scheduledJob',
        },
      },
    }));

    expect(observed.provider).toBe('cloudrun');
    expect(observed.projectExists).toBe(true);
    expect(observed.projectId).toBe('gcp-project');
    expect(observed.environmentId).toBe('us-central1');
    expect(observed.databases).toEqual([]);
    expect(observed.partial).toBe(false);
    expect(observed.warnings).toEqual([]);
    expect(observed.services.map((service) => service.name).sort()).toEqual(['batch', 'cron', 'web']);

    const web = observed.services.find((service) => service.name === 'web');
    expect(web).toMatchObject({
      externalId: 'gcp-project-web',
      workloadKind: 'web',
      url: 'https://gcp-project-web.run.app',
      customDomains: [],
      config: {
        healthCheckPath: '/healthz',
        public: true,
      },
      envVarKeys: ['DATABASE_URL', 'SECRET_VALUE'],
      status: 'running',
    });
    expect(web?.envVarHashes).toEqual({
      DATABASE_URL: hashEnvValue('postgres://super-secret'),
    });

    const cron = observed.services.find((service) => service.name === 'cron');
    expect(cron).toMatchObject({
      externalId: 'gcp-project-cron-schedule',
      workloadKind: 'cron',
      customDomains: [],
      config: {
        startCommand: 'npm run cron',
        cronSchedule: '*/5 * * * *',
      },
      envVarKeys: ['DATABASE_URL'],
      status: 'running',
    });

    const batch = observed.services.find((service) => service.name === 'batch');
    expect(batch).toMatchObject({
      externalId: 'gcp-project-batch',
      workloadKind: 'job',
      config: { startCommand: 'npm run batch' },
      status: 'failed',
    });

    // Raw env var values must never appear in the observed state.
    expect(JSON.stringify(observed)).not.toContain('postgres://super-secret');
  });

  it('returns partial results with warnings when a sub-query fails', async () => {
    const adapter = await connectedAdapter();

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && method === 'GET') {
        return new Response('internal error', { status: 500 });
      }
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/jobs?') && method === 'GET') {
        return Response.json({ jobs: [cronJob] });
      }
      if (url.includes('cloudscheduler.googleapis.com') && url.endsWith('/jobs/gcp-project-cron-schedule') && method === 'GET') {
        return Response.json({
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron-schedule',
          schedule: '*/5 * * * *',
          state: 'ENABLED',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const observed = await adapter.observe(environmentWith({
      provider: 'cloudrun',
      projectId: 'gcp-project',
    }));

    expect(observed.projectExists).toBe(true);
    expect(observed.partial).toBe(true);
    expect(observed.warnings).toHaveLength(1);
    expect(observed.warnings[0]).toContain('Failed to list Cloud Run services');
    expect(observed.services).toHaveLength(1);
    expect(observed.services[0]).toMatchObject({
      name: 'cron',
      workloadKind: 'cron',
      status: 'running',
    });
  });

  it('reports a missing project when no projectId binding exists', async () => {
    const adapter = await connectedAdapter();
    const fetchMock = vi.fn(async () => {
      throw new Error('observe should not call the API without bindings');
    });
    vi.stubGlobal('fetch', fetchMock);

    const observed = await adapter.observe(environmentWith({ provider: 'cloudrun' }));

    expect(observed).toMatchObject({
      provider: 'cloudrun',
      projectExists: false,
      services: [],
      databases: [],
      partial: false,
      warnings: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the adapter is not connected', async () => {
    const adapter = new CloudRunAdapter();
    await expect(adapter.observe(environmentWith({ projectId: 'gcp-project' })))
      .rejects.toThrow('Not connected');
  });
});
