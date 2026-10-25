import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, parse, validate } from 'graphql';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { ComponentRepository } from '../../../db/repositories/component.repository.js';
import { ConnectionRepository } from '../../../db/repositories/connection.repository.js';
import { getSecretStore } from '../../../secrets/secret-store.js';
import { DatabaseAdapter } from '../../database/database.adapter.js';
import { createToolContext } from '../../../../application/context.js';
import { createMcpCommandRegistrar } from '../../../../interfaces/mcp/adapter.js';
import { registerHvDbTools } from '../../../../tools/hv-db.tools.js';
import { acquireDatabaseComponentAccess, databaseAccessLeaseCoordinator } from '../../../../domain/services/database-access.service.js';
import { schema } from './railway-http.fixture.js';
import { RailwayAdapter } from '../railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-railway-no-public-access-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(join(directory, 'state.db')).migrate();
  databaseAccessLeaseCoordinator.resetForTests();
});
afterEach(() => {
  databaseAccessLeaseCoordinator.resetForTests();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

// The owner requires diagnostics/migrations to leave private databases private.
// Railway documents TCP proxies as public exposure, separate from CLI SSH:
// https://docs.railway.com/networking/tcp-proxy
// https://docs.railway.com/cli/connect
// Synthetic responses execute against the pinned official GraphQL schema through
// the real client. Credential tests separately stub unrelated persistence/alias
// checks and SQL transport; they prove route selection, not SQL compatibility.
function fixture(existingProxy = false, options: { denyProxyRead?: boolean } = {}) {
  const project = new ProjectRepository().create({ name: 'private-db-app', defaultPlatform: 'railway' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production',
    platformBindings: { provider: 'railway', projectId: 'project-native', environmentId: 'environment-native' } });
  const component = new ComponentRepository().create({ environmentId: environment.id, type: 'postgres',
    externalId: 'service-native', bindings: { provider: 'railway', projectId: 'project-native', resourceKind: 'service',
      providerScope: { projectId: 'project-native', environmentId: 'environment-native' },
      connectionUrl: 'postgresql://postgres:synthetic-password@postgres.railway.internal:5432/app' } });
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'railway',
    credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-token' }) });
  connections.updateStatus(connection.id, 'verified');
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const proxy = { id: 'existing-proxy', environmentId: 'environment-native', serviceId: 'service-native',
    domain: 'synthetic.proxy.rlwy.net', proxyPort: 23456, applicationPort: 5432, syncStatus: 'ACTIVE', deletedAt: null };
  const variables = new Map<string, Record<string, string>>([['service-native', { PGUSER: 'postgres', POSTGRES_PASSWORD: 'synthetic-password', PGDATABASE: 'app',
    DATABASE_URL: 'postgresql://postgres:synthetic-password@postgres.railway.internal:5432/app' }]]);
  const proxies = new Map(existingProxy ? [['service-native', proxy]] : []);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const request = JSON.parse(String(init.body)); requests.push(request);
    const document = parse(request.query);
    expect(validate(schema, document)).toEqual([]);
    if (options.denyProxyRead && request.query.includes('query TcpProxies')) {
      return Response.json({ errors: [{ message: 'Synthetic access denied: secret-provider-detail' }] }, { status: 403 });
    }
    const response = await execute({ schema, document, variableValues: request.variables, rootValue: {
      variables: ({ projectId, environmentId, serviceId }: { projectId: string; environmentId: string; serviceId: string }) => {
        expect({ projectId, environmentId }).toEqual({ projectId: 'project-native', environmentId: 'environment-native' });
        return variables.get(serviceId) ?? {};
      },
      tcpProxies: ({ environmentId, serviceId }: { environmentId: string; serviceId: string }) => {
        expect(environmentId).toBe('environment-native');
        return proxies.has(serviceId) ? [proxies.get(serviceId)] : [];
      },
      tcpProxyCreate: () => proxy,
      tcpProxyDelete: () => true,
    } });
    expect(response.errors).toBeUndefined();
    return Response.json(response);
  }));
  const query = vi.spyOn(DatabaseAdapter.prototype, 'query').mockResolvedValue({ success: true, rowCount: 1, rows: [{ one: 1 }] });
  return { project, environment, component, requests, query, variables, proxies, proxy };
}

async function client() {
  const server = new McpServer({ name: 'private-db-contract', version: '1.0.0' });
  registerHvDbTools(createMcpCommandRegistrar(server), createToolContext());
  const client = new Client({ name: 'private-db-contract', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function credentialAdapter(f: ReturnType<typeof fixture>) {
  const hosting = new RailwayAdapter();
  await hosting.connect({ apiToken: 'synthetic-token' });
  vi.spyOn(hosting.railwayCredentialAliases, 'inspect').mockResolvedValue({ changeNames: [] } as any);
  const adapter = createRailwayDatabaseAdapter({ hostingAdapter: hosting, envRepo: { findById: () => f.environment } });
  vi.spyOn(adapter, 'observeDatabase').mockResolvedValue({ provider: 'railway', externalId: f.component.externalId!, engine: 'postgres', status: 'running' });
  return adapter;
}

describe('Railway operations never create public database access', () => {
  it('blocks a private-only MCP query and repeated attempts without creating access', async () => {
    const f = fixture(), t = await client();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await t.client.callTool({ name: 'hv_db_query', arguments: {
          project: f.project.name, env: 'production', sql: 'SELECT 1',
        } });
        expect(f.requests.filter(request => request.query.includes('mutation'))).toEqual([]);
        expect(response.structuredContent).toMatchObject({ ok: false, error: { details: {
          resourceCreated: false, cleanup: 'not_needed',
        } } });
        expect(JSON.stringify(response)).toContain('--ssh');
        expect(JSON.stringify(response)).not.toContain('synthetic-password');
      }
      expect(f.query).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it('blocks access to a private migration target without creating a proxy', async () => {
    const f = fixture();
    const response = await acquireDatabaseComponentAccess(f.project, f.environment, f.component, 'railway');
    if (response.ok) await response.lease.release();
    expect(f.requests.filter(request => request.query.includes('mutation'))).toEqual([]);
    expect(response).toMatchObject({ ok: false, code: 'no_external_access', resourceCreated: false, cleanup: 'not_needed' });
  });

  it('reuses an existing user-owned endpoint without creating or deleting access', async () => {
    const f = fixture(true), t = await client();
    try {
      const response = await t.client.callTool({ name: 'hv_db_query', arguments: {
        project: f.project.name, env: 'production', sql: 'SELECT 1',
      } });
      expect(response.structuredContent).toMatchObject({ ok: true, data: { access: { leaseCreated: false, cleanup: 'no_op' } } });
      expect(f.query).toHaveBeenCalledOnce();
      expect(f.requests.filter(request => request.query.includes('mutation'))).toEqual([]);
      expect(JSON.stringify(response)).not.toContain('synthetic-password');
    } finally { await t.close(); }
  });

  it('reuses only the migration candidate endpoint and preserves its configured credentials and options', async () => {
    const f = fixture(true);
    const source = 'postgresql://postgres:synthetic%40password@candidate.railway.internal:5432/candidate?sslmode=verify-full&application_name=migration%20proof';
    const candidate = { ...f.component, id: 'candidate-local', externalId: 'candidate-native',
      bindings: { ...f.component.bindings, connectionUrl: source } };
    f.variables.set(candidate.externalId, { ...f.variables.get('service-native')!, DATABASE_URL: source });
    f.proxies.set(candidate.externalId, { ...f.proxy, id: 'candidate-proxy', serviceId: candidate.externalId,
      domain: 'candidate.proxy.rlwy.net', proxyPort: 34567 });
    const result = await acquireDatabaseComponentAccess(f.project, f.environment, candidate, 'railway');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected an existing migration route');
    expect(await result.lease.withConnection(async url => url)).toBe(source.replace('candidate.railway.internal:5432', 'candidate.proxy.rlwy.net:34567'));
    expect(await result.lease.release()).toEqual({ status: 'no_op' });
    expect(f.requests.filter(request => request.query.includes('mutation'))).toEqual([]);
    expect(f.requests.every(request => request.variables.serviceId === candidate.externalId)).toBe(true);
  });

  it('uses an existing ACTIVE endpoint for credential probes and rotation while retaining private target identity', async () => {
    const f = fixture(true);
    const source = 'postgresql://postgres:synthetic%40password@postgres.railway.internal:5432/app?sslmode=verify-full&application_name=rotation%20proof';
    f.variables.get('service-native')!.DATABASE_URL = source;
    f.variables.get('service-native')!.DATABASE_PUBLIC_URL = 'postgresql://wrong-user:wrong-password@synthetic.proxy.rlwy.net:23456/wrong-db';
    const adapter = await credentialAdapter(f);
    const connections: Array<{ host: string; port: number; user: string; password: string; database: string; application_name?: string }> = [];
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(async function (this: pg.Client) {
      const parameters = (this as any).connectionParameters;
      connections.push(parameters);
      if (parameters.host !== 'synthetic.proxy.rlwy.net') throw Object.assign(new Error('Synthetic private DNS unavailable'), { code: 'ENOTFOUND' });
    });
    vi.spyOn(pg.Client.prototype, 'end').mockResolvedValue(undefined);
    vi.spyOn(pg.Client.prototype, 'query').mockResolvedValue({ rows: [{ username: 'postgres', database: 'app' }] } as never);
    const lifecycle = adapter.credentialLifecycle!;
    const target = await lifecycle.inspect(f.environment, f.component, { environment: 'production', component: f.component.id, username: 'postgres', database: 'app' });
    expect(target.connection.host).toBe('postgres.railway.internal');
    // This route fixture stubs connect without a password challenge. Correct
    // endpoint selection does not establish authentication compatibility.
    expect(await lifecycle.probe(f.environment, f.component, target, 'replacement')).toMatchObject({ state: 'unknown' });
    expect(pg.Client.prototype.query).not.toHaveBeenCalled();
    expect(await lifecycle.rotate(f.environment, f.component, target, 'replacement')).toEqual({ state: 'acknowledged' });
    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({ host: 'synthetic.proxy.rlwy.net', port: 23456, user: 'postgres', password: 'replacement', database: 'app', application_name: 'rotation proof' });
    expect(connections[1]).toMatchObject({ host: 'synthetic.proxy.rlwy.net', port: 23456, user: 'postgres', password: 'synthetic@password', database: 'app', application_name: 'rotation proof' });
    expect(f.requests.filter(request => request.query.includes('mutation'))).toEqual([]);
    expect(await adapter.getConnectionUrl(f.component)).toBe(f.component.bindings.connectionUrl);
  });

  it.each([false, true])('keeps private-only or denied endpoint reads unverified (denied=%s)', async denyProxyRead => {
    const f = fixture(false, { denyProxyRead });
    const adapter = await credentialAdapter(f);
    const connect = vi.spyOn(pg.Client.prototype, 'connect').mockRejectedValue(Object.assign(new Error('Synthetic private DNS unavailable'), { code: 'ENOTFOUND' }));
    vi.spyOn(pg.Client.prototype, 'end').mockResolvedValue(undefined);
    const query = vi.spyOn(pg.Client.prototype, 'query');
    const lifecycle = adapter.credentialLifecycle!;
    const target = await lifecycle.inspect(f.environment, f.component, { environment: 'production', component: f.component.id, username: 'postgres', database: 'app' });
    const result = await lifecycle.probe(f.environment, f.component, target, 'replacement');
    expect(result).toMatchObject({ state: 'unknown' });
    expect(connect).toHaveBeenCalledTimes(denyProxyRead ? 0 : 1);
    expect(query).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('secret-provider-detail');
    expect(f.requests.filter(request => request.query.includes('mutation'))).toEqual([]);
  });

  it.each(['DELETING', 'UPDATING', 'UNSPECIFIED'])('keeps %s endpoint evidence unknown without creating access', async state => {
    const f = fixture(true);
    f.proxy.syncStatus = state;
    const result = await acquireDatabaseComponentAccess(f.project, f.environment, f.component, 'railway');
    expect(result).toMatchObject({ ok: false, code: 'provider_error', resourceCreated: false, cleanup: 'not_needed' });
    expect(f.requests.filter(request => request.query.includes('mutation'))).toEqual([]);
  });

  it('rejects conflicting candidate scope before provider reads', async () => {
    const f = fixture(true);
    const candidate = { ...f.component, bindings: { ...f.component.bindings,
      providerScope: { projectId: 'project-native', environmentId: 'other-environment' } } };
    expect(await acquireDatabaseComponentAccess(f.project, f.environment, candidate, 'railway'))
      .toMatchObject({ ok: false, code: 'provider_error', resourceCreated: false, cleanup: 'not_needed' });
    expect(f.requests).toEqual([]);
  });

  it('does not bypass a configured address override when selecting an existing endpoint', async () => {
    const f = fixture(true);
    f.variables.get('service-native')!.DATABASE_URL += '?host=other.railway.internal';
    expect(await acquireDatabaseComponentAccess(f.project, f.environment, f.component, 'railway'))
      .toMatchObject({ ok: false, code: 'provider_error', resourceCreated: false, cleanup: 'not_needed' });
    expect(f.requests.filter(request => request.query.includes('mutation'))).toEqual([]);
  });
});
