import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import * as backups from '../../domain/services/backup-policy.service.js';
import * as storage from '../../domain/services/storage-plan.service.js';
import * as health from '../../domain/services/backup-health.service.js';
import * as githubInfrastructure from '../../domain/services/github-infrastructure.service.js';
import * as bootstrap from '../../domain/services/bootstrap.service.js';
import '../providers.js';

describe('fresh backup readiness at the real apply boundary', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-apply-backup-readiness-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['update', 'noop', 'mixed-prerequisite'] as const)('blocks %s rollout despite a saved healthy claim before deployment preflight', async type => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'guarded-rollout', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e',
        appliedSpecHash: 'old-contract', services: { web: { serviceId: 'web' } } } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: {} }, database: { provider: 'railway' } } } });
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'full', environmentName: 'production', specRevision: 1,
        observedFingerprint: null, backupCoverage: { complete: true },
        actions: [{ id: 'service:web', type: type === 'mixed-prerequisite' ? 'update' : type, resource: { kind: 'service', provider: 'railway', name: 'web' },
          verified: true, reason: 'Deploy the application', metadata: { externalId: 'web' } },
          ...(type === 'mixed-prerequisite' ? [{ id: 'maintenance:web', type: 'update', resource: { kind: 'service', provider: 'railway', name: 'web' },
            verified: true, reason: 'Enter maintenance first', metadata: { operation: 'maintenanceEnable' } }] : [])] } });
    vi.spyOn(backups, 'observeBackupPolicy').mockResolvedValue({ policy: { mode: 'daily', source: 'default',
      resources: [{ kind: 'database', name: 'postgres', provider: 'railway', retained: false, bindingState: 'unknown' }] },
      resources: [{ resource: { kind: 'database', name: 'postgres', provider: 'railway', retained: false, bindingState: 'unknown' },
        state: 'unknown', reason: 'Backup source cannot be verified.' }] });
    const preflight = vi.spyOn(PlanService.prototype, 'preflight')
      .mockImplementation(() => { throw new Error('Rollout reached unrelated preflight without backup readiness'); });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id,
      confirmActions: [], alwaysRunBootstrap: type === 'noop' });
    expect(result).toMatchObject({ kind: 'blocked', applyBlocked: [{ category: 'prerequisite', provider: 'hypervibe', reason: expect.stringMatching(/backup/i) }] });
    expect(preflight).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(environment.platformBindings);
  });

  it('applies only a confirmed derived backup bucket without unrelated preflight or deployment acceptance', async () => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'backup-bootstrap', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e', appliedSpecHash: 'old-contract' } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: {} },
        storage: { documents: { provider: 'railway', type: 'bucket', region: 'iad', injectInto: ['web'] } } } } });
    const action = { id: 'storage:hypervibe-backups', type: 'create',
      resource: { kind: 'storage', provider: 'railway', name: 'hypervibe-backups' },
      verified: true, billable: true, dataBearing: true, requiresConfirm: true, reason: 'Provision separate retained backup destination',
      metadata: { operation: 'storageEnsure', storageName: 'hypervibe-backups', region: 'iad' } };
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'backup-provisioning', environmentName: 'production', specRevision: 1,
        observedFingerprint: null, actions: [action] } });
    const preflight = vi.spyOn(PlanService.prototype, 'preflight')
      .mockImplementation(() => { throw new Error('Unrelated deploy preflight called for backup provisioning'); });
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
    const ensure = vi.spyOn(storage, 'applyStorageAction').mockResolvedValue({ success: true,
      message: 'Created exact backup destination', data: { applied: 1, skipped: 0 } });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id,
      confirmActions: [action.id], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(preflight).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ action,
      environmentSpec: expect.objectContaining({ storage: expect.objectContaining({ 'hypervibe-backups':
        expect.objectContaining({ purpose: 'backup', injectInto: [] }) }) }) }));
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(environment.platformBindings);
    expect(spec.environments.production.storage).not.toHaveProperty('hypervibe-backups');
  });

  it.each(['running', 'unknown', 'ambiguous'] as const)('re-observes a purported deferred identity stage and blocks %s workload evidence', async state => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'identity-admission', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e', services: state === 'unknown' ? {} : { web: { serviceId: 'web' } } } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: { volume: { mountPath: '/data' } } } } } });
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'hosting-bindings', environmentName: 'production', specRevision: 1,
        observedFingerprint: null, actions: [{ id: 'service:web', type: state === 'unknown' ? 'create' : 'update', resource: { kind: 'service', provider: 'railway', name: 'web' },
          verified: true, billable: true, requiresConfirm: true, reason: 'An outdated identity-only claim', metadata: { workloadCreateRequired: true, ...(state === 'unknown' ? {} : { externalId: 'web' }) } }] } });
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const observed = vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, projectId: 'p', environmentId: 'e',
      services: state === 'unknown' ? [] : Array.from({ length: state === 'ambiguous' ? 2 : 1 }, () => ({ name: 'web', externalId: 'web', status: 'running' as const, workloadKind: 'web' as const,
        ...(state === 'ambiguous' ? { identityOnly: true } : {}), config: {}, envVarKeys: [], envVarHashes: {}, customDomains: [] })),
      databases: [], partial: state === 'unknown', warnings: [],
    } });
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockImplementation(() => { throw new Error('Existing workload must not change without backup proof'); });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id, confirmActions: ['service:web'] });
    expect(observed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ kind: 'executed', result: { success: false,
      receipts: [expect.objectContaining({ actionId: 'service:web', status: 'blocked', message: expect.stringMatching(/backup/i) })] } });
    expect(deploy).not.toHaveBeenCalled();
  });

  it('preserves ordinary deferred setup when no backup-readiness exception is needed', async () => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'ordinary-identity', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e', services: {} } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: {} }, email: { enabled: false } } } });
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'hosting-bindings', environmentName: 'production', specRevision: 1,
        observedFingerprint: null, actions: [{ id: 'service:web', type: 'create', resource: { kind: 'service', provider: 'railway', name: 'web' },
          verified: true, reason: 'Provision deferred service identity' }] } });
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, projectId: 'p', environmentId: 'e',
      services: [], databases: [], partial: false, warnings: [],
    } });
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: { deploymentMode: 'provision' } });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id, confirmActions: [] });
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ provisionOnly: true }));
    expect(deploy.mock.calls[0][0]).not.toHaveProperty('requireNewWorkload');
  });

  it.each([false, true])('keeps backup program publication isolated and honors confirmation=%s', async confirmed => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'backup-publication', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/acme/backup-publication' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e', appliedSpecHash: 'old-contract' } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: {} }, database: { provider: 'railway' } } } });
    const action = { id: 'github:infrastructure', type: 'update',
      resource: { kind: 'repo', provider: 'github', name: 'acme/backup-publication' }, verified: true,
      requiresConfirm: true, billable: true, reason: 'Publish the reviewed backup workflow',
      metadata: { operation: 'githubInfrastructurePullRequest', repository: 'acme/backup-publication', backupWorkflowPublicationRequired: true,
        desiredFiles: [{ path: '.github/workflows/hypervibe-backup-production.yml', hash: 'a'.repeat(64) }] } };
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'backup-program-publication', environmentName: 'production', specRevision: 1,
        observedFingerprint: null, actions: [action] } });
    vi.spyOn(PlanService.prototype, 'preflight').mockImplementation(() => { throw new Error('Unrelated rollout preflight'); });
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(() => { throw new Error('Unrelated hosting observation'); });
    const providers = vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const publication = vi.spyOn(githubInfrastructure, 'applyGitHubInfrastructure').mockResolvedValue({ success: true, message: 'Opened reviewed backup PR', data: { applied: 1, skipped: 0 } });
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockImplementation(() => { throw new Error('Unexpected application deployment'); });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id,
      confirmActions: confirmed ? [action.id] : [], alwaysRunBootstrap: true });
    expect(result).toMatchObject({ kind: 'executed', result: { success: confirmed } });
    expect(publication).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(providers).toHaveBeenCalledWith(['github']);
    expect(deploy).not.toHaveBeenCalled();
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual(environment.platformBindings);
  });

  it.each(['update', 'noop'] as const)('rechecks backup proof immediately before the %s service write, after initial apply admission', async type => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'changing-backup', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e', services: { web: { serviceId: 'web' } } } });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'railway' }, services: { web: {} }, email: { enabled: false }, database: { provider: 'railway' } } } });
    const resource = { kind: 'database' as const, name: 'postgres', provider: 'railway', retained: false, bindingState: 'bound' as const, componentId: 'component' };
    const source = { provider: 'railway', primaryExternalId: 'db', providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: { volumeId: 'v', volumeInstanceId: 'vi' } };
    vi.spyOn(backups, 'observeBackupPolicy').mockResolvedValue({ policy: { mode: 'daily', source: 'default', resources: [resource] },
      resources: [{ resource, state: 'scheduled', observation: { state: 'known', source, daily: true,
        policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot' } }] });
    const observedAt = new Date(Date.now() - 1000).toISOString();
    const freshUntil = new Date(Date.now() + 60000).toISOString();
    const observeHealth = vi.spyOn(health, 'observeBackupHealth').mockResolvedValueOnce({ observedAt, resources: [{
      resource, source, state: 'verified', completedAt: observedAt, dataTime: observedAt, recoveryPointId: 'point', freshUntil,
      restore: { state: 'verified', verifiedAt: observedAt, freshUntil } }] })
      .mockResolvedValue({ observedAt, resources: [{ resource, state: 'missing' }] });
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
    const deploy = vi.spyOn(bootstrap, 'executeBootstrap').mockResolvedValue({ success: true, summary: {} });
    const run = ctx.repos.runs.create({ projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', scope: 'full', environmentName: 'production', specRevision: 1, observedFingerprint: null,
        actions: [{ id: 'service:web', type, resource: { kind: 'service', provider: 'railway', name: 'web' },
          verified: true, reason: 'Deploy reviewed code' }] } });
    const result = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: run.id, confirmActions: [], alwaysRunBootstrap: type === 'noop' });
    expect(result).toMatchObject({ kind: 'executed', result: { success: false,
      receipts: expect.arrayContaining([expect.objectContaining({ actionId: type === 'noop' ? 'backup-readiness' : 'service:web', status: 'blocked', message: expect.stringMatching(/backup/i) })]) } });
    expect(observeHealth).toHaveBeenCalledTimes(2);
    expect(deploy).not.toHaveBeenCalled();
  });
});
