import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { AdapterFactory } from '../../domain/services/adapter.factory.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { executePlanApply } from '../apply-plan.js';
import { applyDatabaseScopeBinding } from '../apply-database-scope-binding.js';
import { planDatabaseScopeBinding } from '../../domain/services/database-scope-binding.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { resolvePlanActionAuthority } from '../../domain/plan/action-authority.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { CloudSqlAdapter } from '../../adapters/providers/gcp/cloudsql.adapter.js';
import { projectRecoveryDatabases } from '../../domain/services/recovery-database-bindings.js';
import { createUnresolvedDatabaseMutation } from '../../domain/ports/database.port.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { diffEnvironment } from '../../domain/plan/diff.engine.js';
import { createRailwayDatabaseAdapter } from '../../adapters/providers/railway/railway-database.factory.js';
import { railwayHttpFixture, projectId, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';

// Real SQLite and graphql-request against the pinned official Railway SDL.
// Synthetic scope/volume state, not a recording or live provider certification.
describe('reviewed legacy database scope binding', () => {
  let directory: string;
  let ctx: CommandContext;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-database-scope-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
    ctx = createCommandContext();
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
  });

  async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
    const http = await railwayHttpFixture(options);
    const nativeService = http.addService('staging-postgres', 'postgres', stagingId);
    Object.assign(nativeService.instances.get(stagingId)!, { source: { image: 'ghcr.io/railwayapp-templates/postgres-ssl:16' },
      latestDeployment: { id: 'database-deployment', status: 'SUCCESS', createdAt: '2026-10-01T00:00:00Z' } });
    const volume = http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    http.backupSchedules.set(String(volume.instance.id), [{ id: 'daily', kind: 'DAILY', name: 'Daily',
      cron: '0 0 * * *', retentionSeconds: 6 * 86400, createdAt: '2026-10-01T00:00:00Z' }]);
    const project = ctx.repos.projects.create({ name: 'legacy-scope', defaultPlatform: 'railway' });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
      environments: { staging: { hosting: { provider: 'railway' }, services: { web: {} },
        database: { provider: 'railway' }, email: { enabled: false }, envVars: {} } } });
    const stored = new SpecStore().replace(project, spec);
    const checkpoints = { preserved: { source: { provider: 'railway', primaryExternalId: 'staging-postgres',
      providerScope: { projectId, environmentId: stagingId }, resourceIdentity: { volumeId: volume.id, volumeInstanceId: String(volume.instance.id) } },
      label: 'historical-checkpoint', beforeBackupIds: [], beforeBackupExternalIds: [], requestStartedAt: '2026-10-01T00:00:00Z',
      state: 'unknown', acknowledged: true, operationId: 'preserved-operation' } };
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'railway', projectId, environmentId: stagingId, appliedSpecHash: 'unchanged-release',
      databaseCheckpoints: checkpoints,
    } });
    const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'staging-postgres',
      bindings: { provider: 'railway', resourceKind: 'service', projectId, environmentId: stagingId,
        connectionUrl: 'postgres://synthetic:private@database.internal/app',
        resilience: { checkpoints } } });
    const service = ctx.repos.services.create({ projectId: project.id, name: 'web',
      buildConfig: { startCommand: 'npm start' }, envVarSpec: { required: ['PRESERVED'] } });
    const database = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter, envRepo: ctx.repos.environments });
    vi.spyOn(AdapterFactory.prototype, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: http.adapter });
    vi.spyOn(AdapterFactory.prototype, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: database });
    vi.spyOn(AdapterFactory.prototype, 'getStorageAdapter').mockResolvedValue({ success: false, error: 'Unrelated archive is not configured' });
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    const planner = new PlanService();
    const plan = () => planner.plan(project, 'staging', { includeEnvFile: false });
    const context = () => ({ project, spec: spec.environments.staging,
      environment: ctx.repos.environments.findById(environment.id)!,
      components: ctx.repos.components.findByEnvironmentId(environment.id), adapterFactory: ctx.adapterFactory });
    return { http, volume, project, spec, stored, environment, component, service, database, plan, context };
  }

  it('plans a local-only scope repair and preserves accepted project state through apply', async () => {
    const f = await fixture();
    const result = await f.plan();
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('database-bindings');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ type: 'update', requiresConfirm: true,
      resource: { kind: 'database', provider: 'railway', name: 'postgres' },
      metadata: { operation: 'databaseScopeBind', componentId: f.component.id, source: {
        provider: 'railway', primaryExternalId: f.component.externalId, providerScope: { projectId, environmentId: stagingId },
        resourceIdentity: { volumeId: f.volume.id, volumeInstanceId: f.volume.instance.id },
      } } });
    expect(JSON.stringify(result)).not.toContain('synthetic:private');
    expect(ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: result.specRevision,
      planId: result.planRunId, confirmActions: [result.actions[0].id], alwaysRunBootstrap: true }))
      .toMatchObject({ kind: 'executed', result: { success: true, receipts: [
        { data: { applied: 1, skipped: 0, providerMutations: 0 } },
      ] } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings).toEqual({ ...f.component.bindings,
      providerScope: { projectId, environmentId: stagingId } });
    // The verified identity is also committed for hosted inspection; nothing else in the environment changes.
    const { databaseTopology, ...unchangedBindings } = ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    expect(databaseTopology).toEqual({ primary: { provider: 'railway', externalId: f.component.externalId }, replicas: {} });
    expect(unchangedBindings).toEqual(f.environment.platformBindings);
    expect(ctx.repos.services.findById(f.service.id)).toEqual(f.service);
    expect(new SpecStore().get(f.project)?.revision).toBe(result.specRevision);
    expect(new SpecStore().get(f.project)?.spec).toEqual(f.spec);
    expect(projectRecoveryDatabases(ctx.repos.components.findByEnvironmentId(f.environment.id), f.environment.id))
      .toEqual(projectRecoveryDatabases([f.component], f.environment.id));
    const current = f.context();
    const observation = await new PlanService().observeEnvironment(f.project, current.environment, current.spec);
    const next = diffEnvironment({ spec: current.spec, envName: 'staging', observed: observation.observed,
      local: { projectExists: true, environmentExists: true, components: current.components,
        services: [f.service], bindings: current.environment.platformBindings } });
    expect(next.actions.find(action => action.resource.kind === 'database')).toMatchObject({ type: 'noop' });
    expect(f.http.mutations).toEqual([]);
    expect(f.http.contractErrors).toEqual([]);
  });

  async function reviewed(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('database-bindings');
    const action = result.actions[0];
    const apply = () => applyDatabaseScopeBinding({ ctx, project: f.project, environmentName: 'staging',
      environmentSpec: f.spec.environments.staging, action, confirmedActionIds: new Set([action.id]) });
    return { result, action, apply };
  }

  it.each(['instance', 'volume', 'component', 'scope'] as const)('rejects changed %s identity after review', async change => {
    const f = await fixture(); const r = await reviewed(f);
    if (change === 'instance') f.volume.instance.id = 'replacement-instance';
    if (change === 'volume') { f.http.volumes.delete(f.volume.id); f.http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data'); }
    if (change === 'component') ctx.repos.components.update(f.component.id, { externalId: 'different-service' });
    if (change === 'scope') ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId, environmentId: 'different-environment' } });
    const before = ctx.repos.components.findById(f.component.id);
    expect(await r.apply()).toMatchObject({ success: false, status: 'blocked', data: { applied: 0, providerMutations: 0 } });
    expect(ctx.repos.components.findById(f.component.id)).toEqual(before);
    expect(f.http.mutations).toEqual([]);
  });

  it('rechecks environment scope after the native read and preserves a concurrent credential update', async () => {
    let changeEnvironment = false;
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ responseOverride: ({ query }) => {
      if (changeEnvironment && query.includes('DailyBackupScheduleList')) {
        ctx.repos.environments.updatePlatformBindings(f.environment.id, { environmentId: 'replacement-environment' });
        ctx.repos.components.updateBindings(f.component.id, { connectionUrl: 'postgres://rotated:private@database.internal/app' });
      }
      return undefined;
    } });
    const r = await reviewed(f); changeEnvironment = true;
    expect(await r.apply()).toMatchObject({ success: false, data: { applied: 0 } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings).not.toHaveProperty('providerScope');
    expect(ctx.repos.components.findById(f.component.id)?.bindings.connectionUrl).toContain('rotated:private');
    expect(f.http.mutations).toEqual([]);
  });

  it('records the verified identity of an already scoped database that has no committed primary', async () => {
    const f = await fixture();
    ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId, environmentId: stagingId } });
    const r = await reviewed(f);
    expect(r.action.reason).toContain('.hypervibe/bindings.json');
    expect(await r.apply()).toMatchObject({ success: true, data: { applied: 1, skipped: 0, providerMutations: 0 } });
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.databaseTopology)
      .toEqual({ primary: { provider: 'railway', externalId: 'staging-postgres' }, replicas: {} });
    expect((await planDatabaseScopeBinding(f.context())).actions).toEqual([]);
    expect(f.http.mutations).toEqual([]);
  });

  it('never replaces a committed primary that names a different database', async () => {
    const f = await fixture();
    const other = { primary: { provider: 'railway', externalId: 'other-postgres' }, replicas: {} };
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { databaseTopology: other });
    ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId, environmentId: stagingId } });
    const planned = await planDatabaseScopeBinding(f.context());
    expect(planned.actions).toEqual([]);
    expect(planned.warnings.join(' ')).toMatch(/different database/);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.databaseTopology).toEqual(other);
    expect(f.http.mutations).toEqual([]);
  });

  async function identityPlan(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    return result;
  }

  it('records the database identity without backups when the environment deliberately disables them', async () => {
    const f = await fixture();
    f.spec.environments.staging.backups = { mode: 'disabled', reason: 'Staging has no backups by owner choice' };
    new SpecStore().replace(f.project, f.spec);
    const result = await identityPlan(f);
    expect(result.scope).toBe('database-bindings');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ type: 'update', requiresConfirm: true,
      resource: { kind: 'database', provider: 'railway', name: 'postgres' },
      metadata: { operation: 'databaseIdentityRecord', componentId: f.component.id, externalId: 'staging-postgres',
        projectId, environmentId: stagingId } });
    expect(resolvePlanActionAuthority(result.actions[0])?.capability).toBe('database.identity.record');
    expect(JSON.stringify(result.warnings ?? [])).not.toMatch(/native recovery source/);
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: result.specRevision,
      planId: result.planRunId, confirmActions: [result.actions[0].id], alwaysRunBootstrap: true }))
      .toMatchObject({ kind: 'executed', result: { success: true, receipts: [
        { data: { applied: 1, skipped: 0, providerMutations: 0 } },
      ] } });
    const { databaseTopology, ...unchangedBindings } = ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    expect(databaseTopology).toEqual({ primary: { provider: 'railway', externalId: 'staging-postgres' }, replicas: {} });
    expect(unchangedBindings).toEqual(f.environment.platformBindings);
    // Only the identity is recorded: the backup-gated recovery scope stays absent.
    expect(ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    const next = await identityPlan(f);
    expect(next.actions.some(action => action.metadata?.operation === 'databaseIdentityRecord')).toBe(false);
    expect(f.http.mutations).toEqual([]);
  });

  it('records the identity of an imported database whose project-only scope stays untouched', async () => {
    const f = await fixture();
    ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId } });
    const scoped = ctx.repos.components.findById(f.component.id)!;
    const result = await identityPlan(f);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].metadata).toMatchObject({ operation: 'databaseIdentityRecord', externalId: 'staging-postgres' });
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: result.specRevision,
      planId: result.planRunId, confirmActions: [result.actions[0].id], alwaysRunBootstrap: true }))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.databaseTopology)
      .toEqual({ primary: { provider: 'railway', externalId: 'staging-postgres' }, replicas: {} });
    expect(ctx.repos.components.findById(f.component.id)).toEqual(scoped);
  });

  it('never records an identity that a complete inventory of the environment does not contain', async () => {
    const f = await fixture();
    f.spec.environments.staging.backups = { mode: 'disabled', reason: 'Staging has no backups by owner choice' };
    new SpecStore().replace(f.project, f.spec);
    ctx.repos.components.update(f.component.id, { externalId: 'retired-postgres' });
    const result = await identityPlan(f);
    expect(result.actions.some(action => action.metadata?.operation === 'databaseIdentityRecord')).toBe(false);
    expect((result.warnings ?? []).join(' ')).toMatch(/could not be confirmed in a complete inventory/);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings).not.toHaveProperty('databaseTopology');
  });

  it('blocks an identity record when the environment changed after review', async () => {
    const f = await fixture();
    f.spec.environments.staging.backups = { mode: 'disabled', reason: 'Staging has no backups by owner choice' };
    new SpecStore().replace(f.project, f.spec);
    const result = await identityPlan(f);
    const other = { primary: { provider: 'railway', externalId: 'other-postgres' }, replicas: {} };
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { databaseTopology: other });
    const applied = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: result.specRevision,
      planId: result.planRunId, confirmActions: [result.actions[0].id], alwaysRunBootstrap: true });
    expect(JSON.stringify(applied)).not.toMatch(/"applied":1/);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.databaseTopology).toEqual(other);
    expect(f.http.mutations).toEqual([]);
  });

  it('preserves concurrent credentials and never repeats an already completed local repair', async () => {
    const f = await fixture(); const r = await reviewed(f);
    ctx.repos.components.updateBindings(f.component.id, { connectionUrl: 'postgres://rotated:private@database.internal/app' });
    expect(await r.apply()).toMatchObject({ success: true, data: { applied: 1, skipped: 0, providerMutations: 0 } });
    const before = ctx.repos.components.findById(f.component.id);
    expect(await r.apply()).toMatchObject({ success: true, data: { applied: 0, skipped: 1, providerMutations: 0 } });
    expect(ctx.repos.components.findById(f.component.id)).toEqual(before);
    expect(before?.bindings.connectionUrl).toContain('rotated:private');
    expect((await planDatabaseScopeBinding(f.context())).actions).toEqual([]);
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['denied', 'missing-field', 'wrong-project', 'duplicate-volume', 'later-page'] as const)('does not repair from %s native evidence', async change => {
    const f = await fixture({ pageSize: 1, responseOverride: ({ query, variables }) => {
      if (change === 'denied' && query.includes('DatabaseCheckpointTarget')) return Response.json({ errors: [{ message: 'private-error' }] }, { status: 403 });
      if (change === 'missing-field' && query.includes('DatabaseCheckpointTarget')) return Response.json({ data: { service: { id: 'staging-postgres', projectId, deletedAt: null } } });
      if (change === 'later-page' && query.includes('EnvironmentVolumeInstances') && variables.after) return Response.json({ errors: [{ message: 'private-error' }] }, { status: 403 });
      return undefined;
    }, ...(change === 'wrong-project' ? { environmentProjectId: 'other-project' } : {}) });
    if (change === 'duplicate-volume') f.http.addVolume('staging-postgres', stagingId, '/another');
    if (change === 'later-page') f.http.addVolume(null, stagingId, '/unrelated');
    expect((await planDatabaseScopeBinding(f.context())).actions).toEqual([]);
    expect(ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['explicit-scope', 'malformed-scope', 'unfinished-create', 'malformed-create', 'retained', 'duplicate', 'disabled'])('preserves %s state without adopting it', async change => {
    const f = await fixture();
    if (change === 'explicit-scope') ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId } });
    if (change === 'malformed-scope') ctx.repos.components.updateBindings(f.component.id, { providerScope: null });
    if (change === 'unfinished-create') ctx.repos.components.updateBindings(f.component.id, {
      unresolvedMutation: createUnresolvedDatabaseMutation('postgres', { projectId, environmentId: stagingId }) });
    if (change === 'malformed-create') ctx.repos.components.updateBindings(f.component.id, { unresolvedMutation: {} });
    if (change === 'retained') ctx.repos.components.updateBindings(f.component.id, { retainedCleanup: true });
    if (change === 'disabled') f.spec.environments.staging.backups = { mode: 'disabled', reason: 'Explicit owner exclusion' };
    const before = ctx.repos.components.findByEnvironmentId(f.environment.id);
    const context = f.context();
    // SQLite disallows duplicate environment/type rows. Also guard an ambiguous
    // caller-supplied snapshot without weakening that real uniqueness constraint.
    if (change === 'duplicate') context.components.push({ ...f.component, id: 'duplicate-component', externalId: 'other' });
    expect((await planDatabaseScopeBinding(context)).actions).toEqual([]);
    expect(ctx.repos.components.findByEnvironmentId(f.environment.id)).toEqual(before);
    expect(f.http.mutations).toEqual([]);
  });

  it('requires confirmation and rejects mixed stages, forged identities and rollout inputs', async () => {
    const f = await fixture(); const r = await reviewed(f);
    const document = ctx.repos.runs.findById(r.result.planRunId)!.plan;
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    for (const change of [{ scope: 'full' }, { overrides: { services: ['web'] } }, { sourceCommitSha: 'a'.repeat(40) },
      { actions: [r.action, { ...r.action, id: 'unrelated' }] }]) {
      expect(planRunDocumentSchema.safeParse({ ...document, ...change }).success).toBe(false);
    }
    for (const action of [{ ...r.action, requiresConfirm: false }, { ...r.action, resource: { ...r.action.resource, kind: 'service' as const } },
      { ...r.action, metadata: { ...r.action.metadata, componentId: 'another-component' } }]) {
      expect(resolvePlanActionAuthority(action)).toBeNull();
    }
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: r.result.specRevision,
      planId: r.result.planRunId, confirmActions: [], alwaysRunBootstrap: true })).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.http.mutations).toEqual([]);
  });

  it('keeps requested checkpoints ahead of metadata repair and rejects filtered plans', async () => {
    const f = await fixture();
    expect(await new PlanService().plan(f.project, 'staging', { includeEnvFile: false, serviceFilter: ['web'] }))
      .toHaveProperty('error', expect.stringMatching(/binding reconciliation/));
    f.spec.environments.staging.database!.resilience = { checkpoint: { id: 'before-release' } };
    new SpecStore().replace(f.project, f.spec);
    const result = await f.plan();
    expect(result).toMatchObject({ scope: 'database-checkpoint' });
    if ('error' in result) throw new Error(result.error);
    expect(result.actions.every(action => action.metadata?.operation === 'databaseCheckpointCreate')).toBe(true);
    expect(f.http.mutations).toEqual([]);
  });

  it('retains a completed local write when export fails and re-exports on exact retry', async () => {
    const f = await fixture(); const r = await reviewed(f);
    const original = EnvironmentRepository.prototype.syncRepoBindingsForId;
    const sync = vi.spyOn(EnvironmentRepository.prototype, 'syncRepoBindingsForId').mockImplementationOnce(() => {
      throw new Error('Synthetic export failure');
    });
    expect(await r.apply()).toMatchObject({ success: false, status: 'blocked', data: { applied: 1, providerMutations: 0 } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings.providerScope).toEqual({ projectId, environmentId: stagingId });
    sync.mockImplementation(original);
    expect(await r.apply()).toMatchObject({ success: true, data: { applied: 0, skipped: 1, providerMutations: 0 } });
    expect(sync).toHaveBeenCalledTimes(2);
    expect(ctx.repos.components.findById(f.component.id)?.bindings.resilience).toEqual(f.component.bindings.resilience);
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['railway', 'cloudsql', 'rds', 'supabase', 'azure-postgres', 'neon', 'fly', 'digitalocean'])('keeps %s recovery-scope support explicit', async provider => {
    const f = await fixture();
    f.spec.environments.staging.database!.provider = provider;
    ctx.repos.components.updateBindings(f.component.id, { provider });
    if (provider === 'cloudsql') {
      const cloudsql = new CloudSqlAdapter();
      await cloudsql.connect({ projectId: 'gcp-project', credentials: JSON.stringify({ client_email: 'synthetic@example.invalid', private_key: 'synthetic-key' }) });
      Object.assign(cloudsql, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60_000) });
      vi.mocked(AdapterFactory.prototype.getDatabaseAdapter).mockResolvedValue({ success: true, adapter: cloudsql });
    }
    const readsBefore = f.http.requests.length;
    vi.mocked(AdapterFactory.prototype.getDatabaseAdapter).mockClear();
    expect(providerRegistry.getMetadata(provider)?.lifecycle?.dailyBackups?.database === true)
      .toBe(provider === 'railway' || provider === 'cloudsql');
    const result = await planDatabaseScopeBinding(f.context());
    expect(result.actions).toHaveLength(provider === 'railway' ? 1 : 0);
    if (provider !== 'railway') expect(result.warnings.join(' ')).toContain('could not be independently verified');
    if (provider !== 'railway') expect(f.http.requests).toHaveLength(readsBefore);
    if (provider !== 'railway' && provider !== 'cloudsql') expect(AdapterFactory.prototype.getDatabaseAdapter).not.toHaveBeenCalled();
    expect(ctx.repos.components.findById(f.component.id)?.bindings).not.toHaveProperty('providerScope');
    expect(f.http.mutations).toEqual([]);
  });

  it('covers every registered database provider in the named repair review', () => {
    expect(providerRegistry.namesFor('database').sort())
      .toEqual(['railway', 'cloudsql', 'rds', 'supabase', 'azure-postgres', 'neon', 'fly', 'digitalocean'].sort());
  });
});
