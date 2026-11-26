/**
 * Moving a database from the app's shared server to a server of its own,
 * through the path a person's commands take: the Google planner, the saved
 * plan, the saved-plan check hv_apply runs, and the Google apply, for each of
 * the move's three plans. Two local, disposable PostgreSQL servers stand for
 * the shared server and the environment's own; the copy job's real script runs
 * against them with the local PostgreSQL tools. Both servers are given what
 * Cloud SQL was seen to put on every database of its own accord (a live run on
 * 2026-11-25, PostgreSQL 16.15): `GRANT ALL ON SCHEMA public TO cloudsqlsuperuser`. Google's interfaces are
 * answered by an in-memory fake and the lifecycle engine by a stand-in; no
 * cloud is contacted.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { planGcpSharedDatabaseRemoval } from '../gcp-shared-database-removal.js';
import { applyGcpInfrastructureEngine, planGcpInfrastructureEngine, planGcpTeardown } from '../infrastructure-engine.js';
import { postgresBin, postgresMajor, startPostgres } from './pause-fixtures.js';

const bin = postgresBin();
const major = postgresMajor();
const GCP = 'demo-project';
const REGION = 'us-central1';
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Google, as far as these commands look at it. Reached by the mocks below, which are hoisted above everything else in this file. */
const google = vi.hoisted(() => ({
  servers: [] as Array<{ name: string; region: string; state: string; connectionName: string; databaseVersion?: string; settings: { userLabels: Record<string, string>; deletionProtectionEnabled: boolean } }>,
  secrets: new Map<string, { labels: Record<string, string>; versions: string[] }>(),
  /** Cloud Run service name -> "the DATABASE_URL secret version it runs|the server its socket is on". */
  services: new Map<string, string>(),
  local: {} as Record<'shared' | 'own', import('./pause-fixtures.js').LocalPostgres>,
  /** The next copy job answers this instead of running. */
  copyAnswers: undefined as Record<string, unknown> | undefined,
  copies: 0,
  failServiceChanges: false,
  /** Hypervibe is stopped right after Google stores the next version of this secret: the answer never arrives and nothing can be read back. */
  stoppedAfterStoring: '',
  /** Cloud Run has not got the newest revision of a service serving. */
  notServing: false,
  work: '',
}));
const sideOf = (instanceOrConnection: string) => {
  const name = instanceOrConnection.split(':').pop()!;
  return google.servers.find((server) => server.name === name)?.settings.userLabels['hv-shared-database'] ? google.local.shared : google.local.own;
};
const urlParts = (url: string) => {
  const parsed = /^postgresql:\/\/([^:]+):([^@]+)@\/([^?]+)\?host=\/cloudsql\/(.+)$/.exec(url)!;
  return { user: parsed[1]!, password: decodeURIComponent(parsed[2]!), database: parsed[3]!, connectionName: parsed[4]! };
};

// The Cloud SQL connector, pointed at the local server that stands for the instance it is asked for.
vi.mock('@google-cloud/cloud-sql-connector', async () => {
  const { symlinkSync } = await import('node:fs');
  return {
    IpAddressTypes: { PUBLIC: 'PUBLIC' },
    GoogleAuth: class {},
    Connector: class {
      async startLocalProxy(options: { instanceConnectionName: string; listenOptions: { path: string } }) { symlinkSync(`${sideOf(options.instanceConnectionName).socket}/.s.PGSQL.5432`, options.listenOptions.path); }
      close() {}
    },
  };
});

vi.mock('../migration-transfer-gcp.js', async (original) => {
  const real = await original<typeof import('../migration-transfer-gcp.js')>();
  return {
    ...real,
    // The job's own script, run here with the local tools instead of in a Cloud Run job. Each connection secret is resolved to the exact version the job names.
    runTransferJob: async (_context: unknown, job: import('../migration-transfer-gcp.js').TransferJob) => {
      google.copies += 1;
      if (google.copyAnswers) { const answer = google.copyAnswers; google.copyAnswers = undefined; return answer; }
      const local = (name: 'SOURCE_DATABASE_URL' | 'DATABASE_URL', connectionName: string) => {
        const reference = job.secretRefs![name]!;
        const url = urlParts(google.secrets.get(reference.secretId)!.versions[Number(reference.version) - 1]!);
        if (url.connectionName !== connectionName) throw new Error('The job was given a secret for another server than the one it mounts.');
        return `postgresql://${url.user}:${encodeURIComponent(url.password)}@/${url.database}?host=${encodeURIComponent(sideOf(connectionName).socket)}`;
      };
      const output = await new Promise<string>((resolve) => {
        const child = spawn('sh', ['-c', job.script.replaceAll('/tmp/hv-move', google.work)], { env: { PATH: `${bin}:${process.env.PATH}`, ...job.env,
          SOURCE_DATABASE_URL: local('SOURCE_DATABASE_URL', job.sourceCloudSqlConnectionName!), DATABASE_URL: local('DATABASE_URL', job.cloudSqlConnectionName!) } });
        let text = '';
        child.stdout.on('data', (chunk) => { text += String(chunk); });
        child.stderr.on('data', (chunk) => { text += String(chunk); });
        child.on('close', () => resolve(text));
      });
      return real.parseTransferResult(output);
    },
  };
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function answer(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const secret = /^\/v1\/projects\/demo-project\/secrets\/([^/:]+)(.*)$/.exec(url.pathname);
  if (url.hostname === 'secretmanager.googleapis.com' && secret) {
    const held = google.secrets.get(secret[1]!);
    const name = `projects/${GCP}/secrets/${secret[1]}`;
    if (secret[2] === ':addVersion' && method === 'POST' && held) {
      held.versions.push(Buffer.from((JSON.parse(String(init!.body)) as { payload: { data: string } }).payload.data, 'base64').toString('utf8'));
      if (google.stoppedAfterStoring === secret[1]) throw new TypeError('fetch failed');
      return json({ name: `${name}/versions/${held.versions.length}` });
    }
    if (method !== 'GET') throw new Error(`Unexpected ${method} ${url.pathname}`);
    if (google.stoppedAfterStoring === secret[1] && secret[2]!.endsWith(':access')) throw new TypeError('fetch failed');
    if (!held) return json({}, 404);
    if (secret[2] === '') return json({ name, labels: held.labels });
    if (secret[2] === '/versions/latest') return held.versions.length ? json({ name: `${name}/versions/${held.versions.length}`, state: 'ENABLED' }) : json({}, 404);
    const access = /^\/versions\/(\d+):access$/.exec(secret[2]!);
    if (access) {
      const value = held.versions[Number(access[1]) - 1];
      return value === undefined ? json({}, 404) : json({ name: `${name}/versions/${access[1]}`, payload: { data: Buffer.from(value).toString('base64') } });
    }
  }
  if (url.hostname === 'secretmanager.googleapis.com' && url.pathname.endsWith('/secrets')) {
    const wanted = /labels\.hv-environment=([a-z0-9_-]+)/.exec(url.searchParams.get('filter') ?? '')?.[1];
    return json({ secrets: [...google.secrets].filter(([, held]) => held.labels['hv-environment'] === wanted).map(([id]) => ({ name: `projects/${GCP}/secrets/${id}` })) });
  }
  const users = /\/instances\/([^/]+)\/users$/.exec(url.pathname);
  if (url.hostname === 'sqladmin.googleapis.com' && users && method !== 'GET') {
    // Google's API makes a login that may create roles and databases but is no superuser; on a server of its own it also joins Google's administrators' group, which owns the database Google created.
    const { name: login, password } = JSON.parse(String(init!.body)) as { name: string; password: string };
    const { boot } = sideOf(users[1]!);
    const exists = (await boot.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login])).rows.length === 1;
    await boot.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN CREATEROLE CREATEDB PASSWORD '${password}'`);
    if (sideOf(users[1]!) === google.local.own) await boot.query(`GRANT cloudsqlsuperuser TO ${login}`);
    return json({ name: 'operation', status: 'DONE' });
  }
  if (url.hostname === 'sqladmin.googleapis.com' && method === 'GET') {
    if (url.pathname.endsWith('/instances')) return json({ items: google.servers });
    if (users) return json({ items: (await sideOf(users[1]!).boot.query('SELECT rolname FROM pg_roles WHERE rolcanlogin')).rows.map((row) => ({ name: row.rolname })) });
    const server = google.servers.find((entry) => url.pathname.endsWith(`/instances/${entry.name}`));
    return server ? json(server) : json({}, 404);
  }
  if (url.hostname === 'run.googleapis.com' && method === 'GET') {
    const running = google.services.get(url.pathname.split('/').pop()!);
    return running ? json({ generation: '1', terminalCondition: { state: google.notServing ? 'CONDITION_FAILED' : 'CONDITION_SUCCEEDED' }, latestReadyRevision: 'r1', latestCreatedRevision: google.notServing ? 'r2' : 'r1', template: { containers: [{ env: [{ name: 'DATABASE_URL', valueSource: { secretKeyRef: { version: running.split('|')[0] } } }] }] } }) : json({}, 404);
  }
  if (url.hostname === 'artifactregistry.googleapis.com') return json({ name: `projects/${GCP}/locations/${REGION}/repositories/hypervibe`, format: 'DOCKER' });
  if (method !== 'GET') throw new Error(`Unexpected ${method} ${url}`);
  return json({}, 404);
}

/** The engine stand-in: what each saved plan would do, address by address, when applied. */
const enginePlans = new Map<string, Map<string, () => void | Promise<void>>>();
const shownPlans = new Map<string, unknown>();
const segmentOf = (planId: string) => ({ id: `opentofu:${planId}`, engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } });
/** What a generated service connects with: its DATABASE_URL secret version and the server of its socket. */
const wiring = (service: Json, files: Record<string, Json>): string => {
  const env = (service.template[0].containers[0].env ?? []) as Array<{ name: string; value?: string; value_source?: Array<{ secret_key_ref: Array<{ version: string }> }> }>;
  const socket = env.find((entry) => entry.name === 'CLOUD_SQL_CONNECTION_NAME')?.value;
  // The environment's own server is referred to by its address in the same configuration.
  const reference = /^\$\{google_sql_database_instance\.([a-z0-9_]+)\.connection_name\}$/.exec(socket ?? '');
  return `${env.find((entry) => entry.name === 'DATABASE_URL')?.value_source?.[0]?.secret_key_ref[0]?.version ?? 'none'}|${socket === undefined ? 'none' : reference ? files['cloudsql.tf.json'].resource.google_sql_database_instance[reference[1]!].name : socket.split(':').pop()}`;
};

function standInPlan({ configuration, state, planId, verifyPlannedChanges }: Parameters<OpenTofuEngine['plan']>[0]): ReturnType<OpenTofuEngine['plan']> {
  const segment = segmentOf(planId);
  const effects = new Map<string, () => void | Promise<void>>();
  const actions: PlanAction[] = [];
  const add = (address: string, type: PlanAction['type'], effect: () => void | Promise<void>) => {
    const mapping = configuration.resources[address]!;
    actions.push({ id: mapping.actionId, type, resource: { kind: mapping.kind, name: mapping.name, provider: 'gcp' }, verified: true, reason: `${type} ${mapping.name}`,
      ...(mapping.billable && type === 'create' ? { billable: true, requiresConfirm: true } : {}), ...(mapping.dataBearing && type === 'destroy' ? { dataBearing: true, requiresConfirm: true } : {}),
      metadata: { engineSegment: { ...segment, addresses: [address] } } });
    effects.set(address, effect);
  };
  const files = configuration.files as Record<string, Json>;
  if (state.partition === 'project-shared') {
    const instance = files['shared-database.tf.json'].resource.google_sql_database_instance.shared;
    const present = google.servers.some((server) => server.name === instance.name);
    if (!present) {
      // Google reports the version a server really runs; the local server standing for this one runs whatever this machine has.
      add('google_sql_database_instance.shared', 'create', () => { google.servers.push({ name: instance.name, region: instance.region, state: 'RUNNABLE', connectionName: `${GCP}:${REGION}:${instance.name}`, databaseVersion: `POSTGRES_${major}`,
        settings: { userLabels: instance.settings[0].user_labels, deletionProtectionEnabled: instance.settings[0].deletion_protection_enabled } }); });
    }
    const shown = { format_version: '1.2', resource_changes: [{ address: 'google_sql_database_instance.shared', type: 'google_sql_database_instance',
      change: { actions: [present ? 'no-op' : 'create'], before: present ? { name: instance.name } : null, after: { name: instance.name } } }] };
    if (verifyPlannedChanges && !verifyPlannedChanges(shown)) return Promise.resolve({ ok: false, stage: 'plan review', error: 'The saved engine plan does not match the reviewed change.' });
    shownPlans.set(planId, shown);
  } else {
    // An environment's own state: its secret containers, its own database server and its web service.
    const declared = Object.entries((files['secrets.tf.json']?.resource?.google_secret_manager_secret ?? {}) as Record<string, { secret_id: string; labels: Record<string, string> }>);
    for (const [key, container] of declared) {
      if (!google.secrets.has(container.secret_id)) add(`google_secret_manager_secret.${key}`, 'create', () => { google.secrets.set(container.secret_id, { labels: container.labels, versions: [] }); });
    }
    for (const [address, mapping] of Object.entries(configuration.resources)) {
      if (address.startsWith('google_secret_manager_secret.') && !declared.some(([key]) => address.endsWith(`.${key}`)) && google.secrets.has(mapping.name)) {
        add(address, 'destroy', () => { google.secrets.delete(mapping.name); });
      }
    }
    for (const [key, instance] of Object.entries((files['cloudsql.tf.json']?.resource?.google_sql_database_instance ?? {}) as Record<string, Json>)) {
      const protect = instance.settings[0].deletion_protection_enabled === true;
      const existing = google.servers.find((server) => server.name === instance.name);
      if (existing) {
        if (existing.settings.deletionProtectionEnabled !== protect) add(`google_sql_database_instance.${key}`, 'update', () => { existing.settings.deletionProtectionEnabled = protect; });
        continue;
      }
      add(`google_sql_database_instance.${key}`, 'create', async () => {
        google.servers.push({ name: instance.name, region: REGION, state: 'RUNNABLE', connectionName: `${GCP}:${REGION}:${instance.name}`, settings: { userLabels: { 'managed-by': 'hypervibe' }, deletionProtectionEnabled: protect } });
        // Google creates the database owned by its administrators' group.
        await google.local.own.boot.query('CREATE ROLE cloudsqlsuperuser NOLOGIN CREATEROLE CREATEDB');
        await google.local.own.boot.query('CREATE DATABASE app OWNER cloudsqlsuperuser TEMPLATE template0');
        await asBoot('own', 'app', 'GRANT ALL ON SCHEMA public TO cloudsqlsuperuser');
      });
    }
    // An own server no longer declared is deleted, unless Google itself still protects it.
    for (const [address, mapping] of Object.entries(configuration.resources)) {
      const gone = address.startsWith('google_sql_database_instance.') && !files['cloudsql.tf.json']?.resource?.google_sql_database_instance?.[address.split('.')[1]!];
      const own = google.servers.find((server) => !server.settings.userLabels['hv-shared-database']);
      if (gone && own && mapping.actionId === 'database:postgres') add(address, 'destroy', () => { if (own.settings.deletionProtectionEnabled) throw new Error('protected'); google.servers.splice(google.servers.indexOf(own), 1); });
    }
    for (const [key, service] of Object.entries((files['cloudrun.tf.json']?.resource?.google_cloud_run_v2_service ?? {}) as Record<string, Json>)) {
      const wanted = wiring(service, files);
      if (google.services.get(service.name) !== wanted) add(`google_cloud_run_v2_service.${key}`, google.services.has(service.name) ? 'update' : 'create', () => { google.services.set(service.name, wanted); });
    }
  }
  enginePlans.set(planId, effects);
  return Promise.resolve({ ok: true, segmentId: segment.id, segment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [], actions });
}

let ctx: CommandContext;
let project: ReturnType<CommandContext['repos']['projects']['create']>;
let environment: { id: string };
let home: string;

const specFor = (database: Record<string, unknown>) => projectSpecSchema.parse({ version: 1, project: project.name, environments: {
  production: { hosting: { provider: 'cloudrun', region: REGION }, services: { web: {} }, database: { provider: 'cloudsql', ...database } } } });
const shared = () => specFor({ placement: 'app' });
const own = () => specFor({});
let revision = 0;
async function attempt(spec: ReturnType<typeof specFor>, teardown = false) {
  const params = { project, spec, specRevision: ++revision, environmentName: 'production' };
  return teardown ? planGcpTeardown(ctx, params) : planGcpInfrastructureEngine(ctx, params);
}
async function plan(spec: ReturnType<typeof specFor>) {
  const planned = await attempt(spec);
  if ('blocked' in planned) throw new Error(`blocked: ${planned.blocked.join(' ')}`);
  // The saved document is what hv_apply loads and checks before it runs anything.
  const saved = ctx.repos.runs.findById(planned.planRunId)!.plan;
  const checked = planRunDocumentSchema.safeParse(saved);
  expect(checked.success ? [] : checked.error.issues.map((issue) => issue.message)).toEqual([]);
  return { ...planned, spec, saved: saved as { actions: PlanAction[] } };
}
async function apply(planned: Awaited<ReturnType<typeof plan>>, confirmActions = planned.confirmActions) {
  const applied = await applyGcpInfrastructureEngine(ctx, { project, spec: planned.spec, specRevision: revision, planId: planned.planRunId, confirmActions });
  if (applied.kind !== 'executed') throw new Error(`not executed: ${applied.reason}`);
  return applied.result;
}
const blockedBy = async (spec: ReturnType<typeof specFor>, teardown = false) => { const planned = await attempt(spec, teardown); return 'blocked' in planned ? planned.blocked.join(' ') : 'planned'; };
const changes = (planned: { actions: PlanAction[] }) => planned.actions.filter((action) => action.type !== 'noop').map((action) => `${action.type} ${action.id}`);
const record = () => (ctx.repos.environments.findById(environment.id)!.platformBindings as { engine?: { database?: Record<string, Json> } }).engine?.database;
const urls = () => google.secrets.get('hv-production-database-url')?.versions ?? [];
const web = () => [...google.services.values()][0];
/** Runs one statement as the app would, with one version of its connection secret; a refused login answers its error code. */
async function asApp(url: string, statement: string): Promise<string> {
  const parts = urlParts(url);
  const client = new pg.Client({ host: sideOf(parts.connectionName).socket, user: parts.user, password: parts.password, database: parts.database, connectionTimeoutMillis: 10_000 });
  client.on('error', () => {});
  try {
    await client.connect();
    return String(Object.values((await client.query(statement)).rows[0] ?? {})[0] ?? '');
  } catch (error) {
    return String((error as { code?: string }).code);
  } finally {
    await client.end().catch(() => {});
  }
}
/** One statement as the server's own superuser, inside one database: what Google does by itself, or what a person does by hand. */
async function asBoot(side: 'shared' | 'own', database: string, statement: string): Promise<void> {
  const client = await google.local[side].connect('boot', undefined, database);
  try { await client.query(statement); } finally { await google.local[side].close(client); }
}
/** Runs `work` with no workload bound to the environment, as when none uses the database. */
async function withNoWorkloads<T>(work: () => Promise<T>): Promise<T> {
  const services = ctx.repos.environments.findById(environment.id)!.platformBindings.services;
  ctx.repos.environments.updatePlatformBindings(environment.id, { services: {} });
  try { return await work(); } finally { ctx.repos.environments.updatePlatformBindings(environment.id, { services }); }
}
const tenants = async () => (await google.local.shared.boot.query(`SELECT datname FROM pg_database WHERE datname LIKE 'app\\_%' ORDER BY 1`)).rows.map((row) => String(row.datname));

beforeAll(async () => {
  google.local.shared = await startPostgres('hv-move-shared');
  await google.local.shared.boot.query('CREATE ROLE cloudsqlsuperuser NOLOGIN CREATEROLE CREATEDB; CREATE ROLE reporting NOLOGIN');
  google.local.own = await startPostgres('hv-move-own');
  home = mkdtempSync(path.join(tmpdir(), 'hv-move-path-'));
  google.work = path.join(home, 'work');
  vi.stubEnv('HYPERVIBE_DATA_DIR', home);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(home, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(answer));
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/unused' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(home);
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('synthetic-token');
  vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(standInPlan);
  vi.spyOn(OpenTofuEngine.prototype, 'apply').mockImplementation(async ({ planId, approvedAddresses, verifySavedPlan }) => {
    if (verifySavedPlan && !verifySavedPlan(shownPlans.get(planId))) return { outcomes: Object.fromEntries(approvedAddresses.map((address) => [address, 'not_started' as const])), diagnostics: ['The saved engine plan does not do what was reviewed.'] };
    const outcomes: Record<string, 'succeeded' | 'failed'> = {};
    for (const address of approvedAddresses) {
      if (google.failServiceChanges && address.startsWith('google_cloud_run_v2_service.')) { outcomes[address] = 'failed'; continue; }
      await enginePlans.get(planId)?.get(address)?.();
      outcomes[address] = 'succeeded';
    }
    return { outcomes, diagnostics: Object.values(outcomes).includes('failed') ? ['Cloud Run did not accept the new revision.'] : [] };
  });
  vi.spyOn(SpecStore.prototype, 'merge').mockReturnValue(undefined as never);
  ctx = createCommandContext();
  project = ctx.repos.projects.create({ name: 'move-path', gitRemoteUrl: 'https://github.com/example/move-path' });
  const connection = ctx.repos.connections.create({ provider: 'cloudrun', scope: 'example/move-path', credentialsEncrypted: ctx.secretStore.encryptObject({
    projectId: GCP, runtimeServiceAccountEmail: `runtime@${GCP}.iam.gserviceaccount.com`,
    credentials: JSON.stringify({ type: 'service_account', project_id: GCP, client_email: `deployer@${GCP}.iam.gserviceaccount.com`, private_key: 'synthetic-key' }) }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  environment = ctx.repos.environments.create({ projectId: project.id, name: 'production' });
}, 90_000);

afterAll(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  const stopped = [await google.local.shared?.stop(), await google.local.own?.stop()];
  if (home) rmSync(home, { recursive: true, force: true });
  expect(stopped).toEqual([true, true]);
});

describe.runIf(major >= 15)('moving a database from the shared server to a server of its own, plan by plan', () => {
  let sharedUrl = '';

  it('starts from an ordinary app on the shared server: a database Hypervibe made, a running service, and the app\'s own data', async () => {
    for (let round = 0; round < 3 && (round === 0 || changes(await plan(shared())).length); round++) { const done = await apply(await plan(shared())); expect(done.success, JSON.stringify(done)).toBe(true); }
    expect(changes(await plan(shared()))).toEqual([]);
    const serviceName = [...google.services.keys()][0]!;
    ctx.repos.environments.updatePlatformBindings(environment.id, { services: { web: { serviceId: serviceName } } });
    sharedUrl = urls().at(-1)!;
    await asBoot('shared', record()!.databaseName, 'GRANT ALL ON SCHEMA public TO cloudsqlsuperuser');
    expect(web()).toBe(`${urls().length}|${record()!.instanceName}`);
    // What an ordinary app leaves in its database: tables with keys and a sequence, an index, a view, a function.
    for (const statement of [
      'CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL UNIQUE)',
      'CREATE TABLE orders (id bigserial PRIMARY KEY, customer integer NOT NULL REFERENCES customers, total numeric(10,2), placed timestamptz DEFAULT now())',
      'CREATE INDEX orders_by_customer ON orders (customer)',
      'CREATE VIEW totals AS SELECT customer, sum(total) AS total FROM orders GROUP BY customer',
      'CREATE FUNCTION order_count() RETURNS bigint LANGUAGE sql AS \'SELECT count(*) FROM orders\'',
      'INSERT INTO customers (name) SELECT \'customer \' || n FROM generate_series(1, 200) n',
      'INSERT INTO orders (customer, total) SELECT 1 + n % 200, n FROM generate_series(1, 3000) n',
    ]) expect(await asApp(sharedUrl, statement)).not.toMatch(/^[0-9A-Z]{5}$/);
    expect(await asApp(sharedUrl, 'SELECT order_count()')).toBe('3000');
  }, 120_000);

  it('step 1 creates the own server, its logins and its connection, and leaves the running app exactly where it is', async () => {
    const before = { web: web(), urls: urls().length };
    // What the copy would refuse is found out now, before a server is paid for.
    await google.local.shared.boot.query(`ALTER DATABASE ${record()!.databaseName} SET work_mem = '8MB'`);
    expect(await blockedBy(own())).toContain('has 1 setting(s) made on the database or the app\'s role, which a copy does not carry over, so it cannot be moved');
    await google.local.shared.boot.query(`ALTER DATABASE ${record()!.databaseName} RESET work_mem`);
    await asBoot('shared', record()!.databaseName, 'GRANT USAGE ON SCHEMA public TO reporting');
    expect(await blockedBy(own())).toContain('grants access the copy cannot carry over (schema public: USAGE to reporting), so it cannot be moved');
    await asBoot('shared', record()!.databaseName, 'REVOKE USAGE ON SCHEMA public FROM reporting');
    // Nor is a move started when no workload runs the database's connection: there would be nothing to switch and nothing to fall back to.
    expect(await withNoWorkloads(() => blockedBy(own()))).toContain('No service of production uses its database');
    expect(google.servers).toHaveLength(1);
    const prepared = await plan(own());
    expect(changes(prepared)).toEqual(['create secret-container:hv-production-database-url-copy', 'create database:postgres', 'create database-credential:postgres']);
    expect(prepared.confirmActions).toEqual(['database:postgres']);
    expect(prepared.warnings.join(' ')).toContain('This plan is step 1');
    // Hypervibe is stopped between Google storing the own server's login and Hypervibe recording it (issue 865).
    google.stoppedAfterStoring = 'hv-production-database-url';
    const stopped = await apply(prepared);
    google.stoppedAfterStoring = '';
    expect(stopped.success).toBe(false);
    expect(urls()).toHaveLength(before.urls + 1);
    // Stopped at the same point a second time: the leftover is set aside, and the next one is left unrecorded in its turn.
    google.stoppedAfterStoring = 'hv-production-database-url';
    expect((await apply(await plan(own()))).success).toBe(false);
    google.stoppedAfterStoring = '';
    expect(web()).toBe(before.web);
    expect(await asApp(sharedUrl, 'SELECT order_count()')).toBe('3000');
    // Running again recovers: the version nobody recorded is set aside and the login is made and stored anew.
    const again = await plan(own());
    expect(changes(again)).toEqual(['create database-credential:postgres']);
    const done = await apply(again);
    expect(done.success, JSON.stringify(done)).toBe(true);
    const ownServer = google.servers.find((server) => !server.settings.userLabels['hv-shared-database'])!.name;
    expect(record()).toMatchObject({ placement: 'app', move: { instanceName: ownServer } });
    // Two versions were set aside, so the own server's login is the third new one.
    expect(urls()).toHaveLength(before.urls + 3);
    expect(urlParts(urls().at(-1)!)).toMatchObject({ user: 'app_a', database: 'app', connectionName: `${GCP}:${REGION}:${ownServer}` });
    // The service still runs the shared database's connection, and that connection still works.
    expect(web()).toBe(before.web);
    expect(await asApp(sharedUrl, 'SELECT order_count()')).toBe('3000');
    expect(await asApp(urls().at(-1)!, 'SELECT count(*) FROM pg_tables WHERE schemaname = \'public\'')).toBe('0');
  }, 120_000);

  it('while the move is under way, nothing else may be planned for that database', async () => {
    expect(await blockedBy(shared())).toContain('is being moved to a server of its own');
    expect(await blockedBy(own(), true)).toContain('is being moved to a server of its own');
    expect(await blockedBy(specFor({ passwordGeneration: 2 }))).toContain('before changing its password');
    const removal = await planGcpSharedDatabaseRemoval(ctx, { project, specRevision: ++revision });
    expect('blocked' in removal ? removal.blocked.join(' ') : 'planned').toContain('production still has its database on the app\'s shared database server');
  }, 60_000);

  it('step 2 is one confirmed step before any service changes, and a saved plan cannot show it as something else', async () => {
    const switching = await plan(own());
    expect(changes(switching)).toEqual(['update shared-database:switch', 'update service:web']);
    expect(switching.confirmActions).toEqual(['shared-database:switch']);
    expect(switching.actions.find((action) => action.id === 'service:web')!.dependsOn).toContain('shared-database:switch');
    const step = switching.saved.actions.find((action) => action.id === 'shared-database:switch')!;
    expect(step.reason).toContain('How long depends on the size of the database and has not been measured');
    expect(switching.warnings.join(' ')).toContain('cannot reach its database and will return database errors');
    const issues = (action: PlanAction) => { const checked = planRunDocumentSchema.safeParse({ ...switching.saved, actions: [action] }); return checked.success ? [] : checked.error.issues.map((issue) => issue.message); };
    expect(issues(step)).toEqual([]);
    for (const forged of [{ ...step, requiresConfirm: false }, { ...step, id: 'shared-database:rotate' }, { ...step, type: 'noop' as const }, { ...step, metadata: { ...step.metadata, step: 'release' } }]) {
      expect(issues(forged)).toContain('A shared database step must be shown as what it does.');
    }
    // Not confirmed: nothing is paused and nothing moves.
    expect((await apply(switching, [])).success).toBe(false);
    expect(google.copies).toBe(0);
    expect(await asApp(sharedUrl, 'SELECT order_count()')).toBe('3000');
  }, 60_000);

  it('a privilege a person granted after step 1 stops the copy itself, which names it, and the app is let back in', async () => {
    await asBoot('shared', record()!.databaseName, 'GRANT SELECT ON TABLE public.orders TO reporting');
    const result = await apply(await plan(own()));
    await asBoot('shared', record()!.databaseName, 'REVOKE SELECT ON TABLE public.orders FROM reporting');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('GRANT SELECT ON TABLE public.orders TO reporting;');
    expect(JSON.stringify(result)).toContain('The app\'s login to its database on the shared server works again');
    expect(await asApp(sharedUrl, 'SELECT order_count()')).toBe('3000');
    expect(record()!.placement).toBe('app');
  }, 120_000);

  it('a copy that fails lets the app back into the shared database, and nothing has moved', async () => {
    const before = { web: web(), record: record() };
    google.copyAnswers = { ok: false, stage: 'dump', targetChanged: false, error: 'The source database could not be dumped; nothing was changed.' };
    // As an earlier switch cut short would leave it: the app's login already switched off. The step can still be planned, and applying it puts that right.
    await google.local.shared.boot.query(`ALTER ROLE ${urlParts(sharedUrl).user} NOLOGIN`);
    expect(await asApp(sharedUrl, 'SELECT 1')).toMatch(/^28/);
    // And the copy login's secret holds a version Google stored without Hypervibe hearing back.
    const copyId = 'hv-production-database-url-copy';
    google.secrets.get(copyId)!.versions.push('postgresql://lost:lost@/lost?host=/cloudsql/lost');
    const saved = (ctx.repos.environments.findById(environment.id)!.platformBindings as { engine: { secretMetadata?: Record<string, unknown> } }).engine;
    ctx.repos.environments.updatePlatformBindings(environment.id, { engine: { ...saved, secretMetadata: { ...saved.secretMetadata, [copyId]: { gcpProjectId: GCP, version: 'pending', labels: google.secrets.get(copyId)!.labels } } } });
    const result = await apply(await plan(own()));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('was not moved: The source database could not be dumped; nothing was changed. The app\'s login to its database on the shared server works again');
    expect(google.copies).toBe(2);
    expect(record()).toEqual(before.record);
    expect(web()).toBe(before.web);
    // The app really is back: the connection its service holds reads and writes.
    expect(await asApp(sharedUrl, 'INSERT INTO customers (name) VALUES (\'after the failed move\') RETURNING id')).toBe('201');
  }, 120_000);

  it('once the copy is checked the environment has its own server; a service change that then fails leaves the old database shut, and running again finishes', async () => {
    const ownUrl = urls().at(-1)!;
    google.failServiceChanges = true;
    const interrupted = await apply(await plan(own()));
    google.failServiceChanges = false;
    expect(interrupted.success).toBe(false);
    expect(google.copies, JSON.stringify(interrupted)).toBe(3);
    expect(JSON.stringify(interrupted)).toContain('was copied to its own server');
    const ownServer = urlParts(ownUrl).connectionName.split(':').pop()!;
    expect(record()).toMatchObject({ instanceName: ownServer, movedFrom: { placement: 'app' } });
    expect(record()!.placement).toBeUndefined();
    // The app is shut out of the old database, and the new one holds everything, the row written after the failed attempt included.
    expect(await asApp(sharedUrl, 'SELECT 1')).toMatch(/^28/);
    expect(await asApp(ownUrl, 'SELECT order_count()')).toBe('3000');
    expect(await asApp(ownUrl, 'SELECT count(*) || \'/\' || max(id) FROM customers')).toBe('201/201');
    expect(await asApp(ownUrl, 'INSERT INTO customers (name) VALUES (\'first on its own server\') RETURNING id')).toBe('202');
    expect(await asApp(ownUrl, 'SELECT sum(total) FROM totals')).toBe(String((3000 * 3001) / 2) + '.00');

    // The service still runs the old connection, so the old copy may not be deleted: not offered, and refused if a saved plan asks.
    const finishing = await plan(own());
    // The copy login's secret has done its work and goes with this plan.
    expect(changes(finishing).sort()).toEqual(['destroy secret-container:hv-production-database-url-copy', 'update service:web']);
    expect(finishing.warnings.join(' ')).toContain('stays there, closed to the app, because a service of production does not run the connection to its own database server yet');
    expect((await apply(finishing)).success).toBe(true);
    expect(web()).toBe(`${urls().length}|${ownServer}`);
    expect(google.secrets.has('hv-production-database-url-copy')).toBe(false);
    expect(await tenants()).toHaveLength(1);
  }, 180_000);

  it('step 3 deletes the old copy only while every service runs the new connection, and then the environment is an ordinary one with its own server', async () => {
    const ownServer = record()!.instanceName as string;
    // Not offered while the newest revision of a service is not the one serving, or while no workload can be seen at all.
    google.notServing = true;
    const unsettled = await plan(own());
    google.notServing = false;
    expect(changes(unsettled)).toEqual([]);
    expect(unsettled.warnings.join(' ')).toContain('web is not serving its newest revision');
    const services = ctx.repos.environments.findById(environment.id)!.platformBindings.services;
    ctx.repos.environments.updatePlatformBindings(environment.id, { services: {} });
    const unseen = await plan(own());
    ctx.repos.environments.updatePlatformBindings(environment.id, { services });
    expect(changes(unseen).filter((change) => change.includes('shared-database'))).toEqual([]);
    expect(unseen.warnings.join(' ')).toContain('no service of production could be seen running');
    const cleanup = await plan(own());
    expect(changes(cleanup)).toEqual(['destroy shared-database:release']);
    expect(cleanup.confirmActions).toContain('shared-database:release');
    // A service back on the old connection after the plan was saved: the delete is refused.
    const now = web()!;
    google.services.set([...google.services.keys()][0]!, `1|${ownServer}`);
    const refused = await apply(cleanup);
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused)).toContain('was not deleted: a service of production does not run the connection to its own database server yet');
    expect(await tenants()).toHaveLength(1);
    google.services.set([...google.services.keys()][0]!, now);

    expect((await apply(await plan(own()))).success).toBe(true);
    expect(await tenants()).toEqual([]);
    expect(record()).toEqual({ instanceName: ownServer });
    expect(await asApp(urls().at(-1)!, 'SELECT count(*) FROM customers')).toBe('202');
    expect(changes(await plan(own()))).toEqual([]);
    // Nothing of the app is recorded on the shared server any more, so it can be removed.
    const removal = await planGcpSharedDatabaseRemoval(ctx, { project, specRevision: ++revision });
    expect('blocked' in removal ? removal.blocked.join(' ') : '').not.toContain('production');
    // No password or administrator detail was saved anywhere along the way.
    expect(JSON.stringify(ctx.repos.environments.findById(environment.id)!.platformBindings)).not.toMatch(/hv_admin|password|postgresql:\/\//i);
  }, 180_000);
});

describe.runIf(major >= 15)('and back: moving that database from its own server onto the shared server, plan by plan', () => {
  let ownUrl = '';
  let ownServer = '';
  const tenant = () => (record()!.moveTo ?? record()!) as Record<string, Json>;

  it('step 1 makes the database on the shared server and its login, and leaves the running app on its own server', async () => {
    ownUrl = urls().at(-1)!;
    ownServer = record()!.instanceName as string;
    const before = { web: web(), urls: urls().length };
    expect(await withNoWorkloads(() => blockedBy(shared()))).toContain('No service of production uses its database');
    // A shared server on another PostgreSQL version than the own server: refused before anything is made.
    const sharedServer = google.servers.find((server) => server.settings.userLabels['hv-shared-database'])!;
    sharedServer.databaseVersion = `POSTGRES_${major - 1}`;
    expect(await blockedBy(shared())).toContain(`production's database server runs PostgreSQL ${major}; the app's shared database server runs ${major - 1}, and a move keeps the version`);
    sharedServer.databaseVersion = `POSTGRES_${major}`;
    expect(await tenants()).toEqual([]);
    expect(record()).toEqual({ instanceName: ownServer });
    const prepared = await plan(shared());
    expect(changes(prepared).sort()).toEqual(['create secret-container:hv-production-database-url-copy', 'create shared-database:allocate']);
    expect(prepared.warnings.join(' ')).toContain('This plan is step 1');
    // Hypervibe is stopped between Google storing the shared database's login and Hypervibe recording it. Running again carries on.
    google.stoppedAfterStoring = 'hv-production-database-url';
    expect((await apply(prepared)).success).toBe(false);
    google.stoppedAfterStoring = '';
    expect(urls()).toHaveLength(before.urls + 1);
    expect(web()).toBe(before.web);
    const done = await apply(await plan(shared()));
    expect(done.success, JSON.stringify(done)).toBe(true);
    expect(record()).toMatchObject({ instanceName: ownServer, moveTo: { placement: 'app', activeLogin: expect.stringMatching(/_a$/) } });
    expect(record()!.placement).toBeUndefined();
    // What Google puts on every database, on this new one too.
    await asBoot('shared', tenant().databaseName, 'GRANT ALL ON SCHEMA public TO cloudsqlsuperuser');
    // The version nobody recorded was set aside, so the shared database's login is the second new one.
    expect(urls()).toHaveLength(before.urls + 2);
    expect(urlParts(urls().at(-1)!).database).toBe(tenant().databaseName);
    expect(web()).toBe(before.web);
    expect(await asApp(ownUrl, 'SELECT count(*) FROM customers')).toBe('202');
  }, 120_000);

  it('while that move is under way, nothing else may be planned for the database', async () => {
    expect(await blockedBy(own())).toContain('is being moved onto the app\'s shared database server');
    expect(await blockedBy(shared(), true)).toContain('is being moved onto the app\'s shared database server');
    const removal = await planGcpSharedDatabaseRemoval(ctx, { project, specRevision: ++revision });
    expect('blocked' in removal ? removal.blocked.join(' ') : 'planned').toContain('production still has its database on the app\'s shared database server');
  }, 60_000);

  it('a copy that fails lets the app back into its own server, and nothing has moved', async () => {
    const before = { web: web(), record: record() };
    const switching = await plan(shared());
    expect(changes(switching)).toEqual(['update shared-database:switch', 'update service:web']);
    expect(switching.confirmActions).toEqual(['shared-database:switch']);
    expect(switching.actions.find((action) => action.id === 'service:web')!.dependsOn).toContain('shared-database:switch');
    google.copyAnswers = { ok: false, stage: 'dump', targetChanged: false, error: 'The source database could not be dumped; nothing was changed.' };
    const result = await apply(switching);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('was not moved: The source database could not be dumped; nothing was changed. The app\'s login to its database on its own server works again');
    expect(record()).toEqual(before.record);
    expect(web()).toBe(before.web);
    expect(await asApp(ownUrl, 'INSERT INTO customers (name) VALUES (\'after the failed move back\') RETURNING id')).toBe('203');
  }, 120_000);

  it('once the copy is checked the environment is on the shared server; a service change that then fails leaves its own server shut, and running again finishes', async () => {
    google.failServiceChanges = true;
    const interrupted = await apply(await plan(shared()));
    google.failServiceChanges = false;
    expect(interrupted.success).toBe(false);
    expect(JSON.stringify(interrupted)).toContain('was copied onto the app\'s shared database server');
    expect(record()).toMatchObject({ placement: 'app', movedFrom: { instanceName: ownServer } });
    expect(record()!.moveTo).toBeUndefined();
    const sharedUrl = urls().at(-1)!;
    expect(await asApp(ownUrl, 'SELECT 1')).toMatch(/^28/);
    expect(await asApp(sharedUrl, 'SELECT count(*) || \'/\' || max(id) FROM customers')).toBe('203/203');
    expect(await asApp(sharedUrl, 'SELECT order_count()')).toBe('3000');
    expect(await asApp(sharedUrl, 'INSERT INTO customers (name) VALUES (\'back on the shared server\') RETURNING id')).toBe('204');

    const finishing = await plan(shared());
    expect(changes(finishing).sort()).toEqual(['destroy secret-container:hv-production-database-url-copy', 'update service:web']);
    expect(finishing.warnings.join(' ')).toContain(`Its own server ${ownServer} stays, closed to the app, because a service of production does not run the connection to the shared database server yet`);
    expect((await apply(finishing)).success).toBe(true);
    expect(web()).toBe(`${urls().length}|${record()!.instanceName}`);
    expect(google.servers.some((server) => server.name === ownServer)).toBe(true);
  }, 180_000);

  it('the own server is deleted only on positive evidence, in two confirmed-where-destructive plans because it is protected, and then nothing is left to do', async () => {
    google.notServing = true;
    const unsettled = await plan(shared());
    google.notServing = false;
    expect(changes(unsettled)).toEqual([]);
    expect(unsettled.warnings.join(' ')).toContain('web is not serving its newest revision');

    const unprotect = await plan(shared());
    expect(changes(unprotect)).toEqual(['update database:postgres']);
    expect(unprotect.warnings.join(' ')).toContain('this one only turns the protection off');
    expect((await apply(unprotect)).success).toBe(true);
    expect(google.servers.find((server) => server.name === ownServer)!.settings.deletionProtectionEnabled).toBe(false);
    expect(record()).toMatchObject({ placement: 'app', movedFrom: { instanceName: ownServer } });

    // Protection is off now. If a workload is then not seen on the shared database, the plan waits; it neither turns protection back on nor gets stuck.
    google.notServing = true;
    const waiting = await plan(shared());
    google.notServing = false;
    expect(changes(waiting)).toEqual([]);
    expect(waiting.warnings.join(' ')).toContain(`Its own server ${ownServer} stays`);
    expect(google.servers.find((server) => server.name === ownServer)!.settings.deletionProtectionEnabled).toBe(false);

    const removal = await plan(shared());
    expect(changes(removal)).toEqual(['update shared-database:confirm-moved', 'destroy database:postgres']);
    expect(removal.confirmActions).toEqual(['database:postgres']);
    // A service back on the old connection after the plan was saved: the server is not touched.
    const now = web()!;
    google.services.set([...google.services.keys()][0]!, `1|${ownServer}`);
    const refused = await apply(removal);
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused)).toContain('own database server was not touched: a service of production does not run the connection to the shared database server yet');
    expect(google.servers.some((server) => server.name === ownServer)).toBe(true);
    google.services.set([...google.services.keys()][0]!, now);

    expect((await apply(await plan(shared()))).success).toBe(true);
    expect(google.servers.some((server) => server.name === ownServer)).toBe(false);
    expect(record()!.movedFrom).toBeUndefined();
    expect(record()).toMatchObject({ placement: 'app', tenantId: environment.id });
    expect(await asApp(urls().at(-1)!, 'SELECT count(*) FROM customers')).toBe('204');
    expect(changes(await plan(shared()))).toEqual([]);
    expect(JSON.stringify(ctx.repos.environments.findById(environment.id)!.platformBindings)).not.toMatch(/hv_admin|password|postgresql:\/\//i);
  }, 180_000);
});
