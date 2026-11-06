import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { AdapterFactory } from '../../domain/services/adapter.factory.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { executePlanApply } from '../apply-plan.js';
import { createRailwayDatabaseAdapter } from '../../adapters/providers/railway/railway-database.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { applyDatabaseScopeBinding } from '../apply-database-scope-binding.js';
import { planDatabaseScopeBinding } from '../../domain/services/database-scope-binding.service.js';

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_ATTEMPTS', '1');
  vi.stubEnv('HYPERVIBE_RAILWAY_CREATE_VERIFY_DELAY_MS', '0');
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(':memory:').migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); });

async function setup() {
  let denyWorkflow = true;
  let afterRead: ((query: string) => void) | undefined;
  const http = await railwayHttpFixture({ renderVariableReferences: true, responseOverride: ({ query }) => {
    afterRead?.(query);
    return query.includes('DatabaseTemplateWorkflow') && denyWorkflow
      ? Response.json({ errors: [{ message: 'synthetic-private-provider-error' }] }, { status: 403 }) : undefined;
  } });
  // The actual create client acknowledges one template mutation and loses only
  // subsequent verification. The fixture executes the pinned official SDL.
  const attempted = await http.adapter.ensureComponent('postgres', http.environment);
  expect(attempted.receipt.success).toBe(false);
  expect(attempted.component.externalId).toBeNull();
  expect(attempted.component.bindings.databaseTemplate).toHaveProperty('workflowId');
  denyWorkflow = false;
  http.services.get('staging-Postgres')!.name = 'Postgres-GgfJ';
  http.mutations.length = 0;
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'contract-project', defaultPlatform: 'railway' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'railway', projectId, environmentId: stagingId,
  } });
  const production = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId, environmentId: productionId, services: { web: { serviceId: 'production-web' } },
  } });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: null,
    bindings: { ...attempted.component.bindings, provisioningIncomplete: true } });
  const stored = new SpecStore().replace(project, { version: 1, project: project.name,
    secrets: { SG_SCRIPT_KEY: { ownership: 'delegated', principal: 'github:owner', environments: ['staging'] } },
    environments: {
      production: { hosting: { provider: 'railway' }, services: { web: {} } },
      staging: { hosting: { provider: 'railway' }, database: { provider: 'railway' },
        deploy: { strategy: 'manual' }, services: { web: { volume: { mountPath: '/data' } } },
        envVars: { MARQR_MEDIA_DIR: '/data/marqr_media' } },
    } });
  const database = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter, envRepo: ctx.repos.environments });
  vi.spyOn(AdapterFactory.prototype, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: http.adapter });
  vi.spyOn(AdapterFactory.prototype, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: http.adapter as never });
  vi.spyOn(AdapterFactory.prototype, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: database });
  vi.spyOn(AdapterFactory.prototype, 'getDatabaseOperations').mockResolvedValue({ success: true, adapter: database });
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
  const plan = async () => {
    const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    return result;
  };
  const apply = async (result: Awaited<ReturnType<typeof plan>>, confirm = true) => executePlanApply(ctx, {
    project, spec: stored.spec, specRevision: stored.revision, planId: result.planRunId,
    confirmActions: confirm ? result.actions.map(action => action.id) : [],
  });
  return { ctx, project, environment, production, component, stored, http, database, plan, apply,
    onRead: (callback: (query: string) => void) => { afterRead = callback; } };
}

function replaceCandidate(http: Awaited<ReturnType<typeof setup>>['http']) {
  const originalId = 'staging-Postgres';
  const original = http.services.get(originalId)!;
  const variables = http.variables.get(`${originalId}/${stagingId}`)!;
  const source = structuredClone(original.instances.get(stagingId)!.source);
  http.services.delete(originalId);
  http.variables.delete(`${originalId}/${stagingId}`);
  delete http.environments.get(stagingId)!.config.services![originalId];
  for (const [id, volume] of http.volumes) if (volume.serviceId === originalId) http.volumes.delete(id);
  const replacement = http.addService('independent-candidate', 'Postgres-independent', stagingId);
  replacement.templateId = original.templateId;
  replacement.templateServiceId = original.templateServiceId;
  replacement.instances.get(stagingId)!.source = source;
  http.addVolume(replacement.id, stagingId, '/var/lib/postgresql/data');
  http.variables.set(`${replacement.id}/${stagingId}`, { ...variables,
    POSTGRES_PASSWORD: 'synthetic-independent-password', RAILWAY_PRIVATE_DOMAIN: 'independent.railway.internal' });
}

describe('retained database provision verification through the existing binding stage', () => {
  it('offers an explicitly reviewed candidate without claiming workflow lineage or replacing desired state', async () => {
    const f = await setup();
    const spec = new SpecStore().get(f.project);
    const production = f.ctx.repos.environments.findById(f.production.id);
    const result = await f.plan();
    expect(result.scope).toBe('database-bindings');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ requiresConfirm: true,
      metadata: { operation: 'databaseProvisionCandidateBinding', lineage: 'unproven', componentId: f.component.id } });
    expect(result.actions[0].id).toContain('staging-Postgres');
    expect(result.actions[0].reason).toContain('Workflow lineage is unproven');
    expect(result.inputRequired).toEqual([]);
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: true } });
    const saved = f.ctx.repos.components.findById(f.component.id)!;
    expect(saved.externalId).toBe('staging-Postgres');
    expect(saved.bindings).toMatchObject({ pluginName: 'Postgres-GgfJ', providerScope: { projectId, environmentId: stagingId },
      databaseTemplate: f.component.bindings.databaseTemplate });
    expect(saved.bindings).not.toHaveProperty('provisioningIncomplete');
    expect(saved.bindings).not.toHaveProperty('unresolvedMutation');
    expect(saved.bindings.provisionRecovery).toMatchObject({ selectionBasis: 'operator-confirmed-current-resource',
      reviewed: { operation: 'databaseProvisionCandidateBinding', lineage: 'unproven' } });
    expect(new SpecStore().get(f.project)).toEqual(spec);
    expect(f.ctx.repos.environments.findById(f.production.id)).toEqual(production);
    expect(f.http.mutations).toEqual([]);
    expect(f.http.contractErrors).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-provider-error');
    expect(JSON.stringify(result)).not.toContain('synthetic-provider-generated-password');
  });

  it('rejects the automatic recovery tag for an ID-less attempt even with exact confirmation', async () => {
    const f = await setup();
    const result = await f.plan();
    const { lineage: _lineage, ...metadata } = result.actions[0].metadata!;
    const forged = { ...result.actions[0], id: `database-recovery:railway:${f.component.id}`,
      metadata: { ...metadata, operation: 'databaseProvisionRecovery' } };
    expect(await applyDatabaseScopeBinding({ ctx: f.ctx, project: f.project, environmentName: 'staging',
      environmentSpec: f.stored.spec.environments.staging, specRevision: f.stored.revision,
      action: forged, confirmedActionIds: new Set([forged.id]) })).toMatchObject({ success: false });
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.http.mutations).toEqual([]);
  });

  it('can record replacement B only through its explicitly confirmed candidate selection, never as original-workflow proof', async () => {
    const f = await setup();
    replaceCandidate(f.http);
    const result = await f.plan();
    const action = result.actions[0];
    expect(action).toMatchObject({ metadata: { operation: 'databaseProvisionCandidateBinding', lineage: 'unproven',
      source: { primaryExternalId: 'independent-candidate' } } });
    expect(await executePlanApply(f.ctx, { project: f.project, spec: f.stored.spec, specRevision: f.stored.revision,
      planId: result.planRunId, confirmActions: [`database-recovery:railway:${f.component.id}`] }))
      .toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    // This exact action confirmation represents the operator selecting B,
    // with the reviewed warning; it is not inferred from the original create.
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.ctx.repos.components.findById(f.component.id)).toMatchObject({ externalId: 'independent-candidate',
      bindings: { provisionRecovery: { selectionBasis: 'operator-confirmed-current-resource', reviewed: { lineage: 'unproven' } } } });
    expect(f.http.mutations).toEqual([]);
    expect(f.http.contractErrors).toEqual([]);
  });

  it('never follows a replacement after the exact candidate plan was reviewed', async () => {
    const f = await setup();
    const result = await f.plan();
    replaceCandidate(f.http);
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.http.mutations).toEqual([]);
  });

  it('blocks when the desired project settings change during the final provider read', async () => {
    const f = await setup();
    const result = await f.plan();
    let changed = false;
    f.onRead(query => {
      if (!changed && query.includes('DatabaseCredentialAliasVariables')) {
        changed = true;
        const next = structuredClone(f.stored.spec);
        next.environments.staging.envVars.CONCURRENT = 'changed';
        new SpecStore().replace(f.project, next);
      }
    });
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(changed).toBe(true);
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.http.mutations).toEqual([]);
  });

  it('requires exact confirmation and rejects changed native evidence without recording the database', async () => {
    const f = await setup();
    const result = await f.plan();
    expect(await f.apply(result, false)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    f.http.services.get('staging-Postgres')!.instances.get(stagingId)!.source = { image: 'postgres:16' };
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.http.mutations).toEqual([]);
  });

  it.each(['component', 'environment'] as const)('preserves concurrent %s metadata written during provider verification', async target => {
    const f = await setup();
    const result = await f.plan();
    let changed = false;
    f.onRead(query => {
      if (!changed && query.includes('DatabaseCredentialAliasVariables')) {
        changed = true;
        if (target === 'component') f.ctx.repos.components.updateBindings(f.component.id, { concurrentAudit: 'retained' });
        else f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { concurrentAudit: 'retained' });
      }
    });
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.ctx.repos.components.findById(f.component.id)!.externalId).toBeNull();
    const metadata = target === 'component' ? f.ctx.repos.components.findById(f.component.id)!.bindings
      : f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    expect(metadata.concurrentAudit).toBe('retained');
    expect(f.http.mutations).toEqual([]);
  });

  it('atomically refuses a local change between the last read and the SQLite commit', async () => {
    const f = await setup();
    const result = await f.plan();
    const finalize = f.ctx.repos.components.finalizeProvisionIfUnchanged.bind(f.ctx.repos.components);
    vi.spyOn(f.ctx.repos.components, 'finalizeProvisionIfUnchanged').mockImplementation(input => {
      f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { competingWriter: 'preserved' });
      return finalize(input);
    });
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).not.toHaveProperty('databaseTopology');
    expect(f.http.mutations).toEqual([]);
  });

  it('atomically refuses a new spec revision between the last read and the SQLite commit', async () => {
    const f = await setup();
    const result = await f.plan();
    const finalize = f.ctx.repos.components.finalizeProvisionIfUnchanged.bind(f.ctx.repos.components);
    vi.spyOn(f.ctx.repos.components, 'finalizeProvisionIfUnchanged').mockImplementation(input => {
      const next = structuredClone(f.stored.spec);
      next.environments.staging.envVars.CONCURRENT = 'changed';
      new SpecStore().replace(f.project, next);
      return finalize(input);
    });
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(f.component);
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).not.toHaveProperty('databaseTopology');
    expect(f.http.mutations).toEqual([]);
  });

  it('does not expose malformed provider diagnostics in public plan warnings', async () => {
    const f = await setup();
    vi.spyOn(f.database.provisionRecovery!, 'inspect').mockResolvedValue({ state: 'unknown', phase: 'workflow',
      code: 'synthetic-private-provider-error' } as never);
    const result = await planDatabaseScopeBinding({ project: f.project, spec: f.stored.spec.environments.staging,
      environment: f.environment, components: [f.component], adapterFactory: f.ctx.adapterFactory });
    expect(result.actions).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-provider-error');
    expect(f.http.mutations).toEqual([]);
  });

  it('retries a failed repository export without a second metadata commit or provider write', async () => {
    const f = await setup();
    const result = await f.plan();
    vi.spyOn(f.ctx.repos.environments, 'syncRepoBindingsForId').mockImplementationOnce(() => { throw new Error('Synthetic export unavailable'); });
    const failed = await f.apply(result);
    expect(failed).toMatchObject({ kind: 'executed', result: { success: false } });
    const recorded = f.ctx.repos.components.findById(f.component.id)!;
    expect(recorded.externalId).toBe('staging-Postgres');
    expect(await f.apply(result)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.ctx.repos.components.findById(f.component.id)).toEqual(recorded);
    expect(f.http.mutations).toEqual([]);
  });

  it('keeps recovery actions inside their single-action metadata-only scope', async () => {
    const f = await setup();
    const result = await f.plan();
    const document = f.ctx.repos.runs.findById(result.planRunId)!.plan;
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    expect(planRunDocumentSchema.safeParse({ ...document, scope: 'full' }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [...result.actions, result.actions[0]] }).success).toBe(false);
    const forged = { ...result.actions[0], requiresConfirm: false };
    expect(await applyDatabaseScopeBinding({ ctx: f.ctx, project: f.project, environmentName: 'staging',
      environmentSpec: f.stored.spec.environments.staging, action: forged,
      confirmedActionIds: new Set([forged.id]) })).toMatchObject({ success: false });
    expect(f.http.mutations).toEqual([]);
  });
});
