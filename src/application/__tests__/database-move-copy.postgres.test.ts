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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTenant, observeTenant, setTenantLoginPassword, tenantNames, type TenantServer } from '../../adapters/providers/database/tenant-database.js';
import { databaseMoveCopyJob, databaseMoveCopyScript, databaseMoveCopyVerified, type DatabaseMoveCopyResult } from '../database-move-copy.js';
import { parseTransferResult, runTransferJob } from '../migration-transfer-gcp.js';
import { POSTGRES_DATABASE_IDENTITY_SQL } from '../../domain/services/postgres-database-identity.js';
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

interface Database { side: 'own' | 'shared'; name: string; login: string; owner: string; url: string; identity: string }
const identityOf = async (side: 'own' | 'shared', name: string) => {
  const inside = await connect(side, 'boot', undefined, name);
  try { return String((await inside.query(POSTGRES_DATABASE_IDENTITY_SQL)).rows[0].identity); } finally { await close(inside); }
};
let counter = 0;

/** A database as Hypervibe leaves a dedicated one: owned by app_owner, which both logins act as. One server holds several here; each has its own roles. */
async function ownDatabase(create = ''): Promise<Database> {
  const id = ++counter;
  const name = `own_${id}`, owner = `own_${id}_owner`, login = `own_${id}_a`;
  const { boot } = servers.own;
  await boot.query(`CREATE ROLE ${owner} NOLOGIN`);
  await boot.query(`CREATE ROLE ${login} LOGIN PASSWORD '${PASSWORD}' IN ROLE ${owner}`);
  await boot.query(`ALTER ROLE ${login} SET role = '${owner}'`);
  await boot.query(`CREATE DATABASE ${name} OWNER ${owner} TEMPLATE template0 ${create}`);
  const inside = await connect('own', 'boot', undefined, name);
  await inside.query(`ALTER SCHEMA public OWNER TO ${owner}`);
  await close(inside);
  return { side: 'own', name, login, owner, url: url('own', login, name), identity: await identityOf('own', name) };
}

let tenants: TenantServer;
/** A database on the shared server, made by the tenant module as its non-superuser administrator. */
async function sharedDatabase(): Promise<Database & { tenant: { names: ReturnType<typeof tenantNames>; tenantId: string } }> {
  const identity = { names: tenantNames(`move_${++counter}`), tenantId: `env-${counter}` };
  await ensureTenant(tenants, { ...identity, connectionLimit: 10, allocate: true });
  await setTenantLoginPassword(tenants, { ...identity, login: identity.names.logins[0], password: PASSWORD });
  return { side: 'shared', name: identity.names.database, login: identity.names.logins[0], owner: identity.names.owner, url: url('shared', identity.names.logins[0], identity.names.database), tenant: identity, identity: await identityOf('shared', identity.names.database) };
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
  `CREATE TABLE shadowed (t text, hv_move_row text, payload text)`,
  `INSERT INTO shadowed VALUES ('same', 'same', 'one'), ('same', 'same', 'two')`,
  `COMMENT ON TABLE shadowed IS 'columns named like aliases'`,
  `CREATE TABLE orders (id bigserial PRIMARY KEY, customer integer REFERENCES customers (id), total numeric) PARTITION BY RANGE (id)`,
  `CREATE TABLE orders_low PARTITION OF orders FOR VALUES FROM (1) TO (1000)`,
  `INSERT INTO orders (customer, total) SELECT n, n * 1.5 FROM generate_series(1, 50) n`,
  `CREATE INDEX customers_by_name ON customers (lower(name))`,
  `CREATE VIEW happy_customers AS SELECT id, name FROM customers WHERE mood = 'happy'`,
  `CREATE MATERIALIZED VIEW totals AS SELECT customer, sum(total) AS total FROM orders GROUP BY customer`,
  `CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.name := trim(NEW.name); RETURN NEW; END $$`,
  `CREATE TRIGGER tidy BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION touch()`,
  `CREATE FUNCTION banner() RETURNS text LANGUAGE sql AS $$ SELECT 'first
-- kept as written

last' $$`,
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
/** The strictest POSIX shell on this machine: the job image's `/bin/sh` is BusyBox ash, which is closer to dash than to bash. */
const shell = existsSync('/bin/dash') ? '/bin/dash' : 'sh';
interface Run { result: DatabaseMoveCopyResult; output: string; code: number | null }
/**
 * Runs the generated script with the same shell command the job uses. `afterRestore` is SQL a stand-in pg_restore runs on
 * the target once the real restore has finished; `path` puts other stand-ins first. Whatever happens, the job must exit 0
 * and print exactly one line: its result. Anything else in its output could be a database message.
 */
async function copy(source: Database, target: Database, env: Record<string, string> = {}, afterRestore?: string, before = ''): Promise<Run> {
  const script = databaseMoveCopyScript().replaceAll('/tmp/hv-move', work);
  const { output, code } = await new Promise<{ output: string; code: number | null }>((resolve) => {
    const child = spawn(shell, ['-c', script], { env: { PATH: `${before}${afterRestore || env.WRAP_KEYS ? `${shims}:` : ''}${bin}:${process.env.PATH}`, SOURCE_DATABASE_URL: source.url, DATABASE_URL: target.url, PGTZ: 'UTC',
      MOVE_SOURCE_IDENTITY: source.identity, MOVE_TARGET_IDENTITY: target.identity, REAL_BIN: bin, ...(afterRestore ? { AFTER_RESTORE: afterRestore } : {}), ...env } });
    let text = '';
    child.stdout.on('data', (chunk) => { text += String(chunk); });
    child.stderr.on('data', (chunk) => { text += String(chunk); });
    child.on('close', (status) => resolve({ output: text, code: status }));
  });
  const shown = output;
  expect(code, shown).toBe(0);
  expect(output.trim().split('\n'), shown).toHaveLength(1);
  expect(output.startsWith('HV_TRANSFER_RESULT {'), shown).toBe(true);
  return { result: parseTransferResult(output) as unknown as DatabaseMoveCopyResult, output: shown, code };
}
const publicRelations = (database: Database) => scalar(database, `SELECT count(*)::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`);

beforeAll(async () => {
  root = mkdtempSync('/tmp/hv-move-test-');
  process.once('exit', stop);
  work = path.join(root, 'work');
  shims = path.join(root, 'shims');
  mkdirSync(shims);
  // The real restore, then a change to the target the verification must notice.
  writeFileSync(path.join(shims, 'pg_restore'), [
    '#!/bin/sh',
    // Writing definitions out as text: with WRAP_KEYS, as newer PostgreSQL does it, between a \\restrict and an \\unrestrict line carrying a key made up for that one run.
    // Where the tools at hand already write such lines themselves (17.6 and later), theirs are the test and nothing is added.
    'case " $* " in *" -f "*) "$REAL_BIN/pg_restore" "$@" || exit $?',
    '  if [ "${WRAP_KEYS:-0}" = 1 ]; then for A in "$@"; do case "$A" in *.rendered) if grep -m 1 -E "^(SET |.restrict [A-Za-z0-9]+$)" "$A" | grep -q restrict; then continue; fi; KEY=$(od -An -N16 -tx1 /dev/urandom | tr -d " \\n"); { printf "%s\\n" "\\\\restrict $KEY"; cat "$A"; printf "%s\\n" "\\\\unrestrict $KEY"; } > "$A.keyed" && mv "$A.keyed" "$A" ;; esac; done; fi',
    '  exit 0 ;; esac',
    'case " $* " in *" -d "*) ;; *) exec "$REAL_BIN/pg_restore" "$@" ;; esac',
    '"$REAL_BIN/pg_restore" "$@" || exit $?',
    'if [ -n "${AFTER_RESTORE:-}" ]; then "$REAL_BIN/psql" "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "$AFTER_RESTORE" >/dev/null; fi',
    '',
  ].join('\n'));
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
}, 60_000);

const A = '7400000000000000001:617070';
const B = '7400000000000000002:617070';
const jobSide = (identity: string, secretId: string, instance: string) => ({ identity, secret: { secretId, version: '1' }, connectionName: `demo-project:us-central1:${instance}` });

describe('the generated job', () => {
  it('holds no connection string', () => {
    expect(databaseMoveCopyScript()).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('mounts both servers, takes both URLs as pinned secret versions and is told which two databases to expect', async () => {
    const job = databaseMoveCopyJob({ majorVersion: 16, source: { ...jobSide(A, 'hv-production-database-url', 'hv-demo-shared-a1b2c3'), secret: { secretId: 'hv-production-database-url', version: '4' } },
      target: jobSide(B, 'hv-production-database-move', 'hv-production-db-d4e5f6'), blockExtensions: true, ignoredGrantees: ['hv-runtime@demo-project.iam'] });
    expect(job.sourceSecrets).toEqual({});
    const body = await createdJobBody(job) as { template: { template: { containers: Array<{ image: string; env: unknown[]; args: string[]; volumeMounts: unknown }>; volumes: unknown } } };
    const container = body.template.template.containers[0]!;
    expect(container.image).toBe('postgres:16-alpine');
    expect(container.args).toEqual(['-c', databaseMoveCopyScript()]);
    expect(container.env).toEqual([{ name: 'PGTZ', value: 'UTC' }, { name: 'MOVE_SOURCE_IDENTITY', value: A }, { name: 'MOVE_TARGET_IDENTITY', value: B },
      { name: 'MOVE_BLOCK_EXTENSIONS', value: '1' }, { name: 'MOVE_IGNORED_GRANTEES', value: 'hv-runtime@demo-project.iam' },
      { name: 'SOURCE_DATABASE_URL', valueSource: { secretKeyRef: { secret: 'hv-production-database-url', version: '4' } } },
      { name: 'DATABASE_URL', valueSource: { secretKeyRef: { secret: 'hv-production-database-move', version: '1' } } }]);
    expect(container.volumeMounts).toEqual([{ name: 'cloudsql', mountPath: '/cloudsql' }]);
    expect(body.template.template.volumes).toEqual([{ name: 'cloudsql', cloudSqlInstance: { instances: ['demo-project:us-central1:hv-production-db-d4e5f6', 'demo-project:us-central1:hv-demo-shared-a1b2c3'] } }]);
  });

  it('refuses a job that is not two pinned, different, named databases', () => {
    const one = jobSide(A, 'one', 'hv-demo-shared-a1b2c3'), two = jobSide(B, 'two', 'hv-demo-db-a1b2c3');
    expect(() => databaseMoveCopyJob({ majorVersion: 16, source: one, target: { ...two, secret: one.secret } })).toThrow(/cannot share one connection secret/);
    expect(() => databaseMoveCopyJob({ majorVersion: 16, source: one, target: { ...two, secret: { secretId: 'two', version: 'latest' } } })).toThrow(/one pinned secret version/);
    expect(() => databaseMoveCopyJob({ majorVersion: 16, source: one, target: { ...two, identity: A } })).toThrow(/must be different databases/);
    expect(() => databaseMoveCopyJob({ majorVersion: 16, source: one, target: { ...two, identity: 'app' } })).toThrow(/identity of each database/);
    expect(() => databaseMoveCopyJob({ majorVersion: 14, source: one, target: two })).toThrow(/PostgreSQL 15 to 18/);
    expect(() => databaseMoveCopyJob({ majorVersion: 16, source: one, target: two, ignoredGrantees: ['a,b'] })).toThrow(/plain role name/);
  });

  it('counts a result as verified only when every part matched and every count is there on both sides', () => {
    const side = { tables: 0, rows: '0', version: '160004', sequences: 0, largeObjects: 0 };
    const good: DatabaseMoveCopyResult = { ok: true, rehearsal: false, match: true, different: [], source: side, target: side };
    expect(databaseMoveCopyVerified(good)).toBe(true);
    for (const bad of [undefined, { ...good, ok: false }, { ...good, rehearsal: true }, { ...good, rehearsal: undefined }, { ...good, match: false }, { ...good, different: ['sequences'] }, { ...good, different: undefined },
      { ...good, source: undefined }, { ...good, source: {}, target: {} }, { ...good, target: { ...side, rows: '1' } }, { ...good, target: { ...side, sequences: 1 } }, { ...good, target: { ...side, largeObjects: 1 } },
      { ...good, source: { ...side, sequences: undefined }, target: { ...side, sequences: undefined } }, { ...good, source: { ...side, rows: undefined }, target: { ...side, rows: undefined } },
      { ...good, source: { ...side, tables: '0' as never }, target: { ...side, tables: '0' as never } }]) {
      expect(databaseMoveCopyVerified(bad as DatabaseMoveCopyResult | undefined)).toBe(false);
    }
  });
});

describe('a refusal reaches the caller through the job runner', () => {
  const parent = 'projects/demo-project/locations/us-central1';
  const refusal = { ok: false, stage: 'dump', targetChanged: false, error: 'The database has 1 privilege(s) granted or taken away that the copy cannot carry over; nothing was changed.' };
  /** Google's interfaces for one job run: created, run to the given end, its output read, deleted. */
  function cloud(end: 'exits 0' | 'exits non-zero') {
    let jobId = '';
    let labels = {};
    let present = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/v2\//, '');
      const method = init.method ?? 'GET';
      const name = `${parent}/jobs/${jobId}`;
      const native = { name, uid: 'uid-1', etag: 'tag', labels };
      if (url.hostname === 'logging.googleapis.com') return Response.json({ entries: String(init.body).includes('HV_RESTORE_ERROR') ? [] : [{ textPayload: `HV_TRANSFER_RESULT ${JSON.stringify(refusal)}` }] });
      if (path === `${parent}/jobs` && method === 'POST') { jobId = url.searchParams.get('jobId')!; labels = JSON.parse(String(init.body)).labels; present = true; return Response.json({ name: `${parent}/operations/create`, done: true, response: { ...native, name: `${parent}/jobs/${jobId}` } }); }
      if (method === 'GET' && path.startsWith(`${parent}/jobs/`)) return present ? Response.json(native) : Response.json({}, { status: 404 });
      if (method === 'POST' && path === `${name}:run`) {
        return end === 'exits 0' ? Response.json({ name: `${parent}/operations/run`, done: true, response: { name: `${name}/executions/e1`, succeededCount: 1, completionTime: '2026-11-24T12:00:00Z' } })
          : Response.json({ name: `${parent}/operations/run`, done: true, error: { code: 13, message: 'Execution failed' }, metadata: { name: `${name}/executions/e1` } });
      }
      if (method === 'DELETE' && path === name) return Response.json({ name: `${parent}/operations/delete` });
      if (path === `${parent}/operations/delete`) { present = false; return Response.json({ name: path, done: true, response: native }); }
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    }));
  }
  const run = async () => {
    vi.useFakeTimers();
    try {
      const pending = runTransferJob({ token: async () => 'synthetic', gcpProjectId: 'demo-project', region: 'us-central1', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com', environmentLabel: 'env-1' },
        databaseMoveCopyJob({ majorVersion: 16, source: jobSide(A, 'one', 'hv-demo-shared-a1b2c3'), target: jobSide(B, 'two', 'hv-demo-db-a1b2c3') })).catch((error: Error) => ({ thrown: error.message }));
      await vi.runAllTimersAsync();
      return await pending;
    } finally { vi.useRealTimers(); }
  };

  it('with its stage and whether the target was written to, because the job exits 0', async () => {
    cloud('exits 0');
    expect(await run()).toEqual(refusal);
  });

  it('which a job that exited non-zero would have lost: the runner reports only that it failed', async () => {
    cloud('exits non-zero');
    expect(await run()).toEqual({ thrown: 'The transfer execution failed.' });
  });
});

describe.runIf(major >= 15)('copying between an own server and the shared server (two real PostgreSQL servers)', () => {
  const make = (side: 'own' | 'shared') => (side === 'own' ? ownDatabase() : sharedDatabase());

  it.each([['shared', 'own'], ['own', 'shared']] as const)('copies everything from %s to %s and proves it, as each side\'s plain owner role', async (from, to) => {
    const source = await make(from);
    const target = await make(to);
    await fill(source);
    const { result, output } = await copy(source, target, to === 'shared' ? { MOVE_BLOCK_EXTENSIONS: '1' } : {});
    const side = { tables: 8, rows: '305', sequences: 5, largeObjects: 1 };
    expect(result, output).toMatchObject({ ok: true, rehearsal: false, match: true, different: [], source: side, target: side });
    expect(databaseMoveCopyVerified(result)).toBe(true);
    // Everything belongs to the target's own owner role, and the app's login can carry on exactly where the source stopped.
    expect(await scalar(target, `SELECT string_agg(DISTINCT pg_catalog.pg_get_userbyid(c.relowner), ',') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'audit')`)).toBe(target.owner);
    expect(await scalar(target, `INSERT INTO customers (name) VALUES ('  new  ') RETURNING id::text || ':' || name`)).toBe('201:new');
    expect(await scalar(target, `SELECT nextval('audit.ticket')::text || ',' || nextval('audit.unused')::text`)).toBe('505,42');
    expect(await scalar(target, `SELECT md5(lo_get(oid)) FROM pg_largeobject_metadata`)).toBe(await scalar(source, `SELECT md5(lo_get(oid)) FROM pg_largeobject_metadata`));
    expect(await scalar(target, `SELECT obj_description('shadowed'::regclass)`)).toBe('columns named like aliases');
    // The source was only read.
    expect(await scalar(source, 'SELECT count(*)::text FROM customers')).toBe('200');
  }, 120_000);

  it('accepts a database with no tables at all', async () => {
    const source = await sharedDatabase();
    const target = await ownDatabase();
    const { result, output } = await copy(source, target);
    const side = { tables: 0, rows: '0', sequences: 0, largeObjects: 0 };
    expect(result, output).toMatchObject({ ok: true, match: true, different: [], source: side, target: side });
    expect(databaseMoveCopyVerified(result)).toBe(true);
  }, 60_000);

  it('verifies a rehearsal against the dump\'s own moment while the app keeps writing, and never counts it as the copy', async () => {
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
    expect(databaseMoveCopyVerified(result)).toBe(false);
    // The copy is the source as it was at one moment, not as it is now.
    expect(Number(await scalar(target, 'SELECT count(*) FROM "a|b"'))).toBeLessThan(Number(await scalar(source, 'SELECT count(*) FROM "a|b"')));
  }, 120_000);

  it.each([
    ['a changed row in a table whose name contains the old separator', `UPDATE "a|b" SET note = 'tampered' WHERE id = 1`, ['tables']],
    ['a changed value beside columns named like the row alias', `UPDATE shadowed SET payload = 'changed' WHERE payload = 'two'`, ['tables']],
    ['a row missing from an oddly named table', `DELETE FROM "we""ird name"`, ['tables']],
    ['a sequence at the same value but marked unused', `SELECT setval('audit.ticket', 500, false)`, ['sequences']],
    ['a sequence one step behind', `SELECT setval('public.customers_id_seq', 199)`, ['sequences']],
    ['different bytes in a large object', `SELECT lo_put(oid, 3, '\\xff') FROM pg_largeobject_metadata`, ['largeobjects']],
    ['a function with a different body', `CREATE OR REPLACE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`, ['definitions']],
    ['a function body that differs only in a line that looks like a comment', `CREATE OR REPLACE FUNCTION banner() RETURNS text LANGUAGE sql AS $$ SELECT 'first
-- changed

last' $$`, ['definitions']],
    ['a function body that differs only in blank lines', `CREATE OR REPLACE FUNCTION banner() RETURNS text LANGUAGE sql AS $$ SELECT 'first
-- kept as written


last' $$`, ['definitions']],
    ['a missing index', `DROP INDEX customers_by_name`, ['definitions']],
    ['a dropped column default', `ALTER TABLE customers ALTER COLUMN mood DROP DEFAULT`, ['definitions']],
    ['a disabled trigger', `ALTER TABLE customers DISABLE TRIGGER tidy`, ['definitions']],
    ['a changed replica identity', `ALTER TABLE customers REPLICA IDENTITY FULL`, ['definitions']],
    ['a changed comment', `COMMENT ON TABLE shadowed IS 'different'`, ['definitions']],
    ['an added collation, a kind of object no list here names', `CREATE COLLATION extra (locale = 'C')`, ['definitions']],
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

  it('refuses swapped connections before reading or clearing anything, even when clearing is allowed', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source);
    // The secrets are the wrong way round: what the job calls its target is the live source.
    const swapped = await copy({ ...target, identity: source.identity }, { ...source, identity: target.identity }, { MOVE_RESET_TARGET: '1' });
    expect(swapped.result).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'The two connections do not reach the two databases this move is for, in that order; nothing was changed.' });
    expect(await scalar(source, 'SELECT count(*)::text FROM customers')).toBe('200');
    expect(await publicRelations(source)).not.toBe('0');
    // The same for one connection used twice, and for a job told nothing.
    expect((await copy(source, { ...source, identity: target.identity }, { MOVE_RESET_TARGET: '1' })).result).toMatchObject({ ok: false, stage: 'check', targetChanged: false });
    expect((await copy(source, target, { MOVE_RESET_TARGET: '1', MOVE_SOURCE_IDENTITY: '', MOVE_TARGET_IDENTITY: '' })).result).toMatchObject({ ok: false, stage: 'check', targetChanged: false, error: expect.stringMatching(/not told which two different databases/) });
    expect((await copy(source, target, { MOVE_RESET_TARGET: '1', MOVE_TARGET_IDENTITY: source.identity })).result).toMatchObject({ ok: false, stage: 'check', targetChanged: false });
    expect(await scalar(source, 'SELECT count(*)::text FROM customers')).toBe('200');
  }, 60_000);

  it('leaves a target that already holds something alone, and clears it only when told to and only once the source is safely dumped', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source);
    await fill(target, [`CREATE TABLE left_behind (id int)`, `INSERT INTO left_behind VALUES (1)`, `CREATE SCHEMA old`, `CREATE TABLE old.things (id int)`, `SELECT lo_from_bytea(0, '\\x01')`]);
    const refused = await copy(source, target);
    expect(refused.result).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'The new database is not empty; nothing was changed.' });
    expect(await scalar(target, 'SELECT count(*)::text FROM left_behind')).toBe('1');

    // Clearing is allowed, but the source turns out not to be movable: the target must still be as it was, and the message true.
    const boot = await connect('own', 'boot', undefined, source.name);
    await boot.query(`ALTER DATABASE ${source.name} SET work_mem = '8MB'`);
    const early = await copy(source, target, { MOVE_RESET_TARGET: '1' });
    expect(early.result).toMatchObject({ ok: false, stage: 'dump', targetChanged: false, error: expect.stringMatching(/setting\(s\) made on the database or the app's role.*nothing was changed/) });
    expect(await scalar(target, 'SELECT count(*)::text FROM left_behind')).toBe('1');
    expect(await scalar(target, 'SELECT count(*)::text FROM old.things')).toBe('0');
    await boot.query(`ALTER DATABASE ${source.name} RESET work_mem`);
    await close(boot);

    const cleared = await copy(source, target, { MOVE_RESET_TARGET: '1' });
    expect(cleared.result, cleared.output).toMatchObject({ ok: true, match: true, different: [], target: { tables: 8, rows: '305', largeObjects: 1 } });
    expect(await scalar(target, `SELECT (to_regclass('public.left_behind') IS NULL AND to_regnamespace('old') IS NULL)::text`)).toBe('true');
    expect((await observeTenant(tenants, target.tenant)).state).toBe('ready');
    // A second run over the first copy (a retry after a lost result) is the same reset and the same proof.
    expect((await copy(source, target, { MOVE_RESET_TARGET: '1' })).result).toMatchObject({ ok: true, match: true });
    expect((await observeTenant(tenants, target.tenant)).state).toBe('ready');
  }, 120_000);

  it.each([
    ['a collation', [`CREATE COLLATION left_over (locale = 'C')`]],
    ['a default privilege for another role', [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting`]],
    ['a text search dictionary', [`CREATE TEXT SEARCH DICTIONARY plain_words (TEMPLATE = pg_catalog.simple)`]],
    ['an empty extra schema', [`CREATE SCHEMA waiting`]],
    ['a privilege on its public schema', [`GRANT CREATE ON SCHEMA public TO PUBLIC`]],
  ])('counts a target holding only %s as not empty', async (_what, statements) => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await servers.shared.boot.query(`DO $$ BEGIN CREATE ROLE reporting NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await fill(source, ['CREATE TABLE one (id int)']);
    await fill(target, statements);
    expect((await copy(source, target)).result).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'The new database is not empty; nothing was changed.' });
  }, 60_000);

  it.each([
    ['an extension, when moving onto the shared server', 'boot', [`CREATE EXTENSION pgcrypto`], { MOVE_BLOCK_EXTENSIONS: '1' }, /uses 1 extension\(s\) that cannot be installed on the new server yet/],
    ['an extension that keeps data of its own, wherever it moves', 'boot', [`CREATE EXTENSION citext`, `CREATE TABLE citext_settings (k text)`, `UPDATE pg_extension SET extconfig = ARRAY['citext_settings'::regclass::oid] WHERE extname = 'citext'`], {}, /1 extension\(s\) that keep data of their own/],
    ['a setting made on the database itself', 'boot', [`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET statement_timeout = 5000', current_database()); END $$`], {}, /1 setting\(s\) made on the database or the app's role/],
    ['execute taken away from everyone on a function', 'app', [`CREATE FUNCTION secret() RETURNS int LANGUAGE sql AS 'SELECT 1'`, `REVOKE EXECUTE ON FUNCTION secret() FROM PUBLIC`], {}, /privilege\(s\) granted or taken away that the copy cannot carry over/],
    ['a table readable by another role', 'app', [`CREATE TABLE shared_out (id int)`, `GRANT SELECT ON shared_out TO reporting`], {}, /1 privilege\(s\) granted or taken away/],
    ['a column readable by another role', 'app', [`CREATE TABLE shared_out (id int, secret text)`, `GRANT SELECT (id) ON shared_out TO reporting`], {}, /privilege\(s\) granted or taken away/],
    ['a default privilege for another role', 'app', [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting`], {}, /1 privilege\(s\) granted or taken away/],
    ['a default privilege taken away from everyone', 'app', [`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`], {}, /privilege\(s\) granted or taken away/],
    ['use of the public schema taken away from everyone', 'app', [`REVOKE USAGE ON SCHEMA public FROM PUBLIC`], {}, /privilege\(s\) granted or taken away/],
    ['everyone allowed to create in the public schema', 'app', [`GRANT CREATE ON SCHEMA public TO PUBLIC`], {}, /privilege\(s\) granted or taken away/],
    ['a composite type usable only by some', 'app', [`CREATE TYPE pair AS (a int, b int)`, `REVOKE USAGE ON TYPE pair FROM PUBLIC`], {}, /privilege\(s\) granted or taken away/],
    ['a large object readable by another role', 'app', [`SELECT lo_from_bytea(77001, '\\x01')`, `GRANT SELECT ON LARGE OBJECT 77001 TO reporting`], {}, /owned by a role other than the app's own, or large objects with privileges of their own/],
    ['a table owned by another role', 'boot', [`CREATE TABLE not_ours (id int)`], {}, /1 object\(s\) owned by a role other than the app's own/],
    ['a publication', 'app', [`CREATE TABLE feed (id int)`, `CREATE PUBLICATION feed_out FOR TABLE feed`], {}, /publication\(s\), subscription\(s\), event trigger\(s\) or foreign data object\(s\)/],
  ])('refuses %s before touching the new database', async (_what, as, statements, env, message) => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await servers.own.boot.query(`DO $$ BEGIN CREATE ROLE reporting NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    const client = as === 'boot' ? await connect('own', 'boot', undefined, source.name) : await connect('own', source.login, PASSWORD, source.name);
    for (const statement of statements) await client.query(statement);
    await close(client);
    const { result, output } = await copy(source, target, env);
    expect(result, output).toMatchObject({ ok: false, stage: 'dump', targetChanged: false, error: expect.stringMatching(message) });
    expect(result.error).toMatch(/nothing was changed/);
    expect(await publicRelations(target)).toBe('0');
  }, 60_000);

  it('carries on when the only grants are to a role Hypervibe re-creates access for itself', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await servers.own.boot.query(`DO $$ BEGIN CREATE ROLE "waker@demo-project.iam" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await fill(source, [`CREATE TABLE jobs (id int)`, `GRANT USAGE ON SCHEMA public TO "waker@demo-project.iam"`, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO "waker@demo-project.iam"`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "waker@demo-project.iam"`]);
    expect((await copy(source, target)).result).toMatchObject({ ok: false, stage: 'dump', targetChanged: false, error: expect.stringMatching(/3 privilege\(s\)/) });
    expect((await copy(source, target, { MOVE_IGNORED_GRANTEES: 'someone-else,waker@demo-project.iam' })).result).toMatchObject({ ok: true, match: true });
  }, 60_000);

  it('copies a database that uses an extension its new owner may install', async () => {
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

  it('restores a source whose public schema was once recreated, and one with a schema whose name merely starts with "public"', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source, ['DROP SCHEMA public CASCADE', 'CREATE SCHEMA public', 'GRANT USAGE ON SCHEMA public TO PUBLIC', `COMMENT ON SCHEMA public IS 'recreated'`, 'CREATE TABLE kept (id int)', 'INSERT INTO kept VALUES (1)',
      `CREATE SCHEMA "public ${source.owner}"`, `CREATE TABLE "public ${source.owner}".also_kept (id int)`, `INSERT INTO "public ${source.owner}".also_kept VALUES (1), (2)`]);
    const { result, output } = await copy(source, target);
    expect(result, output).toMatchObject({ ok: true, match: true, source: { tables: 2, rows: '3' } });
    expect(await scalar(target, `SELECT count(*)::text FROM "public ${source.owner}".also_kept`)).toBe('2');
    // What the person wrote on the public schema comes along.
    expect(await scalar(target, `SELECT obj_description('public'::regnamespace)`)).toBe('recreated');
  }, 60_000);

  it('reports a restore that stopped part-way as a changed target, and says nothing of what the database said', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    // A policy for a role that exists only on the source's server: the restore fails on a statement that names it.
    await fill(source, ['CREATE TABLE guarded (id int, card text)', `INSERT INTO guarded VALUES (1, 'private-card-number')`, 'ALTER TABLE guarded ENABLE ROW LEVEL SECURITY', `CREATE POLICY own_rows ON guarded TO ${source.login} USING (true)`]);
    const { result, output } = await copy(source, target);
    expect(result).toMatchObject({ ok: false, stage: 'restore', targetChanged: true, error: expect.stringMatching(/^The copy could not be written to the new database \(pg_restore exit [1-9][0-9]*\)\.$/) });
    expect(output).not.toMatch(new RegExp(`${source.login}|private-card-number|ERROR|${PASSWORD}`));
    expect(databaseMoveCopyVerified(result)).toBe(false);
    // What it left is cleared by the next attempt only because the caller allows it.
    expect((await copy(source, target)).result).toMatchObject({ ok: false, stage: 'check', error: 'The new database is not empty; nothing was changed.' });
  }, 60_000);

  it('ends in a result line, not silence, when the session holding the snapshot dies', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source, ['CREATE TABLE one (id int)']);
    const dying = path.join(root!, 'dying-psql');
    mkdirSync(dying, { recursive: true });
    // The session that holds the snapshot is the only psql call on the source whose answers are not read back through a pipe.
    writeFileSync(path.join(dying, 'psql'), '#!/bin/sh\ncase " $* " in *" -c "*) exec "$REAL_BIN/psql" "$@" ;; esac\nif [ "$1" = "$SOURCE_DATABASE_URL" ] && [ ! -p /dev/stdout ]; then exit 3; fi\nexec "$REAL_BIN/psql" "$@"\n');
    chmodSync(path.join(dying, 'psql'), 0o755);
    const { result } = await copy(source, target, {}, undefined, `${dying}:`);
    expect(result).toEqual({ ok: false, stage: 'dump', targetChanged: false, error: 'The source database could not be read at one point in time; nothing was changed.' });
    expect(await publicRelations(target)).toBe('0');
  }, 60_000);

  it('refuses two servers on different major versions', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    const older = path.join(root!, 'older-psql');
    mkdirSync(older, { recursive: true });
    writeFileSync(path.join(older, 'psql'), `#!/bin/sh\ncase "$*" in *server_version_num*) if [ "$1" = "$SOURCE_DATABASE_URL" ]; then echo ${(major - 1) * 10000 + 8}; exit 0; fi ;; esac\nexec "$REAL_BIN/psql" "$@"\n`);
    chmodSync(path.join(older, 'psql'), 0o755);
    expect((await copy(source, target, {}, undefined, `${older}:`)).result).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'The two databases run different PostgreSQL major versions; nothing was changed.' });
  }, 60_000);

  it('carries a comment someone put on an ordinary public schema', async () => {
    const source = await sharedDatabase();
    const target = await ownDatabase();
    await fill(source, [`COMMENT ON SCHEMA public IS 'billing data'`, 'CREATE TABLE one (id int)']);
    expect((await copy(source, target)).result).toMatchObject({ ok: true, match: true });
    expect(await scalar(target, `SELECT obj_description('public'::regnamespace)`)).toBe('billing data');
  }, 60_000);

  it('does not certify a copy whose extension arrived at another version', async () => {
    const source = await sharedDatabase();
    const target = await ownDatabase();
    const inside = await connect('shared', 'boot', undefined, source.name);
    await inside.query(`CREATE EXTENSION citext VERSION '1.5'`);
    await close(inside);
    await fill(source, [`CREATE TABLE people (email citext)`]);
    const { result, output } = await copy(source, target);
    expect(result, output).toMatchObject({ ok: true, match: false, different: ['extensions'] });
    expect(databaseMoveCopyVerified(result)).toBe(false);
  }, 60_000);

  it.each([
    ['another role may connect to the source database', 'source', (name: string) => [`GRANT CONNECT ON DATABASE ${name} TO reporting`], 'dump', /database itself grants access to 1 other role/],
    ['another role may connect to the new database', 'target', (name: string) => [`GRANT CONNECT ON DATABASE ${name} TO reporting`], 'check', /new database itself grants access to 1 other role/],
    ['the new database has a setting of its own', 'target', (name: string) => [`ALTER DATABASE ${name} SET work_mem = '8MB'`], 'check', /new database has 1 setting\(s\) made on the database or the app's role/],
    ['the app\'s role on the source has a setting of its own', 'source', (_name: string, owner: string) => [`ALTER ROLE ${owner} SET search_path = audit`], 'dump', /1 setting\(s\) made on the database or the app's role/],
    ['the source database subscribes to another', 'source', () => [`CREATE SUBSCRIPTION hv_test_in CONNECTION 'dbname=nowhere' PUBLICATION p WITH (connect = false)`], 'dump', /1 subscription\(s\)/],
    ['the new database subscribes to another', 'target', () => [`CREATE SUBSCRIPTION hv_test_out CONNECTION 'dbname=nowhere' PUBLICATION p WITH (connect = false)`], 'check', /new database has 1 subscription\(s\)/],
  ] as Array<[string, 'source' | 'target', (name: string, owner: string) => string[], string, RegExp]>)('refuses when %s', async (_what, where, statements, stage, message) => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source, ['CREATE TABLE one (id int)']);
    const changed = where === 'source' ? source : target;
    for (const server of [servers.own.boot, servers.shared.boot]) await server.query(`DO $$ BEGIN CREATE ROLE reporting NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    const inside = await connect(changed.side, 'boot', undefined, changed.name);
    for (const statement of statements(changed.name, changed.owner)) await inside.query(statement);
    const { result, output } = await copy(source, target);
    expect(result, output).toMatchObject({ ok: false, stage, targetChanged: false, error: expect.stringMatching(message) });
    expect(await publicRelations(target)).toBe('0');
    await inside.query(`DROP SUBSCRIPTION IF EXISTS hv_test_in`).catch(() => {});
    await inside.query(`DROP SUBSCRIPTION IF EXISTS hv_test_out`).catch(() => {});
    await close(inside);
  }, 60_000);

  it('refuses two databases created with a different encoding or sort order', async () => {
    const source = await ownDatabase(`ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    const target = await sharedDatabase();
    await fill(source, ['CREATE TABLE one (id int)']);
    expect((await copy(source, target)).result).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'The two databases were created with a different text encoding or sort order; nothing was changed.' });
  }, 60_000);

  it.each([
    ['may also change rows', [`GRANT UPDATE ON jobs TO "waker@demo-project.iam"`]],
    ['may read only one of the tables, which giving access again would widen', [`REVOKE SELECT ON more_jobs FROM "waker@demo-project.iam"`]],
    ['has no default access to new tables, which giving access again would add', [`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM "waker@demo-project.iam"`]],
    ['may read a single column elsewhere', [`CREATE SCHEMA audit`, `CREATE TABLE audit.log (id int, who text)`, `GRANT SELECT (id) ON audit.log TO "waker@demo-project.iam"`]],
  ])('refuses when a role whose access Hypervibe gives again %s', async (_what, extra) => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await servers.own.boot.query(`DO $$ BEGIN CREATE ROLE "waker@demo-project.iam" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await fill(source, [`CREATE TABLE jobs (id int)`, `CREATE TABLE more_jobs (id int)`, `CREATE VIEW open_jobs AS SELECT id FROM jobs`, `GRANT USAGE ON SCHEMA public TO "waker@demo-project.iam"`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO "waker@demo-project.iam"`, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "waker@demo-project.iam"`]);
    // Exactly what Hypervibe grants, on every table and view: carried on.
    expect((await copy(source, target, { MOVE_IGNORED_GRANTEES: 'waker@demo-project.iam', MOVE_REHEARSAL: '1' })).result).toMatchObject({ ok: true, match: true });
    await fill(source, extra);
    const { result, output } = await copy(source, target, { MOVE_IGNORED_GRANTEES: 'waker@demo-project.iam', MOVE_RESET_TARGET: '1' });
    expect(result, output).toMatchObject({ ok: false, stage: 'dump', targetChanged: false, error: expect.stringMatching(/privilege\(s\) granted or taken away/) });
  }, 60_000);

  it('refuses a connection that names more than one server', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source, ['CREATE TABLE one (id int)']);
    const elsewhere = `postgresql://${target.login}:${PASSWORD}@${encodeURIComponent(servers.shared.socket)},${encodeURIComponent(servers.own.socket)}:5432/${target.name}`;
    for (const pair of [[source, { ...target, url: elsewhere }], [{ ...source, url: `${source.url}?host=${servers.own.socket},${servers.shared.socket}` }, target]] as const) {
      expect((await copy(pair[0], pair[1], { MOVE_RESET_TARGET: '1' })).result).toEqual({ ok: false, stage: 'check', targetChanged: false, error: 'A connection names more than one server; nothing was changed.' });
    }
  }, 60_000);

  it('deletes nothing from a target that also holds something of another owner, even when clearing is allowed', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source, ['CREATE TABLE one (id int)']);
    await fill(target, ['CREATE TABLE ours (id int)', 'INSERT INTO ours VALUES (1)']);
    const boot = await connect('shared', 'boot', undefined, target.name);
    await boot.query(`CREATE FUNCTION public.theirs() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    const { result, output } = await copy(source, target, { MOVE_RESET_TARGET: '1' });
    expect(result, output).toMatchObject({ ok: false, stage: 'check', targetChanged: false, error: expect.stringMatching(/new database holds .*owned by a role other than the app's own.*nothing was changed/) });
    expect(await scalar(target, 'SELECT count(*)::text FROM ours')).toBe('1');
    // The same for a table of another owner, which cannot even be read.
    await boot.query('DROP FUNCTION public.theirs()');
    await boot.query('CREATE TABLE public.their_table (id int)');
    await close(boot);
    expect((await copy(source, target, { MOVE_RESET_TARGET: '1' })).result).toMatchObject({ ok: false, stage: 'check', targetChanged: false });
    expect(await scalar(target, 'SELECT count(*)::text FROM ours')).toBe('1');
  }, 60_000);

  it('fails, never passes, when the definitions of one side cannot be written out', async () => {
    const source = await ownDatabase();
    const target = await sharedDatabase();
    await fill(source, ['CREATE TABLE one (id int)']);
    const broken = path.join(root!, 'broken-restore');
    mkdirSync(broken, { recursive: true });
    // Writing a definitions file "succeeds" and leaves it empty, as a full disk can.
    writeFileSync(path.join(broken, 'pg_restore'), '#!/bin/sh\ncase " $* " in *" -f "*) for A in "$@"; do case "$A" in *.rendered) : > "$A"; exit 0 ;; esac; done ;; esac\nexec "$REAL_BIN/pg_restore" "$@"\n');
    chmodSync(path.join(broken, 'pg_restore'), 0o755);
    const { result } = await copy(source, target, {}, undefined, `${broken}:`);
    expect(result).toMatchObject({ ok: false, targetChanged: false });
    expect(databaseMoveCopyVerified(result)).toBe(false);
  }, 60_000);

  describe('when PostgreSQL writes its definitions between per-run \\restrict and \\unrestrict lines (17.6 and later)', () => {
    const keyed = { WRAP_KEYS: '1' };
    const body = (line: string) => `CREATE OR REPLACE FUNCTION banner() RETURNS text LANGUAGE sql AS $$ SELECT 'first\n${line}\n\nlast' $$`;

    it('still matches a faithful copy: the two keys differ on every run and say nothing about the database', async () => {
      const source = await ownDatabase();
      const target = await sharedDatabase();
      await fill(source);
      const { result, output } = await copy(source, target, keyed);
      expect(result, output).toMatchObject({ ok: true, match: true, different: [] });
      expect(databaseMoveCopyVerified(result)).toBe(true);
    }, 60_000);

    it.each([
      ['a changed function body', body('-- changed')],
      ['a body line that itself looks like such a line', body('\\restrict 0123456789abcdef')],
      ['a body line that is such a line with another key', body('\\unrestrict ffffffffffffffffffffffffffffffff')],
    ])('still does not certify a copy with %s', async (_what, change) => {
      const source = await ownDatabase();
      const target = await sharedDatabase();
      await fill(source);
      const { result, output } = await copy(source, target, keyed, change);
      expect(result, output).toMatchObject({ ok: true, match: false, different: ['definitions'] });
    }, 60_000);

    it('keeps such a line that the app itself wrote, on both sides', async () => {
      const source = await ownDatabase();
      const target = await sharedDatabase();
      await fill(source, [`CREATE FUNCTION banner() RETURNS text LANGUAGE sql AS $$ SELECT 'a\n\\restrict 0123456789abcdef\nb' $$`]);
      expect((await copy(source, target, keyed)).result).toMatchObject({ ok: true, match: true });
      expect((await copy(source, target, { ...keyed, MOVE_RESET_TARGET: '1' }, `CREATE OR REPLACE FUNCTION banner() RETURNS text LANGUAGE sql AS $$ SELECT 'a\nb' $$`)).result).toMatchObject({ ok: true, match: false, different: ['definitions'] });
    }, 60_000);
  });
});
