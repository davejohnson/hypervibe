import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandRegistry } from '../commands.js';
import { registerHvDbTools } from '../../tools/hv-db.tools.js';
import type { CommandContext } from '../context.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { parseCliInvocation } from '../../interfaces/cli/parser.js';
import { createPostgresCredentialLifecycle } from '../../adapters/providers/database/database-credential.js';
import type { IDatabaseAdapter } from '../../domain/ports/database.port.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import type { Component } from '../../domain/entities/component.entity.js';

const execute = promisify(execFile);

// Real, disposable PostgreSQL. No provider API, existing database, or access path
// is used. PostgreSQL documents 28P01 as invalid_password and session_user /
// current_database() as the authenticated identity and selected database:
// https://www.postgresql.org/docs/current/errcodes-appendix.html
// https://www.postgresql.org/docs/current/functions-info.html
describe('application connection authentication (real PostgreSQL)', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let started = false;
  let admin: pg.Client;
  let currentUrl: string;
  let staleUrl: string;
  const registry = new CommandRegistry();
  registerHvDbTools(registry, {} as CommandContext);
  const invoke = (overrides: Record<string, unknown> = {}) => registry.execute('hv_db_verify_auth', {
    credentialsRef: 'env:HYPERVIBE_AUTHENTICATION_TEST_CONFIG', driver: 'node-postgres',
    expectedUsername: 'app_user', expectedDatabase: 'railway', configurationSource: 'deployed', ...overrides,
  });

  beforeAll(async () => {
    env = process.env;
    try { await execute('initdb', ['--version']); }
    catch {
      const versions = (await readdir('/usr/lib/postgresql')).sort((a, b) => Number(b) - Number(a));
      env = { ...process.env, PATH: `${join('/usr/lib/postgresql', versions[0], 'bin')}:${process.env.PATH}` };
    }
    directory = await mkdtemp(join(tmpdir(), 'hv-auth-'));
    const data = join(directory, 'data'), socket = join(directory, 'socket');
    await mkdir(socket);
    await execute('initdb', ['-D', data, '-U', 'auth_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { env });
    await writeFile(join(data, 'postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\n`);
    await writeFile(join(data, 'pg_hba.conf'), 'local all auth_admin trust\nlocal all all scram-sha-256\n');
    await execute('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start'], { env });
    started = true;
    admin = new pg.Client({ host: socket, database: 'postgres', user: 'auth_admin' });
    await admin.connect();
    await admin.query("CREATE ROLE app_user LOGIN PASSWORD 'current-synthetic-password'");
    await admin.query('CREATE DATABASE railway OWNER app_user');
    currentUrl = `postgresql://app_user:current-synthetic-password@${encodeURIComponent(socket)}:5432/railway?application_name=invoice%20perfect`;
    staleUrl = currentUrl.replace('current-synthetic-password', 'stale-synthetic-password');
  }, 60_000);

  afterAll(async () => {
    delete process.env.HYPERVIBE_AUTHENTICATION_TEST_CONFIG;
    await admin?.end();
    if (started) await execute('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { env });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('changes real PostgreSQL authentication while keeping old sessions distinct from fresh credential proof', async () => {
    await admin.query("CREATE ROLE native_rotate_user LOGIN PASSWORD 'previous-native-password'");
    await admin.query('CREATE DATABASE native_rotation OWNER native_rotate_user');
    const socket = join(directory, 'socket');
    const url = `postgresql://native_rotate_user:previous-native-password@${encodeURIComponent(socket)}:5432/native_rotation?application_name=native%20rotation`;
    const environment = { id: 'local-environment', projectId: 'local-project', name: 'production', platformBindings: {}, createdAt: new Date(), updatedAt: new Date() } as Environment;
    const component: Component = { id: 'local-database', environmentId: environment.id, externalId: 'disposable-native-database', type: 'postgres',
      bindings: { provider: 'local-postgres-contract', providerScope: { instance: directory }, username: 'native_rotate_user', database: 'native_rotation', password: 'previous-native-password', connectionString: url },
      createdAt: new Date(), updatedAt: new Date() };
    const adapter = { name: 'local-postgres-contract', capabilities: { supportedDatabases: ['postgres'] },
      observeDatabase: async () => ({ provider: 'local-postgres-contract', externalId: component.externalId, engine: 'postgres', status: 'running' }),
      getConnectionUrl: async () => String(component.bindings.connectionString),
    } as unknown as IDatabaseAdapter;
    const lifecycle = createPostgresCredentialLifecycle(() => adapter);
    const target = await lifecycle.inspect(environment, component, { environment: environment.name, component: component.id, username: 'native_rotate_user', database: 'native_rotation' });
    const replacement = "new ' @ native password";
    // Updating configuration alone does not alter pg_authid authentication.
    component.bindings.password = replacement;
    expect(await lifecycle.probe(environment, component, target, replacement)).toMatchObject({ state: 'rejected' });
    expect(await lifecycle.probe(environment, component, target, 'previous-native-password')).toMatchObject({ state: 'authenticated' });
    const existingSession = new pg.Client({ connectionString: url });
    await existingSession.connect();
    try {
      const rotated = await lifecycle.rotate(environment, component, target, replacement);
      expect(rotated).toEqual({ state: 'acknowledged' });
      expect(await lifecycle.probe(environment, component, target, replacement)).toMatchObject({ state: 'authenticated' });
      expect(await lifecycle.probe(environment, component, target, 'previous-native-password')).toMatchObject({ state: 'rejected' });
      expect((await existingSession.query('SELECT session_user AS username, current_database() AS database')).rows).toEqual([{ username: 'native_rotate_user', database: 'native_rotation' }]);
      expect(JSON.stringify(rotated)).not.toContain(replacement);
    } finally { await existingSession.end(); }
  });

  it('does not infer fresh authentication from valid references and matching configured values', async () => {
    const raw = { DATABASE_URL: '${{Postgres.DATABASE_URL}}', POSTGRES_DB_URL: '${{Postgres.DATABASE_URL}}' };
    const configured = { DATABASE_URL: currentUrl, POSTGRES_DB_URL: currentUrl };
    expect(raw.POSTGRES_DB_URL).toBe(raw.DATABASE_URL);
    expect(configured.POSTGRES_DB_URL).toBe(configured.DATABASE_URL);
    const stale = new pg.Client({ connectionString: staleUrl });
    try { await expect(stale.connect()).rejects.toMatchObject({ code: '28P01' }); }
    finally { await stale.end(); }
    process.env.HYPERVIBE_AUTHENTICATION_TEST_CONFIG = staleUrl;
    const result = await invoke();
    expect(result).toMatchObject({ ok: false, error: { code: 'PROVIDER_ERROR', details: {
      authentication: 'rejected', reason: 'invalid_password', deployedConfiguration: 'unchecked', applicationOperation: 'unchecked',
    } } });
    expect(JSON.stringify(result)).not.toContain('synthetic-password');
  });

  it('verifies a new session and exact database identity while preserving configuration options', async () => {
    process.env.HYPERVIBE_AUTHENTICATION_TEST_CONFIG = currentUrl;
    const result = await invoke({ configurationSource: 'configured' });
    expect(result).toMatchObject({ ok: true, data: { authentication: 'authenticated', identity: 'match',
      configurationSource: 'configured', sourceProvenance: 'caller-declared', deployedConfiguration: 'unchecked', applicationOperation: 'unchecked' } });
    expect(JSON.stringify(result)).not.toContain('synthetic-password');
    expect(registry.get('hv_db_verify_auth')).toMatchObject({ access: 'read', cliPath: ['db', 'verify', 'auth'] });
    // The command never equates an intended schema with a database name.
    expect(await invoke({ expectedDatabase: 'public' })).toMatchObject({ ok: false, error: { code: 'VALIDATION', details: { reason: 'configuration_identity_mismatch' } } });
  });

  it('uses the same secret-free authentication result through MCP and CLI registration', async () => {
    process.env.HYPERVIBE_AUTHENTICATION_TEST_CONFIG = currentUrl;
    const invocation = await parseCliInvocation(registry, ['db', 'verify', 'auth', '--credentials-ref', 'env:HYPERVIBE_AUTHENTICATION_TEST_CONFIG',
      '--driver', 'node-postgres', '--expected-username', 'app_user', '--expected-database', 'railway', '--configuration-source', 'configured', '--json'], async () => '');
    const cli = await registry.execute(invocation.command!.id, invocation.input);
    const server = new McpServer({ name: 'auth-contract', version: '0.0.0' });
    registerHvDbTools(createMcpCommandRegistrar(server), {} as CommandContext);
    const client = new Client({ name: 'auth-contract', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const mcp = await client.callTool({ name: 'hv_db_verify_auth', arguments: invocation.input });
      expect(mcp.structuredContent).toEqual(cli);
      expect(JSON.stringify(mcp)).not.toContain('synthetic-password');
      expect(cli).toMatchObject({ ok: true, data: { authentication: 'authenticated', deployedConfiguration: 'unchecked' } });
    } finally { await client.close(); await server.close(); }
  });

  it('reports TLS configuration failure without disabling TLS or falling back to administrative access', async () => {
    process.env.HYPERVIBE_AUTHENTICATION_TEST_CONFIG = JSON.stringify({ connectionString: currentUrl, ssl: { rejectUnauthorized: true } });
    expect(await invoke()).toMatchObject({ ok: false, error: { details: { authentication: 'unknown' } } });
  });

  it('does not inherit missing database identity or credentials from the agent environment', async () => {
    process.env.HYPERVIBE_AUTHENTICATION_TEST_CONFIG = currentUrl.replace('/railway?', '/?');
    expect(await invoke()).toMatchObject({ ok: false, error: { code: 'VALIDATION', details: { reason: 'configuration_invalid' } } });
  });

  it('rejects unsupported options and credential parser errors without exposing private inputs', async () => {
    for (const value of [currentUrl + '&password=unreviewed-secret', '{"connectionString":"sensitive-incomplete']) {
      process.env.HYPERVIBE_AUTHENTICATION_TEST_CONFIG = value;
      const result = await invoke();
      expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      expect(JSON.stringify(result)).not.toMatch(/synthetic-password|unreviewed-secret|sensitive-incomplete/);
    }
  });
});
