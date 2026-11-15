import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudRunGet, releaseImage } from '../gcp-cloud-run.client.js';

afterEach(() => { vi.unstubAllGlobals(); });

// Reconstructed public fields of Cloud Run Admin API v2 `projects.locations.services`
// get/patch and `projects.locations.jobs` get/patch; only fetch is replaced.
const target = { gcpProjectId: 'demo', region: 'us-central1' };
const serviceUrl = 'https://run.googleapis.com/v2/projects/demo/locations/us-central1/services/web';
const jobUrl = 'https://run.googleapis.com/v2/projects/demo/locations/us-central1/jobs/nightly';
const oldImage = 'registry/app@sha256:old';
const newImage = 'registry/app@sha256:new';

type Call = { url: string; method: string; body?: any };
function cloudRun(handler: (call: Call, calls: Call[]) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = { url: String(url), method: init.method ?? 'GET', ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    const { status, body } = handler(call, calls);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }));
  return calls;
}
const service = (image: string) => ({ etag: '"e1"', uri: 'https://web.example', latestReadyRevision: 'r2', latestCreatedRevision: 'r2',
  terminalCondition: { state: 'CONDITION_SUCCEEDED' }, template: { serviceAccount: 'runtime@demo', containers: [{ name: 'app', image, env: [{ name: 'A', value: '1' }] }] } });

// Contract (docs/opentofu-engine.md): a release changes only the running image and
// is guarded by the etag, so a concurrent infrastructure apply is never overwritten.
describe('Cloud Run image release', () => {
  it('keeps present, absent and unknown distinct when reading a workload', async () => {
    cloudRun(() => ({ status: 404 }));
    expect(await cloudRunGet('t', 'demo', 'us-central1', 'web')).toEqual({ state: 'absent' });
    cloudRun(() => ({ status: 503 }));
    expect(await cloudRunGet('t', 'demo', 'us-central1', 'web')).toEqual({ state: 'unknown', reason: 'Cloud Run returned HTTP 503 for web.' });
  });

  it('sends only the container list with the observed etag and reports the service URL', async () => {
    const calls = cloudRun((call, all) => call.method === 'PATCH' ? { status: 200, body: { name: 'operations/1', done: true } }
      : { status: 200, body: service(all.some((entry) => entry.method === 'PATCH') ? newImage : oldImage) });
    expect(await releaseImage('t', target, 'web', newImage)).toEqual({ status: 'released', message: 'Released registry/app to web.', url: 'https://web.example' });
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.url).toBe(`${serviceUrl}?updateMask=template.containers`);
    expect(patch.body).toEqual({ etag: '"e1"', template: { containers: [{ name: 'app', image: newImage, env: [{ name: 'A', value: '1' }] }] } });
  });

  it.each([409, 412])('overwrites nothing when the service changed concurrently (HTTP %s)', async (status) => {
    const calls = cloudRun((call) => call.method === 'PATCH' ? { status } : { status: 200, body: service(oldImage) });
    expect(await releaseImage('t', target, 'web', newImage)).toMatchObject({ status: 'failed', message: expect.stringContaining('Nothing was overwritten') });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('sets the declared start command with the image, and clears an old one when none is declared', async () => {
    const withCommand = (image: string) => { const value = service(image); (value.template.containers[0] as any).command = ['/old']; (value.template.containers[0] as any).args = ['x']; return value; };
    const release = async (start: { startCommand: string | undefined } | undefined) => {
      const calls = cloudRun((call, all) => call.method === 'PATCH' ? { status: 200, body: { name: 'operations/1', done: true } }
        : { status: 200, body: withCommand(all.some((entry) => entry.method === 'PATCH') ? newImage : oldImage) });
      await releaseImage('t', target, 'web', newImage, 'services', start);
      return calls.find((call) => call.method === 'PATCH')!.body.template.containers[0];
    };
    expect(await release({ startCommand: 'python scripts/worker.py' })).toMatchObject({ image: newImage, command: ['/bin/sh'], args: ['-lc', 'python scripts/worker.py'] });
    const cleared = await release({ startCommand: undefined });
    expect(cleared).not.toHaveProperty('command');
    expect(cleared).not.toHaveProperty('args');
    // Without a start instruction (older callers) the observed command is sent back untouched.
    expect(await release(undefined)).toMatchObject({ command: ['/old'], args: ['x'] });
  });

  it('never creates a missing service', async () => {
    const calls = cloudRun(() => ({ status: 404 }));
    expect(await releaseImage('t', target, 'web', newImage)).toMatchObject({ status: 'failed', message: expect.stringContaining('does not exist') });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('reports unknown, not released, when the service does not show the new image as ready', async () => {
    cloudRun((call) => call.method === 'PATCH' ? { status: 200, body: { name: 'operations/1', done: true } } : { status: 200, body: service(oldImage) });
    expect(await releaseImage('t', target, 'web', newImage)).toMatchObject({ status: 'unknown' });
  });

  it('updates a scheduled job by sending it back unchanged except for the image', async () => {
    const job = (image: string) => ({ etag: '"j1"', labels: { 'managed-by': 'hypervibe' }, template: { taskCount: 1, template: { timeout: '600s', containers: [{ image, command: ['npm', 'run', 'nightly'] }] } } });
    const calls = cloudRun((call, all) => call.method === 'PATCH' ? { status: 200, body: { name: 'operations/2', done: true } }
      : { status: 200, body: job(all.some((entry) => entry.method === 'PATCH') ? newImage : oldImage) });
    expect(await releaseImage('t', target, 'nightly', newImage, 'jobs')).toMatchObject({ status: 'released' });
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.url).toBe(jobUrl);
    expect(patch.body).toEqual(job(newImage));
  });
});
