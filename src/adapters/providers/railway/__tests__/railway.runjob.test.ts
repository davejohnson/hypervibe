import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

vi.mock('../../github/package-pull.js', () => ({
  githubPackagePullCredentials: vi.fn(() => ({ username: 'dave', token: 'ghp_read' })),
}));

import { githubPackagePullCredentials } from '../../github/package-pull.js';

const environment = {
  id: 'env-1',
  name: 'production',
  platformBindings: {
    provider: 'railway',
    projectId: 'proj-1',
    environmentId: 'railenv-1',
    services: { web: { serviceId: 'src-svc-1' } },
  },
} as unknown as Environment;

const webService = { id: 'svc-local', name: 'web', buildConfig: {} } as unknown as Service;

interface Call {
  query: string;
  variables: Record<string, unknown>;
}

/**
 * Fake GraphQL client dispatching on operation name. Overrides let each test
 * replace individual operations (e.g. sentinel logs, crash status).
 */
function fakeClient(overrides: Record<string, (variables: Record<string, unknown>, call: number) => unknown> = {}) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const defaults: Record<string, (variables: Record<string, unknown>, call: number) => unknown> = {
    TaskSourceInstance: () => ({ serviceInstance: { source: { image: 'ghcr.io/dave/app:sha1' } } }),
    GetVariables: () => ({ variables: { DATABASE_URL: 'postgresql://internal', RAILWAY_TOKEN_INJECTED: 'x', SESSION_SECRET: 's' } }),
    CreateTaskService: () => ({ serviceCreate: { id: 'task-svc-1', name: 'hv-task-x' } }),
    ConfigureTaskService: () => ({ serviceInstanceUpdate: true }),
    DeployTaskService: () => ({ serviceInstanceDeployV2: 'dep-1' }),
    TaskDeploymentStatus: () => ({ deployment: { status: 'SUCCESS' } }),
    GetLogs: () => ({ deploymentLogs: [
      { timestamp: 't', message: 'seeding...', severity: 'info' },
      { timestamp: 't', message: '__HYPERVIBE_TASK_EXIT:0__', severity: 'info' },
    ] }),
    serviceDelete: () => ({ serviceDelete: true }),
    GetService: () => { throw new Error('Service not found'); },
  };
  const request = vi.fn(async (query: string, variables: Record<string, unknown> = {}) => {
    const text = String(query);
    const key = Object.keys({ ...defaults, ...overrides }).find((name) => text.includes(name));
    if (!key) throw new Error(`Unexpected query in test: ${text.slice(0, 120)}`);
    calls.push({ query: key, variables });
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const handler = overrides[key] ?? defaults[key];
    return handler(variables, n);
  });
  return { request, calls };
}

function adapterWith(client: { request: ReturnType<typeof vi.fn> }): RailwayAdapter {
  const adapter = new RailwayAdapter();
  (adapter as unknown as { client: unknown }).client = client;
  return adapter;
}

const fastOptions = { timeoutMs: 2000, pollIntervalMs: 1 };

describe('RailwayAdapter.runJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the command in a temp service and cleans it up', async () => {
    const client = fakeClient();
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.runner).toBe('railway-temp-service');
    expect(result.jobId).toBe('dep-1');
    expect(result.output).toContain('seeding...');
    expect(result.output).not.toContain('__HYPERVIBE_TASK_EXIT');
    expect(result.cleanupWarning).toBeUndefined();

    const sequence = client.calls.map((call) => call.query);
    expect(sequence.slice(0, 5)).toEqual([
      'TaskSourceInstance', 'GetVariables', 'CreateTaskService', 'ConfigureTaskService', 'DeployTaskService',
    ]);
    expect(sequence).toContain('serviceDelete');

    const create = client.calls.find((call) => call.query === 'CreateTaskService')!;
    const createInput = create.variables.input as Record<string, unknown>;
    expect(createInput.name).toMatch(/^hv-task-/);
    // RAILWAY_* provider-injected vars are not copied to the temp service.
    expect(createInput.variables).toEqual({ DATABASE_URL: 'postgresql://internal', SESSION_SECRET: 's' });

    const configure = client.calls.find((call) => call.query === 'ConfigureTaskService')!;
    const configureInput = configure.variables.input as Record<string, unknown>;
    expect(configureInput.restartPolicyType).toBe('NEVER');
    expect(configureInput.restartPolicyMaxRetries).toBe(0);
    expect(configureInput.source).toEqual({ image: 'ghcr.io/dave/app:sha1' });
    // ghcr image → pull credentials from the GitHub connection.
    expect(configureInput.registryCredentials).toEqual({ username: 'dave', password: 'ghp_read' });
    expect(String(configureInput.startCommand)).toContain('npm run db:seed');
    expect(String(configureInput.startCommand)).toContain('__HYPERVIBE_TASK_EXIT:');
    expect(githubPackagePullCredentials).toHaveBeenCalled();
  });

  it('reports a non-zero exit sentinel as failed with the exit code', async () => {
    const client = fakeClient({
      GetLogs: () => ({ deploymentLogs: [{ timestamp: 't', message: '__HYPERVIBE_TASK_EXIT:3__', severity: 'error' }] }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.receipt.success).toBe(false);
    expect(client.calls.map((call) => call.query)).toContain('serviceDelete');
  });

  it('reports timeout when no sentinel appears, still deleting the temp service', async () => {
    const client = fakeClient({
      TaskDeploymentStatus: () => ({ deployment: { status: 'DEPLOYING' } }),
      GetLogs: () => ({ deploymentLogs: [{ timestamp: 't', message: 'still building', severity: 'info' }] }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', { timeoutMs: 20, pollIntervalMs: 1 });

    expect(result.status).toBe('timeout');
    expect(result.receipt.success).toBe(false);
    expect(client.calls.map((call) => call.query)).toContain('serviceDelete');
  });

  it('treats CRASHED before any sentinel as a container start failure', async () => {
    const client = fakeClient({
      TaskDeploymentStatus: () => ({ deployment: { status: 'CRASHED' } }),
      GetLogs: () => ({ deploymentLogs: [] }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBeUndefined();
    expect(String(result.receipt.error)).toContain('failed to start');
  });

  it('surfaces a cleanup warning when the temp service cannot be deleted', async () => {
    const client = fakeClient({
      serviceDelete: () => { throw new Error('boom'); },
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    // Task result is preserved; cleanup failure is a warning, not an error.
    expect(result.status).toBe('completed');
    expect(result.cleanupWarning).toContain('task-svc-1');
  });

  it('fails fast with deploy-first guidance when the source service has no image', async () => {
    const client = fakeClient({
      TaskSourceInstance: () => ({ serviceInstance: { source: null } }),
    });
    const adapter = adapterWith(client);

    const result = await adapter.runJob(environment, webService, 'npm run db:seed', fastOptions);

    expect(result.status).toBe('failed');
    expect(String(result.receipt.error)).toContain('Deploy it first');
    expect(client.calls.map((call) => call.query)).not.toContain('CreateTaskService');
  });
});
