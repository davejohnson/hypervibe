import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TenantRefusedError, dropTenant, ensureTenant, listTenants, retireTenantLogin, setTenantLoginPassword, tenantNames,
  type TenantServer, type TenantSession,
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

let bin: string;
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

const adminServer = (wrap: (session: TenantSession) => TenantSession = (session) => session): TenantServer => ({
  admin: wrap({ query: (text, values) => adminClient.query(text, values) }),
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
  await ensureTenant(server, { ...identity(target), connectionLimit });
  await setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[0], password: PASSWORD(`${key}-a`) });
  return target;
}
const loginA = (target: Tenant, database = target.names.database) => connect(target.names.logins[0], PASSWORD(`${target.key}-a`), database);
const scalar = async (client: pg.Client, text: string, values?: unknown[]) => Object.values((await client.query(text, values)).rows[0] ?? {})[0];
const roleNames = async (target: Tenant) => (await boot.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1', [[target.names.owner, ...target.names.logins]])).rows.map((row) => row.rolname);
const databaseExists = async (name: string) => (await boot.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rows.length === 1;

beforeAll(async () => {
  bin = postgresBin();
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
      await expect(ensureTenant(recording, { names, tenantId: good.tenantId, connectionLimit: 5 })).rejects.toThrow();
      await expect(dropTenant(recording, { names, tenantId: good.tenantId })).rejects.toThrow();
      await expect(setTenantLoginPassword(recording, { names, tenantId: good.tenantId, login: good.names.logins[0], password: PASSWORD('x') })).rejects.toThrow();
      await expect(retireTenantLogin(recording, { names, tenantId: good.tenantId, login: good.names.logins[0] })).rejects.toThrow();
    }
    for (const tenantId of ['', 'x\'; DROP ROLE boot; --', 'a b', '$tenant$', 'a\nb', '-a', 'x'.repeat(129), 7 as unknown as string]) {
      await expect(ensureTenant(recording, { names: good.names, tenantId, connectionLimit: 5 })).rejects.toThrow(/tenant id/);
      await expect(dropTenant(recording, { names: good.names, tenantId })).rejects.toThrow(/tenant id/);
    }
    for (const connectionLimit of [0, -1, 1.5, Number.NaN, 10_001, '5; DROP DATABASE postgres' as unknown as number]) {
      await expect(ensureTenant(recording, { ...identity(good), connectionLimit })).rejects.toThrow(/connection limit/);
    }
    for (const login of ['boot', ADMIN, good.names.owner, tenantNames('other').logins[0], 'app_checks_a"; --']) {
      await expect(setTenantLoginPassword(recording, { ...identity(good), login, password: PASSWORD('x') })).rejects.toThrow(/does not belong/);
      await expect(retireTenantLogin(recording, { ...identity(good), login })).rejects.toThrow(/does not belong/);
    }
    await expect(setTenantLoginPassword(recording, { ...identity(good), login: good.names.logins[0], password: 'short' })).rejects.toThrow(/at least 16/);
    expect(statements).toEqual([]);
    expect(await databaseExists(good.names.database)).toBe(false);
  });
});

describe('tenants on one server (real PostgreSQL, non-superuser administrator)', () => {
  let one: Tenant;
  let two: Tenant;

  it('runs as an administrator that is not a superuser', async () => {
    expect((await adminClient.query('SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0])
      .toEqual({ rolsuper: false, rolcreaterole: true, rolcreatedb: true, rolreplication: false, rolbypassrls: false });
  });

  it('1. gives each tenant its own database and keeps every other tenant out', async () => {
    one = await ready('one');
    two = await ready('two');
    expect(await listTenants(server)).toEqual([identity(one), identity(two)]);

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
          // PostgreSQL before 15 let every role create in `public`, so the yardstick decides, not a fixed code.
          const fresh = await attempt('fresh_role', PASSWORD('fresh'), database, `BEGIN; ${statement}; ROLLBACK`);
          expect(await attempt(mine.names.logins[0], PASSWORD(`${mine.key}-a`), database, `BEGIN; ${statement}; ROLLBACK`), `${statement} in ${database}`)
            .toBe(fresh);
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
        // Its own database stays the administrator's: the tenant cannot lift its limit, reopen it, forge the marker or drop it.
        `ALTER DATABASE ${mine.names.database} CONNECTION LIMIT 1000`,
        `GRANT CONNECT ON DATABASE ${mine.names.database} TO PUBLIC`,
        `GRANT CONNECT ON DATABASE ${mine.names.database} TO ${theirs.names.owner}`,
        `COMMENT ON DATABASE ${mine.names.database} IS 'hypervibe-tenant:${theirs.tenantId}'`,
        `ALTER DATABASE ${mine.names.database} RENAME TO stolen`,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${theirs.names.database}'`,
      ];
      const holder = await loginA(theirs);
      const access = async () => (await boot.query(`SELECT datname, datacl::text, datconnlimit, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS comment FROM pg_database ORDER BY 1`)).rows;
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
      // The session the hostile statements aimed at is still alive, and nothing was created.
      expect(await scalar(holder, 'SELECT 1')).toBe(1);
      expect(await access()).toEqual(accessBefore);
      expect(await attempt(theirs.names.logins[0], PASSWORD(`${theirs.key}-a`), mine.names.database)).toBe('42501');
      expect(await attempt('fresh_role', PASSWORD('fresh'), mine.names.database)).toBe('42501');
      expect(await scalar(boot, `SELECT count(*)::int FROM pg_roles WHERE rolname IN ('intruder', 'stolen')`)).toBe(0);
      expect(await scalar(boot, `SELECT count(*)::int FROM pg_database WHERE datname IN ('intruder', 'stolen')`)).toBe(0);
    }
    // The tenant's own data survived all of it.
    const check = await loginA(two);
    expect(await scalar(check, 'SELECT body FROM notes')).toBe('two');
    // The public schema is the tenant's on PostgreSQL 15 and later.
    if (version >= 150000) expect(await scalar(check, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'`)).toBe(two.names.owner);
    expect(await scalar(boot, `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = $1`, [two.names.database])).toBe(ADMIN);
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
    await retireTenantLogin(server, { ...identity(one), login: one.names.logins[1] });
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
    await retireTenantLogin(server, { ...identity(one), login: oldLogin });
    expect(await attempt(oldLogin, PASSWORD('one-a'), one.names.database)).toBe('28P01');
    await expect(running.query('SELECT 1')).rejects.toThrow();
    expect(await scalar(switched, 'SELECT count(*)::int FROM notes')).toBe(2);
    await retireTenantLogin(server, { ...identity(one), login: oldLogin });
    expect(await scalar(switched, 'SELECT current_user::text')).toBe(one.names.owner);
    await twoWorks();
    // Neither tenant's password works for the other tenant's logins.
    expect(await attempt(two.names.logins[0], PASSWORD('one-rotated'), two.names.database)).toBe('28P01');
    expect(await attempt(two.names.logins[1], PASSWORD('two-a'), two.names.database)).toBe('28P01');
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
    expect(statements.some((statement) => /ALTER ROLE "app_two_b" PASSWORD 'SCRAM-SHA-256\$/.test(statement))).toBe(true);
    expect(statements.join('\n')).not.toContain(secret);
    expect(await setTenantLoginPassword(server, { ...identity(two), login: two.names.logins[1], password: secret })).toBeUndefined();
    await retireTenantLogin(server, { ...identity(two), login: two.names.logins[1] });
  });

  it('4. drops one tenant, with a connection open, and leaves the other working', async () => {
    const held = await connect(one.names.logins[1], PASSWORD('one-rotated'), one.names.database);
    const twoSession = await loginA(two);
    expect(await dropTenant(server, identity(one))).toEqual({ database: 'dropped' });
    await expect(held.query('SELECT 1')).rejects.toThrow();
    expect(await databaseExists(one.names.database)).toBe(false);
    expect(await roleNames(one)).toEqual([]);
    expect(await listTenants(server)).toEqual([identity(two)]);

    expect(await scalar(twoSession, 'SELECT body FROM notes')).toBe('two');
    await twoSession.query('CREATE TABLE after_drop (i int)');
    await twoSession.query('DROP TABLE after_drop');
    expect(await attempt(two.names.logins[0], PASSWORD('two-a'), two.names.database, 'SELECT count(*) FROM notes')).toBe('ok');
    expect(await roleNames(two)).toEqual([two.names.logins[0], two.names.logins[1], two.names.owner].sort());
    // Dropping what is already gone is a quiet repeat, and the tenant can be made again from nothing.
    expect(await dropTenant(server, identity(one))).toEqual({ database: 'absent' });
    expect(await ensureTenant(server, { ...identity(one), connectionLimit: 10 })).toEqual({ database: 'created' });
    expect(await attempt(one.names.logins[1], PASSWORD('one-rotated'), one.names.database)).toBe('28P01');
    expect(await dropTenant(server, identity(one))).toEqual({ database: 'dropped' });
    expect(await listTenants(server)).toEqual([identity(two)]);
  });

  /** Counts every statement and can fail exactly one, before it runs or after it has taken effect. */
  function faulty(failAt: number, when: 'before' | 'after') {
    const log: string[] = [];
    let fired = false;
    const faultyServer = adminServer((session) => ({
      query: async (text, values) => {
        const index = log.push(text) - 1;
        if (index !== failAt) return session.query(text, values);
        fired = true;
        if (when === 'after') await session.query(text, values);
        throw new Error(`injected interruption at statement ${index}`);
      },
    }));
    return { server: faultyServer, log, fired: () => fired };
  }
  const changes = (log: string[]) => log.filter((text) => !/^\s*SELECT\b/.test(text) || /pg_terminate_backend/.test(text));

  it('5a. re-running ensure on a healthy tenant only reads, and keeps data', async () => {
    const before = await boot.query(`SELECT datconnlimit, datacl::text, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`, [two.names.database]);
    const session = await loginA(two);
    for (let run = 0; run < 2; run++) {
      const watched = faulty(-1, 'before');
      let inDatabaseCalls = 0;
      const counting: TenantServer = { admin: watched.server.admin, inDatabase: (database, work) => { inDatabaseCalls++; return watched.server.inDatabase(database, work); } };
      expect(await ensureTenant(counting, { ...identity(two), connectionLimit: 10 })).toEqual({ database: 'existing' });
      expect(changes(watched.log)).toEqual([]);
      // A finished tenant is never connected to, so a database at its connection limit can still be checked.
      expect(inDatabaseCalls).toBe(0);
    }
    expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
    expect(await attempt(two.names.logins[0], PASSWORD('two-a'), two.names.database, 'SELECT count(*) FROM notes')).toBe('ok');
    expect((await boot.query(`SELECT datconnlimit, datacl::text, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1`, [two.names.database])).rows).toEqual(before.rows);
  });

  it.each(['before', 'after'] as const)('5b. ensure converges after an interruption %s any statement', async (when) => {
    const reference = tenant('two');
    const shape = async (target: Tenant) => {
      const swap = (value: unknown) => String(value).replaceAll(target.key, 'KEY');
      const database = (await boot.query(`SELECT datconnlimit, datacl::text AS acl, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`, [target.names.database])).rows
        .map((row) => ({ ...row, acl: swap(row.acl), comment: swap(row.comment) }));
      const roles = (await boot.query(
        `SELECT r.rolname, r.rolcanlogin, r.rolconfig::text AS config, shobj_description(r.oid, 'pg_authid') AS comment,
           (SELECT array_agg(DISTINCT g.rolname::text ORDER BY g.rolname::text) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of,
           (SELECT array_agg(DISTINCT g.rolname::text ORDER BY g.rolname::text) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.member WHERE m.roleid = r.oid) AS members
         FROM pg_roles r WHERE r.rolname = ANY($1) ORDER BY 1`, [[target.names.owner, ...target.names.logins]])).rows
        .map((row) => JSON.parse(swap(JSON.stringify(row))) as unknown);
      const admin = await connect(ADMIN, ADMIN_PASSWORD, target.names.database);
      const schema = await scalar(admin, `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'`);
      await close(admin);
      return { database, roles, schema: swap(schema) };
    };
    const expected = await shape(reference);
    let interruptions = 0;
    for (let failAt = 0; ; failAt++) {
      const target = tenant(`cut_${when}_${failAt}`);
      const interrupted = faulty(failAt, when);
      const outcome = await ensureTenant(interrupted.server, { ...identity(target), connectionLimit: 10 }).then(() => 'finished', (error: Error) => error.message);
      if (!interrupted.fired()) {
        // Past the last statement: the run was never interrupted, so every statement index has been covered.
        expect(outcome).toBe('finished');
        await dropTenant(server, identity(target));
        break;
      }
      expect(outcome).toBe(`injected interruption at statement ${failAt}`);
      interruptions++;
      // Whatever is there is recognised as this tenant's, by the server itself, or there is nothing yet.
      const listed = (await listTenants(server)).filter((entry) => entry.names.database === target.names.database);
      expect(listed).toEqual(await databaseExists(target.names.database) ? [identity(target)] : []);

      await ensureTenant(server, { ...identity(target), connectionLimit: 10 });
      expect(await shape(target), `after an interruption ${when} statement ${failAt}: ${interrupted.log[failAt]}`).toEqual(expected);
      const again = faulty(-1, 'before');
      await ensureTenant(again.server, { ...identity(target), connectionLimit: 10 });
      expect(changes(again.log), `not settled after an interruption ${when} statement ${failAt}`).toEqual([]);
      // And it works: a login can connect, act as the owner role and create a table.
      await setTenantLoginPassword(server, { ...identity(target), login: target.names.logins[0], password: PASSWORD(`${target.key}-a`) });
      expect(await attempt(target.names.logins[0], PASSWORD(`${target.key}-a`), target.names.database, 'CREATE TABLE works (i int)')).toBe('ok');
      expect(await attempt(two.names.logins[0], PASSWORD('two-a'), target.names.database)).toBe('42501');
      expect(await dropTenant(server, identity(target))).toEqual({ database: 'dropped' });
      expect(await roleNames(target)).toEqual([]);
    }
    // A fresh ensure is more than a dozen statements; make sure the loop really walked them.
    expect(interruptions).toBeGreaterThan(12);
    expect(await listTenants(server)).toEqual([identity(two)]);
  }, 300_000);

  it.each(['before', 'after'] as const)('5c. drop converges after an interruption %s any statement', async (when) => {
    let interruptions = 0;
    for (let failAt = 0; ; failAt++) {
      const target = await ready(`gone_${when}_${failAt}`);
      const holder = await loginA(target);
      const interrupted = faulty(failAt, when);
      const outcome = await dropTenant(interrupted.server, identity(target)).then(() => 'finished', (error: Error) => error.message);
      if (interrupted.fired()) { expect(outcome).toBe(`injected interruption at statement ${failAt}`); interruptions++; }
      await close(holder);
      // A second drop finishes the job; a later ensure of the half-dropped tenant would also be accepted.
      await dropTenant(server, identity(target));
      expect(await databaseExists(target.names.database)).toBe(false);
      expect(await roleNames(target)).toEqual([]);
      if (!interrupted.fired()) break;
    }
    expect(interruptions).toBeGreaterThan(5);
    expect(await listTenants(server)).toEqual([identity(two)]);
    const session = await loginA(two);
    expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
  }, 300_000);

  it('5d. a tenant re-ensured after a half-finished drop gets a working, isolated database again', async () => {
    const target = await ready('half');
    // The database went, the roles stayed (with their old password).
    await boot.query(`DROP DATABASE ${target.names.database} WITH (FORCE)`);
    expect(await ensureTenant(server, { ...identity(target), connectionLimit: 10 })).toEqual({ database: 'created' });
    expect(await attempt(target.names.logins[0], PASSWORD('half-a'), target.names.database, 'CREATE TABLE back (i int)')).toBe('ok');
    expect(await attempt(two.names.logins[0], PASSWORD('two-a'), target.names.database)).toBe('42501');
    await dropTenant(server, identity(target));
  });

  it('6. refuses a database or role that has the tenant\'s name but not its marker, and leaves it untouched', async () => {
    const snapshot = async (database: string) => (await boot.query(
      `SELECT d.datconnlimit, d.datacl::text AS acl, pg_get_userbyid(d.datdba) AS owner, shobj_description(d.oid, 'pg_database') AS comment,
         (SELECT array_agg(rolname::text ORDER BY 1) FROM pg_roles WHERE rolname LIKE 'app\\_%') AS roles
       FROM pg_database d WHERE d.datname = $1`, [database])).rows;
    const every = async (target: Tenant, tenantId: string, standing: 'foreign' | 'absent' = 'foreign') => {
      const calls = [
        () => ensureTenant(server, { names: target.names, tenantId, connectionLimit: 3 }),
        () => dropTenant(server, { names: target.names, tenantId }),
        () => setTenantLoginPassword(server, { names: target.names, tenantId, login: target.names.logins[0], password: PASSWORD('takeover') }),
        () => retireTenantLogin(server, { names: target.names, tenantId, login: target.names.logins[0] }),
      ];
      for (const call of calls) {
        const failure = await call().then(() => undefined, (error: unknown) => error);
        expect(failure).toBeInstanceOf(TenantRefusedError);
        expect((failure as TenantRefusedError).standing).toBe(standing);
      }
    };

    // a. No marker at all: a database someone made by hand with the name a tenant would get.
    const stray = tenant('stray');
    await adminClient.query(`CREATE DATABASE ${stray.names.database}`);
    const inStray = await connect(ADMIN, ADMIN_PASSWORD, stray.names.database);
    await inStray.query(`CREATE TABLE sentinel (value text); INSERT INTO sentinel VALUES ('must survive')`);
    await close(inStray);
    const strayBefore = await snapshot(stray.names.database);
    await every(stray, stray.tenantId);
    expect(await snapshot(stray.names.database)).toEqual(strayBefore);
    expect(await roleNames(stray)).toEqual([]);
    const strayCheck = await connect(ADMIN, ADMIN_PASSWORD, stray.names.database);
    expect(await scalar(strayCheck, 'SELECT value FROM sentinel')).toBe('must survive');
    await close(strayCheck);
    expect((await listTenants(server)).map((entry) => entry.names.database)).not.toContain(stray.names.database);

    // b. A marker that is not a tenant marker, and an unmarked database owned by an unmarked role of the right name.
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
    expect((await listTenants(server)).map((entry) => entry.names.database)).not.toContain(stray.names.database);

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
    expect((await listTenants(server)).filter((entry) => entry.names.database === claimed.names.database)).toEqual([identity(claimed)]);

    // d. No database, but a role with a tenant login's name and no marker: nothing is created around it.
    const squat = tenant('squat');
    await adminClient.query(`CREATE ROLE ${squat.names.logins[1]} LOGIN`);
    await every(squat, squat.tenantId);
    expect(await databaseExists(squat.names.database)).toBe(false);
    expect(await roleNames(squat)).toEqual([squat.names.logins[1]]);

    // e. One of the tenant's own roles was given server-wide powers behind Hypervibe's back: refused, not quietly kept.
    await boot.query(`ALTER ROLE ${claimed.names.logins[1]} CREATEDB`);
    await every(claimed, claimed.tenantId);
    expect(await databaseExists(claimed.names.database)).toBe(true);
    await boot.query(`ALTER ROLE ${claimed.names.logins[1]} NOCREATEDB`);

    // f. A tenant that does not exist cannot have a password set, and is distinguished from one that is not ours.
    const missing = tenant('missing');
    for (const call of [
      () => setTenantLoginPassword(server, { ...identity(missing), login: missing.names.logins[0], password: PASSWORD('missing') }),
      () => retireTenantLogin(server, { ...identity(missing), login: missing.names.logins[0] }),
    ]) {
      const failure = await call().then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(TenantRefusedError);
      expect((failure as TenantRefusedError).standing).toBe('absent');
    }
    expect(await dropTenant(server, identity(missing))).toEqual({ database: 'absent' });
    expect(await roleNames(missing)).toEqual([]);

    await close(claimedSession);
    expect(await dropTenant(server, identity(claimed))).toEqual({ database: 'dropped' });
    await boot.query(`DROP DATABASE ${stray.names.database}`);
    await boot.query(`DROP ROLE ${stray.names.owner}`);
    await boot.query(`DROP ROLE ${squat.names.logins[1]}`);
    expect(await listTenants(server)).toEqual([identity(two)]);
  }, 60_000);

  it('7. enforces each tenant\'s connection limit without affecting the other tenant', async () => {
    const small = await ready('small', 2);
    const first = await loginA(small);
    const second = await loginA(small);
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), small.names.database)).toBe('53300');
    // The full database does not cost the other tenant anything, and it can still be checked and changed.
    const twoSessions = [await loginA(two), await loginA(two), await loginA(two)];
    for (const session of twoSessions) expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
    expect(await ensureTenant(server, { ...identity(small), connectionLimit: 2 })).toEqual({ database: 'existing' });
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), small.names.database)).toBe('53300');
    expect(await scalar(first, 'SELECT 1')).toBe(1);

    // Raising the limit through ensure admits exactly one more.
    await ensureTenant(server, { ...identity(small), connectionLimit: 3 });
    const third = await loginA(small);
    expect(await scalar(third, 'SELECT 1')).toBe(1);
    expect(await attempt(small.names.logins[0], PASSWORD('small-a'), small.names.database)).toBe('53300');
    expect(await scalar(second, 'SELECT 1')).toBe(1);
    // A full tenant can still be dropped.
    expect(await dropTenant(server, identity(small))).toEqual({ database: 'dropped' });
    for (const session of twoSessions) expect(await scalar(session, 'SELECT body FROM notes')).toBe('two');
    expect(await listTenants(server)).toEqual([identity(two)]);
  });
});
