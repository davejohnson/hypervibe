import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudRequestClient } from '../cloud-request-client.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const environmentId = '22222222-2222-4222-8222-222222222222';
const token = 'synthetic-private-device-grant';
const discovery = () => ({ source: { revision: 'a'.repeat(40), digest: 'b'.repeat(64) },
  sourceError: null, selectedEnvironmentId: environmentId, sourceBranch: 'main',
  environments: [{ id: environmentId, name: 'Test', preferred: true }],
  availableFields: [{ key: 'API_KEY', label: 'API key', inputType: 'password' }] });
let server: Server | undefined;
const timers: ReturnType<typeof setTimeout>[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  timers.splice(0).forEach(clearTimeout);
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined; }
});

async function serve(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned listener');
  return `http://127.0.0.1:${address.port}`;
}

describe('credential source discovery complete-response deadline', () => {
  // Native request metadata: GET fields returned HTTP200 after15.137944630s,
  // beyond the deployed10s client deadline. No native response body was retained.
  // This is a synthetic valid response over real serialized HTTP, not a claim
  // about the native latency cause or the native response's schema validity.
  it.each(['headers', 'body'] as const)('accepts delayed valid discovery %s through one real HTTP GET', async stage => {
    const requests: { method?: string; url?: string; authorization?: string }[] = [];
    const baseUrl = await serve((req, res) => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      if (stage === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); }
      timers.push(setTimeout(() => { if (stage === 'headers') res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(discovery())); }, 15_200));
    });
    const result = await createCloudRequestClient({ baseUrl, token, projectId, environmentId }).fields('main');
    expect(result.source).toEqual(discovery().source);
    expect(requests).toEqual([{ method: 'GET', url: `/api/v1/projects/${projectId}/credential-request-fields?environmentId=${environmentId}&sourceBranch=main`, authorization: `Bearer ${token}` }]);
  }, 25_000);

  it.each(['source-error', 'malformed', 'oversized', 'redirect'] as const)('rejects %s without treating HTTP success as verified discovery', async mode => {
    let requests = 0;
    const baseUrl = await serve((_req, res) => {
      requests++;
      if (mode === 'redirect') { res.writeHead(307, { location: '/unexpected' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(mode === 'malformed' ? `{${token}` : JSON.stringify(mode === 'source-error'
        ? { ...discovery(), source: null, sourceError: { code: 'source_temporarily_unavailable' } }
        : { ...discovery(), ignoredProviderField: token + 'x'.repeat(256 * 1024) }));
    });
    const error = await createCloudRequestClient({ baseUrl, token, projectId, environmentId }).fields('main').catch(error => error);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(JSON.stringify(error)).not.toContain(token); expect(requests).toBe(1);
  });

  it.each(['fetch', 'body', 'error-cleanup'] as const)('bounds %s even when the transport ignores cancellation', async stage => {
    vi.useFakeTimers();
    const never = () => new Promise<never>(() => {});
    const transport = vi.fn<typeof fetch>(async () => stage === 'fetch' ? never() : new Response(
      new ReadableStream({ pull: never, cancel: never }), { status: stage === 'error-cleanup' ? 403 : 200 }));
    vi.stubGlobal('fetch', transport);
    let outcome: unknown;
    const pending = createCloudRequestClient({ baseUrl: 'https://hypervibe.example', token, projectId, environmentId })
      .fields('main').then(value => { outcome = value; }, error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(75_000);
    await Promise.race([pending, delay(100)]);
    expect(outcome).toMatchObject({ code: stage === 'error-cleanup' ? 'MISSING_CONNECTION' : 'PROVIDER_ERROR' });
    expect(JSON.stringify(outcome)).not.toContain(token); expect(transport).toHaveBeenCalledTimes(1);
  });

  it('ends discovery at75s rather than extending a stalled read indefinitely', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(token)), { once: true });
    }));
    vi.stubGlobal('fetch', transport);
    let outcome: unknown;
    const pending = createCloudRequestClient({ baseUrl: 'https://hypervibe.example', token, projectId, environmentId })
      .fields('main').catch(error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(74_999); expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(outcome).toMatchObject({ code: 'PROVIDER_ERROR', extras: { details: { outcome: 'unknown' } } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['list', 'create'] as const)('keeps the existing10s %s deadline and never retries', async operation => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(token)), { once: true });
    }));
    vi.stubGlobal('fetch', transport);
    const client = createCloudRequestClient({ baseUrl: 'https://hypervibe.example', token, projectId, environmentId });
    let outcome: unknown;
    const pending = (operation === 'list' ? client.list() : client.create({ recipientEmail: 'recipient@example.test', title: 'API access',
      fields: [{ key: 'API_KEY', label: 'API key', inputType: 'password' }], sourceBranch: 'main',
      expectedSourceRevision: 'a'.repeat(40), expectedSourceDigest: 'b'.repeat(64) })).catch(error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(10_000); await pending;
    expect(outcome).toMatchObject({ code: 'PROVIDER_ERROR', extras: { details: { outcome: 'unknown' } } });
    expect(JSON.stringify(outcome)).not.toContain(token); expect(transport).toHaveBeenCalledTimes(1);
  });
});
