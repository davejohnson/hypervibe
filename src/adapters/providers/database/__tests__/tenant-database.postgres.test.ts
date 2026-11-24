import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TENANT_WRITER_LOCK, TenantBusyError, TenantLockNotReleasedError, TenantRefusedError, TenantServerUnsupportedError, dropTenant, ensureTenant, listTenants, observeTenant, retireTenantLogin,
  setTenantLoginPassword, tenantNames, type TenantServer, type TenantSession,
} from '../tenant-database.js';

/**
 * Tenant isolation proven on a real, disposable PostgreSQL reached over a Unix
 * socket with SCRAM passwords. Everything the module does runs as an
 * administrator with CREATEROLE and CREATEDB only, as on a managed service
 * where the administrator is not a superuser. The bootstrap superuser is used
 * only to create that administrator and to plant fixtures.
 */
const ADMIN = 'tenant_admin';
const ADMIN_PASSWORD = 'synthetic-admin-password';
const PASSWORD = (label: string) => `synthetic-${label}-password-0123456789`;

function postgresBin(): string {
  const candidates = [process.env.HYPERVIBE_TEST_POSTGRES_BIN, '/Applications/Postgres.app/Contents/Versions/16/bin'].filter((entry): entry is string => Boolean(entry));
  try { candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()); } catch { /* runner installation below */ }
  if (existsSync('/usr/lib/postgresql')) for (const version of readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) candidates.push(`/usr/lib/postgresql/${version}/bin`);
  const bin = candidates.find((candidate) => existsSync(path.join(candidate, 'initdb')) && existsSync(path.join(candidate, 'pg_ctl')));
  if (!bin) throw new Error('PostgreSQL tools are required for the tenant database tests.');
  return bin;
}

const bin = postgresBin();
/** Known before the tests are collected, so a server too old for the module runs the refusal tests instead. */
const major = Number(/\(PostgreSQL\) (\d+)/.exec(execFileSync(`${bin}/postgres`, ['--version'], { encoding: 'utf8' }))?.[1]);
const supported = major >= 15;
let directory: string | undefined;
let socket: string;
let version = 0;
let boot: pg.Client;
let adminClient: pg.Client;
let server: TenantServer;
const opened = new Set<pg.Client>();

const stopServer = () => {
  if (directory && existsSync(path.join(directory, 'data/postmaster.pid'))) spawnSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
};

async function connect(user: string, password: string | undefined, database: string): Promise<pg.Client> {
  const client = new pg.Client({ host: socket, user, password, database, connectionTimeoutMillis: 10_000 });
  // A session ended by the server (drop, retire) must not crash the test process.
  client.on('error', () => {});
  await client.connect();
  opened.add(client);
  return client;
}
const close = async (client: pg.Client) => { opened.delete(client); await client.end().catch(() => {}); };
const code = (error: unknown) => (error as { code?: string }).code;
const sqlState = async (work: Promise<unknown>): Promise<string> => work.then(() => 'ok', (error) => code(error) ?? `no code: ${String(error)}`);
/** Connects, runs one statement and closes; resolves to 'ok' or the PostgreSQL error code. */
const attempt = (user: string, password: string, database: string, statement = 'SELECT 1') => sqlState((async () => {
  const client = await connect(user, password, database);
  try { await client.query(statement); } finally { await close(client); }
})());

const adminServer = (wrap: (session: TenantSession) => TenantSession = (session) => session, client: pg.Client = adminClient): TenantServer => ({
  admin: wrap({ query: (text, values) => client.query(text, values) }),
  inDatabase: async (database, work) => {
    const client = await connect(ADMIN, ADMIN_PASSWORD, database);
    try { return await work(wrap({ query: (text, values) => client.query(text, values) })); } finally { await close(client); }
  },
});

interface Tenant { key: string; names: ReturnType<typeof tenantNames>; tenantId: string }
const tenant = (key: string): Tenant => ({ key, names: tenantNames(key), tenantId: `project-1:${key}` });
const identity = (target: Tenant) => ({ names: target.names, tenantId: target.tenantId });
/** A ready tenant whose first login has a password. */
async function ready(key: string, connectionLimit = 10): Promise<Tenant> {
  const target = tenant(key);
  await ensureTenant(server, { ...identity(target), connectionLimit, allocate: true });
  await setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[0], password: PASSWORD(`${key}-a`) });
  return target;
}
const loginA = (target: Tenant, database = target.names.database) => connect(target.names.logins[0], PASSWORD(`${target.key}-a`), database);
const scalar = async (client: pg.Client, text: string, values?: unknown[]) => Object.values((await client.query(text, values)).rows[0] ?? {})[0];
const roleNames = async (target: Tenant) => (await boot.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1', [[target.names.owner, ...target.names.logins]])).rows.map((row) => row.rolname);
/** The server's own inventory, as `database:state`. */
const inventory = async () => (await listTenants(server)).map((entry) => `${entry.names.database}:${entry.state}`);
const refusal = async (work: Promise<unknown>) => work.then(() => 'not refused', (error: unknown) => error instanceof TenantRefusedError ? error.standing : `threw ${String(error)}`);
/** A login that has been switched off is turned away for its password or for the role itself, whichever the server checks first. */
const DENIED = ['28P01', '28000'];
const databaseExists = async (name: string) => (await boot.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows.length === 1;

beforeAll(async () => {
  // A short path: Unix socket paths are limited to about 100 characters.
  directory = mkdtempSync('/tmp/hv-tenant-');
  process.once('exit', stopServer);
  const data = path.join(directory, 'data');
  socket = path.join(directory, 'socket');
  mkdirSync(socket);
  execFileSync(`${bin}/initdb`, ['-D', data, '-U', 'boot', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { stdio: 'pipe' });
  writeFileSync(path.join(data, 'postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\nmax_connections = 60\n`);
  writeFileSync(path.join(data, 'pg_hba.conf'), 'local all boot trust\nlocal all all scram-sha-256\n');
  execFileSync(`${bin}/pg_ctl`, ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', 'start'], { stdio: 'pipe' });
  boot = await connect('boot', undefined, 'postgres');
  version = Number(await scalar(boot, `SELECT current_setting('server_version_num')::int`));
  await boot.query(`CREATE ROLE ${ADMIN} LOGIN CREATEROLE CREATEDB PASSWORD '${ADMIN_PASSWORD}'`);
  // A role nothing was ever done for: the yardstick for what any login on the server can reach.
  await boot.query(`CREATE ROLE fresh_role LOGIN PASSWORD '${PASSWORD('fresh')}'`);
  adminClient = await connect(ADMIN, ADMIN_PASSWORD, 'postgres');
  server = adminServer();
  console.info(`tenant database tests ran on PostgreSQL ${version} from ${bin}`);
}, 60_000);

afterEach(async () => {
  for (const client of [...opened]) if (client !== boot && client !== adminClient) await close(client);
});

afterAll(async () => {
  try {
    for (const client of [...opened]) await close(client);
  } finally {
    stopServer();
    if (directory) {
      const stopped = !existsSync(path.join(directory, 'data/postmaster.pid'));
      rmSync(directory, { recursive: true, force: true });
      expect(stopped).toBe(true);
    }
  }
});

describe('tenant names and input checks', () => {
  it('derives deterministic names', () => {
    expect(tenantNames('staging')).toEqual({ database: 'app_staging', owner: 'app_staging_owner', logins: ['app_staging_a', 'app_staging_b'] });
    expect(tenantNames('pr_12')).toEqual(tenantNames('pr_12'));
  });

  it.each(['', 'A', 'a-b', 'a b', '_a', 'a_', 'a__b', 'a"; DROP DATABASE postgres; --', 'a\'b', 'a\u0000', 'é', 'x'.repeat(41), 'a\n'])('rejects the key %j', (key) => {
    expect(() => tenantNames(key)).toThrow(/tenant key/);
  });

  it('rejects hostile or malformed input before any SQL runs', async () => {
    const statements: string[] = [];
    const recording = adminServer((session) => ({ query: (text, values) => { statements.push(text); return session.query(text, values); } }));
    const good = tenant('checks');
    const badNames = [
      { ...good.names, database: 'postgres' },
      { ...good.names, database: 'app_checks"; DROP DATABASE postgres; --' },
      { ...good.names, owner: 'tenant_admin' },
      { ...good.names, owner: tenantNames('other').owner },
      { ...good.names, logins: [good.names.logins[0], 'boot'] as const },
      { ...good.names, logins: [good.names.logins[0]] as unknown as readonly [string, string] },
      undefined as unknown as typeof good.names,
    ];
    for (const names of badNames) {
      await expect(ensureTenant(recording, { names, tenantId: good.tenantId, connectionLimit: 5, allocate: true })).rejects.toThrow();
      await expect(observeTenant(recording, { names, tenantId: good.tenantId })).rejects.toThrow();
      await expect(dropTenant(recording, { names, tenantId: good.tenantId })).rejects.toThrow();
      await expect(setTenantLoginPassword(recording, { names, tenantId: good.tenantId, login: good.names.logins[0], password: PASSWORD('x') })).rejects.toThrow();
      await expect(retireTenantLogin(recording, { names, tenantId: good.tenantId, login: good.names.logins[0] })).rejects.toThrow();
    }
    for (const tenantId of ['', 'x\'; DROP ROLE boot; --', 'a b', '$tenant$', 'a\nb', '-a', 'x'.repeat(129), 7 as unknown as string]) {
      await expect(ensureTenant(recording, { names: good.names, tenantId, connectionLimit: 5, allocate: true })).rejects.toThrow(/tenant id/);
      await expect(observeTenant(recording, { names: good.names, tenantId })).rejects.toThrow(/tenant id/);
      await expect(dropTenant(recording, { names: good.names, tenantId })).rejects.toThrow(/tenant id/);
    }
    for (const connectionLimit of [0, -1, 1.5, Number.NaN, 10_001, '5; DROP DATABASE postgres' as unknown as number]) {
      await expect(ensureTenant(recording, { ...identity(good), connectionLimit, allocate: true })).rejects.toThrow(/connection limit/);
    }
    for (const login of ['boot', ADMIN, good.names.owner, tenantNames('other').logins[0], 'app_checks_a"; --']) {
      await expect(setTenantLoginPassword(recording, { ...identity(good), login, password: PASSWORD('x') })).rejects.toThrow(/does not belong/);
      await expect(retireTenantLogin(recording, { ...identity(good), login })).rejects.toThrow(/does not belong/);
    }
    await expect(setTenantLoginPassword(recording, { ...identity(good), login: good.names.logins[0], password: 'short' })).rejects.toThrow(/at least 16/);
    // 5. Only a real boolean says whether a database may be created; "false" as text would otherwise count as yes.
    for (const allocate of ['false', 'true', 1, 0, null, undefined, {}]) {
      await expect(ensureTenant(recording, { ...identity(good), connectionLimit: 5, allocate: allocate as unknown as boolean })).rejects.toThrow(/allocate/);
    }
    await expect(ensureTenant({ ...recording, lockWaitMs: -1 }, { ...identity(good), connectionLimit: 5, allocate: true })).rejects.toThrow(/lock wait/);
    expect(statements).toEqual([]);
    expect(await databaseExists(good.names.database)).toBe(false);
  });
});

describe.skipIf(supported)('a server older than PostgreSQL 15', () => {
  it('3. is refused by every function, with nothing changed', async () => {
    const statements: string[] = [];
    const recording = adminServer((session) => ({ query: (text, values) => { statements.push(text); return session.query(text, values); } }));
    const target = tenant('old');
    const calls = [
      () => ensureTenant(recording, { ...identity(target), connectionLimit: 5, allocate: true }),
      () => setTenantLoginPassword(recording, { ...identity(target), login: target.names.logins[0], password: PASSWORD('old') }),
      () => retireTenantLogin(recording, { ...identity(target), login: target.names.logins[0] }),
      () => dropTenant(recording, identity(target)),
      () => observeTenant(recording, identity(target)),
      () => listTenants(recording),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(TenantServerUnsupportedError);
    expect(statements.filter((text) => !/^\s*SELECT\b/.test(text))).toEqual([]);
    expect(await scalar(boot, `SELECT count(*)::int FROM pg_roles WHERE rolname LIKE 'app\\_%'`)).toBe(0);
    expect(await databaseExists(target.names.database)).toBe(false);
  });
});

describe.skipIf(!supported)('tenants on one server (real PostgreSQL, non-superuser administrator)', () => {
  let one: Tenant;
  let two: Tenant;
  const ONLY_TWO = ['app_two:ready'];

  it('runs as an administrator that is not a superuser', async () => {
    expect((await adminClient.query('SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0])
      .toEqual({ rolsuper: false, rolcreaterole: true, rolcreatedb: true, rolreplication: false, rolbypassrls: false });
    expect(await listTenants(server)).toEqual([]);
  });

  it('1. gives each tenant its own database and keeps every other tenant out', async () => {
    one = await ready('one');
    two = await ready('two');
    expect(await listTenants(server)).toEqual([one, two].map((target) => ({
      ...identity(target), state: 'ready', database: 'finished', roles: [target.names.owner, ...target.names.logins], foreignRoles: [],
    })));
    expect(await observeTenant(server, identity(one))).toMatchObject({ state: 'ready', database: 'finished' });

    for (const [mine, theirs] of [[one, two], [two, one]] as const) {
      const client = await loginA(mine);
      // The login acts as the tenant's owner role.
      expect((await client.query('SELECT session_user::text AS login, current_user::text AS acting')).rows[0]).toEqual({ login: mine.names.logins[0], acting: mine.names.owner });
      await client.query('CREATE TABLE notes (id int PRIMARY KEY, body text)');
      await client.query(`INSERT INTO notes VALUES (1, $1)`, [mine.key]);
      expect(await scalar(client, 'SELECT body FROM notes')).toBe(mine.key);
      await client.query('CREATE SCHEMA extra');
      await client.query('CREATE TEMPORARY TABLE scratch (i int)');

      // The other tenant's database refuses the connection outright, with either of this tenant's logins.
      expect(await attempt(mine.names.logins[0], PASSWORD(`${mine.key}-a`), theirs.names.database)).toBe('42501');
      expect(await scalar(boot, `SELECT has_database_privilege($1::name, $2::text, 'CONNECT') OR has_database_privilege($1::name, $2::text, 'TEMPORARY') OR has_database_privilege($1::name, $2::text, 'CREATE')`, [mine.names.logins[1], theirs.names.database])).toBe(false);
      expect(await scalar(boot, `SELECT has_database_privilege($1::name, $2::text, 'CONNECT')`, [mine.names.owner, theirs.names.database])).toBe(false);

      // Everywhere else it can do exactly what a role nothing was done for can do, and no more.
      const others = (await boot.query('SELECT datname FROM pg_database WHERE datname <> $1 ORDER BY 1', [mine.names.database])).rows.map((row) => row.datname as string);
      expect(others).toEqual(expect.arrayContaining(['postgres', 'template0', 'template1', theirs.names.database]));
      for (const database of others) {
        for (const privilege of ['CONNECT', 'CREATE', 'TEMPORARY']) {
          expect(await scalar(boot, `SELECT has_database_privilege($1::name, $2::text, $3::text)`, [mine.names.logins[0], database, privilege]), `${privilege} on ${database}`)
            .toBe(await scalar(boot, `SELECT has_database_privilege('fresh_role'::name, $1::text, $2::text)`, [database, privilege]));
        }
      }
      for (const database of ['postgres', 'template1', 'template0']) {
        for (const statement of ['SELECT 1', 'CREATE TABLE public.intruder (i int)', 'CREATE SCHEMA intruder']) {
          const fresh = await attempt('fresh_role', PASSWORD('fresh'), database, `BEGIN; ${statement}; ROLLBACK`);
          expect(await attempt(mine.names.logins[0], PASSWORD(`${mine.key}-a`), database, `BEGIN; ${statement}; ROLLBACK`), `${statement} in ${database}`).toBe(fresh);
        }
      }

      // It is a plain role: no server-wide powers, and no membership in the administrator or the other tenant.
      const plain = await boot.query(
        `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, pg_has_role(oid, $2::name, 'MEMBER') AS admin_member,
           pg_has_role(oid, $3::name, 'MEMBER') AS other_member FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1`,
        [[mine.names.owner, ...mine.names.logins], ADMIN, theirs.names.owner]);
      expect(plain.rows).toHaveLength(3);
      for (const row of plain.rows) expect(row).toEqual({ rolname: row.rolname, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, admin_member: false, other_member: false });

      const refused = [
        `DROP DATABASE ${theirs.names.database}`,
        `DROP DATABASE ${theirs.names.database} WITH (FORCE)`,
        `ALTER DATABASE ${theirs.names.database} CONNECTION LIMIT 100`,
        `ALTER DATABASE ${theirs.names.database} RENAME TO stolen`,
        `ALTER DATABASE ${theirs.names.database} OWNER TO ${mine.names.owner}`,
        `GRANT CONNECT ON DATABASE ${theirs.names.database} TO ${mine.names.owner}`,
        `COMMENT ON DATABASE ${theirs.names.database} IS 'hypervibe-tenant:${mine.tenantId}'`,
        ...[theirs.names.owner, ...theirs.names.logins].flatMap((role) => [
          `DROP ROLE ${role}`, `ALTER ROLE ${role} PASSWORD 'stolen-password-0123456789'`, `ALTER ROLE ${role} NOLOGIN`, `ALTER ROLE ${role} RENAME TO stolen`,
          `ALTER ROLE ${role} SET search_path = 'stolen'`, `GRANT ${role} TO ${mine.names.logins[0]}`, `SET ROLE ${role}`, `COMMENT ON ROLE ${role} IS 'stolen'`,
        ]),
        `SET ROLE ${ADMIN}`, `GRANT ${ADMIN} TO ${mine.names.logins[0]}`, `ALTER ROLE ${ADMIN} PASSWORD 'stolen-password-0123456789'`,
        'CREATE ROLE intruder', 'CREATE ROLE intruder LOGIN SUPERUSER', 'CREATE DATABASE intruder',
        `ALTER ROLE ${mine.names.logins[0]} CREATEDB`, `ALTER ROLE ${mine.names.logins[0]} CREATEROLE`, `ALTER ROLE ${mine.names.logins[0]} SUPERUSER`,
        // Its own caps and its own database stay the administrator's: no lifting a limit, reopening, forging the marker or dropping.
        `ALTER ROLE ${mine.names.logins[0]} CONNECTION LIMIT 1000`,
        `ALTER DATABASE ${mine.names.database} CONNECTION LIMIT 1000`,
        `ALTER DATABASE ${mine.names.database} SET search_path = 'public'`,
        `GRANT CONNECT ON DATABASE ${mine.names.database} TO PUBLIC`,
        `GRANT CONNECT ON DATABASE ${mine.names.database} TO ${theirs.names.owner}`,
        `COMMENT ON DATABASE ${mine.names.database} IS 'hypervibe-tenant:${theirs.tenantId}'`,
        `ALTER DATABASE ${mine.names.database} RENAME TO stolen`,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${theirs.names.database}'`,
      ];
      const holder = await loginA(theirs);
      const access = async () => (await boot.query(
        `SELECT datname, datacl::text, datconnlimit, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS comment,
           (SELECT array_agg(rolname || ':' || rolconnlimit ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'app\\_%') AS roles FROM pg_database ORDER BY 1`)).rows;
      const accessBefore = await access();
      // Granting on its own database without the right to grant is answered with a warning, not an error: nothing is granted.
      const warnsOnly = (statement: string) => statement.startsWith(`GRANT CONNECT ON DATABASE ${mine.names.database} `);
      for (const acting of ['owner role', 'login itself']) {
        await client.query(acting === 'owner role' ? `SET ROLE ${mine.names.owner}` : 'SET ROLE NONE');
        for (const statement of refused) {
          const outcome = await sqlState(client.query(statement));
          expect(outcome, `${statement} as the ${acting}`).toBe(warnsOnly(statement) ? 'ok' : '42501');
        }
      }
      // The session the hostile statements aimed at is still alive, and nothing was created or changed.
      expect(await scalar(holder, 'SELECT 1')).toBe(1);
      expect(await access()).toEqual(accessBefore);
      expect(await attempt(theirs.names.logins[0], PASSWORD(`${theirs.key}-a`), mine.names.database)).toBe('42501');
      expect(await attempt('fresh_role', PASSWORD('fresh'), mine.names.database)).toBe('42501');
      expect(await scalar(boot, `SELECT count(*)::int FROM pg_roles WHERE rolname IN ('intruder', 'stolen')`)).toBe(0);
      expect(await scalar(boot, `SELECT count(*)::int FROM pg_database WHERE datname IN ('intruder', 'stolen')`)).toBe(0);
    }
    const check = await loginA(two);
    expect(await scalar(check, 'SELECT body FROM notes')).toBe('two');
    expect(await scalar(check, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'`)).toBe(two.names.owner);
    expect(await scalar(boot, `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = $1`, [two.names.database])).toBe(ADMIN);
    // The schema's privileges moved with it: "the database owner" (the administrator) holds nothing on it by that title.
    expect(await scalar(check, `SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public'`)).toBe(`{${two.names.owner}=UC/${two.names.owner},=U/${two.names.owner}}`);
  }, 120_000);

  it('2. lets either login of a tenant use tables the other created', async () => {
    await setTenantLoginPassword(server, { ...identity(one), login: one.names.logins[1], password: PASSWORD('one-b') });
    const a = await loginA(one);
    const b = await connect(one.names.logins[1], PASSWORD('one-b'), one.names.database);
    expect(await scalar(b, 'SELECT current_user::text')).toBe(one.names.owner);
    expect(await scalar(b, 'SELECT body FROM notes WHERE id = 1')).toBe('one');
    await b.query(`INSERT INTO notes VALUES (2, 'from b')`);
    await b.query('ALTER TABLE notes ADD COLUMN seen boolean DEFAULT false');
    await b.query('CREATE TABLE made_by_b (i int)');
    await a.query('INSERT INTO made_by_b VALUES (1)');
    await a.query('DROP TABLE made_by_b');
    expect(await scalar(a, 'SELECT count(*)::int FROM notes WHERE NOT seen')).toBe(2);
    expect((await a.query(`SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows).toEqual([{ tablename: 'notes', tableowner: one.names.owner }]);
    // Leave the second login without a password again, as before a first rotation.
    expect(await retireTenantLogin(server, { ...identity(one), login: one.names.logins[1] })).toEqual({ remainingSessions: 0 });
  });

  it('3. rotates one tenant\'s password without disturbing the other tenant', async () => {
    const [oldLogin, newLogin] = one.names.logins;
    const twoSession = await loginA(two);
    const twoWorks = async () => {
      expect(await scalar(twoSession, 'SELECT body FROM notes')).toBe('two');
      expect(await attempt(two.names.logins[0], PASSWORD('two-a'), two.names.database, 'SELECT count(*) FROM notes')).toBe('ok');
    };
    const running = await loginA(one);
    expect(await attempt(newLogin, PASSWORD('one-rotated'), one.names.database)).toBe('28P01');
    await twoWorks();

    // Step one: the idle login gets a password. The running app is untouched and both logins work.
    await setTenantLoginPassword(server, { ...identity(one), login: newLogin, password: PASSWORD('one-rotated') });
    expect(await scalar(running, 'SELECT count(*)::int FROM notes')).toBe(2);
    expect(await attempt(oldLogin, PASSWORD('one-a'), one.names.database, 'SELECT count(*) FROM notes')).toBe('ok');
    expect(await attempt(newLogin, PASSWORD('one-rotated'), one.names.database, 'SELECT count(*) FROM notes')).toBe('ok');
    await twoWorks();
    // Running it again (an interrupted rotation repeated) changes nothing for anyone.
    await setTenantLoginPassword(server, { ...identity(one), login: newLogin, password: PASSWORD('one-rotated') });
    const switched = await connect(newLogin, PASSWORD('one-rotated'), one.names.database);
    await twoWorks();

    // Last step: the retired login can no longer log in and its open session is ended.
    expect(await retireTenantLogin(server, { ...identity(one), login: oldLogin })).toEqual({ remainingSessions: 0 });
    expect(await attempt(oldLogin, PASSWORD('one-a'), one.names.database)).toBe('28P01');
    await expect(running.query('SELECT 1')).rejects.toThrow();
    expect(await scalar(switched, 'SELECT count(*)::int FROM notes')).toBe(2);
    expect(await retireTenantLogin(server, { ...identity(one), login: oldLogin })).toEqual({ remainingSessions: 0 });
    expect(await scalar(switched, 'SELECT current_user::text')).toBe(one.names.owner);
    await twoWorks();
    // Neither tenant's password works for the other tenant's logins.
    expect(await attempt(two.names.logins[0], PASSWORD('one-rotated'), two.names.database)).toBe('28P01');
    expect(await attempt(two.names.logins[1], PASSWORD('two-a'), two.names.database)).toBe('28P01');
  });

  it('11. retiring a login returns only once its sessions are gone, and says so when they are not', async () => {
    const target = await ready('wait', 20);
    for (let index = 0; index < 12; index++) await loginA(target, index % 2 ? 'postgres' : target.names.database);
    expect(await retireTenantLogin(server, { ...identity(target), login: target.names.logins[0] })).toEqual({ remainingSessions: 0 });
    expect(await scalar(boot, `SELECT count(*)::int FROM pg_stat_activity WHERE usename = $1`, [target.names.logins[0]])).toBe(0);

    // Sessions that will not end cannot be produced on demand, so the session's answers are replaced for this one check.
    let checks = 0;
    const stuck = adminServer((session) => ({
      query: async (text, values) => {
        if (/count\(\*\)::int AS remaining/.test(text)) { checks++; return { rows: [{ remaining: 3 }] }; }
        return session.query(text, values);
      },
    }));
    expect(await retireTenantLogin({ ...stuck, sessionWaitMs: 300 }, { ...identity(target), login: target.names.logins[1] })).toEqual({ remainingSessions: 3 });
    expect(checks).toBeGreaterThan(1);
    expect(await dropTenant(server, identity(target))).toEqual({ database: 'dropped', remainingRoles: [] });
  });

  it('keeps passwords out of SQL text, results and errors', async () => {
    const secret = PASSWORD('never-shown');
    const statements: string[] = [];
    const failing = adminServer((session) => ({
      query: async (text, values) => {
        statements.push(`${text} ${JSON.stringify(values ?? [])}`);
        if (/PASSWORD/.test(text)) throw Object.assign(new Error(`driver echo: ${text} ${secret}`), { code: '57014', query: text, detail: secret });
        return session.query(text, values);
      },
    }));
    const failure = await setTenantLoginPassword(failing, { ...identity(two), login: two.names.logins[1], password: secret }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const shown = `${String(failure)} ${JSON.stringify(failure, Object.getOwnPropertyNames(failure as object))}`;
    expect(shown).toContain('57014');
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain('SCRAM-SHA-256');
    expect(statements.some((statement) => /ALTER ROLE "app_two_b" LOGIN PASSWORD 'SCRAM-SHA-256\$/.test(statement))).toBe(true);
    expect(statements.join('\n')).not.toContain(secret);
    expect(await setTenantLoginPassword(server, { ...identity(two), login: two.names.logins[1], password: secret })).toBeUndefined();
    await retireTenantLogin(server, { ...identity(two), login: two.names.logins[1] });
  });

  it('4. drops one tenant, with a connection open, and leaves the other working', async () => {
    const held = await connect(one.names.logins[1], PASSWORD('one-rotated'), one.names.database);
    const twoSession = await loginA(two);
    expect(await dropTenant(server, identity(one))).toEqual({ database: 'dropped', remainingRoles: [] });
    await expect(held.query('SELECT 1')).rejects.toThrow();
    expect(await databaseExists(one.names.database)).toBe(false);
    expect(await roleNames(one)).toEqual([]);
    expect(await inventory()).toEqual(ONLY_TWO);
    expect(await observeTenant(server, identity(one))).toEqual({ ...identity(one), state: 'absent', database: 'absent', roles: [], foreignRoles: [] });

    expect(await scalar(twoSession, 'SELECT body FROM notes')).toBe('two');
    await twoSession.query('CREATE TABLE after_drop (i int)');
    await twoSession.query('DROP TABLE after_drop');
    expect(await attempt(two.names.logins[0], PASSWORD('two-a'), two.names.database, 'SELECT count(*) FROM notes')).toBe('ok');
    expect(await roleNames(two)).toEqual([two.names.logins[0], two.names.logins[1], two.names.owner].sort());
    // Dropping what is already gone is a quiet repeat, and the tenant can be allocated again from nothing.
    expect(await dropTenant(server, identity(one))).toEqual({ database: 'absent', remainingRoles: [] });
    expect(await refusal(ensureTenant(server, { ...identity(one), connectionLimit: 10, allocate: false }))).toBe('absent');
    expect(await ensureTenant(server, { ...identity(one), connectionLimit: 10, allocate: true })).toEqual({ database: 'created' });
    expect(await attempt(one.names.logins[1], PASSWORD('one-rotated'), one.names.database)).toBe('28P01');
    expect(await dropTenant(server, identity(one))).toEqual({ database: 'dropped', remainingRoles: [] });
    expect(await inventory()).toEqual(ONLY_TWO);
  });

  /**
   * Counts every statement and can fail exactly one, before it runs or after it has taken effect. It has its own
   * administrator session, closed by `end`, as an interrupted run's session would be.
   */
  async function faulty(failAt: number, when: 'before' | 'after') {
    const log: string[] = [];
    let fired = false;
    const client = await connect(ADMIN, ADMIN_PASSWORD, 'postgres');
    const faultyServer = adminServer((session) => ({
      query: async (text, values) => {
        const index = log.push(text) - 1;
        if (index !== failAt) return session.query(text, values);
        fired = true;
        if (when === 'after') await session.query(text, values);
        throw new Error(`injected interruption at statement ${index}`);
      },
    }), client);
    return { server: faultyServer, log, fired: () => fired, end: () => close(client) };
  }
  /** An interrupted call fails with the interruption, or, when the lock's own statements were hit, by saying the session must be closed. */
  const expectInterrupted = (outcome: string, log: string[], failAt: number) => {
    if (outcome === `injected interruption at statement ${failAt}`) return;
    expect(outcome).toMatch(/lock could not be released/);
    expect(log[failAt]).toMatch(/advisory_unlock/);
  };
  const changes = (log: string[]) => log.filter((text) => !/^\s*SELECT\b/.test(text) || /pg_terminate_backend/.test(text));
  /** Every privileged session, the administrator's and each one opened inside a database, starts by pinning its search path. */
  const PIN = `SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false)`;
  const exists = async (target: Tenant) => await databaseExists(target.names.database) || (await roleNames(target)).length > 0;
  /** A password can be set exactly when the server says the tenant is ready. */
  const passwordOnlyWhenReady = async (target: Tenant, label: string) => {
    const seen = await observeTenant(server, identity(target));
    const outcome = await refusal(setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[0], password: PASSWORD(`${target.key}-a`) }));
    expect(outcome, `${label}: ${JSON.stringify(seen)}`).toBe(seen.state === 'ready' ? 'not refused' : seen.state);
    // The inventory shows exactly what is there, finished or not.
    expect(await inventory(), label).toEqual(await exists(target) ? ['app_two:ready', `${target.names.database}:${seen.state}`].sort() : ONLY_TWO);
    return seen;
  };

  /**
   * 2. Whatever state creation was left in, a tenant login cannot change the database's comment, owner, limit or
   * grants, even if it had a working password (given here by the superuser, since the module never gives one this early).
   */
  const cannotTamper = async (target: Tenant, label: string) => {
    const [login] = target.names.logins;
    if (!await databaseExists(target.names.database) || !(await roleNames(target)).includes(login)) return false;
    const row = async () => (await boot.query(`SELECT COALESCE(datacl, acldefault('d', datdba))::text AS acl, datconnlimit, datdba, shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`, [target.names.database])).rows;
    // A refused grant can still make PostgreSQL write the default privileges out in full; what they say must not change.
    const before = await row();
    await boot.query(`ALTER ROLE ${login} LOGIN PASSWORD '${PASSWORD('tamper')}'`);
    // Statements about a database can be sent from any database, so `postgres` will do.
    const client = await connect(login, PASSWORD('tamper'), 'postgres');
    for (const acting of [`SET ROLE NONE`, `SET ROLE ${target.names.owner}`]) {
      await client.query(acting).catch(() => {});
      for (const statement of [
        `COMMENT ON DATABASE ${target.names.database} IS 'hypervibe-tenant:${target.tenantId}'`,
        `COMMENT ON DATABASE ${target.names.database} IS 'hypervibe-tenant-dropping:${target.tenantId}'`,
        `ALTER DATABASE ${target.names.database} OWNER TO ${login}`,
        `ALTER DATABASE ${target.names.database} CONNECTION LIMIT 99`,
        `ALTER DATABASE ${target.names.database} SET search_path = 'public'`,
        `DROP DATABASE ${target.names.database}`,
      ]) expect(await sqlState(client.query(statement)), `${label}: ${statement} after ${acting}`).toBe('42501');
      // A grant or revoke it has no right to make is an error or a warning, depending on what it holds; either way nothing changes.
      await client.query(`GRANT ALL ON DATABASE ${target.names.database} TO PUBLIC`).catch(() => {});
      await client.query(`REVOKE ALL ON DATABASE ${target.names.database} FROM ${ADMIN}`).catch(() => {});
    }
    await close(client);
    await boot.query(`ALTER ROLE ${login} NOLOGIN PASSWORD NULL`);
    expect(await row(), label).toEqual(before);
    expect(before[0]!.datdba, label).toBe(await scalar(boot, `SELECT oid FROM pg_roles WHERE rolname = $1`, [ADMIN]));
    return true;
  };

  it('5a. re-running ensure on a ready tenant only reads, and keeps data', async () => {
    const before = await boot.query(`SELECT datconnlimit, datacl::text, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`, [two.names.database]);
    const session = await loginA(two);
    for (const allocate of [false, true]) {
      const watched = await faulty(-1, 'before');
      let inDatabaseCalls = 0;
      const counting: TenantServer = { admin: watched.server.admin, inDatabase: (database, work) => { inDatabaseCalls++; return watched.server.inDatabase(database, work); } };
      expect(await ensureTenant(counting, { ...identity(two), connectionLimit: 10, allocate })).toEqual({ database: 'existing' });
      expect(changes(watched.log)).toEqual([]);
      expect(watched.log[0]).toBe(PIN);
      // A finished tenant is never connected to, so a database at its connection limit can still be checked.
      expect(inDatabaseCalls).toBe(0);
      await watched.end();
    }
    expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
    expect(await attempt(two.names.logins[0], PASSWORD('two-a'), two.names.database, 'SELECT count(*) FROM notes')).toBe('ok');
    expect((await boot.query(`SELECT datconnlimit, datacl::text, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`, [two.names.database])).rows).toEqual(before.rows);
  });

  it.each(['before', 'after'] as const)('5b. ensure converges after an interruption %s any statement, and is not usable until finished', async (when) => {
    const shape = async (target: Tenant) => {
      const swap = (value: unknown) => String(value).replaceAll(target.key, 'KEY');
      const database = (await boot.query(`SELECT datconnlimit, datacl::text AS acl, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`, [target.names.database])).rows
        .map((row) => ({ ...row, acl: swap(row.acl), comment: swap(row.comment) }));
      const roles = (await boot.query(
        `SELECT r.rolname, r.rolconnlimit, r.rolconfig::text AS config, shobj_description(r.oid, 'pg_authid') AS comment,
           (SELECT array_agg(DISTINCT g.rolname::text ORDER BY g.rolname::text) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
           (SELECT array_agg(DISTINCT g.rolname::text ORDER BY g.rolname::text) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.member WHERE m.roleid = r.oid) AS members
         FROM pg_roles r WHERE r.rolname = ANY($1) ORDER BY 1`, [[target.names.owner, ...target.names.logins]])).rows
        .map((row) => JSON.parse(swap(JSON.stringify(row))) as unknown);
      const admin = await connect(ADMIN, ADMIN_PASSWORD, target.names.database);
      const schema = await scalar(admin, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'`);
      await close(admin);
      return { database, roles, schema: swap(schema) };
    };
    const expected = await shape(tenant('two'));
    const stages = new Set<string>();
    let interruptions = 0;
    for (let failAt = 0; ; failAt++) {
      const target = tenant(`cut_${when}_${failAt}`);
      const label = `interruption ${when} statement ${failAt}`;
      const interrupted = await faulty(failAt, when);
      const sessions: string[][] = [];
      const recording: TenantServer = {
        admin: interrupted.server.admin,
        inDatabase: (database, work) => interrupted.server.inDatabase(database, (session) => {
          const own: string[] = [];
          sessions.push(own);
          return work({ query: (text, values) => { own.push(text); return session.query(text, values); } });
        }),
      };
      const outcome = await ensureTenant(recording, { ...identity(target), connectionLimit: 10, allocate: true }).then(() => 'finished', (error: Error) => error.message);
      await interrupted.end();
      expect(interrupted.log[0]).toBe(PIN);
      for (const own of sessions) if (own.length) expect(own[0]).toBe(PIN);
      if (!interrupted.fired()) {
        // Past the last statement: the run was never interrupted, so every statement index has been covered.
        expect(outcome).toBe('finished');
        expect(sessions).toHaveLength(1);
        await dropTenant(server, identity(target));
        break;
      }
      expectInterrupted(outcome, interrupted.log, failAt);
      interruptions++;
      await cannotTamper(target, label);
      const seen = await passwordOnlyWhenReady(target, label);
      stages.add(`${seen.state}/${seen.database}`);

      // A maintenance run never creates the database; an allocating run finishes whatever was left.
      if (seen.database === 'absent') expect(await refusal(ensureTenant(server, { ...identity(target), connectionLimit: 10, allocate: false })), label).toBe(seen.state);
      await ensureTenant(server, { ...identity(target), connectionLimit: 10, allocate: seen.database === 'absent' });
      expect(await shape(target), `${label}: ${interrupted.log[failAt]}`).toEqual(expected);
      expect(await observeTenant(server, identity(target))).toMatchObject({ state: 'ready', database: 'finished' });
      const again = await faulty(-1, 'before');
      await ensureTenant(again.server, { ...identity(target), connectionLimit: 10, allocate: false });
      await again.end();
      expect(changes(again.log), `not settled after ${label}`).toEqual([]);
      // And it works: a login can connect, act as the owner role and create a table.
      await setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[0], password: PASSWORD(`${target.key}-a`) });
      expect(await attempt(target.names.logins[0], PASSWORD(`${target.key}-a`), target.names.database, 'CREATE TABLE works (i int)')).toBe('ok');
      expect(await attempt(two.names.logins[0], PASSWORD('two-a'), target.names.database)).toBe('42501');
      expect(await dropTenant(server, identity(target))).toEqual({ database: 'dropped', remainingRoles: [] });
      expect(await roleNames(target)).toEqual([]);
    }
    expect(interruptions).toBeGreaterThan(20);
    // The walk passed through nothing, roles only, a database being created, and a finished tenant.
    expect([...stages].sort()).toEqual(['absent/absent', 'partial/absent', 'partial/creating', 'ready/finished']);
    expect(await inventory()).toEqual(ONLY_TWO);
  }, 300_000);

  it.each(['before', 'after'] as const)('5c. drop converges after an interruption %s any statement, and never leaves a working login', async (when) => {
    const stages = new Set<string>();
    let interruptions = 0;
    for (let failAt = 0; ; failAt++) {
      const target = await ready(`gone_${when}_${failAt}`);
      const label = `interruption ${when} statement ${failAt}`;
      const holder = await loginA(target);
      const interrupted = await faulty(failAt, when);
      const outcome = await dropTenant(interrupted.server, identity(target)).then(() => 'finished', (error: Error) => error.message);
      await interrupted.end();
      await close(holder);
      if (interrupted.fired()) {
        expectInterrupted(outcome, interrupted.log, failAt);
        interruptions++;
        const seen = await observeTenant(server, identity(target));
        stages.add(`${seen.state}/${seen.database}`);
        expect(await inventory(), label).toEqual(await exists(target) ? ['app_two:ready', `${target.names.database}:${seen.state}`].sort() : ONLY_TWO);
        // Once the database is gone, the old password must already be dead everywhere.
        if (!await databaseExists(target.names.database) && (await roleNames(target)).includes(target.names.logins[0])) {
          expect(DENIED, label).toContain(await attempt(target.names.logins[0], PASSWORD(`${target.key}-a`), 'postgres'));
        }
        // A half-removed tenant is not brought back to life by a maintenance run.
        if (seen.state === 'partial') expect(await refusal(ensureTenant(server, { ...identity(target), connectionLimit: 10, allocate: false })), label).toBe('partial');
      }
      expect(await dropTenant(server, identity(target))).toMatchObject({ remainingRoles: [] });
      expect(await databaseExists(target.names.database)).toBe(false);
      expect(await roleNames(target)).toEqual([]);
      if (!interrupted.fired()) break;
    }
    expect(interruptions).toBeGreaterThan(10);
    // How many times the drop polls for sessions to end depends on timing, so which statement is the very last one
    // (the only place an interruption leaves nothing at all) is not hit on every run. The other stages always are.
    const allowed = ['absent/absent', 'partial/absent', 'partial/dropping', 'ready/finished'];
    expect([...stages].filter((stage) => !allowed.includes(stage))).toEqual([]);
    expect([...stages]).toEqual(expect.arrayContaining(['partial/absent', 'partial/dropping', 'ready/finished']));
    expect(await inventory()).toEqual(ONLY_TWO);
    const session = await loginA(two);
    expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
  }, 300_000);

  it('10. a lost database is reported, not silently replaced by an empty one under working credentials', async () => {
    const target = await ready('half');
    // The database went (dropped behind Hypervibe's back); the roles stayed, with a working password.
    await boot.query(`DROP DATABASE ${target.names.database} WITH (FORCE)`);
    expect(await observeTenant(server, identity(target))).toEqual({ ...identity(target), state: 'partial', database: 'absent', roles: [target.names.owner, ...target.names.logins], foreignRoles: [] });
    expect(await inventory()).toEqual(['app_half:partial', 'app_two:ready']);
    expect(await refusal(ensureTenant(server, { ...identity(target), connectionLimit: 10, allocate: false }))).toBe('partial');
    expect(await refusal(setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[1], password: PASSWORD('half-b') }))).toBe('partial');
    expect(await refusal(retireTenantLogin(server, { ...identity(target), login: target.names.logins[0] }))).toBe('partial');
    expect(await databaseExists(target.names.database)).toBe(false);
    expect(await attempt(target.names.logins[0], PASSWORD('half-a'), 'postgres')).toBe('ok');

    // 3. While a session of the old logins will not end, even an explicit allocation is refused and nothing is created.
    // (Sessions that will not end cannot be produced on demand, so the session's answers are replaced for this check.)
    const stuck: TenantServer = { ...adminServer((session) => ({
      query: async (text, values) => {
        if (/count\(\*\)::int AS remaining/.test(text)) return { rows: [{ remaining: 1 }] };
        return session.query(text, values);
      },
    })), sessionWaitMs: 300 };
    expect(await refusal(ensureTenant(stuck, { ...identity(target), connectionLimit: 10, allocate: true }))).toBe('partial');
    expect(await refusal(dropTenant(stuck, identity(target)))).toBe('partial');
    expect(await databaseExists(target.names.database)).toBe(false);
    expect(await roleNames(target)).toHaveLength(3);
    await boot.query(`ALTER ROLE ${target.names.logins[0]} LOGIN PASSWORD '${PASSWORD('half-a')}'`);

    // An explicit fresh allocation makes a new database, and the old password does not open it or anything else.
    const lingering = await loginA(target, 'postgres');
    expect(await ensureTenant(server, { ...identity(target), connectionLimit: 10, allocate: true })).toEqual({ database: 'created' });
    await expect(lingering.query('SELECT 1')).rejects.toThrow();
    expect(await attempt(target.names.logins[0], PASSWORD('half-a'), target.names.database)).toBe('28P01');
    expect(await attempt(target.names.logins[0], PASSWORD('half-a'), 'postgres')).toBe('28P01');
    await setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[0], password: PASSWORD('half-new') });
    expect(await attempt(target.names.logins[0], PASSWORD('half-new'), target.names.database, 'CREATE TABLE back (i int)')).toBe('ok');
    expect(await attempt(two.names.logins[0], PASSWORD('two-a'), target.names.database)).toBe('42501');
    expect(await dropTenant(server, identity(target))).toEqual({ database: 'dropped', remainingRoles: [] });
  });

  it('6. refuses a database or role that has the tenant\'s name but is not provably its own, and leaves it untouched', async () => {
    const snapshot = async (database: string) => (await boot.query(
      `SELECT d.datconnlimit, d.datacl::text AS acl, pg_get_userbyid(d.datdba) AS owner, shobj_description(d.oid, 'pg_database') AS comment,
         (SELECT array_agg(rolname::text ORDER BY 1) FROM pg_roles WHERE rolname LIKE 'app\\_%') AS roles
       FROM pg_database d WHERE d.datname = $1`, [database])).rows;
    const every = async (target: Tenant, tenantId: string, standing: 'foreign' | 'absent' | 'partial' = 'foreign') => {
      const calls = [
        () => ensureTenant(server, { names: target.names, tenantId, connectionLimit: 3, allocate: true }),
        () => ensureTenant(server, { names: target.names, tenantId, connectionLimit: 3, allocate: false }),
        () => dropTenant(server, { names: target.names, tenantId }),
        () => setTenantLoginPassword(server, { names: target.names, tenantId, login: target.names.logins[0], password: PASSWORD('takeover') }),
        () => retireTenantLogin(server, { names: target.names, tenantId, login: target.names.logins[0] }),
      ];
      for (const call of calls) expect(await refusal(call())).toBe(standing);
      expect((await observeTenant(server, { names: target.names, tenantId })).state).toBe(standing);
    };

    // a. No marker at all: a database someone made by hand with the name a tenant would get.
    const stray = tenant('stray');
    await adminClient.query(`CREATE DATABASE ${stray.names.database}`);
    const inStray = await connect(ADMIN, ADMIN_PASSWORD, stray.names.database);
    await inStray.query(`CREATE TABLE sentinel (value text); INSERT INTO sentinel VALUES ('must survive')`);
    await close(inStray);
    // Even with no connections allowed, as a database is born: without this tenant's marked roles it is not an interrupted creation.
    await adminClient.query(`ALTER DATABASE ${stray.names.database} CONNECTION LIMIT 0`);
    const strayBefore = await snapshot(stray.names.database);
    await every(stray, stray.tenantId);
    expect(await snapshot(stray.names.database)).toEqual(strayBefore);
    expect(await roleNames(stray)).toEqual([]);
    const strayCheck = await connect('boot', undefined, stray.names.database);
    expect(await scalar(strayCheck, 'SELECT value FROM sentinel')).toBe('must survive');
    await close(strayCheck);
    expect(await inventory()).toEqual(ONLY_TWO);

    // b. A comment that is not a tenant marker, and an unmarked database owned by an unmarked role of the right name.
    await adminClient.query(`COMMENT ON DATABASE ${stray.names.database} IS 'somebody else''s database'`);
    await every(stray, stray.tenantId);
    await adminClient.query(`COMMENT ON DATABASE ${stray.names.database} IS NULL`);
    await adminClient.query(`CREATE ROLE ${stray.names.owner} NOLOGIN`);
    await adminClient.query(`GRANT ${stray.names.owner} TO CURRENT_USER`);
    await adminClient.query(`ALTER DATABASE ${stray.names.database} OWNER TO ${stray.names.owner}`);
    const forgedBefore = await snapshot(stray.names.database);
    await every(stray, stray.tenantId);
    expect(await snapshot(stray.names.database)).toEqual(forgedBefore);
    expect(await roleNames(stray)).toEqual([stray.names.owner]);
    expect(await inventory()).toEqual(ONLY_TWO);

    // c. Another tenant's marker: the same names claimed under a different tenant id.
    const claimed = await ready('claimed', 4);
    const claimedSession = await loginA(claimed);
    await claimedSession.query(`CREATE TABLE sentinel (value text); INSERT INTO sentinel VALUES ('must survive')`);
    const claimedBefore = await snapshot(claimed.names.database);
    await every(claimed, 'project-2:claimed');
    expect(await snapshot(claimed.names.database)).toEqual(claimedBefore);
    expect(await scalar(claimedSession, 'SELECT value FROM sentinel')).toBe('must survive');
    expect(await attempt(claimed.names.logins[0], PASSWORD('claimed-a'), claimed.names.database, 'SELECT value FROM sentinel')).toBe('ok');
    expect(await attempt(claimed.names.logins[0], PASSWORD('takeover'), claimed.names.database)).toBe('28P01');
    expect(await inventory()).toEqual(['app_claimed:ready', 'app_two:ready']);

    // d. No database, but a role with a tenant login's name and no marker: nothing is created around it.
    const squat = tenant('squat');
    await adminClient.query(`CREATE ROLE ${squat.names.logins[1]} LOGIN`);
    await every(squat, squat.tenantId);
    expect(await databaseExists(squat.names.database)).toBe(false);
    expect(await roleNames(squat)).toEqual([squat.names.logins[1]]);

    // e. One of the tenant's own roles was given server-wide powers behind Hypervibe's back: refused, not quietly kept.
    await boot.query(`ALTER ROLE ${claimed.names.logins[1]} CREATEDB`);
    await every(claimed, claimed.tenantId);
    expect(await observeTenant(server, identity(claimed))).toMatchObject({ foreignRoles: [claimed.names.logins[1]] });
    expect(await databaseExists(claimed.names.database)).toBe(true);
    await boot.query(`ALTER ROLE ${claimed.names.logins[1]} NOCREATEDB`);

    // f. The right marker under an owner that is neither the administrator nor the tenant's owner role.
    await adminClient.query('CREATE ROLE unexpected_owner NOLOGIN');
    await adminClient.query('GRANT unexpected_owner TO CURRENT_USER');
    await adminClient.query(`ALTER DATABASE ${claimed.names.database} OWNER TO unexpected_owner`);
    const movedBefore = await snapshot(claimed.names.database);
    await every(claimed, claimed.tenantId);
    expect(await snapshot(claimed.names.database)).toEqual(movedBefore);
    expect(await scalar(claimedSession, 'SELECT value FROM sentinel')).toBe('must survive');
    await adminClient.query(`ALTER DATABASE ${claimed.names.database} OWNER TO CURRENT_USER`);
    expect((await observeTenant(server, identity(claimed))).state).toBe('ready');

    // g. A database restored by hand under the tenant's name and owner role, where the original was lost: never adopted.
    await close(claimedSession);
    await boot.query(`DROP DATABASE ${claimed.names.database} WITH (FORCE)`);
    await boot.query(`CREATE DATABASE ${claimed.names.database} OWNER ${claimed.names.owner}`);
    const restoredBefore = await snapshot(claimed.names.database);
    await every(claimed, claimed.tenantId);
    expect(await snapshot(claimed.names.database)).toEqual(restoredBefore);
    // Its roles are still this tenant's, so the inventory shows the conflict rather than hiding it.
    expect(await inventory()).toEqual(['app_claimed:foreign', 'app_two:ready']);
    await boot.query(`DROP DATABASE ${claimed.names.database}`);
    // The same restore made with the administrator's own login: its marked roles exist, but it is not in the state a database is born in.
    await adminClient.query(`CREATE DATABASE ${claimed.names.database}`);
    await every(claimed, claimed.tenantId);
    await adminClient.query(`ALTER DATABASE ${claimed.names.database} CONNECTION LIMIT 0`);
    await adminClient.query(`REVOKE TEMPORARY ON DATABASE ${claimed.names.database} FROM PUBLIC`);
    await every(claimed, claimed.tenantId);
    await boot.query(`DROP DATABASE ${claimed.names.database}`);
    expect(await dropTenant(server, identity(claimed))).toEqual({ database: 'absent', remainingRoles: [] });

    // h. A tenant that does not exist is distinguished from one that is not ours.
    const missing = tenant('missing');
    for (const call of [
      () => ensureTenant(server, { ...identity(missing), connectionLimit: 3, allocate: false }),
      () => setTenantLoginPassword(server, { ...identity(missing), login: missing.names.logins[0], password: PASSWORD('missing') }),
      () => retireTenantLogin(server, { ...identity(missing), login: missing.names.logins[0] }),
    ]) expect(await refusal(call())).toBe('absent');
    expect(await dropTenant(server, identity(missing))).toEqual({ database: 'absent', remainingRoles: [] });
    expect(await roleNames(missing)).toEqual([]);

    await boot.query(`DROP DATABASE ${stray.names.database}`);
    await boot.query(`DROP ROLE ${stray.names.owner}`);
    await boot.query(`DROP ROLE ${squat.names.logins[1]}`);
    await boot.query('DROP ROLE unexpected_owner');
    expect(await inventory()).toEqual(ONLY_TWO);
  }, 60_000);

  it('7. a ready tenant that lost a grant is not ready until a maintenance run repairs it', async () => {
    const target = await ready('worn');
    await boot.query(`GRANT CONNECT ON DATABASE ${target.names.database} TO PUBLIC`);
    expect(await observeTenant(server, identity(target))).toMatchObject({ state: 'partial', database: 'finished' });
    expect(await refusal(setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[1], password: PASSWORD('worn-b') }))).toBe('partial');
    expect(await refusal(retireTenantLogin(server, { ...identity(target), login: target.names.logins[0] }))).toBe('partial');
    expect(await attempt(target.names.logins[1], PASSWORD('worn-b'), target.names.database)).toBe('28P01');
    expect(await ensureTenant(server, { ...identity(target), connectionLimit: 10, allocate: false })).toEqual({ database: 'existing' });
    expect((await observeTenant(server, identity(target))).state).toBe('ready');
    expect(await attempt('fresh_role', PASSWORD('fresh'), target.names.database)).toBe('42501');
    await dropTenant(server, identity(target));
  });

  it('4/7. caps each tenant in its own database and across the server, without affecting the other tenant', async () => {
    const small = await ready('small', 2);
    const first = await loginA(small);
    const second = await loginA(small);
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), small.names.database)).toBe('53300');
    // Going through another database does not get around the cap.
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), 'postgres')).toBe('53300');
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), 'template1')).toBe('53300');
    await close(second);
    const elsewhere = await loginA(small, 'postgres');
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), small.names.database)).toBe('53300');
    await close(elsewhere);
    const again = await loginA(small);

    // The full tenant does not cost the other tenant anything, and it can still be checked and changed.
    const twoSessions = [await loginA(two), await loginA(two), await loginA(two)];
    for (const session of twoSessions) expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
    expect(await ensureTenant(server, { ...identity(small), connectionLimit: 2, allocate: false })).toEqual({ database: 'existing' });
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), small.names.database)).toBe('53300');
    expect(await scalar(first, 'SELECT 1')).toBe(1);

    // Raising the limit through ensure admits exactly one more, wherever it connects.
    await ensureTenant(server, { ...identity(small), connectionLimit: 3, allocate: false });
    const third = await loginA(small, 'postgres');
    expect(await scalar(third, 'SELECT 1')).toBe(1);
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), small.names.database)).toBe('53300');
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), 'postgres')).toBe('53300');
    expect(await scalar(again, 'SELECT 1')).toBe(1);
    // A full tenant can still be dropped.
    expect(await dropTenant(server, identity(small))).toEqual({ database: 'dropped', remainingRoles: [] });
    for (const session of twoSessions) expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
    expect(await inventory()).toEqual(ONLY_TWO);
  });

  it('1b. never runs anything a tenant planted where an administrator session would look', async () => {
    // A server upgraded from before PostgreSQL 15 keeps a `public` schema in `postgres` that every role may create in.
    const inPostgres = await connect('boot', undefined, 'postgres');
    await inPostgres.query('GRANT CREATE ON SCHEMA public TO PUBLIC; CREATE TABLE public.caught (who text); GRANT INSERT ON public.caught TO PUBLIC');
    const hostile = await loginA(two, 'postgres');
    const trap = (name: string, args: string, result: string, body: string) => `CREATE FUNCTION public.${name}(${args}) RETURNS ${result} LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.caught VALUES (session_user); RETURN ${body}; END $$`;
    await hostile.query(trap('oid_int_eq', 'oid, integer', 'boolean', '$1 OPERATOR(pg_catalog.=) $2::oid'));
    await hostile.query('CREATE OPERATOR public.= (LEFTARG = oid, RIGHTARG = integer, FUNCTION = public.oid_int_eq)');
    await hostile.query(trap('bigint_int_eq', 'bigint, integer', 'boolean', '$1 OPERATOR(pg_catalog.=) $2::bigint'));
    await hostile.query('CREATE OPERATOR public.= (LEFTARG = bigint, RIGHTARG = integer, FUNCTION = public.bigint_int_eq)');
    await hostile.query(trap('pg_backend_pid', '', 'integer', 'pg_catalog.pg_backend_pid()'));
    // The trap is live: a session that looks in `public` before `pg_catalog` springs it.
    await inPostgres.query(`SET search_path = public, pg_catalog; SELECT pg_backend_pid(); RESET search_path`);
    expect(await scalar(boot, 'SELECT count(*)::int FROM public.caught')).toBe(1);
    await boot.query('TRUNCATE public.caught');

    // A brand-new administrator session, with the server's default search path, through every function.
    const fresh = adminServer(undefined, await connect(ADMIN, ADMIN_PASSWORD, 'postgres'));
    const target = tenant('trap');
    await observeTenant(fresh, identity(two));
    await listTenants(fresh);
    await ensureTenant(fresh, { ...identity(target), connectionLimit: 5, allocate: true });
    await setTenantLoginPassword(fresh, { ...identity(target), login: target.names.logins[0], password: PASSWORD('trap-a') });
    await retireTenantLogin(fresh, { ...identity(target), login: target.names.logins[0] });
    await dropTenant(fresh, identity(target));
    expect((await boot.query('SELECT DISTINCT who FROM public.caught')).rows).toEqual([]);

    await inPostgres.query(`DROP OPERATOR public.= (oid, integer); DROP OPERATOR public.= (bigint, integer); DROP FUNCTION public.oid_int_eq, public.bigint_int_eq, public.pg_backend_pid;
      DROP TABLE public.caught; REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  });

  it('1c. the session opened inside a new database ignores a search path set on that database', async () => {
    const target = tenant('lure');
    // Stop just before the administrator connects to the new database, then plant a trap as the database's owner could.
    const stopping = adminServer((session) => session);
    await expect(ensureTenant({ admin: stopping.admin, inDatabase: async () => { throw new Error('stop before connecting'); } }, { ...identity(target), connectionLimit: 5, allocate: true })).rejects.toThrow('stop before connecting');
    expect(await observeTenant(server, identity(target))).toMatchObject({ state: 'partial', database: 'creating' });
    const planted = await connect('boot', undefined, target.names.database);
    await planted.query(`CREATE TABLE public.caught (who text); GRANT INSERT ON public.caught TO PUBLIC;
      CREATE FUNCTION public.pg_get_userbyid(oid) RETURNS name LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.caught VALUES (session_user); RETURN pg_catalog.pg_get_userbyid($1); END $$;
      CREATE FUNCTION public.set_config(text, text, boolean) RETURNS text LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.caught VALUES (session_user); RETURN pg_catalog.set_config($1, $2, $3); END $$;
      CREATE FUNCTION public.name_eq(name, name) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.caught VALUES (session_user); RETURN $1 OPERATOR(pg_catalog.=) $2; END $$;
      CREATE OPERATOR public.= (LEFTARG = name, RIGHTARG = name, FUNCTION = public.name_eq)`);
    await boot.query(`ALTER DATABASE ${target.names.database} SET search_path = public, pg_catalog`);
    const lured = await connect(ADMIN, ADMIN_PASSWORD, target.names.database);
    // The trap is live: a schema-qualified function is safe there, but an operator is not until the search path is pinned.
    await lured.query(`SELECT pg_get_userbyid(10)`);
    await lured.query(`SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'`);
    await close(lured);
    expect(await scalar(planted, 'SELECT count(*)::int FROM public.caught')).toBeGreaterThan(1);
    await planted.query('TRUNCATE public.caught');

    expect(await ensureTenant(server, { ...identity(target), connectionLimit: 5, allocate: false })).toEqual({ database: 'existing' });
    expect((await planted.query('SELECT who FROM public.caught')).rows).toEqual([]);
    expect((await observeTenant(server, identity(target))).state).toBe('ready');
    await close(planted);
    await dropTenant(server, identity(target));
  });

  it('2. copies new databases from template0, whatever is in or connected to template1', async () => {
    const inTemplate = await connect('boot', undefined, 'template1');
    await inTemplate.query('CREATE TABLE public.leftover (i int)');
    // An idle session on template1, as any login on the server may hold, would block a copy of template1.
    await connect('fresh_role', PASSWORD('fresh'), 'template1');
    const target = await ready('tpl');
    const inside = await connect(ADMIN, ADMIN_PASSWORD, target.names.database);
    expect((await inside.query(`SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`)).rows).toEqual([]);
    // Encoding and locale are the server's own defaults, as recorded on template0.
    const settings = `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype, datlocprovider FROM pg_database WHERE datname = $1`;
    expect((await boot.query(settings, [target.names.database])).rows).toEqual((await boot.query(settings, ['template0'])).rows);
    await inTemplate.query('DROP TABLE public.leftover');
    await dropTenant(server, identity(target));
  });

  it('5. serializes writers on separate sessions', async () => {
    const sessions = await Promise.all([0, 1, 2].map(() => connect(ADMIN, ADMIN_PASSWORD, 'postgres')));
    const [first, second] = sessions.map((client) => adminServer(undefined, client));
    const target = tenant('race');
    const settle = async (work: Array<Promise<unknown>>) => (await Promise.allSettled(work)).map((result) => result.status === 'rejected' ? String(result.reason) : JSON.stringify(result.value));

    // Two allocations of the same tenant at once: one creates it, the other finds it finished.
    expect((await settle([
      ensureTenant(first!, { ...identity(target), connectionLimit: 5, allocate: true }), ensureTenant(second!, { ...identity(target), connectionLimit: 5, allocate: true }),
    ])).sort()).toEqual(['{"database":"created"}', '{"database":"existing"}']);
    expect((await observeTenant(server, identity(target))).state).toBe('ready');

    // An allocation racing a removal, both ways round: each call completes, and the tenant ends up whole or gone, never in between.
    for (let round = 0; round < 6; round++) {
      const pair = [dropTenant(first!, identity(target)), ensureTenant(second!, { ...identity(target), connectionLimit: 5, allocate: true })];
      const outcomes = await settle(round % 2 ? pair.reverse() : pair);
      for (const outcome of outcomes) expect(outcome).toMatch(/^\{"database":/);
      expect(['ready', 'absent']).toContain((await observeTenant(server, identity(target))).state);
      await ensureTenant(server, { ...identity(target), connectionLimit: 5, allocate: true });
    }

    // While another session holds the documented lock, every writer waits, and a bounded wait ends with a clear refusal.
    const holder = sessions[2]!;
    const [key1, key2] = TENANT_WRITER_LOCK;
    expect([key1, key2]).toEqual([1752593508, 830]);
    const impatient: TenantServer = { ...second!, lockWaitMs: 250 };
    const busy = async (work: Promise<unknown>) => work.then(() => 'not refused', (error: unknown) => error instanceof TenantBusyError ? error.message : `threw ${String(error)}`);
    const writers = (via: TenantServer): Array<[string, () => Promise<unknown>]> => [
      ['ensure', () => ensureTenant(via, { ...identity(target), connectionLimit: 5, allocate: false })],
      ['password', () => setTenantLoginPassword(via, { ...identity(target), login: target.names.logins[0], password: PASSWORD('race-a') })],
      ['retire', () => retireTenantLogin(via, { ...identity(target), login: target.names.logins[1] })],
      ['drop', () => dropTenant(via, identity(target))],
    ];
    const patient = writers(first!);
    for (const [index, [name, refusedWriter]] of writers(impatient).entries()) {
      await holder.query(`SELECT pg_advisory_lock(${key1}, ${key2})`);
      let settled = false;
      const running = patient[index]![1]().finally(() => { settled = true; });
      const started = Date.now();
      expect(await busy(refusedWriter()), name).toMatch(/Another change is in progress/);
      expect(Date.now() - started, name).toBeLessThan(3000);
      // 4. Readers wait for a writer too, so they never see a change half made.
      expect(await busy(observeTenant({ ...second!, lockWaitMs: 0 }, identity(target))), name).toMatch(/Another change is in progress/);
      expect(await busy(listTenants({ ...second!, lockWaitMs: 0 })), name).toMatch(/Another change is in progress/);
      expect(settled, `${name} did not wait for the lock`).toBe(false);
      await holder.query(`SELECT pg_advisory_unlock(${key1}, ${key2})`);
      await running;
    }
    // Readers share the lock with each other and keep writers out.
    await ensureTenant(server, { ...identity(target), connectionLimit: 5, allocate: true });
    await holder.query(`SELECT pg_advisory_lock_shared(${key1}, ${key2})`);
    expect((await observeTenant(second!, identity(target))).state).toBe('ready');
    expect(await listTenants(second!)).toHaveLength(2);
    expect(await busy(dropTenant(impatient, identity(target)))).toMatch(/Another change is in progress/);
    expect((await observeTenant(second!, identity(target))).state).toBe('ready');
    await holder.query(`SELECT pg_advisory_unlock_shared(${key1}, ${key2})`);
    await dropTenant(server, identity(target));
    // Nothing is left holding the lock.
    expect(await scalar(boot, `SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory'`)).toBe(0);
    expect(await inventory()).toEqual(ONLY_TWO);
  }, 60_000);

  it('8/9. disables credentials before dropping, and reports roles it cannot drop instead of failing halfway', async () => {
    // a. The login owns a large object in `postgres`, where any role may create one.
    const pinned = await ready('lob');
    const elsewhere = await loginA(pinned, 'postgres');
    await elsewhere.query('SET ROLE NONE');
    await elsewhere.query('SELECT lo_create(0)');
    await close(elsewhere);
    const [login] = pinned.names.logins;
    expect(await dropTenant(server, identity(pinned))).toEqual({ database: 'dropped', remainingRoles: [login] });
    expect(await roleNames(pinned)).toEqual([login]);
    // What is left cannot log in anywhere, and the server's inventory still shows it.
    expect(DENIED).toContain(await attempt(login, PASSWORD('lob-a'), 'postgres'));
    expect(await listTenants(server)).toContainEqual({ ...identity(pinned), state: 'partial', database: 'absent', roles: [login], foreignRoles: [] });
    expect(await dropTenant(server, identity(pinned))).toEqual({ database: 'absent', remainingRoles: [login] });
    const cleaner = await connect('boot', undefined, 'postgres');
    await cleaner.query(`SELECT lo_unlink(oid) FROM pg_largeobject_metadata WHERE lomowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`, [login]);
    expect(await dropTenant(server, identity(pinned))).toEqual({ database: 'absent', remainingRoles: [] });
    expect(await inventory()).toEqual(ONLY_TWO);

    // b. Another tenant granted this tenant's owner role something inside its own database.
    const granted = await ready('grantee');
    const twoSession = await loginA(two);
    await twoSession.query(`GRANT SELECT ON notes TO ${granted.names.owner}`);
    expect(await dropTenant(server, identity(granted))).toEqual({ database: 'dropped', remainingRoles: [granted.names.owner] });
    expect(await inventory()).toEqual(['app_grantee:partial', 'app_two:ready']);
    expect(await scalar(twoSession, 'SELECT body FROM notes')).toBe('two');
    await twoSession.query(`REVOKE SELECT ON notes FROM ${granted.names.owner}`);
    expect(await dropTenant(server, identity(granted))).toEqual({ database: 'absent', remainingRoles: [] });

    // c. The drop fails at the database itself: the password is already dead, and the tenant shows as being removed.
    const stuck = await ready('stuck');
    const failing = adminServer((session) => ({ query: async (text, values) => { if (/^DROP DATABASE/.test(text)) throw new Error('could not drop'); return session.query(text, values); } }));
    await expect(dropTenant(failing, identity(stuck))).rejects.toThrow('could not drop');
    expect(DENIED).toContain(await attempt(stuck.names.logins[0], PASSWORD('stuck-a'), stuck.names.database));
    expect(await observeTenant(server, identity(stuck))).toMatchObject({ state: 'partial', database: 'dropping' });
    for (const allocate of [false, true]) expect(await refusal(ensureTenant(server, { ...identity(stuck), connectionLimit: 10, allocate }))).toBe('partial');
    expect(await refusal(setTenantLoginPassword(server, { ...identity(stuck), login: stuck.names.logins[0], password: PASSWORD('stuck-a') }))).toBe('partial');
    expect(await dropTenant(server, identity(stuck))).toEqual({ database: 'dropped', remainingRoles: [] });
    expect(await inventory()).toEqual(ONLY_TWO);
  }, 60_000);

  it('1. a lock that could not be released is reported, on a session that lives on', async () => {
    const client = await connect(ADMIN, ADMIN_PASSWORD, 'postgres');
    const unlocks = { fail: true };
    const leaky = adminServer((session) => ({
      query: async (text, values) => {
        if (unlocks.fail && /advisory_unlock/.test(text)) throw new Error('the answer was lost');
        return session.query(text, values);
      },
    }), client);
    const elsewhere: TenantServer = { ...adminServer(undefined, await connect(ADMIN, ADMIN_PASSWORD, 'postgres')), lockWaitMs: 250 };
    const busy = (work: Promise<unknown>) => work.then(() => 'not refused', (error: unknown) => error instanceof TenantBusyError ? 'busy' : `threw ${String(error)}`);

    // The work finished, the unlock did not: the caller is told both, and told to close the session.
    const failure = await ensureTenant(leaky, { ...identity(two), connectionLimit: 10, allocate: false }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TenantLockNotReleasedError);
    expect((failure as TenantLockNotReleasedError).completed).toBe(true);
    expect((failure as Error).message).toMatch(/Close this database session/);
    // The session is alive and really does still hold the lock: nobody else can change or read anything.
    expect(await scalar(client, 'SELECT 1')).toBe(1);
    expect(await busy(ensureTenant(elsewhere, { ...identity(two), connectionLimit: 10, allocate: false }))).toBe('busy');
    expect(await busy(listTenants(elsewhere))).toBe('busy');
    // Closing it, as told, frees everyone.
    await close(client);
    expect(await ensureTenant({ ...elsewhere, lockWaitMs: 10_000 }, { ...identity(two), connectionLimit: 10, allocate: false })).toEqual({ database: 'existing' });

    // The work failed and the unlock failed too: the unlock problem is what is reported, with the work's failure as its cause.
    const second = await connect(ADMIN, ADMIN_PASSWORD, 'postgres');
    const both = adminServer((session) => ({
      query: async (text, values) => {
        if (/advisory_unlock/.test(text) || /^ALTER ROLE/.test(text)) throw new Error(/advisory_unlock/.test(text) ? 'the answer was lost' : 'refused');
        return session.query(text, values);
      },
    }), second);
    const double = await setTenantLoginPassword(both, { ...identity(two), login: two.names.logins[1], password: PASSWORD('never-set') }).then(() => undefined, (error: unknown) => error);
    expect(double).toBeInstanceOf(TenantLockNotReleasedError);
    expect((double as TenantLockNotReleasedError).completed).toBe(false);
    expect(String((double as Error).cause)).toMatch(/could not be set/);
    await close(second);
    expect((await observeTenant({ ...elsewhere, lockWaitMs: 10_000 }, identity(two))).state).toBe('ready');
  });

  it('3. leaves no usable session or credential by the time anything is deleted', async () => {
    const target = await ready('quiet');
    await setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[1], password: PASSWORD('quiet-b') });
    const open = [await loginA(target), await loginA(target, 'postgres'), await connect(target.names.logins[1], PASSWORD('quiet-b'), 'template1')];

    // An interruption straight after the "being removed" marker: the logins still work, and the server says the tenant is not ready.
    const cut = adminServer((session) => ({ query: async (text, values) => { if (/^ALTER ROLE/.test(text)) throw new Error('cut'); return session.query(text, values); } }));
    await expect(dropTenant(cut, identity(target))).rejects.toThrow('cut');
    expect(await observeTenant(server, identity(target))).toMatchObject({ state: 'partial', database: 'dropping' });
    expect(await scalar(open[0]!, 'SELECT 1')).toBe(1);
    expect(await attempt(target.names.logins[0], PASSWORD('quiet-a'), 'postgres')).toBe('ok');

    // The next run deals with that before it deletes anything: at the moment the database is dropped, both logins are
    // switched off, have no session in any database, and cannot open a new one.
    const atDrop: Record<string, unknown> = {};
    const watching = adminServer((session) => ({
      query: async (text, values) => {
        if (/^DROP DATABASE/.test(text)) {
          atDrop.canLogin = await scalar(boot, 'SELECT bool_or(rolcanlogin) FROM pg_roles WHERE rolname = ANY($1)', [[...target.names.logins]]);
          atDrop.sessions = await scalar(boot, 'SELECT count(*)::int FROM pg_stat_activity WHERE usename = ANY($1)', [[...target.names.logins]]);
          atDrop.databaseStillThere = await databaseExists(target.names.database);
          atDrop.logins = [
            await attempt(target.names.logins[0], PASSWORD('quiet-a'), 'postgres'), await attempt(target.names.logins[1], PASSWORD('quiet-b'), 'postgres'),
            await attempt(target.names.logins[0], PASSWORD('quiet-a'), target.names.database),
          ].every((outcome) => DENIED.includes(outcome));
        }
        return session.query(text, values);
      },
    }));
    expect(await dropTenant(watching, identity(target))).toEqual({ database: 'dropped', remainingRoles: [] });
    expect(atDrop).toEqual({ canLogin: false, sessions: 0, databaseStillThere: true, logins: true });
    for (const client of open) await expect(client.query('SELECT 1')).rejects.toThrow();
    expect(await inventory()).toEqual(ONLY_TWO);
  });

  it('4. the inventory never misses a tenant that existed throughout, while others come and go', async () => {
    const steady = await ready('steady');
    const writer: TenantServer = { ...adminServer(undefined, await connect(ADMIN, ADMIN_PASSWORD, 'postgres')), lockWaitMs: 250 };
    const attempts: string[] = [];
    let interfered = false;
    // Between the inventory's scan and its per-tenant checks, another session tries to add one tenant and remove another.
    const reader = adminServer((session) => ({
      query: async (text, values) => {
        const result = await session.query(text, values);
        if (/UNION ALL/.test(text) && !interfered) {
          interfered = true;
          for (const change of [
            () => ensureTenant(writer, { ...identity(tenant('arriving')), connectionLimit: 5, allocate: true }),
            () => dropTenant(writer, identity(steady)),
            () => dropTenant(writer, identity(two)),
          ]) attempts.push(await change().then(() => 'changed', (error: unknown) => error instanceof TenantBusyError ? 'busy' : String(error)));
        }
        return result;
      },
    }), await connect(ADMIN, ADMIN_PASSWORD, 'postgres'));
    expect((await listTenants(reader)).map((entry) => `${entry.names.database}:${entry.state}`)).toEqual(['app_steady:ready', 'app_two:ready']);
    expect(attempts).toEqual(['busy', 'busy', 'busy']);
    expect(await inventory()).toEqual(['app_steady:ready', 'app_two:ready']);
    await dropTenant(server, identity(steady));
  });

  it('third pass 1. a session that shows up after a first zero count is not missed', async () => {
    // A connection that passed the login check just before the login was switched off can appear late. That cannot be
    // timed on demand, so the session counts the module reads are replaced here.
    const scripted = (counts: (statements: string[]) => number) => {
      const statements: string[] = [];
      const scriptedServer: TenantServer = { ...adminServer((session) => ({
        query: async (text, values) => {
          statements.push(text);
          if (/count\(\*\)::int AS remaining/.test(text)) return { rows: [{ remaining: counts(statements) }] };
          return session.query(text, values);
        },
      })), sessionWaitMs: 400 };
      return { server: scriptedServer, statements };
    };
    const reads = (statements: string[]) => statements.filter((text) => /AS remaining/.test(text)).length;
    const ends = (statements: string[]) => statements.filter((text) => /pg_terminate_backend/.test(text)).length;

    // Zero, then a late session, then zero twice: the first zero alone is not believed, and the late session is ended.
    const late = await ready('late');
    const first = scripted((statements) => reads(statements) === 2 ? 1 : 0);
    expect(await dropTenant(first.server, identity(late))).toEqual({ database: 'dropped', remainingRoles: [] });
    const firstDrop = first.statements.findIndex((text) => /^DROP DATABASE/.test(text));
    expect(reads(first.statements.slice(0, firstDrop))).toBe(4);
    expect(ends(first.statements.slice(0, firstDrop))).toBeGreaterThanOrEqual(3);

    // A session that keeps coming back: nothing is deleted.
    const haunted = await ready('haunted');
    const second = scripted((statements) => reads(statements) % 2);
    expect(await refusal(dropTenant(second.server, identity(haunted)))).toBe('partial');
    expect(second.statements.some((text) => /^DROP/.test(text))).toBe(false);
    expect(await databaseExists(haunted.names.database)).toBe(true);

    // A session that appears only after the database is gone: that login is ended again and, while it stays, not dropped.
    const third = { statements: [] as string[] };
    const afterDrop = adminServer((session) => ({ query: (text, values) => {
      third.statements.push(text);
      const forA = Array.isArray(values) && values[0] === haunted.names.logins[0];
      if (/AS remaining/.test(text)) return Promise.resolve({ rows: [{ remaining: forA && third.statements.some((entry) => /^DROP DATABASE/.test(entry)) ? 1 : 0 }] });
      return session.query(text, values);
    } }));
    expect(await dropTenant({ ...afterDrop, sessionWaitMs: 400 }, identity(haunted))).toEqual({ database: 'dropped', remainingRoles: [haunted.names.logins[0]] });
    const dropped = third.statements.findIndex((text) => /^DROP DATABASE/.test(text));
    expect(ends(third.statements.slice(dropped))).toBeGreaterThanOrEqual(2);
    expect(await roleNames(haunted)).toEqual([haunted.names.logins[0]]);
    expect(await dropTenant(server, identity(haunted))).toEqual({ database: 'absent', remainingRoles: [] });
  }, 60_000);

  it('third pass 2. ensure never switches a login back on', async () => {
    // a. A login an administrator switched off on purpose, password intact, stays off through a maintenance run.
    const target = await ready('offduty');
    await boot.query(`ALTER ROLE ${target.names.logins[0]} NOLOGIN`);
    for (const allocate of [false, true]) await ensureTenant(server, { ...identity(target), connectionLimit: 10, allocate });
    expect(await scalar(boot, 'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [target.names.logins[0]])).toBe(false);
    expect(await attempt(target.names.logins[0], PASSWORD('offduty-a'), target.names.database)).toBe('28000');
    // Giving it a password is the one thing that switches it on.
    await setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[0], password: PASSWORD('offduty-new') });
    expect(await attempt(target.names.logins[0], PASSWORD('offduty-new'), target.names.database)).toBe('ok');

    // b. Re-allocating over old roles: from before the database is created until the call returns, no login can log in.
    await boot.query(`DROP DATABASE ${target.names.database} WITH (FORCE)`);
    const seen: boolean[] = [];
    let creating = false;
    const watching = adminServer((session) => ({
      query: async (text, values) => {
        if (/^CREATE DATABASE/.test(text)) creating = true;
        if (creating) seen.push(await scalar(boot, 'SELECT bool_or(rolcanlogin) FROM pg_roles WHERE rolname = ANY($1)', [[...target.names.logins]]) as boolean);
        return session.query(text, values);
      },
    }));
    expect(await ensureTenant(watching, { ...identity(target), connectionLimit: 10, allocate: true })).toEqual({ database: 'created' });
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((canLogin) => canLogin === false)).toBe(true);
    expect((await boot.query('SELECT rolcanlogin FROM pg_roles WHERE rolname = ANY($1)', [[...target.names.logins]])).rows).toEqual([{ rolcanlogin: false }, { rolcanlogin: false }]);
    expect((await observeTenant(server, identity(target))).state).toBe('ready');
    expect(DENIED).toContain(await attempt(target.names.logins[0], PASSWORD('offduty-new'), target.names.database));
    await dropTenant(server, identity(target));
  });

  it('third pass 3. reads the caller\'s options once', async () => {
    const target = tenant('once');
    const reads: Record<string, number> = {};
    const shifting = (values: Record<string, unknown[]>) => new Proxy({}, {
      get: (_, property: string) => {
        if (!(property in values)) return undefined;
        reads[property] = (reads[property] ?? 0) + 1;
        return values[property]![Math.min(reads[property]!, values[property]!.length) - 1];
      },
    }) as never;
    // The first answers say "do not create"; a caller object that changes its mind later must not be believed.
    expect(await refusal(ensureTenant(server, shifting({ names: [target.names], tenantId: [target.tenantId], connectionLimit: [5, 9000], allocate: [false, true] })))).toBe('absent');
    expect(await databaseExists(target.names.database)).toBe(false);
    expect(reads).toEqual({ names: 1, tenantId: 1, connectionLimit: 1, allocate: 1 });
  });

  it('third pass 4. waits end at a wall-clock deadline, however slow the server answers', async () => {
    const holder = await connect(ADMIN, ADMIN_PASSWORD, 'postgres');
    await holder.query(`SELECT pg_advisory_lock(${TENANT_WRITER_LOCK[0]}, ${TENANT_WRITER_LOCK[1]})`);
    let tries = 0;
    const slow = (pattern: RegExp, count: () => void, answer?: Record<string, unknown>) => adminServer((session) => ({
      query: async (text, values) => {
        if (!pattern.test(text)) return session.query(text, values);
        count();
        await new Promise((done) => setTimeout(done, 400));
        return answer ? { rows: [answer] } : session.query(text, values);
      },
    }), sessionForSlow);
    const sessionForSlow = await connect(ADMIN, ADMIN_PASSWORD, 'postgres');
    const started = Date.now();
    await expect(observeTenant({ ...slow(/try_advisory_lock/, () => { tries++; }), lockWaitMs: 500 }, identity(tenant('slow')))).rejects.toBeInstanceOf(TenantBusyError);
    // Each try takes 0.4 s against a 0.5 s limit: two tries, never a third after the deadline.
    expect(tries).toBe(2);
    expect(Date.now() - started).toBeLessThan(1500);
    await holder.query(`SELECT pg_advisory_unlock(${TENANT_WRITER_LOCK[0]}, ${TENANT_WRITER_LOCK[1]})`);

    const target = await ready('slowend');
    let counts = 0;
    const began = Date.now();
    expect(await retireTenantLogin({ ...slow(/AS remaining/, () => { counts++; }, { remaining: 1 }), sessionWaitMs: 500 }, { ...identity(target), login: target.names.logins[0] })).toEqual({ remainingSessions: 1 });
    expect(counts).toBe(2);
    expect(Date.now() - began).toBeLessThan(2500);
    await dropTenant(server, identity(target));
  });

  it('leaves the surviving tenant intact after everything above', async () => {
    const session = await loginA(two);
    expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
    expect(await listTenants(server)).toEqual([{ ...identity(two), state: 'ready', database: 'finished', roles: [two.names.owner, ...two.names.logins], foreignRoles: [] }]);
    expect(await dropTenant(server, identity(two))).toEqual({ database: 'dropped', remainingRoles: [] });
    expect(await listTenants(server)).toEqual([]);
    expect(await scalar(boot, `SELECT count(*)::int FROM pg_roles WHERE rolname LIKE 'app\\_%'`)).toBe(0);
  });
});
