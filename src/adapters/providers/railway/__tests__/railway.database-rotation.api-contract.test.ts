import { execFile } from 'node:child_process';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import { databaseCredentialLifecycle } from '../../../../domain/ports/database-credential.port.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { railwayHttpFixture, projectId, stagingId } from './railway-http.fixture.js';

const execute = promisify(execFile);
const nativeSpawn = childProcess.spawn.bind(childProcess);
const oldPassword = 'old-synthetic-password', replacement = 'frozen-synthetic-replacement';
const source = '${{POSTGRES_PASSWORD}}', reference = '${{Postgres.DATABASE_URL}}';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Railway SDL validates serialized client requests. Opaque reference semantics
// follow https://docs.railway.com/integrations/api/manage-variables and
// https://docs.railway.com/variables. PostgreSQL executes the actual ALTER ROLE:
// https://www.postgresql.org/docs/current/sql-alterrole.html . All provider state
// is synthetic; the SCRAM server below is real and disposable, on loopback only.
describe('Railway complete database password rotation', () => {
  let directory: string, env: NodeJS.ProcessEnv, portNumber: number, started = false;
  let admin: pg.Client;
  const uri = (password: string) => `postgresql://app_user:${password}@127.0.0.1:${portNumber}/railway?application_name=invoice-perfect`;
  beforeAll(async () => {
    env = process.env;
    try { await execute('initdb', ['--version']); }
    catch { const versions = (await readdir('/usr/lib/postgresql')).sort((a, b) => Number(b) - Number(a));
      env = { ...process.env, PATH: `${join('/usr/lib/postgresql', versions[0], 'bin')}:${process.env.PATH}` }; }
    const listener = createServer();
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    portNumber = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    directory = await mkdtemp(join(tmpdir(), 'hv-railway-rotation-'));
    const data = join(directory, 'data');
    await execute('initdb', ['-D', data, '-U', 'auth_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { env });
    await writeFile(join(data, 'postgresql.conf'), `listen_addresses = '127.0.0.1'\nport = ${portNumber}\nunix_socket_directories = '${directory}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\n`);
    await writeFile(join(data, 'pg_hba.conf'), 'local all auth_admin trust\nhost all all 127.0.0.1/32 scram-sha-256\n');
    await execute('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start'], { env }); started = true;
    admin = new pg.Client({ host: directory, port: portNumber, database: 'postgres', user: 'auth_admin' }); await admin.connect();
    await admin.query(`CREATE ROLE app_user LOGIN PASSWORD '${oldPassword}'`);
    await admin.query('CREATE DATABASE railway OWNER app_user');
    await writeFile(join(directory, 'existing-key'), 'synthetic-existing-key', { mode: 0o600 });
    await writeFile(join(directory, 'known-hosts'), 'synthetic-existing-host-trust', { mode: 0o600 });
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    if (started) await execute('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { env });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
    await admin.query(`ALTER ROLE app_user PASSWORD '${oldPassword}'`);
    const f = await railwayHttpFixture({ renderVariableReferences: true, pageSize: 2, ...options });
    await f.adapter.connect({ apiToken: 'synthetic-contract-token', workspaceId: 'workspace-contract',
      sshIdentityFile: join(directory, 'existing-key'), sshKnownHostsFile: join(directory, 'known-hosts') });
    const runtimeValues = new Map<string, Record<string, string>>();
    // Native SSH argv follows the official CLI ssh/native.rs contract. Instead
    // of contacting Railway, execute the exact stdin program as a real Node
    // process against disposable PostgreSQL with independent workload envs.
    vi.spyOn(childProcess, 'spawn').mockImplementation(((file: string, args: string[], options: childProcess.SpawnOptions) => {
      expect(file).toBe('/usr/bin/ssh');
      expect(args.slice(0, 3)).toEqual(['-F', '/dev/null', '-T']);
      for (const required of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no', 'IdentitiesOnly=yes',
        'ForwardAgent=no', 'ClearAllForwardings=yes', 'RequestTTY=no', 'PermitLocalCommand=no']) expect(args).toContain(required);
      expect(options).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      expect(args.join(' ')).not.toContain(oldPassword); expect(args.join(' ')).not.toContain(replacement);
      const replica = args.find(value => value.endsWith('@ssh.railway.com'))!.split('@')[0];
      expect(runtimeValues.has(replica)).toBe(true);
      return nativeSpawn(process.execPath, ['-'], { ...options, cwd: process.cwd(), env: { PATH: process.env.PATH, ...runtimeValues.get(replica) } });
    }) as typeof childProcess.spawn);
    f.addService('staging-db', 'Postgres', stagingId).instances.get(stagingId)!.source = { image: 'postgres:16' };
    const volume = f.addVolume('staging-db', stagingId, '/var/lib/postgresql/data');
    const component: Component = { id: 'local-db', environmentId: f.environment.id, type: 'postgres', externalId: 'staging-db',
      createdAt: new Date(), updatedAt: new Date(), bindings: { provider: 'railway', resourceKind: 'service',
        providerScope: { projectId, environmentId: stagingId }, volumeId: volume.id, pluginName: 'Postgres', directUrlVariable: 'DATABASE_URL' } };
    f.variables.set(`staging-db/${stagingId}`, { POSTGRES_PASSWORD: oldPassword, PGPASSWORD: source, DATABASE_URL: uri(source),
      PGUSER: 'app_user', PGDATABASE: 'railway', PGDATA: '/var/lib/postgresql/data/pgdata' });
    f.environment.platformBindings.services = {};
    for (const name of ['web', 'worker', 'cron']) {
      const id = `staging-${name}`; f.addService(id, name, stagingId);
      (f.environment.platformBindings.services as Record<string, unknown>)[name] = { serviceId: id };
      f.variables.set(`${id}/${stagingId}`, { DATABASE_URL: reference, POSTGRES_DB_URL: reference, DATABASE_READ_URL_1: reference });
    }
    const database = createRailwayDatabaseAdapter({ hostingAdapter: f.adapter, envRepo: { findById: () => f.environment } as never });
    const result = { ...f, component, database, runtimeValues, required: Object.fromEntries(['web', 'worker', 'cron'].map(name => [name, ['DATABASE_URL', 'POSTGRES_DB_URL']])) };
    for (const name of ['web', 'worker', 'cron']) deployed(result, name, oldPassword);
    return result;
  }
  async function reviewed(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
    const f = await fixture(options), native = databaseCredentialLifecycle(f.database)!;
    const lifecycle = { ...native, configuration: native.runtimeConfiguration! };
    const target = await lifecycle.inspect(f.environment, f.component, { environment: 'staging', component: f.component.id, username: 'app_user', database: 'railway' });
    const review = await lifecycle.configuration.inspect(f.environment, f.component, target, replacement, f.required);
    return { ...f, lifecycle, target, review };
  }
  function deployed(f: Awaited<ReturnType<typeof fixture>>, name: string, password: string, draining = false) {
    const serviceId = `staging-${name}`, id = `deployment-${name}-${password === replacement ? 'new' : 'old'}`;
    const instance = f.services.get(serviceId)!.instances.get(stagingId)!;
    instance.latestDeployment = { id, status: 'SUCCESS' };
    instance.activeDeployments = [{ id }, ...(draining ? [{ id: `old-${name}` }] : [])];
    f.deployments.set(id, { id, projectId, environmentId: stagingId, serviceId, snapshotId: `snapshot-${id}`,
      status: 'SUCCESS', deploymentStopped: false, instances: [{ id: `replica-${id}`, status: 'RUNNING' }] });
    f.deploymentSnapshots.set(id, { id: `snapshot-${id}`, variables: { DATABASE_URL: reference, POSTGRES_DB_URL: reference, DATABASE_READ_URL_1: reference } });
    f.runtimeValues.set(`replica-${id}`, { DATABASE_URL: uri(password), POSTGRES_DB_URL: uri(password), DATABASE_READ_URL_1: uri(password),
      RAILWAY_PROJECT_ID: projectId, RAILWAY_ENVIRONMENT_ID: stagingId, RAILWAY_SERVICE_ID: serviceId,
      RAILWAY_DEPLOYMENT_ID: id, RAILWAY_REPLICA_ID: `runtime-${id}` });
  }

  it('executes the fixed read-only program in the selected workload with real PostgreSQL authentication', async () => {
    const f = await fixture();
    const evidence = await f.adapter.railwayRuntimeEvidence.read({ projectId, environmentId: stagingId,
      serviceId: 'staging-worker', deploymentId: 'deployment-worker-old' },
    { keys: ['DATABASE_URL'], authentication: { username: 'app_user', database: 'railway' } });
    expect(f.contractErrors).toEqual([]);
    expect(childProcess.spawn).toHaveBeenCalled();
    expect(evidence).toMatchObject({ state: 'verified', authentication: 'authenticated', envVarHashes: { DATABASE_URL: hashEnvValue(uri(oldPassword)) } });
  });

  it.each(['schema as database', 'wrong login', 'required TLS', 'missing database', 'URI password override', 'malformed URL'])(
    'keeps unsupported or mismatched application authentication unknown: %s', async scenario => {
      const f = await fixture();
      const target = { projectId, environmentId: stagingId, serviceId: 'staging-worker', deploymentId: 'deployment-worker-old' };
      const authentication = { username: 'app_user', database: 'railway' };
      const values = f.runtimeValues.get('replica-deployment-worker-old')!;
      if (scenario === 'schema as database') authentication.database = 'public';
      if (scenario === 'wrong login') authentication.username = 'another_user';
      if (scenario === 'required TLS') values.DATABASE_URL += '&sslmode=require';
      if (scenario === 'missing database') values.DATABASE_URL = uri(oldPassword).replace('/railway?', '/?');
      if (scenario === 'URI password override') values.DATABASE_URL += '&password=unreviewed-synthetic-secret';
      if (scenario === 'malformed URL') values.DATABASE_URL = 'invalid-sensitive-synthetic-url';
      const evidence = await f.adapter.railwayRuntimeEvidence.read(target, { keys: ['DATABASE_URL'], authentication });
      expect(evidence).toMatchObject({ state: 'unknown', authentication: 'unknown' });
      expect(JSON.stringify(evidence)).not.toMatch(/old-synthetic-password|unreviewed-synthetic-secret|invalid-sensitive-synthetic-url/);
      expect(f.mutations).toEqual([]);
      expect(f.contractErrors).toEqual([]);
    });

  it('changes SQL before issuer, freezes references and all affected consumers while deployed credentials remain stale', async () => {
    const f = await fixture();
    const native = databaseCredentialLifecycle(f.database)!;
    const lifecycle = { ...native, configuration: native.runtimeConfiguration! };
    expect(lifecycle, 'a reachable complete Railway capability must replace the SQL-only scaffold').toBeDefined();
    const target = await lifecycle!.inspect(f.environment, f.component, { environment: 'staging', component: f.component.id, username: 'app_user', database: 'railway' });
    const review = await lifecycle!.configuration.inspect(f.environment, f.component, target, replacement, f.required);
    expect(review.consumers).toHaveLength(3);
    for (const consumer of review.consumers) expect(consumer.envVarHashes).toEqual({ DATABASE_URL: hashEnvValue(uri(replacement)),
      POSTGRES_DB_URL: hashEnvValue(uri(replacement)), DATABASE_READ_URL_1: hashEnvValue(uri(replacement)) });
    expect('acquireTemporaryDatabaseAccess' in f.adapter).toBe(false);
    expect(await lifecycle!.probe(f.environment, f.component, target, replacement)).toMatchObject({ state: 'rejected' });
    expect(await lifecycle!.rotate(f.environment, f.component, target, replacement)).toEqual({ state: 'acknowledged' });
    expect(f.variables.get(`staging-db/${stagingId}`)!.POSTGRES_PASSWORD).toBe(oldPassword);
    expect(await lifecycle!.probe(f.environment, f.component, target, replacement)).toMatchObject({ state: 'authenticated' });
    expect(await lifecycle!.configuration.synchronize(f.environment, f.component, target, replacement, review)).toEqual({ state: 'acknowledged' });
    expect(await lifecycle!.configuration.observe(f.environment, f.component, target, replacement, review)).toEqual({ issuer: 'match', references: 'match' });
    expect(await lifecycle!.configuration.inspect(f.environment, f.component, target, replacement, f.required, review)).toEqual(review);
    const stale = new pg.Client({ connectionString: uri(oldPassword) });
    try { await expect(stale.connect()).rejects.toMatchObject({ code: '28P01' }); } finally { await stale.end(); }
    const staleRuntime = await f.adapter.railwayRuntimeEvidence.read({ projectId, environmentId: stagingId,
      serviceId: 'staging-worker', deploymentId: 'deployment-worker-old' },
    { keys: ['DATABASE_URL', 'POSTGRES_DB_URL'], authentication: { username: 'app_user', database: 'railway' } });
    expect(staleRuntime).toMatchObject({ state: 'verified', authentication: 'rejected' });
    expect(JSON.stringify(staleRuntime)).not.toMatch(/old-synthetic-password|frozen-synthetic-replacement/);
    // Reference/config agreement and successful configuration write did not
    // redeploy even one stale consumer. Shared rollout tests own activation.
    expect(f.variables.get(`staging-web/${stagingId}`)!.POSTGRES_DB_URL).toBe(reference);
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['variableCollectionUpsert']);
    expect(f.mutations[0].args.input).toMatchObject({ serviceId: 'staging-db', variables: { POSTGRES_PASSWORD: replacement }, replace: false, skipDeploys: true });
    expect(f.contractErrors).toEqual([]);
  });

  it('separates misleading deployment success, SQL rejection, partial activation, drain and fresh application authentication', async () => {
    const f = await reviewed(), verify = () => f.lifecycle.configuration.verifyAuthentication(f.environment, f.component, f.target, f.review, 'node-postgres');
    for (const name of ['web', 'worker', 'cron']) deployed(f, name, replacement);
    // All deployments claim SUCCESS with intended config, but SQL still accepts
    // the old credential. Deployment status alone must never finish rotation.
    expect(await verify()).toMatchObject({ state: 'rejected' });
    expect(await f.lifecycle.rotate(f.environment, f.component, f.target, replacement)).toEqual({ state: 'acknowledged' });
    expect(await f.lifecycle.configuration.synchronize(f.environment, f.component, f.target, replacement, f.review)).toEqual({ state: 'acknowledged' });
    deployed(f, 'worker', oldPassword);
    expect(await verify()).toMatchObject({ state: 'unknown' });
    deployed(f, 'worker', replacement, true);
    expect(await verify()).toMatchObject({ state: 'unknown' });
    deployed(f, 'worker', replacement);
    expect(await verify()).toMatchObject({ state: 'authenticated' });
    const last = f.services.get('staging-worker')!.instances.get(stagingId)!.latestDeployment!.id;
    f.runtimeValues.get(`replica-${last}`)!.PGOPTIONS = '-c search_path=invoice_perfect_workflow';
    expect(await verify()).toMatchObject({ state: 'unknown' });
    expect(f.mutations).toHaveLength(1); expect(f.contractErrors).toEqual([]);
  });

  it('reconciles a lost issuer acknowledgement by readback without repeating SQL or the issuer write', async () => {
    const f = await reviewed({ dropVariableResponse: true });
    expect(await f.lifecycle.rotate(f.environment, f.component, f.target, replacement)).toEqual({ state: 'acknowledged' });
    expect(await f.lifecycle.configuration.synchronize(f.environment, f.component, f.target, replacement, f.review)).toEqual({ state: 'unknown' });
    expect(await f.lifecycle.probe(f.environment, f.component, f.target, replacement)).toMatchObject({ state: 'authenticated' });
    expect(await f.lifecycle.configuration.observe(f.environment, f.component, f.target, replacement, f.review)).toEqual({ issuer: 'match', references: 'match' });
    expect(await f.lifecycle.configuration.synchronize(f.environment, f.component, f.target, replacement, f.review)).toEqual({ state: 'acknowledged' });
    expect(f.mutations).toHaveLength(1); expect(f.contractErrors).toEqual([]);
  });

  it.each(['unlisted reference', 'copied literal', 'copied password', 'missing alias', 'third-party issuer', 'changed reference', 'unknown variable evidence', 'extra driver option'])(
    'blocks %s before any provider or SQL mutation', async scenario => {
      let unknown = false;
      const f = await reviewed({ responseOverride: ({ query }) => unknown && query.includes('DatabaseRotationVariables')
        ? Response.json({ data: { definitions: {}, rendered: null } }) : undefined });
      if (scenario === 'unlisted reference') {
        f.addService('unlisted', 'unknown-worker', stagingId);
        f.variables.set(`unlisted/${stagingId}`, { QUEUE_DB_URL: reference });
      }
      if (scenario === 'copied literal') f.variables.get(`staging-worker/${stagingId}`)!.DATABASE_READ_URL_2 = uri(oldPassword);
      if (scenario === 'copied password') f.variables.get(`staging-worker/${stagingId}`)!.QUEUE_PASSWORD = oldPassword;
      if (scenario === 'missing alias') delete f.variables.get(`staging-worker/${stagingId}`)!.POSTGRES_DB_URL;
      if (scenario === 'third-party issuer') f.variables.get(`staging-db/${stagingId}`)!.POSTGRES_PASSWORD = 'another-synthetic-password';
      if (scenario === 'changed reference') f.variables.get(`staging-worker/${stagingId}`)!.POSTGRES_DB_URL = '${{DATABASE_URL}}';
      if (scenario === 'unknown variable evidence') unknown = true;
      if (scenario === 'extra driver option') f.variables.get(`staging-worker/${stagingId}`)!.PGSSLMODE = 'no-verify';
      expect(await f.lifecycle.configuration.observe(f.environment, f.component, f.target, replacement, f.review)).toEqual({ issuer: 'unknown', references: 'unknown' });
      expect(await f.lifecycle.configuration.synchronize(f.environment, f.component, f.target, replacement, f.review)).toEqual({ state: 'blocked' });
      expect(f.mutations).toEqual([]);
      const current = new pg.Client({ connectionString: uri(oldPassword) });
      try { await current.connect(); expect((await current.query('SELECT current_database() AS db')).rows[0].db).toBe('railway'); }
      finally { await current.end(); }
    });

  it('discovers indirect aliases while excluding other environments and preserves exact reference definitions', async () => {
    const f = await fixture();
    f.variables.get(`staging-web/${stagingId}`)!.DATABASE_READ_URL_1 = '${{ POSTGRES_DB_URL }}';
    const native = databaseCredentialLifecycle(f.database)!;
      const lifecycle = { ...native, configuration: native.runtimeConfiguration! };
    const target = await lifecycle.inspect(f.environment, f.component, { environment: 'staging', component: f.component.id, username: 'app_user', database: 'railway' });
    const review = await lifecycle.configuration.inspect(f.environment, f.component, target, replacement, f.required);
    expect(review.consumers.find(item => item.service === 'web')!.envVarHashes.DATABASE_READ_URL_1).toBe(hashEnvValue(uri(replacement)));
    expect(review.consumers.map(item => item.service)).toEqual(['cron', 'web', 'worker']);
    expect(f.mutations).toEqual([]); expect(f.contractErrors).toEqual([]);
  });

  it.each(['empty', 'duplicate'])('does not infer activation from %s active deployments', async scenario => {
    const f = await reviewed();
    await f.lifecycle.rotate(f.environment, f.component, f.target, replacement);
    for (const name of ['web', 'worker', 'cron']) deployed(f, name, replacement);
    const instance = f.services.get('staging-worker')!.instances.get(stagingId)!;
    instance.activeDeployments = scenario === 'empty' ? [] : [instance.activeDeployments![0], instance.activeDeployments![0]];
    expect(await f.lifecycle.configuration.verifyAuthentication(f.environment, f.component, f.target, f.review, 'node-postgres')).toMatchObject({ state: 'unknown' });
  });

  it('rejects a fresh rotation that would keep the existing password', async () => {
    const f = await reviewed();
    await expect(f.lifecycle.configuration.inspect(f.environment, f.component, f.target, oldPassword, f.required)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it.each(['unreachable application route', 'unsupported runtime connection settings'])(
    'preflights %s before a reachable native SQL route can rotate the password', async scenario => {
      const f = await fixture(), native = databaseCredentialLifecycle(f.database)!;
      const lifecycle = { ...native, configuration: native.runtimeConfiguration! };
      const target = await lifecycle.inspect(f.environment, f.component, { environment: 'staging', component: f.component.id, username: 'app_user', database: 'railway' });
      if (scenario === 'unreachable application route') {
        const listener = createServer();
        await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
        const closedPort = (listener.address() as { port: number }).port;
        await new Promise<void>(resolve => listener.close(() => resolve()));
        // The administrative route still works; the application's exact alias
        // uses an unavailable route. No invented/private-network mock is used.
        f.variables.get(`staging-db/${stagingId}`)!.DATABASE_PRIVATE_URL = uri(source).replace(`:${portNumber}/`, `:${closedPort}/`);
        f.variables.get(`staging-worker/${stagingId}`)!.POSTGRES_DB_URL = '${{Postgres.DATABASE_PRIVATE_URL}}';
        f.runtimeValues.get('replica-deployment-worker-old')!.POSTGRES_DB_URL = uri(oldPassword).replace(`:${portNumber}/`, `:${closedPort}/`);
      } else f.runtimeValues.get('replica-deployment-worker-old')!.PGOPTIONS = '-c search_path=public';
      try {
        await expect(lifecycle.configuration.inspect(f.environment, f.component, target, replacement, f.required)).rejects.toThrow('Existing authorized runtime access');
      } finally { vi.unstubAllEnvs(); }
      expect(f.mutations).toEqual([]);
      expect(await lifecycle.probe(f.environment, f.component, target, oldPassword)).toMatchObject({ state: 'authenticated' });
      expect(await lifecycle.probe(f.environment, f.component, target, replacement)).toMatchObject({ state: 'rejected' });
      expect(f.contractErrors).toEqual([]);
    });
});
