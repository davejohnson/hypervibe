import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCloudJsonClient } from '../cloud-http.js';
import { createHypervibeCloudPairingClient } from '../cloud-pairing.js';

let server: Server;
let origin: string;
let leakedRequests: number;
let pairingRequests: number;
let pairingTimer: ReturnType<typeof setTimeout> | undefined;
beforeEach(async () => {
  leakedRequests = 0;
  pairingRequests = 0;
  server = createServer((req, res) => {
    if (req.url === '/api/v1/pairings') {
      pairingRequests++;
      pairingTimer = setTimeout(() => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ deviceCode: 'A'.repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString(),
          intervalSeconds: 2, repository: 'northstar/launchpad', userCode: '2345-6789',
          verificationUrl: `${origin}/pair?code=2345-6789` }));
      }, 10_600);
    }
    else if (req.url === '/redirect') { res.writeHead(307, { location: `${origin}/capture` }); res.end(); }
    else if (req.url === '/capture') { leakedRequests++; res.end('{}'); }
    else if (req.url === '/large') { res.writeHead(200); res.end(JSON.stringify({ value: 'x'.repeat(80_000) })); }
    else if (req.url === '/slow') { res.writeHead(200); res.write('{'); }
    else if (req.url === '/error') { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'private-token-from-provider' } })); }
    else res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  clearTimeout(pairingTimer);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
describe('credential HTTP transport with a real local server', () => {
  // Native Cloud Run request log on 2026-11-01: POST /api/v1/pairings
  // completed HTTP 201 in 10.455206052s, after the original 10s client limit.
  // Reconstruct that delay through real HTTP; the response is synthetic.
  it('receives the first browser approval after a slow start without repeating its POST', async () => {
    const result = await createHypervibeCloudPairingClient({ baseUrl: origin }).start('northstar/launchpad');
    expect(result.verificationUrl).toBe(`${origin}/pair?code=2345-6789`);
    expect(pairingRequests).toBe(1);
  }, 20_000);
  it('honors an explicit shorter pairing deadline and never resubmits an uncertain request', async () => {
    await expect(createHypervibeCloudPairingClient({ baseUrl: origin, timeoutMs: 100 }).start('northstar/launchpad'))
      .rejects.toThrow('Could not reach');
    expect(pairingRequests).toBe(1);
  });
  it('does not dispatch a deferred request after caller cancellation', async () => {
    const controller = new AbortController();
    const transport = vi.fn(async () => Response.json({}));
    const pending = createCloudJsonClient(origin, transport)('/session', { token: 'synthetic-device-token', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('Could not reach');
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects untrusted absolute request paths before making a network request', async () => {
    await expect(createCloudJsonClient(origin)(`${origin}/capture`, { token: 'test-grant' })).rejects.toThrow('relative API path');
    await expect(createCloudJsonClient(origin)('//attacker.example/capture', { token: 'test-grant' })).rejects.toThrow('relative API path');
    expect(leakedRequests).toBe(0);
  });
  it('does not follow redirects with authorization or uploaded values', async () => {
    await expect(createCloudJsonClient(origin)('/redirect', { token: 'test-grant', body: { secret: 'test-value' } })).rejects.toThrow('Could not reach');
    expect(leakedRequests).toBe(0);
  });
  it('bounds streamed bodies and keeps the abort deadline active until the body finishes', async () => {
    await expect(createCloudJsonClient(origin)('/large')).rejects.toThrow('oversized');
    await expect(createCloudJsonClient(origin, fetch, 50)('/slow')).rejects.toThrow('Could not reach');
  });
  it('never reflects provider errors containing credential values', async () => {
    await expect(createCloudJsonClient(origin)('/error')).rejects.toMatchObject({
      code: 'VALIDATION', message: 'Hypervibe rejected the request. Check connection status before retrying.',
    });
  });
  // The customer contract bounds the complete handoff, including injected
  // transports and response cleanup. Abort notification alone is not a deadline.
  it.each(['fetch', 'body', 'error-cleanup'] as const)('enforces the deadline when %s ignores cancellation', async stage => {
    const never = () => new Promise<never>(() => {});
    const transport = (async () => stage === 'fetch' ? never() : new Response(
      new ReadableStream({ pull: never, cancel: never }),
      { status: stage === 'error-cleanup' ? 403 : 200 }
    )) as typeof fetch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      createCloudJsonClient(origin, transport, 20)('/session', { token: 'synthetic-device-token' })
        .then(() => 'unexpected-success', error => error),
      new Promise(resolve => { timer = setTimeout(() => resolve('deadline-not-enforced'), 100); }),
    ]);
    clearTimeout(timer);
    expect(result).toMatchObject(stage === 'error-cleanup'
      ? { status: 403, code: 'VALIDATION' }
      : { code: 'PROVIDER_ERROR', message: 'Could not reach Hypervibe cloud.' });
    expect(JSON.stringify(result)).not.toContain('synthetic-device-token');
  });
});
