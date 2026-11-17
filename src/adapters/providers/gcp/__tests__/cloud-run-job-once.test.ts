import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCloudRunJobOnce, type PendingJobRun } from '../gcp-cloud-run.client.js';

// #548: a release command (migrations) must not run twice because Hypervibe lost
// track of a run it started. Cloud Run's contract: jobs.run returns an operation
// whose metadata is the Execution; an Execution has completionTime once it ends.
const target = { gcpProjectId: 'demo', region: 'us-central1' };
const image = 'us-central1-docker.pkg.dev/demo/hypervibe/web@sha256:' + 'a'.repeat(64);
const executionName = 'projects/demo/locations/us-central1/jobs/release/executions/release-abc';
const opts = { pollMs: 1, deadlineMs: 200, now: () => Date.parse('2026-11-17T10:00:00Z') };

function cloud(handlers: { run?: () => Response | Promise<Response>; execution?: () => unknown; list?: () => unknown; operation?: () => unknown }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (raw: string | URL, init: { method?: string } = {}) => {
    const url = String(raw);
    if (url.endsWith(':run')) { calls.push('run'); if (!handlers.run) throw new Error('unexpected start'); return handlers.run(); }
    if (url.endsWith(executionName)) { calls.push('get-execution'); return Response.json(handlers.execution!()); }
    if (url.includes('/executions')) { calls.push('list'); return Response.json(handlers.list ? handlers.list() : { executions: [] }); }
    if (url.includes('/operations/')) { calls.push('operation'); return Response.json(handlers.operation!()); }
    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  }));
  return calls;
}
function memory(initial?: PendingJobRun) {
  let saved = initial; const history: Array<PendingJobRun | undefined> = [];
  return { get: () => saved, save: (next: PendingJobRun | undefined) => { saved = next; history.push(next); }, history };
}
const run = (store: ReturnType<typeof memory>) => runCloudRunJobOnce(async () => 't', target, 'release', image, store.get(), store.save, opts);

afterEach(() => vi.unstubAllGlobals());

describe('release command runs once', () => {
  it('records the run before starting it and clears the record when it succeeds', async () => {
    const store = memory();
    const calls = cloud({ run: () => Response.json({ name: 'projects/demo/locations/us-central1/operations/op1', done: true, metadata: { name: executionName }, response: { succeededCount: 1 } }) });
    expect(await run(store)).toMatchObject({ status: 'released' });
    expect(calls).toEqual(['run']);
    expect(store.history[0]).toMatchObject({ image, startedAt: '2026-11-17T10:00:00.000Z' });
    expect(store.get()).toBeUndefined();
  });

  it('keeps the record when the start response is lost, then waits on that run instead of starting another', async () => {
    const store = memory();
    cloud({ run: () => { throw new Error('socket hang up'); } });
    expect(await run(store)).toMatchObject({ status: 'unknown' });
    expect(store.get()).toMatchObject({ image });

    // Retry: Cloud Run did accept the first request and that execution is still going, then finishes.
    let reads = 0;
    const calls = cloud({
      list: () => ({ executions: [{ name: executionName, createTime: '2026-11-17T10:00:01Z', template: { containers: [{ image }] } }] }),
      execution: () => (++reads < 2 ? { name: executionName } : { name: executionName, completionTime: '2026-11-17T10:03:00Z', succeededCount: 1 }),
    });
    expect(await run(store)).toMatchObject({ status: 'released' });
    expect(calls).not.toContain('run');
    expect(store.get()).toBeUndefined();
  });

  it('does not run again when the unobserved run already succeeded', async () => {
    const store = memory({ image, startedAt: '2026-11-17T09:50:00.000Z', execution: executionName });
    const calls = cloud({ execution: () => ({ name: executionName, completionTime: '2026-11-17T09:52:00Z', succeededCount: 1 }) });
    expect(await run(store)).toMatchObject({ status: 'released', message: expect.stringMatching(/already finished/i) });
    expect(calls).toEqual(['get-execution']);
    expect(store.get()).toBeUndefined();
  });

  it('starts a fresh run after the recorded one failed', async () => {
    const store = memory({ image, startedAt: '2026-11-17T09:50:00.000Z', execution: executionName });
    const calls = cloud({
      execution: () => ({ name: executionName, completionTime: '2026-11-17T09:52:00Z', failedCount: 1 }),
      run: () => Response.json({ name: 'projects/demo/locations/us-central1/operations/op2', done: true, metadata: { name: executionName }, response: { succeededCount: 1 } }),
    });
    expect(await run(store)).toMatchObject({ status: 'released' });
    expect(calls).toEqual(['get-execution', 'run']);
  });

  it('starts nothing when it cannot read the recorded run', async () => {
    const store = memory({ image, startedAt: '2026-11-17T09:50:00.000Z', execution: executionName });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 503 })));
    expect(await run(store)).toMatchObject({ status: 'unknown' });
    expect(store.get()).toMatchObject({ execution: executionName });
  });

  it('starts nothing while a just-recorded start is not yet visible in Cloud Run', async () => {
    const store = memory({ image, startedAt: '2026-11-17T09:59:30.000Z' });
    const calls = cloud({ list: () => ({ executions: [] }) });
    expect(await run(store)).toMatchObject({ status: 'unknown' });
    expect(calls).toEqual(['list']);
  });

  it('ignores a record for a different image', async () => {
    const store = memory({ image: 'other@sha256:' + 'b'.repeat(64), startedAt: '2026-11-17T09:00:00.000Z', execution: executionName });
    const calls = cloud({ run: () => Response.json({ name: 'projects/demo/locations/us-central1/operations/op3', done: true, response: { succeededCount: 1 } }) });
    expect(await run(store)).toMatchObject({ status: 'released' });
    expect(calls).toEqual(['run']);
  });

  it('still running at the deadline keeps the record so a retry waits instead of starting', async () => {
    const store = memory();
    cloud({ run: () => Response.json({ name: 'projects/demo/locations/us-central1/operations/op4', metadata: { name: executionName } }), operation: () => ({ name: 'projects/demo/locations/us-central1/operations/op4' }) });
    expect(await run(store)).toMatchObject({ status: 'unknown' });
    expect(store.get()).toMatchObject({ image, execution: executionName });
  });
});
