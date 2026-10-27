import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { createCommandRegistry } from '../commands.js';
import { AdapterFactory } from '../../domain/services/adapter.factory.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { executePlanApply } from '../apply-plan.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { getCompletedDatabaseInitializationReceipt } from '../../domain/plan/database-initialization.contract.js';
import { credentialActionId, type CredentialTarget } from '../../domain/plan/credential-plan.contract.js';
import * as credentialLifecycle from '../../domain/services/credential-lifecycle.service.js';
import { createRailwayDatabaseAdapter } from '../../adapters/providers/railway/railway-database.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';

let directory: string;
let ctx: CommandContext;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-database-initialization-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '2');
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
  vi.stubEnv('HYPERVIBE_RAILWAY_INITIALIZATION_POLL_ATTEMPTS', '2');
  vi.stubEnv('HYPERVIBE_RAILWAY_INITIALIZATION_POLL_INTERVAL_MS', '0');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  ctx = createCommandContext();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
});

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const http = await railwayHttpFixture({ renderVariableReferences: true, mutationEnvironments: [productionId], ...options });
  const native = http.services.get('production-postgres-db')!;
  Object.assign(native.instances.get(productionId)!, { source: { image: 'postgres:16' },
    latestDeployment: { id: 'old-ephemeral-deployment', status: 'SUCCESS' } });
  http.variables.set(`${native.id}/${productionId}`, {
    POSTGRES_PASSWORD: 'synthetic-preserved-password', POSTGRES_USER: 'postgres', POSTGRES_DB: 'postgres',
    DATABASE_URL: 'postgresql://${{POSTGRES_USER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{POSTGRES_DB}}',
    RAILWAY_PRIVATE_DOMAIN: 'postgres-db.railway.internal',
  });
  const stagingDatabase = http.addService('staging-postgres', 'postgres-db', stagingId);
  Object.assign(stagingDatabase.instances.get(stagingId)!, { source: { image: 'postgres:16' } });
  http.addVolume(stagingDatabase.id, stagingId, '/var/lib/postgresql/data');
  const documents = http.addService('production-documents', 'documents', productionId);
  http.addVolume(documents.id, productionId, '/documents');
  const project = ctx.repos.projects.create({ name: 'fresh-initialization-contract', defaultPlatform: 'railway' });
  let spec = projectSpecSchema.parse({ version: 1, project: project.name,
    runtime: { kind: 'node', version: '24', installCommand: 'npm ci --omit=dev' },
    environments: { production: { hosting: { provider: 'railway' }, services: {},
      backups: { mode: 'disabled', reason: 'Synthetic fixture; later backup readiness is checked separately.' },
      database: { provider: 'railway' }, email: { enabled: false }, envVars: {} } } });
  new SpecStore().replace(project, spec);
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId, environmentId: productionId,
    databaseTopology: { primary: { provider: 'railway', externalId: native.id }, replicas: {} },
    appliedSpecHash: 'preserved-deployment-marker',
  } });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: native.id,
    bindings: { provider: 'railway', resourceKind: 'service', pluginName: 'postgres-db', directUrlVariable: 'DATABASE_URL',
      providerScope: { projectId, environmentId: productionId } } });
  const database = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter, envRepo: ctx.repos.environments });
  vi.spyOn(AdapterFactory.prototype, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: http.adapter });
  vi.spyOn(AdapterFactory.prototype, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: database });
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
  const registry = createCommandRegistry(ctx);
  const plan = async () => {
    const result = await new PlanService().plan(project, 'production', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    return result;
  };
  const status = async () => {
    const result = await registry.execute('hv_status', { project: project.name, env: 'production' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.data as { verified: boolean; inSync: boolean; drift: Array<{ id: string; metadata?: Record<string, unknown> }> };
  };
  const declare = (overrides: Record<string, unknown> = {}) => {
    spec = projectSpecSchema.parse({ ...spec, environments: { ...spec.environments, production: {
      ...spec.environments.production, database: { ...spec.environments.production.database,
        freshInitialization: { id: 'fresh-production', discardExistingData: true,
          target: { externalId: native.id, providerScope: { projectId, environmentId: productionId } }, ...overrides } },
    } } });
    return new SpecStore().replace(project, spec);
  };
  const apply = async (planned: Awaited<ReturnType<typeof plan>>, confirmed = true) => executePlanApply(ctx, {
    project, spec, specRevision: planned.specRevision, planId: planned.planRunId,
    confirmActions: confirmed ? planned.actions.map(action => action.id) : [],
  });
  return { http, project, environment, component, database, plan, status, declare, apply, spec: () => spec };
}

// Synthetic provider state is executed through graphql-request and the pinned
// official Railway schema. PostgreSQL entrypoint/volume contracts are recorded
// with the provider tests. This does not establish live SQL or durability proof.
describe('explicit fresh database initialization lifecycle', () => {
  it('offers only the confirmed exact-database initialization after explicit discard intent', async () => {
    const f = await fixture();
    expect((await f.status()).drift.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe('database_persistence_missing');
    f.declare();
    const planned = await f.plan();
    expect(planned.scope).toBe('database-initialization');
    expect(planned.actions).toHaveLength(1);
    expect(planned.actions[0]).toMatchObject({ type: 'update', requiresConfirm: true, billable: true, dataBearing: true,
      resource: { kind: 'database', provider: 'railway' }, metadata: { operation: 'databaseFreshInitialize',
        target: { externalId: f.component.externalId, providerScope: { projectId, environmentId: productionId } } } });
    expect(JSON.stringify(planned)).not.toContain('synthetic-preserved-password');
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['entering', 'active', 'exiting', 'malformed', 'previous-target', 'database-candidate', 'storage-candidate'] as const)(
    'preserves the persisted %s safety veto even without desired maintenance or migration', async state => {
      const f = await fixture(); f.declare();
      if (['entering', 'active', 'exiting', 'malformed'].includes(state)) {
        ctx.repos.environments.updatePlatformBindings(f.environment.id, { maintenance: state === 'malformed' ? { state: 'invalid' } : { state } });
      }
      if (state === 'previous-target') ctx.repos.components.updateBindings(f.component.id,
        { dataMigrationPreviousTarget: { provider: 'railway', externalId: 'retained-database' } });
      if (state === 'database-candidate') ctx.repos.components.create({ environmentId: f.environment.id,
        type: 'data-migration:pending:postgres', externalId: 'candidate-id', bindings: { provider: 'railway' } });
      if (state === 'storage-candidate') ctx.repos.environments.updatePlatformBindings(f.environment.id,
        { dataMigrationCandidates: { storage: { documents: { externalId: 'candidate-documents' } } } });
      const planned = await f.plan();
      expect(planned.scope).toBe('database-initialization');
      expect(planned.actions).toEqual([]);
      expect(planned.blocked.length).toBeGreaterThan(0);
      expect(f.http.mutations).toEqual([]);
    });

  it('blocks duplicate native identity even when another binding adds extra scope coordinates', async () => {
    const f = await fixture(); f.declare();
    const other = ctx.repos.environments.create({ projectId: f.project.id, name: 'shadow', platformBindings: {
      provider: 'railway', projectId, environmentId: productionId } });
    ctx.repos.components.create({ environmentId: other.id, type: 'postgres', externalId: f.component.externalId,
      bindings: { provider: 'railway', providerScope: { projectId, environmentId: productionId, region: 'extra-metadata' } } });
    const planned = await f.plan();
    expect(planned.actions).toEqual([]);
    expect(planned.blocked.length).toBeGreaterThan(0);
    expect(f.http.mutations).toEqual([]);
  });

  it('vetoes new and previously reviewed credential dispatch while initialization owns frozen configuration', async () => {
    const f = await fixture(); f.declare();
    const planned = await f.plan();
    const document = ctx.repos.runs.findById(planned.planRunId)!.plan as Record<string, any>;
    ctx.repos.components.updateBindings(f.component.id, { freshInitialization: {
      metadata: planned.actions[0].metadata, inspectionEncrypted: document.overrides.databaseInitializationEncrypted,
      startedAt: new Date().toISOString(), progress: { phase: 'prepared' },
    } });
    const target: CredentialTarget = { kind: 'hosting', environment: 'production', environmentId: f.environment.id,
      provider: 'railway', key: 'API_KEY', targetFingerprint: 'a'.repeat(64), services: ['web'] };
    const action = { id: credentialActionId('application-api', target), type: 'update', verified: true, requiresConfirm: true,
      resource: { kind: 'secret', provider: 'railway', name: 'API_KEY' }, reason: 'Previously reviewed credential update',
      metadata: { operation: 'credentialUpdate', role: 'application-api', intent: 'rotate', target } };
    const reviewed = ctx.repos.runs.create({ projectId: f.project.id, environmentId: f.environment.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'credentials', environmentName: 'production', specRevision: planned.specRevision,
      observedFingerprint: null, lockEnvironmentIds: [f.environment.id], actions: [action],
      overrides: { delegatedSecretVarsEncrypted: 'synthetic-encrypted-review' },
    } });
    ctx.repos.runs.updateStatus(reviewed.id, 'succeeded');
    const dispatch = vi.spyOn(credentialLifecycle, 'applyCredentialLifecycle').mockResolvedValue({ success: true } as never);
    expect(await executePlanApply(ctx, { project: f.project, spec: f.spec(), specRevision: planned.specRevision,
      planId: reviewed.id, confirmActions: [action.id] })).toMatchObject({ kind: 'blocked' });
    expect(dispatch).not.toHaveBeenCalled();
    const newPlan = await new PlanService().plan(f.project, 'production', { scope: 'credentials', credential: 'application-api', intent: 'rotate' });
    expect(newPlan).toHaveProperty('error', expect.stringMatching(/initialization/i));
    expect(f.http.mutations).toEqual([]);
  });

  it('requires confirmation, initializes only this database, retains exact storage and deployment receipts, and never reinitializes a completed intent', async () => {
    const f = await fixture(); f.declare();
    const beforeVariables = structuredClone(f.http.variables);
    const beforeVolumes = structuredClone(f.http.volumes);
    const planned = await f.plan();
    expect(await f.apply(planned, false)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.http.mutations).toEqual([]);
    const applied = await f.apply(planned);
    expect(applied).toMatchObject({ kind: 'executed', result: { success: true } });
    const component = ctx.repos.components.findById(f.component.id)!;
    const environment = ctx.repos.environments.findById(f.environment.id)!;
    const completed = getCompletedDatabaseInitializationReceipt({ component, environment });
    expect(completed).toMatchObject({ intentId: 'fresh-production', target: {
      provider: 'railway', externalId: f.component.externalId, providerScope: { projectId, environmentId: productionId } },
      storageId: expect.any(String), storageInstanceId: expect.any(String), deploymentId: expect.any(String) });
    expect(completed!.deploymentId).not.toBe('old-ephemeral-deployment');
    expect(component.externalId).toBe(f.component.externalId);
    expect(component.bindings).toMatchObject(f.component.bindings);
    expect(environment.platformBindings).toEqual(f.environment.platformBindings);
    expect(f.http.variables.get(`${f.component.externalId}/${productionId}`)).toMatchObject(beforeVariables.get(`${f.component.externalId}/${productionId}`)!);
    for (const [id, volume] of beforeVolumes) expect(f.http.volumes.get(id)).toEqual(volume);
    const mutations = f.http.mutations.length;
    expect(await f.apply(planned)).toMatchObject({ kind: 'executed', result: { success: false, conflict: { kind: 'already_applied' } } });
    expect(f.http.mutations).toHaveLength(mutations);
    expect((await f.plan()).scope).not.toBe('database-initialization');
    f.http.volumes.delete(completed!.storageId);
    const lostVolume = await f.plan();
    expect(lostVolume.scope).not.toBe('database-initialization');
    expect((await f.status()).drift.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe('database_persistence_missing');
    expect(f.http.mutations).toHaveLength(mutations);
    expect(JSON.stringify(applied)).not.toContain('synthetic-preserved-password');
  });

  it.each(['storage-identified', 'activation-identified'] as const)('retains acknowledged IDs in the durable apply receipt if %s local persistence fails', async phase => {
    const f = await fixture(); f.declare();
    const planned = await f.plan();
    const update = ComponentRepository.prototype.updateBindings;
    vi.spyOn(ComponentRepository.prototype, 'updateBindings').mockImplementation(function (this: ComponentRepository, id, patch) {
      if ((patch.freshInitialization as { progress?: { phase?: string } } | undefined)?.progress?.phase === phase) {
        throw new Error('synthetic local storage unavailable after provider acknowledgement');
      }
      return update.call(this, id, patch);
    });
    const applied = await f.apply(planned);
    expect(applied).toMatchObject({ kind: 'executed', result: { success: false } });
    const serialized = JSON.stringify(applied);
    expect(serialized).toContain('acknowledgedProgress');
    expect(serialized).toContain(phase);
    const durable = ctx.repos.runs.findById((applied as any).result.applyRunId)!;
    expect(JSON.stringify(durable)).toContain('acknowledgedProgress');
    expect(serialized).not.toContain('synthetic-preserved-password');
    const mutations = f.http.mutations.length;
    expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.http.mutations).toHaveLength(mutations);
  });


  it('keeps status and unrelated apply blocked until the newly acknowledged database deployment succeeds', async () => {
    const f = await fixture({ deploymentStatus: 'DEPLOYING' }); f.declare();
    const planned = await f.plan();
    const applied = await f.apply(planned);
    expect(applied).toMatchObject({ kind: 'executed', result: { success: false } });
    const component = ctx.repos.components.findById(f.component.id)!;
    expect(component.bindings.freshInitialization).toMatchObject({ progress: { phase: 'activation-identified' } });
    expect(getCompletedDatabaseInitializationReceipt({ component, environment: f.environment })).toBeUndefined();
    const status = await f.status();
    expect(status.inSync).toBe(false);
    expect(status.drift.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe('database_initialization_pending');
    const mutations = f.http.mutations.length;
    expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.http.mutations).toHaveLength(mutations);
    const progress = (component.bindings.freshInitialization as any).progress;
    f.http.deployments.get(progress.deploymentId)!.status = 'SUCCESS';
    const instance = f.http.services.get(f.component.externalId!)!.instances.get(productionId)!;
    Object.assign(instance.latestDeployment!, { status: 'SUCCESS' });
    expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.http.mutations).toHaveLength(mutations);
    expect((await f.status()).drift.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .not.toBe('database_initialization_pending');
  });

  it.each(['volume', 'deployment'] as const)('never adopts or repeats an uncertain %s creation on lifecycle retry', async kind => {
    const f = await fixture(kind === 'volume' ? { dropVolumeCreateResponse: true } : { dropDeploymentResponse: true }); f.declare();
    expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    const component = ctx.repos.components.findById(f.component.id)!;
    expect(component.bindings.freshInitialization).toMatchObject({ progress: {
      phase: kind === 'volume' ? 'storage-attempted' : 'activation-attempted' } });
    const mutations = f.http.mutations.length;
    expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.http.mutations).toHaveLength(mutations);
    expect((await f.status()).drift.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe('database_initialization_pending');
  });


  it('leaves a completed initialization consumed when later ordinary maintenance needs reconciliation', async () => {
    const f = await fixture(); f.declare();
    expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: true } });
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { maintenance: { state: 'active' } });
    const mutations = f.http.mutations.length;
    expect((await f.plan()).scope).not.toBe('database-initialization');
    expect(f.http.mutations).toHaveLength(mutations);
  });

  it.each(['', '   '])('does not treat a duplicate binding with blank native scope %j as another proven database', async empty => {
    const f = await fixture(); f.declare();
    const other = ctx.repos.environments.create({ projectId: f.project.id, name: 'unknown-scope' });
    ctx.repos.components.create({ environmentId: other.id, type: 'postgres', externalId: f.component.externalId,
      bindings: { provider: 'railway', providerScope: { projectId: empty, environmentId: empty } } });
    const planned = await f.plan();
    expect(planned.actions).toEqual([]);
    expect(planned.blocked.length).toBeGreaterThan(0);
    expect(f.http.mutations).toEqual([]);
  });


  it('initializes the observed legacy binding with flattened projectId and environment-owned scope without rewriting that identity', async () => {
    const f = await fixture(); f.declare();
    const { providerScope: _scope, ...legacyBindings } = f.component.bindings;
    ctx.repos.components.update(f.component.id, { bindings: { ...legacyBindings, projectId } });
    const planned = await f.plan();
    expect(planned.scope).toBe('database-initialization');
    expect(await f.apply(planned)).toMatchObject({ kind: 'executed', result: { success: true } });
    const component = ctx.repos.components.findById(f.component.id)!;
    expect(component.externalId).toBe(f.component.externalId);
    expect(component.bindings).toMatchObject({ ...legacyBindings, projectId });
    expect(Object.hasOwn(component.bindings, 'providerScope')).toBe(false);
    expect(Object.hasOwn(component.bindings, 'environmentId')).toBe(false);
    expect(getCompletedDatabaseInitializationReceipt({ component, environment: f.environment })).toMatchObject({
      intentId: 'fresh-production', target: { provider: 'railway', externalId: f.component.externalId,
        providerScope: { projectId, environmentId: productionId } } });
  });

});
