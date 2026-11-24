/**
 * Pausing a database on a server of the environment's own, and undoing it,
 * through the real Google ports: Secret Manager answered in memory (so the
 * real secret write path and its records run), the Admin API's password change
 * and the connector's sessions redirected to a real, disposable PostgreSQL set
 * up the way Hypervibe sets up a dedicated database. No cloud is contacted.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import type { ActionResult } from '../../domain/plan/converge.executor.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { googleDedicatedPausePorts, pauseDedicatedDatabase, resumeDedicatedDatabase, type DedicatedPauseParams } from '../gcp-dedicated-database-pause.js';
import { connectionUrl, databaseCopySecretId, parseConnectionUrl } from '../infrastructure-engine-database.js';
import { writeSecretVersion } from '../infrastructure-engine.js';
import { fakeSecretManager, startPostgres, type LocalPostgres } from './pause-fixtures.js';

const GCP = 'demo-project';
const INSTANCE = 'hv-production-db-a1b2c3';
const CONNECTION = `${GCP}:us-central1:${INSTANCE}`;

/** Reached by the mocked Admin API and connector below, which are hoisted above everything else in this file. */
const local = vi.hoisted(() => ({
  server: undefined as unknown as import('./pause-fixtures.js').LocalPostgres,
  /** Passwords handed to the Admin API, applied or not. */
  passwords: [] as string[],
  /** The Admin API answers "another operation is in progress" this many times. */
  busy: 0,
  /** Password changes still to succeed before one is cut off with an unknown outcome. */
  cutAfter: undefined as number | undefined,
  /** Logins the server has no free connection for. */
  full: new Set<string>(),
  /** Sessions that ignore being ended. */
  stubborn: false,
}));

vi.mock('../infrastructure-engine-database.js', async (original) => ({
  ...await original<typeof import('../infrastructure-engine-database.js')>(),
  setCloudSqlLoginPassword: async (_token: string, _project: string, _instance: string, login: string, password: string) => {
    local.passwords.push(password);
    if (local.busy > 0) { local.busy--; return { success: false, message: `Setting database login ${login} failed (HTTP 409).`, error: 'HTTP 409' }; }
    if (local.cutAfter !== undefined && local.cutAfter-- === 0) { local.cutAfter = undefined; return { success: false, status: 'pending', message: `The change to database login ${login} has an unknown outcome.` }; }
    await local.server.boot.query(`ALTER ROLE ${login} PASSWORD '${password}'`);
    return 'done';
  },
  withCloudSqlSession: async (_account: unknown, _connectionName: string, user: string, password: string, database: string, work: (client: pg.Client) => Promise<unknown>) => {
    if (local.full.has(user)) throw Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    const client = await local.server.connect(user, password, database);
    const real = client.query.bind(client);
    if (local.stubborn) (client as { query: unknown }).query = (text: string, values?: unknown[]) => (text.includes('pg_terminate_backend') ? Promise.resolve({ rows: [] }) : real(text, values as never));
    try { return await work(client); } finally { await local.server.close(client); }
  },
}));

const google = fakeSecretManager(GCP);
let logins = ['app_a', 'app_b', 'postgres'];
let home: string;
let ctx: CommandContext;
let server: LocalPostgres;
let params: DedicatedPauseParams;
let counter = 0;
let neighbours = 0;
const shown: ActionResult[] = [];
const ports = () => googleDedicatedPausePorts({ token: 'synthetic-token', credentials: () => ({}), gcpProjectId: GCP, instanceName: INSTANCE, connectionName: CONNECTION, databaseName: 'app' });
const pause = async (override: Partial<DedicatedPauseParams> = {}) => { const result = await pauseDedicatedDatabase(ports(), { ...params, ...override }); shown.push(result); return result; };
const resume = async (override: Partial<DedicatedPauseParams> = {}) => { const result = await resumeDedicatedDatabase(ports(), { ...params, ...override }); shown.push(result); return result; };
const versions = (secretId: string) => google.state.secrets.get(secretId)!.versions;
const appUrl = () => versions(params.secret.id).at(-1)!;
const copyId = () => databaseCopySecretId(params.secret.id);
const copyUrl = () => versions(copyId()).at(-1)!;
/** Connects the way a service would, with a URL from a secret; resolves to the role it acts as or the PostgreSQL error code. */
async function reach(url: string): Promise<string> {
  const parsed = parseConnectionUrl(url)!;
  try {
    const client = await server.connect(parsed.login, parsed.password, parsed.databaseName);
    try { return String((await client.query('SELECT current_user AS role')).rows[0].role); } finally { await server.close(client); }
  } catch (error) { return String((error as { code?: string }).code); }
}
const alive = (client: pg.Client) => client.query('SELECT 1').then(() => true, () => false);
const session = (url: string) => { const parsed = parseConnectionUrl(url)!; return server.connect(parsed.login, parsed.password, parsed.databaseName); };
const DENIED = ['28P01', '28000'];
const SHUT_OUT = /^production-\d+'s app is shut out of its database, and the pause did not finish: .* Run the same command again to finish it, or undo the pause to let the app back in\.$/;

beforeAll(async () => {
  server = local.server = await startPostgres('hv-pause-own');
  // As Hypervibe's first credential step leaves a dedicated database.
  await server.boot.query('CREATE ROLE app_owner NOLOGIN');
  for (const login of ['app_a', 'app_b']) {
    await server.boot.query(`CREATE ROLE ${login} LOGIN PASSWORD 'never-published-${login}' IN ROLE app_owner`);
    await server.boot.query(`ALTER ROLE ${login} SET role = 'app_owner'`);
  }
  await server.boot.query(`CREATE ROLE reporting LOGIN PASSWORD 'reporting-password-0123'`);
  await server.boot.query('CREATE DATABASE app OWNER app_owner TEMPLATE template0');
  await server.boot.query('CREATE DATABASE elsewhere TEMPLATE template0');
  home = mkdtempSync(path.join(tmpdir(), 'hv-pause-own-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', home);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(home, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const secret = await google.answer(input, init);
    if (secret) return secret;
    const url = new URL(String(input));
    if (url.hostname === 'sqladmin.googleapis.com' && url.pathname.endsWith('/users')) return google.json({ items: logins.map((name) => ({ name })) });
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url.hostname}${url.pathname}`);
  }));
  ctx = createCommandContext();
}, 60_000);

/** Each test is its own environment with a running app: app_a's password is in version 1 of its connection secret, stored the real way. */
beforeEach(async () => {
  Object.assign(local, { busy: 0, cutAfter: undefined, stubborn: false });
  local.full.clear();
  logins = ['app_a', 'app_b', 'postgres'];
  const name = `production-${++counter}`;
  const project = ctx.repos.projects.create({ name: `app-${counter}` });
  const environment = ctx.repos.environments.create({ projectId: project.id, name });
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': environment.id };
  params = { environmentName: name, instanceName: INSTANCE, connectionName: CONNECTION, databaseName: 'app', secret: { id: `hv-${name}-database-url`, labels, version: '1' }, sessionWaitMs: 1500 };
  google.state.secrets.set(params.secret.id, { labels, versions: [] });
  google.state.secrets.set(copyId(), { labels, versions: [] });
  const password = `app-password-published-${counter}-0123456789`;
  local.passwords.push(password);
  await server.boot.query(`ALTER ROLE app_a PASSWORD '${password}'`);
  await server.boot.query(`ALTER ROLE app_b PASSWORD 'discarded-${counter}-${Date.now()}'`);
  expect(await writeSecretVersion('synthetic-token', GCP, params.secret.id, { ...labels, 'hv-db-instance': INSTANCE, 'hv-db-login': 'app_a', 'hv-db-generation': '1' }, connectionUrl('app_a', password, 'app', CONNECTION))).toBeUndefined();
  shown.length = 0;
});

afterEach(async () => {
  // Whatever a test did, nothing it was told carries a password: neither one handed to Google, nor one stored in a secret, kept or not.
  const text = JSON.stringify(shown);
  for (const secret of [...local.passwords, ...google.state.sent.map((url) => parseConnectionUrl(url)?.password ?? url)]) expect(text).not.toContain(secret);
  await server.closeOthers();
});

afterAll(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  rmSync(home, { recursive: true, force: true });
  expect(await server.stop()).toBe(true);
});

describe('pausing a database on a server of its own', () => {
  it('shuts the app out, ends its sessions, proves nobody is connected, and leaves one other way in for the copy', async () => {
    const service = await session(appUrl());
    expect(await reach(appUrl())).toBe('app_owner');
    const result = await pause();
    expect(result).toEqual({ success: true, data: { paused: true, copySecretId: copyId(), copySecretVersion: '1' },
      message: `${params.environmentName}'s database is paused: the app cannot connect and no session is open. Only the copy login (${copyId()}, version 1) can.` });
    expect(DENIED).toContain(await reach(appUrl()));
    expect(await alive(service)).toBe(false);
    expect((await server.boot.query(`SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = 'app'`)).rows[0].open).toBe(0);
    // The copy login is the login the app did not hold, acting as the owner, and its URL is in its own secret only.
    expect(parseConnectionUrl(copyUrl())).toMatchObject({ login: 'app_b', databaseName: 'app', connectionName: CONNECTION });
    expect(await reach(copyUrl())).toBe('app_owner');
    expect(versions(params.secret.id)).toHaveLength(1);
  });

  it('undoes the pause: the exact connection the services hold works again, and the copy login does not', async () => {
    expect((await pause()).success).toBe(true);
    const copy = copyUrl();
    const copying = await session(copy);
    const result = await resume();
    expect(result).toEqual({ success: true, data: { paused: false },
      message: `${params.environmentName}'s database is no longer paused: the connection its services hold (${params.secret.id}, version 1) works again, and the copy login's password is one nobody has.` });
    expect(await reach(appUrl())).toBe('app_owner');
    expect(DENIED).toContain(await reach(copy));
    expect(await alive(copying)).toBe(false);
    // The app's secret was never rewritten: its services need no new version.
    expect(versions(params.secret.id)).toHaveLength(1);
  });

  it('is not paused while anyone else is connected to the database, counts each session once, and keeps the app out', async () => {
    const person = await server.connect('reporting', 'reporting-password-0123', 'app');
    const elsewhere = await server.connect('reporting', 'reporting-password-0123', 'elsewhere');
    const waiting = await pause();
    expect(waiting).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(SHUT_OUT) });
    expect(waiting.message).toMatch(/: 1 session\(s\) are still connected to its database \(1 of them not the app's\)\./);
    expect(DENIED).toContain(await reach(appUrl()));
    expect(versions(copyId())).toHaveLength(0);
    await server.close(person);
    // Someone on another database of the same server does not count.
    expect((await pause()).success).toBe(true);
    expect(await alive(elsewhere)).toBe(true);
  });

  it('is not paused while a session of the app will not end, counts it once, and says the app is shut out', async () => {
    const service = await session(appUrl());
    local.stubborn = true;
    const waiting = await pause();
    expect(waiting).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(SHUT_OUT) });
    expect(waiting.message).toMatch(/: 1 session\(s\) are still connected to its database\. Run/);
    expect(await alive(service)).toBe(true);
    expect(versions(copyId())).toHaveLength(0);
    local.stubborn = false;
    expect((await pause()).success).toBe(true);
    expect(await alive(service)).toBe(false);
  });

  it('does not give the app back while a copy session will not end', async () => {
    expect((await pause()).success).toBe(true);
    const copying = await session(copyUrl());
    local.stubborn = true;
    const waiting = await resume();
    expect(waiting).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/1 session\(s\) of the copy login are still connected, so the app's password was not given back\. The app may still be shut out/) });
    expect(DENIED).toContain(await reach(appUrl()));
    expect(await alive(copying)).toBe(true);
    local.stubborn = false;
    expect((await resume()).success).toBe(true);
    expect(await alive(copying)).toBe(false);
    expect(await reach(appUrl())).toBe('app_owner');
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
    const service = await session(appUrl());
    expect((await resume()).success).toBe(true);
    expect(await alive(service)).toBe(true);
    expect(await reach(appUrl())).toBe('app_owner');
  });

  it.each([[0, 'the first'], [1, 'the second']])('says the app is shut out when password change number %i is cut off, and recovers by undoing or by pausing again', async (cut) => {
    local.cutAfter = cut;
    const stopped = await pause();
    expect(stopped).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(SHUT_OUT) });
    expect(stopped.message).toMatch(/the password of app_[ab] could not be changed \(the server is busy with another change\)/);
    expect((await resume()).success).toBe(true);
    expect(await reach(appUrl())).toBe('app_owner');
    local.cutAfter = cut;
    await pause();
    expect((await pause()).success).toBe(true);
    expect(await reach(copyUrl())).toBe('app_owner');
    expect(DENIED).toContain(await reach(appUrl()));
  });

  it('recovers when Google stored the copy login and Hypervibe died before recording it', async () => {
    google.state.loseNextAnswer = true;
    google.state.failNextAccess = true;
    const stopped = await pause();
    expect(stopped).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(SHUT_OUT) });
    expect(stopped.message).toMatch(new RegExp(`the copy login could not be stored in ${copyId()}\\.`));
    // Google holds a version nobody recorded. Pausing again sets it aside and stores a new one; undoing works too.
    expect(versions(copyId())).toHaveLength(1);
    const again = await pause();
    expect(again).toMatchObject({ success: true, data: { copySecretVersion: '2' } });
    expect(DENIED).toContain(await reach(versions(copyId())[0]!));
    expect(await reach(copyUrl())).toBe('app_owner');
    google.state.loseNextAnswer = true;
    google.state.failNextAccess = true;
    await pause();
    expect((await resume()).success).toBe(true);
    expect(await reach(appUrl())).toBe('app_owner');
  });

  it('treats a busy Admin API as "run again", before and after the app is shut out', async () => {
    local.busy = 1;
    const first = await pause();
    expect(first).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/the password of app_a could not be changed \(the server is busy with another change\)/) });
    expect((await pause()).success).toBe(true);
    local.busy = 1;
    expect(await resume()).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/the copy login's password could not be changed \(the server is busy with another change\)\. The app may still be shut out/) });
    expect((await resume()).success).toBe(true);
  });

  it('changes nothing when the server has no free connection for the app\'s login, and says the app is shut out when that happens later', async () => {
    local.full.add('app_a');
    expect(await pause()).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/has no free connection, so its app's sessions cannot be ended from here\. Nothing was changed/) });
    expect(await reach(appUrl())).toBe('app_owner');
    local.full.clear();
    local.full.add('app_b');
    const later = await pause();
    expect(later).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(SHUT_OUT) });
    expect(later.message).toMatch(/the database server has no free connection to work through/);
    expect(DENIED).toContain(await reach(appUrl()));
    expect(await resume()).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/no free connection to work through\. The app may still be shut out/) });
    local.full.clear();
    expect((await resume()).success).toBe(true);
    expect(await reach(appUrl())).toBe('app_owner');
  });

  it('refuses, with the app untouched, when one of the two logins is missing', async () => {
    logins = ['app_a', 'postgres'];
    for (const call of [pause, resume]) expect(await call()).toMatchObject({ success: false, status: 'blocked', message: `Database login app_b does not exist on ${INSTANCE}. Nothing was changed.` });
    expect(await reach(appUrl())).toBe('app_owner');
  });

  describe('refuses to pause or undo, changing nothing', () => {
    const neighbour = () => {
      const project = ctx.repos.projects.create({ name: `neighbour-${counter}-${++neighbours}` });
      return { 'managed-by': 'hypervibe', 'hv-environment': ctx.repos.environments.create({ projectId: project.id, name: 'staging' }).id };
    };
    const relabel = (secretId: string, change: Record<string, string | undefined>) => {
      const environment = ctx.repos.environments.findById(params.secret.labels['hv-environment']!)!;
      const engine = (environment.platformBindings as { engine: { secretMetadata: Record<string, { labels: Record<string, string | undefined> }> } }).engine;
      Object.assign(engine.secretMetadata[secretId]!.labels, change);
      ctx.repos.environments.updatePlatformBindings(environment.id, { engine });
    };
    const cases: Array<[string, () => Promise<void> | void, () => Partial<DedicatedPauseParams>, RegExp]> = [
      ['a password change is still in flight', () => relabel(params.secret.id, { 'hv-db-retire': 'app_b' }), () => ({}), /password is still being changed/],
      ['the services are pinned to an older version than the newest', async () => { await writeSecretVersion('synthetic-token', GCP, params.secret.id, { ...params.secret.labels, 'hv-db-instance': INSTANCE, 'hv-db-login': 'app_a' }, appUrl()); }, () => ({}),
        /services use version 1 of its connection secret, which is not its newest \(2\)/],
      ['the secret was made for another server', () => relabel(params.secret.id, { 'hv-db-instance': 'hv-other-db' }), () => ({}), /does not hold a login for database server/],
      ['the secret records a login Hypervibe did not make', () => relabel(params.secret.id, { 'hv-db-login': 'postgres' }), () => ({}), /does not hold a login for database server/],
      ['the caller names another environment as the owner', () => {}, () => ({ secret: { ...params.secret, labels: neighbour() } }), /not owned by this Hypervibe environment/],
      ['the caller names no owner at all', () => {}, () => ({ secret: { ...params.secret, labels: {} } }), /was not named with the environment it belongs to/],
      ['there is no connection secret', () => {}, () => ({ secret: { ...params.secret, id: 'hv-nothing-database-url' } }), /has no connection secret/],
      ['the secret for the copy login does not exist', () => { google.state.secrets.delete(copyId()); }, () => ({}), /does not exist yet\. Nothing was changed/],
      ['the secret for the copy login is a neighbour\'s', () => { google.state.secrets.get(copyId())!.labels = neighbour(); }, () => ({}), /does not belong to production-\d+\. Nothing was changed/],
      ['the secret for the copy login has no owner', () => { google.state.secrets.get(copyId())!.labels = {}; }, () => ({}), /does not belong to production-\d+\. Nothing was changed/],
      ['the secret for the copy login already holds something that is not a copy login', async () => { await writeSecretVersion('synthetic-token', GCP, copyId(), { ...params.secret.labels }, 'some-app-value'); }, () => ({}),
        /holds something other than a copy login\. Nothing was changed/],
      ['the pinned version is not the recorded connection', () => { versions(params.secret.id)[0] = connectionUrl('app_b', 'x'.repeat(24), 'app', CONNECTION); }, () => ({}), /is not the connection to production-\d+'s database that was recorded\. Nothing was changed/],
    ];
    it.each(cases)('when %s', async (_what, arrange, override, reason) => {
      const url = appUrl();
      const service = await session(url);
      await arrange();
      const copies = google.state.secrets.get(copyId())?.versions.length;
      for (const call of [pause, resume]) {
        expect(await call(override())).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(reason) });
        // The app's own password still works and its session was never touched.
        expect(await alive(service)).toBe(true);
        expect((await server.connect('app_a', parseConnectionUrl(url)!.password, 'app').then((client) => server.close(client).then(() => 'in'), () => 'out'))).toBe('in');
      }
      expect(google.state.secrets.get(copyId())?.versions.length).toBe(copies);
    });
  });
});
