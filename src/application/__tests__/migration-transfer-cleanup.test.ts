import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverTerminalTransferResources, runTransferJob, verifyTransferResourcesAbsent, type TransferResources } from '../migration-transfer-gcp.js';

const project = 'fixture-project';
const region = 'us-central1';
const parent = `projects/${project}/locations/${region}`;
const context = { token: async () => 'fixture', gcpProjectId: project, region, runtimeServiceAccountEmail: 'transfer@fixture.invalid', environmentLabel: 'staging' };
const job = { purpose: 'database' as const, image: 'postgres:18', script: 'true', env: {}, sourceSecrets: {}, timeoutSeconds: 60 };
const json = (body: unknown, status = 200) => Response.json(body, { status });
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Scenario = 'normal' | 'delete-failed' | 'still-present' | 'uncertain-create' | 'collision' | 'foreign-operation' | 'run-response-lost' | 'replaced-job' | 'transient-delete' | 'poll-recovers' | 'poll-unavailable' | 'poll-denied' | 'run-unscoped' | 'run-still-active' | 'run-failed';
function cloud(scenario: Scenario) {
  const calls: string[] = [];
  const recorded: (TransferResources | null)[] = [];
  let jobId = '';
  let labels = {};
  let present = false;
  let deleteRequested = false;
  let ran = false;
  let deleteAttempts = 0;
  let runPolls = 0;
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v2\//, '');
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const name = `${parent}/jobs/${jobId}`;
    const nativeJob = { name, uid: scenario === 'replaced-job' && ran ? 'replacement-uid' : 'fixture-uid', etag: 'job-tag', labels };
    if (url.hostname === 'logging.googleapis.com') return json({ entries: String(init.body).includes('HV_RESTORE_ERROR') ? [] : [{ textPayload: 'HV_TRANSFER_RESULT {"ok":true}' }] });
    if (path === `${parent}/jobs` && method === 'POST') {
      jobId = url.searchParams.get('jobId')!;
      labels = JSON.parse(String(init.body)).labels;
      present = true;
      if (scenario === 'collision' || scenario === 'uncertain-create') {
        labels = { 'managed-by': 'hypervibe', 'hv-temporary': 'true' };
        if (scenario === 'uncertain-create') throw new Error('Create response lost');
        return json({}, 409);
      }
      return json({ name: `${parent}/operations/create`, done: true, response: { ...nativeJob, name: `${parent}/jobs/${jobId}` } });
    }
    if (method === 'GET' && path.startsWith(`${parent}/jobs/`)) return present ? json(nativeJob) : json({}, 404);
    if (method === 'POST' && path === `${name}:run`) {
      ran = true;
      if (JSON.parse(String(init.body)).etag !== nativeJob.etag) throw new Error('Missing run etag');
      if (scenario === 'run-response-lost') throw new Error('Run response lost');
      if (scenario.startsWith('poll-') || scenario.startsWith('run-')) return json({ name: `${parent}/operations/run` });
      return json({ name: `${parent}/operations/run`, done: true, response: { name: `${name}/executions/exact-execution`, succeededCount: 1, completionTime: '2026-11-12T12:00:00Z' } });
    }
    if (path === `${parent}/operations/run`) {
      runPolls++;
      if (scenario === 'poll-unavailable' || (scenario === 'poll-recovers' && runPolls === 1)) return json({}, 503);
      if (scenario === 'poll-recovers' && runPolls === 2) return json({}, 429);
      if (scenario === 'poll-recovers' && runPolls === 3) throw new Error('Temporary polling failure');
      if (scenario === 'poll-denied') return json({}, 403);
      if (scenario === 'run-still-active') return json({ name: path, done: true, response: { name: `${name}/executions/exact-execution`, runningCount: 1 } });
      if (scenario === 'run-unscoped') return json({ name: path, done: true, response: { name: `${parent}/jobs/different/executions/x` } });
      if (scenario === 'run-failed') return json({ name: path, done: true, error: { code: 13, message: 'Execution failed' }, metadata: { name: `${name}/executions/exact-execution` } });
      return json({ name: path, done: true, response: { name: `${name}/executions/exact-execution`, succeededCount: 1, completionTime: '2026-11-12T12:00:00Z' } });
    }
    if (method === 'DELETE' && path === name) {
      if (url.searchParams.get('etag') !== nativeJob.etag) throw new Error('Missing deletion etag');
      deleteAttempts++;
      if (scenario === 'transient-delete' && deleteAttempts === 1) return json({}, 503);
      if (scenario === 'delete-failed') return json({}, 503);
      if (scenario === 'foreign-operation') return json({ name: 'projects/other-project/locations/us-central1/operations/delete' });
      deleteRequested = true;
      return json({ name: `${parent}/operations/delete` });
    }
    if (path === `${parent}/operations/delete` && deleteRequested) {
      if (scenario !== 'still-present') present = false;
      return json({ name: path, done: true, response: nativeJob });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetch);
  const run = async () => {
    const pending = runTransferJob({ ...context, recordTransferResources: (resources) => {
      recorded.push(resources);
      calls.push(resources ? 'record' : 'clear');
    } }, job).catch((error: Error) => ({ ok: false, error: error.message }));
    await vi.runAllTimersAsync();
    return pending;
  };
  return { calls, recorded, run };
}

describe('temporary Cloud Run transfer ownership and completion', () => {
  it('records the scoped operation before run and clears it after the delete operation and an exact 404', async () => {
    const provider = cloud('normal');
    expect(await provider.run()).toMatchObject({ ok: true });
    const resources = provider.recorded[0]!;
    expect(resources).toMatchObject({ gcpProjectId: project, region, secretIds: [] });
    const run = `POST ${parent}/jobs/${resources.jobId}:run`;
    expect(provider.calls.indexOf(run)).toBeGreaterThan(provider.calls.indexOf('record'));
    const poll = provider.calls.indexOf(`GET ${parent}/operations/delete`);
    expect(poll).toBeGreaterThan(provider.calls.indexOf(`DELETE ${parent}/jobs/${resources.jobId}`));
    expect(provider.calls.lastIndexOf(`GET ${parent}/jobs/${resources.jobId}`)).toBeGreaterThan(poll);
    expect(provider.calls.at(-1)).toBe('clear');
  });
  it('rechecks ownership before retrying a transient delete', async () => {
    const provider = cloud('transient-delete');
    expect(await provider.run()).toMatchObject({ ok: true });
    expect(provider.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(2);
    expect(provider.calls.at(-1)).toBe('clear');
  });
  it('preserves a replacement job even when it inherited the transfer labels', async () => {
    const provider = cloud('replaced-job');
    expect(await provider.run()).toMatchObject({ ok: false });
    expect(provider.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });
  it('does not write a credential into or remove an unreviewed secret container', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await runTransferJob(context, { ...job, sourceSecrets: { SOURCE_DATABASE_URL: 'private-fixture' } })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['delete-failed', 'still-present', 'foreign-operation'] as const)('keeps a finished transfer blocked when the job cleanup is %s', async (scenario) => {
    const provider = cloud(scenario);
    expect(await provider.run()).toMatchObject({ ok: false });
    expect(provider.recorded[0]?.jobId).toBeTruthy();
    expect(provider.recorded).not.toContain(null);
    expect(provider.calls.some((call) => call.includes('other-project'))).toBe(false);
  });
  it.each(['collision', 'uncertain-create'] as const)('preserves a same-name foreign job after %s', async (scenario) => {
    const provider = cloud(scenario);
    expect(await provider.run()).toMatchObject({ ok: false });
    expect(provider.calls.some((call) => call.startsWith('DELETE') || call.endsWith(':run'))).toBe(false);
  });
  it('retries observation after HTTP 503, rate limiting, and a transport failure without reissuing the execution', async () => {
    const provider = cloud('poll-recovers');
    expect(await provider.run()).toMatchObject({ ok: true });
    expect(provider.calls.filter((call) => call === `GET ${parent}/operations/run`)).toHaveLength(4);
    expect(provider.calls.filter((call) => call.endsWith(':run'))).toHaveLength(1);
    expect(provider.calls.at(-1)).toBe('clear');
  });
  it.each(['run-response-lost', 'poll-unavailable', 'poll-denied', 'run-unscoped', 'run-still-active'] as const)('keeps the exact job and journal when execution completion is unknown: %s', async scenario => {
    const provider = cloud(scenario);
    expect(await provider.run()).toMatchObject({ ok: false });
    expect(provider.calls.filter((call) => call.endsWith(':run'))).toHaveLength(1);
    expect(provider.calls.some(call => call.startsWith('DELETE'))).toBe(false);
    expect(provider.recorded.at(-1)).toMatchObject({ jobUid: 'fixture-uid' });
    if (scenario === 'poll-unavailable') expect(provider.calls.filter(call => call.endsWith('/operations/run')).length).toBeLessThanOrEqual(72);
  });
  it('cleans up after a provider-confirmed terminal execution error without reporting a successful copy', async () => {
    const provider = cloud('run-failed');
    expect(await provider.run()).toMatchObject({ ok: false });
    expect(provider.calls.filter(call => call.startsWith('DELETE'))).toHaveLength(1);
    expect(provider.calls.at(-1)).toBe('clear');
  });
});

describe('read-only recovery of transfer resources', () => {
  const jobId = 'hv-migrate-database-df53c0';
  const resources: TransferResources = { gcpProjectId: project, region, jobId, secretIds: [`${jobId}-source-database-url`] };
  it.each([404, 200, 403, 500])('requires exact absence of the job and every secret (secret HTTP %i)', async (status) => {
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      expect(init.method ?? 'GET').toBe('GET');
      return json({}, url.includes('run.googleapis.com') ? 404 : status);
    });
    vi.stubGlobal('fetch', fetch);
    expect(await verifyTransferResourcesAbsent(context, resources)).toBe(status === 404);
    expect(fetch.mock.calls.map(([url]) => url)).toContain(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${resources.secretIds[0]}`);
  });
  it.each([{ region: 'us-east1' }, { gcpProjectId: 'other-project' }, { secretIds: ['persistent-database-url'] }, { jobId: '../apps' }])('rejects untrusted receipt scope %j before provider access', async (override) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await verifyTransferResourcesAbsent(context, { ...resources, ...override })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('explicit recovery of an interrupted transfer', () => {
  const jobId = 'hv-migrate-storage-ef394a';
  const resources = { gcpProjectId: project, region, jobId, secretIds: [], ownershipToken: 'unique-transfer', jobUid: 'stable-job-uid' };
  const name = `${parent}/jobs/${jobId}`;
  const completed = (id: string) => ({ name: `${name}/executions/${id}`, job: name, uid: id, completionTime: '2026-11-10T00:00:00Z' });

  it.each(['complete', 'running', 'missing', 'cycle', 'foreign', 'denied', 'replaced', 'changed', 'empty'] as const)('checks every execution and uses its observed job revision: %s', async (scenario) => {
    let jobReads = 0;
    let deleted = false;
    let pages = 0;
    const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/executions')) {
        pages++;
        if (!url.searchParams.has('pageToken')) return json({ executions: [completed('first')], nextPageToken: 'more' });
        if (scenario === 'denied') return json({}, 403);
        const last = completed('last');
        return json({ executions: scenario === 'missing' ? [] : [scenario === 'running' ? { ...last, completionTime: undefined } : scenario === 'foreign' ? { ...last, job: 'unrelated' } : last],
          ...(scenario === 'cycle' ? { nextPageToken: 'more' } : {}) });
      }
      if (!url.pathname.endsWith('/' + jobId)) throw new Error('Unexpected request');
      if (init.method === 'DELETE') {
        if (url.searchParams.get('etag') !== 'rev') return json({}, 412);
        deleted = true;
        return json({ name: `${parent}/operations/del`, done: true, response: {} });
      }
      jobReads++;
      return deleted ? json({}, 404) : json({ name, uid: scenario === 'replaced' ? 'other' : resources.jobUid, etag: scenario === 'changed' && pages ? 'new-revision' : 'rev',
        labels: { 'managed-by': 'hypervibe', 'hv-temporary': 'true', 'hv-transfer': resources.ownershipToken },
        executionCount: scenario === 'empty' ? 0 : 2, latestCreatedExecution: { name: `${name}/executions/last` } });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await recoverTerminalTransferResources(context, resources)).toBe(scenario === 'complete');
    expect(deleted).toBe(scenario === 'complete');
    if (scenario === 'complete') {
      expect(pages).toBe(2);
      expect(jobReads).toBeGreaterThanOrEqual(2);
    }
  });
});
