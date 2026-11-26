/**
 * The private source values of a migration copy (a signed link to a database
 * export, a source database URL, a source bucket's access keys) on their way
 * to the copy job: the real job runner and the real Secret Manager client,
 * over an in-memory Secret Manager and a stand-in for Cloud Run and its logs.
 * A value may reach Secret Manager and nothing else; whatever happens, the
 * temporary secrets are gone afterwards or are removed by the next run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { acquireMigrationTargetLease } from '../../adapters/db/migration-target-lease.js';
import { recoverTerminalTransferResources, runTransferJob, transferSettleMinutes, verifyTransferResourcesAbsent, type TransferJob, type TransferResources } from '../migration-transfer-gcp.js';
import { fakeSecretManager } from './pause-fixtures.js';

const project = 'fixture-project';
const region = 'us-central1';
const parent = `projects/${project}/locations/${region}`;
const LINK = 'https://storage.invalid/export.dump?X-Goog-Signature=PRIVATE-LINK-0123456789';
const KEY = 'PRIVATE-ACCESS-KEY-0123456789';
const values = { DUMP_URL: LINK, RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY: KEY };
const job: TransferJob = { purpose: 'database', image: 'postgres:18-alpine', script: 'true', env: { PGTZ: 'UTC' }, sourceSecrets: values,
  secretRefs: { DATABASE_URL: { secretId: 'hv-target-database-url', version: '3' } }, timeoutSeconds: 600 };

type End = 'succeeds' | 'refuses' | 'fails';
/** Where the connection to Google is lost for good, as when the machine running Hypervibe dies there. */
type Death = 'the answer to creating the job is lost' | 'after the secrets are written' | 'as the job is created' | 'after the job is created' | 'as the run is requested' | undefined;

function cloud(end: End, death?: Death) {
  const secrets = fakeSecretManager(project);
  const journal: (TransferResources | null)[] = [];
  /** Everything sent anywhere but Secret Manager: the job definition, the run request, log queries. */
  const elsewhere: string[] = [];
  let down = false;
  let jobId = '';
  let labels: Record<string, string> = {};
  let present = false;
  let executions = 0;
  let body: any;
  const refusal = { ok: false, error: 'The source and target reach the same database; no data was replaced.' };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    if (down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const answered = await secrets.answer(url, init);
    if (answered) {
      if (death === 'after the secrets are written' && url.pathname.endsWith(':addVersion') && secrets.state.sent.length === Object.keys(values).length) down = true;
      return answered;
    }
    elsewhere.push(`${init.method ?? 'GET'} ${url.href} ${String(init.body ?? '')}`);
    const route = url.pathname.replace(/^\/v2\//, '');
    const method = init.method ?? 'GET';
    const name = `${parent}/jobs/${jobId}`;
    // A job that never ran is reported with an empty latestCreatedExecution.
    const native = { name, uid: 'uid-1', etag: 'tag', labels, ...(executions ? { executionCount: executions, latestCreatedExecution: { name: `${name}/executions/e1` } } : { latestCreatedExecution: {} }) };
    if (url.hostname === 'logging.googleapis.com') {
      return Response.json({ entries: String(init.body).includes('HV_RESTORE_ERROR') ? [] : [{ textPayload: `HV_TRANSFER_RESULT ${JSON.stringify(end === 'refuses' ? refusal : { ok: true })}` }] });
    }
    if (route === `${parent}/jobs` && method === 'POST') {
      jobId = url.searchParams.get('jobId')!;
      body = JSON.parse(String(init.body));
      labels = body.labels;
      present = true;
      if (death === 'as the job is created') { down = true; throw new TypeError('fetch failed'); }
      // Google goes on creating the job; it is not there to be seen yet.
      if (death === 'the answer to creating the job is lost') { present = false; throw new TypeError('fetch failed'); }
      return Response.json({ name: `${parent}/operations/create`, done: true, response: { ...native, name: `${parent}/jobs/${jobId}` } });
    }
    if (method === 'GET' && route === name) return present ? Response.json(native) : Response.json({}, { status: 404 });
    if (method === 'GET' && route.startsWith(`${parent}/jobs/`) && !route.includes('/executions')) return Response.json({}, { status: 404 });
    if (method === 'GET' && route === `${name}/executions`) {
      return Response.json({ executions: executions ? [{ name: `${name}/executions/e1`, uid: 'e-uid', job: name, completionTime: '2026-11-26T12:00:00Z' }] : [] });
    }
    if (method === 'POST' && route === `${name}:run`) {
      // Google answers with an error and starts nothing.
      if (death === 'as the run is requested') return Response.json({}, { status: 503 });
      executions = 1;
      return end === 'fails'
        ? Response.json({ name: `${parent}/operations/run`, done: true, error: { code: 13, message: 'Execution failed' }, metadata: { name: `${name}/executions/e1` } })
        : Response.json({ name: `${parent}/operations/run`, done: true, response: { name: `${name}/executions/e1`, succeededCount: 1, completionTime: '2026-11-26T12:00:00Z' } });
    }
    if (method === 'DELETE' && route === name) return Response.json({ name: `${parent}/operations/delete` });
    if (route === `${parent}/operations/delete`) { present = false; return Response.json({ name: route, done: true, response: native }); }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  }));
  const context = { token: async () => 'synthetic-token', gcpProjectId: project, region, runtimeServiceAccountEmail: `runtime@${project}.iam.gserviceaccount.com`, environmentLabel: 'env-1',
    recordTransferResources: (resources: TransferResources | null) => {
      if (down) throw new Error('The process is gone.');
      journal.push(resources);
      if (death === 'after the job is created' && resources?.jobUid) down = true;
    } };
  const settle = async <T>(pending: Promise<T>) => { await vi.runAllTimersAsync(); return pending; };
  const run = () => settle(runTransferJob<{ ok: boolean; error?: string }>(context, job).catch((error: Error) => ({ ok: false, thrown: error.message })));
  return {
    secrets, journal, elsewhere, context, run, settle, refusal,
    body: () => body,
    jobPresent: () => present,
    appear: () => { present = true; },
    restore: () => { down = false; },
    pending: () => journal.at(-1),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('private source values on their way to a copy job', () => {
  it('are stored one secret each before the job exists, mounted at one pinned version, and deleted with the job', async () => {
    const provider = cloud('succeeds');
    const result = await provider.run();
    expect(result).toEqual({ ok: true });
    const first = provider.journal[0]!;
    // Journalled before anything was written, under this job's own name and mark.
    expect(first.secretIds).toEqual([`${first.jobId}-dump-url`, `${first.jobId}-rclone-config-src-secret-access-key`]);
    expect(provider.secrets.state.sent).toEqual([LINK, KEY]);
    // The job definition carries references only: the target's own secret as given, and each temporary one at the version just written.
    expect(provider.body().template.template.containers[0].env).toEqual([
      { name: 'PGTZ', value: 'UTC' },
      { name: 'DATABASE_URL', valueSource: { secretKeyRef: { secret: 'hv-target-database-url', version: '3' } } },
      { name: 'DUMP_URL', valueSource: { secretKeyRef: { secret: first.secretIds[0], version: '1' } } },
      { name: 'RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY', valueSource: { secretKeyRef: { secret: first.secretIds[1], version: '1' } } },
    ]);
    expect(provider.secrets.state.secrets.size).toBe(0);
    expect(provider.jobPresent()).toBe(false);
    expect(provider.pending()).toBeNull();
  });

  it('carry this transfer\'s mark and an expiry of their own, so Secret Manager removes them even if Hypervibe never returns', async () => {
    const provider = cloud('succeeds', 'after the secrets are written');
    await provider.run();
    const journal = provider.pending()!;
    for (const id of journal.secretIds) {
      expect(provider.secrets.state.secrets.get(id)).toMatchObject({ ttl: '4200s', labels: { 'managed-by': 'hypervibe', 'hv-temporary': 'true', 'hv-transfer': journal.ownershipToken } });
    }
  });

  it.each(['succeeds', 'refuses', 'fails'] as const)('never appear in a result, an error, the job definition, a request to Cloud Run or a log query when the job %s', async (end) => {
    const provider = cloud(end);
    const result = await provider.run();
    if (end === 'refuses') expect(result).toEqual(provider.refusal);
    if (end === 'fails') expect(result).toEqual({ ok: false, thrown: 'The transfer execution failed.' });
    const everything = JSON.stringify([result, provider.journal, provider.elsewhere]);
    expect(everything).not.toContain('PRIVATE-');
    expect(everything).not.toContain(Buffer.from(KEY).toString('base64'));
    // Gone after a success, after a refusal and after a failed execution alike.
    expect(provider.secrets.state.secrets.size).toBe(0);
    expect(provider.jobPresent()).toBe(false);
    expect(provider.pending()).toBeNull();
  });

  it('are not written when nothing can record them first', async () => {
    const provider = cloud('succeeds');
    const { recordTransferResources: _unused, ...unrecorded } = provider.context;
    expect(await provider.settle(runTransferJob(unrecorded, job))).toEqual({ ok: false, error: 'This copy has nowhere to record its temporary secret, so it was not started.' });
    expect(provider.secrets.state.sent).toEqual([]);
  });
});

describe('a copy that died with its temporary secrets still there', () => {
  it.each(['appears', 'never appears'] as const)('keeps its record while the job may still be created, so a job that %s is not stranded', async (later) => {
    const provider = cloud('succeeds', 'the answer to creating the job is lost');
    const result = await provider.run();
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/is not known yet\. Run the copy again in 10 minutes/) });
    const journal = provider.pending()!;
    expect(journal.jobUid).toBeUndefined();
    expect(provider.secrets.state.secrets.size).toBe(2);
    // Too early to tell: nothing is deleted and the record stays.
    expect(await provider.settle(recoverTerminalTransferResources(provider.context, journal))).toBe(false);
    expect(provider.secrets.state.secrets.size).toBe(2);
    if (later === 'appears') provider.appear();
    else vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await provider.settle(recoverTerminalTransferResources(provider.context, journal))).toBe(true);
    expect(provider.secrets.state.secrets.size).toBe(0);
    expect(provider.jobPresent()).toBe(false);
  });

  it('is not blocked for good when the run was requested and nothing ever started', async () => {
    const provider = cloud('succeeds', 'as the run is requested');
    const result = await provider.run();
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/unverified/) });
    const journal = provider.pending()!;
    expect(provider.jobPresent()).toBe(true);
    expect(provider.secrets.state.secrets.size).toBe(2);
    expect(await provider.settle(recoverTerminalTransferResources(provider.context, journal))).toBe(false);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await provider.settle(recoverTerminalTransferResources(provider.context, journal))).toBe(true);
    expect(provider.secrets.state.secrets.size).toBe(0);
    expect(provider.jobPresent()).toBe(false);
  });

  it.each(['after the secrets are written', 'as the job is created', 'after the job is created'] as const)('is cleaned up by the next run: %s', async (death) => {
    const provider = cloud('succeeds', death);
    const died = await provider.run();
    expect(died.ok).toBe(false);
    expect(JSON.stringify(died)).not.toContain('PRIVATE-');
    const journal = provider.pending()!;
    expect(journal.secretIds).toHaveLength(2);
    expect(provider.secrets.state.secrets.size).toBe(2);
    expect(provider.jobPresent()).toBe(death !== 'after the secrets are written');
    if (death === 'after the job is created') expect(journal.jobUid).toBe('uid-1');
    else expect(journal.jobUid).toBeUndefined();

    provider.restore();
    // What hv_migrate does with a recorded transfer before starting another: look, then finish the cleanup.
    expect(await verifyTransferResourcesAbsent(provider.context, journal)).toBe(false);
    // A job being created may still appear, and a run being started may still start: neither is decided for ten minutes.
    // A job that is there and was never recorded was never asked to run, and goes at once.
    const atOnce = death === 'as the job is created';
    expect(transferSettleMinutes(journal)).toBe(10);
    expect(await provider.settle(recoverTerminalTransferResources(provider.context, journal))).toBe(atOnce);
    if (!atOnce) {
      expect(provider.secrets.state.secrets.size).toBe(2);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(transferSettleMinutes(journal)).toBe(0);
      expect(await provider.settle(recoverTerminalTransferResources(provider.context, journal))).toBe(true);
    }
    expect(provider.secrets.state.secrets.size).toBe(0);
    expect(provider.jobPresent()).toBe(false);
    expect(await verifyTransferResourcesAbsent(provider.context, journal)).toBe(true);
  });

  it('leaves alone a secret of the recorded name that does not carry this transfer\'s mark, and stays unfinished', async () => {
    const provider = cloud('succeeds', 'after the secrets are written');
    await provider.run();
    const journal = provider.pending()!;
    provider.restore();
    provider.secrets.state.secrets.get(journal.secretIds[0]!)!.labels['hv-transfer'] = 'someone-else';
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await provider.settle(recoverTerminalTransferResources(provider.context, journal))).toBe(false);
    expect([...provider.secrets.state.secrets.keys()]).toEqual([journal.secretIds[0]]);
  });

  it('is recorded in the migration target\'s own journal through each step, which refuses anything but those steps', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'hv-handoff-lease-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
    const lease = acquireMigrationTargetLease('project-1', 'target')!;
    try {
      const written: TransferResources = { gcpProjectId: project, region, jobId: 'hv-migrate-database-0123456789abcdef', secretIds: ['hv-migrate-database-0123456789abcdef-dump-url'], ownershipToken: 'token' };
      lease.record({ ...written, recordedAt: 1 });
      lease.record({ ...written, jobUid: 'uid-1', recordedAt: 2 });
      expect(lease.pending()).toEqual({ ...written, jobUid: 'uid-1', recordedAt: 2 });
      // No other job or secret takes this record's place.
      expect(() => lease.record({ ...written, jobUid: 'uid-2', recordedAt: 3 })).toThrow(/outstanding cleanup/);
      expect(() => lease.record({ ...written, secretIds: [], jobUid: 'uid-1', recordedAt: 3 })).toThrow(/outstanding cleanup/);
    } finally {
      lease.close();
      SqliteAdapter.resetInstance();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
