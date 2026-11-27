import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { environmentSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { migrationCutoverReadiness } from '../migration-cutover-readiness.js';
import { observeMigrationDatabaseBackups } from '../migration-database-backups.js';

const projectId = 'backup-target';
const region = 'us-central1';
const instanceName = 'hv-green-db-fb34ab';
const instancePath = `/v1/projects/${projectId}/instances/${instanceName}`;
const databasePath = instancePath + '/databases/app';
const instanceFor = (environmentId: string) => ({
  project: projectId, name: instanceName, region, connectionName: `${projectId}:${region}:${instanceName}`,
  state: 'RUNNABLE', instanceType: 'CLOUD_SQL_INSTANCE', databaseVersion: 'POSTGRES_16',
  settings: {
    userLabels: { 'managed-by': 'hypervibe', 'hv-environment': environmentId.toLowerCase() },
    backupConfiguration: { enabled: true, backupTier: 'STANDARD' },
  },
});
const database = { project: projectId, instance: instanceName, name: 'app' };
const repository = 'example/backup-check';
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });

let f: ReturnType<typeof fixture>;
beforeAll(() => {
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(':memory:').migrate();
  f = fixture();
});
afterAll(() => SqliteAdapter.resetInstance());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function connect(ctx: ReturnType<typeof createCommandContext>, scope: string, keyProject = projectId) {
  const credentials = JSON.stringify({ type: 'service_account', project_id: keyProject,
    client_email: `deployer@${keyProject}.iam.gserviceaccount.com`, private_key: privateKey });
  const connection = ctx.repos.connections.upsert({ provider: 'cloudrun', scope, credentialsEncrypted: ctx.secretStore.encryptObject({ projectId, credentials }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
}

function fixture() {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'app', gitRemoteUrl: `https://github.com/${repository}.git` });
  const destination = ctx.repos.environments.create({ projectId: project.id, name: 'green', platformBindings: {
    provider: 'cloudrun', projectId, environmentId: region, region, engine: { kind: 'opentofu', database: { instanceName } },
  } });
  connect(ctx, `${repository}#gcp:${projectId}`);
  connect(ctx, repository);
  const target = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun', region, gcpProjectId: projectId },
    services: { web: { public: true } }, database: { provider: 'cloudsql' } });
  return { ctx, project, destination, target, instance: instanceFor(destination.id) };
}

// Reconstructed Cloud SQL v1 responses. The destination uses the real connection, token exchange and HTTP client.
// https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances/get
// https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances#BackupConfiguration
// https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases/get
// https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases#Database
// https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options
function transport(instanceResponse = Response.json(f.instance), databaseResponse = Response.json(database)) {
  const observed: Array<{ path: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const request = new Request(url, init);
    const { origin, pathname } = new URL(request.url);
    if (origin === 'https://oauth2.googleapis.com' && pathname === '/token' && request.method === 'POST') {
      return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    }
    observed.push({ path: pathname, method: request.method });
    if (origin === 'https://sqladmin.googleapis.com' && request.method === 'GET'
      && request.headers.get('Authorization') === 'Bearer fixture-token') {
      if (pathname === instancePath) return instanceResponse;
      if (pathname === databasePath) return databaseResponse;
    }
    throw new Error('Unexpected provider request');
  }));
  return observed;
}

it.each(['selected project', 'repository default'])('reads the owned instance and logical database using the %s connection', async scope => {
  const observed = transport();
  const target = scope === 'selected project' ? f.target : { ...f.target, hosting: { provider: 'cloudrun' } };
  expect(await observeMigrationDatabaseBackups(f.project, f.destination, target)).toBe(true);
  expect(observed).toEqual([{ path: instancePath, method: 'GET' }, { path: databasePath, method: 'GET' }]);
  expect(fetch).toHaveBeenCalledTimes(3); // token exchange, instance, database
});

it('recognizes the owned daily standard configuration at cutover and checks again when it changes', async () => {
  const { project, destination, target, instance } = f;
  const optedInTarget = environmentSpecSchema.parse({ ...target, database: { ...target.database, automatedBackups: true } });
  const source = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, domain: 'app.example.com', services: { web: { public: true } },
    database: { provider: 'railway' }, backups: { mode: 'daily' } });
  const production = { ...destination, id: 'source-id', name: 'production', platformBindings: {} };
  vi.spyOn(PlanService.prototype, 'plan').mockResolvedValue({ error: 'Fixture has no Railway route.' });
  const check = () => migrationCutoverReadiness(project, production, source, destination, optedInTarget, 'web');
  const enabledReads = transport();
  expect((await check()).problems.filter(problem => /backup/i.test(problem))).toEqual([]);
  expect(enabledReads.map(request => request.path)).toEqual([instancePath, databasePath]);
  transport(Response.json({ ...instance, settings: { ...instance.settings, backupConfiguration: { enabled: false, backupTier: 'STANDARD' } } }));
  expect((await check()).problems.some(problem => /backup/i.test(problem))).toBe(true);
});

it.each([
  ['disabled', { enabled: false, backupTier: 'STANDARD', pointInTimeRecoveryEnabled: true }],
  ['omitted enabled', { backupTier: 'STANDARD', startTime: '05:00' }],
  ['malformed enabled', { enabled: 'true', backupTier: 'STANDARD' }],
  ['unreported tier', { enabled: true }],
  ['unspecified tier', { enabled: true, backupTier: 'BACKUP_TIER_UNSPECIFIED' }],
  ['enhanced backup plan', { enabled: true, backupTier: 'ENHANCED' }],
  ['deprecated enhanced tier', { enabled: true, backupTier: 'ADVANCED' }],
  ['unknown future tier', { enabled: true, backupTier: 'SOMETHING_NEW' }],
] as const)('declines %s even with a matching instance and backup intent', async (_label, backupConfiguration) => {
  const observed = transport(Response.json({ ...f.instance, settings: { ...f.instance.settings, backupConfiguration } }));
  expect(await observeMigrationDatabaseBackups(f.project, f.destination, { ...f.target, backups: { mode: 'daily' } })).toBe(false);
  expect(observed).toEqual([{ path: instancePath, method: 'GET' }]);
});

it.each([
  ['wrong project', { project: 'other-project' }], ['wrong region', { region: 'us-east1' }], ['wrong instance', { name: 'other-db' }],
  ['wrong connection name', { connectionName: 'other-project:us-central1:other-db' }],
  ['replica', { instanceType: 'READ_REPLICA_INSTANCE' }], ['non-PostgreSQL server', { databaseVersion: 'MYSQL_8_0' }],
  ['unavailable server', { state: 'SUSPENDED' }],
] as const)('declines a protected instance reporting %s', async (_label, change) => {
  const observed = transport(Response.json({ ...f.instance, ...change }));
  expect(await observeMigrationDatabaseBackups(f.project, f.destination, f.target)).toBe(false);
  expect(observed).toEqual([{ path: instancePath, method: 'GET' }]);
});

it.each([{}, { 'managed-by': 'hypervibe' }, { 'managed-by': 'hypervibe', 'hv-environment': 'another-environment' }])(
  'requires Hypervibe and exact environment ownership %#', async userLabels => {
    transport(Response.json({ ...f.instance, settings: { ...f.instance.settings, userLabels } }));
    expect(await observeMigrationDatabaseBackups(f.project, f.destination, f.target)).toBe(false);
  });

it('refuses a shared server even when it also carries the destination environment label', async () => {
  const settings = f.instance.settings;
  const observed = transport(Response.json({ ...f.instance, settings: { ...settings,
    userLabels: { ...settings.userLabels, 'hv-shared-database': 'true' } } }));
  expect(await observeMigrationDatabaseBackups(f.project, f.destination, f.target)).toBe(false);
  expect(observed).toEqual([{ path: instancePath, method: 'GET' }]);
});

it.each([
  ['missing', () => new Response(null, { status: 404 })], ['unreadable', () => new Response('private details', { status: 403 })],
  ['malformed', () => new Response('private details')], ['incomplete', () => Response.json({ name: 'app' })],
  ['another database', () => Response.json({ ...database, name: 'postgres' })],
  ['another instance', () => Response.json({ ...database, instance: 'other-db' })],
  ['another project', () => Response.json({ ...database, project: 'other-project' })],
] as const)('declines an enabled server whose logical database is %s', async (_label, response) => {
  const observed = transport(Response.json(f.instance), response());
  expect(await observeMigrationDatabaseBackups(f.project, f.destination, f.target)).toBe(false);
  expect(observed.map(request => request.path)).toEqual([instancePath, databasePath]);
});

it('requires the accepted destination project, provider, placement, region and unambiguous native binding before access', async () => {
  transport();
  const { project, destination, target } = f;
  const check = (binding: Record<string, unknown>) => observeMigrationDatabaseBackups(project,
    { ...destination, platformBindings: { ...destination.platformBindings, ...binding } }, target);
  expect(await observeMigrationDatabaseBackups({ ...project, id: 'other-project-id' }, destination, target)).toBe(false);
  for (const binding of [
    { provider: 'railway' }, { projectId: 'other-project' }, { environmentId: 'us-east1' }, { region: 'us-east1' },
    { engine: { database: { instanceName } } }, { engine: { kind: 'opentofu' } },
  ]) expect(await check(binding)).toBe(false);
  for (const saved of [
    { instanceName: '../other-db' }, { placement: 'app' }, { connectionName: `${projectId}:us-east1:${instanceName}` },
    { databaseName: 'other' }, { gcpProjectId: 'other-project' }, { databaseName: 17 },
  ]) expect(await check({ engine: { kind: 'opentofu', database: { instanceName, ...saved } } })).toBe(false);
  expect(await observeMigrationDatabaseBackups(project, destination, { ...target, database: undefined })).toBe(false);
  expect(await observeMigrationDatabaseBackups(project, destination,
    { ...target, database: { ...target.database!, placement: 'app' } })).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps unavailable connection and HTTP error details private', async () => {
  const { project, destination, target } = f;
  transport();
  expect(await observeMigrationDatabaseBackups({ ...project, gitRemoteUrl: 'https://github.com/other/app.git' }, destination, target)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  const observed = transport(new Response('credential-shaped private text', { status: 403 }));
  expect(await observeMigrationDatabaseBackups(project, destination, target)).toBe(false);
  expect(observed).toEqual([{ path: instancePath, method: 'GET' }]);
});

it('keeps explicitly selected Google projects separate from the repository default and rejects a misbound deployment key', async () => {
  transport();
  const otherRepo = 'example/other-app';
  const project = { ...f.project, gitRemoteUrl: `https://github.com/${otherRepo}.git` };
  connect(f.ctx, otherRepo);
  expect(await observeMigrationDatabaseBackups(project, f.destination, f.target)).toBe(false);
  connect(f.ctx, otherRepo, 'different-google-project');
  const defaultTarget = { ...f.target, hosting: { provider: 'cloudrun', region } };
  expect(await observeMigrationDatabaseBackups(project, f.destination, defaultTarget)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
