/**
 * A database on the app's shared server, through the path a person's commands
 * take: the Google planner, the saved plan, the saved-plan check that hv_apply
 * runs, and the Google apply. Two environments of one app share one local,
 * disposable PostgreSQL. Google's interfaces are answered by an in-memory fake
 * and the lifecycle engine by a stand-in; no cloud is contacted.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { applyGcpInfrastructureEngine, planGcpInfrastructureEngine, planGcpTeardown } from '../infrastructure-engine.js';

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

/** Reached by the mocked session helpers below, which are hoisted above everything else in this file. */
const local = vi.hoisted(() => ({ socket: '', boot: undefined as unknown as import('pg').Client }));

vi.mock('../infrastructure-engine-database.js', async (original) => {
  const { default: postgres } = await import('pg');
  return {
    ...await original<typeof import('../infrastructure-engine-database.js')>(),
    // Google's API makes a login that may create roles and databases but is no superuser.
    setCloudSqlLoginPassword: async (_token: string, _project: string, _instance: string, login: string, password: string) => {
      const exists = (await local.boot.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login])).rows.length === 1;
      await local.boot.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${login} LOGIN CREATEROLE CREATEDB PASSWORD '${password}'`);
      return 'done';
    },
    withCloudSqlSession: async (_account: unknown, _connectionName: string, user: string, password: string, database: string, work: (client: import('pg').Client) => Promise<unknown>) => {
      const client = new postgres.Client({ host: local.socket, user, password, database, connectionTimeoutMillis: 10_000 });
      client.on('error', () => {});
      await client.connect();
      try { return await work(client); } finally { await client.end().catch(() => {}); }
    },
  };
});

/** Google, as far as these commands look at it. */
const google = {
  servers: [] as Array<{ name: string; region: string; state: string; settings: { userLabels: Record<string, string>; deletionProtectionEnabled: boolean } }>,
  listWarning: false,
  /** The next secret version is stored, and its answer never arrives. */
  loseNextAnswer: false,
  secrets: new Map<string, { labels: Record<string, string>; versions: string[] }>(),
  /** Cloud Run service name -> the DATABASE_URL secret version it runs. */
  services: new Map<string, string>(),
};
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
      if (google.loseNextAnswer) { google.loseNextAnswer = false; throw new TypeError('fetch failed'); }
      return json({ name: `${name}/versions/${held.versions.length}` });
    }
    if (method !== 'GET') throw new Error(`Unexpected ${method} ${url.pathname}`);
    if (!held) return json({}, 404);
    if (secret[2] === '') return json({ name, labels: held.labels });
    if (secret[2] === '/versions/latest') return held.versions.length ? json({ name: `${name}/versions/${held.versions.length}`, state: 'ENABLED' }) : json({}, 404);
  }
  if (url.hostname === 'secretmanager.googleapis.com' && url.pathname.endsWith('/secrets')) {
    const wanted = /labels\.hv-environment=([a-z0-9_-]+)/.exec(url.searchParams.get('filter') ?? '')?.[1];
    return json({ secrets: [...google.secrets].filter(([, held]) => held.labels['hv-environment'] === wanted).map(([id]) => ({ name: `projects/${GCP}/secrets/${id}` })) });
  }
  if (url.hostname === 'sqladmin.googleapis.com' && method === 'GET') {
    if (url.pathname.endsWith('/instances')) return json({ items: google.servers, ...(google.listWarning ? { warnings: [{ code: 'REGION_UNREACHABLE', region: 'europe-west1' }] } : {}) });
    if (url.pathname.endsWith('/users')) return json({ items: [] });
    return json({}, 404);
  }
  if (url.hostname === 'run.googleapis.com' && method === 'GET') {
    const version = google.services.get(url.pathname.split('/').pop()!);
    return version ? json({ generation: '1', template: { containers: [{ env: [{ name: 'DATABASE_URL', valueSource: { secretKeyRef: { version } } }] }] } }) : json({}, 404);
  }
  if (url.hostname === 'artifactregistry.googleapis.com') return json({ name: `projects/${GCP}/locations/${REGION}/repositories/hypervibe`, format: 'DOCKER' });
  if (method !== 'GET') throw new Error(`Unexpected ${method} ${url}`);
  return json({}, 404);
}

/** The engine stand-in: what each saved plan would do when applied. */
const enginePlans = new Map<string, Array<() => void>>();
const configurations: Array<{ partition: string; configuration: EngineConfiguration }> = [];
const segmentOf = (planId: string) => ({ id: `opentofu:${planId}`, engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } });

function standInPlan({ configuration, state, planId }: Parameters<OpenTofuEngine['plan']>[0]): ReturnType<OpenTofuEngine['plan']> {
  configurations.push({ partition: state.partition, configuration });
  const segment = segmentOf(planId);
  const effects: Array<() => void> = [];
  const actions: PlanAction[] = [];
  const add = (address: string, type: PlanAction['type'], effect: () => void) => {
    const mapping = configuration.resources[address]!;
    actions.push({ id: mapping.actionId, type, resource: { kind: mapping.kind, name: mapping.name, provider: 'gcp' }, verified: true, reason: `${type} ${mapping.name}`,
      ...(mapping.billable && type === 'create' ? { billable: true } : {}), ...(mapping.dataBearing && type === 'destroy' ? { dataBearing: true, requiresConfirm: true } : {}),
      metadata: { engineSegment: { ...segment, addresses: [address] } } });
    effects.push(effect);
  };
  if (state.partition === 'project-shared') {
    const instance = (configuration.files['shared-database.tf.json'] as { resource: { google_sql_database_instance: { shared: { name: string; region: string; settings: Array<{ user_labels: Record<string, string>; deletion_protection_enabled: boolean }> } } } })
      .resource.google_sql_database_instance.shared;
    if (!google.servers.some((server) => server.name === instance.name)) {
      add('google_sql_database_instance.shared', 'create', () => { google.servers.push({ name: instance.name, region: instance.region, state: 'RUNNABLE',
        settings: { userLabels: instance.settings[0]!.user_labels, deletionProtectionEnabled: instance.settings[0]!.deletion_protection_enabled } }); });
    }
  } else {
    // An environment's own state: only its secret containers matter here. Created when declared and missing, destroyed when no longer declared.
    const declared = Object.entries((configuration.files['secrets.tf.json'] as { resource?: { google_secret_manager_secret?: Record<string, { secret_id: string; labels: Record<string, string> }> } } | undefined)
      ?.resource?.google_secret_manager_secret ?? {});
    for (const [key, container] of declared) {
      if (!google.secrets.has(container.secret_id)) add(`google_secret_manager_secret.${key}`, 'create', () => { google.secrets.set(container.secret_id, { labels: container.labels, versions: [] }); });
    }
    for (const [address, mapping] of Object.entries(configuration.resources)) {
      if (address.startsWith('google_secret_manager_secret.') && !declared.some(([key]) => address.endsWith(`.${key}`)) && google.secrets.has(mapping.name)) {
        add(address, 'destroy', () => { google.secrets.delete(mapping.name); });
      }
    }
  }
  enginePlans.set(planId, effects);
  return Promise.resolve({ ok: true, segmentId: segment.id, segment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [], actions });
}

let directory: string | undefined;
let ctx: CommandContext;
let project: ReturnType<CommandContext['repos']['projects']['create']>;
const environments: Record<string, { id: string }> = {};
const stopServer = () => {
  if (directory && existsSync(path.join(directory, 'data/postmaster.pid'))) spawnSync(`${bin}/pg_ctl`, ['-D', path.join(directory, 'data'), '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
};

const specFor = (databases: Record<string, Record<string, unknown> | undefined>) => projectSpecSchema.parse({ version: 1, project: project.name, environments: Object.fromEntries(
  Object.entries(databases).map(([name, database]) => [name, { hosting: { provider: 'cloudrun', region: REGION }, services: { web: {} }, ...(database ? { database: { provider: 'cloudsql', placement: 'app', ...database } } : {}) }])) });
let revision = 0;
async function plan(spec: ReturnType<typeof specFor>, environmentName: string, teardown = false) {
  const params = { project, spec, specRevision: ++revision, environmentName };
  const planned = teardown ? await planGcpTeardown(ctx, params) : await planGcpInfrastructureEngine(ctx, params);
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
const changes = (planned: { actions: PlanAction[] }) => planned.actions.filter((action) => action.type !== 'noop').map((action) => `${action.type} ${action.id}`);
const record = (name: string) => (ctx.repos.environments.findById(environments[name]!.id)!.platformBindings as { engine?: { database?: Record<string, string> } }).engine?.database;
const urls = (name: string) => google.secrets.get(`hv-${name}-database-url`)?.versions ?? [];
async function reach(url: string, database?: string): Promise<string> {
  const parsed = /^postgresql:\/\/([^:]+):([^@]+)@\/([^?]+)\?host=\/cloudsql\/(.+)$/.exec(url)!;
  const client = new pg.Client({ host: local.socket, user: parsed[1], password: decodeURIComponent(parsed[2]!), database: database ?? parsed[3], connectionTimeoutMillis: 10_000 });
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
const databases = async () => (await local.boot.query(`SELECT datname FROM pg_database WHERE datname LIKE 'app\\_%' ORDER BY 1`)).rows.map((row) => String(row.datname));

beforeAll(async () => {
  directory = mkdtempSync('/tmp/hv-shared-path-');
  process.once('exit', stopServer);
  const data = path.join(directory, 'data');
  local.socket = path.join(directory, 'socket');
  mkdirSync(local.socket);
  execFileSync(`${bin}/initdb`, ['-D', data, '-U', 'boot', '--auth-local=trust', '--auth-host=reject', '--no-locale'], { stdio: 'pipe' });
  writeFileSync(path.join(data, 'postgresql.conf'), `listen_addresses = ''\nunix_socket_directories = '${local.socket}'\nunix_socket_permissions = 0700\npassword_encryption = 'scram-sha-256'\nmax_connections = 60\n`);
  writeFileSync(path.join(data, 'pg_hba.conf'), 'local all boot trust\nlocal all all scram-sha-256\n');
  execFileSync(`${bin}/pg_ctl`, ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', 'start'], { stdio: 'pipe' });
  local.boot = new pg.Client({ host: local.socket, user: 'boot', database: 'postgres' });
  local.boot.on('error', () => {});
  await local.boot.connect();

  const home = mkdtempSync(path.join(tmpdir(), 'hv-shared-path-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', home);
  SecretStore.resetInstance();
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(home, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(answer));
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/unused' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(home);
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('synthetic-token');
  vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(standInPlan);
  vi.spyOn(OpenTofuEngine.prototype, 'apply').mockImplementation(async ({ planId, approvedAddresses }) => {
    for (const effect of enginePlans.get(planId) ?? []) effect();
    return { outcomes: Object.fromEntries(approvedAddresses.map((address) => [address, 'succeeded' as const])), diagnostics: [] };
  });
  vi.spyOn(SpecStore.prototype, 'merge').mockReturnValue(undefined as never);
  ctx = createCommandContext();
  project = ctx.repos.projects.create({ name: 'shared-path', gitRemoteUrl: 'https://github.com/example/shared-path' });
  const connection = ctx.repos.connections.create({ provider: 'cloudrun', scope: 'example/shared-path', credentialsEncrypted: ctx.secretStore.encryptObject({
    projectId: GCP, runtimeServiceAccountEmail: `runtime@${GCP}.iam.gserviceaccount.com`,
    credentials: JSON.stringify({ type: 'service_account', project_id: GCP, client_email: `deployer@${GCP}.iam.gserviceaccount.com`, private_key: 'synthetic-key' }) }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  for (const name of ['production', 'staging']) environments[name] = ctx.repos.environments.create({ projectId: project.id, name });
}, 60_000);

afterAll(async () => {
  try {
    await local.boot?.end().catch(() => {});
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  } finally {
    stopServer();
    if (directory) {
      const stopped = !existsSync(path.join(directory, 'data/postmaster.pid'));
      rmSync(directory, { recursive: true, force: true });
      expect(stopped).toBe(true);
    }
  }
});

describe.runIf(major >= 15)('a shared database through plan, the saved-plan check and apply', () => {
  const both = () => specFor({ production: {}, staging: {} });

  it('creates the server and production\'s database from one reviewed plan; only the server needs confirming', async () => {
    const first = await plan(both(), 'production');
    expect(changes(first)).toEqual(['create secret-container:hv-production-database-url', 'create shared-database:server', 'create shared-database:allocate']);
    expect(first.confirmActions).toEqual(['shared-database:server']);
    const allocate = first.actions.find((action) => action.id === 'shared-database:allocate')!;
    expect(allocate.billable).toBeUndefined();
    expect(allocate.dependsOn).toEqual(['shared-database:server', 'secret-container:hv-production-database-url']);
    // Unconfirmed, the billable server is not created and nothing that needs it runs.
    const held = await apply(first, []);
    expect(held.success).toBe(false);
    expect(google.servers).toEqual([]);
    expect(await databases()).toEqual([]);

    const again = await plan(both(), 'production');
    expect((await apply(again)).success).toBe(true);
    expect(google.servers).toHaveLength(1);
    expect(google.servers[0]!.settings).toEqual({ userLabels: { 'managed-by': 'hypervibe', 'hv-shared-database': project.id.toLowerCase() }, deletionProtectionEnabled: true });
    expect(record('production')).toMatchObject({ placement: 'app', tenantId: environments.production!.id, gcpProjectId: GCP, region: REGION, instanceName: google.servers[0]!.name });
    expect(record('production')!.activeLogin).toBe(`${record('production')!.databaseName}_a`);
    expect(await databases()).toEqual([record('production')!.databaseName]);
  });

  it('keeps the dedicated rule: a database create that is not this exact step must still be marked billable', async () => {
    const saved = ctx.repos.runs.findByEnvironmentId(environments.production!.id, 10).find((run) => run.type === 'plan')!.plan as { actions: PlanAction[] };
    const allocate = saved.actions.find((action) => action.id === 'shared-database:allocate')!;
    const withAction = (action: PlanAction) => planRunDocumentSchema.safeParse({ ...saved, actions: [action] });
    expect(withAction(allocate).success).toBe(true);
    const issues = (action: PlanAction) => { const checked = withAction(action); return checked.success ? [] : checked.error.issues.map((issue) => issue.message); };
    for (const metadata of [{ ...allocate.metadata, step: 'server' }, { ...allocate.metadata, operation: 'gcpDatabaseCredentialEnsure' }]) {
      expect(issues({ ...allocate, metadata })).toContain('database creation must be marked billable');
    }
    // An engine-made database cannot borrow the exemption by carrying this step's label.
    expect(issues({ ...allocate, metadata: { ...allocate.metadata, engineSegment: { id: 'opentofu:x', engine: 'opentofu', planDigest: 'a', configurationDigest: 'b', engineVersion: '1', providerVersions: {}, addresses: ['google_sql_database_instance.db'] } } }))
      .toContain('database creation must be marked billable');
    // What a step is shown as must be what it does.
    const server = saved.actions.find((action) => action.id === 'shared-database:server')!;
    expect(issues(server)).toEqual([]);
    const shape = 'A shared database step must be shown as what it does.';
    expect(issues({ ...server, requiresConfirm: false })).toContain(shape);
    expect(issues({ ...server, billable: false })).toContain(shape);
    expect(issues({ ...allocate, type: 'destroy' })).toContain(shape);
    const release: PlanAction = { ...allocate, id: 'shared-database:release', type: 'destroy', dataBearing: true, requiresConfirm: true, metadata: { ...allocate.metadata, step: 'release' } };
    expect(issues(release)).toEqual([]);
    for (const tampered of [{ ...release, type: 'update' as const }, { ...release, requiresConfirm: false }, { ...release, dataBearing: false }, { ...release, metadata: { ...release.metadata, step: 'remove-server' }, requiresConfirm: undefined },
      { ...release, type: 'update' as const, dataBearing: false, metadata: { ...release.metadata, step: 'unprotect-server' }, requiresConfirm: false }, { ...release, metadata: { ...release.metadata, step: 'drop-everything' } }]) {
      expect(issues(tampered as PlanAction)).toContain(shape);
    }
  });

  it('then connects production\'s services to it by name, with no Cloud SQL resource in the environment\'s own configuration', async () => {
    const next = await plan(both(), 'production');
    expect(changes(next)).toEqual([]);
    const text = JSON.stringify(configurations.filter((entry) => entry.partition === 'environment').at(-1)!.configuration);
    expect(text).toContain(`{"name":"CLOUD_SQL_CONNECTION_NAME","value":"${GCP}:${REGION}:${google.servers[0]!.name}"}`);
    expect(text).not.toMatch(/google_sql/);
    expect(JSON.stringify(configurations)).not.toMatch(/password|hv_admin/i);
  });

  it('gives staging its own database on the same server with nothing to confirm', async () => {
    const staged = await plan(both(), 'staging');
    expect(changes(staged)).toEqual(['create secret-container:hv-staging-database-url', 'create shared-database:allocate']);
    expect(staged.confirmActions).toEqual([]);
    expect((await apply(staged)).success).toBe(true);
    expect(google.servers).toHaveLength(1);
    expect(await databases()).toEqual([record('production')!.databaseName, record('staging')!.databaseName].sort());
    expect(await reach(urls('staging')[0]!)).toBe(record('staging')!.databaseName);
    expect(await reach(urls('production')[0]!)).toBe(record('production')!.databaseName);
    expect(await reach(urls('staging')[0]!, record('production')!.databaseName)).toBe('42501');
  });

  it('refuses a declared data copy out of a database that is on the shared server, even after "placement" left the spec', async () => {
    ctx.repos.environments.create({ projectId: project.id, name: 'copy' });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
      staging: { hosting: { provider: 'cloudrun', region: REGION }, services: { web: {} }, database: { provider: 'cloudsql' } },
      copy: { hosting: { provider: 'cloudrun', region: REGION }, services: { web: {} }, database: { provider: 'cloudsql' }, dataMigration: { id: 'copy-1', fromEnvironment: 'staging', include: { database: true } } } } });
    await expect(plan(spec, 'copy')).rejects.toThrow(/copies the database of staging, which is on the app's shared database server\. That is not available yet/);
  });

  it('plans nothing when Google\'s list of servers is incomplete', async () => {
    google.listWarning = true;
    ctx.repos.environments.create({ projectId: project.id, name: 'preview' });
    await expect(plan(specFor({ production: {}, staging: {}, preview: {} }), 'preview')).rejects.toThrow(/could not reach every region.*list may be incomplete/);
    await expect(plan(both(), 'production')).rejects.toThrow(/could not reach every region/);
    google.listWarning = false;
    expect(google.servers).toHaveLength(1);
  });

  it('rotates staging in two steps, switching the old login off only when every service runs the new version at that moment', async () => {
    const rotated = specFor({ production: {}, staging: { passwordGeneration: 2 } });
    const rotate = await plan(rotated, 'staging');
    expect(changes(rotate)).toEqual(['update shared-database:rotate']);
    expect((await apply(rotate)).success).toBe(true);
    expect(urls('staging')).toHaveLength(2);
    expect(await reach(urls('staging')[0]!)).toBe(record('staging')!.databaseName);
    expect(await reach(urls('staging')[1]!)).toBe(record('staging')!.databaseName);

    // Staging's service is still on the first version.
    ctx.repos.environments.updatePlatformBindings(environments.staging!.id, { services: { web: { serviceId: 'web-staging' } } });
    google.services.set('web-staging', '1');
    expect(changes(await plan(rotated, 'staging'))).toEqual([]);
    google.services.set('web-staging', '2');
    const retire = await plan(rotated, 'staging');
    expect(changes(retire)).toEqual(['update shared-database:retire']);
    // Rolled back between review and apply: the old login stays on.
    google.services.set('web-staging', '1');
    expect((await apply(retire)).success).toBe(false);
    expect(await reach(urls('staging')[0]!)).toBe(record('staging')!.databaseName);
    google.services.set('web-staging', '2');
    expect((await apply(await plan(rotated, 'staging'))).success).toBe(true);
    expect(['28P01', '28000']).toContain(await reach(urls('staging')[0]!));
    expect(await reach(urls('staging')[1]!)).toBe(record('staging')!.databaseName);
    expect(record('staging')!.activeLogin).toBe(`${record('staging')!.databaseName}_b`);
    expect(changes(await plan(rotated, 'staging'))).toEqual([]);
    // Production's login, secret and record were never touched.
    expect(urls('production')).toHaveLength(1);
    expect(await reach(urls('production')[0]!)).toBe(record('production')!.databaseName);
    expect(changes(await plan(rotated, 'production'))).toEqual([]);
  });

  it('recovers through the planner when Google stored a secret version and the answer was lost', async () => {
    const serving = urls('staging')[1]!;
    const rotated = specFor({ production: {}, staging: { passwordGeneration: 3 } });
    google.loseNextAnswer = true;
    expect((await apply(await plan(rotated, 'staging'))).success).toBe(false);
    expect(urls('staging')).toHaveLength(3);
    // Nothing is known about the second version; the first still works and is what services run.
    const recover = await plan(rotated, 'staging');
    expect(changes(recover)).toEqual(['update shared-database:allocate']);
    expect((await apply(recover)).success).toBe(true);
    expect(urls('staging')).toHaveLength(4);
    expect(await reach(urls('staging')[3]!)).toBe(record('staging')!.databaseName);
    expect(await reach(serving)).toBe(record('staging')!.databaseName);
    expect(await reach(urls('production')[0]!)).toBe(record('production')!.databaseName);
  });

  it('tearing staging down removes its database and secret after confirmation, and leaves production and the server', async () => {
    google.services.delete('web-staging');
    const stagingDatabase = record('staging')!.databaseName!;
    const teardown = await plan(specFor({ production: {}, staging: { passwordGeneration: 2 } }), 'staging', true);
    expect(changes(teardown)).toEqual(['destroy secret-container:hv-staging-database-url', 'destroy shared-database:release', 'destroy cleanup:leftovers']);
    expect(teardown.confirmActions).toEqual(expect.arrayContaining(['shared-database:release', 'cleanup:leftovers']));
    expect(teardown.warnings.join(' ')).toMatch(/The server and the other environments' databases on it stay/);
    expect(teardown.warnings.join(' ')).not.toMatch(/deleted with its backups/);
    const cleanup = teardown.actions.find((action) => action.id === 'cleanup:leftovers')!;
    expect(cleanup.dependsOn).toContain('shared-database:release');
    // The cleanup never looks for the shared server among the things that must be gone.
    expect(cleanup.metadata).not.toHaveProperty('instanceName');

    // Without confirmation nothing is deleted.
    expect((await apply(teardown, [])).success).toBe(false);
    expect(await databases()).toContain(stagingDatabase);
    const result = await apply(await plan(specFor({ production: {}, staging: { passwordGeneration: 2 } }), 'staging', true));
    expect(result.success).toBe(true);
    expect(await databases()).toEqual([record('production')!.databaseName]);
    expect((await local.boot.query('SELECT 1 FROM pg_roles WHERE rolname LIKE $1', [`${stagingDatabase}%`])).rows).toEqual([]);
    expect(google.secrets.has('hv-staging-database-url')).toBe(false);
    expect(record('staging')).toBeUndefined();
    expect(google.servers).toHaveLength(1);
    expect(google.servers[0]!.settings.deletionProtectionEnabled).toBe(true);
    expect(await reach(urls('production')[0]!)).toBe(record('production')!.databaseName);
    expect(changes(await plan(specFor({ production: {} }), 'production'))).toEqual([]);
  });

  it('keeps no administrator password anywhere Google or Hypervibe stores things', () => {
    expect([...google.secrets.keys()]).toEqual(['hv-production-database-url']);
    expect(JSON.stringify(ctx.repos.environments.findById(environments.production!.id)!.platformBindings)).not.toMatch(/hv_admin|password/i);
    expect(JSON.stringify(ctx.repos.runs.findByEnvironmentId(environments.production!.id, 100))).not.toMatch(/hv_admin/);
  });
});
