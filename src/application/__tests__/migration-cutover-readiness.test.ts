import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { createCommandContext } from '../context.js';
import * as commands from '../commands.js';
import * as engine from '../infrastructure-engine.js';
import * as launch from '../launch.js';
import { migrateEnvironment } from '../migrate.js';
import * as backupEvidence from '../migration-database-backups.js';
import * as bucketEvidence from '../cloud-bucket-backups.js';
import { selectMigrationBuckets } from '../migration-storage.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-cutover-readiness-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

const domain = 'app.example.com';
const desiredRoute = { domainTarget: { environment: 'gcp', service: 'web' },
  maintenance: { enabled: true, mode: 'application', page: 'off' } };
const web = { web: { workloadKind: 'web', public: true } };
const promotion = { strategy: 'branch', trigger: 'ci', promoteFrom: 'staging', autoDeploy: false };
const protectedSource = { backups: { mode: 'daily' }, deploy: promotion };

function fixture(sourceSettings = {}, targetSettings = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'cutover-readiness', defaultPlatform: 'railway' });
  ctx.repos.environments.create({ projectId: project.id, name: 'production' });
  const target = ctx.repos.environments.create({ projectId: project.id, name: 'gcp', platformBindings: { engine: {
    kind: 'opentofu', importedSecrets: [], migration: { from: 'production', copiedAt: '2026-11-01T00:00:00.000Z', storage: [],
      ...('database' in sourceSettings ? { database: { tables: 1, rows: '1', match: true, differences: [], restoreWarnings: 0 } } : {}) },
  } } });
  const store = new SpecStore();
  store.replace(project, { version: 1, project: project.name, gitRemoteUrl: 'https://github.com/example/fixture.git', environments: {
    staging: { hosting: { provider: 'railway' }, services: web, deploy: { strategy: 'branch', trigger: 'ci' } },
    production: { hosting: { provider: 'railway' }, services: web, domain, ...sourceSettings },
    gcp: { hosting: { provider: 'cloudrun' }, services: web, ...targetSettings },
  } });
  vi.spyOn(launch, 'launchEnvironment').mockImplementation(async (_ctx, params) => params.stopAfter
    ? { status: 'ready', stage: params.stopAfter } as never : { status: 'live', urls: {} } as never);
  vi.spyOn(engine, 'resolveEngineContext').mockResolvedValue({ environment: target, gcpProjectId: 'fixture' } as never);
  const plan = vi.spyOn(PlanService.prototype, 'plan').mockResolvedValue({ actions: [], blocked: [] } as never);
  const actions = (...actions: Partial<PlanAction>[]) => plan.mockResolvedValue({ actions, blocked: [] } as never);
  const apply = vi.fn();
  vi.spyOn(commands, 'createCommandRegistry').mockReturnValue({ get: (name: string) => ({
    execute: name === 'hv_apply' ? apply : vi.fn(async () => ({ ok: true, data: { planId: 'fixture', actions: [] } })),
  }) } as never);
  return { ctx, project, target, plan, apply, actions, spec: () => store.get(project)!.spec, migrate: (options = {}) =>
    migrateEnvironment(ctx, { project, from: 'production', to: 'gcp', ...options }) };
}

const domainProof: Partial<PlanAction> = { id: 'domain:' + domain, type: 'noop', verified: true,
  resource: { kind: 'domain', name: domain, provider: 'railway' } };
const routeProof: Partial<PlanAction> = { id: 'maintenance:production:traffic', type: 'noop', verified: true,
  resource: { kind: 'maintenance', name: domain, provider: 'cloudflare' },
  metadata: { hostname: domain, targetEnvironment: 'gcp', targetService: 'web', operation: 'maintenanceEdgeRoute' } };

const dailyDatabase = { backups: { mode: 'daily' }, database: { provider: 'railway' } };
const nativeDatabase = { database: { provider: 'cloudsql', automatedBackups: true } };

it('describes the narrower protection in the review when the destination database has backups enabled', async () => {
  const f = fixture({ ...dailyDatabase, storage: { archive: {
    provider: 'railway', type: 'bucket', purpose: 'backup', region: 'sjc', injectInto: [],
  } } }, { database: { provider: 'cloudsql' } });
  const observed = vi.spyOn(backupEvidence, 'observeMigrationDatabaseBackups').mockResolvedValue(true);
  f.actions(domainProof);
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'blocked', message: expect.stringContaining('database.automatedBackups') });
  expect(observed).not.toHaveBeenCalled();
  new SpecStore().merge(f.project, { environments: { gcp: { database: { automatedBackups: true } } } });
  const result = await f.migrate({ cutover: true });
  expect(result).toMatchObject({ status: 'needs_cutover_approval', steps: expect.arrayContaining([
    expect.stringMatching(/Google Cloud.*PostgreSQL.*independent.*restore tests/i),
  ]) });
  expect(observed).toHaveBeenCalledWith(f.project, expect.objectContaining({ id: f.target.id }), f.spec().environments.gcp);
  expect(f.apply).not.toHaveBeenCalled();
});

it.each([{}, { maintenance: { enabled: true, mode: 'application', page: 'active' } }, desiredRoute])(
  'requires fresh backup evidence before pausing or resuming traffic %#', async stage => {
    const f = fixture({ ...dailyDatabase, ...stage }, nativeDatabase);
    vi.spyOn(backupEvidence, 'observeMigrationDatabaseBackups').mockResolvedValue(false);
    f.actions(domainProof, { ...routeProof, type: 'update' });
    const before = f.spec();
    expect(await f.migrate({ cutover: true, confirmCutover: true })).toMatchObject({
      status: 'blocked', message: expect.stringMatching(/could not confirm.*automated backups/i) });
    expect(f.spec()).toEqual(before);
    expect(f.apply).not.toHaveBeenCalled();
  });

it('preserves the staging gate when cloud backups are confirmed', async () => {
  const f = fixture({ ...dailyDatabase, deploy: promotion }, nativeDatabase);
  vi.spyOn(backupEvidence, 'observeMigrationDatabaseBackups').mockResolvedValue(true);
  f.actions(domainProof);
  const result = await f.migrate({ cutover: true, confirmCutover: true });
  expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/promotion.*staging/i) });
  expect(result).not.toMatchObject({ message: expect.stringMatching(/backup/i) });
  expect(f.apply).not.toHaveBeenCalled();
});

it('does not substitute an unrelated database for source file protection', async () => {
  const f = fixture({ backups: { mode: 'daily' } }, nativeDatabase);
  vi.spyOn(backupEvidence, 'observeMigrationDatabaseBackups').mockResolvedValue(true);
  f.actions(domainProof);
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'blocked', message: expect.stringMatching(/daily backup/i) });
});

it.each(['copied', 'retained'])('preserves the independent backup requirement for a %s document bucket', async state => {
  const copied = state === 'copied';
  const storage = (provider: string) => ({ documents: { provider, type: 'bucket', region: provider === 'railway' ? 'sjc' : 'us-central1', injectInto: [] } });
  const f = fixture({ ...dailyDatabase, ...(copied ? { storage: storage('railway') } : {}) },
    { ...nativeDatabase, ...(copied ? { storage: storage('gcs') } : {}) });
  const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'production')!;
  const boundSource = f.ctx.repos.environments.updatePlatformBindings(source.id, { storage: {
    documents: { provider: 'railway', externalId: 'documents-id', instanceScope: { projectId: 'railway-project' } },
  } })!;
  if (copied) {
    const spec = f.spec().environments;
    const { buckets } = selectMigrationBuckets(spec.production!, spec.gcp!, boundSource, 'fixture', 'gcp');
    const binding = f.target.platformBindings.engine as engine.EngineBinding;
    f.ctx.repos.environments.updatePlatformBindings(f.target.id, { engine: { ...binding, storage: ['documents'],
      migration: { ...binding.migration, storage: [{ name: 'documents', files: 1, bytes: 10, match: true, downloadVerifiedFor: buckets![0]!.identity }] } } });
  }
  vi.spyOn(backupEvidence, 'observeMigrationDatabaseBackups').mockResolvedValue(true);
  f.actions(domainProof);
  const before = f.spec();
  for (const confirmCutover of [false, true]) {
    expect(await f.migrate({ cutover: true, confirmCutover })).toMatchObject({ status: 'blocked',
      message: expect.stringMatching(/backup.*bucket documents/i) });
  }
  expect(f.spec()).toEqual(before);
  expect(f.apply).not.toHaveBeenCalled();
});

it('keeps covered service volumes and retained databases in the cutover review', async () => {
  const f = fixture({ ...dailyDatabase, services: { web: { ...web.web, volume: { mountPath: '/uploads' } } } }, nativeDatabase);
  const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'production')!;
  f.ctx.repos.environments.updatePlatformBindings(source.id, { previousDatabase: {
    provider: 'railway', externalId: 'old-id', engine: 'postgres', name: 'previous', providerScope: { projectId: 'railway-project' },
  } });
  vi.spyOn(backupEvidence, 'observeMigrationDatabaseBackups').mockResolvedValue(true);
  f.actions(domainProof);
  const review = await f.migrate({ cutover: true });
  expect(review).toMatchObject({ status: 'blocked', message: expect.stringContaining('volume web') });
  expect(review).toMatchObject({ message: expect.stringContaining('retained database') });
});

it.each([true, false])('accepts a daily bucket copy in the cutover review, with a database: %s', async database => {
  const storage = (provider: string) => ({ documents: { provider, type: 'bucket',
    region: provider === 'railway' ? 'sjc' : 'us-central1', injectInto: [], ...(provider === 'gcs' && { automatedBackups: true }) } });
  const f = fixture({ backups: { mode: 'daily' }, ...(database ? dailyDatabase : {}), storage: storage('railway') },
    { ...(database ? nativeDatabase : {}), storage: storage('gcs') });
  const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'production')!;
  const boundSource = f.ctx.repos.environments.updatePlatformBindings(source.id, { storage: {
    documents: { provider: 'railway', externalId: 'documents-id', instanceScope: { projectId: 'railway-project' } },
  } })!;
  const spec = f.spec().environments;
  const { buckets } = selectMigrationBuckets(spec.production!, spec.gcp!, boundSource, 'fixture', 'gcp');
  const binding = f.target.platformBindings.engine as engine.EngineBinding;
  f.ctx.repos.environments.updatePlatformBindings(f.target.id, { engine: { ...binding, storage: ['documents'],
    migration: { ...binding.migration, storage: [{ name: 'documents', files: 1, bytes: 10, match: true, downloadVerifiedFor: buckets![0]!.identity }] } } });
  vi.spyOn(backupEvidence, 'observeMigrationDatabaseBackups').mockResolvedValue(database);
  const read = vi.spyOn(bucketEvidence, 'observeCloudBucketBackup').mockResolvedValue(undefined);
  f.actions(domainProof);
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'blocked', message: expect.stringMatching(/bucket documents/i) });
  read.mockResolvedValue({ source: 'documents-identity', archive: 'archive-identity', latestAt: '2026-10-31T23:59:59.000Z' });
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'blocked', message: expect.stringMatching(/bucket documents/i) });
  read.mockResolvedValue({ source: 'documents-identity', archive: 'archive-identity', latestAt: new Date().toISOString() });
  const review = await f.migrate({ cutover: true });
  expect(review).toMatchObject({ status: 'needs_cutover_approval', steps: expect.arrayContaining([expect.stringMatching(/documents.*daily|daily.*documents/i)]) });
  expect(read).toHaveBeenCalledWith(f.project, expect.objectContaining({ id: f.target.id }), spec.gcp, 'documents');
  read.mockResolvedValue({ source: 'documents-identity', archive: 'new-archive-identity', latestAt: new Date().toISOString() });
  expect((await f.migrate({ cutover: true }) as { backupReviewId?: string }).backupReviewId).not.toBe((review as { backupReviewId?: string }).backupReviewId);
  expect(f.apply).not.toHaveBeenCalled();
});

it.each([{}, { maintenance: { enabled: true, mode: 'application', page: 'active' } }, desiredRoute])(
  'keeps daily recovery and staging promotion checks ahead of new or resumed cutover %#', async (stage) => {
    const f = fixture({ ...protectedSource, ...stage });
    f.actions(domainProof, { ...routeProof, type: 'update' });
    const before = f.spec();
    const result = await f.migrate({ cutover: true, confirmCutover: true });
    expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/daily backup/i) });
    expect(result).toMatchObject({ message: expect.stringMatching(/promot.*staging/i) });
    expect(f.spec()).toEqual(before);
    expect(f.apply).not.toHaveBeenCalled();
  });

it('recognizes verified existing target traffic and reports missing protection without operations', async () => {
  const f = fixture({ ...protectedSource, ...desiredRoute });
  f.actions(routeProof);
  const before = f.spec();
  const result = await f.migrate({ cutover: true, confirmCutover: true });
  expect(result).toMatchObject({ status: 'cut_over', message: expect.stringMatching(/already.*gcp/i) });
  expect(result).toMatchObject({ message: expect.stringMatching(/daily backup/i) });
  expect(result).toMatchObject({ message: expect.stringMatching(/target writes|writes accepted/i) });
  expect(f.spec()).toEqual(before);
  expect(f.apply).not.toHaveBeenCalled();
});

it('uses the verified domain from the full source plan and rejects unverified attachment', async () => {
  const f = fixture();
  f.actions({ ...domainProof, verified: false });
  const before = f.spec();
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'blocked', message: expect.stringContaining(domain) });
  expect(f.spec()).toEqual(before);
  f.actions(domainProof);
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'needs_cutover_approval', domain });
});

it('allows a temporary target rehearsal while production protections are pending', async () => {
  const f = fixture(protectedSource);
  expect(await f.migrate()).toMatchObject({ status: 'migrated', target: 'gcp' });
  expect(PlanService.prototype.plan).not.toHaveBeenCalled();
});

it('rejects unsupported guarantees even if the target copies both policy declarations', async () => {
  const f = fixture(protectedSource, protectedSource);
  const result = await f.migrate({ cutover: true });
  expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/engine.*daily backups/i) });
  expect(result).toMatchObject({ message: expect.stringMatching(/engine.*promotion.*staging/i) });
});

it.each([{ domain: undefined }, { domain: 'https://app.example.com/other' }, { domainProxy: false }])(
  'requires an existing usable cutover hostname before taking the source offline %#', async settings => {
    const f = fixture(settings);
    f.actions(domainProof);
    const before = f.spec();
    expect(await f.migrate({ cutover: true, confirmCutover: true })).toMatchObject({ status: 'blocked', message: expect.stringMatching(/domain|hostname/i) });
    expect(f.spec()).toEqual(before);
    expect(f.apply).not.toHaveBeenCalled();
  });

it('never resumes a pending traffic move using a pre-pause copy', async () => {
  const f = fixture(desiredRoute);
  f.actions(domainProof, { ...routeProof, type: 'update' });
  const before = f.spec();
  expect(await f.migrate({ cutover: true, confirmCutover: true })).toMatchObject({
    status: 'blocked', message: expect.stringMatching(/final copy.*pause|paused.*final copy/i),
  });
  expect(f.spec()).toEqual(before);
  expect(f.apply).not.toHaveBeenCalled();
});

it('records a final-copy receipt through the normal stateless cutover and preserves a healthy resume', async () => {
  const f = fixture();
  const source = f.ctx.repos.environments.findByProjectAndName(f.project.id, 'production')!;
  const pausedAt = '2026-11-01T00:01:00.000Z';
  const binding = { state: 'active', mode: 'application', updatedAt: pausedAt,
    edge: { hostname: domain, accountId: 'account', zoneId: 'zone', routeId: 'route', scriptName: 'maintenance-page', contentHash: 'page-hash' },
    workloads: { web: { serviceId: 'web-id', workloadKind: 'web' } } };
  const pausedActions = [
    { id: 'maintenance:production:edge', type: 'noop', verified: true, resource: { kind: 'maintenance', name: domain },
      metadata: { operation: 'maintenanceEdgeEnable', hostname: domain } },
    { id: 'maintenance:production:workload:web', type: 'noop', verified: true, resource: { kind: 'maintenance', name: 'web' },
      metadata: { operation: 'maintenanceWorkloadSuspend', serviceId: 'web-id', workloadKind: 'web' } },
  ];
  let forwarded = false;
  f.plan.mockImplementation(async () => {
    const sourceSpec = f.spec().environments.production!;
    return { actions: !sourceSpec.maintenance ? [domainProof] :
      [...pausedActions, ...(sourceSpec.domainTarget ? [{ ...routeProof, type: forwarded ? 'noop' : 'update' }] : [])], blocked: [] } as never;
  });
  const observedSource = vi.fn(async () => {
    if (f.spec().environments.production!.domainTarget) forwarded = true;
    f.ctx.repos.environments.updatePlatformBindings(source.id, { maintenance: binding });
    return { ok: true, data: { planId: 'verified-pause', actions: [] } };
  });
  vi.mocked(commands.createCommandRegistry).mockReturnValue({ get: () => ({ execute: observedSource }) } as never);
  expect(await f.migrate({ cutover: true, confirmCutover: true })).toMatchObject({ status: 'cut_over' });
  const migration = (f.ctx.repos.environments.findById(f.target.id)!.platformBindings.engine as engine.EngineBinding).migration!;
  expect(migration.finalCopy).toMatchObject({ sourceEnvironmentId: source.id, targetEnvironmentId: f.target.id,
    domain, targetService: 'web', copyAttemptId: migration.copyAttempt!.id, copiedAt: migration.copiedAt });
  forwarded = false;
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'cut_over' });
  forwarded = false;
  f.ctx.repos.environments.updatePlatformBindings(source.id, { maintenance: { ...binding, updatedAt: '2026-11-02T00:00:00.000Z' } });
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'blocked', message: expect.stringMatching(/current source pause/) });
});

it.each(['missing', 'incomplete'] as const)('protects a live target when historical copy evidence is %s', async history => {
  const f = fixture({ ...protectedSource, ...desiredRoute });
  const migration = history === 'missing' ? { from: 'production' } : {
    from: 'production', copyAttempt: { id: 'prior', startedAt: '2026-11-01T00:00:00Z', status: 'incomplete' },
  };
  f.ctx.repos.environments.updatePlatformBindings(f.target.id, { engine: { kind: 'opentofu', importedSecrets: [], migration } });
  f.actions(routeProof);
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'cut_over', message: expect.stringMatching(/already.*gcp/i) });
  for (const options of [{}, { refreshData: true }, { refreshData: true, copyData: true }]) {
    const result = await f.migrate(options);
    expect(result).toMatchObject({ status: 'blocked', message: expect.stringMatching(/target writes|writes accepted/i) });
    expect(result).not.toMatchObject({ message: expect.stringMatching(/refreshData=true/i) });
  }
  f.actions({ ...routeProof, verified: false });
  expect(await f.migrate({ cutover: true })).toMatchObject({ status: 'blocked', message: expect.stringMatching(/route|traffic/i) });
  expect(launch.launchEnvironment).not.toHaveBeenCalled();
  expect(f.apply).not.toHaveBeenCalled();
});
