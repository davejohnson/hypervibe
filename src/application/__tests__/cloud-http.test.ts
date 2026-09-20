import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createCloudJsonClient } from '../cloud-http.js';

let server: Server;
let origin: string;
let leakedRequests: number;
beforeEach(async () => {
  leakedRequests = 0;
  server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(307, { location: `${origin}/capture` }); res.end(); }
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
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
describe('credential HTTP transport with a real local server', () => {
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
});
