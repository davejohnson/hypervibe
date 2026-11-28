import { expect, it, vi } from 'vitest';
import { pollRuntime } from '../../application/runtime-observation-poll.js';
import { replayHostedReports, type Report } from '../hosted-observations.js';
import { hostedReplayLimit, pendingHostedReports, restoreObservationCursor, type HostedProgress, type MonitorScope, type ObserverCursor } from '../observation-history.js';

const origin = Date.parse('2026-11-26T10:00:00Z');
const audience = 'https://hypervibe.dev/api/v1/runtime-observations';
const sha = 'a'.repeat(40);
const scopeFor = (id: number): MonitorScope => ({ repository: 'owner/invoices', repositoryId: '42', environment: 'prod', provider: 'aws', branch: 'main', runId: String(id) });
const githubFor = (id: number) => ({ repository: 'owner/invoices', ref: 'refs/heads/main', sha, runId: String(id), runAttempt: '1', eventName: 'schedule',
  requestUrl: 'https://pipelines.actions.githubusercontent.com/token', requestToken: 'fixture' });
const nowFor = (index: number) => new Date(origin + index * 5 * 60_000);
function reportFor(entries: number): Report {
  const at = nowFor(0).toISOString();
  return { version: 1, environment: 'prod', provider: 'aws', window: { since: at, until: at }, sources: [],
    observations: Array.from({ length: entries }, (_, i) => ({ kind: 'log', service: 'web', at, id: String(i), severity: 'ERROR', message: 'error ' + i })) };
}

function historyFixture() {
  const snapshots = new Map<number, Map<string, unknown>>();
  function save(id: number, filename: string, value: unknown) {
    if (!snapshots.has(id)) snapshots.set(id, new Map());
    snapshots.get(id)!.set(filename, value);
  }
  const names = ['next-cursor.json', 'prod.json', 'hosted-receipt.json'];
  const artifacts = ['hypervibe-runtime-cursor', 'hypervibe-runtime-observation', 'hypervibe-hosted-delivery'];
  const run = (id: number) => ({ id, name: 'observe', created_at: '', updated_at: '', html_url: '', path: '.github/workflows/hypervibe-observe-prod.yml',
    status: 'completed', conclusion: 'success', head_sha: sha, head_branch: 'main', event: 'schedule', run_attempt: 1,
    repository: { full_name: 'owner/invoices', id: 42 }, head_repository: { full_name: 'owner/invoices', id: 42 } });
  const ids = () => [...snapshots.keys()].sort((a, b) => b - a);
  const api = {
    listWorkflowRuns: vi.fn(async () => ({ total_count: snapshots.size, workflow_runs: ids().map(run) })),
    getWorkflowRun: vi.fn(async (_owner: string, _repo: string, id: number) => run(id)),
    listWorkflowRunArtifacts: vi.fn(async (_owner: string, _repo: string, id: string | number) => {
      const files = [...snapshots.get(Number(id))!.keys()];
      return { total_count: files.length, artifacts: files.map(file => ({ id: Number(id) * 10 + names.indexOf(file), name: artifacts[names.indexOf(file)],
        created_at: '', updated_at: '', expired: false, workflow_run: { id: Number(id), repository_id: 42, head_repository_id: 42, head_branch: 'main', head_sha: sha } })) };
    }),
    readJsonArtifact: vi.fn(async (_owner: string, _repo: string, artifact: number, filename: string) => {
      if (names[artifact % 10] !== filename) throw new Error('Unexpected filename.');
      return snapshots.get(Math.floor(artifact / 10))!.get(filename);
    }),
  };
  const saveReceipt = (id: number, progress: HostedProgress) => save(id, 'hosted-receipt.json', {
    version: 1, environment: 'prod', provider: 'aws', repositoryId: '42', ...progress,
  });
  const cursor: ObserverCursor = { version: 1, environment: 'prod', repositoryId: '42', provider: 'aws', logs: nowFor(0).toISOString(),
    jobs: nowFor(0).toISOString(), schedules: {}, starts: {}, hostedReview: true };
  return { api, save, saveReceipt, cursor };
}

function transport(runId: number, post: (events: Array<{ kind: string; message: string; id: string }>) => Response): typeof fetch {
  const github = githubFor(runId);
  const claims = { ...github, iss: 'https://token.actions.githubusercontent.com', aud: audience, exp: 2e10,
    workflow_ref: github.repository + '/.github/workflows/hypervibe-observe-prod.yml@' + github.ref,
    runner_environment: 'github-hosted', event_name: 'schedule', run_id: String(runId), run_attempt: '1' };
  return async (url, init) => {
    if (String(url).startsWith(github.requestUrl)) return Response.json({ value: 'test.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.test' });
    expect(url).toBe(audience);
    return post(JSON.parse(String(init?.body)).events);
  };
}

it('keeps cloud and cron history across refused hosted deliveries, then replays missed evidence', async () => {
  const { api, save, saveReceipt } = historyFixture();
  const missed: string[] = [];
  for (let i = 0; i < 6; i++) {
    const runId = 100 + i;
    const now = nowFor(i);
    const scope = scopeFor(runId);
    const previous = (await restoreObservationCursor(api, scope, now)).cursor;
    if (i) expect(previous?.jobs).toBe(nowFor(i - 1).toISOString());
    const { report, cursor } = await pollRuntime({ now, previous, repositoryId: '42',
      binding: { provider: 'aws', environmentName: 'prod', services: { nightly: { region: 'us-west-2', workloadKind: 'cron', serviceId: 'job' } } },
      schedules: { nightly: { cronSchedule: '*/5 * * * *' } },
      read: async (window, opts) => ({ ...reportFor(0), window, sources: [{ kind: opts.sources![0], status: 'ok' }],
        observations: opts.sources![0] === 'logs' ? [{ kind: 'log', at: now.toISOString(), severity: 'ERROR', service: 'web', message: 'error ' + i }] : [] }),
    });
    save(runId, 'next-cursor.json', { ...cursor, hostedReview: true });
    save(runId, 'prod.json', report);
    if (i === 4) expect(report.observations).toContainEqual(expect.objectContaining({ check: 'scheduled execution', service: 'nightly' }));
    const result = replayHostedReports({ api, scope, github: githubFor(runId), report, now, warn: vi.fn(),
      acknowledge: async progress => saveReceipt(runId, progress),
      request: transport(runId, events => {
        if (i < 5) return new Response(null, { status: 503 });
        for (const e of events) if (e.kind === 'missed') missed.push(e.id);
        return Response.json({ applied: events.length, skipped: 0 });
      }),
    });
    if (i < 5) await expect(result).rejects.toThrow('did not accept');
    else expect(await result).toBeGreaterThan(5);
  }
  expect(missed.length).toBeGreaterThan(0);
});

it('restarts at the last acknowledged batch and stops after the receipt for a fully delivered run', async () => {
  const { api, save, saveReceipt, cursor } = historyFixture();
  const first = reportFor(25);
  for (const [id, report] of [[100, first], [101, reportFor(0)]] as const) {
    save(id, 'prod.json', report); save(id, 'next-cursor.json', cursor);
  }
  const saved = vi.fn(async (progress: HostedProgress) => saveReceipt(100, progress));
  await expect(replayHostedReports({ api, scope: scopeFor(100), github: githubFor(100), now: nowFor(0), warn: vi.fn(), report: first, acknowledge: saved,
    request: transport(100, events => events.length === 24 ? Response.json({ applied: 24, skipped: 0 }) : new Response(null, { status: 503 })) })).rejects.toThrow('did not accept');
  expect(saved.mock.calls).toEqual([[{ runId: 100, offset: 24, complete: false }]]);
  const afterRecovery: string[] = [];
  const count = await replayHostedReports({ api, scope: scopeFor(101), github: githubFor(101), now: nowFor(1), report: reportFor(0), warn: vi.fn(),
    acknowledge: async progress => saveReceipt(101, progress), request: transport(101, events => {
      afterRecovery.push(...events.map(e => e.message));
      return Response.json({ applied: 0, skipped: events.length });
    }) });
  expect(count).toBe(1);
  expect(afterRecovery).toEqual(['error 24']);
  expect(await pendingHostedReports(api, scopeFor(102), nowFor(2), vi.fn())).toEqual([]);
});

it('warns about backlog beyond the retry bound and stops at an opted-out collection', async () => {
  const { api, save, cursor } = historyFixture();
  for (let i = 1; i <= hostedReplayLimit + 1; i++) {
    save(i, 'prod.json', reportFor(0)); save(i, 'next-cursor.json', cursor);
  }
  const warn = vi.fn();
  const pending = await pendingHostedReports(api, scopeFor(100), nowFor(0), warn);
  expect(pending.map(p => p.runId)).toEqual(Array.from({ length: hostedReplayLimit }, (_, i) => 2 + i));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside the retry window'));
  save(hostedReplayLimit, 'next-cursor.json', { ...cursor, hostedReview: undefined });
  expect((await pendingHostedReports(api, scopeFor(100), nowFor(0), vi.fn())).map(p => p.runId)).toEqual([hostedReplayLimit + 1]);
});
