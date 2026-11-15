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
