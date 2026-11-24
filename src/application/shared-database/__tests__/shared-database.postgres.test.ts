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
  administratorSecrets: new Map<string, { labels: Record<string, string>; value?: string }>(),
  connectionSecrets: new Map<string, { labels: Record<string, string>; versions: string[] }>(),
  engineState: new Map<string, Set<string>>(),
  plans: new Map<string, { configuration: EngineConfiguration; destroy: boolean }>(),
  engineApplies: 0,
  failNextPublish: false,
  statements: [] as string[],
};

const stateKey = (state: { projectId: string; environmentId: string; partition: string }) => `${state.projectId}/${state.environmentId}/${state.partition}`;
const instanceOf = (configuration: EngineConfiguration) => {
  const file = Object.values(configuration.files)[0] as { resource: { google_sql_database_instance: { shared: { name: string; region: string; settings: Array<{ deletion_protection_enabled: boolean; user_labels: Record<string, string> }> } };
    google_secret_manager_secret: { shared_administrator: { secret_id: string; labels: Record<string, string> } } } };
  return { instance: file.resource.google_sql_database_instance.shared, secret: file.resource.google_secret_manager_secret.shared_administrator };
};

/** Plans a create for each address not in saved state, a takeover for each import, and an update when protection differs. */
const engine: SharedDatabaseEngine = {
  async plan(configuration, state, planId, destroy) {
    const known = google.engineState.get(stateKey(state)) ?? new Set<string>();
    google.plans.set(planId, { configuration, destroy: destroy === true });
    const { instance } = instanceOf(configuration);
    const live = google.servers.find((server) => server.instanceName === instance.name);
    const actions: PlanAction[] = Object.entries(configuration.resources).map(([address, mapping]) => {
      const imported = Boolean(configuration.imports?.[address]);
      const reprotect = address.startsWith('google_sql') && live !== undefined && live.deletionProtection !== instance.settings[0]!.deletion_protection_enabled;
      const type = destroy ? (known.has(address) ? 'destroy' : 'noop') : !known.has(address) && !imported ? 'create' : imported || reprotect ? 'update' : 'noop';
      return { id: mapping.actionId, type, resource: { kind: mapping.kind, name: mapping.name, provider: 'gcp' }, verified: true, reason: 'engine',
        metadata: { engineSegment: { id: `opentofu:${planId}`, engine: 'opentofu', planDigest: 'digest', configurationDigest: 'digest', engineVersion: '1', providerVersions: {}, addresses: [address] } } };
    });
    return { ok: true, actions, blockers: [], segment: { id: `opentofu:${planId}`, engine: 'opentofu', planDigest: 'digest', configurationDigest: 'digest', engineVersion: '1', providerVersions: {} } };
  },
  async apply(state, planId, segment) {
    google.engineApplies++;
    const saved = google.plans.get(planId)!;
    const known = google.engineState.get(stateKey(state)) ?? new Set<string>();
    google.engineState.set(stateKey(state), known);
    const { instance, secret } = instanceOf(saved.configuration);
    if (saved.destroy) {
      google.servers = google.servers.filter((server) => server.instanceName !== instance.name);
      google.administratorSecrets.delete(secret.secret_id);
      known.clear();
    } else {
      for (const address of segment.addresses) known.add(address);
      const live = google.servers.find((server) => server.instanceName === instance.name);
      const seen = { instanceName: instance.name, region: instance.region, runnable: true, deletionProtection: instance.settings[0]!.deletion_protection_enabled, labels: instance.settings[0]!.user_labels };
      if (live) Object.assign(live, seen); else google.servers.push(seen);
      if (!google.administratorSecrets.has(secret.secret_id)) google.administratorSecrets.set(secret.secret_id, { labels: secret.labels });
    }
    return { outcomes: Object.fromEntries(segment.addresses.map((address) => [address, 'succeeded' as const])), diagnostics: [] };
  },
};

const cloud: SharedDatabaseCloud = {
  listServers: async () => ({ state: 'listed', servers: google.servers.map((server) => ({ ...server })) }),
  async setServerLogin(_project, _instance, login, password) {
    // Google's API creates a login that may create roles and databases but is no superuser.
    const exists = (await boot.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login])).rows.length === 1;
    await boot.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN CREATEROLE CREATEDB PASSWORD '${password}'`);
    return undefined;
  },
  async readAdministratorSecret(_project, secretId) {
    const secret = google.administratorSecrets.get(secretId);
    return secret ? { state: 'present', value: { ...secret } } : { state: 'absent' };
  },
  async writeAdministratorSecret(_project, secretId, value) {
    google.administratorSecrets.get(secretId)!.value = value;
    return undefined;
  },
  async observeConnectionSecret(_project, secretId) {
    const secret = google.connectionSecrets.get(secretId);
    if (!secret) return { state: 'absent' };
    return { state: 'present', value: { labels: secret.labels, hasEnabledVersion: secret.versions.length > 0, ...(secret.versions.length ? { latestVersion: String(secret.versions.length) } : {}) } };
  },
  async publishConnectionSecret(_project, secretId, labels, value) {
    if (google.failNextPublish) {
      google.failNextPublish = false;
      return { success: false, status: 'pending', message: 'The value write has an unknown outcome.' } satisfies ActionResult;
    }
    const secret = google.connectionSecrets.get(secretId)!;
    secret.versions.push(value);
    secret.labels = labels;
    return undefined;
  },
  relabelConnectionSecret(_project, secretId, version, labels) {
    const secret = google.connectionSecrets.get(secretId)!;
    if (String(secret.versions.length) !== version) return false;
    secret.labels = labels;
    return true;
  },
  async withSession(target, work) {
    if (!google.servers.some((server) => target.connectionName === `${GCP}:${REGION}:${server.instanceName}`)) throw new Error(`no such server: ${target.connectionName}`);
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
const target = (environment: { id: string; name: string }) => ({ project, environment, gcpProjectId: GCP, region: REGION, binding: bindings.get(environment.id), engine, cloud });
let running: string[] = [];
const planFor = (environment: { id: string; name: string }, desired: SharedDatabasePlanRequest['desired'], more: Partial<SharedDatabasePlanRequest> = {}) => sharedDatabase.plan({
  ...target(environment), desired, countsPendingWork: false, secret: { id: secretIdOf(environment), labels: labelsOf(environment) },
  runningSecretVersions: async () => ({ versions: running }), ...more,
});
const shared = { provider: 'cloudsql', engine: 'postgres', placement: 'app' } as NonNullable<SharedDatabasePlanRequest['desired']>;
const planned = async (work: ReturnType<typeof planFor>): Promise<SharedDatabasePlan> => {
  const result = await work;
  if (!result || 'blocked' in result) throw new Error(`expected a plan, got ${JSON.stringify(result)}`);
  return result;
};
const refusal = async (work: Promise<unknown>) => ((await work) as { blocked?: string } | undefined)?.blocked ?? 'not blocked';
/** Applies every action of a plan in order and records what the module says to save, as the planner does. */
async function applyAll(environment: { id: string; name: string }, plan: { actions: PlanAction[]; reviewed: Record<string, unknown> }): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of plan.actions) {
    expect(sharedDatabase.handles(action)).toBe(true);
    const applied = await sharedDatabase.apply({ ...target(environment), action, reviewed: plan.reviewed });
    if (applied.binding === null) bindings.delete(environment.id);
    else if (applied.binding) bindings.set(environment.id, { database: applied.binding });
    results.push(applied.result);
    if (!applied.result.success) break;
  }
  return results;
}
const latestUrl = (environment: { name: string }) => google.connectionSecrets.get(secretIdOf(environment))!.versions.at(-1)!;
/** Connects the way a service would, with the URL in the environment's secret; resolves to the database it reached or the PostgreSQL error code. */
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
const databases = async () => (await boot.query(`SELECT datname FROM pg_database WHERE datname LIKE 'app\\_%' ORDER BY 1`)).rows.map((row) => String(row.datname));
const everySecretValue = () => [...[...google.administratorSecrets.values()].map((secret) => secret.value), ...[...google.connectionSecrets.values()].flatMap((secret) => secret.versions)
  .map((url) => decodeURIComponent(/:([^:@]+)@/.exec(url)![1]!))].filter((value): value is string => Boolean(value));
const shown: unknown[] = [];

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
    expect(google.statements).toEqual([]);
  });

  it('plans the server once, as the only billable step, and production\'s database on it', async () => {
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
  });

  it('converges when an apply is interrupted after the database exists and before its secret is stored', async () => {
    const first = await planned(planFor(production, shared));
    google.failNextPublish = true;
    const results = await applyAll(production, first);
    expect(results.map((result) => result.success)).toEqual([true, false]);
    expect(bindings.has(production.id)).toBe(false);
    expect(await databases()).toHaveLength(1);

    const again = await planned(planFor(production, shared));
    // The server exists now: nothing billable, nothing to confirm.
    expect(again.actions.map((action) => [action.id, action.type, action.billable === true])).toEqual([['shared-database:allocate', 'create', false]]);
    expect((await applyAll(production, again)).map((result) => result.success)).toEqual([true]);
    expect(await databases()).toHaveLength(1);
    const record = bindings.get(production.id)!.database!;
    expect(record).toMatchObject({ gcpProjectId: GCP, region: REGION, placement: 'app', tenantId: production.id, instanceName: google.servers[0]!.instanceName });
    expect(record.activeLogin).toBe(`${record.databaseName}_a`);
    expect(gcpDatabasePlanBlocker(GCP, bindings.get(production.id), production.id)).toBeUndefined();
    expect(google.engineApplies).toBe(1);
  });

  it('then has nothing to do, and hands workloads the literal connection and secret version', async () => {
    const plan = await planned(planFor(production, shared));
    expect(plan.actions).toEqual([]);
    expect(plan.connection).toEqual({ connectionName: `${GCP}:${REGION}:${google.servers[0]!.instanceName}`, wireServices: true,
      workerQuery: { projectId: GCP, instanceName: google.servers[0]!.instanceName, databaseName: bindings.get(production.id)!.database!.databaseName } });
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
    expect(limits).toEqual([[bindings.get(production.id)!.database!.databaseName, 15], [bindings.get(staging.id)!.database!.databaseName, 5]].sort());
  });

  it('each environment\'s secret opens its own database and not the other\'s', async () => {
    const productionDatabase = bindings.get(production.id)!.database!.databaseName!;
    const stagingDatabase = bindings.get(staging.id)!.database!.databaseName!;
    expect(productionDatabase).not.toBe(stagingDatabase);
    expect(await reach(latestUrl(production))).toBe(productionDatabase);
    expect(await reach(latestUrl(staging))).toBe(stagingDatabase);
    expect(await reach(latestUrl(staging), productionDatabase)).toBe('42501');
    expect(await reach(latestUrl(production), stagingDatabase)).toBe('42501');
  });

  it('always works as the same administrator, on the maintenance database, with a bounded lock wait', () => {
    expect([...google.administratorSecrets.keys()]).toEqual([`hv-shared-database-admin-${google.servers[0]!.instanceName}`]);
    expect(google.statements.some((text) => /set_config\('lock_timeout'/.test(text))).toBe(true);
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
    expect(await reach(before)).toBe(bindings.get(staging.id)!.database!.databaseName);
    expect(await reach(after)).toBe(bindings.get(staging.id)!.database!.databaseName);
    expect(bindings.get(staging.id)!.database!.activeLogin).toBe(`${bindings.get(staging.id)!.database!.databaseName}_b`);

    running = ['1'];
    expect((await planned(planFor(staging, { ...shared, passwordGeneration: 2 }))).actions).toEqual([]);
    running = ['2'];
    const retire = await planned(planFor(staging, { ...shared, passwordGeneration: 2 }));
    expect(retire.actions.map((action) => action.id)).toEqual(['shared-database:retire']);
    expect((await applyAll(staging, retire)).map((result) => result.success)).toEqual([true]);
    expect(['28P01', '28000']).toContain(await reach(before));
    expect(await reach(after)).toBe(bindings.get(staging.id)!.database!.databaseName);
    expect((await planned(planFor(staging, { ...shared, passwordGeneration: 2 }))).actions).toEqual([]);
    // Production never noticed.
    expect(latestUrl(production)).toBe(productionUrl);
    expect(await reach(productionUrl)).toBe(bindings.get(production.id)!.database!.databaseName);
    expect((await planned(planFor(production, shared))).actions).toEqual([]);
  });

  it('blocks a record that is incomplete or was made for another environment', async () => {
    const record = bindings.get(staging.id)!.database!;
    expect(gcpDatabasePlanBlocker(GCP, { database: record }, staging.id)).toBeUndefined();
    expect(gcpDatabasePlanBlocker(GCP, { database: record }, production.id)).toMatch(/different environment/);
    expect(gcpDatabasePlanBlocker(GCP, { database: record })).toMatch(/different environment/);
    for (const damaged of [{ ...record, activeLogin: undefined }, { ...record, activeLogin: 'app_other_a' }, { ...record, tenantId: undefined }, { ...record, region: undefined },
      { ...record, gcpProjectId: 'another-project' }, { ...record, databaseName: 'app' }, { ...record, placement: 'account' as never }]) {
      expect(gcpDatabasePlanBlocker(GCP, { database: damaged }, staging.id)).toMatch(/incomplete/);
    }
    // Handing production's entry staging's record never reaches staging's database.
    const plan = await planned(planFor(staging, shared));
    bindings.set('env-intruder', { database: record });
    const intruder = { id: 'env-intruder', name: 'intruder' };
    google.connectionSecrets.set(secretIdOf(intruder), { labels: labelsOf(intruder), versions: [] });
    const applied = await sharedDatabase.apply({ ...target(intruder), action: { id: 'shared-database:release', type: 'destroy', resource: { kind: 'database', name: 'postgres', provider: 'gcp' }, verified: true, reason: '',
      metadata: { operation: 'gcpSharedDatabase', step: 'release', gcpProjectId: GCP, region: REGION, instanceName: record.instanceName, databaseName: record.databaseName, tenantId: 'env-intruder' } }, reviewed: plan.reviewed });
    expect(applied.result).toMatchObject({ success: false, status: 'blocked' });
    expect(await databases()).toHaveLength(2);
    bindings.delete('env-intruder');
  });

  it('refuses to move a database between its own server and the shared one, and everything not supported yet', async () => {
    const own = { ...target(production), binding: { database: { instanceName: 'hv-production-db-a1b2c3' } } };
    expect(await refusal(sharedDatabase.plan({ ...own, desired: shared, countsPendingWork: false, secret: { id: 'x', labels: {} }, runningSecretVersions: async () => ({ versions: [] }) })))
      .toMatch(/already has a database server of its own\. Moving an existing database onto the app's shared server is not available yet/);
    expect(await refusal(planFor(production, { provider: 'cloudsql', engine: 'postgres' }))).toMatch(/Moving it to a server of its own is not available yet/);
    expect(await refusal(planFor(production, shared, { countsPendingWork: true }))).toMatch(/on-demand worker that counts pending work/);
    expect(await refusal(planFor(production, { ...shared, size: 'medium' }))).toMatch(/database\.size cannot be set/);
    expect(await refusal(planFor(production, { ...shared, version: 17 }))).toMatch(/database\.version cannot be set/);
    expect(await refusal(sharedDatabase.plan({ ...target(production), binding: { ...bindings.get(production.id), migration: { copiedAt: 'now' } } as never, desired: shared, countsPendingWork: false,
      secret: { id: secretIdOf(production), labels: labelsOf(production) }, runningSecretVersions: async () => ({ versions: [] }) }))).toMatch(/Migration is not available yet/);
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
    const unknown: SharedDatabaseCloud = { ...cloud, listServers: async () => ({ state: 'unknown', reason: 'Google did not list this project\'s database servers (HTTP 503). Nothing was planned.' }) };
    expect(await refusal(sharedDatabase.plan({ ...target(production), cloud: unknown, desired: shared, countsPendingWork: false, secret: { id: secretIdOf(production), labels: labelsOf(production) },
      runningSecretVersions: async () => ({ versions: [] }) }))).toMatch(/HTTP 503/);
    expect(await databases()).toHaveLength(2);
  });

  it('will not offer to remove the server while any environment\'s database is on it', async () => {
    const removal = await sharedDatabase.planServerRemoval({ project, gcpProjectId: GCP, region: REGION, engine, cloud });
    expect(removal).toEqual({ blocked: expect.stringMatching(/still holds 2 databases .*the server is never deleted with data on it/) });
  });

  it('tearing down staging deletes only staging\'s database, after confirmation, and never the server', async () => {
    const productionUrl = latestUrl(production);
    const stagingDatabase = bindings.get(staging.id)!.database!.databaseName!;
    const release = await planned(planFor(staging, undefined, { teardown: true }));
    shown.push(release);
    expect(release.actions.map((action) => [action.id, action.type, action.dataBearing === true, action.requiresConfirm === true, action.billable === true])).toEqual([['shared-database:release', 'destroy', true, true, false]]);
    expect(release.actions[0]!.reason).toMatch(/The server itself and every other environment's database stay/);
    expect(release.connection).toBeUndefined();
    const applies = google.engineApplies;
    const results = await applyAll(staging, release);
    expect(results.map((result) => result.success)).toEqual([true]);
    expect(results[0]!.message).toMatch(/The server and the other environments' databases were not touched/);
    expect(bindings.has(staging.id)).toBe(false);
    expect(await databases()).toEqual([bindings.get(production.id)!.database!.databaseName]);
    expect((await boot.query('SELECT 1 FROM pg_roles WHERE rolname LIKE $1', [`${stagingDatabase}%`])).rows).toEqual([]);
    expect(google.engineApplies).toBe(applies);
    expect(google.servers).toHaveLength(1);
    expect(google.servers[0]!.deletionProtection).toBe(true);
    expect(await reach(productionUrl)).toBe(bindings.get(production.id)!.database!.databaseName);
    expect(await sharedDatabase.planServerRemoval({ project, gcpProjectId: GCP, region: REGION, engine, cloud })).toEqual({ blocked: expect.stringMatching(/still holds a database/) });
  });

  it('never replaces a recorded database that has gone missing with an empty one', async () => {
    const record = bindings.get(production.id)!.database!;
    const lost = { id: 'env-lost-1', name: 'lost' };
    google.connectionSecrets.set(secretIdOf(lost), { labels: labelsOf(lost), versions: [] });
    bindings.set(lost.id, { database: { ...record, databaseName: 'app_lost_0123456789ab', tenantId: lost.id, activeLogin: 'app_lost_0123456789ab_a' } });
    const plan = await planned(planFor(lost, shared));
    expect(plan.actions.map((action) => [action.id, action.type])).toEqual([['shared-database:allocate', 'update']]);
    const results = await applyAll(lost, plan);
    expect(results[0]).toMatchObject({ success: false, status: 'blocked' });
    expect(results[0]!.message).toMatch(/will not put an empty database in its place/);
    expect(await databases()).toEqual([record.databaseName]);
    bindings.delete(lost.id);
  });

  it('offers the server\'s removal once it is empty, checks again at the last moment, and removes it in two confirmed steps', async () => {
    const release = await planned(planFor(production, undefined));
    expect((await applyAll(production, release)).map((result) => result.success)).toEqual([true]);
    expect(await databases()).toEqual([]);
    expect(google.servers).toHaveLength(1);

    const request = { project, gcpProjectId: GCP, region: REGION, engine, cloud };
    const unprotect = await sharedDatabase.planServerRemoval(request) as { actions: PlanAction[]; reviewed: Record<string, unknown> };
    expect(unprotect.actions.map((action) => [action.id, action.type, action.requiresConfirm === true])).toEqual([['shared-database:unprotect-server', 'update', true]]);
    // A database arrives after the offer was made: the reviewed step refuses.
    expect((await applyAll(staging, await planned(planFor(staging, shared)))).map((result) => result.success)).toEqual([true]);
    const refused = await sharedDatabase.apply({ ...target(production), action: unprotect.actions[0]!, reviewed: unprotect.reviewed });
    expect(refused.result).toMatchObject({ success: false, status: 'blocked' });
    expect(google.servers[0]!.deletionProtection).toBe(true);
    expect((await applyAll(staging, await planned(planFor(staging, undefined)))).map((result) => result.success)).toEqual([true]);

    const applied = await sharedDatabase.apply({ ...target(production), action: unprotect.actions[0]!, reviewed: unprotect.reviewed });
    expect(applied.result.success).toBe(true);
    expect(applied.binding).toBeUndefined();
    expect(google.servers[0]!.deletionProtection).toBe(false);
    const remove = await sharedDatabase.planServerRemoval(request) as { actions: PlanAction[]; reviewed: Record<string, unknown> };
    expect(remove.actions.map((action) => [action.id, action.type, action.dataBearing === true, action.requiresConfirm === true])).toEqual([['shared-database:remove-server', 'destroy', true, true]]);
    expect((await sharedDatabase.apply({ ...target(production), action: remove.actions[0]!, reviewed: remove.reviewed })).result.success).toBe(true);
    expect(google.servers).toEqual([]);
    expect(await sharedDatabase.planServerRemoval(request)).toEqual({ blocked: expect.stringMatching(/has no shared database server/) });
  });

  it('takes over a server whose creation was interrupted instead of creating a second one', async () => {
    // Google has the labelled server; saved engine state and the administrator secret do not exist.
    google.servers.push({ instanceName: 'hv-demo-app-shared-0a0b0c', region: REGION, runnable: true, deletionProtection: true, labels: { 'managed-by': 'hypervibe', 'hv-shared-database': 'project-1' } });
    google.engineState.clear();
    const plan = await planned(planFor(production, shared));
    expect(plan.actions.map((action) => [action.id, action.type, action.billable === true])).toEqual([['shared-database:server', 'update', false], ['shared-database:allocate', 'create', false]]);
    expect(plan.connection!.connectionName).toBe(`${GCP}:${REGION}:hv-demo-app-shared-0a0b0c`);
    // Someone else's server with the same name pattern but no label is never taken.
    google.servers[0]!.labels = { 'managed-by': 'hypervibe' };
    const fresh = await planned(planFor(production, shared));
    expect(fresh.actions[0]).toMatchObject({ id: 'shared-database:server', type: 'create', billable: true });
    expect(fresh.connection!.connectionName).not.toBe(plan.connection!.connectionName);
    google.servers = [];
  });

  it('never shows a password in a plan or a result', () => {
    const text = JSON.stringify(shown);
    const secrets = everySecretValue();
    expect(secrets.length).toBeGreaterThan(2);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(google.statements.filter((statement) => secrets.some((secret) => statement.includes(secret)))).toEqual([]);
  });
});
