import { describe, expect, it } from 'vitest';
import { RELEASE_SCRIPT } from '../gcp-ci-release-script.js';

// #548: the generated release program runs in CI with no memory of earlier attempts.
// Re-running the workflow must wait on a migration that is still going, not start a second one.
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
const image = 'registry/web@sha256:1';
const executionName = 'projects/p/locations/r/jobs/release/executions/e1';

async function runJob(options: { executions: unknown[] | 503; final?: Record<string, unknown> }) {
  const calls: string[] = [];
  const job = { template: { template: { containers: [{ image: 'old' }] } } };
  class Exit extends Error {}
  const fetchStub = async (raw: string | URL, init: { method?: string; body?: string } = {}) => {
    const url = String(raw);
    if (url.endsWith(':run')) { calls.push('run'); return Response.json({ name: 'operations/op', done: true, response: { succeededCount: 1 } }); }
    if (url.includes('/executions?')) { calls.push('list'); return options.executions === 503 ? new Response('no', { status: 503 }) : Response.json({ executions: options.executions }); }
    if (url.endsWith(executionName)) { calls.push('get-execution'); return Response.json({ name: executionName, ...options.final }); }
    if (init.method === 'PATCH') { job.template.template.containers[0]!.image = JSON.parse(init.body!).template.template.containers[0].image; return Response.json({ done: true }); }
    return Response.json(job);
  };
  const processStub = { argv: ['node', 'release.mjs', 'release', image, '', 'jobs'], env: { GCP_TOKEN: 't', GCP_PROJECT: 'p', GCP_REGION: 'r', HYPERVIBE_RUN_JOB: '1', HYPERVIBE_POLL_MS: '1' }, exit: () => { throw new Exit(); } };
  const outcome = await new AsyncFunction('process', 'fetch', 'console', RELEASE_SCRIPT)(processStub, fetchStub, { log: () => undefined }).then(() => 'ok', (error: Error) => error instanceof Exit ? 'ok' : error.message);
  return { calls, outcome };
}

describe('generated Google release program: release command', () => {
  it('starts the command when no run of this image is going', async () => {
    const done = { name: 'x', completionTime: '2026-11-17T09:00:00Z', succeededCount: 1, template: { containers: [{ image }] } };
    expect(await runJob({ executions: [done] })).toEqual({ calls: ['list', 'run'], outcome: 'ok' });
  });
  it('waits on a run of this image that is still going instead of starting another', async () => {
    const going = { name: executionName, template: { containers: [{ image }] } };
    expect(await runJob({ executions: [going], final: { completionTime: '2026-11-17T10:00:00Z', succeededCount: 1 } })).toEqual({ calls: ['list', 'get-execution'], outcome: 'ok' });
    const failed = await runJob({ executions: [going], final: { completionTime: '2026-11-17T10:00:00Z', failedCount: 1 } });
    expect(failed.calls).not.toContain('run'); expect(failed.outcome).toMatch(/release command failed/);
  });
  it('starts nothing when earlier runs cannot be read', async () => {
    const result = await runJob({ executions: 503 });
    expect(result.calls).toEqual(['list']); expect(result.outcome).toMatch(/nothing was started/);
  });
});
