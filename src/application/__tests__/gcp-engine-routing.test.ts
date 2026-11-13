import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { registerHvDeployTools } from '../../tools/hv-deploy.tools.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import * as engine from '../infrastructure-engine.js';
import * as bootstrap from '../../domain/services/gcp-bootstrap.service.js';
import { launchEnvironment } from '../launch.js';
import { secretAges } from '../secret-rotation.js';
import { executePlanApply } from '../apply-plan.js';
import { ConvergeExecutor } from '../../domain/plan/converge.executor.js';
import { firstProviderSpecValidationFailure } from '../../domain/services/provider-spec-validation.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';

// The product contract selects OpenTofu for every Cloud Run environment.
// Public command routing is real; terminal operations prohibit cloud mutations.
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-gcp-routing-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in routing probe'); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(provider: 'railway' | 'cloudrun', engineChoice?: 'opentofu') {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'routing-investigation', defaultPlatform: provider });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    staging: { hosting: { provider, ...(engineChoice ? { engine: engineChoice } : {}) }, services: { web: {} } },
  } });
  const commands = new CommandRegistry();
  registerCoreTools(commands, ctx);
  registerHvDeployTools(commands, ctx);
  const release = vi.spyOn(engine, 'releaseEngineServices').mockResolvedValue({ blocked: 'ENGINE_RELEASE_REACHED' });
  const infrastructure = vi.spyOn(engine, 'planInfrastructureEngine').mockResolvedValue({ blocked: ['ENGINE_PLAN_REACHED'] });
  const plan = vi.spyOn(PlanService.prototype, 'plan').mockResolvedValue({ error: 'LEGACY_PLANNER_REACHED' } as never);
  return { ctx, project, spec, commands, release, plan, infrastructure };
}

describe('GCP engine public routing', () => {
  it.each([undefined, 'opentofu'] as const)('accepts hv_spec with engine=%s', async engineChoice => {
    const f = fixture('cloudrun', engineChoice);
    const result = await f.commands.execute('hv_spec', { project: f.project.name, spec: f.spec });
    expect(result.ok, 'Every Cloud Run spec selects OpenTofu').toBe(true);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.plan).not.toHaveBeenCalled();
  });

  it.each([undefined, 'opentofu'] as const)('routes hv_deploy with persisted engine=%s', async engineChoice => {
    const f = fixture('cloudrun', engineChoice);
    // Existing persisted specs can predate the current provider maturity gate.
    new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
    const result = await f.commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
    expect(f.release, 'Every Cloud Run deployment reaches the engine release boundary').toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, error: { message: 'ENGINE_RELEASE_REACHED' } });
    expect(f.plan).not.toHaveBeenCalled();
  });

  it('retains Railway public spec writes and legacy deploy routing', async () => {
    const f = fixture('railway');
    const saved = await f.commands.execute('hv_spec', { project: f.project.name, spec: f.spec });
    expect(saved.ok).toBe(true);
    const deployed = await f.commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
    expect(deployed).toMatchObject({ ok: false, error: { message: 'LEGACY_PLANNER_REACHED' } });
    expect(f.plan).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
  });

  it('infers the engine from the GCP provider for previously saved specs', () => {
    const absent = projectSpecSchema.parse({ version: 1, project: 'routing-probe', environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } } } });
    const explicit = projectSpecSchema.parse({ version: 1, project: 'routing-probe', environments: { staging: { hosting: { provider: 'cloudrun', engine: 'opentofu' }, services: { web: {} } } } });
    expect(absent.environments.staging.hosting.engine).toBeUndefined();
    expect(engine.isEngineManaged(absent.environments.staging)).toBe(true);
    expect(engine.isEngineManaged(explicit.environments.staging)).toBe(true);
  });
  it.each([undefined, 'full', 'infrastructure'] as const)('routes hv_plan scope=%s to OpenTofu', async scope => {
    const f = fixture('cloudrun');
    new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', ...(scope ? { scope } : {}) });
    expect(f.infrastructure).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, error: { details: { blocked: ['ENGINE_PLAN_REACHED'] } } });
    expect(f.plan).not.toHaveBeenCalled();
  });

  it.each(['retained-cleanup', 'secrets', 'database-credential-aliases', 'backups'])('rejects unsupported GCP scope=%s before either planner', async scope => {
    const f = fixture('cloudrun');
    new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(`scope="${scope}" is not supported`) } });
    expect(f.plan).not.toHaveBeenCalled();
    expect(f.infrastructure).not.toHaveBeenCalled();
  });

  it('routes exact credential operations to their scoped planner without admitting infrastructure', async () => {
    const f = fixture('cloudrun');
    const withUnsupportedFutureIntent = projectSpecSchema.parse({ ...f.spec, environments: { staging: {
      ...f.spec.environments.staging, email: { enabled: true },
    } } });
    new ProjectSpecRepository().insert(f.project.id, 1, withUnsupportedFutureIntent);
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'credentials',
      credential: 'database-login', intent: 'rotate' });
    expect(result).toMatchObject({ ok: false, error: { message: 'LEGACY_PLANNER_REACHED' } });
    expect(f.plan).toHaveBeenCalledWith(expect.objectContaining({ id: f.project.id }), 'staging',
      { scope: 'credentials', credential: 'database-login', intent: 'rotate' });
    expect(f.infrastructure).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects infrastructure actions relabeled as a credential plan before any executor', async () => {
    const f = fixture('cloudrun');
    const environment = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'staging' });
    const run = f.ctx.repos.runs.create({ projectId: f.project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'credentials', environmentName: 'staging', specRevision: 1,
        observedFingerprint: null, lockEnvironmentIds: [environment.id], overrides: { delegatedSecretVarsEncrypted: 'not-a-credential-plan' },
        actions: [{ id: 'service:web', type: 'create', resource: { kind: 'service', name: 'web', provider: 'cloudrun' }, verified: true, reason: 'Unreviewed infrastructure' }] } });
    const execute = vi.spyOn(ConvergeExecutor.prototype, 'execute').mockRejectedValue(new Error('UNAUTHORIZED_EXECUTOR_REACHED'));
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: run.id, confirmActions: ['service:web'] });
    expect(result).toMatchObject({ kind: 'plan_not_found' });
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an engine selection for a provider that engine does not implement', async () => {
    const f = fixture('railway', 'opentofu');
    const result = await f.commands.execute('hv_spec', { project: f.project.name, spec: f.spec });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('is not supported with hosting.provider="railway"') } });
    new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
    const deployed = await f.commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
    expect(deployed.ok).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.plan).not.toHaveBeenCalled();
  });

  it('admits engine-supported GCP capabilities while keeping legacy writers planned', () => {
    const f = fixture('cloudrun');
    const supported = projectSpecSchema.parse({ ...f.spec, environments: { staging: {
      ...f.spec.environments.staging,
      database: { provider: 'cloudsql' }, cache: { provider: 'memorystore' },
      storage: { uploads: { provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: ['web'] } }, queues: { jobs: {} },
    } } });
    expect(firstProviderSpecValidationFailure(supported)).toBeUndefined();
    expect(providerRegistry.lifecycleMaturity('cloudrun', 'hosting')?.status).toBe('planned');
    expect(providerRegistry.lifecycleMaturity('cloudsql', 'database')?.status).toBe('planned');
  });

  it('keeps validation scoped in a mixed Railway/GCP project', async () => {
    const f = fixture('railway');
    const mixed = projectSpecSchema.parse({ ...f.spec, environments: { ...f.spec.environments,
      gcp: { hosting: { provider: 'cloudrun' }, services: {}, email: { enabled: true } },
    } });
    new ProjectSpecRepository().insert(f.project.id, 1, mixed);
    const deployed = await f.commands.execute('hv_deploy', { project: f.project.name, env: 'staging' });
    expect(deployed).toMatchObject({ ok: false, error: { message: 'LEGACY_PLANNER_REACHED' } });
    expect(firstProviderSpecValidationFailure(mixed, 'gcp')).toMatchObject({ message: expect.stringContaining('email is not yet managed') });
    expect(f.release).not.toHaveBeenCalled();
  });

  it('fails closed for direct legacy PlanService calls with an old GCP spec', async () => {
    const f = fixture('cloudrun');
    f.plan.mockRestore();
    new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
    const result = await new PlanService().plan(f.project, 'staging');
    expect(result).toMatchObject({ error: expect.stringContaining('managed by the OpenTofu engine') });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks applying a legacy GCP plan before its executor can mutate', async () => {
    const f = fixture('cloudrun');
    const environment = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'staging' });
    const run = f.ctx.repos.runs.create({ projectId: f.project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'full', environmentName: 'staging', specRevision: 1,
        observedFingerprint: null, actions: [{ id: 'service:web', type: 'create', resource: { kind: 'service', name: 'web', provider: 'cloudrun' }, verified: true, reason: 'Old provider plan' }] } });
    const execute = vi.spyOn(ConvergeExecutor.prototype, 'execute').mockRejectedValue(new Error('LEGACY_EXECUTOR_REACHED'));
    const result = await executePlanApply(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, planId: run.id, confirmActions: ['service:web'] });
    expect(result).toMatchObject({ kind: 'blocked', applyBlocked: [{ reason: expect.stringContaining('requires an OpenTofu plan') }] });
    expect(execute).not.toHaveBeenCalled();
  });

  it('launches a saved GCP spec without an engine flag', async () => {
    const f = fixture('cloudrun');
    vi.spyOn(engine, 'engineGcpAdapter').mockResolvedValue(undefined);
    const prepare = vi.spyOn(bootstrap, 'runGcpBootstrap').mockResolvedValue({ success: false, mode: 'preview', error: 'BOOTSTRAP_REACHED' });
    const result = await launchEnvironment(f.ctx, { project: f.project, spec: f.spec, specRevision: 1, environmentName: 'staging' });
    expect(prepare).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'blocked', message: 'BOOTSTRAP_REACHED' });
  });

  it('blocks unsupported GCP intent before launch creates an account or grants access', async () => {
    const f = fixture('cloudrun');
    const unsupported = projectSpecSchema.parse({ ...f.spec, environments: { staging: { ...f.spec.environments.staging, email: { enabled: true } } } });
    const adapter = vi.spyOn(engine, 'engineGcpAdapter').mockResolvedValue(undefined);
    const prepare = vi.spyOn(bootstrap, 'runGcpBootstrap').mockResolvedValue({ success: false, mode: 'preview', error: 'BOOTSTRAP_REACHED' });
    const result = await launchEnvironment(f.ctx, { project: f.project, spec: unsupported, specRevision: 1, environmentName: 'staging' });
    expect(result).toMatchObject({ status: 'blocked', message: expect.stringContaining('email is not yet managed') });
    expect(prepare).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });

  it('uses engine status for a saved GCP spec without an engine flag', async () => {
    const f = fixture('cloudrun');
    new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
    const status = vi.spyOn(engine, 'engineWorkerStatus').mockResolvedValue({ blocked: 'ENGINE_STATUS_REACHED' });
    const result = await f.commands.execute('hv_status', { project: f.project.name, env: 'staging' });
    expect(status).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, error: { message: 'ENGINE_STATUS_REACHED' } });
  });

  it('uses the engine secret boundary for a saved GCP spec without an engine flag', async () => {
    const f = fixture('cloudrun');
    const context = vi.spyOn(engine, 'resolveEngineContext').mockResolvedValue({ blocked: 'ENGINE_SECRET_CONTEXT_REACHED' });
    const result = await secretAges(f.ctx, f.project, f.spec, 'staging');
    expect(context).toHaveBeenCalledOnce();
    expect(result).toEqual({ blocked: 'ENGINE_SECRET_CONTEXT_REACHED' });
    expect(fetch).not.toHaveBeenCalled();
  });

});
