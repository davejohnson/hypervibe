/**
 * The app's shared database server, exercised only through the module's entry:
 * two environments of one app (production and staging) on one server. Google
 * is replaced by fakes; every SQL statement runs on a real, disposable
 * PostgreSQL, where the "administrator" is a plain CREATEROLE/CREATEDB login as
 * on a managed service. No cloud is contacted.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionResult } from '../../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../../domain/plan/plan.types.js';
import type { EngineConfiguration } from '../../../domain/ports/infrastructure-engine.port.js';
import { gcpDatabasePlanBlocker, type GcpDatabaseBinding } from '../../gcp-database-location.js';
import { sharedDatabase, type SharedDatabaseCloud, type SharedDatabaseEngine, type SharedDatabasePlan, type SharedDatabasePlanRequest } from '../index.js';
import type { SeenServer } from '../ports.js';

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
let directory: string | undefined;
let socket: string;
let boot: pg.Client;
const stopServer = () => {
  if (directory && existsSync(path.join(directory, 'data/postmaster.pid'))) spawnSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
};

const GCP = 'demo-project';
const REGION = 'us-central1';
const project = { id: 'project-1', name: 'Demo App' };
const production = { id: 'env-production-1', name: 'production' };
const staging = { id: 'env-staging-1', name: 'staging' };
const secretIdOf = (environment: { name: string }) => `${environment.name}-database-url`;
const labelsOf = (environment: { id: string }) => ({ 'managed-by': 'hypervibe', 'hv-environment': environment.id });

/** What the fakes hold in place of Google. */
const google = {
  servers: [] as SeenServer[],
  connectionSecrets: new Map<string, { labels: Record<string, string>; versions: string[]; unrecorded?: boolean }>(),
  engineState: new Map<string, Set<string>>(),
  plans: new Map<string, { configuration: EngineConfiguration; destroy: boolean; shown: ReturnType<typeof shownPlan> }>(),
  stateNames: new Map<string, string>(),
  enginePlans: 0,
  engineApplies: 0,
  administratorPasswords: [] as string[],
  /** 'refused': the write never reaches Google. 'lost': Google stores it and the answer is lost. */
  nextPublish: undefined as 'refused' | 'lost' | undefined,
  refuseAdministratorOnce: false,
  statements: [] as string[],
};

const stateKey = (state: { projectId: string; environmentId: string; partition: string }) => `${state.projectId}/${state.environmentId}/${state.partition}`;
const instanceOf = (configuration: EngineConfiguration) => (configuration.files['shared-database.tf.json'] as { resource: { google_sql_database_instance: {
  shared: { name: string; region: string; settings: Array<{ deletion_protection_enabled: boolean; user_labels: Record<string, string> }> } } } }).resource.google_sql_database_instance.shared;
const ADDRESS = 'google_sql_database_instance.shared';

/** What OpenTofu's own JSON plan would say about the server: the operation, and the server's name in saved state and in configuration. */
const shownPlan = (type: string, before: string | undefined, after: string | undefined, importing: boolean) => ({ format_version: '1.2', resource_changes: [{ address: ADDRESS, type: 'google_sql_database_instance',
  change: { actions: [type === 'destroy' ? 'delete' : type === 'noop' ? 'no-op' : type], before: before ? { name: before } : null, after: after ? { name: after } : null, ...(importing ? { importing: { id: 'x' } } : {}) } }] });

/** Plans what OpenTofu would: a create when saved state has no server, a takeover for an import, an update when protection differs. */
const engine: SharedDatabaseEngine = {
  async plan(configuration, state, planId, review, destroy) {
    google.enginePlans++;
    const known = google.engineState.get(stateKey(state)) ?? new Set<string>();
    const instance = instanceOf(configuration);
    const live = google.servers.find((server) => server.instanceName === instance.name);
    // OpenTofu reads imports from the configuration's own file, not from Hypervibe's notes about it.
    const imported = JSON.stringify(configuration.files['imports.tf.json'] ?? {}).includes(`"to":"${ADDRESS}"`);
    const reprotect = live !== undefined && live.deletionProtection !== instance.settings[0]!.deletion_protection_enabled;
    const mapping = configuration.resources[ADDRESS]!;
    const type = destroy ? (known.has(ADDRESS) ? 'destroy' : 'noop') : !known.has(ADDRESS) && !imported ? 'create' : imported || reprotect ? 'update' : 'noop';
    // Saved state remembers the server it made, whatever the configuration now says.
    const inState = known.has(ADDRESS) ? google.stateNames.get(stateKey(state)) : imported ? instance.name : undefined;
    const shown = shownPlan(type, inState, destroy ? undefined : instance.name, imported);
    if (!review(shown)) return { ok: false, error: 'The saved engine plan does not match the reviewed change.' };
    google.plans.set(planId, { configuration, destroy: destroy === true, shown });
    const segment = { id: `opentofu:${planId}`, engine: 'opentofu' as const, planDigest: 'digest', configurationDigest: 'digest', engineVersion: '1', providerVersions: {} };
    return { ok: true, blockers: [], segment,
      actions: [{ id: mapping.actionId, type, resource: { kind: mapping.kind, name: mapping.name, provider: 'gcp' }, verified: true, reason: 'engine', metadata: { engineSegment: { ...segment, addresses: [ADDRESS] } } }] };
  },
  async apply(state, planId, segment, review) {
    const saved = google.plans.get(planId)!;
    const notStarted = { outcomes: Object.fromEntries(segment.addresses.map((address) => [address, 'not_started' as const])), diagnostics: ['The saved engine plan does not do what was reviewed.'] };
    if (!review(saved.shown)) return notStarted;
    google.engineApplies++;
    const known = google.engineState.get(stateKey(state)) ?? new Set<string>();
    google.engineState.set(stateKey(state), known);
    const instance = instanceOf(saved.configuration);
    if (saved.destroy) {
      google.servers = google.servers.filter((server) => server.instanceName !== instance.name);
      known.clear();
    } else {
      known.add(ADDRESS);
      google.stateNames.set(stateKey(state), instance.name);
      const live = google.servers.find((server) => server.instanceName === instance.name);
      const seen = { instanceName: instance.name, region: instance.region, runnable: true, deletionProtection: instance.settings[0]!.deletion_protection_enabled, labels: instance.settings[0]!.user_labels };
      if (live) Object.assign(live, seen); else google.servers.push(seen);
    }
    return { outcomes: Object.fromEntries(segment.addresses.map((address) => [address, 'succeeded' as const])), diagnostics: [] };
  },
};

const cloud: SharedDatabaseCloud = {
  listServers: async () => ({ state: 'listed', servers: google.servers.map((server) => ({ ...server })) }),
  async setServerLogin(_project, _instance, login, password) {
    // Google's API creates a login that may create roles and databases but is no superuser.
    google.administratorPasswords.push(password);
    const exists = (await boot.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login])).rows.length === 1;
    await boot.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN CREATEROLE CREATEDB PASSWORD '${password}'`);
    return undefined;
  },
  async observeConnectionSecret(_project, secretId) {
    const secret = google.connectionSecrets.get(secretId);
    if (!secret) return { state: 'absent' };
    return { state: 'present', value: { labels: secret.unrecorded ? labelsOf({ id: secret.labels['hv-environment']! }) : secret.labels, hasEnabledVersion: secret.versions.length > 0,
      ...(secret.versions.length ? { latestVersion: String(secret.versions.length) } : {}), ...(secret.unrecorded ? { unrecorded: true } : {}) } };
  },
  readSecretVersion: async (_project, secretId, version) => {
    const value = google.connectionSecrets.get(secretId)?.versions[Number(version) - 1];
    return value ? { state: 'present', value } : { state: 'absent' };
  },
  async publishConnectionSecret(_project, secretId, labels, value) {
    const secret = google.connectionSecrets.get(secretId)!;
    const mode = google.nextPublish;
    google.nextPublish = undefined;
    if (mode === 'refused') return { success: false, status: 'pending', message: 'The value was not stored.' } satisfies ActionResult;
    if (secret.unrecorded) return { success: false, status: 'blocked', message: 'The secret has an unrecognized version.' } satisfies ActionResult;
    secret.versions.push(value);
    if (mode === 'lost') {
      secret.unrecorded = true;
      return { success: false, status: 'pending', message: 'The value write has an unknown outcome.' } satisfies ActionResult;
    }
    secret.labels = labels;
    return undefined;
  },
  relabelConnectionSecret(_project, secretId, version, labels) {
    const secret = google.connectionSecrets.get(secretId)!;
    if (String(secret.versions.length) !== version) return false;
    secret.labels = labels;
    secret.unrecorded = false;
    return true;
  },
  async withSession(target, work) {
    if (!google.servers.some((server) => target.connectionName === `${GCP}:${REGION}:${server.instanceName}`)) throw new Error(`no such server: ${target.connectionName}`);
    if (target.user === 'hv_admin' && google.refuseAdministratorOnce) {
      google.refuseAdministratorOnce = false;
      throw Object.assign(new Error(`password authentication failed for user "hv_admin" (${target.password})`), { code: '28P01' });
    }
    const client = new pg.Client({ host: socket, user: target.user, password: target.password, database: target.database, connectionTimeoutMillis: 10_000 });
    client.on('error', () => {});
    await client.connect();
    try {
      return await work({ query: (text, values) => { google.statements.push(text); return client.query(text, values); } });
    } finally {
      await client.end().catch(() => {});
    }
  },
};

/** The environment's saved binding, as the planner would keep it. */
const bindings = new Map<string, GcpDatabaseBinding>();
let running: string[] = [];
const target = (environment: { id: string; name: string }) => ({ project, environment, gcpProjectId: GCP, region: REGION, binding: bindings.get(environment.id), engine, cloud,
  secret: { id: secretIdOf(environment), labels: labelsOf(environment) }, runningSecretVersions: async () => ({ versions: running }) });
const planFor = (environment: { id: string; name: string }, desired: SharedDatabasePlanRequest['desired'], more: Partial<SharedDatabasePlanRequest> = {}) => sharedDatabase.plan({ ...target(environment), desired, ...more });
const shared = { provider: 'cloudsql', engine: 'postgres', placement: 'app' } as NonNullable<SharedDatabasePlanRequest['desired']>;
const planned = async (work: ReturnType<typeof planFor>): Promise<SharedDatabasePlan> => {
  const result = await work;
  if (!result || 'blocked' in result) throw new Error(`expected a plan, got ${JSON.stringify(result)}`);
  return result;
};
const refusal = async (work: Promise<unknown>) => ((await work) as { blocked?: string } | undefined)?.blocked ?? 'not blocked';
const applyOne = (environment: { id: string; name: string }, action: PlanAction, reviewed: unknown) => sharedDatabase.apply({ ...target(environment), action, reviewed,
  record: (database) => { if (database) bindings.set(environment.id, { database }); else bindings.delete(environment.id); } });
/** Applies every action of a plan in order, as the planner does. */
async function applyAll(environment: { id: string; name: string }, plan: { actions: PlanAction[]; reviewed: Record<string, unknown> }): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of plan.actions) {
    expect(sharedDatabase.handles(action)).toBe(true);
    results.push(await applyOne(environment, action, plan.reviewed));
    shown.push(results.at(-1));
    if (!results.at(-1)!.success) break;
  }
  return results;
}
const record = (environment: { id: string }) => bindings.get(environment.id)!.database!;
const latestUrl = (environment: { name: string }) => google.connectionSecrets.get(secretIdOf(environment))!.versions.at(-1)!;
/** Connects the way a service would, with a URL from the environment's secret; resolves to the database it reached or the PostgreSQL error code. */
async function reach(url: string, database?: string): Promise<string> {
  const parsed = /^postgresql:\/\/([^:]+):([^@]+)@\/([^?]+)\?host=\/cloudsql\/(.+)$/.exec(url)!;
  const client = new pg.Client({ host: socket, user: parsed[1], password: decodeURIComponent(parsed[2]!), database: database ?? parsed[3], connectionTimeoutMillis: 10_000 });
  client.on('error', () => {});
  try {
    await client.connect();
    return String((await client.query('SELECT current_database() AS name')).rows[0].name);
  } catch (error) {
    return String((error as { code?: string }).code);
  } finally {
    await client.end().catch(() => {});
  }
}
const DENIED = ['28P01', '28000'];
const databases = async () => (await boot.query(`SELECT datname FROM pg_database WHERE datname LIKE 'app\\_%' ORDER BY 1`)).rows.map((row) => String(row.datname));
const everySecretValue = () => [...google.administratorPasswords, ...[...google.connectionSecrets.values()].flatMap((secret) => secret.versions).map((url) => decodeURIComponent(/:([^:@]+)@/.exec(url)![1]!))];
const shown: unknown[] = [];
const serverRequest = { project, gcpProjectId: GCP, region: REGION, engine, cloud, recorded: [] as Array<{ environment: string; binding: GcpDatabaseBinding | undefined }> };
const removalStep = async () => {
  const removal = await sharedDatabase.planServerRemoval(serverRequest);
  if (!('action' in removal)) throw new Error(`expected a removal step, got ${JSON.stringify(removal)}`);
  return removal;
};

beforeAll(async () => {
  directory = mkdtempSync('/tmp/hv-shared-');
  process.once('exit', stopServer);
  const data = path.join(directory, 'data');
  socket = path.join(directory, 'socket');
  mkdirSync(socket);
  execFileSync(`${bin}/initdb`, ['-D', data, '-U', 'boot', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { stdio: 'pipe' });
  writeFileSync(path.join(data, 'postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\nmax_connections = 60\n`);
  writeFileSync(path.join(data, 'pg_hba.conf'), 'local all boot trust\nlocal all all scram-sha-256\n');
  execFileSync(`${bin}/pg_ctl`, ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', 'start'], { stdio: 'pipe' });
  boot = new pg.Client({ host: socket, user: 'boot', database: 'postgres' });
  boot.on('error', () => {});
  await boot.connect();
  // The environments' own secret containers are made by their own configuration before any value is written.
  for (const environment of [production, staging]) google.connectionSecrets.set(secretIdOf(environment), { labels: labelsOf(environment), versions: [] });
}, 60_000);

afterAll(async () => {
  try {
    await boot?.end().catch(() => {});
  } finally {
    stopServer();
    if (directory) {
      const stopped = !existsSync(path.join(directory, 'data/postmaster.pid'));
      rmSync(directory, { recursive: true, force: true });
      expect(stopped).toBe(true);
    }
  }
});

describe.runIf(major >= 15)('two environments of one app on one shared database server', () => {
  it('leaves an environment alone unless its database is, or is asked to be, on the shared server', async () => {
    expect(await planFor(production, undefined)).toBeUndefined();
    expect(await planFor(production, { provider: 'cloudsql', engine: 'postgres' })).toBeUndefined();
    expect(await planFor(production, { provider: 'cloudsql', engine: 'postgres', placement: 'dedicated' })).toBeUndefined();
    expect(google.enginePlans).toBe(0);
  });

  it('plans the server once, as the only billable step, and production\'s database on it, reading no database and setting no password', async () => {
    const plan = await planned(planFor(production, shared));
    shown.push(plan);
    expect(plan.actions.map((action) => [action.id, action.type, action.billable === true, action.requiresConfirm === true])).toEqual([
      ['shared-database:server', 'create', true, true], ['shared-database:allocate', 'create', false, false]]);
    expect(plan.actions[0]!.reason).toMatch(/^Create the app's shared database server \(shared CPU, 0\.6 GB, about US\$10 a month plus storage, charged once however many/);
    expect(plan.actions[1]!.reason).toMatch(/^Create production's own database on the app's shared database server \(up to 15 connections\).*No extra server charge/);
    expect(plan.actions[1]!.dependsOn).toEqual(['shared-database:server']);
    expect(plan.connection!.wireServices).toBe(false);
    expect(plan.credential).toEqual({ ready: false });
    expect(plan.warnings.join(' ')).toMatch(/shares one server with this app's other environments/);
    expect(google.statements).toEqual([]);
    expect(google.administratorPasswords).toEqual([]);
  });

  it('writes the database down before creating it, so an interrupted apply can be finished or torn down', async () => {
    const first = await planned(planFor(production, shared));
    google.nextPublish = 'refused';
    const results = await applyAll(production, first);
    expect(results.map((result) => result.success)).toEqual([true, false]);
    expect(record(production)).toMatchObject({ placement: 'app', tenantId: production.id, allocation: 'started' });
    expect(record(production).activeLogin).toBeUndefined();
    expect(gcpDatabasePlanBlocker(GCP, bindings.get(production.id), production.id)).toBeUndefined();
    expect(await databases()).toEqual([record(production).databaseName]);

    // Torn down from exactly here: the half-made database is found and removed, and the record goes with it.
    const teardown = await planned(planFor(production, undefined, { teardown: true }));
    expect(teardown.actions.map((action) => action.id)).toEqual(['shared-database:release']);
    expect((await applyAll(production, teardown)).map((result) => result.success)).toEqual([true]);
    expect(await databases()).toEqual([]);
    expect(bindings.has(production.id)).toBe(false);

    // Started again and interrupted again, then simply run again: it converges on one database.
    google.nextPublish = 'refused';
    expect((await applyAll(production, await planned(planFor(production, shared)))).map((result) => result.success)).toEqual([false]);
    const again = await planned(planFor(production, shared));
    // The server exists now: nothing billable, nothing to confirm, and the engine is not asked about it at all.
    const enginePlans = google.enginePlans;
    expect(again.actions.map((action) => [action.id, action.type, action.billable === true])).toEqual([['shared-database:allocate', 'create', false]]);
    expect((await applyAll(production, again)).map((result) => result.success)).toEqual([true]);
    expect(await databases()).toHaveLength(1);
    expect(record(production)).toEqual({ gcpProjectId: GCP, region: REGION, placement: 'app', tenantId: production.id, instanceName: google.servers[0]!.instanceName,
      databaseName: record(production).databaseName, activeLogin: `${record(production).databaseName}_a` });
    expect(google.engineApplies).toBe(1);
    await planned(planFor(production, shared));
    expect(google.enginePlans).toBe(enginePlans);
  });

  it('then has nothing to do, and hands workloads the literal connection and secret version', async () => {
    const plan = await planned(planFor(production, shared));
    expect(plan.actions).toEqual([]);
    expect(plan.connection).toEqual({ connectionName: `${GCP}:${REGION}:${google.servers[0]!.instanceName}`, wireServices: true,
      workerQuery: { projectId: GCP, instanceName: google.servers[0]!.instanceName, databaseName: record(production).databaseName } });
    expect(plan.credential).toEqual({ ready: true, version: '1' });
  });

  it('gives staging its own database on the same server, with no server step and nothing billable', async () => {
    const plan = await planned(planFor(staging, shared));
    shown.push(plan);
    expect(plan.actions.map((action) => [action.id, action.type, action.billable === true, action.requiresConfirm === true])).toEqual([['shared-database:allocate', 'create', false, false]]);
    expect(plan.actions[0]!.reason).toMatch(/up to 5 connections/);
    expect((await applyAll(staging, plan)).map((result) => result.success)).toEqual([true]);
    expect(google.servers).toHaveLength(1);
    expect(google.engineApplies).toBe(1);
    const limits = (await boot.query(`SELECT datname, datconnlimit FROM pg_database WHERE datname LIKE 'app\\_%' ORDER BY 1`)).rows.map((row) => [row.datname, row.datconnlimit]);
    expect(limits).toEqual([[record(production).databaseName, 15], [record(staging).databaseName, 5]].sort());
  });

  it('each environment\'s secret opens its own database and not the other\'s', async () => {
    expect(record(production).databaseName).not.toBe(record(staging).databaseName);
    expect(await reach(latestUrl(production))).toBe(record(production).databaseName);
    expect(await reach(latestUrl(staging))).toBe(record(staging).databaseName);
    expect(await reach(latestUrl(staging), record(production).databaseName)).toBe('42501');
    expect(await reach(latestUrl(production), record(staging).databaseName)).toBe('42501');
  });

  it('keeps no administrator password: each use sets a fresh one, and an older one stops working', async () => {
    expect(google.administratorPasswords.length).toBeGreaterThan(2);
    expect(new Set(google.administratorPasswords).size).toBe(google.administratorPasswords.length);
    const connect = (password: string) => reach(`postgresql://hv_admin:${encodeURIComponent(password)}@/postgres?host=/cloudsql/x`);
    expect(DENIED).toContain(await connect(google.administratorPasswords[0]!));
    expect(await connect(google.administratorPasswords.at(-1)!)).toBe('postgres');
    expect(google.statements.some((text) => /set_config\('lock_timeout'/.test(text))).toBe(true);
  });

  it('reports "run again", not damage, when another apply replaced the administrator password first', async () => {
    google.refuseAdministratorOnce = true;
    const rotate = await planned(planFor(staging, { ...shared, passwordGeneration: 2 }));
    const results = await applyAll(staging, rotate);
    expect(results[0]).toMatchObject({ success: false, status: 'pending' });
    expect(results[0]!.message).toMatch(/Another change to the app's shared database server is in progress.*run the same command again/);
    expect(google.connectionSecrets.get(secretIdOf(staging))!.versions).toHaveLength(1);
  });

  it('rotates staging\'s password in two steps without touching production\'s login', async () => {
    const productionUrl = latestUrl(production);
    const before = latestUrl(staging);
    const rotate = await planned(planFor(staging, { ...shared, passwordGeneration: 2 }));
    expect(rotate.actions.map((action) => action.id)).toEqual(['shared-database:rotate']);
    expect((await applyAll(staging, rotate)).map((result) => result.success)).toEqual([true]);
    const after = latestUrl(staging);
    expect(after).not.toBe(before);
    // Both of staging's logins work until its services have moved.
    expect(await reach(before)).toBe(record(staging).databaseName);
    expect(await reach(after)).toBe(record(staging).databaseName);
    expect(record(staging).activeLogin).toBe(`${record(staging).databaseName}_b`);

    running = ['1'];
    expect((await planned(planFor(staging, { ...shared, passwordGeneration: 2 }))).actions).toEqual([]);
    running = ['2', '2'];
    const retire = await planned(planFor(staging, { ...shared, passwordGeneration: 2 }));
    expect(retire.actions.map((action) => action.id)).toEqual(['shared-database:retire']);
    // Between review and apply a job is found still on the old version: the old login is left on.
    running = ['2', '1'];
    const early = await applyAll(staging, retire);
    expect(early[0]).toMatchObject({ success: false, status: 'blocked' });
    expect(early[0]!.message).toMatch(/Not every service and job of staging uses the new database password yet/);
    expect(await reach(before)).toBe(record(staging).databaseName);
    running = ['2', '2'];
    expect((await applyAll(staging, retire)).map((result) => result.success)).toEqual([true]);
    expect(DENIED).toContain(await reach(before));
    expect(await reach(after)).toBe(record(staging).databaseName);
    expect((await planned(planFor(staging, { ...shared, passwordGeneration: 2 }))).actions).toEqual([]);
    // Production never noticed.
    expect(latestUrl(production)).toBe(productionUrl);
    expect(await reach(productionUrl)).toBe(record(production).databaseName);
    expect((await planned(planFor(production, shared))).actions).toEqual([]);
  });

  it('recovers when Google stored a new secret version and Hypervibe never heard back', async () => {
    const serving = latestUrl(staging);
    google.nextPublish = 'lost';
    const rotate = await planned(planFor(staging, { ...shared, passwordGeneration: 3 }));
    expect((await applyAll(staging, rotate))[0]).toMatchObject({ success: false, status: 'pending' });
    // The services still run the version before the lost one, and it still works.
    expect(await reach(serving)).toBe(record(staging).databaseName);
    const recover = await planned(planFor(staging, { ...shared, passwordGeneration: 3 }));
    expect(recover.actions.map((action) => [action.id, action.type])).toEqual([['shared-database:allocate', 'update']]);
    expect(recover.connection!.wireServices).toBe(false);
    expect((await applyAll(staging, recover)).map((result) => result.success)).toEqual([true]);
    expect(await reach(latestUrl(staging))).toBe(record(staging).databaseName);
    expect(await reach(serving)).toBe(record(staging).databaseName);
    expect(await databases()).toHaveLength(2);
    // The login the services were on is switched off only after they have all moved.
    running = [String(google.connectionSecrets.get(secretIdOf(staging))!.versions.length)];
    const retire = await planned(planFor(staging, { ...shared, passwordGeneration: 3 }));
    expect(retire.actions.map((action) => action.id)).toEqual(['shared-database:retire']);
    expect((await applyAll(staging, retire)).map((result) => result.success)).toEqual([true]);
    expect(DENIED).toContain(await reach(serving));
    expect((await planned(planFor(staging, { ...shared, passwordGeneration: 3 }))).actions).toEqual([]);
    expect(await reach(latestUrl(production))).toBe(record(production).databaseName);
  });

  it('blocks a record that is incomplete or was made for another environment', async () => {
    const kept = record(staging);
    expect(gcpDatabasePlanBlocker(GCP, { database: kept }, staging.id)).toBeUndefined();
    expect(gcpDatabasePlanBlocker(GCP, { database: kept }, production.id)).toMatch(/different environment/);
    expect(gcpDatabasePlanBlocker(GCP, { database: kept })).toMatch(/different environment/);
    for (const damaged of [{ ...kept, tenantId: undefined }, { ...kept, region: undefined }, { ...kept, gcpProjectId: 'another-project' }, { ...kept, databaseName: '' }, { ...kept, placement: 'account' as never }]) {
      expect(gcpDatabasePlanBlocker(GCP, { database: damaged }, staging.id)).toMatch(/incomplete/);
    }
    // What only the module can judge: a database name and a login that do not belong together, or a record neither started nor finished.
    for (const damaged of [{ ...kept, activeLogin: undefined }, { ...kept, activeLogin: 'app_other_a' }, { ...kept, allocation: 'started' as const }, { ...kept, databaseName: 'app' }, { ...kept, databaseName: 'App_X' }]) {
      expect(await refusal(sharedDatabase.plan({ ...target(staging), binding: { database: damaged }, desired: shared, secret: { id: secretIdOf(staging), labels: labelsOf(staging) } }))).toMatch(/incomplete/);
    }
    // Handing another environment staging's record never reaches staging's database.
    const plan = await planned(planFor(staging, shared));
    const intruder = { id: 'env-intruder', name: 'intruder' };
    bindings.set(intruder.id, { database: kept });
    const applied = await applyOne(intruder, { id: 'shared-database:release', type: 'destroy', resource: { kind: 'database', name: 'postgres', provider: 'gcp' }, verified: true, reason: '',
      metadata: { operation: 'gcpSharedDatabase', step: 'release', gcpProjectId: GCP, region: REGION, instanceName: kept.instanceName, databaseName: kept.databaseName, tenantId: intruder.id } }, plan.reviewed);
    expect(applied).toMatchObject({ success: false, status: 'blocked' });
    expect(await databases()).toHaveLength(2);
    bindings.delete(intruder.id);
  });

  it('publishes a login only to the environment\'s own secret, whatever the saved action says', async () => {
    const rotate = await planned(planFor(staging, { ...shared, passwordGeneration: 4 }));
    const action = rotate.actions[0]!;
    const before = google.connectionSecrets.get(secretIdOf(production))!.versions.length;
    for (const forged of [{ secretId: secretIdOf(production) }, { labels: labelsOf(production) }, { secretId: secretIdOf(production), labels: labelsOf(production) }]) {
      const result = await applyOne(staging, { ...action, metadata: { ...action.metadata, ...forged } }, rotate.reviewed);
      expect(result).toMatchObject({ success: false, status: 'blocked' });
      expect(result.message).toMatch(/not this environment's own/);
    }
    expect(google.connectionSecrets.get(secretIdOf(production))!.versions).toHaveLength(before);
    expect(record(staging).activeLogin).toBe(google.connectionSecrets.get(secretIdOf(staging))!.labels['hv-db-login']);
  });

  it('refuses to migrate a database on the shared server, and plans a move off it or onto it', async () => {
    // Asking for the shared server from a server of its own is no longer refused either: it is planned as the opposite move, which keeps that server as it is meanwhile.
    expect((await sharedDatabase.plan({ ...target(production), binding: { database: { instanceName: 'hv-production-db-a1b2c3' } }, desired: shared }) as { move?: { ownServer?: string; instanceName?: string } }).move)
      .toMatchObject({ ownServer: 'keep', instanceName: 'hv-production-db-a1b2c3' });
    // Leaving the shared server is no longer refused: it is planned as a move, which starts by preparing the environment's own server.
    expect((await planFor(production, { provider: 'cloudsql', engine: 'postgres' }) as { move?: { stage: string } }).move?.stage).toBe('prepare');
    expect(await refusal(sharedDatabase.plan({ ...target(production), binding: { ...bindings.get(production.id), migration: { copiedAt: 'now' } } as never, desired: shared,
      secret: { id: secretIdOf(production), labels: labelsOf(production) } }))).toMatch(/Migration is not available yet/);
  });

  it('blocks instead of guessing when the server cannot be listed, or the recorded one is not there', async () => {
    const kept = google.servers;
    google.servers = [];
    expect(await refusal(planFor(production, shared))).toMatch(/was not found in demo-project\. Hypervibe will not create another server or an empty database/);
    const release = await planned(planFor(staging, undefined, { teardown: true }));
    const results = await applyAll(staging, release);
    // Not finding the server is never read as "the database is gone".
    expect(results[0]).toMatchObject({ success: false, status: 'blocked' });
    expect(results[0]!.message).toMatch(/nothing on it is treated as removed/);
    expect(bindings.has(staging.id)).toBe(true);
    google.servers = kept;
    const unknown: SharedDatabaseCloud = { ...cloud, listServers: async () => ({ state: 'unknown', reason: 'Google could not reach every region while listing this project\'s database servers.' }) };
    expect(await refusal(sharedDatabase.plan({ ...target(production), cloud: unknown, desired: shared, secret: { id: secretIdOf(production), labels: labelsOf(production) } }))).toMatch(/could not reach every region/);
    const fresh = { id: 'env-fresh-1', name: 'fresh' };
    expect(await refusal(sharedDatabase.plan({ ...target(fresh), cloud: unknown, desired: shared, secret: { id: secretIdOf(fresh), labels: labelsOf(fresh) } }))).toMatch(/could not reach every region/);
    expect(await databases()).toHaveLength(2);
  });

  it('refuses, at the moment of removal, to touch a server with any environment\'s database on it', async () => {
    const removal = await removalStep();
    expect([removal.action.id, removal.action.type, removal.action.requiresConfirm]).toEqual(['shared-database:unprotect-server', 'update', true]);
    expect(removal.action.reason).toMatch(/changed only if its own list shows no database on it at that moment/);
    const applies = google.engineApplies;
    const refused = await sharedDatabase.applyServerRemoval({ ...serverRequest, action: removal.action, reviewed: removal.reviewed });
    expect(refused).toMatchObject({ success: false, status: 'blocked' });
    expect(refused.message).toMatch(/still holds 2 databases/);
    expect(google.engineApplies).toBe(applies);
    expect(google.servers[0]!.deletionProtection).toBe(true);
    // What Hypervibe has saved is checked before Google or the server is asked anything, at plan and again at apply.
    const recorded = [production, staging].map((environment) => ({ environment: environment.name, binding: bindings.get(environment.id) }));
    expect(await refusal(sharedDatabase.planServerRemoval({ ...serverRequest, recorded }))).toMatch(/^production, staging still have their database on the app's shared database server\. Tear those environments down/);
    expect(await sharedDatabase.applyServerRemoval({ ...serverRequest, recorded: recorded.slice(1), action: removal.action, reviewed: removal.reviewed }))
      .toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/^staging still has its database/) });
    // A step runs only the engine plan it claims to be. Here a saved delete is offered under the step, the id and the approval of a server create.
    const forged = `forged-${Date.now()}`;
    const state = { provider: 'gcp', projectId: project.id, environmentId: `shared_database_${GCP}_${REGION}`, partition: 'project-shared' as const };
    const deleting = await engine.plan(google.plans.get((removal.reviewed as { server: { planId: string } }).server.planId)!.configuration, state, forged, () => true, true);
    if (!deleting.ok) throw new Error(deleting.error);
    const create: PlanAction = { id: 'shared-database:server', type: 'create', resource: removal.action.resource, verified: true, reason: '', billable: true, requiresConfirm: true,
      metadata: { ...removal.action.metadata, step: 'server' } };
    const ridden = await applyOne(production, create, { instanceName: removal.instanceName, server: { planId: forged, state, segment: { ...deleting.segment, addresses: [ADDRESS] } } });
    expect(ridden).toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/would not create exactly .*Nothing was changed/) });
    expect(google.engineApplies).toBe(applies);
    expect(google.servers).toHaveLength(1);
    // Saved engine state that describes some other server is never acted on: the server changed must be the one Google lists for this app.
    const key = [...google.stateNames.keys()][0]!;
    const tracked = google.stateNames.get(key)!;
    google.stateNames.set(key, 'hv-some-other-server');
    expect(await refusal(sharedDatabase.planServerRemoval(serverRequest))).toMatch(/was not exactly "(unprotect|take-over)" on shared database server .*saved state may describe a different server\. Nothing was planned/);
    google.stateNames.set(key, tracked);
    // The step cannot be smuggled into an environment's plan, nor an environment's step into the removal.
    expect(await applyOne(production, removal.action, removal.reviewed)).toMatchObject({ success: false, status: 'blocked' });
    const allocate = (await planned(planFor(staging, { ...shared, passwordGeneration: 9 }))).actions[0]!;
    expect(await sharedDatabase.applyServerRemoval({ ...serverRequest, action: allocate, reviewed: removal.reviewed })).toMatchObject({ success: false, status: 'blocked' });
  });

  it('tearing down staging deletes only staging\'s database, after confirmation, and never the server', async () => {
    const productionUrl = latestUrl(production);
    const stagingDatabase = record(staging).databaseName!;
    const release = await planned(planFor(staging, undefined, { teardown: true }));
    shown.push(release);
    expect(release.actions.map((action) => [action.id, action.type, action.dataBearing === true, action.requiresConfirm === true, action.billable === true])).toEqual([['shared-database:release', 'destroy', true, true, false]]);
    expect(release.actions[0]!.reason).toMatch(/The server itself and every other environment's database stay/);
    expect(release.connection).toBeUndefined();
    const applies = google.engineApplies;

    // Something elsewhere on the server still depends on one of staging's roles: the database goes, the record stays until the role can go too.
    await boot.query(`CREATE TABLE public.leftover (); ALTER TABLE public.leftover OWNER TO ${stagingDatabase}_owner`);
    const partial = await applyAll(staging, release);
    expect(partial[0]).toMatchObject({ success: false, status: 'pending' });
    expect(partial[0]!.message).toMatch(/could not be deleted yet \(they are switched off\)\. Run the same command again/);
    expect(bindings.has(staging.id)).toBe(true);
    expect(await databases()).toEqual([record(production).databaseName]);
    await boot.query('DROP TABLE public.leftover');
    const again = await planned(planFor(staging, undefined, { teardown: true }));
    const results = await applyAll(staging, again);
    expect(results.map((result) => result.success)).toEqual([true]);
    expect(bindings.has(staging.id)).toBe(false);
    expect((await boot.query('SELECT 1 FROM pg_roles WHERE rolname LIKE $1', [`${stagingDatabase}%`])).rows).toEqual([]);
    expect(google.engineApplies).toBe(applies);
    expect(google.servers).toHaveLength(1);
    expect(google.servers[0]!.deletionProtection).toBe(true);
    expect(await reach(productionUrl)).toBe(record(production).databaseName);
  });

  it('never replaces a finished database that has gone missing with an empty one', async () => {
    const lost = { id: 'env-lost-1', name: 'lost' };
    google.connectionSecrets.set(secretIdOf(lost), { labels: labelsOf(lost), versions: [] });
    bindings.set(lost.id, { database: { ...record(production), databaseName: 'app_lost_0123456789ab', tenantId: lost.id, activeLogin: 'app_lost_0123456789ab_a' } });
    const plan = await planned(planFor(lost, shared));
    expect(plan.actions.map((action) => [action.id, action.type])).toEqual([['shared-database:allocate', 'update']]);
    const results = await applyAll(lost, plan);
    expect(results[0]).toMatchObject({ success: false, status: 'blocked' });
    expect(results[0]!.message).toMatch(/will not put an empty database in its place/);
    expect(await databases()).toEqual([record(production).databaseName]);
    bindings.delete(lost.id);
  });

  it('removes the empty server in two confirmed steps, and not while any database at all is on it', async () => {
    expect((await applyAll(production, await planned(planFor(production, undefined)))).map((result) => result.success)).toEqual([true]);
    expect(await databases()).toEqual([]);
    expect(google.servers).toHaveLength(1);

    // A database nobody marked is still someone's data.
    await boot.query('CREATE DATABASE made_by_hand');
    const unprotect = await removalStep();
    const refused = await sharedDatabase.applyServerRemoval({ ...serverRequest, action: unprotect.action, reviewed: unprotect.reviewed });
    expect(refused).toMatchObject({ success: false, status: 'blocked' });
    expect(refused.message).toMatch(/still holds a database \(made_by_hand\)/);
    await boot.query('DROP DATABASE made_by_hand');

    // Checked again at apply, against the saved plan as it reads then.
    const saved = google.plans.get((unprotect.reviewed as { server: { planId: string } }).server.planId)!;
    const honest = saved.shown;
    saved.shown = shownPlan('update', 'hv-some-other-server', 'hv-some-other-server', false);
    expect(await sharedDatabase.applyServerRemoval({ ...serverRequest, action: unprotect.action, reviewed: unprotect.reviewed }))
      .toMatchObject({ success: false, status: 'blocked', message: expect.stringMatching(/would not update exactly/) });
    saved.shown = shownPlan('destroy', honest.resource_changes[0]!.change.before!.name, undefined, false);
    expect(await sharedDatabase.applyServerRemoval({ ...serverRequest, action: unprotect.action, reviewed: unprotect.reviewed })).toMatchObject({ success: false, status: 'blocked' });
    expect(google.servers[0]!.deletionProtection).toBe(true);
    saved.shown = honest;
    expect((await sharedDatabase.applyServerRemoval({ ...serverRequest, action: unprotect.action, reviewed: unprotect.reviewed })).success).toBe(true);
    expect(google.servers[0]!.deletionProtection).toBe(false);
    const remove = await removalStep();
    expect([remove.action.id, remove.action.type, remove.action.dataBearing, remove.action.requiresConfirm]).toEqual(['shared-database:remove-server', 'destroy', true, true]);
    expect((await sharedDatabase.applyServerRemoval({ ...serverRequest, action: remove.action, reviewed: remove.reviewed })).success).toBe(true);
    expect(google.servers).toEqual([]);
    expect(await sharedDatabase.planServerRemoval(serverRequest)).toEqual({ none: true });
  });

  it('never changes a server that exists from an environment\'s plan, and takes over an interrupted create only when removing it', async () => {
    // Google has the labelled server; saved engine state does not (the create was cut off).
    google.servers.push({ instanceName: 'hv-demo-app-shared-0a0b0c', region: REGION, runnable: true, deletionProtection: true, labels: { 'managed-by': 'hypervibe', 'hv-shared-database': 'project-1' } });
    google.engineState.clear();
    const enginePlans = google.enginePlans;
    const plan = await planned(planFor(production, shared));
    expect(plan.actions.map((action) => [action.id, action.type, action.billable === true])).toEqual([['shared-database:allocate', 'create', false]]);
    expect(plan.connection!.connectionName).toBe(`${GCP}:${REGION}:hv-demo-app-shared-0a0b0c`);
    expect(google.enginePlans).toBe(enginePlans);
    // Removal takes it over through OpenTofu's own import file, as an update, never as a second create.
    const takeover = await removalStep();
    expect([takeover.action.id, takeover.action.type]).toEqual(['shared-database:unprotect-server', 'update']);
    const reviewed = takeover.reviewed as { server: { planId: string } };
    expect(google.plans.get(reviewed.server.planId)!.configuration.files['imports.tf.json']).toEqual({ import: [{ to: ADDRESS, id: `projects/${GCP}/instances/hv-demo-app-shared-0a0b0c` }] });
    // Someone else's server with the same name pattern but no label is never used.
    google.servers[0]!.labels = { 'managed-by': 'hypervibe' };
    const fresh = await planned(planFor(production, shared));
    expect(fresh.actions[0]).toMatchObject({ id: 'shared-database:server', type: 'create', billable: true });
    expect(fresh.connection!.connectionName).not.toBe(plan.connection!.connectionName);
    google.servers = [];
  });

  it('never shows a password in a plan, a result or a statement, even when an error quotes one', () => {
    const text = JSON.stringify(shown);
    const secrets = everySecretValue();
    expect(secrets.length).toBeGreaterThan(8);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(google.statements.filter((statement) => secrets.some((secret) => statement.includes(secret)))).toEqual([]);
  });

  it('reports an unexpected error by its kind and code only', async () => {
    google.servers.push({ instanceName: 'hv-demo-app-shared-0a0b0c', region: REGION, runnable: true, deletionProtection: true, labels: { 'managed-by': 'hypervibe', 'hv-shared-database': 'project-1' } });
    const loud: SharedDatabaseCloud = { ...cloud, withSession: async (session) => { throw Object.assign(new Error(`driver said: password=${session.password}`), { code: '53300' }); } };
    const plan = await planned(planFor(production, shared));
    const result = await sharedDatabase.apply({ ...target(production), cloud: loud, action: plan.actions[0]!, reviewed: plan.reviewed, record: () => {} });
    expect(result).toEqual({ success: false, error: 'Error 53300', message: 'A step on the app\'s shared database server failed (Error 53300). The app keeps using its current login.' });
    google.servers = [];
  });
});
