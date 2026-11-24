/**
 * Removing the app's shared database server with the commands a person or the
 * CLI runs: hv_plan scope="shared-database" intent="remove", the saved plan,
 * the saved-plan check, and hv_apply. Two environments of one app share one
 * local, disposable PostgreSQL. Google's interfaces are answered by an
 * in-memory fake and the lifecycle engine by a stand-in; no cloud is contacted.
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
import { CommandRegistry } from '../../application/commands.js';
import { createCommandContext, type CommandContext } from '../../application/context.js';
import { registerCoreTools } from '../core.tools.js';
import '../../application/providers.js';
import { applyGcpInfrastructureEngine, planGcpInfrastructureEngine, planGcpTeardown } from '../../application/infrastructure-engine.js';

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

vi.mock('../../application/infrastructure-engine-database.js', async (original) => {
  const { default: postgres } = await import('pg');
  return {
    ...await original<typeof import('../../application/infrastructure-engine-database.js')>(),
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
  /** The server name OpenTofu's saved state holds; set when the stand-in creates one. */
  stateServerName: undefined as string | undefined,
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
const shownPlans = new Map<string, unknown>();
const configurations: Array<{ partition: string; configuration: EngineConfiguration }> = [];
const segmentOf = (planId: string) => ({ id: `opentofu:${planId}`, engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } });

function standInPlan({ configuration, state, planId, destroy, verifyPlannedChanges }: Parameters<OpenTofuEngine['plan']>[0]): ReturnType<OpenTofuEngine['plan']> {
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
    const live = google.servers.find((server) => server.name === instance.name);
    if (live && destroy) {
      add('google_sql_database_instance.shared', 'destroy', () => { google.servers = google.servers.filter((server) => server !== live); });
    } else if (live && live.settings.deletionProtectionEnabled !== instance.settings[0]!.deletion_protection_enabled) {
      add('google_sql_database_instance.shared', 'update', () => { live.settings.deletionProtectionEnabled = instance.settings[0]!.deletion_protection_enabled; });
    } else if (!live) {
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
  if (state.partition === 'project-shared') {
    // What OpenTofu's own plan says: the operation, the server named in saved state, and the one in the configuration.
    const name = (configuration.files['shared-database.tf.json'] as { resource: { google_sql_database_instance: { shared: { name: string } } } }).resource.google_sql_database_instance.shared.name;
    const type = actions[0]?.type ?? 'noop';
    const before = type === 'create' ? null : { name: google.stateServerName ?? name };
    const shown = { format_version: '1.2', resource_changes: [{ address: 'google_sql_database_instance.shared', type: 'google_sql_database_instance',
      change: { actions: [type === 'destroy' ? 'delete' : type === 'noop' ? 'no-op' : type], before, after: type === 'destroy' ? null : { name } } }] };
    if (verifyPlannedChanges && !verifyPlannedChanges(shown)) return Promise.resolve({ ok: false, stage: 'plan review', error: 'The saved engine plan does not match the reviewed change.' });
    shownPlans.set(planId, shown);
    if (type === 'create') effects.push(() => { google.stateServerName = name; });
  }
  enginePlans.set(planId, effects);
  return Promise.resolve({ ok: true, segmentId: segment.id, segment, planFile: '/not-executed', blockers: [], unmanagedDeletes: [], actions });
}

let directory: string | undefined;
let ctx: CommandContext;
const registry = new CommandRegistry();
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
  vi.spyOn(OpenTofuEngine.prototype, 'apply').mockImplementation(async ({ planId, approvedAddresses, verifySavedPlan }) => {
    if (verifySavedPlan && !verifySavedPlan(shownPlans.get(planId))) return { outcomes: Object.fromEntries(approvedAddresses.map((address) => [address, 'not_started' as const])), diagnostics: ['The saved engine plan does not do what was reviewed.'] };
    for (const effect of enginePlans.get(planId) ?? []) effect();
    return { outcomes: Object.fromEntries(approvedAddresses.map((address) => [address, 'succeeded' as const])), diagnostics: [] };
  });
  vi.spyOn(SpecStore.prototype, 'merge').mockReturnValue(undefined as never);
  registerCoreTools(registry, ctx = createCommandContext());
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

const NAME = 'shared-path';
const removal = (more: Record<string, unknown> = {}) => registry.execute('hv_plan', { project: NAME, scope: 'shared-database', intent: 'remove', ...more }) as Promise<{
  ok: boolean; data?: { planId: string; actions: PlanAction[]; confirmActions: string[] }; error?: { message?: string; details?: { blocked?: string[] } } }>;
const blockers = async (work: ReturnType<typeof removal>) => { const result = await work; return result.ok ? 'not blocked' : (result.error?.details?.blocked ?? [result.error?.message]).join(' '); };
const applyPlan = (planId: string, confirmActions: string[]) => registry.execute('hv_apply', { project: NAME, planId, confirmActions }) as Promise<{
  ok: boolean; data?: { applied: boolean; receipts: Array<{ actionId: string; status: string; message?: string }> } }>;
const receipt = (result: Awaited<ReturnType<typeof applyPlan>>, id: string) => result.data!.receipts.find((entry) => entry.actionId === id)!;
const savedPlan = (planId: string) => ctx.repos.runs.findById(planId)!.plan as { actions: PlanAction[]; engine: Record<string, unknown> };
const issues = (document: unknown) => { const checked = planRunDocumentSchema.safeParse(document); return checked.success ? [] : checked.error.issues.map((issue) => issue.message); };

describe.runIf(major >= 15)('removing the app\'s shared database server with hv_plan and hv_apply', () => {
  const both = () => specFor({ production: {}, staging: {} });

  it('starts with two environments on one server', async () => {
    new SpecStore().replace(project, both());
    expect((await apply(await plan(both(), 'production'))).success).toBe(true);
    expect((await apply(await plan(both(), 'staging'))).success).toBe(true);
    expect(google.servers).toHaveLength(1);
    expect(await databases()).toHaveLength(2);
  });

  it('is its own scope and intent, and takes nothing else', async () => {
    for (const input of [{ scope: 'shared-database' }, { intent: 'remove' }, { scope: 'credentials', intent: 'remove' }, { scope: 'shared-database', intent: 'rotate' }]) {
      const result = await registry.execute('hv_plan', { project: NAME, ...input }) as { ok: boolean; error?: { message?: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/scope="shared-database" together with intent="remove"/);
    }
    expect(await blockers(removal({ services: ['web'] }))).toMatch(/takes only project, scope and intent/);
  });

  it('is refused while any environment\'s saved record still has a database on the server, before Google is asked anything', async () => {
    const before = configurations.length;
    expect(await blockers(removal())).toMatch(/^production, staging still have their database on the app's shared database server\. Tear those environments down/);
    expect(configurations).toHaveLength(before);
  });

  it('says nothing about the server when another environment still uses it, and names the removal call when the last one leaves', async () => {
    const first = await apply(await plan(both(), 'staging', true));
    expect(first.success).toBe(true);
    expect(first.receipts.find((entry) => entry.actionId === 'shared-database:release')!.message).not.toMatch(/billed/);
    expect(await blockers(removal())).toMatch(/^production still has its database/);

    const last = await apply(await plan(both(), 'production', true));
    expect(last.success).toBe(true);
    expect(last.receipts.find((entry) => entry.actionId === 'shared-database:release')!.message)
      .toMatch(/No other environment of shared-path is recorded on that server; it is still running and still billed\. To remove it: hv_plan project="shared-path" scope="shared-database" intent="remove"\.$/);
    expect(await databases()).toEqual([]);
    expect(google.servers).toHaveLength(1);
  });

  it('plans the first of two confirmed steps, saved in a form the saved-plan check accepts and nothing looser', async () => {
    const planned = await removal();
    expect(planned.ok).toBe(true);
    expect(planned.data!.actions.map((action) => [action.id, action.type, action.requiresConfirm])).toEqual([['shared-database:unprotect-server', 'update', true]]);
    expect(planned.data!.actions[0]!.reason).toMatch(/changed only if its own list shows no database on it at that moment/);
    expect(planned.data!.confirmActions).toEqual(['shared-database:unprotect-server']);
    const saved = savedPlan(planned.data!.planId);
    expect(issues(saved)).toEqual([]);
    const only = 'A plan to remove the shared database server holds exactly that one step and nothing else.';
    const step = saved.actions[0]!;
    expect(issues({ ...saved, engine: { ...saved.engine, serverRemoval: undefined } })).toContain(only);
    expect(issues({ ...saved, actions: [step, { ...step, id: 'x' }] })).toContain(only);
    expect(issues({ ...saved, actions: [step, { id: 'secret:x', type: 'create', resource: { kind: 'secret', name: 'x', provider: 'gcp' }, verified: true, reason: '', metadata: { operation: 'gcpSecretManagerEnsure' } }] })).toContain(only);
    expect(issues({ ...saved, actions: [] })).toContain(only);
    const shape = 'A shared database step must be shown as what it does.';
    expect(issues({ ...saved, actions: [{ ...step, requiresConfirm: false }] })).toContain(shape);
    // Confirmation is given by id: a delete can never travel under the first step's id, nor any step under another's.
    const mislabelled = { ...step, type: 'destroy', dataBearing: true, metadata: { ...step.metadata, step: 'remove-server' } };
    expect(issues({ ...saved, actions: [mislabelled] })).toContain(shape);
    expect(issues({ ...saved, actions: [{ ...step, id: 'shared-database:remove-server' }] })).toContain(shape);
    const destroy = { ...mislabelled, id: 'shared-database:remove-server' };
    expect(issues({ ...saved, actions: [destroy] })).toEqual([]);
    expect(issues({ ...saved, actions: [{ ...destroy, type: 'update' }] })).toContain(shape);
    expect(issues({ ...saved, actions: [{ ...destroy, dataBearing: false }] })).toContain(shape);
    expect(issues({ ...saved, actions: [{ ...destroy, requiresConfirm: false }] })).toContain(shape);

    // Unconfirmed, nothing happens.
    const held = await applyPlan(planned.data!.planId, []);
    expect(held.data!.applied).toBe(false);
    expect(google.servers[0]!.settings.deletionProtectionEnabled).toBe(true);
  });

  it('is refused when the engine\'s saved state describes a different server than the one Google lists for the app', async () => {
    const tracked = google.stateServerName;
    google.stateServerName = 'hv-some-other-server';
    expect(await blockers(removal())).toMatch(/was not exactly "(unprotect|take-over)" on shared database server .*saved state may describe a different server\. Nothing was planned/);
    google.stateServerName = tracked;
  });

  it('refuses at apply when the saved engine plan no longer does what its step says', async () => {
    const planned = await removal();
    const reviewed = (savedPlan(planned.data!.planId).engine.sharedDatabase as { server: { planId: string } }).server.planId;
    const honest = shownPlans.get(reviewed) as { resource_changes: Array<{ change: { actions: string[]; after: unknown } }> };
    shownPlans.set(reviewed, { ...honest, resource_changes: [{ ...honest.resource_changes[0]!, change: { ...honest.resource_changes[0]!.change, actions: ['delete'], after: null } }] });
    const result = await applyPlan(planned.data!.planId, planned.data!.confirmActions);
    expect(receipt(result, 'shared-database:unprotect-server')).toMatchObject({ status: 'blocked', message: expect.stringMatching(/would not update exactly .*Nothing was changed/) });
    expect(google.servers).toHaveLength(1);
    expect(google.servers[0]!.settings.deletionProtectionEnabled).toBe(true);
  });

  it('refuses at apply when a database appeared on the server after the plan', async () => {
    const planned = await removal();
    await local.boot.query('CREATE DATABASE made_after_the_plan');
    const result = await applyPlan(planned.data!.planId, planned.data!.confirmActions);
    expect(result.data!.applied).toBe(false);
    expect(receipt(result, 'shared-database:unprotect-server')).toMatchObject({ status: 'blocked', message: expect.stringMatching(/still holds a database \(made_after_the_plan\)\. It was not changed/) });
    expect(google.servers[0]!.settings.deletionProtectionEnabled).toBe(true);
    await local.boot.query('DROP DATABASE made_after_the_plan');
  });

  it('refuses at apply when an environment\'s saved record points at the server again', async () => {
    const planned = await removal();
    const staging = environments.staging!.id;
    const kept = ctx.repos.environments.findById(staging)!.platformBindings.engine;
    ctx.repos.environments.updatePlatformBindings(staging, { engine: { kind: 'opentofu', database: { instanceName: google.servers[0]!.name, gcpProjectId: GCP, region: REGION, databaseName: 'app_staging_0123456789ab',
      placement: 'app', tenantId: staging, allocation: 'started' } } });
    const result = await applyPlan(planned.data!.planId, planned.data!.confirmActions);
    expect(receipt(result, 'shared-database:unprotect-server')).toMatchObject({ status: 'blocked', message: expect.stringMatching(/^staging still has its database on the app's shared database server/) });
    expect(google.servers[0]!.settings.deletionProtectionEnabled).toBe(true);
    ctx.repos.environments.updatePlatformBindings(staging, { engine: kept });
  });

  it('turns protection off, then deletes the server, each from its own confirmed plan', async () => {
    const unprotect = await removal();
    const first = await applyPlan(unprotect.data!.planId, unprotect.data!.confirmActions);
    expect(first.data!.applied).toBe(true);
    expect(receipt(first, 'shared-database:unprotect-server').message).toMatch(/Plan its removal again to delete it/);
    expect(google.servers[0]!.settings.deletionProtectionEnabled).toBe(false);

    const remove = await removal();
    expect(remove.data!.actions.map((action) => [action.id, action.type, action.dataBearing, action.requiresConfirm])).toEqual([['shared-database:remove-server', 'destroy', true, true]]);
    expect(issues(savedPlan(remove.data!.planId))).toEqual([]);
    expect((await applyPlan(remove.data!.planId, [])).data!.applied).toBe(false);
    expect(google.servers).toHaveLength(1);
    const again = await removal();
    const second = await applyPlan(again.data!.planId, again.data!.confirmActions);
    expect(second.data!.applied).toBe(true);
    expect(google.servers).toEqual([]);
    expect(await blockers(removal())).toMatch(/has no shared database server in demo-project \(us-central1\)\. There is nothing to remove/);
  });
});
