import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { MaintenanceWorkloadSnapshot } from '../../../../domain/ports/maintenance.port.js';
import { CloudRunAdapter } from '../cloudrun.adapter.js';

const jobId = 'production-cron';
const schedulerId = 'production-cron-schedule';
const parent = 'projects/gcp-project/locations/us-central1';
const jobName = `${parent}/jobs/${jobId}`;
const schedulerName = `${parent}/jobs/${schedulerId}`;
const target = `https://run.googleapis.com/v2/${jobName}:run`;
const schedule = '0 * * * *';
const execution = (fields: Record<string, unknown> = {}) => ({
  name: `${jobName}/executions/run-1`, job: jobName, ...fields,
});
const completed = () => execution({ completionTime: '2026-11-04T00:01:00Z' });

// Reconstructed REST responses from the official Execution/ListExecutions and
// Cloud Scheduler contracts reviewed in test/provider-contracts/gcp/maintenance.md.
// Only HTTP transport is mocked; requests and interpretation use the real adapter.
async function fixture(options: {
  state?: string;
  inventory?: (page: string | null, read: number) => unknown;
  scheduler?: Record<string, unknown>;
  inventoryStatus?: number;
  pauseLostAcknowledgement?: boolean;
} = {}) {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-central1', credentials: JSON.stringify({
    type: 'service_account', project_id: 'gcp-project', private_key: 'dummy',
    client_email: 'deploy@gcp-project.iam.gserviceaccount.com',
  }) });
  Object.assign(adapter, { accessToken: 'token', tokenExpiry: new Date(Date.now() + 60_000) });
  const now = new Date();
  const environment: Environment = {
    id: 'env-production', projectId: 'project-1', name: 'production', createdAt: now, updatedAt: now,
    platformBindings: { provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-central1',
      services: { cron: { serviceId: schedulerId, jobName: jobId, schedulerJobName: schedulerId } } },
  };
  let state = options.state ?? 'ENABLED';
  let reads = 0;
  const scheduler = () => ({ name: schedulerName, state, schedule, timeZone: 'Etc/UTC',
    httpTarget: { uri: target, httpMethod: 'POST' }, ...options.scheduler });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
    if (url.href === `https://cloudscheduler.googleapis.com/v1/${schedulerName}` && method === 'GET') {
      return Response.json(scheduler());
    }
    if (url.pathname === `/v2/${jobName}/executions` && method === 'GET') {
      reads += 1;
      return Response.json(options.inventory?.(url.searchParams.get('pageToken'), reads)
        ?? { executions: [completed()] }, { status: options.inventoryStatus ?? 200 });
    }
    if (url.href === `https://cloudscheduler.googleapis.com/v1/${schedulerName}:pause` && method === 'POST') {
      expect(JSON.parse(String(init?.body))).toEqual({});
      state = 'PAUSED';
      if (options.pauseLostAcknowledgement) throw new Error('Synthetic response lost');
      return Response.json(scheduler());
    }
    if (url.href === `https://cloudscheduler.googleapis.com/v1/${schedulerName}:resume` && method === 'POST') {
      state = 'ENABLED';
      return Response.json(scheduler());
    }
    throw new Error(`Unexpected maintenance request: ${method} ${url.href}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('HYPERVIBE_GCP_WAIT_DELAY_MS', '0');
  const snapshot: MaintenanceWorkloadSnapshot = {
    serviceId: schedulerId, workloadKind: 'cron', wasRunning: true, cronSchedule: schedule,
    providerState: { schedulerJobName: schedulerId, schedulerState: 'ENABLED', jobName: jobId,
      schedulerTimeZone: 'Etc/UTC', schedulerTarget: target },
  };
  return { adapter, environment, snapshot, fetchMock, reads: () => reads,
    observe: () => adapter.observeMaintenanceWorkload(environment, schedulerId, 'cron'),
    writes: () => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') !== 'GET') };
}

describe('Cloud Run native cron maintenance transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('retains the reviewed immutable official source snapshots offline', () => {
    const sourceDirectory = new URL('../../../../../test/provider-contracts/gcp/maintenance/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('source.json', sourceDirectory), 'utf8')) as {
      sourceRevision: string; files: Array<{ file: string; sourceUrl: string; sha256: string }>;
    };
    expect(manifest.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.files.map((file) => file.file).sort()).toEqual(['cloudscheduler.proto', 'execution.proto', 'job.proto']);
    for (const file of manifest.files) {
      expect(file.sourceUrl).toContain(`/googleapis/googleapis/blob/${manifest.sourceRevision}/`);
      expect(createHash('sha256').update(readFileSync(new URL(file.file, sourceDirectory))).digest('hex')).toBe(file.sha256);
    }
  });

  it('does not equate a paused trigger with an unfinished execution being stopped', async () => {
    const f = await fixture({ state: 'PAUSED', inventory: () => ({ executions: [execution()] }) });
    expect(await f.observe()).toMatchObject({ state: 'running', wasRunning: false,
      reason: 'maintenance_executions_draining' });
    expect(f.writes()).toHaveLength(0);
  });

  it.each([
    ['omitted repeated/scalar defaults', {}],
    ['empty execution inventory', { executions: [], nextPageToken: '' }],
    ['completed execution with omitted false and zero defaults', { executions: [completed()] }],
  ])('accepts %s as complete', async (_label, inventory) => {
    const f = await fixture({ state: 'PAUSED', inventory: () => inventory });
    expect(await f.observe()).toMatchObject({ state: 'suspended' });
  });

  it.each([
    ['a pending execution with omitted scalar defaults', execution()],
    ['an unrelated completionStatus field', execution({ completionStatus: 'SUCCEEDED' })],
    ['completion with running tasks', { ...completed(), runningCount: 1 }],
    ['completion while reconciling', { ...completed(), reconciling: true }],
  ])('keeps %s unfinished', async (_label, run) => {
    const f = await fixture({ state: 'PAUSED', inventory: () => ({ executions: [run] }) });
    expect(await f.observe()).toMatchObject({ state: 'running' });
  });

  it.each([
    ['foreign job identity', { executions: [execution({ name: `${parent}/jobs/staging-cron/executions/run-1` })] }],
    ['missing identity', { executions: [{ completionTime: '2026-11-04T00:01:00Z' }] }],
    ['foreign parent', { executions: [execution({ job: `${parent}/jobs/staging-cron` })] }],
    ['malformed collection', { executions: {} }],
    ['malformed body', []],
    ['duplicate identities', { executions: [completed(), completed()] }],
    ['invalid scalar', { executions: [execution({ runningCount: '0' })] }],
    ['invalid completion time', { executions: [execution({ completionTime: 'finished' })] }],
    ['malformed pagination', { nextPageToken: 4 }],
  ])('keeps %s unknown and performs no mutations', async (_label, inventory) => {
    const f = await fixture({ state: 'PAUSED', inventory: () => inventory });
    expect(await f.observe()).toMatchObject({ state: 'unknown' });
    await expect(f.adapter.suspendMaintenanceWorkload(f.environment, f.snapshot)).resolves.toMatchObject({ success: false });
    expect(f.writes()).toHaveLength(0);
  });

  it('rejects repeated continuation tokens instead of treating a partial list as completion', async () => {
    const f = await fixture({ state: 'PAUSED', inventory: () => ({ nextPageToken: 'repeat' }) });
    expect(await f.observe()).toMatchObject({ state: 'unknown' });
    expect(f.reads()).toBe(2);
  });

  it('does not treat inaccessible execution inventory as empty', async () => {
    const f = await fixture({ state: 'PAUSED', inventoryStatus: 403 });
    expect(await f.observe()).toMatchObject({ state: 'unknown' });
    expect(f.writes()).toHaveLength(0);
  });

  it.each([
    ['unrelated scheduler identity', { name: `${parent}/jobs/staging-cron-schedule` }],
    ['unrelated scheduler target', { httpTarget: { uri: `https://run.googleapis.com/v2/${parent}/jobs/staging-cron:run`, httpMethod: 'POST' } }],
  ])('blocks %s before any mutation', async (_label, scheduler) => {
    const f = await fixture({ scheduler });
    expect(await f.observe()).toMatchObject({ state: 'unknown' });
    await expect(f.adapter.suspendMaintenanceWorkload(f.environment, f.snapshot)).resolves.toMatchObject({ success: false });
    expect(f.writes()).toHaveLength(0);
  });

  it('blocks resume when the saved schedule changed', async () => {
    const f = await fixture({ state: 'PAUSED', scheduler: { schedule: '*/5 * * * *' } });
    await expect(f.adapter.resumeMaintenanceWorkload(f.environment, f.snapshot)).resolves.toMatchObject({ success: false });
    expect(f.writes()).toHaveLength(0);
  });
});
