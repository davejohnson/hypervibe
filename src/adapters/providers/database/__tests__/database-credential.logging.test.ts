import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresCredentialLifecycle } from '../database-credential.js';
import type { IDatabaseAdapter } from '../../../../domain/ports/database.port.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

const execute = promisify(execFile);
const oldPassword = 'synthetic-logging-before';
const replacement = 'synthetic-logging-replacement_A3-~.';

// Independent real-server boundary: PostgreSQL documents that log_statement
// includes Bind parameters, and accepts a pre-encrypted SCRAM secret verbatim.
// https://www.postgresql.org/docs/17/runtime-config-logging.html
// https://www.postgresql.org/docs/17/sql-createrole.html
// https://www.postgresql.org/docs/17/catalog-pg-authid.html
// Only disposable local PostgreSQL is used. No provider or customer database.
describe('opted-in SQL password rotation with full parameter logging', () => {
  let directory: string, socket: string, env: NodeJS.ProcessEnv, admin: pg.Client;
  let started = false;

  beforeAll(async () => {
    env = process.env;
    try { await execute('initdb', ['--version']); }
    catch {
      const versions = (await readdir('/usr/lib/postgresql')).sort((a, b) => Number(b) - Number(a));
      env = { ...process.env, PATH: `${join('/usr/lib/postgresql', versions[0], 'bin')}:${process.env.PATH}` };
    }
    directory = await mkdtemp(join(tmpdir(), 'hv-log-'));
    const data = join(directory, 'data'); socket = join(directory, 'socket');
    await mkdir(socket);
    await execute('initdb', ['-D', data, '-U', 'log_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { env });
    await writeFile(join(data, 'postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\nlog_statement = 'all'\nlog_parameter_max_length = -1\nlog_parameter_max_length_on_error = -1\n`);
    await writeFile(join(data, 'pg_hba.conf'), 'local all log_admin trust\nlocal all trust_app trust\nlocal all all scram-sha-256\n');
    await execute('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start'], { env }); started = true;
    admin = new pg.Client({ host: socket, database: 'postgres', user: 'log_admin' });
    await admin.connect();
    await admin.query(`CREATE ROLE rotation_app LOGIN PASSWORD '${oldPassword}'`);
    await admin.query(`CREATE ROLE trust_app LOGIN PASSWORD '${oldPassword}'`);
    await admin.query('CREATE DATABASE rotation_database OWNER rotation_app');
    // Supplying a SCRAM verifier must remain SCRAM even when this role's
    // default would hash a plaintext PASSWORD using a different algorithm.
    await admin.query("ALTER ROLE rotation_app SET password_encryption = 'md5'");
  }, 60_000);

  afterAll(async () => {
    await admin?.end();
    if (started) await execute('pg_ctl', ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { env });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await admin.query(`ALTER ROLE rotation_app PASSWORD '${oldPassword}'`);
  });

  function fixture(password = oldPassword, username = 'rotation_app') {
    const environment = { id: 'local-environment', name: 'production', projectId: 'local-project', platformBindings: {} } as Environment;
    const component = { id: 'component', environmentId: environment.id, externalId: 'database', type: 'postgres',
      createdAt: new Date(), updatedAt: new Date(), bindings: { provider: 'logging-fixture', providerScope: { account: 'local' },
        username, database: 'rotation_database',
        connectionString: `postgresql://${username}:${password}@${encodeURIComponent(socket)}:5432/rotation_database`,
      } } as Component;
    const adapter = { name: 'logging-fixture', capabilities: { supportedDatabases: ['postgres'] },
      observeDatabase: async () => ({ provider: 'logging-fixture', externalId: component.externalId, engine: 'postgres', status: 'running' }),
      getConnectionUrl: async () => component.bindings.connectionString,
    } as unknown as IDatabaseAdapter;
    const port = createPostgresCredentialLifecycle(() => adapter, {
      passwordEncoding: 'scram-sha-256',
    });
    return { environment, component, port, target: () => port.inspect(environment, component, {
      environment: environment.name, component: component.id, username, database: 'rotation_database',
    }) };
  }

  it('keeps the replacement out of fully logged SQL and Bind values while changing actual SCRAM authentication', async () => {
    const f = fixture(), target = await f.target();
    expect(await f.port.rotate(f.environment, f.component, target, replacement)).toEqual({ state: 'acknowledged' });
    const logs = await readFile(join(directory, 'postgres.log'), 'utf8');
    expect(logs.includes('hypervibe.credential_rotation_password')).toBe(true);
    expect(logs.includes('DETAIL:  parameters:')).toBe(true);
    expect(logs.includes(replacement)).toBe(false);
    const { rows } = await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'rotation_app'");
    expect(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/.test(rows[0].rolpassword)).toBe(true);
    expect(await f.port.probe(f.environment, f.component, target, replacement)).toMatchObject({ state: 'authenticated' });
    expect(await f.port.probe(f.environment, f.component, target, oldPassword)).toMatchObject({ state: 'rejected' });
  });

  it('uses a fresh cryptographic salt without changing the intended replacement', async () => {
    const f = fixture(), target = await f.target();
    expect(await f.port.rotate(f.environment, f.component, target, replacement)).toEqual({ state: 'acknowledged' });
    f.component.bindings.connectionString = String(f.component.bindings.connectionString).replace(oldPassword, replacement);
    const before = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'rotation_app'")).rows[0].rolpassword;
    expect(await f.port.rotate(f.environment, f.component, target, replacement)).toEqual({ state: 'acknowledged' });
    const after = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'rotation_app'")).rows[0].rolpassword;
    expect(after === before).toBe(false);
    expect(await f.port.probe(f.environment, f.component, target, replacement)).toMatchObject({ state: 'authenticated' });
    expect((await readFile(join(directory, 'postgres.log'), 'utf8')).includes(replacement)).toBe(false);
  });

  it.each(['not url safe', 'non-ascii-é', 'with$dollar', 'with\0null'])('rejects unsupported replacement encoding before SQL (%j)', async value => {
    const f = fixture(), target = await f.target();
    const before = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'rotation_app'")).rows[0].rolpassword;
    expect(await f.port.rotate(f.environment, f.component, target, value)).toEqual({ state: 'blocked' });
    const after = (await admin.query("SELECT rolpassword FROM pg_authid WHERE rolname = 'rotation_app'")).rows[0].rolpassword;
    expect(after === before).toBe(true);
  });

  it('does not call a trust-authenticated session proof that the intended replacement password was accepted', async () => {
    const f = fixture('arbitrary-never-stored-password', 'trust_app'), target = await f.target();
    // Independent PG behavior: trust accepts this identity despite an unrelated
    // stored password. It must not let rotation skip the actual role update.
    // https://www.postgresql.org/docs/17/auth-trust.html
    const direct = new pg.Client({ connectionString: String(f.component.bindings.connectionString) });
    try { await expect(direct.connect()).resolves.toBeUndefined(); }
    finally { await direct.end(); }
    expect(await f.port.probe(f.environment, f.component, target, replacement)).toMatchObject({ state: 'unknown' });
  });
});
