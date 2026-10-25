import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import { Client } from 'pg';
import { GoogleAuth } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGcpRecoveryWorker } from '../recovery-worker.js';
import { postgresProcessEnvironment } from '../../../../domain/services/postgres-transfer.service.js';
import type { RecoveryWorkerRequest, RecoveryWorkerSession } from '../../../../domain/ports/recovery-worker.port.js';

// Real GoogleAuth/JWT client with synthetic cached access token, actual pinned
// Cloud SQL Connector1.10.0 and serialized SQLAdmin requests to local HTTP.
// Only HTTP/TLS transport is synthetic. This does not certify Google grants,
// live VPC reachability, a TLS handshake, or a restored production database.
// https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector/tree/v1.10.0
// https://cloud.google.com/sql/docs/postgres/connect-run
// https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1beta4/connect/get
// https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1beta4/connect/generateEphemeralCert
const servers: Server[] = [];
const sessions: RecoveryWorkerSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  vi.restoreAllMocks();
});

function request(ipType: 'PRIVATE' | 'PUBLIC' = 'PRIVATE'): RecoveryWorkerRequest {
  return { configuration: { projectId: 'sequence-prod', instanceConnectionName: 'sequence-prod:us-central1:sequence-db', ipType, runtimeServiceAccountEmail: 'backup@sequence-prod.iam.gserviceaccount.com' },
    sourceUrl: 'postgresql://app:synthetic-db-password@10.0.0.2/sequence',
    database: { source: { provider: 'cloudsql', primaryExternalId: 'sequence-db', providerScope: { projectId: 'sequence-prod', region: 'us-central1' }, resourceIdentity: { instanceId: 'sequence-db' } } },
    archiveBucket: 'sequence-archive', destination: { provider: 'gcs', externalId: 'sequence-archive', instanceScope: { projectId: 'sequence-prod', region: 'us-central1' } },
    objects: [{ name: 'media', bucket: 'sequence-media', identity: { provider: 'gcs', externalId: 'sequence-media', instanceScope: { projectId: 'sequence-prod', region: 'us-central1' } } }],
  };
}

async function fixture(options: { noPrivate?: boolean; wrongRegion?: boolean; wrongPrincipal?: boolean } = {}) {
  const certificate = tls.rootCertificates.find(cert => Date.parse(new X509Certificate(cert).validTo) > Date.now() + 86_400_000)!;
  const calls: Array<{ method: string; path: string; body?: any; authenticated: boolean }> = [];
  const server = createServer(async (incoming, response) => {
    let body = ''; for await (const part of incoming) body += part;
    calls.push({ method: incoming.method!, path: incoming.url!, ...(body ? { body: JSON.parse(body) } : {}), authenticated: incoming.headers.authorization?.startsWith('Bearer ') === true });
    response.setHeader('content-type', 'application/json');
    if (incoming.method === 'GET' && incoming.url === '/sql/v1beta4/projects/sequence-prod/instances/sequence-db/connectSettings') {
      response.end(JSON.stringify({ region: options.wrongRegion ? 'us-west1' : 'us-central1', databaseVersion: 'POSTGRES_16', ipAddresses: [{ type: 'PRIMARY', ipAddress: '203.0.113.10' }, ...(options.noPrivate ? [] : [{ type: 'PRIVATE', ipAddress: '10.0.0.2' }])], serverCaCert: { cert: certificate, expirationTime: new Date(Date.now() + 3_600_000).toISOString() } }));
    } else if (incoming.method === 'POST' && incoming.url === '/sql/v1beta4/projects/sequence-prod/instances/sequence-db:generateEphemeralCert') {
      response.end(JSON.stringify({ ephemeralCert: { cert: certificate } }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const address = server.address() as { port: number };
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const auth = new GoogleAuth({ credentials: { type: 'service_account', project_id: 'sequence-prod', client_email: options.wrongPrincipal ? 'deploy@sequence-prod.iam.gserviceaccount.com' : 'backup@sequence-prod.iam.gserviceaccount.com', private_key: privateKey }, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  (await auth.getClient()).setCredentials({ access_token: 'synthetic-worker-access-token', expiry_date: Date.now() + 3_600_000 });
  const storageRequests: Array<{ url: string; method: string; authenticated: boolean }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    storageRequests.push({ url: String(url), method: init?.method ?? 'GET', authenticated: new Headers(init?.headers).get('authorization') === 'Bearer synthetic-worker-access-token' });
    return Response.json({ items: [{ name: 'example.txt', size: '4', generation: '5', metageneration: '1' }] });
  };
  return { driver: createGcpRecoveryWorker({ auth, connectorEndpoint: `http://127.0.0.1:${address.port}/`, fetch: fetcher }), calls, storageRequests };
}

describe('GCP native recovery worker transport', () => {
  it.each(['PRIVATE', 'PUBLIC'] as const)('opens only the selected %s Cloud SQL route and exact GCS bucket using the runtime identity', async mode => {
    const f = await fixture();
    const tlsCalls: any[] = [];
    vi.spyOn(tls, 'createSecureContext').mockReturnValue({} as tls.SecureContext);
    vi.spyOn(tls, 'connect').mockImplementation(((options: any) => {
      tlsCalls.push(options);
      return Object.assign(new PassThrough(), { setKeepAlive() {}, connect() { return this; } });
    }) as any);
    const input = request(mode);
    const session = await f.driver.open(input); sessions.push(session);
    const source = new URL(session.sourceUrl!);
    const directory = decodeURIComponent(source.hostname);
    expect(directory).toContain('hv-backup-sql-');
    expect(existsSync(directory)).toBe(true);
    const client = new Client({ connectionString: session.sourceUrl });
    expect((client as any).connectionParameters.host).toBe(directory);
    expect(postgresProcessEnvironment(session.sourceUrl!).PGHOST).toBe(directory);
    const socket = createConnection(directory + '/.s.PGSQL.5432'); await once(socket, 'connect');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(tlsCalls).toHaveLength(1);
    expect(tlsCalls[0]).toMatchObject({ host: mode === 'PRIVATE' ? '10.0.0.2' : '203.0.113.10', port: 3307 });
    socket.destroy();
    expect(f.calls.every(call => call.authenticated)).toBe(true);
    expect(f.calls.find(call => call.method === 'POST')?.body.public_key).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const objects = await session.openStorage(input.objects[0]!.identity);
    expect(await objects.list()).toEqual([{ key: 'example.txt', size: 4, revision: { generation: '5', metageneration: '1' } }]);
    expect(f.storageRequests).toEqual([{ url: 'https://storage.googleapis.com/storage/v1/b/sequence-media/o?', method: 'GET', authenticated: true }]);
    await expect(session.openStorage({ ...input.destination, externalId: 'another-bucket' })).rejects.toThrow(/outside/);
    await session.close(); expect(existsSync(directory)).toBe(false);
  });

  it('does not fall back to PUBLIC when the exact requested PRIVATE route is absent', async () => {
    const f = await fixture({ noPrivate: true });
    await expect(f.driver.open(request())).rejects.toThrow(/No alternate network route/);
    expect(f.calls.some(call => call.method === 'GET')).toBe(true);
    expect(f.storageRequests).toEqual([]);
  });

  it('rejects a mismatched observed SQL region before any storage or workload data access', async () => {
    const f = await fixture({ wrongRegion: true });
    await expect(f.driver.open(request())).rejects.toThrow(/No alternate network route/);
    expect(f.storageRequests).toEqual([]);
  });

  it('rejects the deployment principal before calling Cloud SQL or opening storage', async () => {
    const f = await fixture({ wrongPrincipal: true });
    await expect(f.driver.open(request())).rejects.toThrow(/different Google service account/);
    expect(f.calls).toEqual([]); expect(f.storageRequests).toEqual([]);
  });
});
