import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  });

});
