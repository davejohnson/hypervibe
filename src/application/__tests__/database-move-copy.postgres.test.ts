/**
 * The copy-and-verify job for moving a database between an environment's own
 * server and the app's shared server, run as the real generated script against
 * two disposable local PostgreSQL servers: one set up the way Hypervibe sets
 * up a dedicated database (two logins acting as `app_owner`, which owns the
 * database), one the way it sets up the shared server (an administrator who is
 * no superuser, and a tenant made by the tenant module). Only the temporary
 * directory and the PATH to the PostgreSQL tools differ from the job.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTenant, observeTenant, setTenantLoginPassword, tenantNames, type TenantServer } from '../../adapters/providers/database/tenant-database.js';
import { databaseMoveCopyJob, databaseMoveCopyScript, databaseMoveCopyVerified, type DatabaseMoveCopyResult } from '../database-move-copy.js';
import { parseTransferResult } from '../migration-transfer-gcp.js';
import { createdJobBody } from './transfer-job-body.js';

function postgresBin(): string {
  const candidates = [process.env.HYPERVIBE_TEST_POSTGRES_BIN, '/Applications/Postgres.app/Contents/Versions/16/bin'].filter((entry): entry is string => Boolean(entry));
  try { candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()); } catch { /* runner installation below */ }
  if (existsSync('/usr/lib/postgresql')) for (const version of readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) candidates.push(`/usr/lib/postgresql/${version}/bin`);
  const bin = candidates.find((candidate) => existsSync(path.join(candidate, 'initdb')) && existsSync(path.join(candidate, 'pg_ctl')));
  if (!bin) throw new Error('PostgreSQL tools are required for the database move tests.');
  return bin;
}

const bin = postgresBin();
const major = Number(/\(PostgreSQL\) (\d+)/.exec(execFileSync(`${bin}/postgres`, ['--version'], { encoding: 'utf8' }))?.[1]);
const PASSWORD = 'synthetic-password-0123456789';
const ADMIN = 'tenant_admin';
let root: string | undefined;
const servers: Record<'own' | 'shared', { directory: string; socket: string; boot: pg.Client }> = {} as never;
const opened = new Set<pg.Client>();

const stop = () => {
  for (const server of Object.values(servers)) {
    if (existsSync(path.join(server.directory, 'data/postmaster.pid'))) spawnSync(`${bin}/pg_ctl`, ['-D', path.join(server.directory, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
  }
};
async function connect(side: 'own' | 'shared', user: string, password: string | undefined, database: string): Promise<pg.Client> {
  const client = new pg.Client({ host: servers[side].socket, user, password, database, connectionTimeoutMillis: 10_000 });
  client.on('error', () => {});
  await client.connect();
  opened.add(client);
  return client;
}
const close = async (client: pg.Client) => { opened.delete(client); await client.end().catch(() => {}); };
const url = (side: 'own' | 'shared', user: string, database: string) => `postgresql://${user}:${PASSWORD}@${encodeURIComponent(servers[side].socket)}:5432/${database}`;

interface Database { side: 'own' | 'shared'; name: string; login: string; owner: string; url: string }
let counter = 0;

/** A database as Hypervibe leaves a dedicated one: owned by app_owner, which both logins act as. One server holds several here; each has its own roles. */
async function ownDatabase(): Promise<Database> {
  const id = ++counter;
  const name = `own_${id}`, owner = `own_${id}_owner`, login = `own_${id}_a`;
  const { boot } = servers.own;
  await boot.query(`CREATE ROLE ${owner} NOLOGIN`);
  await boot.query(`CREATE ROLE ${login} LOGIN PASSWORD '${PASSWORD}' IN ROLE ${owner}`);
  await boot.query(`ALTER ROLE ${login} SET role = '${owner}'`);
  await boot.query(`CREATE DATABASE ${name} OWNER ${owner} TEMPLATE template0`);
  const inside = await connect('own', 'boot', undefined, name);
  await inside.query(`ALTER SCHEMA public OWNER TO ${owner}`);
  await close(inside);
  return { side: 'own', name, login, owner, url: url('own', login, name) };
}

let tenants: TenantServer;
/** A database on the shared server, made by the tenant module as its non-superuser administrator. */
async function sharedDatabase(): Promise<Database & { identity: { names: ReturnType<typeof tenantNames>; tenantId: string } }> {
  const identity = { names: tenantNames(`move_${++counter}`), tenantId: `env-${counter}` };
  await ensureTenant(tenants, { ...identity, connectionLimit: 10, allocate: true });
  await setTenantLoginPassword(tenants, { ...identity, login: identity.names.logins[0], password: PASSWORD });
  return { side: 'shared', name: identity.names.database, login: identity.names.logins[0], owner: identity.names.owner, url: url('shared', identity.names.logins[0], identity.names.database), identity };
}

/** Everything the verification has to see, written as the app's own login. */
const FIXTURE = [
  `CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')`,
  `CREATE TABLE customers (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL, mood mood DEFAULT 'ok', joined timestamptz DEFAULT '2026-01-02 03:04:05+00')`,
  `INSERT INTO customers (name, mood) SELECT 'customer ' || n, 'happy' FROM generate_series(1, 200) n`,
  `CREATE TABLE "a|b" (id serial PRIMARY KEY, note text)`,
  `INSERT INTO "a|b" (note) VALUES ('first'), ('second')`,
  `CREATE TABLE "we""ird name" (payload jsonb, raw bytea, amount numeric(12, 2))`,
  `INSERT INTO "we""ird name" VALUES ('{"k": [1, 2]}', '\\xdeadbeef', 12.50)`,
  `CREATE TABLE never_filled (id bigint)`,
  `CREATE TABLE orders (id bigserial PRIMARY KEY, customer integer REFERENCES customers (id), total numeric) PARTITION BY RANGE (id)`,
  `CREATE TABLE orders_low PARTITION OF orders FOR VALUES FROM (1) TO (1000)`,
  `INSERT INTO orders (customer, total) SELECT n, n * 1.5 FROM generate_series(1, 50) n`,
  `CREATE INDEX customers_by_name ON customers (lower(name))`,
  `CREATE VIEW happy_customers AS SELECT id, name FROM customers WHERE mood = 'happy'`,
  `CREATE MATERIALIZED VIEW totals AS SELECT customer, sum(total) AS total FROM orders GROUP BY customer`,
  `CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.name := trim(NEW.name); RETURN NEW; END $$`,
  `CREATE TRIGGER tidy BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION touch()`,
  `CREATE SCHEMA audit`,
  `CREATE SEQUENCE audit.ticket START 500 INCREMENT 5`,
  `SELECT nextval('audit.ticket')`,
  `CREATE SEQUENCE audit.unused START 7`,
  `SELECT setval('audit.unused', 42, false)`,
  `SELECT lo_from_bytea(0, decode(repeat('00ff10', 5000), 'hex'))`,
];
async function fill(database: Database, statements: string[] = FIXTURE): Promise<void> {
  const client = await connect(database.side, database.login, PASSWORD, database.name);
  for (const statement of statements) await client.query(statement);
  await close(client);
}
const scalar = async (database: Database, sql: string) => {
  const client = await connect(database.side, database.login, PASSWORD, database.name);
  try { return Object.values((await client.query(sql)).rows[0] ?? {})[0]; } finally { await close(client); }
};

let work: string;
let shims: string;
/** Runs the generated script with the same shell command the job uses. `afterRestore` is SQL a stand-in pg_restore runs on the target once the real restore has finished. */
function copy(source: Database, target: Database, env: Record<string, string> = {}, afterRestore?: string): Promise<{ result: DatabaseMoveCopyResult; output: string }> {
  const script = databaseMoveCopyScript().replaceAll('/tmp/hv-move', work);
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script], { env: { PATH: `${afterRestore ? `${shims}:` : ''}${bin}:${process.env.PATH}`, SOURCE_DATABASE_URL: source.url, DATABASE_URL: target.url, PGTZ: 'UTC',
      REAL_BIN: bin, ...(afterRestore ? { AFTER_RESTORE: afterRestore } : {}), ...env } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('close', () => { for (const log of ['hold.log', 'precheck.log', 'reset.log', 'restore.log', 'verify.log', 'dump.log']) { try { output += `\n[${log}] ${readFileSync(path.join(work, log), 'utf8')}`; } catch { /* not written */ } }
      resolve({ result: (parseTransferResult(output) ?? { ok: false, error: `no result: ${output}` }) as unknown as DatabaseMoveCopyResult, output }); });
  });
}

beforeAll(async () => {
  root = mkdtempSync('/tmp/hv-move-test-');
  process.once('exit', stop);
  work = path.join(root, 'work');
  shims = path.join(root, 'shims');
  mkdirSync(shims);
  // The real restore, then a change to the target the verification must notice.
  writeFileSync(path.join(shims, 'pg_restore'), '#!/bin/sh\ncase " $* " in *" -l "*) exec "$REAL_BIN/pg_restore" "$@" ;; esac\n"$REAL_BIN/pg_restore" "$@" || exit $?\n"$REAL_BIN/psql" "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "$AFTER_RESTORE" >/dev/null\n');
  chmodSync(path.join(shims, 'pg_restore'), 0o755);
  for (const side of ['own', 'shared'] as const) {
    const directory = path.join(root, side);
    const socket = path.join(directory, 's');
    mkdirSync(socket, { recursive: true });
    execFileSync(`${bin}/initdb`, ['-D', path.join(directory, 'data'), '-U', 'boot', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { stdio: 'pipe' });
    writeFileSync(path.join(directory, 'data/postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\nmax_connections = 60\n`);
    writeFileSync(path.join(directory, 'data/pg_hba.conf'), 'local all boot trust\nlocal all all scram-sha-256\n');
    execFileSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'), '-w', 'start'], { stdio: 'pipe' });
    servers[side] = { directory, socket, boot: undefined as never };
    servers[side].boot = await connect(side, 'boot', undefined, 'postgres');
  }
  await servers.shared.boot.query(`CREATE ROLE ${ADMIN} LOGIN CREATEROLE CREATEDB PASSWORD '${PASSWORD}'`);
  const admin = await connect('shared', ADMIN, PASSWORD, 'postgres');
  tenants = {
    admin: { query: (text, values) => admin.query(text, values) },
    inDatabase: async (database, inner) => {
      const client = await connect('shared', ADMIN, PASSWORD, database);
      try { return await inner({ query: (text, values) => client.query(text, values) }); } finally { await close(client); }
    },
  };
}, 120_000);

afterEach(() => { vi.unstubAllGlobals(); });

afterAll(async () => {
  try {
    for (const client of [...opened]) await close(client);
  } finally {
    stop();
    if (root) {
      const stopped = Object.values(servers).every((server) => !existsSync(path.join(server.directory, 'data/postmaster.pid')));
      rmSync(root, { recursive: true, force: true });
      expect(stopped).toBe(true);
    }
  }
});

describe('the generated job', () => {
  it('is valid POSIX shell and holds no connection string', () => {
    const script = databaseMoveCopyScript();
    expect(() => execFileSync('sh', ['-n'], { input: script })).not.toThrow();
    expect(script).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('mounts both servers and takes both URLs as pinned secret versions, never as values', async () => {
    const job = databaseMoveCopyJob({ majorVersion: 16, source: { secret: { secretId: 'hv-production-database-url', version: '4' }, connectionName: 'demo-project:us-central1:hv-demo-shared-a1b2c3' },
      target: { secret: { secretId: 'hv-production-database-move', version: '1' }, connectionName: 'demo-project:us-central1:hv-production-db-d4e5f6' }, blockExtensions: true, ignoredGrantees: ['hv-runtime@demo-project.iam'] });
    expect(job.sourceSecrets).toEqual({});
    const body = await createdJobBody(job) as { template: { template: { containers: Array<{ image: string; env: unknown[]; args: string[]; volumeMounts: unknown }>; volumes: unknown } } };
    const container = body.template.template.containers[0]!;
    expect(container.image).toBe('postgres:16-alpine');
    expect(container.args).toEqual(['-c', databaseMoveCopyScript()]);
    expect(container.env).toEqual([{ name: 'PGTZ', value: 'UTC' }, { name: 'MOVE_BLOCK_EXTENSIONS', value: '1' }, { name: 'MOVE_IGNORED_GRANTEES', value: 'hv-runtime@demo-project.iam' },
      { name: 'SOURCE_DATABASE_URL', valueSource: { secretKeyRef: { secret: 'hv-production-database-url', version: '4' } } },
      { name: 'DATABASE_URL', valueSource: { secretKeyRef: { secret: 'hv-production-database-move', version: '1' } } }]);
    expect(container.volumeMounts).toEqual([{ name: 'cloudsql', mountPath: '/cloudsql' }]);
    expect(body.template.template.volumes).toEqual([{ name: 'cloudsql', cloudSqlInstance: { instances: ['demo-project:us-central1:hv-production-db-d4e5f6', 'demo-project:us-central1:hv-demo-shared-a1b2c3'] } }]);
  });

  it('refuses a job that is not two pinned, different databases', () => {
    const side = (secretId: string) => ({ secret: { secretId, version: '1' }, connectionName: 'demo-project:us-central1:hv-demo-shared-a1b2c3' });
    expect(() => databaseMoveCopyJob({ majorVersion: 16, source: side('one'), target: side('one') })).toThrow(/cannot share one connection secret/);
    expect(() => databaseMoveCopyJob({ majorVersion: 16, source: side('one'), target: { ...side('two'), secret: { secretId: 'two', version: 'latest' } } })).toThrow(/one pinned secret version/);
    expect(() => databaseMoveCopyJob({ majorVersion: 14, source: side('one'), target: side('two') })).toThrow(/PostgreSQL 15 to 18/);
    expect(() => databaseMoveCopyJob({ majorVersion: 16, source: side('one'), target: side('two'), ignoredGrantees: ['a,b'] })).toThrow(/plain role name/);
  });

  it('counts a result as verified only when every part matched', () => {
    const good: DatabaseMoveCopyResult = { ok: true, rehearsal: false, match: true, different: [], source: { tables: 0, rows: '0', version: '160004' }, target: { tables: 0, rows: '0', version: '160004' } };
    expect(databaseMoveCopyVerified(good)).toBe(true);
    for (const bad of [undefined, { ...good, ok: false }, { ...good, rehearsal: true }, { ...good, rehearsal: undefined }, { ...good, match: false }, { ...good, different: ['sequences'] }, { ...good, different: undefined }, { ...good, target: { ...good.target!, rows: '1' } }, { ...good, source: undefined }]) {
      expect(databaseMoveCopyVerified(bad)).toBe(false);
    }
  });
});

describe.runIf(major >= 15)('copying between an own server and the shared server (two real PostgreSQL servers)', () => {
  it.each([['shared', 'own'], ['own', 'shared']] as const)('copies everything from %s to %s and proves it, as each side\'s plain owner role', async (from, to) => {
    const make = (side: 'own' | 'shared') => (side === 'own' ? ownDatabase() : sharedDatabase());
    const source = await make(from);
    const target = await make(to);
    await fill(source);
    const { result, output } = await copy(source, target, to === 'shared' ? { MOVE_BLOCK_EXTENSIONS: '1' } : {});
    expect(result, output).toMatchObject({ ok: true, match: true, different: [], rehearsal: false, source: { tables: 7, rows: '303' }, target: { tables: 7, rows: '303' }, sequences: 5, largeObjects: 1 });
    expect(databaseMoveCopyVerified(result)).toBe(true);
    expect(output).not.toContain(PASSWORD);
    // Everything belongs to the target's own owner role, and the app's login can carry on exactly where the source stopped.
    expect(await scalar(target, `SELECT string_agg(DISTINCT pg_catalog.pg_get_userbyid(c.relowner), ',') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'audit')`)).toBe(target.owner);
    expect(await scalar(target, `INSERT INTO customers (name) VALUES ('  new  ') RETURNING id::text || ':' || name`)).toBe('201:new');
    expect(await scalar(target, `SELECT nextval('audit.ticket')::text || ',' || nextval('audit.unused')::text`)).toBe('505,42');
    expect(await scalar(target, `SELECT md5(lo_get(oid)) FROM pg_largeobject_metadata`)).toBe(await scalar(source, `SELECT md5(lo_get(oid)) FROM pg_largeobject_metadata`));
    // The source was only read.
    expect(await scalar(source, 'SELECT count(*)::text FROM customers')).toBe('200');
  }, 120_000);

  it('accepts a database with no tables at all', async () => {
    const source = await sharedDatabase();
    const target = await ownDatabase();
    const { result, output } = await copy(source, target);
    expect(result, output).toMatchObject({ ok: true, match: true, different: [], source: { tables: 0, rows: '0' }, target: { tables: 0, rows: '0' } });
    expect(databaseMoveCopyVerified(result)).toBe(true);
  }, 60_000);

  it('verifies a rehearsal against the dump\'s own moment while the app keeps writing', async () => {
    const source = await sharedDatabase();
    const target = await ownDatabase();
    await fill(source);
    const writer = await connect(source.side, source.login, PASSWORD, source.name);
    let writing = true;
    let written = 0;
    const writes = (async () => { while (writing) { await writer.query(`INSERT INTO "a|b" (note) VALUES ('during the copy')`); await writer.query(`SELECT nextval('audit.ticket')`); written++; } })();
    const { result, output } = await copy(source, target, { MOVE_REHEARSAL: '1' });
    writing = false;
    await writes;
    expect(written).toBeGreaterThan(10);
    expect(result, output).toMatchObject({ ok: true, rehearsal: true, match: true, different: [] });
    // A rehearsal proves the copy works; it is never the proof that the two databases are the same.
    expect(databaseMoveCopyVerified(result)).toBe(false);
    // The copy is the source as it was at one moment, not as it is now.
    expect(Number(await scalar(target, 'SELECT count(*) FROM "a|b"'))).toBeLessThan(Number(await scalar(source, 'SELECT count(*) FROM "a|b"')));
  }, 120_000);

  it.each([
    ['a changed row in a table whose name contains the old separator', `UPDATE "a|b" SET note = 'tampered' WHERE id = 1`, ['tables']],
    ['a row missing from an oddly named table', `DELETE FROM "we""ird name"`, ['tables']],
    ['a sequence at the same value but marked unused', `SELECT setval('audit.ticket', 500, false)`, ['sequences']],
    ['a sequence one step behind', `SELECT setval('public.customers_id_seq', 199)`, ['sequences']],
    ['different bytes in a large object', `SELECT lo_put(oid, 3, '\\xff') FROM pg_largeobject_metadata`, ['largeobjects']],
    ['a function with a different body', `CREATE OR REPLACE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`, ['definitions']],
    ['a missing index', `DROP INDEX customers_by_name`, ['definitions']],
    ['a dropped column default', `ALTER TABLE customers ALTER COLUMN mood DROP DEFAULT`, ['definitions']],
    ['a disabled trigger', `ALTER TABLE customers DISABLE TRIGGER tidy`, ['definitions']],
    ['an extra table', `CREATE TABLE smuggled (id int)`, ['tables', 'definitions']],
    ['a missing sequence, even in a rehearsal', `DROP SEQUENCE audit.unused`, ['sequences', 'definitions'], { MOVE_REHEARSAL: '1' }],
  ] as Array<[string, string, string[], Record<string, string>?]>)('does not certify a copy with %s', async (_what, change, different, env) => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source);
    const { result, output } = await copy(source, target, env ?? {}, change);
    expect(result, output).toMatchObject({ ok: true, match: false, different });
    expect(databaseMoveCopyVerified(result)).toBe(false);
  }, 60_000);

  it('leaves a target that already holds something alone, and clears it only when told to, keeping the owner role\'s place on the shared server', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source);
    await fill(target, [`CREATE TABLE left_behind (id int)`, `INSERT INTO left_behind VALUES (1)`, `CREATE SCHEMA old`, `CREATE TABLE old.things (id int)`, `SELECT lo_from_bytea(0, '\\x01')`]);
    const refused = await copy(source, target);
    expect(refused.result).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'The new database is not empty; nothing was changed.' });
    expect(await scalar(target, 'SELECT count(*)::text FROM left_behind')).toBe('1');

    const cleared = await copy(source, target, { MOVE_RESET_TARGET: '1' });
    expect(cleared.result, cleared.output).toMatchObject({ ok: true, match: true, different: [], target: { tables: 7, rows: '303' }, largeObjects: 1 });
    expect(await scalar(target, `SELECT (to_regclass('public.left_behind') IS NULL AND to_regnamespace('old') IS NULL)::text`)).toBe('true');
    expect((await observeTenant(tenants, target.identity)).state).toBe('ready');
    // A second run over the first copy (a retry after a lost result) is the same reset and the same proof.
    expect((await copy(source, target, { MOVE_RESET_TARGET: '1' })).result).toMatchObject({ ok: true, match: true });
    expect((await observeTenant(tenants, target.identity)).state).toBe('ready');
  }, 120_000);

  it('never clears or writes when both connections reach the same database', async () => {
    const source = await ownDatabase();
    await fill(source);
    const again = { ...source, url: url('own', source.login, source.name) };
    expect((await copy(source, again, { MOVE_RESET_TARGET: '1' })).result).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'The source and target reach the same database; no data was replaced.' });
    expect(await scalar(source, 'SELECT count(*)::text FROM customers')).toBe('200');
  });

  it.each([
    ['an extension, when moving onto the shared server', 'boot', [`CREATE EXTENSION pgcrypto`], { MOVE_BLOCK_EXTENSIONS: '1' }, /uses 1 extension\(s\) that cannot be installed on the new server yet/],
    ['execute taken away from everyone on a function', 'app', [`CREATE FUNCTION secret() RETURNS int LANGUAGE sql AS 'SELECT 1'`, `REVOKE EXECUTE ON FUNCTION secret() FROM PUBLIC`], {}, /privilege\(s\) granted or taken away that the copy cannot carry over/],
    ['a table readable by another role', 'app', [`CREATE TABLE shared_out (id int)`, `GRANT SELECT ON shared_out TO reporting`], {}, /1 privilege\(s\) granted or taken away/],
    ['a default privilege for another role', 'app', [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting`], {}, /1 privilege\(s\) granted or taken away/],
    ['a table owned by another role', 'boot', [`CREATE TABLE not_ours (id int)`], {}, /1 object\(s\) owned by a role other than the app's own/],
    ['a publication', 'app', [`CREATE TABLE feed (id int)`, `CREATE PUBLICATION feed_out FOR TABLE feed`], {}, /publication\(s\), event trigger\(s\) or foreign server\(s\)/],
  ])('refuses %s before touching the new database', async (_what, as, statements, env, message) => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await servers.own.boot.query(`DO $$ BEGIN CREATE ROLE reporting NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    const client = as === 'boot' ? await connect('own', 'boot', undefined, source.name) : await connect('own', source.login, PASSWORD, source.name);
    for (const statement of statements) await client.query(statement);
    await close(client);
    const { result, output } = await copy(source, target, env);
    expect(result, output).toMatchObject({ ok: false, stage: 'check', targetChanged: false, error: expect.stringMatching(message) });
    expect(result.error).toMatch(/nothing was changed/);
    expect(await scalar(target, `SELECT count(*)::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`)).toBe('0');
  }, 60_000);

  it('carries on when the only grants are to a role Hypervibe re-creates access for itself', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await servers.own.boot.query(`DO $$ BEGIN CREATE ROLE "waker@demo-project.iam" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await fill(source, [`CREATE TABLE jobs (id int)`, `GRANT USAGE ON SCHEMA public TO "waker@demo-project.iam"`, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO "waker@demo-project.iam"`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "waker@demo-project.iam"`]);
    expect((await copy(source, target)).result).toMatchObject({ ok: false, stage: 'check', targetChanged: false });
    expect((await copy(source, target, { MOVE_IGNORED_GRANTEES: 'waker@demo-project.iam' })).result).toMatchObject({ ok: true, match: true });
  }, 60_000);

  it('allows an extension when the new server\'s login may install it, and compares it', async () => {
    const source = await sharedDatabase();
    const target = await ownDatabase();
    const inside = await connect('shared', 'boot', undefined, source.name);
    await inside.query('CREATE EXTENSION citext');
    await close(inside);
    await fill(source, [`CREATE TABLE people (email citext)`, `INSERT INTO people VALUES ('A@example.com')`]);
    // citext is a trusted extension: the database's owner may install it on its own server.
    const { result, output } = await copy(source, target);
    expect(result, output).toMatchObject({ ok: true, match: true, source: { tables: 1, rows: '1' } });
    expect(await scalar(target, `SELECT (email = 'a@EXAMPLE.com')::text FROM people`)).toBe('true');
  }, 60_000);

  it('restores a source whose public schema was once recreated, which a dump then tries to create again', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source, ['DROP SCHEMA public CASCADE', 'CREATE SCHEMA public', 'GRANT USAGE ON SCHEMA public TO PUBLIC', `COMMENT ON SCHEMA public IS 'recreated'`, 'CREATE TABLE kept (id int)', 'INSERT INTO kept VALUES (1)']);
    const { result, output } = await copy(source, target);
    expect(result, output).toMatchObject({ ok: true, match: true, source: { tables: 1, rows: '1' } });
  }, 60_000);

  it('reports a restore that stopped part-way as a changed target, never as a copy', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    // A policy for a role that exists only on the source's server.
    await fill(source, ['CREATE TABLE guarded (id int)', 'INSERT INTO guarded VALUES (1)', 'ALTER TABLE guarded ENABLE ROW LEVEL SECURITY', `CREATE POLICY own_rows ON guarded TO ${source.login} USING (true)`]);
    const { result } = await copy(source, target);
    expect(result).toMatchObject({ ok: false, stage: 'restore', targetChanged: true, error: expect.stringMatching(/could not be written to the new database \(pg_restore exit [1-9]/) });
    expect(databaseMoveCopyVerified(result)).toBe(false);
    // What it left is cleared by the next attempt only because the caller allows it.
    expect((await copy(source, target)).result).toMatchObject({ ok: false, stage: 'check', error: 'The new database is not empty; nothing was changed.' });
  }, 60_000);

  it('refuses two servers on different major versions before reading anything else', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    const fake = path.join(root!, 'old-psql');
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(fake, 'psql'), '#!/bin/sh\ncase "$*" in *server_version_num*) if [ "$1" = "$SOURCE_DATABASE_URL" ]; then echo 150008; exit 0; fi ;; esac\nexec "$REAL_BIN/psql" "$@"\n');
    chmodSync(path.join(fake, 'psql'), 0o755);
    const script = databaseMoveCopyScript().replaceAll('/tmp/hv-move', work);
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: `${fake}:${bin}:${process.env.PATH}`, REAL_BIN: bin, SOURCE_DATABASE_URL: source.url, DATABASE_URL: target.url } });
    expect(parseTransferResult(run.stdout)).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'The two databases run different PostgreSQL major versions; nothing was changed.' });
  });
});
