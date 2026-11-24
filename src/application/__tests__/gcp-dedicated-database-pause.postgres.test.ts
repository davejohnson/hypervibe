/**
 * Pausing a database on a server of the environment's own, and undoing it,
 * against a real, disposable PostgreSQL set up the way Hypervibe sets up a
 * dedicated database: two logins acting as `app_owner`, which owns the
 * database. Google's API for setting a login's password is replaced by the
 * local superuser doing exactly that; Secret Manager by a map.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import { pauseDedicatedDatabase, resumeDedicatedDatabase, type DedicatedPauseParams, type DedicatedPausePorts } from '../gcp-dedicated-database-pause.js';
import { connectionUrl, parseConnectionUrl } from '../infrastructure-engine-database.js';

function postgresBin(): string {
  const candidates = [process.env.HYPERVIBE_TEST_POSTGRES_BIN, '/Applications/Postgres.app/Contents/Versions/16/bin'].filter((entry): entry is string => Boolean(entry));
  try { candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()); } catch { /* runner installation below */ }
  if (existsSync('/usr/lib/postgresql')) for (const version of readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) candidates.push(`/usr/lib/postgresql/${version}/bin`);
  const bin = candidates.find((candidate) => existsSync(path.join(candidate, 'initdb')) && existsSync(path.join(candidate, 'pg_ctl')));
  if (!bin) throw new Error('PostgreSQL tools are required for the database pause tests.');
  return bin;
}

const bin = postgresBin();
const CONNECTION = 'demo-project:us-central1:hv-production-db-a1b2c3';
const labels = { 'managed-by': 'hypervibe', 'hv-environment': 'env-1' };
let directory: string | undefined;
let socket: string;
let boot: pg.Client;
const opened = new Set<pg.Client>();
const stop = () => {
  if (directory && existsSync(path.join(directory, 'data/postmaster.pid'))) spawnSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
};
async function connect(user: string, password: string | undefined, database = 'app'): Promise<pg.Client> {
  const client = new pg.Client({ host: socket, user, password, database, connectionTimeoutMillis: 10_000 });
  client.on('error', () => {});
  await client.connect();
  opened.add(client);
  return client;
}
const close = async (client: pg.Client) => { opened.delete(client); await client.end().catch(() => {}); };
/** Connects the way a service would, with a URL from a secret; resolves to the role it acts as or the PostgreSQL error code. */
async function reach(url: string): Promise<string> {
  const parsed = parseConnectionUrl(url)!;
  try {
    const client = await connect(parsed.login, parsed.password, parsed.databaseName);
    try { return String((await client.query('SELECT current_user AS role')).rows[0].role); } finally { await close(client); }
  } catch (error) { return String((error as { code?: string }).code); }
}
const alive = (client: pg.Client) => client.query('SELECT 1').then(() => true, () => false);

/** Secret Manager and what Hypervibe records with each version. */
const secrets = new Map<string, { labels: Record<string, string>; versions: string[] }>();
const everyPassword: string[] = [];
let failNext: 'publish' | 'set-second-password' | undefined;
let passwordsSet = 0;
const ports: DedicatedPausePorts = {
  async observeSecret(secretId) {
    const secret = secrets.get(secretId);
    return secret ? { state: 'present', value: { labels: secret.labels, hasEnabledVersion: secret.versions.length > 0, ...(secret.versions.length ? { latestVersion: String(secret.versions.length) } : {}) } } : { state: 'absent' };
  },
  async readSecretVersion(secretId, version) {
    const value = secrets.get(secretId)?.versions[Number(version) - 1];
    return value ? { state: 'present', value } : { state: 'absent' };
  },
  async publishSecret(secretId, recorded, value) {
    if (failNext === 'publish') { failNext = undefined; return { success: false, status: 'pending', message: 'The value write has an unknown outcome.' }; }
    const secret = secrets.get(secretId)!;
    secret.versions.push(value);
    secret.labels = recorded;
    return undefined;
  },
  async setLoginPassword(login, password) {
    passwordsSet++;
    if (failNext === 'set-second-password' && passwordsSet % 2 === 0) { failNext = undefined; return { success: false, status: 'pending', message: `The change to database login ${login} has not finished. Run the same command again.` }; }
    everyPassword.push(password);
    await boot.query(`ALTER ROLE ${login} PASSWORD '${password}'`);
    return undefined;
  },
  async withSession(login, password, work) {
    const client = await connect(login, password);
    try { return await work({ query: (text, values) => client.query(text, values) }); } finally { await close(client); }
  },
};
const params: DedicatedPauseParams = { environmentName: 'production', instanceName: 'hv-production-db-a1b2c3', connectionName: CONNECTION, databaseName: 'app',
  secret: { id: 'hv-production-database-url', labels, version: '1' }, copySecret: { id: 'hv-production-database-copy', labels }, sessionWaitMs: 3000 };
const appUrl = () => secrets.get(params.secret.id)!.versions[0]!;
const copyUrl = () => secrets.get(params.copySecret.id)!.versions.at(-1)!;
const DENIED = ['28P01', '28000'];
const shown: ActionResult[] = [];
const pause = async (override: Partial<DedicatedPauseParams> = {}) => { const result = await pauseDedicatedDatabase(ports, { ...params, ...override }); shown.push(result); return result; };
const resume = async (override: Partial<DedicatedPauseParams> = {}) => { const result = await resumeDedicatedDatabase(ports, { ...params, ...override }); shown.push(result); return result; };

beforeAll(async () => {
  directory = mkdtempSync('/tmp/hv-pause-own-');
  process.once('exit', stop);
  socket = path.join(directory, 's');
  mkdirSync(socket);
  execFileSync(`${bin}/initdb`, ['-D', path.join(directory, 'data'), '-U', 'boot', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { stdio: 'pipe' });
  writeFileSync(path.join(directory, 'data/postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\nmax_connections = 60\n`);
  writeFileSync(path.join(directory, 'data/pg_hba.conf'), 'local all boot trust\nlocal all all scram-sha-256\n');
  execFileSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'), '-w', 'start'], { stdio: 'pipe' });
  boot = await connect('boot', undefined, 'postgres');
  // As Hypervibe's first credential step leaves a dedicated database.
  await boot.query(`CREATE ROLE app_owner NOLOGIN`);
  for (const login of ['app_a', 'app_b']) {
    await boot.query(`CREATE ROLE ${login} LOGIN PASSWORD 'never-published-${login}' IN ROLE app_owner`);
    await boot.query(`ALTER ROLE ${login} SET role = 'app_owner'`);
  }
  await boot.query(`CREATE ROLE reporting LOGIN PASSWORD 'reporting-password-0123'`);
  await boot.query(`CREATE DATABASE app OWNER app_owner TEMPLATE template0`);
}, 60_000);

/** Each test starts from a running app: app_a's password is in version 1 of the connection secret; app_b's is one nobody has. */
beforeEach(async () => {
  failNext = undefined;
  const password = 'app-password-published-0123456789';
  everyPassword.push(password);
  await boot.query(`ALTER ROLE app_a PASSWORD '${password}'`);
  await boot.query(`ALTER ROLE app_b PASSWORD 'discarded-${Date.now()}'`);
  secrets.clear();
  secrets.set(params.secret.id, { labels: { ...labels, 'hv-db-instance': params.instanceName, 'hv-db-login': 'app_a', 'hv-db-generation': '1' }, versions: [connectionUrl('app_a', password, 'app', CONNECTION)] });
  secrets.set(params.copySecret.id, { labels, versions: [] });
});

afterEach(async () => {
  for (const client of [...opened]) if (client !== boot) await close(client);
});

afterAll(async () => {
  try {
    for (const client of [...opened]) await close(client);
  } finally {
    stop();
    if (directory) {
      const stopped = !existsSync(path.join(directory, 'data/postmaster.pid'));
      rmSync(directory, { recursive: true, force: true });
      expect(stopped).toBe(true);
    }
  }
});

describe('pausing a database on a server of its own', () => {
  it('shuts the app out, ends its sessions, proves nobody is connected, and leaves one other way in for the copy', async () => {
    const service = await connect('app_a', parseConnectionUrl(appUrl())!.password);
    expect(await reach(appUrl())).toBe('app_owner');
    const result = await pause();
    expect(result).toEqual({ success: true, data: { paused: true, copySecretId: params.copySecret.id, copySecretVersion: '1' },
      message: 'production\'s database is paused: the app cannot connect and no session is open. Only the copy login (hv-production-database-copy, version 1) can.' });
    expect(DENIED).toContain(await reach(appUrl()));
    expect(await alive(service)).toBe(false);
    expect((await boot.query(`SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = 'app'`)).rows[0].open).toBe(0);
    // The copy login is the login the app did not hold, acting as the owner, and its URL is in its own secret only.
    expect(parseConnectionUrl(copyUrl())).toMatchObject({ login: 'app_b', databaseName: 'app', connectionName: CONNECTION });
    expect(await reach(copyUrl())).toBe('app_owner');
    expect(secrets.get(params.copySecret.id)!.labels).toMatchObject({ 'hv-db-login': 'app_b', 'hv-db-copy': 'true', 'hv-environment': 'env-1' });
    expect(secrets.get(params.secret.id)!.versions).toHaveLength(1);
  });

  it('undoes the pause: the exact connection the services hold works again, and the copy login does not', async () => {
    await pause();
    const copy = copyUrl();
    const copying = await connect('app_b', parseConnectionUrl(copy)!.password);
    const result = await resume();
    expect(result).toEqual({ success: true, data: { paused: false },
      message: 'production\'s database is no longer paused: the connection its services hold (hv-production-database-url, version 1) works again, and the copy login\'s password is one nobody has.' });
    expect(await reach(appUrl())).toBe('app_owner');
    expect(DENIED).toContain(await reach(copy));
    expect(await alive(copying)).toBe(false);
    // The app's secret was never rewritten: its services need no new version.
    expect(secrets.get(params.secret.id)!.versions).toHaveLength(1);
  });

  it('is not paused while anyone else is still connected, and says so; the app stays shut out until it is run again', async () => {
    const person = await connect('reporting', 'reporting-password-0123');
    const waiting = await pause();
    expect(waiting).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/1 session\(s\) are still connected to it \(1 of them not the app's\)\. It is not paused until they are gone/) });
    expect(DENIED).toContain(await reach(appUrl()));
    expect(secrets.get(params.copySecret.id)!.versions).toHaveLength(0);
    await close(person);
    expect((await pause()).success).toBe(true);
  });

  it('can be repeated and undone in any order, each time ending in a known state', async () => {
    expect((await pause()).success).toBe(true);
    const first = copyUrl();
    // Pausing a paused database: still paused, with a new copy password; the old one is gone.
    expect((await pause()).success).toBe(true);
    expect(DENIED).toContain(await reach(first));
    expect(await reach(copyUrl())).toBe('app_owner');
    expect(DENIED).toContain(await reach(appUrl()));
    expect((await resume()).success).toBe(true);
    // Undoing twice, and undoing a database that is not paused: the app keeps working, and its open session is left alone.
    const service = await connect('app_a', parseConnectionUrl(appUrl())!.password);
    expect((await resume()).success).toBe(true);
    expect(await alive(service)).toBe(true);
    expect(await reach(appUrl())).toBe('app_owner');
  });

  it.each(['set-second-password', 'publish'] as const)('recovers from a pause cut off at "%s", by undoing or by pausing again', async (step) => {
    failNext = step;
    const cut = await pause();
    expect(cut).toMatchObject({ success: false, status: 'pending' });
    // Cut off anywhere, the app is already shut out; nothing in between counts as running.
    expect(DENIED).toContain(await reach(appUrl()));
    expect((await resume()).success).toBe(true);
    expect(await reach(appUrl())).toBe('app_owner');
    failNext = step;
    await pause();
    expect((await pause()).success).toBe(true);
    expect(await reach(copyUrl())).toBe('app_owner');
    expect(DENIED).toContain(await reach(appUrl()));
  });

  it.each([
    ['a password change is still in flight', () => { secrets.get(params.secret.id)!.labels['hv-db-retire'] = 'app_b'; }, {}, /password is still being changed/],
    ['the services are pinned to an older version than the newest', () => {}, { secret: { ...params.secret, version: '2' } }, /newer version than the one its services use/],
    ['the secret was made for another server', () => { secrets.get(params.secret.id)!.labels['hv-db-instance'] = 'hv-other-db'; }, {}, /does not hold a login for database server/],
    ['the secret belongs to another environment', () => { secrets.get(params.secret.id)!.labels['hv-environment'] = 'env-2'; }, {}, /not owned by this Hypervibe environment/],
    ['the secret records a login Hypervibe did not make', () => { secrets.get(params.secret.id)!.labels['hv-db-login'] = 'postgres'; }, {}, /does not hold a login for database server/],
    ['there is no connection secret', () => { secrets.delete(params.secret.id); }, {}, /has no connection secret/],
    ['the copy would go into the app\'s own secret', () => {}, { copySecret: { id: params.secret.id, labels } }, /needs a secret of its own/],
  ] as Array<[string, () => void, Partial<DedicatedPauseParams>, RegExp]>)('refuses to pause or undo, changing nothing, when %s', async (_what, arrange, override, reason) => {
    const url = appUrl();
    arrange();
    for (const call of [pause, resume]) {
      expect(await call(override)).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(reason) });
      expect(await reach(url)).toBe('app_owner');
    }
  });

  it('refuses to undo when the pinned version is not the recorded connection, and gives no login back', async () => {
    await pause();
    for (const wrong of [connectionUrl('app_b', 'x'.repeat(24), 'app', CONNECTION), connectionUrl('app_a', 'x'.repeat(24), 'other', CONNECTION), connectionUrl('app_a', 'x'.repeat(24), 'app', 'demo-project:us-central1:hv-other'), 'not a url']) {
      const kept = secrets.get(params.secret.id)!.versions[0]!;
      secrets.get(params.secret.id)!.versions[0] = wrong;
      expect(await resume()).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/is not the connection to production's database that was recorded\. Nothing was changed/) });
      secrets.get(params.secret.id)!.versions[0] = kept;
      expect(DENIED).toContain(await reach(kept));
    }
    expect(await reach(copyUrl())).toBe('app_owner');
  });

  it('never puts a password in a result', () => {
    const text = JSON.stringify(shown);
    expect(shown.length).toBeGreaterThan(20);
    expect(everyPassword.length).toBeGreaterThan(10);
    for (const password of everyPassword) expect(text).not.toContain(password);
  });
});
