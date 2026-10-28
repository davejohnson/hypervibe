import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ComponentRepository } from '../../../adapters/db/repositories/component.repository.js';
import { createCommandContext } from '../../../application/context.js';
import { projectSpecSchema, type ProjectSpec } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { applyDatabaseFreshInitialization, planDatabaseFreshInitialization } from '../database-fresh-initialization.service.js';
import { getCompletedDatabaseInitializationReceipt } from '../../plan/database-initialization.contract.js';
import type { DatabaseFreshInitializationProgress, IDatabaseFreshInitialization } from '../../ports/database-fresh-initialization.port.js';
import '../../../application/providers.js';

// Real SQLite and encrypted lifecycle persistence with synthetic provider
// completion. Railway's separate HTTP regressions prove successor admission.
let directory: string, ctx: ReturnType<typeof createCommandContext>;
let project: ReturnType<typeof ctx.repos.projects.create>, environment: ReturnType<typeof ctx.repos.environments.create>;
let component: ReturnType<typeof ctx.repos.components.create>, spec: ProjectSpec;
let providerApply: ReturnType<typeof vi.fn<IDatabaseFreshInitialization['apply']>>;
const target = { provider: 'railway', externalId: 'native-database', providerScope: { projectId: 'native-project', environmentId: 'native-environment' } };
const activationReconciliation = { version: 1 as const, kind: 'storage-attachment' as const, deploymentId: 'verified-successor', operationId: 'owned-attachment' };
const acknowledged = { phase: 'activation-identified' as const, storageId: 'owned-storage', storageInstanceId: 'owned-instance', deploymentId: 'original-acknowledgment' };
const storageBindings = { volumeId: acknowledged.storageId, volumeInstanceId: acknowledged.storageInstanceId };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-initialization-domain-'));
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(join(directory, 'test.db')).migrate();
  ctx = createCommandContext(); project = ctx.repos.projects.create({ name: 'initialization-domain', defaultPlatform: 'railway' });
  environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: target.provider, ...target.providerScope, appliedSpecHash: 'preserved-application-marker' } });
  component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: target.externalId,
    bindings: { provider: target.provider, providerScope: target.providerScope } });
  spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'railway' }, services: {}, database: { provider: 'railway', freshInitialization: {
      id: 'initialize-once', discardExistingData: true, target: { externalId: target.externalId, providerScope: target.providerScope } } } } } });
  providerApply = vi.fn(async input => {
    if (input.progress.phase === 'prepared') await input.saveProgress(acknowledged);
    const progress: DatabaseFreshInitializationProgress = { ...acknowledged, phase: 'complete', activationReconciliation };
    await input.saveProgress(progress);
    return { state: 'complete', progress, storageBindings };
  });
  vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: { name: 'railway', freshInitialization: {
    inspect: async () => ({ state: 'eligible', inspection: { target, configurationFingerprint: 'a'.repeat(64), privateConfiguration: { privateSentinel: 'never-render-this-review' } } }),
    apply: providerApply,
  } } as any });
});
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
async function plan() {
  const result = await planDatabaseFreshInitialization({ project, spec, revision: 1, environmentName: 'production' });
  if (!result || 'error' in result) throw new Error('Expected isolated initialization plan.');
  expect(result.blocked).toEqual([]); expect(result.actions).toHaveLength(1); return result;
}
async function apply(planned: Awaited<ReturnType<typeof plan>>) {
  const document = ctx.repos.runs.findById(planned.planRunId)!.plan as any;
  return applyDatabaseFreshInitialization({ project, spec: spec.environments.production, environmentName: 'production',
    action: planned.actions[0], confirmed: new Set([planned.actions[0].id]), encrypted: document.overrides.databaseInitializationEncrypted });
}
const retained = () => ctx.repos.components.findById(component.id)!.bindings.freshInitialization as any;

describe('fresh initialization reconciled completion persistence', () => {
  it.each([
    ['unknown', 'deployment-replaced'], ['failed', 'deployment-failed'], ['pending', 'deployment-pending'],
  ] as const)('retains the bounded %s outcome and diagnostic without exposing the provider reason', async (state, code) => {
    const diagnostic = { stage: 'activation' as const, code };
    providerApply.mockImplementation(async input => {
      await input.saveProgress(acknowledged);
      return { state, progress: acknowledged, diagnostic, reason: 'provider-secret-sentinel-in-ordinary-reason' };
    });
    const result = await apply(await plan());
    expect(result).toMatchObject({ success: false, status: 'blocked', data: {
      providerState: state, diagnostic, acknowledgedProgress: acknowledged, recoveryRequired: true,
    } });
    expect(JSON.stringify(result)).not.toContain('provider-secret-sentinel-in-ordinary-reason');
    expect(retained().progress).toEqual(acknowledged); expect(retained().completed).toBeUndefined();
  });

  it.each([
    { stage: 'activation', code: 'provider-secret-sentinel' },
    { stage: 'provider-secret-sentinel', code: 'deployment-unverified' },
    { stage: 'activation', code: 'deployment-unverified', detail: 'provider-secret-sentinel' },
    'provider-secret-sentinel',
  ])('drops invalid diagnostic %# while preserving validated state and acknowledgments', async diagnostic => {
    providerApply.mockImplementation(async input => {
      await input.saveProgress(acknowledged);
      return { state: 'unknown', progress: acknowledged, diagnostic, reason: 'provider-secret-sentinel' } as any;
    });
    const result = await apply(await plan());
    expect(result).toMatchObject({ success: false, status: 'blocked', data: { providerState: 'unknown', acknowledgedProgress: acknowledged } });
    expect(result.data).not.toHaveProperty('diagnostic');
    expect(JSON.stringify(result)).not.toContain('provider-secret-sentinel');
  });

  it('does not project an invalid provider state as public diagnostic text', async () => {
    providerApply.mockImplementation(async input => {
      await input.saveProgress(acknowledged);
      return { state: 'provider-secret-sentinel', progress: acknowledged, reason: 'provider-secret-sentinel' } as any;
    });
    const result = await apply(await plan());
    expect(result).toMatchObject({ success: false, status: 'blocked', data: { acknowledgedProgress: acknowledged } });
    expect(result.data).not.toHaveProperty('providerState');
    expect(JSON.stringify(result)).not.toContain('provider-secret-sentinel');
  });

  it('atomically records the reconciled activation beside the immutable original acknowledgment', async () => {
    const planned = await plan();
    const result = await apply(planned);
    expect(result).toMatchObject({ success: true, data: { databaseConfigurationVerified: true, sqlAccess: 'unchecked' } });
    expect(retained()).toMatchObject({ progress: { ...acknowledged, phase: 'complete', activationReconciliation },
      completed: { deploymentId: acknowledged.deploymentId, activationReconciliation }, storageBindings });
    expect(getCompletedDatabaseInitializationReceipt({ component: ctx.repos.components.findById(component.id)!, environment }))
      .toMatchObject({ deploymentId: acknowledged.deploymentId, activationReconciliation });
    expect(JSON.stringify(result)).not.toContain('never-render-this-review');
    expect(await apply(planned)).toMatchObject({ success: true, data: { providerMutations: 0 } });
    expect(providerApply).toHaveBeenCalledOnce();
    expect(ctx.repos.environments.findById(environment.id)!.platformBindings.appliedSpecHash).toBe('preserved-application-marker');
  });

  it('retains the acknowledged attempt when the atomic reconciled receipt cannot be read back', async () => {
    const original = ComponentRepository.prototype.updateBindings;
    let rejectCompletion = true;
    vi.spyOn(ComponentRepository.prototype, 'updateBindings').mockImplementation(function (this: ComponentRepository, id, bindings) {
      if (rejectCompletion && (bindings.freshInitialization as any)?.progress?.phase === 'complete') return this.findById(id);
      return original.call(this, id, bindings);
    });
    const planned = await plan();
    expect(await apply(planned)).toMatchObject({ success: false, status: 'blocked', message: 'Database initialization completion could not be persisted.' });
    expect(retained().progress).toEqual(acknowledged); expect(retained().completed).toBeUndefined();
    expect(ctx.repos.components.findById(component.id)!.bindings.volumeId).toBeUndefined();
    rejectCompletion = false;
    expect(await apply(planned)).toMatchObject({ success: true });
    expect(providerApply.mock.calls[1][0].progress).toEqual(acknowledged);
    expect(retained().completed).toMatchObject({ deploymentId: acknowledged.deploymentId, activationReconciliation });
  });

  it('rejects replacing the acknowledged deployment even when the provider claims completion', async () => {
    providerApply.mockImplementation(async input => {
      await input.saveProgress(acknowledged);
      return { state: 'complete', progress: { ...acknowledged, phase: 'complete', deploymentId: 'different-acknowledgment', activationReconciliation }, storageBindings };
    });
    expect(await apply(await plan())).toMatchObject({ success: false, status: 'blocked' });
    expect(retained().progress).toEqual(acknowledged); expect(retained().completed).toBeUndefined();
    expect(ctx.repos.components.findById(component.id)!.bindings.volumeId).toBeUndefined();
  });
});
