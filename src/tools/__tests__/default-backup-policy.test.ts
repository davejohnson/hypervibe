import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry } from '../../application/commands.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { environmentSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
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

describe('daily backup intent through the public command boundary', () => {
  // Product requirement: declaring durable resources is enough to require daily
  // protection. Absence of a policy must not be interpreted as opting out.
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
      mode: 'daily', source: 'default', resources: [
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
      hosting: { provider: 'railway' }, services: {}, database: { provider: 'railway', engine: 'postgres' },
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
    vi.spyOn(backupPolicies, 'observeBackupPolicy').mockResolvedValue({ policy: { mode: 'daily', source: 'default', resources: [resource] }, resources: [item] });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network call in status contract test'); }));
    const result = await createCommandRegistry(ctx).execute('hv_status', { project: project.name, env: 'production' });
    expect(store.get(project)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    return result;
  }

  it.each(['unsupported', 'unknown', 'needs-configuration'] as const)('hv_status does not claim convergence while daily backup coverage is %s', async state => {
    // Infrastructure itself is in sync. Only the independently supplied backup
    // coverage gap must prevent the public command from claiming convergence.
    expect(await statusFor(state)).toMatchObject({ ok: true, data: {
      inSync: false, backupCoverage: { complete: false, backupObserved: 'unverified', restoreTested: 'unverified',
        policy: { mode: 'daily', source: 'default' }, resources: [{ state }] },
    } });
  });

  it('hv_status reports an observed schedule separately from backup availability and tested restoration', async () => {
    expect(await statusFor('scheduled')).toMatchObject({ ok: true, data: {
      inSync: false, backupCoverage: { complete: true, backupObserved: 'unverified', restoreTested: 'unverified',
        resources: [{ state: 'scheduled', observation: { daily: true } }] },
      backupReadiness: { ready: false, recoveryPointReady: false, restoreReady: false },
    } });
  });
});
