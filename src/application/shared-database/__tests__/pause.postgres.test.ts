/**
 * Pausing one environment's database on the app's shared server, and undoing
 * it, through the module's entry and its real Google adapter: Secret Manager
 * and the server list answered in memory (so the real secret write path and
 * its records run), the Admin API's password change and the connector's
 * sessions redirected to a real, disposable PostgreSQL whose administrator is a
 * plain CREATEROLE/CREATEDB login. Every test has environments of its own on
 * that one server. No cloud is contacted.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../../adapters/secrets/secret-store.js';
import type { ActionResult } from '../../../domain/plan/converge.executor.js';
import { fakeSecretManager, postgresMajor, startPostgres, type LocalPostgres } from '../../__tests__/pause-fixtures.js';
import { createCommandContext, type CommandContext } from '../../context.js';
import type { GcpDatabaseBinding } from '../../gcp-database-location.js';
import * as database from '../../infrastructure-engine-database.js';
import { databaseCopySecretId, parseConnectionUrl } from '../../infrastructure-engine-database.js';
import { googleSharedDatabaseCloud, sharedDatabase, type SharedDatabaseEngine, type SharedDatabasePauseRequest } from '../index.js';

const GCP = 'demo-project';
const REGION = 'us-central1';
const INSTANCE = 'hv-demo-app-shared-a1b2c3';

/** What the stand-ins for the Admin API and the connector are told to do. */
const local = {
  server: undefined as unknown as LocalPostgres,
  passwords: [] as string[],
  /** Sessions that ignore being ended. */
  stubborn: false,
};

const google = fakeSecretManager(GCP);
const engine: SharedDatabaseEngine = { plan: async () => { throw new Error('The server exists; nothing plans it here.'); }, apply: async () => { throw new Error('unused'); } };
let home: string;
let ctx: CommandContext;
let server: LocalPostgres;
let counter = 0;
const shown: ActionResult[] = [];

interface Running { project: { id: string; name: string }; environment: { id: string; name: string }; labels: Record<string, string>; secretId: string }
const bindings = new Map<string, GcpDatabaseBinding>();
let serving: string[] = [];
const cloud = () => googleSharedDatabaseCloud({ token: 'synthetic-token', credentials: () => ({}) });
const base = (app: Running) => ({ project: app.project, environment: app.environment, gcpProjectId: GCP, region: REGION, binding: bindings.get(app.environment.id), engine, cloud: cloud(),
  secret: { id: app.secretId, labels: app.labels }, runningSecretVersions: async () => ({ versions: serving }) });
/** hv_plan and hv_apply for an environment's database, as the planner would run them. */
async function converge(app: Running, passwordGeneration = 1): Promise<string[]> {
  const planned = await sharedDatabase.plan({ ...base(app), desired: { provider: 'cloudsql', engine: 'postgres', placement: 'app', passwordGeneration } as never });
  if (!planned || 'blocked' in planned) throw new Error(`not planned: ${JSON.stringify(planned)}`);
  for (const action of planned.actions) {
    const result = await sharedDatabase.apply({ ...base(app), action, reviewed: planned.reviewed,
      record: (database) => { if (database) bindings.set(app.environment.id, { database }); else bindings.delete(app.environment.id); } });
    if (!result.success) throw new Error(result.message);
  }
  return planned.actions.map((action) => action.id);
}
/** A new environment of the one app, with its database on the shared server and a running app. */
async function running(kind: string): Promise<Running> {
  const name = `${kind}-${++counter}`;
  const environment = ctx.repos.environments.create({ projectId: project.id, name });
  const app: Running = { project, environment: { id: environment.id, name }, labels: { 'managed-by': 'hypervibe', 'hv-environment': environment.id }, secretId: `hv-${name}-database-url` };
  google.state.secrets.set(app.secretId, { labels: app.labels, versions: [] });
  google.state.secrets.set(databaseCopySecretId(app.secretId), { labels: app.labels, versions: [] });
  expect(await converge(app)).toEqual(['shared-database:allocate']);
  return app;
}
let project: { id: string; name: string };
const record = (app: Running) => bindings.get(app.environment.id)!.database!;
const versions = (secretId: string) => google.state.secrets.get(secretId)!.versions;
const appUrl = (app: Running) => versions(app.secretId).at(-1)!;
const copyId = (app: Running) => databaseCopySecretId(app.secretId);
const copyUrl = (app: Running) => versions(copyId(app)).at(-1)!;
const request = (app: Running, override: Partial<SharedDatabasePauseRequest> = {}): SharedDatabasePauseRequest => ({
  project: app.project, environment: app.environment, gcpProjectId: GCP, region: REGION, binding: bindings.get(app.environment.id), cloud: cloud(),
  secret: { id: app.secretId, labels: app.labels, version: String(versions(app.secretId).length) }, ...override });
const pause = async (app: Running, override: Partial<SharedDatabasePauseRequest> = {}) => { const result = await sharedDatabase.pause(request(app, override)); shown.push(result); return result; };
const resume = async (app: Running, override: Partial<SharedDatabasePauseRequest> = {}) => { const result = await sharedDatabase.resume(request(app, override)); shown.push(result); return result; };
async function reach(url: string): Promise<string> {
  const parsed = parseConnectionUrl(url)!;
  try {
    const client = await server.connect(parsed.login, parsed.password, parsed.databaseName);
    try { return String((await client.query('SELECT current_database() AS name')).rows[0].name); } finally { await server.close(client); }
  } catch (error) { return String((error as { code?: string }).code); }
}
const session = (url: string) => { const parsed = parseConnectionUrl(url)!; return server.connect(parsed.login, parsed.password, parsed.databaseName); };
const alive = (client: pg.Client) => client.query('SELECT 1').then(() => true, () => false);
const DENIED = ['28P01', '28000'];
const SHUT_OUT = /'s app is shut out of its database, and the pause did not finish: .* Run the same command again to finish it, or undo the pause to let the app back in\.$/;

beforeAll(async () => {
  server = local.server = await startPostgres('hv-pause-shared');
  home = mkdtempSync(path.join(tmpdir(), 'hv-pause-shared-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', home);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(home, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const secret = await google.answer(input, init);
    if (secret) return secret;
    const url = new URL(String(input));
    if (url.hostname === 'sqladmin.googleapis.com' && url.pathname.endsWith('/users')) return google.json({ items: [{ name: 'hv_admin' }, { name: 'postgres' }] });
    if (url.hostname === 'sqladmin.googleapis.com' && url.pathname.endsWith('/instances')) {
      return google.json({ items: [{ name: INSTANCE, region: REGION, state: 'RUNNABLE', settings: { userLabels: { 'managed-by': 'hypervibe', 'hv-shared-database': project.id.toLowerCase() }, deletionProtectionEnabled: true } }] });
    }
    throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${url.hostname}${url.pathname}`);
  }));
  // Google's API makes a login that may create roles and databases but is no superuser.
  vi.spyOn(database, 'setCloudSqlLoginPassword').mockImplementation(async (_token, _project, _instance, login, password) => {
    local.passwords.push(password);
    const exists = (await server.boot.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login])).rows.length === 1;
    await server.boot.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN CREATEROLE CREATEDB PASSWORD '${password}'`);
    return 'done';
  });
  vi.spyOn(database, 'withCloudSqlSession').mockImplementation(async (_account, _connectionName, user, password, name, work) => {
    const client = await server.connect(user, password, name);
    const real = client.query.bind(client);
    if (local.stubborn) (client as { query: unknown }).query = (text: string, values?: unknown[]) => (text.includes('pg_terminate_backend') ? Promise.resolve({ rows: [] }) : real(text, values as never));
    try { return await work(client); } finally { await server.close(client); }
  });
  ctx = createCommandContext();
  const created = ctx.repos.projects.create({ name: 'demo-app' });
  project = { id: created.id, name: created.name };
  // The administrator login exists from the server's first use.
  await server.boot.query(`CREATE ROLE hv_admin LOGIN CREATEROLE CREATEDB PASSWORD 'replaced-on-first-use-0123456789'`);
}, 60_000);

beforeEach(() => {
  local.stubborn = false;
  google.state.whileStoring = undefined;
  serving = [];
  shown.length = 0;
});

afterEach(async () => {
  // Whatever a test did, nothing it was told carries a password: the administrator's, or one stored in a secret, kept or not.
  const text = JSON.stringify(shown);
  for (const secret of [...local.passwords, ...google.state.sent.map((url) => parseConnectionUrl(url)?.password ?? url)]) expect(text).not.toContain(secret);
  await server.closeOthers();
});

afterAll(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  rmSync(home, { recursive: true, force: true });
  expect(await server.stop()).toBe(true);
});

describe.runIf(postgresMajor() >= 15)('pausing one environment\'s database on the shared server', () => {
  it('shuts that app out, ends its sessions, proves nobody is connected, and leaves its neighbour alone', async () => {
    const staging = await running('staging');
    const production = await running('production');
    const service = await session(appUrl(staging));
    const neighbour = await session(appUrl(production));
    const result = await pause(staging);
    expect(result).toEqual({ success: true, data: { paused: true, copySecretId: copyId(staging), copySecretVersion: '1' },
      message: `${staging.environment.name}'s database is paused: the app cannot connect and no session is open. Only the copy login (${copyId(staging)}, version 1) can.` });
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect(await alive(service)).toBe(false);
    expect((await server.boot.query('SELECT count(*)::int AS open FROM pg_stat_activity WHERE datname = $1', [record(staging).databaseName])).rows[0].open).toBe(0);
    // The copy login is staging's other login, on staging's database; its URL is in its own secret only.
    expect(parseConnectionUrl(copyUrl(staging))).toMatchObject({ login: `${record(staging).databaseName}_b`, databaseName: record(staging).databaseName, connectionName: `${GCP}:${REGION}:${INSTANCE}` });
    expect(await reach(copyUrl(staging))).toBe(record(staging).databaseName);
    expect(versions(staging.secretId)).toHaveLength(1);
    // The neighbour never noticed: its open session, its secrets and its login are as they were.
    expect(await alive(neighbour)).toBe(true);
    expect(await reach(appUrl(production))).toBe(record(production).databaseName);
    expect(versions(copyId(production))).toHaveLength(0);
  });

  it('undoes the pause: the exact connection the services hold works again, and the copy login does not', async () => {
    const staging = await running('staging');
    expect((await pause(staging)).success).toBe(true);
    const copy = copyUrl(staging);
    const copying = await session(copy);
    const result = await resume(staging);
    expect(result).toEqual({ success: true, data: { paused: false },
      message: `${staging.environment.name}'s database is no longer paused: the connection its services hold (${staging.secretId}, version 1) works again, and the copy login is switched off.` });
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    expect(DENIED).toContain(await reach(copy));
    expect(await alive(copying)).toBe(false);
    // The app's secret was never rewritten, and the database is as fully set up as before.
    expect(versions(staging.secretId)).toHaveLength(1);
    expect(await converge(staging)).toEqual([]);
  });

  it('is not paused while anyone else is connected to that database, counts each session once, and keeps the app out', async () => {
    const staging = await running('staging');
    const production = await running('production');
    const person = await server.connect('boot', undefined, record(staging).databaseName!);
    const elsewhere = await server.connect('boot', undefined, record(production).databaseName!);
    const waiting = await pause(staging);
    expect(waiting).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(SHUT_OUT) });
    expect(waiting.message).toMatch(/: 1 session\(s\) are still connected to its database \(1 of them not the app's\)\. Run/);
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect(versions(copyId(staging))).toHaveLength(0);
    await server.close(person);
    // Someone on another environment's database does not count.
    expect((await pause(staging)).success).toBe(true);
    expect(await alive(elsewhere)).toBe(true);
  });

  it('is not paused while a session of the app will not end, counts it once, and says the app is shut out', async () => {
    const staging = await running('staging');
    const service = await session(appUrl(staging));
    local.stubborn = true;
    const waiting = await pause(staging);
    expect(waiting).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(SHUT_OUT) });
    expect(waiting.message).toMatch(/: 1 session\(s\) are still connected to its database\. Run/);
    expect(await alive(service)).toBe(true);
    // Its login is off all the same, and no copy login was made.
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect(versions(copyId(staging))).toHaveLength(0);
    local.stubborn = false;
    expect((await pause(staging)).success).toBe(true);
    expect(await alive(service)).toBe(false);
  }, 30_000);

  it('does not let the app back in while a copy session will not end', async () => {
    const staging = await running('staging');
    expect((await pause(staging)).success).toBe(true);
    const copying = await session(copyUrl(staging));
    local.stubborn = true;
    const waiting = await resume(staging);
    expect(waiting).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(/1 session\(s\) of the copy login are still connected, so the app's login was not switched back on\. The app may still be shut out\. Run the same command again\.$/) });
    expect(await alive(copying)).toBe(true);
    expect(DENIED).toContain(await reach(appUrl(staging)));
    local.stubborn = false;
    expect((await resume(staging)).success).toBe(true);
    expect(await alive(copying)).toBe(false);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
  }, 30_000);

  it('can be repeated and undone in any order, each time ending in a known state', async () => {
    const staging = await running('staging');
    expect((await pause(staging)).success).toBe(true);
    const first = copyUrl(staging);
    expect((await pause(staging)).success).toBe(true);
    expect(DENIED).toContain(await reach(first));
    expect(await reach(copyUrl(staging))).toBe(record(staging).databaseName);
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect((await resume(staging)).success).toBe(true);
    // Undoing twice, and undoing a database that is not paused: the app keeps working and its open session is left alone.
    const service = await session(appUrl(staging));
    expect((await resume(staging)).success).toBe(true);
    expect(await alive(service)).toBe(true);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
  });

  it('recovers when Google stored the copy login and Hypervibe died before recording it', async () => {
    const staging = await running('staging');
    google.state.loseNextAnswer = true;
    google.state.failNextAccess = true;
    const stopped = await pause(staging);
    expect(stopped).toMatchObject({ success: false, status: 'pending', message: expect.stringMatching(SHUT_OUT) });
    expect(stopped.message).toMatch(new RegExp(`the copy login could not be stored in ${copyId(staging)}\\.`));
    // Google holds a version nobody recorded. Pausing again sets it aside and stores a new one; undoing works too.
    expect(versions(copyId(staging))).toHaveLength(1);
    expect(await pause(staging)).toMatchObject({ success: true, data: { copySecretVersion: '2' } });
    expect(DENIED).toContain(await reach(versions(copyId(staging))[0]!));
    expect(await reach(copyUrl(staging))).toBe(record(staging).databaseName);
    google.state.loseNextAnswer = true;
    google.state.failNextAccess = true;
    await pause(staging);
    expect((await resume(staging)).success).toBe(true);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
  });

  it('holds the server\'s lock for the whole pause: an undo that arrives while the copy login is being stored waits until the pause is done', async () => {
    const staging = await running('staging');
    let undo: Promise<ActionResult> | undefined;
    let undoneEarly = true;
    google.state.whileStoring = { secretId: copyId(staging), run: async () => {
      // The app is shut out and the copy login exists, but is not stored yet. An undo starts now and is given time to finish, if it can.
      undo = resume(staging);
      undoneEarly = await Promise.race([undo.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500))]);
    } };
    const paused = await pause(staging);
    expect(undoneEarly).toBe(false);
    // The pause finished whole and said so truthfully; only then did the undo run, and it too ran whole.
    expect(paused.success).toBe(true);
    expect((await undo!).success).toBe(true);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    expect(DENIED).toContain(await reach(copyUrl(staging)));
  }, 60_000);

  it('refuses a database that is not fully set up', async () => {
    const staging = await running('staging');
    const half = { database: { ...record(staging), activeLogin: undefined, allocation: 'started' as const } };
    for (const call of [pause, resume]) {
      expect(await call(staging, { binding: half })).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/not fully set up, so it cannot be paused/) });
      expect(await call(staging, { binding: undefined })).toMatchObject({ success: false, status: 'blocked' });
    }
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
  });

  it('refuses, with the app untouched, anything about the two secrets that is not as it must be', async () => {
    const staging = await running('staging');
    const production = await running('production');
    const service = await session(appUrl(staging));
    const cases: Array<[string, () => Partial<SharedDatabasePauseRequest>, () => void, RegExp]> = [
      ['a neighbour\'s connection secret', () => ({ secret: { id: production.secretId, labels: staging.labels, version: '1' } }), () => {}, /not owned by this Hypervibe environment/],
      ['a neighbour\'s secret and its owner', () => ({ secret: { id: production.secretId, labels: production.labels, version: '1' } }), () => {}, /does not hold the login recorded for its database/],
      ['no owner named at all', () => ({ secret: { id: staging.secretId, labels: {}, version: '1' } }), () => {}, /was not named with the environment it belongs to/],
      ['a copy secret that is a neighbour\'s', () => ({}), () => { google.state.secrets.get(copyId(staging))!.labels = production.labels; }, /does not belong to staging-\d+\. Nothing was changed/],
      ['a copy secret with no owner', () => ({}), () => { google.state.secrets.get(copyId(staging))!.labels = {}; }, /does not belong to staging-\d+\. Nothing was changed/],
      ['no copy secret', () => ({}), () => { google.state.secrets.delete(copyId(staging)); }, /does not exist yet\. Nothing was changed/],
    ];
    for (const [, override, arrange, reason] of cases) {
      const kept = google.state.secrets.get(copyId(staging));
      const labels = kept && { ...kept.labels };
      arrange();
      for (const call of [pause, resume]) expect(await call(staging, override())).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(reason) });
      if (kept) google.state.secrets.set(copyId(staging), { ...kept, labels: labels! });
      expect(await alive(service)).toBe(true);
    }
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    expect(versions(production.secretId)).toHaveLength(1);
    expect(versions(copyId(production))).toHaveLength(0);
  });

  it('refuses while a password change is in flight, and when the services are pinned to an older version than the newest', async () => {
    const staging = await running('staging');
    expect(await converge(staging, 2)).toEqual(['shared-database:rotate']);
    const previous = versions(staging.secretId)[0]!;
    for (const call of [pause, resume]) expect(await call(staging)).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/password is still being changed/) });
    // Neither login was touched: services on either version keep working.
    expect(await reach(previous)).toBe(record(staging).databaseName);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    serving = ['2'];
    expect(await converge(staging, 2)).toEqual(['shared-database:retire']);
    // The services are said to be on version 1, and version 2 is the newest.
    const older = { secret: { id: staging.secretId, labels: staging.labels, version: '1' } };
    for (const call of [pause, resume]) expect(await call(staging, older)).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/services use version 1 of its connection secret, which is not its newest \(2\)/) });
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    // Rotation finished and the right version named: the pause works on the new login, and undoing restores exactly version 2.
    expect((await pause(staging)).success).toBe(true);
    expect(DENIED).toContain(await reach(appUrl(staging)));
    expect((await resume(staging)).success).toBe(true);
    expect(await reach(appUrl(staging))).toBe(record(staging).databaseName);
    expect(parseConnectionUrl(appUrl(staging))!.login).toBe(record(staging).activeLogin);
  });
});
