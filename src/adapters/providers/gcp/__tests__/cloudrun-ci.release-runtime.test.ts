import { describe, expect, it, vi } from 'vitest';
import { buildCloudRunReleaseRuntime } from '../cloudrun-ci.release-runtime.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

async function runtime(fetchImpl: typeof fetch): Promise<{
  runCloudRunReleaseCommands: (params: Record<string, unknown>) => Promise<void>;
  cloudRunRuntimeResourcesFromBase64: (
    encoded: string,
    serviceNames: string[],
    jobNames: string[]
  ) => Array<Record<string, unknown>>;
  cloudRunContainerWithRuntime: (
    container: Record<string, unknown>,
    image: string,
    resource: Record<string, unknown>
  ) => Record<string, unknown>;
  cloudRunRuntimeMismatch: (
    container: Record<string, unknown>,
    resource: Record<string, unknown>
  ) => string | null;
}> {
  const load = new AsyncFunction(
    'fetch',
    `${buildCloudRunReleaseRuntime()}\nreturn { runCloudRunReleaseCommands, cloudRunRuntimeResourcesFromBase64, cloudRunContainerWithRuntime, cloudRunRuntimeMismatch };`
  );
  return await load(fetchImpl) as Awaited<ReturnType<typeof runtime>>;
}

describe('Cloud Run generated release runtime', () => {
  const projectId = 'gcp-project';
  const region = 'us-central1';
  const serviceName = 'cloudapp-staging-web';
  const jobName = `${serviceName}-migration`;
  const serviceUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}`;
  const jobUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${jobName}`;
  const executionName = `projects/${projectId}/locations/${region}/jobs/${jobName}/executions/run-1`;
  const runOperationName = `projects/${projectId}/locations/${region}/operations/run`;
  const configureOperationName = `projects/${projectId}/locations/${region}/operations/configure`;

  function release() {
    return {
      serviceName: 'web',
      providerServiceId: serviceName,
      jobName,
      command: 'npm run db:migrate',
      commandHash: 'a'.repeat(64),
    };
  }

  function readyJob(overrides: Record<string, unknown> = {}) {
    return {
      name: `projects/${projectId}/locations/${region}/jobs/${jobName}`,
      generation: '1',
      observedGeneration: '1',
      terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      template: {
        template: {
          containers: [{
            image: 'candidate@sha256:' + 'b'.repeat(64),
            command: ['/bin/sh'],
            args: ['-lc', 'npm run db:migrate'],
            env: [],
          }],
          maxRetries: 1,
          timeout: '3600s',
        },
      },
      ...overrides,
    };
  }

  it('applies and verifies exact per-resource commands and service probes', async () => {
    const loaded = await runtime(vi.fn() as unknown as typeof fetch);
    const resources = [
      {
        logicalName: 'web', workloadKind: 'web', providerResourceType: 'service',
        providerResourceId: 'web-service', startCommand: 'npm run web', healthCheckPath: '/healthz',
      },
      {
        logicalName: 'worker', workloadKind: 'worker', providerResourceType: 'service',
        providerResourceId: 'worker-service', startCommand: 'npm run worker', healthCheckPath: '/ready',
      },
      {
        logicalName: 'daily', workloadKind: 'cron', providerResourceType: 'job',
        providerResourceId: 'daily-job', startCommand: 'npm run daily', healthCheckPath: null,
      },
    ];
    const decoded = loaded.cloudRunRuntimeResourcesFromBase64(
      Buffer.from(JSON.stringify(resources)).toString('base64'),
      ['web-service', 'worker-service'],
      ['daily-job']
    );

    const web = loaded.cloudRunContainerWithRuntime(
      { image: 'old', command: ['stale'], args: ['stale'], livenessProbe: { tcpSocket: {} } },
      'candidate@sha256:' + 'b'.repeat(64),
      decoded[0]!
    );
    expect(web).toMatchObject({
      image: expect.stringContaining('@sha256:'),
      command: ['/bin/sh'],
      args: ['-lc', 'npm run web'],
      startupProbe: { httpGet: { path: '/healthz' } },
    });
    expect(web).not.toHaveProperty('livenessProbe');
    expect(loaded.cloudRunRuntimeMismatch(web, decoded[0]!)).toBeNull();

    const worker = loaded.cloudRunContainerWithRuntime({}, 'candidate@sha256:' + 'b'.repeat(64), decoded[1]!);
    expect(worker).toMatchObject({
      command: ['/bin/sh'],
      args: ['-lc', 'npm run worker'],
      startupProbe: { httpGet: { path: '/ready' } },
    });
    expect(loaded.cloudRunRuntimeMismatch(worker, decoded[1]!)).toBeNull();

    const cron = loaded.cloudRunContainerWithRuntime({}, 'candidate@sha256:' + 'b'.repeat(64), decoded[2]!);
    expect(cron).toMatchObject({ command: ['/bin/sh'], args: ['-lc', 'npm run daily'] });
    expect(loaded.cloudRunRuntimeMismatch({ ...cron, args: ['-lc', 'stale'] }, decoded[2]!)).toBe('container command');
  });

  it('refuses to create a release-command job that reviewed apply did not bind', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const loaded = await runtime(fetchImpl);

    await expect(loaded.runCloudRunReleaseCommands({
      releases: [release()],
      imageUri: 'candidate@sha256:' + 'b'.repeat(64),
      projectId,
      region,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      authHeaders: { Authorization: 'Bearer token' },
      getJson: vi.fn(async () => ({
        name: `projects/${projectId}/locations/${region}/services/${serviceName}`,
        template: { containers: [{}] },
      })),
      waitOperation: vi.fn(),
    })).rejects.toThrow(/reviewed release job.*missing/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('runs the candidate image with copied runtime config and omits service-only cpuIdle', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === jobUrl && !init?.method) return Response.json(readyJob());
      if (url === jobUrl && init?.method === 'PATCH') {
        return Response.json({ name: configureOperationName, done: true });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const getJson = vi.fn(async (url: string) => {
      if (url === serviceUrl) {
        return {
          name: `projects/${projectId}/locations/${region}/services/${serviceName}`,
          template: {
            containers: [{
              image: 'old-image',
              env: [{ name: 'DATABASE_URL', valueSource: { secretKeyRef: { secret: 'database-url' } } }],
              resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true },
              volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }],
            }],
            volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: ['gcp-project:us-central1:database'] } }],
            serviceAccount: 'runtime@gcp-project.iam.gserviceaccount.com',
            vpcAccess: { egress: 'ALL_TRAFFIC' },
          },
        };
      }
      if (url === jobUrl) {
        return {
          name: `projects/${projectId}/locations/${region}/jobs/${jobName}`,
          generation: '1',
          observedGeneration: '1',
          terminalCondition: { state: 'CONDITION_SUCCEEDED' },
          template: {
            template: {
              containers: [{
                image: 'us-central1-docker.pkg.dev/gcp-project/infraprint/app@sha256:' + 'b'.repeat(64),
                command: ['/bin/sh'],
                args: ['-lc', 'npm run db:migrate'],
                env: [{ name: 'DATABASE_URL', valueSource: { secretKeyRef: { secret: 'database-url' } } }],
                resources: { limits: { cpu: '1', memory: '512Mi' } },
                volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }],
              }],
              volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: ['gcp-project:us-central1:database'] } }],
              serviceAccount: 'runtime@gcp-project.iam.gserviceaccount.com',
              vpcAccess: { egress: 'ALL_TRAFFIC' },
              maxRetries: 1,
              timeout: '3600s',
            },
          },
        };
      }
      if (url === `${jobUrl}:run`) return { name: runOperationName, done: false };
      throw new Error(`Unexpected getJson ${url}`);
    });
    const waitOperation = vi.fn(async (operation: { name: string }) => operation.name === runOperationName
      ? { ...operation, done: true, response: { name: executionName, completionStatus: 'EXECUTION_SUCCEEDED' } }
      : { ...operation, done: true });
    const loaded = await runtime(fetchImpl);

    await loaded.runCloudRunReleaseCommands({
      releases: [release()],
      imageUri: 'us-central1-docker.pkg.dev/gcp-project/infraprint/app@sha256:' + 'b'.repeat(64),
      projectId,
      region,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      authHeaders: { Authorization: 'Bearer token' },
      getJson,
      waitOperation,
    });

    const update = requests.find((request) => request.url === jobUrl && request.init?.method === 'PATCH');
    const body = JSON.parse(String(update?.init?.body));
    expect(body.template.template.containers[0]).toMatchObject({
      image: expect.stringContaining('@sha256:'),
      command: ['/bin/sh'],
      args: ['-lc', 'npm run db:migrate'],
      resources: { limits: { cpu: '1', memory: '512Mi' } },
    });
    expect(body.template.template.containers[0].resources).not.toHaveProperty('cpuIdle');
    expect(body.template.template).toMatchObject({
      serviceAccount: 'runtime@gcp-project.iam.gserviceaccount.com',
      maxRetries: 1,
      timeout: '3600s',
    });
    expect(requests.some((request) => request.url.includes('/executions'))).toBe(false);
  });

  it('fails on the exact new execution even if stale execution history could be successful', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === jobUrl && !init?.method) return Response.json(readyJob());
      if (url === jobUrl && init?.method === 'PATCH') return Response.json({ name: configureOperationName, done: true });
      throw new Error(`Unexpected fetch ${url}`);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const getJson = vi.fn(async (url: string) => {
      if (url === serviceUrl) return {
        name: `projects/${projectId}/locations/${region}/services/${serviceName}`,
        template: { containers: [{}] },
      };
      if (url === jobUrl) return readyJob();
      if (url === `${jobUrl}:run`) return { name: runOperationName, done: false };
      throw new Error(`Unexpected getJson ${url}`);
    });
    const waitOperation = vi.fn(async (operation: { name: string }) => operation.name === runOperationName
      ? { ...operation, done: true, response: { name: executionName, completionStatus: 'EXECUTION_FAILED' } }
      : { ...operation, done: true });
    const loaded = await runtime(fetchImpl);

    await expect(loaded.runCloudRunReleaseCommands({
      releases: [release()],
      imageUri: 'candidate@sha256:' + 'b'.repeat(64),
      projectId,
      region,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      authHeaders: { Authorization: 'Bearer token' },
      getJson,
      waitOperation,
    })).rejects.toThrow(`Cloud Run release execution ${executionName} ended with status failed`);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/executions'))).toBe(false);
  });

  it('rejects a successful run response for a different Cloud Run job identity', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === jobUrl && !init?.method) return Response.json(readyJob());
      if (url === jobUrl && init?.method === 'PATCH') return Response.json({ name: configureOperationName, done: true });
      throw new Error(`Unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const getJson = vi.fn(async (url: string) => {
      if (url === serviceUrl) return {
        name: `projects/${projectId}/locations/${region}/services/${serviceName}`,
        template: { containers: [{}] },
      };
      if (url === jobUrl) return readyJob();
      if (url === `${jobUrl}:run`) return { name: runOperationName, done: false };
      throw new Error(`Unexpected getJson ${url}`);
    });
    const wrongExecution = `projects/${projectId}/locations/${region}/jobs/another-job/executions/run-1`;
    const waitOperation = vi.fn(async (operation: { name: string }) => operation.name === runOperationName
      ? { ...operation, done: true, response: { name: wrongExecution, completionStatus: 'EXECUTION_SUCCEEDED' } }
      : { ...operation, done: true });
    const loaded = await runtime(fetchImpl);

    await expect(loaded.runCloudRunReleaseCommands({
      releases: [release()],
      imageUri: 'candidate@sha256:' + 'b'.repeat(64),
      projectId,
      region,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      authHeaders: { Authorization: 'Bearer token' },
      getJson,
      waitOperation,
    })).rejects.toThrow(`Cloud Run release job ${jobName} returned a different execution identity`);
  });

  it('refuses to execute an acknowledged release job with stale candidate configuration', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === jobUrl && !init?.method) return Response.json(readyJob());
      if (url === jobUrl && init?.method === 'PATCH') return Response.json({ name: configureOperationName, done: true });
      throw new Error(`Unexpected fetch ${url}`);
    });
    const getJson = vi.fn(async (url: string) => {
      if (url === serviceUrl) return {
        name: `projects/${projectId}/locations/${region}/services/${serviceName}`,
        template: { containers: [{}] },
      };
      if (url === jobUrl) return readyJob({
        template: {
          template: {
            containers: [{
              image: 'stale@sha256:' + 'c'.repeat(64),
              command: ['/bin/sh'],
              args: ['-lc', 'npm run db:migrate'],
              env: [],
            }],
            maxRetries: 1,
            timeout: '3600s',
          },
        },
      });
      throw new Error(`Unexpected getJson ${url}`);
    });
    const loaded = await runtime(fetchMock as unknown as typeof fetch);

    await expect(loaded.runCloudRunReleaseCommands({
      releases: [release()],
      imageUri: 'candidate@sha256:' + 'b'.repeat(64),
      projectId,
      region,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      authHeaders: { Authorization: 'Bearer token' },
      getJson,
      waitOperation: vi.fn(async (operation: unknown) => operation),
    })).rejects.toThrow('did not converge to the exact candidate container image');
    expect(getJson).not.toHaveBeenCalledWith(`${jobUrl}:run`, expect.anything(), expect.anything());
  });

  it('rejects a release-job configuration response without an exact scoped operation identity', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === jobUrl && !init?.method) return Response.json(readyJob());
      if (url === jobUrl && init?.method === 'PATCH') return Response.json({ name: 'operations/configure', done: true });
      throw new Error(`Unexpected fetch ${url}`);
    });
    const getJson = vi.fn(async (url: string) => {
      if (url === serviceUrl) return {
        name: `projects/${projectId}/locations/${region}/services/${serviceName}`,
        template: { containers: [{}] },
      };
      throw new Error(`Unexpected getJson ${url}`);
    });
    const waitOperation = vi.fn();
    const loaded = await runtime(fetchMock as unknown as typeof fetch);

    await expect(loaded.runCloudRunReleaseCommands({
      releases: [release()],
      imageUri: 'candidate@sha256:' + 'b'.repeat(64),
      projectId,
      region,
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      authHeaders: { Authorization: 'Bearer token' },
      getJson,
      waitOperation,
    })).rejects.toThrow('configuration returned a different operation identity');
    expect(waitOperation).not.toHaveBeenCalled();
  });
});
