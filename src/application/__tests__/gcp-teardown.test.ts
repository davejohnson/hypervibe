import { afterEach, describe, expect, it, vi } from 'vitest';
import { GCP_STORAGE_EMPTY_OPERATION, GCP_TEARDOWN_CLEANUP_OPERATION, emptyGcpBucket, finishGcpTeardown } from '../infrastructure-engine.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const action = (operation: string, metadata: Record<string, unknown>): PlanAction => ({ id: 'x', type: 'destroy', verified: true, resource: { kind: 'storage', name: 'x', provider: 'gcp' }, reason: '', metadata: { operation, gcpProjectId: 'demo', ...metadata } });
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

describe('emptying a Google bucket before it is removed', () => {
  const empty = action(GCP_STORAGE_EMPTY_OPERATION, { bucket: 'hv-1-test-files', environmentLabel: 'env-1' });
  const own = { labels: { 'managed-by': 'hypervibe', 'hv-environment': 'env-1' } };
  // Google's list answer (`items` with `name` and `generation`) and its 204 on delete, per the Cloud Storage JSON API.
  function bucket(objects: Array<{ name: string; generation: string }>, options: { labels?: unknown; deleteStatus?: number } = {}) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'; calls.push(`${method} ${new URL(url).pathname}${new URL(url).searchParams.get('generation') ? `#${new URL(url).searchParams.get('generation')}` : ''}`);
      if (method === 'DELETE') {
        if (options.deleteStatus) return json(options.deleteStatus);
        const name = decodeURIComponent(new URL(url).pathname.split('/o/')[1]!);
        const index = objects.findIndex((entry) => entry.name === name && entry.generation === new URL(url).searchParams.get('generation'));
        if (index >= 0) objects.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      if (new URL(url).pathname.endsWith('/o')) {
        if (new URL(url).searchParams.get('versions') !== 'true') throw new Error('Older versions must be listed too.');
        return json(200, { items: objects.slice(0, 2) });
      }
      return json(200, options.labels ?? own);
    }));
    return calls;
  }

  it('deletes every version of every file, page after page, and nothing else', async () => {
    const objects = [{ name: 'a.txt', generation: '1' }, { name: 'a.txt', generation: '2' }, { name: 'dir/b c.txt', generation: '7' }];
    const calls = bucket(objects);
    expect(await emptyGcpBucket('token', empty)).toMatchObject({ success: true, message: expect.stringContaining('3 file version') });
    expect(objects).toEqual([]);
    expect(calls.filter((call) => call.startsWith('DELETE'))).toEqual(['DELETE /storage/v1/b/hv-1-test-files/o/a.txt#1', 'DELETE /storage/v1/b/hv-1-test-files/o/a.txt#2', 'DELETE /storage/v1/b/hv-1-test-files/o/dir%2Fb%20c.txt#7']);
  });

  it('deletes nothing from a bucket that is not labelled as this environment\'s, or that cannot be read', async () => {
    let calls = bucket([{ name: 'a.txt', generation: '1' }], { labels: { labels: { 'managed-by': 'hypervibe', 'hv-environment': 'other' } } });
    expect(await emptyGcpBucket('token', empty)).toMatchObject({ success: false, status: 'blocked' });
    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json(403)));
    expect(await emptyGcpBucket('token', empty)).toMatchObject({ success: false, status: 'blocked', message: expect.stringContaining('HTTP 403') });
    vi.stubGlobal('fetch', vi.fn(async () => json(404)));
    expect(await emptyGcpBucket('token', empty)).toMatchObject({ success: true });
    calls = bucket([{ name: 'a.txt', generation: '1' }], { deleteStatus: 403 });
    expect(await emptyGcpBucket('token', empty)).toMatchObject({ success: false, message: expect.stringContaining('HTTP 403') });
  });

  it('does not report success when the answer to a delete is lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new Error('socket closed');
      return new URL(url).pathname.endsWith('/o') ? json(200, { items: [{ name: 'a.txt', generation: '1' }] }) : json(200, own);
    }));
    await expect(emptyGcpBucket('token', empty)).rejects.toThrow('socket closed');
  });
});

describe('the last Google teardown step', () => {
  const environment = { id: 'env-1', name: 'test', platformBindings: { provider: 'cloudrun', projectId: 'demo', services: { web: { serviceId: 'web-1' } }, engine: { kind: 'opentofu', storage: ['files'] } } };
  const updates: Array<Record<string, unknown>> = [];
  const ctx = { repos: { environments: { findById: () => environment, updatePlatformBindings: (_id: string, value: Record<string, unknown>) => { updates.push(value); } } } } as never;
  const spec = projectSpecSchema.parse({ version: 1, project: 'demo', environments: { test: { hosting: { provider: 'cloudrun' }, services: { web: {} } }, other: { hosting: { provider: 'cloudrun' }, services: { web: {} } } } });
  const cleanup = action(GCP_TEARDOWN_CLEANUP_OPERATION, { workloads: [{ name: 'web', kind: 'services', resource: 'web-1' }], instanceName: 'hv-test-db-aaaaaa', buckets: ['hv-1-test-files'], cacheInstanceName: 'hv-test-cache-bbbbbb', topics: ['hv-test-jobs'] });
  const run = () => finishGcpTeardown(ctx, 'token', { gcpProjectId: 'demo', region: 'us-central1', environment } as never, { project: { id: 'p', name: 'demo' } as never, spec }, 'test', cleanup);
  const answers = (statusFor: (url: string) => number, secrets: string[] = []) => vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url.includes('/secrets?') ? json(200, { secrets: secrets.map((name) => ({ name: `projects/demo/secrets/${name}` })) }) : json(statusFor(url))));

  it('removes the environment from the spec only when Google confirms every piece is gone', async () => {
    updates.length = 0;
    const merge = vi.spyOn(SpecStore.prototype, 'merge').mockReturnValue(undefined as never);
    answers(() => 404);
    expect(await run()).toMatchObject({ success: true });
    expect(merge).toHaveBeenCalledWith(expect.anything(), { environments: { test: null } });
    expect(updates).toEqual([expect.objectContaining({ provider: 'cloudrun', services: {}, engine: {}, gcp: { tornDownAt: expect.any(String) } })]);
  });

  it.each([
    ['the database', (url: string) => url.includes('sqladmin') ? 200 : 404, [] as string[], 'hv-test-db-aaaaaa'],
    ['a bucket', (url: string) => url.includes('storage.googleapis.com') ? 200 : 404, [], 'hv-1-test-files'],
    ['a service', (url: string) => url.includes('run.googleapis.com') ? 200 : 404, [], 'web-1'],
    ['the cache', (url: string) => url.includes('redis.googleapis.com') ? 200 : 404, [], 'hv-test-cache-bbbbbb'],
    ['a queue', (url: string) => url.includes('pubsub.googleapis.com') ? 200 : 404, [], 'hv-test-jobs'],
    ['a secret', () => 404, ['hv-test-api-key'], 'hv-test-api-key'],
  ])('keeps the environment in the spec while %s still exists', async (_what, statusFor, secrets, named) => {
    updates.length = 0;
    const merge = vi.spyOn(SpecStore.prototype, 'merge').mockReturnValue(undefined as never);
    answers(statusFor, secrets);
    expect(await run()).toMatchObject({ success: false, message: expect.stringContaining(named) });
    expect(merge).not.toHaveBeenCalled(); expect(updates).toEqual([]);
  });

  it('treats an unreadable answer as unknown, never as gone', async () => {
    updates.length = 0;
    const merge = vi.spyOn(SpecStore.prototype, 'merge').mockReturnValue(undefined as never);
    for (const unreadable of ['sqladmin', 'storage.googleapis.com', 'run.googleapis.com', 'redis.googleapis.com', 'pubsub.googleapis.com', '/secrets?']) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes(unreadable) ? json(403) : url.includes('/secrets?') ? json(200, { secrets: [] }) : json(404)));
      expect(await run()).toMatchObject({ success: false, status: 'blocked' });
    }
    expect(merge).not.toHaveBeenCalled(); expect(updates).toEqual([]);
  });
});
