import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { CloudflareAdapter } from '../cloudflare.adapter.js';

// Synthetic transport fixtures; request semantics are sourced from Cloudflare's
// Workers Request/fetch contracts. Execute the uploaded program as the boundary.
// https://developers.cloudflare.com/workers/runtime-apis/request/
// https://developers.cloudflare.com/workers/runtime-apis/fetch/
describe('Cloudflare retained maintenance route traffic handoff', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const hostname = 'app.example.com';
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'synthetic-token', accountId: 'account-1' });
    vi.spyOn(adapter, 'resolveLoadBalancerScope').mockResolvedValue({ accountId: 'account-1', zoneId: 'zone-1' });
    const binding = {
      hostname, accountId: 'account-1', zoneId: 'zone-1', routeId: 'route-1',
      scriptName: `hv-maintenance-${createHash('sha256').update(hostname).digest('hex').slice(0, 20)}`,
      contentHash: adapter.maintenanceContentHash(hostname),
    };
    let source = '';
    const routes = [{ id: binding.routeId, pattern: `${hostname}/*`, script: binding.scriptName }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/workers/routes') && !init?.method?.match(/PUT|POST|DELETE/)) {
        return Response.json({ success: true, result: routes });
      }
      if (url.includes('/workers/scripts/') && init?.method === 'PUT') {
        source = String(init.body);
        return new Response('');
      }
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { adapter, hostname, binding, routes, fetchMock, source: () => source };
  }

  it('replaces only the owned script and forwards requests to the reviewed HTTPS origin', async () => {
    const fixture = setup();
    const target = { origin: 'https://target-123.run.app', targetFingerprint: 'target-identity' };
    const result = await fixture.adapter.ensureTrafficEdge(fixture.hostname, target, fixture.binding);
    expect(result.success).toBe(true);
    expect(result.data?.binding).toMatchObject({ ...fixture.binding, ...target, contentHash: expect.any(String) });
    expect((result.data?.binding as { contentHash: string }).contentHash).not.toBe(fixture.binding.contentHash);
    expect(fixture.fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    let handler: (event: { request: Request; respondWith(value: Promise<Response>): void }) => void;
    const originFetch = vi.fn(async (_request: Request) => new Response('target', { status: 201 }));
    runInNewContext(fixture.source(), {
      addEventListener: (_kind: string, callback: typeof handler) => { handler = callback; },
      URL, Request, Response, Headers, fetch: originFetch,
    });
    const request = new Request(`https://${fixture.hostname}/save?a=1`, {
      method: 'POST', body: 'payload', headers: { Host: fixture.hostname, 'X-Forwarded-Host': 'spoofed.example' },
    });
    let response!: Promise<Response>;
    handler!({ request, respondWith: (value) => { response = value; } });
    expect((await response).status).toBe(201);
    const forwarded = originFetch.mock.calls[0]![0];
    expect(forwarded.url).toBe(`${target.origin}/save?a=1`);
    expect(forwarded.method).toBe('POST');
    expect(await forwarded.text()).toBe('payload');
    expect(forwarded.redirect).toBe('manual');
    expect(forwarded.headers.get('host')).toBe('target-123.run.app');
    expect(forwarded.headers.get('x-forwarded-host')).toBe(fixture.hostname);
    expect(forwarded.headers.get('x-forwarded-proto')).toBe('https');

    handler!({ request: new Request(`https://${fixture.hostname}/.well-known/hypervibe-traffic`), respondWith: (value) => { response = value; } });
    const marker = await response;
    expect(marker.status).toBe(204);
    expect(marker.headers.get('x-hypervibe-traffic')).toBe((result.data?.binding as { contentHash: string }).contentHash);
    expect(originFetch).toHaveBeenCalledOnce();

    originFetch.mockRejectedValueOnce(new Error('TLS failed'));
    handler!({ request: new Request(`https://${fixture.hostname}/`), respondWith: (value) => { response = value; } });
    expect((await response).status).toBe(503);
  });

  it.each(['http://target.example', 'https://user:pass@target.example', 'https://app.example.com', 'https://target.example/path'])('rejects unsafe origin %s before any mutation', async origin => {
    const fixture = setup();
    const result = await fixture.adapter.ensureTrafficEdge(fixture.hostname, { origin, targetFingerprint: 'target' }, fixture.binding);
    expect(result.success).toBe(false);
    expect(fixture.fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it('does not recreate a missing route or change a different scoped binding', async () => {
    const fixture = setup();
    fixture.routes.splice(0);
    const result = await fixture.adapter.ensureTrafficEdge(fixture.hostname, {
      origin: 'https://target.run.app', targetFingerprint: 'target',
    }, fixture.binding);
    expect(result.success).toBe(false);
    expect(fixture.fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it('observes the public routing marker without writes and restores the page on the same route', async () => {
    const fixture = setup();
    const target = { origin: 'https://target.run.app', targetFingerprint: 'target' };
    const result = await fixture.adapter.ensureTrafficEdge(fixture.hostname, target, fixture.binding);
    const binding = result.data?.binding as typeof fixture.binding & typeof target;
    fixture.fetchMock.mockImplementation(async (input, init) => {
      if (String(input).startsWith(`https://${fixture.hostname}/`)) {
        return new Response(null, { status: 204, headers: { 'X-Hypervibe-Traffic': binding.contentHash } });
      }
      if (init?.method === 'PUT') return new Response('');
      return Response.json({ success: true, result: fixture.routes });
    });
    fixture.fetchMock.mockClear();
    await expect(fixture.adapter.observeTrafficEdge(fixture.hostname, target, binding)).resolves.toMatchObject({ state: 'active', markerVerified: true });
    expect(fixture.fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    await expect(fixture.adapter.prepareTrafficEdge(fixture.hostname, target, binding)).resolves.toEqual(binding);
    await expect(fixture.adapter.ensureTrafficEdge(fixture.hostname, target, binding)).resolves.toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(fixture.fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    const restored = await fixture.adapter.ensureMaintenanceEdge(fixture.hostname, fixture.binding.contentHash, binding);
    expect(restored).toMatchObject({ success: true, data: { binding: fixture.binding } });
    expect((restored.data?.binding as Record<string, unknown>).origin).toBeUndefined();
    expect(fixture.fetchMock.mock.calls.some(([, init]) => init?.method === 'POST' || init?.method === 'DELETE')).toBe(false);
  });

  it('blocks a different account and unknown or mismatched public marker', async () => {
    const fixture = setup();
    const target = { origin: 'https://target.run.app', targetFingerprint: 'target' };
    await expect(fixture.adapter.ensureTrafficEdge(fixture.hostname, target, { ...fixture.binding, accountId: 'other' })).resolves.toMatchObject({ success: false });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    const result = await fixture.adapter.ensureTrafficEdge(fixture.hostname, target, fixture.binding);
    const binding = result.data?.binding as typeof fixture.binding & typeof target;
    fixture.fetchMock.mockImplementation(async input => String(input).startsWith(`https://${fixture.hostname}/`)
      ? new Response(null, { status: 204, headers: { 'X-Hypervibe-Traffic': 'different' } })
      : Response.json({ success: true, result: fixture.routes }));
    await expect(fixture.adapter.observeTrafficEdge(fixture.hostname, target, binding)).resolves.toMatchObject({ state: 'unknown', markerVerified: false });
  });

  it.each(['App.Example.com', 'App.Example.com.'])('normalizes %s consistently for script requests, binding comparison and public observation', async hostname => {
    const fixture = setup();
    const target = { origin: 'https://target.run.app', targetFingerprint: 'target' };
    const existing = { ...fixture.binding, hostname };
    const result = await fixture.adapter.ensureTrafficEdge(hostname, target, existing);
    expect(result.success).toBe(true);
    let handler!: (event: { request: Request; respondWith(value: Promise<Response>): void }) => void;
    const originFetch = vi.fn(async () => new Response('target', { status: 200 }));
    runInNewContext(fixture.source(), { URL, Request, Response, Headers, fetch: originFetch,
      addEventListener: (_kind: string, callback: typeof handler) => { handler = callback; } });
    let response!: Promise<Response>;
    handler({ request: new Request('https://app.example.com/path'), respondWith: value => { response = value; } });
    expect((await response).status).toBe(200);
    expect(originFetch).toHaveBeenCalledOnce();
    handler({ request: new Request(`https://${hostname}/another`), respondWith: value => { response = value; } });
    expect((await response).status).toBe(200);
    expect(originFetch).toHaveBeenCalledTimes(2);
    const binding = result.data?.binding as typeof fixture.binding & typeof target;
    expect(binding.hostname).toBe('app.example.com');
    fixture.fetchMock.mockImplementation(async input => String(input).startsWith('https://app.example.com/')
      ? new Response(null, { status: 204, headers: { 'X-Hypervibe-Traffic': binding.contentHash } })
      : Response.json({ success: true, result: fixture.routes }));
    await expect(fixture.adapter.observeTrafficEdge(hostname, target, binding)).resolves.toMatchObject({ state: 'active', markerVerified: true });
    await expect(fixture.adapter.prepareTrafficEdge('app.example.com', target, existing)).resolves.toMatchObject({ hostname: 'app.example.com', contentHash: binding.contentHash });
    const restored = await fixture.adapter.ensureMaintenanceEdge(hostname, fixture.binding.contentHash, binding);
    expect(restored).toMatchObject({ success: true, data: { binding: fixture.binding } });
    fixture.fetchMock.mockImplementation(async input => String(input).startsWith('https://app.example.com/')
      ? new Response('', { status: 503, headers: { 'X-Hypervibe-Maintenance': fixture.binding.contentHash } })
      : Response.json({ success: true, result: fixture.routes }));
    await expect(fixture.adapter.observeMaintenanceEdge(hostname, fixture.binding)).resolves.toMatchObject({ state: 'active', markerVerified: true });
  });
});
