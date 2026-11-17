import '../../aws/aws-engine.adapter.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../db/repositories/connection.repository.js';
import { getSecretStore } from '../../../secrets/secret-store.js';
import { acquireEngineDatabaseAccess } from '../../../../domain/services/engine-database-access.service.js';
import { analyzeSqlQuery } from '../../../../domain/services/sql-query-analysis.js';
import { createPostgresCredentialLifecycle } from '../database-credential.js';
import type { IDatabaseAdapter } from '../../../../domain/ports/database.port.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import { buildDatabaseInitializationCommand, DATABASE_INITIALIZATION_CONFIG_VARIABLE,
  DATABASE_INITIALIZATION_AUTH_COMMAND_HASH, parseDatabaseInitializationReceipt,
  type DatabaseInitializationRequest } from '../../../../domain/services/database-initialization-program.js';

const execute = promisify(execFile);

// Independent real PostgreSQL boundary, using a disposable Unix socket and SCRAM.
// https://www.postgresql.org/docs/current/sql-alterrole.html
// https://www.postgresql.org/docs/current/errcodes-appendix.html
// Configuration changes alone do not change role authentication, and rotating a
// password does not terminate sessions that authenticated with the old password.
describe('native credential lifecycle (real PostgreSQL)', () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  let started = false;
  let admin: pg.Client;

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
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    if (started) await execute('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { env });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('authenticates Aurora diagnostics as the environment login so one readonly SELECT cannot restore control-plane authority', async () => {
    // PostgreSQL checks SET ROLE against session_user, not current_user:
    // https://www.postgresql.org/docs/17/sql-set-role.html
    // The HTTP peer below only translates real SDK Data API messages to real SQL.
    // It selects the SQL login from secretArn, exactly the provider auth boundary.
    const app = 'native_query_owner', control = 'native_query_control', database = 'native_query_database';
    const password = 'synthetic-query-password';
    await admin.query(`CREATE ROLE ${app} LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE ${control} LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query(`GRANT ${app} TO ${control}`);
    await admin.query(`CREATE DATABASE ${database} OWNER ${app}`);
    const open = async (user: string) => {
      const client = new pg.Client({ host: join(directory, 'socket'), database, user, password });
      await client.connect(); return client;
    };
    const setup = await open('auth_admin');
    try {
      await setup.query('CREATE TABLE admin_only(secret text)');
      await setup.query("INSERT INTO admin_only VALUES ('synthetic-outside-environment')");
      await setup.query(`ALTER TABLE admin_only OWNER TO ${control}`);
    } finally { await setup.end(); }
    const exploit = "WITH elevate AS MATERIALIZED (SELECT set_config('role','none',true)) SELECT current_user, query_to_xml('SELECT secret FROM admin_only',false,true,'') FROM elevate";
    expect(analyzeSqlQuery(exploit)).toMatchObject({ isMutation: false, multiStatement: false });
    const counterexample = await open(control);
    try {
      await counterexample.query('BEGIN READ ONLY');
      await counterexample.query(`SET LOCAL ROLE "${app}"`);
      const escaped = await counterexample.query(exploit);
      expect(escaped.rows[0]).toMatchObject({ current_user: control });
      expect(escaped.rows[0].query_to_xml).toContain('synthetic-outside-environment');
      await counterexample.query('ROLLBACK');
    } finally { await counterexample.end(); }

    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(join(directory, 'query.sqlite')).migrate();
    const project = new ProjectRepository().create({ name: 'native-query-project', defaultPlatform: 'aws' });
    const environments = new EnvironmentRepository();
    const environment = environments.create({ projectId: project.id, name: 'test', platformBindings: {} });
    const clusterArn = 'arn:aws:rds:us-west-2:111122223333:cluster:native-query';
    const masterSecretArn = 'arn:aws:secretsmanager:us-west-2:111122223333:secret:master-AbCd12';
    const querySecretName = `hypervibe/${environment.id.toLowerCase()}/database-query`;
    const querySecretArn = `arn:aws:secretsmanager:us-west-2:111122223333:secret:${querySecretName}-AbCd12`;
    environment.platformBindings = { provider: 'aws', aws: { kind: 'opentofu', databaseLoginAt: '2026-01-01T00:00:00Z', sharedDatabase: true,
      database: { clusterArn, accountId: '111122223333', region: 'us-west-2', name: database, owner: app, querySecretArn } } };
    const connections = new ConnectionRepository();
    const connection = connections.create({ provider: 'aws', credentialsEncrypted: getSecretStore().encryptObject({ accessKeyId: 'LOCALACCESSKEY1234', secretAccessKey: 'synthetic-local-secret-value-32-characters', roleArn: 'arn:aws:iam::111122223333:role/hypervibe/hypervibe-deploy', accountId: '111122223333', region: 'us-west-2' }) });
    connections.updateStatus(connection.id, 'verified');
    const transactions = new Map<string, pg.Client>();
    const requests: Array<{ path: string; body: Record<string, any> }> = [];
    const transport = vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (request: any) => {
      const raw = String(request.body);
      const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
      requests.push({ path: request.path, body });
      let statusCode = 200, payload: string;
      try {
        if (request.hostname.startsWith('sts.')) payload = '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASSUMEDACCESSKEY123</AccessKeyId><SecretAccessKey>synthetic-assumed-secret</SecretAccessKey><SessionToken>synthetic-session-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>';
        else if (request.hostname.startsWith('rds.')) payload = `<DescribeDBClustersResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><DescribeDBClustersResult><DBClusters><DBCluster><DBClusterArn>${clusterArn}</DBClusterArn><Engine>aurora-postgresql</Engine><Status>available</Status><HttpEndpointEnabled>true</HttpEndpointEnabled><MasterUserSecret><SecretArn>${masterSecretArn}</SecretArn></MasterUserSecret></DBCluster></DBClusters></DescribeDBClustersResult></DescribeDBClustersResponse>`;
        else if (request.hostname.startsWith('secretsmanager.') && request.headers['x-amz-target']?.endsWith('.DescribeSecret')) payload = JSON.stringify({ ARN: querySecretArn, Name: querySecretName, Tags: [{ Key: 'managed-by', Value: 'hypervibe' }, { Key: 'hv-environment', Value: environment.id.toLowerCase() }], VersionIdsToStages: { current: ['AWSCURRENT'] } });
        else if (request.path === '/BeginTransaction') {
          if (![querySecretArn, masterSecretArn].includes(body.secretArn)) throw new Error('Unknown synthetic secret.');
          const client = await open(body.secretArn === querySecretArn ? app : control);
          const transactionId = `transaction-${transactions.size}`;
          transactions.set(transactionId, client); await client.query('BEGIN'); payload = JSON.stringify({ transactionId });
        } else if (request.path === '/Execute') {
          const client = transactions.get(body.transactionId); if (!client) throw new Error('Unknown transaction.');
          const result = await client.query(body.sql);
          payload = JSON.stringify({ formattedRecords: JSON.stringify(result.rows), numberOfRecordsUpdated: result.rowCount ?? 0 });
        } else if (request.path === '/RollbackTransaction' || request.path === '/CommitTransaction') {
          const client = transactions.get(body.transactionId); if (!client) throw new Error('Unknown transaction.');
          const commit = request.path === '/CommitTransaction'; await client.query(commit ? 'COMMIT' : 'ROLLBACK');
          await client.end(); transactions.delete(body.transactionId);
          payload = JSON.stringify({ transactionStatus: commit ? 'Transaction Committed' : 'Rollback Complete' });
        } else throw new Error('Unexpected synthetic provider operation.');
      } catch {
        statusCode = 400; payload = JSON.stringify({ __type: 'DatabaseErrorException', message: 'Synthetic PostgreSQL rejected the operation.' });
      }
      return { response: { statusCode, headers: { 'content-type': request.hostname.startsWith('sts.') || request.hostname.startsWith('rds.') ? 'text/xml' : 'application/json' }, body: Readable.from([payload]) } };
    });
    let access: Awaited<ReturnType<typeof acquireEngineDatabaseAccess>> | undefined;
    try {
      access = await acquireEngineDatabaseAccess(project, environment);
      expect(access.ok).toBe(true); if (!access.ok) return;
      const result = await access.lease.query!(exploit, [], { readOnly: true });
      expect(result.success).toBe(false);
      expect(requests.find(request => request.path === '/BeginTransaction')?.body.secretArn).toBe(querySecretArn);
      expect(JSON.stringify(result)).not.toContain('synthetic-outside-environment');
    } finally {
      if (access?.ok) await access.lease.release();
      for (const client of transactions.values()) await client.end();
      transport.mockRestore(); SqliteAdapter.resetInstance();
    }
  }, 60_000);

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

  describe('private initialization emitted program (real PostgreSQL)', () => {
    const password = 'initialization-private-password';
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    let url: string;
    beforeAll(async () => {
      await admin.query(`CREATE ROLE initialization_user LOGIN PASSWORD '${password}'`);
      await admin.query('CREATE DATABASE initialization_database OWNER initialization_user');
      url = `postgresql://initialization_user:${password}@${encodeURIComponent(join(directory, 'socket'))}:5432/initialization_database?application_name=initialization`;
    });
    function request(values: Record<string, string>, migration?: { command: string; timeoutMs: number }): DatabaseInitializationRequest {
      return { version: 1, executionId: 'real-initialization-task', mode: migration ? 'migrate' : 'authenticate',
        commandHash: migration ? hash(migration.command) : DATABASE_INITIALIZATION_AUTH_COMMAND_HASH,
        keys: Object.keys(values), expectedHashes: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, hash(value)])),
        authentication: { username: 'initialization_user', database: 'initialization_database' }, ...(migration ? { migration } : {}) };
    }
    async function run(configuration: DatabaseInitializationRequest, values: Record<string, string>) {
      const result = await execute('/bin/sh', ['-c', buildDatabaseInitializationCommand()], {
        cwd: process.cwd(), env: { PATH: process.env.PATH, ...values,
          [DATABASE_INITIALIZATION_CONFIG_VARIABLE]: JSON.stringify(configuration) }, timeout: 15_000, maxBuffer: 8192,
      }).then(value => ({ ...value, code: 0 }), error => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code: error.code }));
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(password); expect(result.stdout).not.toContain(url);
      expect(result.stdout).not.toContain(configuration.authentication.username);
      expect(result.stdout).not.toContain(configuration.authentication.database);
      return { ...result, receipt: parseDatabaseInitializationReceipt(result.stdout.trimEnd(), configuration) };
    }
    it('authenticates the exact intended database and every URL alias with a fresh SCRAM connection', async () => {
      const values = { DATABASE_URL: url, POSTGRES_DB_URL: url };
      expect(await run(request(values), values)).toMatchObject({ code: 0,
        receipt: { authentication: 'authenticated', migration: 'unchecked' } });
    });
    it('rejects valid references and matching configured URL hashes when PostgreSQL rejects the actual password', async () => {
      const stale = url.replace(password, 'stale-initialization-password');
      const values = { DATABASE_URL: stale, POSTGRES_DB_URL: stale };
      const result = await run(request(values), values);
      expect(result.code).not.toBe(0); expect(result.receipt).toMatchObject({ authentication: 'rejected', migration: 'unchecked' });
    });
    it('refuses a stale alias, wrong database identity, trust authentication, or extra PG settings', async () => {
      const values = { DATABASE_URL: url, POSTGRES_DB_URL: url };
      expect((await run(request(values), { ...values, POSTGRES_DB_URL: url.replace(password, 'stale') })).receipt)
        .toMatchObject({ authentication: 'unknown', migration: 'unchecked' });
      const wrong = request(values); wrong.authentication.database = 'public';
      expect((await run(wrong, values)).receipt).toMatchObject({ authentication: 'unknown' });
      const trusted = { DATABASE_URL: `postgresql://auth_admin:unused@${encodeURIComponent(join(directory, 'socket'))}:5432/postgres` };
      const trustRequest = request(trusted); trustRequest.authentication = { username: 'auth_admin', database: 'postgres' };
      expect((await run(trustRequest, trusted)).receipt).toMatchObject({ authentication: 'unknown' });
      for (const key of ['PGPASSWORD', 'PGOPTIONS', 'PGSSLCERT']) {
        expect((await run(request(values), { ...values, [key]: 'private-extra-setting' })).receipt).toMatchObject({ authentication: 'unknown' });
      }
    });
    it('runs only the exact reviewed migration after authentication and suppresses both output streams', async () => {
      const values = { DATABASE_URL: url, POSTGRES_DB_URL: url };
      const script = `const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('CREATE TABLE initialization_proof (id int)');await c.end();console.log(process.env.DATABASE_URL);console.error(process.env.DATABASE_URL)})().catch(()=>process.exit(1));`;
      const migration = { command: `${quote(process.execPath)} -e ${quote(script)}`, timeoutMs: 5_000 };
      const result = await run(request(values, migration), values);
      expect(result).toMatchObject({ code: 0, receipt: { authentication: 'authenticated', migration: 'completed', exitCode: 0 } });
      const verified = new pg.Client({ connectionString: url }); await verified.connect();
      try { expect((await verified.query("SELECT to_regclass('public.initialization_proof')::text AS name")).rows).toEqual([{ name: 'initialization_proof' }]); }
      finally { await verified.end(); }
    });
    it('never starts migration after rejected authentication, and bounds hung migration children', async () => {
      const marker = join(directory, 'must-not-run');
      const values = { DATABASE_URL: url.replace(password, 'stale') };
      const migration = { command: `${quote(process.execPath)} -e ${quote(`require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`)}`, timeoutMs: 1_000 };
      expect((await run(request(values, migration), values)).receipt).toMatchObject({ authentication: 'rejected', migration: 'unchecked' });
      expect(await readdir(directory)).not.toContain('must-not-run');
      const current = { DATABASE_URL: url };
      const hung = { command: `${quote(process.execPath)} -e ${quote('setInterval(()=>{},100)')}`, timeoutMs: 100 };
      const result = await run(request(current, hung), current);
      expect(result.code).not.toBe(0); expect(result.receipt).toMatchObject({ authentication: 'authenticated', migration: 'unknown' });
    });
    it('retains a finite nonzero migration exit after successful real authentication', async () => {
      const values = { DATABASE_URL: url };
      const migration = { command: 'exit 7', timeoutMs: 1_000 };
      const result = await run(request(values, migration), values);
      expect(result.code).not.toBe(0);
      expect(result.receipt).toMatchObject({ authentication: 'authenticated', migration: 'failed', exitCode: 7 });
    });
  });

});
