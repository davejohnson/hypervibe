/**
 * Pausing one environment's database on the app's shared server, and undoing
 * it, through the module's entry. Two environments share one real, disposable
 * PostgreSQL whose administrator is a plain CREATEROLE/CREATEDB login; Google
 * is replaced by fakes. No cloud is contacted.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ActionResult } from '../../../domain/plan/converge.executor.js';
import type { GcpDatabaseBinding } from '../../gcp-database-location.js';
import { parseConnectionUrl } from '../../infrastructure-engine-database.js';
import { sharedDatabase, type SharedDatabaseCloud, type SharedDatabaseEngine, type SharedDatabasePauseRequest } from '../index.js';

function postgresBin(): string {
  const candidates = [process.env.HYPERVIBE_TEST_POSTGRES_BIN, '/Applications/Postgres.app/Contents/Versions/16/bin'].filter((entry): entry is string => Boolean(entry));
  try { candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()); } catch { /* runner installation below */ }
  if (existsSync('/usr/lib/postgresql')) for (const version of readdirSync('/usr/lib/postgresql').sort((a, b) => Number(b) - Number(a))) candidates.push(`/usr/lib/postgresql/${version}/bin`);
  const bin = candidates.find((candidate) => existsSync(path.join(candidate, 'initdb')) && existsSync(path.join(candidate, 'pg_ctl')));
  if (!bin) throw new Error('PostgreSQL tools are required for the shared database tests.');
  return bin;
}

const bin = postgresBin();
const major = Number(/\(PostgreSQL\) (\d+)/.exec(execFileSync(`${bin}/postgres`, ['--version'], { encoding: 'utf8' }))?.[1]);
const GCP = 'demo-project';
const REGION = 'us-central1';
const INSTANCE = 'hv-demo-app-shared-a1b2c3';
const project = { id: 'project-1', name: 'Demo App' };
const production = { id: 'env-production-1', name: 'production' };
const staging = { id: 'env-staging-1', name: 'staging' };
type Environment = typeof production;
const secretIdOf = (environment: Environment) => `hv-${environment.name}-database-url`;
const copyIdOf = (environment: Environment) => `hv-${environment.name}-database-copy`;
const labelsOf = (environment: Environment) => ({ 'managed-by': 'hypervibe', 'hv-environment': environment.id });

let directory: string | undefined;
let socket: string;
let boot: pg.Client;
const opened = new Set<pg.Client>();
const stop = () => {
  if (directory && existsSync(path.join(directory, 'data/postmaster.pid'))) spawnSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
};
async function connect(user: string, password: string | undefined, database: string): Promise<pg.Client> {
  const client = new pg.Client({ host: socket, user, password, database, connectionTimeoutMillis: 10_000 });
  client.on('error', () => {});
  await client.connect();
  opened.add(client);
  return client;
}
const close = async (client: pg.Client) => { opened.delete(client); await client.end().catch(() => {}); };
async function reach(url: string): Promise<string> {
  const parsed = parseConnectionUrl(url)!;
  try {
    const client = await connect(parsed.login, parsed.password, parsed.databaseName);
    try { return String((await client.query('SELECT current_database() AS name')).rows[0].name); } finally { await close(client); }
  } catch (error) { return String((error as { code?: string }).code); }
}
const alive = (client: pg.Client) => client.query('SELECT 1').then(() => true, () => false);
const DENIED = ['28P01', '28000'];

const secrets = new Map<string, { labels: Record<string, string>; versions: string[] }>();
const administratorPasswords: string[] = [];
let failNextPublish = false;
const cloud: SharedDatabaseCloud = {
  listServers: async () => ({ state: 'listed', servers: [{ instanceName: INSTANCE, region: REGION, runnable: true, deletionProtection: true, labels: { 'managed-by': 'hypervibe', 'hv-shared-database': 'project-1' } }] }),
  async setServerLogin(_project, _instance, login, password) {
    administratorPasswords.push(password);
    const exists = (await boot.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login])).rows.length === 1;
    await boot.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN CREATEROLE CREATEDB PASSWORD '${password}'`);
    return undefined;
  },
  async observeConnectionSecret(_project, secretId) {
    const secret = secrets.get(secretId);
    return secret ? { state: 'present', value: { labels: secret.labels, hasEnabledVersion: secret.versions.length > 0, ...(secret.versions.length ? { latestVersion: String(secret.versions.length) } : {}) } } : { state: 'absent' };
  },
  async readSecretVersion(_project, secretId, version) {
    const value = secrets.get(secretId)?.versions[Number(version) - 1];
    return value ? { state: 'present', value } : { state: 'absent' };
  },
  async publishConnectionSecret(_project, secretId, labels, value) {
    if (failNextPublish) { failNextPublish = false; return { success: false, status: 'pending', message: 'The value write has an unknown outcome.' }; }
    const secret = secrets.get(secretId)!;
    secret.versions.push(value);
    secret.labels = labels;
    return undefined;
  },
  relabelConnectionSecret(_project, secretId, _version, labels) { secrets.get(secretId)!.labels = labels; return true; },
  async withSession(target, work) {
    const client = await connect(target.user, target.password, target.database);
    try { return await work({ query: (text, values) => client.query(text, values) }); } finally { await close(client); }
  },
};
const engine: SharedDatabaseEngine = { plan: async () => { throw new Error('The server exists; nothing plans it here.'); }, apply: async () => { throw new Error('unused'); } };

const bindings = new Map<string, GcpDatabaseBinding>();
let running: string[] = [];
const base = (environment: Environment) => ({ project, environment, gcpProjectId: GCP, region: REGION, binding: bindings.get(environment.id), engine, cloud,
  secret: { id: secretIdOf(environment), labels: labelsOf(environment) }, runningSecretVersions: async () => ({ versions: running }) });
/** hv_plan and hv_apply for an environment's database, as the planner would run them. */
async function converge(environment: Environment, passwordGeneration = 1): Promise<string[]> {
  const planned = await sharedDatabase.plan({ ...base(environment), desired: { provider: 'cloudsql', engine: 'postgres', placement: 'app', passwordGeneration } as never });
  if (!planned || 'blocked' in planned) throw new Error(`not planned: ${JSON.stringify(planned)}`);
  for (const action of planned.actions) {
    const result = await sharedDatabase.apply({ ...base(environment), action, reviewed: planned.reviewed,
      record: (database) => { if (database) bindings.set(environment.id, { database }); else bindings.delete(environment.id); } });
    if (!result.success) throw new Error(result.message);
  }
  return planned.actions.map((action) => action.id);
}
const record = (environment: Environment) => bindings.get(environment.id)!.database!;
const appUrl = (environment: Environment) => secrets.get(secretIdOf(environment))!.versions.at(-1)!;
const copyUrl = (environment: Environment) => secrets.get(copyIdOf(environment))!.versions.at(-1)!;
const request = (environment: Environment, override: Partial<SharedDatabasePauseRequest> = {}): SharedDatabasePauseRequest => ({
  project, environment, gcpProjectId: GCP, region: REGION, binding: bindings.get(environment.id), cloud,
  secret: { id: secretIdOf(environment), labels: labelsOf(environment), version: String(secrets.get(secretIdOf(environment))!.versions.length) },
  copySecret: { id: copyIdOf(environment), labels: labelsOf(environment) }, ...override });
const shown: ActionResult[] = [];
const pause = async (environment: Environment, override: Partial<SharedDatabasePauseRequest> = {}) => { const result = await sharedDatabase.pause(request(environment, override)); shown.push(result); return result; };
const resume = async (environment: Environment, override: Partial<SharedDatabasePauseRequest> = {}) => { const result = await sharedDatabase.resume(request(environment, override)); shown.push(result); return result; };

beforeAll(async () => {
  directory = mkdtempSync('/tmp/hv-pause-shared-');
  process.once('exit', stop);
  socket = path.join(directory, 's');
  mkdirSync(socket);
  execFileSync(`${bin}/initdb`, ['-D', path.join(directory, 'data'), '-U', 'boot', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { stdio: 'pipe' });
  writeFileSync(path.join(directory, 'data/postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\nmax_connections = 60\n`);
  writeFileSync(path.join(directory, 'data/pg_hba.conf'), 'local all boot trust\nlocal all all scram-sha-256\n');
  execFileSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-l', path.join(directory, 'postgres.log'), '-w', 'start'], { stdio: 'pipe' });
  boot = await connect('boot', undefined, 'postgres');
  for (const environment of [production, staging]) {
    secrets.set(secretIdOf(environment), { labels: labelsOf(environment), versions: [] });
    secrets.set(copyIdOf(environment), { labels: labelsOf(environment), versions: [] });
  }
}, 60_000);

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

describe.runIf(major >= 15)('pausing one environment\'s database on the shared server', () => {
  it('starts with two environments running on one server', async () => {
    expect(await converge(production)).toEqual(['shared-database:allocate']);
    expect(await converge(staging)).toEqual(['shared-database:allocate']);
    expect(await reach(appUrl(production))).toBe(record(production).databaseName);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
  });

  it('refuses a database that is not fully set up', async () => {
    const half = { database: { ...record(staging), activeLogin: undefined, allocation: 'started' as const } };
    for (const call of [pause, resume]) {
      expect(await call(staging, { binding: half })).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/not fully set up, so it cannot be paused/) });
      expect(await call(staging, { binding: undefined })).toMatchObject({ success: false, status: 'blocked' });
    }
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
  });

  it('shuts staging\'s app out, ends its sessions, proves nobody is connected, and leaves production alone', async () => {
    const service = await connect(record(staging).activeLogin!, parseConnectionUrl(appUrl(staging))!.password, record(staging).databaseName!);
    const neighbour = await connect(record(production).activeLogin!, parseConnectionUrl(appUrl(production))!.password, record(production).databaseName!);
    const result = await pause(staging);
    expect(result).toEqual({ success: true, data: { paused: true, copySecretId: 'hv-staging-database-copy', copySecretVersion: '1' },
      message: 'staging\'s database is paused: the app cannot connect and no session is open. Only the copy login (hv-staging-database-copy, version 1) can.' });
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect(await alive(service)).toBe(false);
    expect((await boot.query('SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1', [record(staging).databaseName])).rows[0].open).toBe(0);
    // The copy login is staging's other login, on staging's database, acting as its owner; its URL is in its own secret only.
    expect(parseConnectionUrl(copyUrl(staging))).toMatchObject({ login: `${record(staging).databaseName}_b`, databaseName: record(staging).databaseName, connectionName: `${GCP}:${REGION}:${INSTANCE}` });
    expect(await reach(copyUrl(staging))).toBe(record(staging).databaseName);
    expect(secrets.get(secretIdOf(staging))!.versions).toHaveLength(1);
    // Production never noticed: its open session, its secret and its login are as they were.
    expect(await alive(neighbour)).toBe(true);
    expect(await reach(appUrl(production))).toBe(record(production).databaseName);
    expect(secrets.get(copyIdOf(production))!.versions).toHaveLength(0);
  });

  it('undoes the pause: the exact connection staging\'s services hold works again, and the copy login does not', async () => {
    const copy = copyUrl(staging);
    const copying = await connect(parseConnectionUrl(copy)!.login, parseConnectionUrl(copy)!.password, record(staging).databaseName!);
    const result = await resume(staging);
    expect(result).toEqual({ success: true, data: { paused: false },
      message: 'staging\'s database is no longer paused: the connection its services hold (hv-staging-database-url, version 1) works again, and the copy login is switched off.' });
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    expect(DENIED).toContain(await reach(copy));
    expect(await alive(copying)).toBe(false);
    // The app's secret was never rewritten, and the database is as fully set up as before.
    expect(secrets.get(secretIdOf(staging))!.versions).toHaveLength(1);
    expect(await converge(staging)).toEqual([]);
  });

  it('is not paused while anyone else is still connected to that database, and says so', async () => {
    const person = await connect('boot', undefined, record(staging).databaseName!);
    const waiting = await pause(staging);
    expect(waiting).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/1 session\(s\) are still connected to its database \(1 of them not the app's\)\. It is not paused until they are gone/) });
    expect(DENIED).toContain(await reach(appUrl(staging)));
    await close(person);
    // A session on another environment's database does not count.
    const elsewhere = await connect('boot', undefined, record(production).databaseName!);
    expect((await pause(staging)).success).toBe(true);
    await close(elsewhere);
    expect((await resume(staging)).success).toBe(true);
  });

  it('can be repeated and undone in any order, each time ending in a known state', async () => {
    expect((await pause(staging)).success).toBe(true);
    const first = copyUrl(staging);
    expect((await pause(staging)).success).toBe(true);
    expect(DENIED).toContain(await reach(first));
    expect(await reach(copyUrl(staging))).toBe(record(staging).databaseName);
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect((await resume(staging)).success).toBe(true);
    // Undoing twice, and undoing a database that is not paused: the app keeps working and its open session is left alone.
    const service = await connect(record(staging).activeLogin!, parseConnectionUrl(appUrl(staging))!.password, record(staging).databaseName!);
    expect((await resume(staging)).success).toBe(true);
    expect(await alive(service)).toBe(true);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
  });

  it('recovers from a pause cut off before the copy login was stored, by undoing or by pausing again', async () => {
    failNextPublish = true;
    const cut = await pause(staging);
    expect(cut).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/is paused, but the copy login could not be stored/) });
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect((await resume(staging)).success).toBe(true);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    failNextPublish = true;
    await pause(staging);
    expect((await pause(staging)).success).toBe(true);
    expect(await reach(copyUrl(staging))).toBe(record(staging).databaseName);
    expect((await resume(staging)).success).toBe(true);
  });

  it('refuses, changing nothing, when the pinned version is not the newest, the secrets are mixed up, or the secret is another environment\'s', async () => {
    const cases: Array<[Partial<SharedDatabasePauseRequest>, RegExp]> = [
      [{ secret: { id: secretIdOf(staging), labels: labelsOf(staging), version: '7' } }, /newer version than the one its services use \(7\)/],
      [{ copySecret: { id: secretIdOf(staging), labels: labelsOf(staging) } }, /needs a secret of its own/],
      [{ secret: { id: secretIdOf(production), labels: labelsOf(staging), version: '1' } }, /not owned by this Hypervibe environment/],
      [{ secret: { id: secretIdOf(production), labels: labelsOf(production), version: '1' } }, /does not hold the login recorded for its database/],
    ];
    for (const [override, reason] of cases) {
      for (const call of [pause, resume]) expect(await call(staging, override)).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(reason) });
    }
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    expect(await reach(appUrl(production))).toBe(record(production).databaseName);
  });

  it('refuses while a password change is still in flight, when the other login is one the services may still hold', async () => {
    expect(await converge(staging, 2)).toEqual(['shared-database:rotate']);
    const previous = secrets.get(secretIdOf(staging))!.versions[0]!;
    for (const call of [pause, resume]) expect(await call(staging)).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/password is still being changed/) });
    // Neither login was touched: services on either version keep working.
    expect(await reach(previous)).toBe(record(staging).databaseName);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    running = ['2'];
    expect(await converge(staging, 2)).toEqual(['shared-database:retire']);
    // Rotation finished: the pause works on the new login, and undoing restores exactly version 2.
    expect((await pause(staging)).success).toBe(true);
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect((await resume(staging)).success).toBe(true);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    expect(parseConnectionUrl(appUrl(staging))!.login).toBe(record(staging).activeLogin);
  });

  it('never puts a password in a result', () => {
    const text = JSON.stringify(shown);
    const passwords = [...administratorPasswords, ...[...secrets.values()].flatMap((secret) => secret.versions).map((url) => parseConnectionUrl(url)!.password)];
    expect(shown.length).toBeGreaterThan(20);
    expect(passwords.length).toBeGreaterThan(15);
    for (const password of passwords) expect(text).not.toContain(password);
  });
});
