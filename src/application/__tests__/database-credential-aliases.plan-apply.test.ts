import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter, getDb } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService, type PlanOptions } from '../../domain/plan/plan.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import '../providers.js';

// Shared lifecycle fixture, not Railway transport or live reference-resolution proof.
let root: string;
let ctx: ReturnType<typeof createCommandContext>;
let project: ReturnType<typeof ctx.repos.projects.create>;
let component: ReturnType<typeof ctx.repos.components.create>;
let spec: ProjectSpec;
let revision: number;
let converged: boolean;
let inspect: ReturnType<typeof vi.fn>;
let repair: ReturnType<typeof vi.fn>;
let writes: number;
const secret = 'private-issuer-fixture-never-public';
const names = ['DATABASE_PRIVATE_URL', 'DATABASE_URL', 'PGPASSWORD'];
const target = { provider: 'railway', resourceId: 'database-id', providerScope: { projectId: 'provider-project', environmentId: 'production-id' } };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hypervibe-aliases-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  ctx = createCommandContext(); project = ctx.repos.projects.create({ name: 'alias-test', defaultPlatform: 'railway' });
  spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'railway' }, services: { web: {} }, database: { provider: 'railway', credentialAliases: { mode: 'issuer-references' } },
  } } });
  revision = new SpecStore().replace(project, spec).revision;
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'provider-project', environmentId: 'production-id', services: { web: { serviceId: 'web-id' } },
  } });
  component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: target.resourceId,
    bindings: { provider: 'railway', providerScope: target.providerScope } });
  converged = false; writes = 0;
  inspect = vi.fn(async () => ({ target, checkedNames: names, changeNames: converged ? [] : names, privateState: { password: secret } }));
  repair = vi.fn(async ({ allowWrite, beforeWrite }) => {
    if (!converged && allowWrite) {
      await beforeWrite();
      expect(ctx.repos.components.findById(component.id)!.bindings.credentialAliasRepair).toBeDefined();
      expect(JSON.stringify(getDb().prepare('SELECT bindings FROM components WHERE id=?').get(component.id))).not.toContain(secret);
      writes++; converged = true;
      return { success: true, message: 'verified', data: { requestedCount: 3, appliedCount: 3, skippedCount: 0,
        referencesVerified: true, deploymentDeferred: true, authentication: 'unchecked' } };
    }
    return { success: converged, message: 'readback', data: { requestedCount: 3, appliedCount: 0, skippedCount: 3,
      referencesVerified: converged, deploymentDeferred: true, authentication: 'unchecked' } };
  });
  vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: { credentialAliases: { inspect, repair } } as any });
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockRejectedValue(new Error('unrelated hosting must not be observed'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true }); });
async function plan(options: PlanOptions = { scope: 'database-credential-aliases' } as PlanOptions) {
  const result = await new PlanService().plan(project, 'production', options);
  if ('error' in result) throw new Error(result.error);
  return result;
}
async function apply(planned: Awaited<ReturnType<typeof plan>>, confirmed = true) {
  return executePlanApply(ctx, { project, spec, specRevision: revision, planId: planned.planRunId,
    confirmActions: confirmed ? planned.actions.map(action => action.id) : [] });
}

describe('database credential alias plan/apply', () => {
  it('isolates the database action and encrypts private evidence before provider writes', async () => {
    const planned = await plan();
    expect(planned.blocked).toEqual([]); expect(planned.actions).toHaveLength(1);
    expect(planned.actions[0]).toMatchObject({ resource: { kind: 'database', provider: 'railway' }, requiresConfirm: true });
    expect(JSON.stringify(planned)).not.toContain(secret);
    expect(JSON.stringify(ctx.repos.runs.findById(planned.planRunId)!.plan)).not.toContain(secret);
    expect(writes).toBe(0);
    const result = await apply(planned);
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } }); expect(writes).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('unchecked');
    expect(ctx.repos.components.findById(component.id)!.bindings.credentialAliasRepair).toBeUndefined();
    expect(PlanService.prototype.observeEnvironment).not.toHaveBeenCalled();
  });
  it('makes no writes without exact confirmation', async () => {
    await apply(await plan(), false); expect(writes).toBe(0); expect(repair).not.toHaveBeenCalled();
  });
  it('rejects broadened, tampered or cross-scope plan authority', async () => {
    const planned = await plan(); const document = ctx.repos.runs.findById(planned.planRunId)!.plan as any;
    expect(planRunDocumentSchema.safeParse({ ...document, scope: 'full' }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [{ ...document.actions[0], requiresConfirm: false }] }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [{ ...document.actions[0], metadata: { ...document.actions[0].metadata, privateState: { password: secret } } }] }).success).toBe(false);
  });
  it('blocks unknown observation without exposing provider diagnostics', async () => {
    inspect.mockRejectedValue(new Error(secret));
    const planned = await plan(); expect(planned.actions).toEqual([]); expect(planned.blocked).toHaveLength(1);
    expect(JSON.stringify(planned)).not.toContain(secret); expect(writes).toBe(0);
  });
  it('recovers an uncertain write by readback without repeating it', async () => {
    repair.mockImplementationOnce(async ({ beforeWrite }) => { await beforeWrite(); writes++; converged = true; throw new Error(secret); });
    expect(await apply(await plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findById(component.id)!.bindings.credentialAliasRepair).toBeDefined();
    expect(await apply(await plan())).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(repair.mock.calls[1][0].allowWrite).toBe(false); expect(writes).toBe(1);
  });
  it('verifies already-correct aliases without any provider mutations', async () => {
    converged = true; const planned = await plan(); expect(planned.actions).toEqual([]);
    expect(await apply(planned)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toBe(0); expect(repair).not.toHaveBeenCalled();
  });
  it('blocks stale noops instead of silently repairing them', async () => {
    converged = true; const planned = await plan(); converged = false;
    expect(await apply(planned)).toMatchObject({ kind: 'blocked' }); expect(writes).toBe(0);
  });
  it('returns an isolated prerequisite from full planning only while aliases need repair', async () => {
    expect(await plan({ scope: 'full' })).toMatchObject({ scope: 'database-credential-aliases', actions: [expect.anything()] });
    converged = true;
    // Once converged, ordinary planning reaches its own next prerequisite rather than returning this scope forever.
    vi.mocked(PlanService.prototype.observeEnvironment).mockResolvedValue({ observed: null, warnings: [] });
    const result = await new PlanService().plan(project, 'production', { scope: 'full', includeEnvFile: false });
    expect('scope' in result ? result.scope : undefined).not.toBe('database-credential-aliases');
  });
  it('rejects deployment or local input overrides', async () => {
    const result = await new PlanService().plan(project, 'production', { scope: 'database-credential-aliases', envVarOverrides: { X: 'value' } } as PlanOptions);
    expect(result).toHaveProperty('error'); expect(inspect).not.toHaveBeenCalled();
  });
  it('rejects another environment sharing the exact database identity', async () => {
    const staging = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
    ctx.repos.components.create({ environmentId: staging.id, type: 'postgres', externalId: target.resourceId,
      bindings: { provider: 'railway', providerScope: target.providerScope } });
    const planned = await plan(); expect(planned.blocked).toHaveLength(1); expect(writes).toBe(0);
  });
  it('keeps incomplete repair receipts pending and prevents an automatic second write', async () => {
    repair.mockImplementationOnce(async ({ beforeWrite }) => {
      await beforeWrite(); writes++;
      return { success: false, message: secret, data: { appliedCount: null, skippedCount: null, requestedCount: 3 } };
    });
    const first = await apply(await plan()); expect(JSON.stringify(first)).not.toContain(secret);
    expect(await apply(await plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(writes).toBe(1); expect(repair.mock.calls[1][0].allowWrite).toBe(false);
    expect(ctx.repos.components.findById(component.id)!.bindings.credentialAliasRepair).toBeDefined();
  });
  it('rejects database scope changes after planning', async () => {
    const planned = await plan();
    ctx.repos.components.updateBindings(component.id, { providerScope: { ...target.providerScope, environmentId: 'staging-id' } });
    expect(await apply(planned)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(repair).not.toHaveBeenCalled(); expect(writes).toBe(0);
  });
  it('blocks an active password rotation before provider inspection', async () => {
    ctx.repos.components.updateBindings(component.id, { credentialRotation: { phase: 'attempted' } });
    expect((await plan()).blocked).toHaveLength(1); expect(inspect).not.toHaveBeenCalled();
  });
  it('preserves changed recovery ownership after an awaited provider write', async () => {
    const original = repair.getMockImplementation() as (input: any) => Promise<unknown>;
    repair.mockImplementationOnce(async input => {
      const receipt = await original(input);
      const saved = ctx.repos.components.findById(component.id)!.bindings.credentialAliasRepair as any;
      ctx.repos.components.updateBindings(component.id, { credentialAliasRepair: { ...saved,
        metadata: { ...saved.metadata, environmentFingerprint: 'b'.repeat(64) } } });
      return receipt;
    });
    expect(await apply(await plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findById(component.id)!.bindings.credentialAliasRepair).toBeDefined();
  });
});
