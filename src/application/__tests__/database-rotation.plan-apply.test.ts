import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter, getDb } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { projectSpecSchema, type ProjectSpec } from '../../domain/spec/spec.schema.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { hashEnvValue, type ObservedState } from '../../domain/ports/observe.port.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { databaseCredentialRotationTargetSchema } from '../../domain/ports/database-password-rotation.port.js';
import * as maintenanceObservation from '../../domain/services/environment-maintenance.service.js';
import '../providers.js';

// Stateful orchestration fixture, not a provider contract. The separate real
// Supabase transport + PostgreSQL suites establish native behavior. These
// checks exercise persisted plan authority, encrypted intent, retries and the
// practical requirement to change issuer credentials before host variables.
let root: string;
let ctx: ReturnType<typeof createCommandContext>;
let project: ReturnType<typeof ctx.repos.projects.create>;
let environment: ReturnType<typeof ctx.repos.environments.create>;
let component: ReturnType<typeof ctx.repos.components.create>;
let spec: ProjectSpec;
let revision: number;
let observed: ObservedState;
let activePassword: string;
let reset: ReturnType<typeof vi.fn>;
let install: ReturnType<typeof vi.fn>;
const initialPassword = 'previous-db-password-test-only';
const target = databaseCredentialRotationTargetSchema.parse({ provider: 'supabase', resourceId: 'exact-db',
  providerScope: { organizationId: 'org', region: 'region' }, username: 'postgres', database: 'postgres',
  endpoints: [{ kind: 'direct', host: 'db.exact-db.supabase.co', port: 5432, username: 'postgres', database: 'postgres', expectedRole: 'postgres' }] });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hypervibe-db-password-')); SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  ctx = createCommandContext();
  project = ctx.repos.projects.create({ name: 'password-test', defaultPlatform: 'railway' });
  spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: {
    hosting: { provider: 'railway' }, services: { web: { startCommand: 'npm start' }, worker: { workloadKind: 'worker', startCommand: 'npm run worker' } },
    maintenance: { enabled: true }, database: { provider: 'supabase', engine: 'postgres',
      credentialRotation: { generation: 1, consumers: 'environment-only', destinations: 'trusted' } },
  } } });
  revision = new SpecStore().replace(project, spec).revision;
  environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'host-project', environmentId: 'host-environment',
    services: { web: { serviceId: 'web-id' }, worker: { serviceId: 'worker-id' } },
  } });
  for (const name of ['web', 'worker']) ctx.repos.services.create({ projectId: project.id, name });
  component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'exact-db', bindings: {
    provider: 'supabase', providerScope: target.providerScope, host: target.endpoints[0].host, username: 'postgres', database: 'postgres', port: 5432,
    password: initialPassword, connectionString: `postgresql://postgres:${initialPassword}@${target.endpoints[0].host}:5432/postgres`,
  } });
  observed = { provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, services: ['web', 'worker'].map(name => ({
    name, externalId: `${name}-id`, workloadKind: name === 'web' ? 'web' : 'worker', sourceState: 'disconnected',
    status: 'running', customDomains: [], config: {}, envVarKeys: [], envVarHashes: {},
    })), databases: [], warnings: [], partial: false, maintenance: { state: 'active', stage: 'verified', edge: { state: 'active', hostname: 'example.test', markerVerified: true },
    database: { state: 'fenced' }, workloads: Object.fromEntries(['web', 'worker'].map(name => [name, { serviceId: `${name}-id`, workloadKind: name, state: 'suspended' }])) } };
  activePassword = initialPassword;
  reset = vi.fn(async ({ replacementPassword }) => {
    const persisted = ctx.repos.components.findById(component.id)!.bindings.credentialRotation as any;
    expect(persisted).toMatchObject({ phase: 'attempted', oldPassword: initialPassword, replacementPassword });
    const raw = JSON.stringify(getDb().prepare('SELECT bindings FROM components WHERE id=?').get(component.id));
    expect(raw).not.toContain(initialPassword); expect(raw).not.toContain(replacementPassword);
    activePassword = replacementPassword;
    return { status: 'acknowledged', mutationAttempted: true };
  });
  install = vi.fn(async (_environment, service, vars) => {
    expect(activePassword).not.toBe(initialPassword);
    const found = observed.services.find(s => s.name === service.name)!;
    found.envVarKeys = Object.keys(vars);
    found.envVarHashes = Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, hashEnvValue(String(value))]));
    return { success: true, message: 'Configured' };
  });
  vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: { passwordRotation: {
    strategy: 'replace-in-place', observeTarget: vi.fn(async () => target), replacePassword: reset,
    verifyPassword: vi.fn(async ({ password }) => ({ status: password === activePassword ? 'accepted' : 'rejected',
      endpoints: [{ kind: 'direct', status: password === activePassword ? 'accepted' : 'rejected' }], existingSessions: 'unchecked' })),
  } } as any });
  vi.spyOn(adapterFactory, 'getHostingAdapterByName').mockResolvedValue({ success: true, adapter: {
    capabilities: { supportsDeferredSecretUpdates: true }, setEnvVars: install,
  } as any });
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(async () => ({ observed, warnings: [] }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(root, { recursive: true, force: true }); });
async function plan() {
  const result = await new PlanService().plan(project, 'production', { scope: 'database-rotation' });
  if ('error' in result) throw new Error(result.error);
  return result;
}
async function apply(planned: Awaited<ReturnType<typeof plan>>, confirm = true) {
  return executePlanApply(ctx, { project, spec, specRevision: revision, planId: planned.planRunId,
    confirmActions: confirm ? planned.actions.map(a => a.id) : [] });
}

describe('database password plan/apply', () => {
  it('includes shared maintenance evidence through the real scoped hosting observation path', async () => {
    vi.mocked(PlanService.prototype.observeEnvironment).mockRestore();
    const { maintenance, ...hostingObservation } = observed;
    const maintenanceRead = vi.spyOn(maintenanceObservation, 'observeEnvironmentMaintenance').mockResolvedValue(maintenance!);
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {
      capabilities: { supportsObserve: true, supportsDeferredSecretUpdates: true },
      observe: vi.fn(async () => hostingObservation),
    } as any });
    const planned = await plan();
    expect(maintenanceRead).toHaveBeenCalled();
    expect(planned.actions).toHaveLength(3);
    expect(planned.blocked).toEqual([]);
    expect(reset).not.toHaveBeenCalled();
  });

  it('changes issuer and both consumers under exact actions, with encrypted intent before the first write', async () => {
    const planned = await plan();
    expect(planned.blocked).toEqual([]); expect(planned.actions).toHaveLength(3);
    expect(reset).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
    const outcome = await apply(planned);
    expect(outcome).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(reset).toHaveBeenCalledTimes(1); expect(install).toHaveBeenCalledTimes(2);
    expect(ctx.repos.components.findById(component.id)!.bindings.credentialRotation).toMatchObject({ phase: 'installed', installedServices: ['web', 'worker'] });
    expect(JSON.stringify(outcome)).not.toContain(initialPassword); expect(JSON.stringify(outcome)).not.toContain(activePassword);
    expect(JSON.stringify(outcome)).toContain('unchecked');
  });
  it('makes zero mutations without exact confirmation', async () => {
    await apply(await plan(), false); expect(reset).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });
  it('rejects an action with stripped confirmation and a plan missing a consumer', async () => {
    const planned = await plan(); const run = ctx.repos.runs.findById(planned.planRunId)!;
    const document = run.plan as any;
    expect(planRunDocumentSchema.safeParse({ ...document, actions: document.actions.slice(0, 2) }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: document.actions.map((a: any, i: number) => i === 0 ? { ...a, requiresConfirm: false } : a) }).success).toBe(false);
  });
  it('recovers a lost reset response using authentication, never a second reset', async () => {
    reset.mockImplementationOnce(async ({ replacementPassword }) => { activePassword = replacementPassword; throw new Error(`provider echoed ${replacementPassword}`); });
    const first = await apply(await plan());
    expect(first).toMatchObject({ kind: 'executed', result: { success: false } }); expect(install).not.toHaveBeenCalled();
    const next = await apply(await plan());
    expect(next).toMatchObject({ kind: 'executed', result: { success: true } }); expect(reset).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain(activePassword);
  });
  it('uses a verified recovery candidate for real maintenance observation before changing the active binding', async () => {
    vi.mocked(PlanService.prototype.observeEnvironment).mockRestore();
    const { maintenance, ...hostingObservation } = observed;
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {
      capabilities: { supportsObserve: true, supportsDeferredSecretUpdates: true },
      observe: vi.fn(async () => hostingObservation),
    } as any });
    const issuer = (await adapterFactory.getDatabaseAdapter('supabase', project)).adapter!.passwordRotation!;
    const verify = vi.mocked(issuer.verifyPassword);
    const maintenanceRead = vi.spyOn(maintenanceObservation, 'observeEnvironmentMaintenance').mockImplementation(async input => {
      const binding = ctx.repos.components.findById(component.id)!.bindings;
      const connectionUrl = input.databaseUrlOverride ?? String(binding.connectionString);
      if (input.databaseUrlOverride) {
        expect(verify).toHaveBeenCalledWith(expect.objectContaining({ target, password: activePassword }));
      }
      return decodeURIComponent(new URL(connectionUrl).password) === activePassword
        ? maintenance!
        : { ...maintenance!, state: 'unknown', database: { state: 'unknown' } };
    });
    reset.mockImplementationOnce(async ({ replacementPassword }) => { activePassword = replacementPassword; throw new Error('response lost'); });
    expect(await apply(await plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findById(component.id)!.bindings.password).toBe(initialPassword);
    expect(install).not.toHaveBeenCalled();
    verify.mockClear(); maintenanceRead.mockClear();

    const recovery = await plan();
    expect(recovery.blocked).toEqual([]);
    expect(recovery.actions).toHaveLength(3);
    expect(ctx.repos.components.findById(component.id)!.bindings.password).toBe(initialPassword);
    expect(maintenanceRead).toHaveBeenCalledTimes(1);
    const recoveryUrl = maintenanceRead.mock.calls[0][0].databaseUrlOverride;
    expect(recoveryUrl).toBeDefined();
    expect(decodeURIComponent(new URL(recoveryUrl!).password)).toBe(activePassword);
    expect(await apply(recovery)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(reset).toHaveBeenCalledTimes(1);
  });
  it('preserves an uncertain reset that did not take effect instead of repeating it', async () => {
    reset.mockResolvedValueOnce({ status: 'unknown', mutationAttempted: true });
    await apply(await plan()); await apply(await plan());
    expect(reset).toHaveBeenCalledTimes(1); expect(install).not.toHaveBeenCalled();
    expect(ctx.repos.components.findById(component.id)!.bindings.password).toBe(initialPassword);
  });
  it('blocks unsupported issuer and implicit managed-CI consumers before mutation', async () => {
    spec.environments.production.deploy = { strategy: 'branch', branch: 'main' };
    revision = new SpecStore().replace(project, spec).revision;
    const blocked = await plan(); expect(blocked.blocked[0]?.reason).toContain('CI'); expect(blocked.actions).toEqual([]);
    delete spec.environments.production.deploy; revision = new SpecStore().replace(project, spec).revision;
    vi.mocked(adapterFactory.getDatabaseAdapter).mockResolvedValue({ success: true, adapter: {} as any });
    expect((await plan()).blocked[0]?.reason).toContain('unsupported'); expect(reset).not.toHaveBeenCalled();
  });
  it('blocks mismatched suspended workload identity and unknown same-id shared scope', async () => {
    observed.maintenance!.workloads.web.serviceId = 'replacement-service';
    expect((await plan()).actions).toEqual([]);
    observed.maintenance!.workloads.web.serviceId = 'web-id';
    const other = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
    ctx.repos.components.create({ environmentId: other.id, type: 'postgres', externalId: 'exact-db', bindings: { provider: 'supabase' } });
    expect((await plan()).blocked[0]?.reason).toContain('Shared'); expect(reset).not.toHaveBeenCalled();
  });
  it('blocks stale destination identities at apply without creating replacement resources', async () => {
    const planned = await plan();
    ctx.repos.environments.updatePlatformBindings(environment.id, { services: { web: { serviceId: 'new-web' }, worker: { serviceId: 'worker-id' } } });
    expect(await apply(planned)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(reset).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });
  it('keeps partial installation retry-safe and never rotates another password', async () => {
    install.mockImplementationOnce(async () => ({ success: false, message: 'temporarily unavailable' }));
    expect(await apply(await plan())).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findById(component.id)!.bindings.credentialRotation).toMatchObject({ phase: 'issuer-verified' });
    expect(await apply(await plan())).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(reset).toHaveBeenCalledTimes(1);
  });
  it('keeps an installed generation mutation-free on retry', async () => {
    await apply(await plan()); reset.mockClear(); install.mockClear();
    const next = await plan(); expect(next.actions).toEqual([]);
    await apply(next); expect(reset).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });
  it('does not use a saved installed marker as proof after issuer or consumer drift', async () => {
    await apply(await plan());
    activePassword = 'changed-outside-hypervibe';
    expect((await plan()).blocked).not.toEqual([]);
    activePassword = String(ctx.repos.components.findById(component.id)!.bindings.password);
    observed.services[0].envVarHashes.DATABASE_PASSWORD = hashEnvValue('changed-outside-hypervibe');
    expect((await plan()).blocked).not.toEqual([]);
    expect(reset).toHaveBeenCalledTimes(1);
  });
  it('treats incomplete same-id database scope as ambiguous ownership', async () => {
    const other = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
    ctx.repos.components.create({ environmentId: other.id, type: 'postgres', externalId: 'exact-db', bindings: { provider: 'supabase', providerScope: {} } });
    expect((await plan()).blocked).not.toEqual([]);
  });
  it('does not leak upstream errors from planning', async () => {
    vi.mocked(adapterFactory.getDatabaseAdapter).mockRejectedValue(new Error(`echo ${initialPassword}`));
    const result = await plan(); expect(result.blocked).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(initialPassword);
  });
  it('does not mark the generation installed when an earlier consumer drifts during the final installation', async () => {
    const installed: string[] = [];
    const write = install.getMockImplementation()! as (...args: any[]) => Promise<unknown>;
    install.mockImplementation(async (...args) => {
      const receipt = await write(...args);
      installed.push(args[1].name);
      if (installed.length === 2) {
        observed.services.find(service => service.name === installed[0])!.envVarHashes.DATABASE_PASSWORD = hashEnvValue(initialPassword);
      }
      return receipt;
    });
    const outcome = await apply(await plan());
    expect(outcome).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.components.findById(component.id)!.bindings.credentialRotation).not.toMatchObject({ phase: 'installed' });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('rechecks installed evidence when applying a saved empty rotation plan', async () => {
    await apply(await plan());
    const alreadyInstalled = await plan();
    expect(alreadyInstalled.actions).toEqual([]);
    activePassword = 'issuer-changed-after-noop-plan';
    const outcome = await apply(alreadyInstalled);
    expect(outcome).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it.each(['target', 'environmentFingerprint', 'bindingsFingerprint', 'services'])('rejects conflicting consumer %s before issuer authorization', async field => {
    const planned = await plan();
    const document = ctx.repos.runs.findById(planned.planRunId)!.plan as any;
    const altered = structuredClone(document);
    const consumer = altered.actions[1].metadata;
    if (field === 'target') consumer.target.endpoints[0].host = 'different-database.example';
    else if (field === 'services') consumer.services = [consumer.service];
    else consumer[field] = 'f'.repeat(64);
    expect(planRunDocumentSchema.safeParse(altered).success).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it('never turns a persisted blocked assessment into a successful empty apply', async () => {
    vi.mocked(adapterFactory.getDatabaseAdapter).mockResolvedValue({ success: true, adapter: {} as any });
    const planned = await plan(); expect(planned.blocked).toHaveLength(1);
    expect(await apply(planned)).toMatchObject({ kind: 'blocked' });
    expect(reset).not.toHaveBeenCalled();
  });
  it('blocks managed backup credentials and conflicting owner-provided password configuration before reset', async () => {
    spec.environments.production.backups = { mode: 'daily', runnerImage: 'ghcr.io/example/backup@sha256:' + 'a'.repeat(64) } as any;
    revision = new SpecStore().replace(project, spec).revision;
    expect((await plan()).blocked[0]?.reason).toContain('backup');
    delete spec.environments.production.backups;
    spec.environments.production.envVars.DATABASE_PASSWORD = 'application-owned-other-value';
    revision = new SpecStore().replace(project, spec).revision;
    expect((await plan()).blocked[0]?.reason).toContain('configuration');
    expect(reset).not.toHaveBeenCalled();
  });
  it('blocks ordinary apply while an issuer reset needs recovery', async () => {
    reset.mockResolvedValueOnce({ status: 'unknown', mutationAttempted: true });
    await apply(await plan());
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan', plan: {
      kind: 'hv_plan', scope: 'full', environmentName: 'production', specRevision: revision, observedFingerprint: null, actions: [],
    } });
    const outcome = await executePlanApply(ctx, { project, spec, specRevision: revision, planId: run.id, confirmActions: [] });
    expect(outcome).toMatchObject({ kind: 'blocked' }); expect(reset).toHaveBeenCalledTimes(1);
  });
  it('does not forget retained CI credential consumers when deploy intent was removed', async () => {
    ctx.repos.environments.updatePlatformBindings(environment.id, { ci: { deployBranch: {
      '.github/workflows/deploy.yml': { syncedEnvironmentSecrets: ['DATABASE_URL'] },
    } } });
    expect((await plan()).blocked[0]?.reason).toContain('CI');
    expect(reset).not.toHaveBeenCalled();
  });
});
