import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';

describe('CloudRunAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

  it('inventories Artifact Registry repositories in the explicitly selected region', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/us-west1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ repositories: [{
          name: 'projects/gcp-project/locations/us-west1/repositories/infraprint',
          format: 'DOCKER',
          sizeBytes: '12884901888',
        }] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectArtifactResources({ resource: 'artifact', region: 'us-west1', limit: 25 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'artifact',
      region: 'us-west1',
      artifacts: [{
        id: 'projects/gcp-project/locations/us-west1/repositories/infraprint',
        name: 'infraprint',
        format: 'DOCKER',
        sizeBytes: '12884901888',
        providerScope: { projectId: 'gcp-project', location: 'us-west1' },
      }],
      partial: false,
    });
  });

  it('discovers Artifact Registry repositories across all project locations by default', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations?pageSize=100' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ locations: [
          { name: 'projects/gcp-project/locations/us-central1' },
          { name: 'projects/gcp-project/locations/europe-west1' },
        ] });
      }
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/us-central1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ repositories: [] });
      }
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/europe-west1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ repositories: [{
          name: 'projects/gcp-project/locations/europe-west1/repositories/legacy-images',
          format: 'DOCKER',
        }] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectArtifactResources({ resource: 'artifact', limit: 25 });

    expect(result).toMatchObject({
      observation: 'present',
      region: 'all',
      artifacts: [{
        id: 'projects/gcp-project/locations/europe-west1/repositories/legacy-images',
        providerScope: { projectId: 'gcp-project', location: 'europe-west1' },
      }],
      partial: false,
    });
  });

  it('does not report Artifact Registry absence when one project location cannot be observed', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations?pageSize=100' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ locations: [
          { name: 'projects/gcp-project/locations/us-central1' },
          { name: 'projects/gcp-project/locations/europe-west1' },
        ] });
      }
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/us-central1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ repositories: [] });
      }
      if (url === 'https://artifactregistry.googleapis.com/v1/projects/gcp-project/locations/europe-west1/repositories?pageSize=25' && (init?.method ?? 'GET') === 'GET') {
        return new Response('permission denied', { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectArtifactResources({ resource: 'artifact', limit: 25 });

    expect(result).toMatchObject({
      observation: 'unknown',
      artifacts: [],
      partial: true,
      warnings: [expect.stringContaining('europe-west1: 403 permission denied')],
    });
  });

  it('fails project-wide Artifact Registry inventory when locations cannot be enumerated', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));

    await expect(adapter.inspectArtifactResources({ resource: 'artifact', limit: 25 }))
      .rejects.toThrow('Artifact Registry location inventory failed: 403 forbidden');
  });

  it('derives Artifact Registry location from an exact durable id', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const id = 'projects/gcp-project/locations/europe-west1/repositories/legacy-images';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://artifactregistry.googleapis.com/v1/${id}` && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ name: id, format: 'DOCKER' });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.inspectArtifactResources({ resource: 'artifact', id, limit: 1 });

    expect(result).toMatchObject({
      observation: 'present',
      artifacts: [{ id, providerScope: { projectId: 'gcp-project', location: 'europe-west1' } }],
      partial: false,
    });
  });

  it.each([
    {
      evidence: 'repository identity',
      repository: {
        name: 'projects/gcp-project/locations/us-central1/repositories/other-repository',
        format: 'DOCKER',
      },
      expectedError: /different repository identity/i,
    },
    {
      evidence: 'repository format',
      repository: {
        name: 'projects/gcp-project/locations/us-central1/repositories/infraprint',
      },
      expectedError: /DOCKER format/i,
    },
  ])('rejects an existing Artifact Registry repository with unknown $evidence', async ({ repository, expectedError }) => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const subject = adapter as unknown as {
      verifyArtifactRepository(repository: string, token: string): Promise<void>;
    };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(repository)));

    await expect(subject.verifyArtifactRepository('infraprint', 'token')).rejects.toThrow(expectedError);
  });

  it('preserves provider errors in deployment-status observations', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json(
      { error: { message: 'permission denied' } },
      { status: 403 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.getDeployStatus({
      id: 'environment-local',
      projectId: 'project-local',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        environmentId: 'northamerica-northeast1',
        services: { web: { serviceId: 'production-web' } },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }, 'production-web');

    expect(result).toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/403.*permission denied/i),
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/locations/northamerica-northeast1/'
    );
  });

  it('forensically lists a migrated environment without a retained binding or mutations', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account',
        project_id: 'gcp-project',
        private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      expect(init?.method ?? 'GET').toBe('GET');
      if (pathname.endsWith('/services')) {
        return Response.json({
          services: [{
            name: 'projects/gcp-project/locations/us-central1/services/hls-property-care-web',
            uri: 'https://hls-property-care-web.run.app',
            labels: {
              'infraprint-environment': 'production',
              'infraprint-service': 'web',
            },
          }],
        });
      }
      if (pathname.endsWith('/jobs')) return Response.json({ jobs: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await adapter.inspectEnvironmentResources({
      resource: 'environment',
      limit: 25,
      project: { id: 'local-project', name: 'hls-property-care' },
      environment: { id: 'local-environment', projectId: 'local-project', name: 'production' },
    });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'environment',
      project: { id: 'gcp-project' },
      environment: { name: 'production', region: 'us-central1' },
      services: [{
        id: 'hls-property-care-web',
        name: 'web',
        managedByHypervibe: true,
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recognizes legacy unlabeled resources from deterministic service identities', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'hls-property-care',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'hls-property-care', private_key: 'dummy',
        client_email: 'deploy@hls-property-care.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/services')) {
        return Response.json({ services: [] });
      }
      if (pathname.endsWith('/jobs')) return Response.json({ jobs: [{
        name: 'projects/hls-property-care/locations/us-central1/jobs/hls-property-care-production-web-migration',
      }] });
      if (new URL(String(input)).hostname === 'cloudscheduler.googleapis.com') {
        return Response.json({}, { status: 404 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }));

    const result = await adapter.inspectEnvironmentResources({
      resource: 'environment',
      limit: 25,
      project: { id: 'local-project', name: 'hls-property-care' },
      environment: { id: 'local-environment', projectId: 'local-project', name: 'production' },
      serviceNames: ['web'],
    });

    expect(result).toMatchObject({
      observation: 'present',
      services: [{
        id: 'hls-property-care-production-web-migration',
        name: 'web-migration',
        resourceType: 'taskJob',
        managedByHypervibe: true,
      }],
    });
  });

const EXPECTED_DEPLOY_IMAGE = `us-central1-docker.pkg.dev/gcp-project/infraprint/production-web@sha256:${'b'.repeat(64)}`;
const EXPECTED_CRON_IMAGE = `us-central1-docker.pkg.dev/gcp-project/infraprint/production-cron@sha256:${'c'.repeat(64)}`;

it('derives environment-qualified names for every unbound Cloud Run workload while preserving bindings', async () => {
  const adapter = new CloudRunAdapter();
  await adapter.connect({
    projectId: 'gcp-project',
    credentials: JSON.stringify({
      type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
      client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
    }),
  });
  const now = new Date();
  const staging: Environment = {
    id: 'staging',
    projectId: 'project-1',
    name: 'staging',
    platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
    createdAt: now,
    updatedAt: now,
  };
  const production: Environment = {
    ...staging,
    id: 'production',
    name: 'production',
  };
  const subject = adapter as unknown as {
    workloadResourceName(environment: Environment, logicalName: string, boundId?: string): string;
    schedulerResourceName(jobName: string, boundId?: string): string;
    migrationJobName(serviceName: string): string;
  };

  const stagingNames = {
    web: subject.workloadResourceName(staging, 'web'),
    worker: subject.workloadResourceName(staging, 'worker'),
    scheduledJob: subject.workloadResourceName(staging, 'cron'),
  };
  const productionNames = {
    web: subject.workloadResourceName(production, 'web'),
    worker: subject.workloadResourceName(production, 'worker'),
    scheduledJob: subject.workloadResourceName(production, 'cron'),
  };

  expect(stagingNames).toEqual({
    web: 'web-7e22b6c2dc',
    worker: 'worker-7e22b6c2dc',
    scheduledJob: 'cron-7e22b6c2dc',
  });
  expect(productionNames).toEqual({
    web: 'web-383368e489',
    worker: 'worker-383368e489',
    scheduledJob: 'cron-383368e489',
  });
  expect(new Set([...Object.values(stagingNames), ...Object.values(productionNames)]).size).toBe(6);
  expect(subject.migrationJobName(stagingNames.web)).toBe('web-7e22b6c2dc-migration');
  expect(subject.migrationJobName(productionNames.web)).toBe('web-383368e489-migration');
  expect(subject.schedulerResourceName(stagingNames.scheduledJob)).toBe('cron-7e22b6c2dc-schedule');
  expect(subject.schedulerResourceName(productionNames.scheduledJob)).toBe('cron-383368e489-schedule');
  expect(subject.workloadResourceName(staging, 'web', 'legacy-exact-service')).toBe('legacy-exact-service');
  expect(subject.workloadResourceName({ ...staging,
    platformBindings: { projectId: 'legacy-logical-staging' } }, 'web')).toBe(stagingNames.web);
  expect(subject.schedulerResourceName(stagingNames.scheduledJob, 'legacy-exact-scheduler')).toBe('legacy-exact-scheduler');
});

it('maps environment-qualified services and scheduled jobs to logical names during observation', async () => {
  const adapter = new CloudRunAdapter();
  await adapter.connect({
    projectId: 'gcp-project',
    region: 'us-central1',
    credentials: JSON.stringify({
      type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
      client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
    }),
  });
  (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
  (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);
  const ready = { type: 'Ready', state: 'CONDITION_SUCCEEDED' };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith('-run.googleapis.com') && url.pathname.endsWith('/domainmappings')) {
      return Response.json({ items: [] });
    }
    if (url.hostname === 'run.googleapis.com' && url.pathname.endsWith('/services')) {
      return Response.json({ services: [
        {
          name: 'projects/gcp-project/locations/us-central1/services/gcp-project-staging-web',
          latestReadyRevision: 'projects/gcp-project/locations/us-central1/services/gcp-project-staging-web/revisions/new',
          trafficStatuses: [{ revision: 'new', percent: 90 }, { revision: 'old', percent: 10 }, { revision: 'tagged', tag: 'debug', percent: 0 }],
          labels: { 'infraprint-environment': 'staging' },
          ingress: 'INGRESS_TRAFFIC_ALL',
          template: { containers: [{ image: EXPECTED_DEPLOY_IMAGE }] },
          terminalCondition: ready,
        },
        {
          name: 'projects/gcp-project/locations/us-central1/services/gcp-project-staging-worker',
          labels: { 'infraprint-environment': 'staging' },
          ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
          template: { containers: [{ image: EXPECTED_DEPLOY_IMAGE }] },
          terminalCondition: ready,
        },
        {
          name: 'projects/gcp-project/locations/us-central1/services/gcp-project-production-web',
          labels: { 'infraprint-environment': 'production' },
          ingress: 'INGRESS_TRAFFIC_ALL',
          template: { containers: [{ image: EXPECTED_DEPLOY_IMAGE }] },
          terminalCondition: ready,
        },
        {
          name: 'projects/gcp-project/locations/us-central1/services/gcp-project-production-worker',
          labels: { 'infraprint-environment': 'production' },
          ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
          template: { containers: [{ image: EXPECTED_DEPLOY_IMAGE }] },
          terminalCondition: ready,
        },
      ] });
    }
    if (url.hostname === 'run.googleapis.com' && url.pathname.endsWith('/jobs')) {
      return Response.json({ jobs: [
        {
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-staging-cron',
          labels: { 'infraprint-environment': 'staging' },
          template: { template: { containers: [{ image: EXPECTED_CRON_IMAGE }] } },
          terminalCondition: ready,
        },
        {
          name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-production-cron',
          labels: { 'infraprint-environment': 'production' },
          template: { template: { containers: [{ image: EXPECTED_CRON_IMAGE }] } },
          terminalCondition: ready,
        },
      ] });
    }
    if (url.hostname === 'run.googleapis.com' && url.pathname.endsWith('/executions')) {
      const job = url.pathname.slice(4, -'/executions'.length);
      return Response.json({ executions: [{ name: `${job}/executions/new`, job, createTime: '2026-10-25T12:00:00Z', startTime: '2026-10-25T12:00:01Z', runningCount: 1, template: { containers: [{ env: [{ name: 'API_KEY', value: 'replacement' }] }] } }, { name: `${job}/executions/old`, job, createTime: '2026-10-25T11:00:00Z', startTime: '2026-10-25T11:00:01Z', runningCount: 1, template: { containers: [{ env: [{ name: 'API_KEY', value: 'old' }] }] } }] });
    }
    if (url.hostname === 'run.googleapis.com' && url.pathname.endsWith(':getIamPolicy')) {
      return Response.json({ bindings: [] });
    }
    if (url.hostname === 'cloudscheduler.googleapis.com') {
      const schedulerName = url.pathname.split('/').at(-1)!;
      return Response.json({
        name: `projects/gcp-project/locations/us-central1/jobs/${schedulerName}`,
        schedule: '*/5 * * * *',
        state: 'ENABLED',
      });
    }
    throw new Error(`Unexpected fetch: GET ${url}`);
  }));

  const now = new Date();
  const environment = (name: string): Environment => ({
    id: `env-${name}`,
    projectId: 'project-1',
    name,
    platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' },
    createdAt: now,
    updatedAt: now,
  });

  const [staging, production] = await Promise.all([
    adapter.observe(environment('staging')),
    adapter.observe(environment('production')),
  ]);

  expect(staging.services.map(({ name, externalId }) => ({ name, externalId }))).toEqual([
    { name: 'web', externalId: 'gcp-project-staging-web' },
    { name: 'worker', externalId: 'gcp-project-staging-worker' },
    { name: 'cron', externalId: 'gcp-project-staging-cron-schedule' },
  ]);
  expect(staging.services[0]?.deployment).toMatchObject({ id: 'projects/gcp-project/locations/us-central1/services/gcp-project-staging-web/revisions/new', activeDeploymentIds: ['projects/gcp-project/locations/us-central1/services/gcp-project-staging-web/revisions/new', 'projects/gcp-project/locations/us-central1/services/gcp-project-staging-web/revisions/old', 'projects/gcp-project/locations/us-central1/services/gcp-project-staging-web/revisions/tagged'], activeDeploymentCoverage: 'traffic' });
  expect(staging.services[2]?.deployment).toMatchObject({ id: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-staging-cron/executions/new', activeDeploymentIds: ['projects/gcp-project/locations/us-central1/jobs/gcp-project-staging-cron/executions/new', 'projects/gcp-project/locations/us-central1/jobs/gcp-project-staging-cron/executions/old'], activeDeploymentCoverage: 'instances', envVarHashes: { API_KEY: hashEnvValue('replacement') }, configurationState: 'resolved' });
  expect(production.services.map(({ name, externalId }) => ({ name, externalId }))).toEqual([
    { name: 'web', externalId: 'gcp-project-production-web' },
    { name: 'worker', externalId: 'gcp-project-production-worker' },
    { name: 'cron', externalId: 'gcp-project-production-cron-schedule' },
  ]);
});

it('rejects a runtime service account from a different GCP project', async () => {
  const adapter = new CloudRunAdapter();

  await expect(adapter.connect({
    projectId: 'gcp-project',
    runtimeServiceAccountEmail: 'runtime@other-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({
      type: 'service_account',
      project_id: 'gcp-project',
      private_key: 'dummy',
      client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
    }),
  })).rejects.toThrow(/runtime service account.*connected GCP project/i);
});

  it('verifies with an actionable warning when Cloud Logging views are not readable', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({ services: [] });
      }
      if (url === 'https://logging.googleapis.com/v2/entries:list' && init?.method === 'POST') {
        return Response.json({
          error: {
            code: 403,
            message: 'Permission denied for all log views',
            status: 'PERMISSION_DENIED',
          },
        }, { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(result.email).toBe('deploy@gcp-project.iam.gserviceaccount.com');
    expect(result.warning).toContain('roles/logging.viewer');
    expect(result.warning).toContain('roles/logging.viewAccessor');
    expect(result.warning).toContain('serviceAccount:deploy@gcp-project.iam.gserviceaccount.com');
  });

  it('fails verification when the Cloud Run Admin API probe is denied', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          error: {
            code: 403,
            message: "Permission 'run.services.list' denied on resource",
            status: 'PERMISSION_DENIED',
          },
        }, { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('roles/run.admin');
    expect(result.error).toContain('serviceAccount:deploy@gcp-project.iam.gserviceaccount.com');
  });

  it('fails verification with status and body on non-403 Cloud Run Admin API errors', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://run.googleapis.com/v2/projects/gcp-project/locations/us-central1/services?') && (init?.method ?? 'GET') === 'GET') {
        return new Response('backend unavailable', { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const result = await adapter.verify();

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
    expect(result.error).toContain('backend unavailable');
  });

  it('reads Cloud Run service logs from Cloud Logging', async () => {
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

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://logging.googleapis.com/v2/entries:list' && init?.method === 'POST') {
        return Response.json({
          entries: [{
            timestamp: '2026-06-03T18:00:00Z',
            severity: 'ERROR',
            textPayload: 'boom',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const logs = await adapter.getLogs({
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, 'web', { limit: 25, errorsOnly: true });

    expect(logs).toEqual([{
      timestamp: new Date('2026-06-03T18:00:00Z'),
      severity: 'error',
      message: 'boom',
      raw: expect.any(String),
    }]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.pageSize).toBe(25);
    expect(body.filter).toContain('resource.type="cloud_run_revision"');
    expect(body.filter).toContain('resource.labels.service_name="gcp-project-web"');
    expect(body.filter).toContain('severity>=WARNING');
  });

  it('explains the required IAM roles when Cloud Logging rejects log view access', async () => {
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

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://logging.googleapis.com/v2/entries:list' && init?.method === 'POST') {
        return Response.json({
          error: {
            code: 403,
            message: 'Permission denied for all log views',
            status: 'PERMISSION_DENIED',
          },
        }, { status: 403 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }));

    const now = new Date();
    await expect(adapter.getLogs({
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, 'web', { limit: 25 })).rejects.toThrow(/roles\/logging\.viewAccessor/);
  });

  it('lists Cloud Run revisions and scheduled job executions as deployments', async () => {
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

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/services/gcp-project-web') && !url.includes('/revisions') && method === 'GET') {
        return Response.json({
          name: 'gcp-project-web',
          uid: 'uid-1',
          generation: '1',
          observedGeneration: '1',
          reconciling: false,
          uri: 'https://gcp-project-web.run.app',
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
        });
      }
      if (url.includes('/services/gcp-project-web/revisions') && method === 'GET') {
        return Response.json({
          revisions: [{
            name: 'projects/gcp-project/locations/us-central1/services/gcp-project-web/revisions/gcp-project-web-00001',
            createTime: '2026-06-03T18:00:00Z',
            terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
          }],
        });
      }
      if (url.includes('/jobs/gcp-project-cron/executions') && method === 'GET') {
        return Response.json({
          executions: [{
            name: 'projects/gcp-project/locations/us-central1/jobs/gcp-project-cron/executions/gcp-project-cron-abc',
            startTime: '2026-06-03T18:05:00Z',
            completionTime: '2026-06-03T18:05:10Z',
            completionStatus: 'EXECUTION_SUCCEEDED',
          }],
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = new Date();
    const deployments = await adapter.listDeployments({
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: {
          web: { serviceId: 'gcp-project-web' },
          cron: {
            serviceId: 'gcp-project-cron-schedule',
            jobName: 'gcp-project-cron',
            resourceType: 'scheduledJob',
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, undefined, 10);

    expect(deployments).toEqual([
      {
        id: 'gcp-project-cron-abc',
        status: 'completed',
        createdAt: '2026-06-03T18:05:00Z',
        updatedAt: '2026-06-03T18:05:10Z',
        service: 'cron',
        type: 'jobExecution',
      },
      {
        id: 'gcp-project-web-00001',
        status: 'deployed',
        createdAt: '2026-06-03T18:00:00Z',
        updatedAt: undefined,
        url: 'https://gcp-project-web.run.app',
        service: 'web',
        type: 'revision',
        logUri: undefined,
      },
    ]);
    });
  });

  it('preserves deployment-history API errors instead of returning empty history', async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({
      projectId: 'gcp-project',
      region: 'us-central1',
      credentials: JSON.stringify({
        type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
        client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
      }),
    });
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).accessToken = 'token';
    (adapter as unknown as { accessToken: string; tokenExpiry: Date }).tokenExpiry = new Date(Date.now() + 60_000);

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/services/gcp-project-web/revisions')) {
        return new Response('revision access denied', { status: 403 });
      }
      if (url.includes('/services/gcp-project-web')) {
        return Response.json({
          name: 'gcp-project-web',
          terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const now = new Date();
    await expect(adapter.listDeployments({
      id: 'env-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'cloudrun',
        projectId: 'gcp-project',
        services: { web: { serviceId: 'gcp-project-web' } },
      },
      createdAt: now,
      updatedAt: now,
    }, 'web', 10)).rejects.toThrow(/403.*revision access denied/i);
  });
