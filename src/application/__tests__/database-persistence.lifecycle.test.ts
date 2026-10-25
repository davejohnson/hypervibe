import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter, getDb } from '../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { AdapterFactory } from '../../domain/services/adapter.factory.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { executePlanApply } from '../apply-plan.js';
import { applyDatabaseScopeBinding } from '../apply-database-scope-binding.js';
import { buildDatabaseEnvVarsFromComponent } from '../../domain/services/database-env.js';
import { createRailwayDatabaseAdapter } from '../../adapters/providers/railway/railway-database.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';

let directory: string;
let ctx: CommandContext;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-database-persistence-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '2');
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  ctx = createCommandContext();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
});

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}, web = false) {
  const http = await railwayHttpFixture(options);
  const native = http.addService('staging-postgres', 'postgres-db', stagingId);
  Object.assign(native.instances.get(stagingId)!, { source: { image: 'postgres:16' },
    latestDeployment: { id: 'database-deployment', status: 'SUCCESS' } });
  http.variables.set(`staging-postgres/${stagingId}`, { PGDATA: '/var/lib/postgresql/data/pgdata',
    DATABASE_URL: 'postgresql://synthetic:private@database.railway.internal/postgres' });
  const project = ctx.repos.projects.create({ name: 'persistence-contract', defaultPlatform: 'railway' });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name,
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
    environments: { staging: { hosting: { provider: 'railway' }, services: web ? { web: { startCommand: 'npm start' } } : {},
      backups: { mode: 'disabled', reason: 'Synthetic contract fixture; persistence must be enforced independently of backup policy.' },
      database: { provider: 'railway' }, email: { enabled: false }, envVars: {} } } });
  new SpecStore().replace(project, spec);
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'railway', projectId, environmentId: stagingId,
    databaseTopology: { primary: { provider: 'railway', externalId: 'staging-postgres' }, replicas: {} },
  } });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'staging-postgres',
    bindings: { provider: 'railway', resourceKind: 'service', pluginName: 'postgres-db', directUrlVariable: 'DATABASE_URL',
      providerScope: { projectId, environmentId: stagingId } } });
  const database = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter, envRepo: ctx.repos.environments });
  vi.spyOn(AdapterFactory.prototype, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: http.adapter });
  vi.spyOn(AdapterFactory.prototype, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: database });
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
  const registry = createCommandRegistry(ctx);
  const plan = async () => {
    const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    return result;
  };
  const status = async () => {
    const before = getDb().prepare('SELECT COUNT(*) AS count FROM runs').get();
    const result = await registry.execute('hv_status', { project: project.name, env: 'staging' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual(before);
    return result.data as { verified: boolean; inSync: boolean; drift: Array<{ id: string; metadata?: Record<string, unknown> }> };
  };
  return { http, project, spec, environment, component, plan, status };
}

async function legacyReferenceFixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const f = await fixture(options);
  const { directUrlVariable: _direct, ...legacy } = f.component.bindings;
  ctx.repos.components.update(f.component.id, { bindings: legacy });
  f.http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
  return f;
}

async function newDatabaseFixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const f = await fixture({ renderVariableReferences: true, ...options });
  ctx.repos.components.delete(f.component.id);
  ctx.repos.environments.update(f.environment.id, { platformBindings: { provider: 'railway', projectId, environmentId: stagingId } });
  f.http.services.delete('staging-postgres');
  delete f.http.environments.get(stagingId)!.config.services!['staging-postgres'];
  const productionDatabase = f.http.services.get('production-postgres-db')!;
  Object.assign(productionDatabase.instances.get(productionId)!, { source: { image: 'postgres:16' },
    latestDeployment: { id: 'production-database-deployment', status: 'SUCCESS' } });
  f.http.addVolume(productionDatabase.id, productionId, '/var/lib/postgresql/data');
  return f;
}

// Real command/status, SQLite plan, apply re-observation, and Railway serialized
// transport against its pinned SDL. Provider state is synthetic and follows the
// volume/PGDATA sources cited in railway.database-persistence.api-contract.test.
// These tests never restart a server or establish live data survival.
describe('database persistence through status, plan, apply and retry', () => {
  it('reports missing persistence and blocks an approved apply and retry without repairing the existing database', async () => {
    const f = await fixture({}, true);
    const status = await f.status();
    expect(status.inSync).toBe(false);
    expect(status.drift.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe('database_persistence_missing');
    const plan = await f.plan();
    expect(plan.actions.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe('database_persistence_missing');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
        planId: plan.planRunId, confirmActions: plan.actions.map(action => action.id) });
      expect(result).toMatchObject({ kind: 'executed', result: { success: false, receipts: expect.arrayContaining([
        expect.objectContaining({ actionId: 'database:railway', status: 'blocked' }),
      ]) } });
    }
    expect(ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings).toEqual(f.environment.platformBindings);
    expect(f.http.contractErrors).toEqual([]);
    expect(f.http.mutations).toEqual([]);
  });

  it('reports unknown persistence as unverified status, not a missing database', async () => {
    const f = await fixture({ responseOverride: request => request.query.includes('query EnvironmentVolumeInstances')
      ? Response.json({ errors: [{ message: 'synthetic volume access denied' }] }, { status: 403 }) : undefined });
    const status = await f.status();
    expect(status.verified).toBe(false);
    expect(status.inSync).toBe(false);
    expect(status.drift.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe('database_persistence_unknown');
    expect((await f.plan()).actions.some(action => action.resource.kind === 'database' && action.type === 'create')).toBe(false);
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['removed', 'replaced'] as const)('rejects a persisted plan after its data volume is %s', async change => {
    const f = await fixture();
    f.http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const plan = await f.plan();
    expect(plan.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'noop', verified: true });
    expect((await f.status()).inSync).toBe(true);
    f.http.volumes.clear();
    if (change === 'replaced') f.http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const result = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: plan.actions.map(action => action.id) });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false,
      error: 'Live infrastructure changed since this plan was created. Re-run hv_plan.', receipts: [] } });
    expect(ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.http.contractErrors).toEqual([]);
    expect(f.http.mutations).toEqual([]);
  });

  it('does not approve a new plan against a same-service replacement of the durably bound volume', async () => {
    const f = await fixture();
    const original = f.http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const component = ctx.repos.components.update(f.component.id, {
      bindings: { ...f.component.bindings, volumeId: original.id },
    });
    f.http.volumes.clear();
    f.http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const plan = await f.plan();
    expect(plan.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'update',
      metadata: { blockedReason: 'database_persistence_unknown' } });
    expect(ctx.repos.components.findById(f.component.id)).toEqual(component);
    expect(f.http.mutations).toEqual([]);
  });

  it('reviews missing runtime reference metadata even when scope and primary identity are already recorded', async () => {
    const f = await legacyReferenceFixture();
    expect((await f.status()).drift.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe('database_runtime_reference_missing');
    const plan = await f.plan();
    expect(plan.scope).toBe('database-bindings');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].metadata).toMatchObject({ runtimeReference: { directUrlVariable: 'DATABASE_URL' } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings.directUrlVariable).toBeUndefined();
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: [] }))
      .toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings.directUrlVariable).toBeUndefined();
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: [plan.actions[0].id] }))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    const saved = ctx.repos.components.findById(f.component.id)!;
    expect(saved.bindings).toEqual({ ...f.component.bindings, directUrlVariable: 'DATABASE_URL' });
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings).toEqual(f.environment.platformBindings);
    expect(buildDatabaseEnvVarsFromComponent(saved).envVars).toEqual({
      DATABASE_URL: '${{postgres-db.DATABASE_URL}}', DIRECT_URL: '${{postgres-db.DATABASE_URL}}' });
    expect(await applyDatabaseScopeBinding({ ctx, project: f.project, environmentName: 'staging',
      environmentSpec: f.spec.environments.staging, action: plan.actions[0], confirmedActionIds: new Set([plan.actions[0].id]) }))
      .toMatchObject({ success: true, data: { applied: 0, providerMutations: 0 } });
    expect((await f.plan()).actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'noop' });
    expect((await f.status()).inSync).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('synthetic:private');
    expect(f.http.mutations).toEqual([]);
    expect(f.http.contractErrors).toEqual([]);
  });

  it.each(['missing', 'present'] as const)('preserves the existing private URL choice with %s explicit metadata', async marker => {
    const f = await legacyReferenceFixture();
    Object.assign(f.http.variables.get(`staging-postgres/${stagingId}`)!, {
      DATABASE_PRIVATE_URL: 'postgresql://private-choice', DIRECT_URL: 'postgresql://different-choice' });
    if (marker === 'present') ctx.repos.components.updateBindings(f.component.id, { directUrlVariable: 'DATABASE_PRIVATE_URL' });
    const plan = await f.plan();
    if (marker === 'missing') {
      expect(plan.scope).toBe('database-bindings');
      expect(plan.actions[0].metadata).toMatchObject({ runtimeReference: { directUrlVariable: 'DATABASE_PRIVATE_URL' } });
    } else {
      expect(plan.scope).toBe('full');
      expect(plan.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'noop' });
    }
    expect(f.http.mutations).toEqual([]);
  });

  it('repairs a legacy project-only scope and missing runtime key without replacing recorded identity', async () => {
    const f = await legacyReferenceFixture();
    ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId } });
    const plan = await f.plan();
    expect(plan.scope).toBe('database-bindings');
    expect(plan.actions[0].metadata).toMatchObject({ priorProviderScope: { projectId },
      runtimeReference: { directUrlVariable: 'DATABASE_URL' } });
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: [plan.actions[0].id] }))
      .toMatchObject({ kind: 'executed', result: { success: true } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings).toEqual(f.component.bindings);
    expect((await f.plan()).actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'noop' });
    expect((await f.status()).inSync).toBe(true);
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['missing', 'present'] as const)('blocks a renamed database reference namespace with %s URL metadata', async marker => {
    const f = await legacyReferenceFixture();
    if (marker === 'present') ctx.repos.components.updateBindings(f.component.id, { directUrlVariable: 'DATABASE_URL' });
    // The durable id still names the same database, but Railway references use
    // its observed name. Another service now owns the recorded reference name.
    f.http.services.get('staging-postgres')!.name = 'renamed-postgres';
    f.http.addService('unrelated-service', 'postgres-db', stagingId);
    const plan = await f.plan();
    expect(plan.scope).toBe('full');
    expect(plan.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'update', verified: false,
      metadata: { blockedReason: 'database_runtime_reference_unknown' } });
    expect((await f.status()).verified).toBe(false);
    expect(ctx.repos.components.findById(f.component.id)?.bindings.pluginName).toBe('postgres-db');
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['empty-private', 'empty-direct', 'denied-variables'] as const)('blocks uncertain runtime reference selection after %s', async failure => {
    const f = await legacyReferenceFixture(failure === 'denied-variables' ? { responseOverride: request =>
      request.query.includes('query GetVariables') ? Response.json({ errors: [{ message: 'synthetic access denied' }] }, { status: 403 }) : undefined } : {});
    if (failure !== 'denied-variables') Object.assign(f.http.variables.get(`staging-postgres/${stagingId}`)!,
      failure === 'empty-private' ? { DATABASE_PRIVATE_URL: '', DIRECT_URL: 'postgresql://other' } : { DIRECT_URL: '' });
    const plan = await f.plan();
    expect(plan.scope).toBe('full');
    expect(plan.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'update',
      metadata: { blockedReason: failure === 'denied-variables' ? 'database_persistence_unknown' : 'database_runtime_reference_unknown' } });
    expect((await f.status()).verified).toBe(false);
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: plan.actions.map(action => action.id) }))
      .toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings.directUrlVariable).toBeUndefined();
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['key-presence', 'explicit-selection', 'scope', 'namespace'] as const)('rejects metadata apply when reviewed %s changes', async change => {
    const f = await legacyReferenceFixture();
    const plan = await f.plan();
    if (change === 'key-presence') f.http.variables.get(`staging-postgres/${stagingId}`)!.DIRECT_URL = 'postgresql://other';
    if (change === 'explicit-selection') ctx.repos.components.updateBindings(f.component.id, { directUrlVariable: 'DIRECT_URL' });
    if (change === 'scope') ctx.repos.environments.updatePlatformBindings(f.environment.id, { environmentId: productionId });
    if (change === 'namespace') f.http.services.get('staging-postgres')!.name = 'renamed-postgres';
    expect(await applyDatabaseScopeBinding({ ctx, project: f.project, environmentName: 'staging',
      environmentSpec: f.spec.environments.staging, action: plan.actions[0], confirmedActionIds: new Set([plan.actions[0].id]) }))
      .toMatchObject({ success: false, status: 'blocked', data: { providerMutations: 0 } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings.directUrlVariable)
      .toBe(change === 'explicit-selection' ? 'DIRECT_URL' : undefined);
    expect(f.http.mutations).toEqual([]);
  });

  it('keeps credential values out of runtime metadata fingerprints', async () => {
    const f = await legacyReferenceFixture();
    const first = await f.plan();
    f.http.variables.get(`staging-postgres/${stagingId}`)!.DATABASE_URL = 'postgresql://another-secret@database.railway.internal/postgres';
    const second = await f.plan();
    expect(first.actions[0].metadata?.runtimeReference).toEqual(second.actions[0].metadata?.runtimeReference);
    expect(JSON.stringify(second)).not.toContain('another-secret');
    expect(f.http.mutations).toEqual([]);
  });

  it('retains a runtime reference metadata write after export failure and safely retries it', async () => {
    const f = await legacyReferenceFixture();
    ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId } });
    const plan = await f.plan();
    const apply = () => applyDatabaseScopeBinding({ ctx, project: f.project, environmentName: 'staging',
      environmentSpec: f.spec.environments.staging, action: plan.actions[0], confirmedActionIds: new Set([plan.actions[0].id]) });
    const original = EnvironmentRepository.prototype.syncRepoBindingsForId;
    const sync = vi.spyOn(EnvironmentRepository.prototype, 'syncRepoBindingsForId').mockImplementationOnce(() => {
      throw new Error('Synthetic export failure');
    });
    expect(await apply()).toMatchObject({ success: false, status: 'blocked', data: { applied: 1, providerMutations: 0 } });
    expect(ctx.repos.components.findById(f.component.id)?.bindings.directUrlVariable).toBe('DATABASE_URL');
    sync.mockImplementation(original);
    expect(await apply()).toMatchObject({ success: true, data: { applied: 0, skipped: 1, providerMutations: 0 } });
    expect((await f.plan()).scope).toBe('full');
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['removed-scope', 'changed-scope', 'pending-recovery'] as const)('preserves partial-scope repair veto after %s', async change => {
    const f = await legacyReferenceFixture();
    ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId } });
    const plan = await f.plan();
    expect(plan.scope).toBe('database-bindings');
    if (change === 'removed-scope') {
      const { providerScope: _scope, ...bindings } = ctx.repos.components.findById(f.component.id)!.bindings;
      ctx.repos.components.update(f.component.id, { bindings });
    }
    if (change === 'changed-scope') ctx.repos.components.updateBindings(f.component.id, { providerScope: { projectId: 'different-project' } });
    if (change === 'pending-recovery') ctx.repos.components.updateBindings(f.component.id,
      { credentialAliasRepair: { phase: 'attempted', inspectionEncrypted: 'preserved-local-evidence' } });
    const before = ctx.repos.components.findById(f.component.id);
    const applied = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: [plan.actions[0].id] });
    expect(applied.kind === 'blocked' || (applied.kind === 'executed' && !applied.result.success)).toBe(true);
    expect(ctx.repos.components.findById(f.component.id)).toEqual(before);
    expect(f.http.mutations).toEqual([]);
  });

  it('creates a new staging database through its reviewed template action beside unchanged production, then reaches a mutation-free noop', async () => {
    const f = await newDatabaseFixture();
    const production = structuredClone(f.http.services.get('production-postgres-db'));
    const plan = await f.plan();
    expect(plan.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'create', billable: true });
    const unconfirmed = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: [] });
    expect(unconfirmed).toMatchObject({ kind: 'executed', result: { success: false, receipts: expect.arrayContaining([
      expect.objectContaining({ actionId: 'database:railway', status: 'skipped_requires_confirm' }),
    ]) } });
    expect(f.http.mutations).toEqual([]);
    const applied = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: plan.actions.map(action => action.id) });
    expect(applied, JSON.stringify(applied)).toMatchObject({ kind: 'executed', result: { success: true } });
    const component = ctx.repos.components.findByEnvironmentAndType(f.environment.id, 'postgres')!;
    expect(component).toMatchObject({ bindings: { providerScope: { projectId, environmentId: stagingId },
      resourceKind: 'service', pluginName: 'Postgres', volumeId: expect.any(String) } });
    expect(f.http.mutations.map(mutation => mutation.field)).toEqual(['templateDeployV2']);
    expect((await f.status()).inSync).toBe(false);
    // Template completion proves resource configuration. A later provider read
    // independently reports its deployment running before an ordinary noop.
    Object.assign(f.http.services.get(component.externalId!)!.instances.get(stagingId)!, {
      latestDeployment: { id: 'staging-template-deployment', status: 'SUCCESS' },
    });
    const next = await f.plan();
    expect(next.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'noop', verified: true });
    const noop = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: next.specRevision,
      planId: next.planRunId, confirmActions: next.actions.map(action => action.id) });
    expect(noop).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.http.mutations.map(mutation => mutation.field)).toEqual(['templateDeployV2']);
    expect(f.http.services.get('production-postgres-db')).toEqual(production);
    expect(f.http.contractErrors).toEqual([]);
  });

  it.each(['lost-response', 'missing-volume', 'pending-workflow', 'flattened-aliases'] as const)('retains failed template creation after %s and blocks repeat creates', async failure => {
    let f: Awaited<ReturnType<typeof newDatabaseFixture>>;
    f = await newDatabaseFixture(failure === 'lost-response' ? { dropTemplateDeployResponse: true }
      : failure === 'missing-volume' ? { templateWithoutVolume: true }
        : failure === 'pending-workflow' ? { templateWorkflowStatus: 'Running' }
          : { responseOverride: request => {
            if (request.query.includes('query DatabaseTemplateWorkflow')) {
              const variables = f.http.variables.get(`staging-Postgres/${stagingId}`)!;
              variables.PGPASSWORD = variables.POSTGRES_PASSWORD;
            }
            return undefined;
          } });
    const plan = await f.plan();
    const applied = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: plan.specRevision,
      planId: plan.planRunId, confirmActions: plan.actions.map(action => action.id) });
    expect(applied).toMatchObject({ kind: 'executed', result: { success: false } });
    const retained = ctx.repos.components.findByEnvironmentAndType(f.environment.id, 'postgres')!;
    expect(retained.bindings.provisioningIncomplete).toBe(true);
    if (failure === 'missing-volume' || failure === 'flattened-aliases') expect(retained.externalId).toBe('staging-Postgres');
    else expect(retained.bindings.unresolvedMutation).toMatchObject({ operation: 'create' });
    const retry = await f.plan();
    expect(retry.actions.some(action => action.resource.kind === 'database' && action.type === 'create')).toBe(false);
    expect(retry.actions.find(action => action.resource.kind === 'database')?.metadata?.blockedReason).toBeTruthy();
    const retried = await executePlanApply(ctx, { project: f.project, spec: f.spec, specRevision: retry.specRevision,
      planId: retry.planRunId, confirmActions: retry.actions.map(action => action.id) });
    expect(retried).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findByEnvironmentAndType(f.environment.id, 'postgres')).toEqual(retained);
    expect(f.http.mutations.map(mutation => mutation.field)).toEqual(['templateDeployV2']);
    expect(f.http.contractErrors).toEqual([]);
  });
});
