import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry } from '../../application/commands.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { environmentSpecSchema, type EnvironmentSpec } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import type { StorageBinding } from '../../domain/services/storage-plan.service.js';
import * as backupPolicies from '../../domain/services/backup-policy.service.js';
import type { BackupCoverageItem } from '../../domain/services/backup-policy.service.js';

let directory: string;
beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hv-backup-default-'));
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('retained backup archives through the public status boundary', () => {
  // docs/development/recovery.md: daily intent may derive an archive only in
  // backup-scoped planning. Status interprets that intent without changing the
  // spec, proposing archive provisioning, or claiming recovery is verified.
  async function fixture(options: { backups?: EnvironmentSpec['backups']; explicitDestination?: boolean; collision?: boolean; archive?: boolean } = {}) {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'retained-backup-status', defaultPlatform: 'railway' });
    const archiveName = options.collision ? 'retained-history' : 'hypervibe-backups';
    const scope = { projectId: 'native-project', environmentId: 'native-environment' };
    const storage = {
      documents: { provider: 'railway', type: 'bucket' as const, region: 'sjc', injectInto: [] },
      ...(options.explicitDestination ? { archive: { provider: 'railway', type: 'bucket' as const, region: 'sjc', injectInto: [], purpose: 'backup' as const } } : {}),
      ...(options.collision ? { 'hypervibe-backups': { provider: 'railway', type: 'bucket' as const, region: 'sjc', injectInto: [] } } : {}),
    };
    const bindingEntries: Array<[string, StorageBinding]> = Object.entries(storage).map(([name, entry]) => [name, {
        provider: 'railway', externalId: `bucket-${name}`, region: 'sjc', services: [], envKeys: [], instanceScope: scope,
        ...('purpose' in entry ? { purpose: entry.purpose } : {}),
      }]);
    if (options.archive !== false) bindingEntries.push([archiveName, {
        provider: 'railway', externalId: 'retained-archive', region: 'sjc', services: [], envKeys: [], instanceScope: scope, purpose: 'backup',
      }]);
    const storageBindings = Object.fromEntries(bindingEntries);
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
      provider: 'railway', ...scope, storage: storageBindings,
    } });
    const store = new SpecStore();
    store.replace(project, { version: 1, project: project.name, environments: { production: {
      hosting: { provider: 'railway' }, services: {}, storage,
      ...(options.backups ? { backups: options.backups } : {}),
    } } });
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
      provider: 'railway', observedAt: '2026-11-17T00:00:00Z', projectExists: true, ...scope,
      services: [], databases: [], partial: false, warnings: [],
      storage: Object.entries(storageBindings).map(([name, entry]) => ({ name, provider: 'railway', kind: 'object' as const,
        status: 'running', externalId: entry.externalId, region: 'sjc', instanceScope: scope })),
    } });
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call in retained archive status test'); }));
    const before = { spec: store.get(project), environment: ctx.repos.environments.findById(environment.id), runs: ctx.repos.runs.findByProjectId(project.id) };
    const result = await createCommandRegistry(ctx).execute('hv_status', { project: project.name, env: 'production' });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect({ spec: store.get(project), environment: ctx.repos.environments.findById(environment.id), runs: ctx.repos.runs.findByProjectId(project.id) }).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    const data = result.data as { drift: PlanAction[]; backupCoverage: { complete: boolean }; backupReadiness: { ready: boolean } };
    expect(data.drift.filter(action => action.resource.kind === 'storage')).toEqual([]);
    return { project, result, data, store, before };
  }

  it('keeps an implicitly desired daily archive out of removal warnings in status and ordinary planning', async () => {
    const f = await fixture({ backups: { mode: 'daily' } });
    expect(f.result.warnings?.filter(warning => warning.includes('Retaining backup storage'))).toEqual([]);
    expect(f.data.backupCoverage.complete).toBe(false);
    expect(f.data.backupReadiness.ready).toBe(false);
    expect(f.before.spec!.spec.environments.production.storage).not.toHaveProperty('hypervibe-backups');
    const plan = await new PlanService().plan(f.project, 'production', { includeEnvFile: false });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.warnings.filter(warning => warning.includes('Retaining backup storage'))).toEqual([]);
    expect(plan.actions.some(action => action.resource.name === 'hypervibe-backups')).toBe(false);
    const backupPlan = await new PlanService().plan(f.project, 'production', { includeEnvFile: false, scope: 'backups' });
    if ('error' in backupPlan) throw new Error(backupPlan.error);
    expect(backupPlan.warnings.filter(warning => warning.includes('Retaining backup storage'))).toEqual([]);
    expect(backupPlan.actions.some(action => action.resource.name === 'hypervibe-backups'
      && (action.type === 'destroy' || action.metadata?.operation === 'storageUnwire'))).toBe(false);
    expect(f.store.get(f.project)).toEqual(f.before.spec);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('describes omitted intent as unmanaged and preserves retained history', async () => {
    const f = await fixture();
    expect(f.result.warnings).toContainEqual(expect.stringMatching(/Retaining backup storage .*not managed/));
    expect(f.result.warnings?.join(' ')).not.toMatch(/policy was removed|provider.*disabled/i);
    expect(f.result.data).toMatchObject({ backupCoverage: { policy: { mode: 'disabled', source: 'default' } } });
  });

  it('keeps an explicit exclusion distinct from deleting the archive or provider backups', async () => {
    const f = await fixture({ backups: { mode: 'disabled', reason: 'This environment is disposable' } });
    expect(f.result.warnings).toContainEqual(expect.stringMatching(/Retaining backup storage .*excluded/));
    expect(f.result.data).toMatchObject({ backupCoverage: { policy: { mode: 'disabled', source: 'explicit' } } });
  });

  it('retains an old archive when a different destination is explicitly selected', async () => {
    const f = await fixture({ backups: { mode: 'daily', destination: 'archive' }, explicitDestination: true });
    expect(f.result.warnings).toContainEqual(expect.stringMatching(/Retaining backup storage "hypervibe-backups".*not selected/));
    expect(f.result.warnings?.some(warning => warning.includes('Retaining backup storage "archive"'))).toBe(false);
  });

  it('preserves the application-storage collision blocker and separate retained archive', async () => {
    const f = await fixture({ backups: { mode: 'daily' }, collision: true });
    expect(f.result.warnings).toContainEqual(expect.stringMatching(/Retaining backup storage "retained-history".*not selected/));
    expect(JSON.stringify(f.result)).toContain('The default backup destination name is already used by application storage');
    expect(f.before.spec!.spec.environments.production.storage?.['hypervibe-backups']).not.toHaveProperty('purpose');
  });

  it('does not turn a missing implicit archive into ordinary storage drift', async () => {
    const f = await fixture({ backups: { mode: 'daily' }, archive: false });
    expect(f.data.backupReadiness.ready).toBe(false);
    expect(f.before.spec!.spec.environments.production.storage).not.toHaveProperty('hypervibe-backups');
  });
});

describe('optional backup intent through the public command boundary', () => {
  // User requirement: ordinary deployments do not require backup setup.
  // Omission leaves backup intent unconfigured and never rewrites the spec.
  it('reports the default for an existing spec without rewriting that spec or revision', async () => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'daily-default-test', defaultPlatform: 'railway' });
    const store = new SpecStore();
    store.replace(project, { version: 1, project: project.name, environments: { production: {
      hosting: { provider: 'railway' }, services: { web: { volume: { mountPath: '/data' } } },
      database: { provider: 'railway', engine: 'postgres' },
      storage: { documents: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['web'] } },
    } } });
    const before = store.get(project)!;
    const result = await createCommandRegistry(ctx).execute('hv_spec', { project: project.name });
    expect(result).toMatchObject({ ok: true, data: { backupPolicies: { production: {
      mode: 'disabled', source: 'default', resources: [
        { kind: 'database', name: 'postgres', provider: 'railway' },
        { kind: 'volume', name: 'web', provider: 'railway' },
        { kind: 'storage', name: 'documents', provider: 'railway' },
      ],
    } } } });
    expect(store.get(project)).toEqual(before);
    expect(before.spec.environments.production).not.toHaveProperty('backups');
  });

  it('accepts explicit daily intent and a reasoned opt-out', () => {
    const base = { hosting: { provider: 'railway' }, services: {} };
    expect(environmentSpecSchema.safeParse({ ...base, backups: { mode: 'daily' } }).success).toBe(true);
    expect(environmentSpecSchema.safeParse({ ...base, backups: { mode: 'disabled', reason: 'Disposable test environment' } }).success).toBe(true);
    expect(environmentSpecSchema.safeParse({ ...base, backups: { mode: 'disabled' } }).success).toBe(false);
  });

  async function statusFor(state: BackupCoverageItem['state']) {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'daily-status-test', defaultPlatform: 'railway' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'railway', projectId: 'native-project', environmentId: 'native-environment' } });
    const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'primary',
      bindings: { provider: 'railway', providerScope: { projectId: 'native-project', environmentId: 'native-environment' } } });
    const store = new SpecStore();
    store.replace(project, { version: 1, project: project.name, environments: { production: {
      hosting: { provider: 'railway' }, services: {}, database: { provider: 'railway', engine: 'postgres' }, backups: { mode: 'daily' },
    } } });
    const before = store.get(project);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ warnings: [], observed: {
      provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
      projectId: 'native-project', environmentId: 'native-environment', services: [],
      databases: [{ provider: 'railway', engine: 'postgres', externalId: 'primary', status: 'running',
        providerScope: { projectId: 'native-project', environmentId: 'native-environment' } }],
      partial: false, warnings: [],
    } });
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    const resource = { kind: 'database' as const, name: 'postgres', provider: 'railway', retained: false,
      bindingState: 'bound' as const, componentId: component.id };
    const item: BackupCoverageItem = { resource, state, target: { kind: 'database', componentId: component.id },
      ...(state === 'scheduled' || state === 'needs-configuration' ? { observation: {
        state: 'known' as const, daily: state === 'scheduled', mechanism: 'snapshot' as const, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64),
        source: { provider: 'railway', primaryExternalId: 'primary', providerScope: { projectId: 'native-project', environmentId: 'native-environment' }, resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'volume-instance' } },
      } } : { reason: state === 'unsupported' ? 'Daily policy adapter unavailable.' : 'Daily policy observation unavailable.' }) };
    vi.spyOn(backupPolicies, 'observeBackupPolicy').mockResolvedValue({ policy: { mode: 'daily', source: 'explicit', resources: [resource] }, resources: [item] });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call in status contract test'); }));
    const result = await createCommandRegistry(ctx).execute('hv_status', { project: project.name, env: 'production' });
    expect(store.get(project)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    return result;
  }

  it.each(['unsupported', 'unknown', 'needs-configuration'] as const)('hv_status reports optional backup coverage %s separately from deployment convergence', async state => {
    // Deployment is in sync while the independent backup status remains incomplete.
    expect(await statusFor(state)).toMatchObject({ ok: true, data: {
      inSync: true, backupCoverage: { complete: false, backupObserved: 'unverified', restoreTested: 'unverified',
        policy: { mode: 'daily', source: 'explicit' }, resources: [{ state }] },
    } });
  });

  it('hv_status reports an observed schedule separately from backup availability and tested restoration', async () => {
    expect(await statusFor('scheduled')).toMatchObject({ ok: true, data: {
      inSync: true, backupCoverage: { complete: true, backupObserved: 'unverified', restoreTested: 'unverified',
        resources: [{ state: 'scheduled', observation: { daily: true } }] },
      backupReadiness: { ready: false, recoveryPointReady: false, restoreReady: false },
    } });
  });
});
