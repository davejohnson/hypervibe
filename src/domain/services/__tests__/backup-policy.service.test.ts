import { describe, expect, it, vi } from 'vitest';
import { configureBackupPolicyItem, observeBackupPolicy, resolveBackupPolicies } from '../backup-policy.service.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Component } from '../../entities/component.entity.js';
import { environmentSpecSchema, projectSpecSchema, type EnvironmentSpec } from '../../spec/spec.schema.js';
import type { AdapterFactory } from '../adapter.factory.js';

const now = new Date();
const spec = environmentSpecSchema.parse({ hosting: { provider: 'example-host' }, services: { web: { volume: { mountPath: '/data' } } }, database: { provider: 'example-db', engine: 'postgres' }, storage: { documents: { provider: 'example-storage', type: 'bucket', region: 'west', injectInto: ['web'] } } });
const environment: Environment = { id: 'env', projectId: 'project', name: 'production', createdAt: now, updatedAt: now,
  platformBindings: {
    serviceVolumes: { web: { provider: 'example-host', state: 'bound', externalId: 'volume-1', target: { projectId: 'native', environmentId: 'prod', serviceId: 'web-id', mountPath: '/data' } } },
    storage: { documents: { provider: 'example-storage', externalId: 'bucket-1', instanceScope: { projectId: 'native' } } },
  } };
const component: Component = { id: 'db', environmentId: 'env', type: 'postgres', externalId: 'primary', bindings: { provider: 'example-db', password: 'must-not-escape' }, createdAt: now, updatedAt: now };
const source = { provider: 'example-db', primaryExternalId: 'primary', providerScope: { projectId: 'native' }, resourceIdentity: {} };
const known = { state: 'known' as const, source, daily: true, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot' as const };
const projectSpec = (envSpec = spec) => projectSpecSchema.parse({ version: 1, project: 'example', environments: { production: envSpec } });

function factory() {
  const db = { observe: vi.fn().mockResolvedValue(known), configureDaily: vi.fn().mockResolvedValue({ success: true, message: 'applied 1', data: { applied: 1, skipped: 0 } }) };
  const volume = { observe: vi.fn().mockResolvedValue({ ...known, source: { ...source, provider: 'example-host', primaryExternalId: 'web-id', resourceIdentity: { volumeId: 'volume-1' } }, daily: false }), configureDaily: vi.fn() };
  const storage = { observe: vi.fn().mockResolvedValue({ ...known, source: { ...source, provider: 'example-storage', primaryExternalId: 'bucket-1' } }), configureDaily: vi.fn() };
  const adapters = {
    getDatabaseAdapter: vi.fn().mockResolvedValue({ success: true, adapter: { name: 'example-db', dailyBackups: db } }),
    getProviderAdapter: vi.fn().mockResolvedValue({ success: true, adapter: { name: 'example-host', serviceVolumes: { dailyBackups: volume } } }),
    getStorageAdapter: vi.fn().mockResolvedValue({ success: true, adapter: { name: 'example-storage', dailyBackups: storage } }),
  };
  return { db, volume, storage, adapters: adapters as unknown as Pick<AdapterFactory, 'getDatabaseAdapter' | 'getProviderAdapter' | 'getStorageAdapter'> };
}

describe('default backup discovery and observation', () => {
  it('reports the retained-set defaults and missing helper instead of leaving setup gaps implicit', async () => {
    const f = factory();
    expect(await observeBackupPolicy({ spec, environment, components: [component], adapterFactory: f.adapters }))
      .toMatchObject({ managedProgram: { state: 'blocked', retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7,
        destination: 'hypervibe-backups', issues: ['The managed private backup runner requires a published immutable Hypervibe helper image.'] } });
  });

  it('defaults every declared data store to daily without mutating the spec', () => {
    const input = projectSpec();
    const before = JSON.stringify(input);
    const policy = resolveBackupPolicies(input).production;
    expect(policy).toMatchObject({ mode: 'daily', source: 'default' });
    expect(policy.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'database', name: 'postgres', provider: 'example-db' }),
      expect.objectContaining({ kind: 'volume', name: 'web', provider: 'example-host' }),
      expect.objectContaining({ kind: 'storage', name: 'documents', provider: 'example-storage' }),
    ]));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('discovers retained resources after their declarations are removed', () => {
    const empty = { hosting: spec.hosting, services: {} } as EnvironmentSpec;
    const policy = resolveBackupPolicies(projectSpec(empty), [environment], [component]).production;
    expect(policy.resources).toHaveLength(3);
    expect(policy.resources.every(resource => resource.retained)).toBe(true);
  });

  it('keeps desired and retained resource coverage separate during provider changes', () => {
    const desired = { ...spec, hosting: { provider: 'new-host' }, storage: { documents: { ...spec.storage!.documents, provider: 'new-storage' } } };
    const resources = resolveBackupPolicies(projectSpec(desired), [environment], [component]).production.resources;
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'volume', name: 'web', provider: 'new-host', retained: false, bindingState: 'unbound' }),
      expect.objectContaining({ kind: 'volume', name: 'web', provider: 'example-host', retained: true }),
      expect.objectContaining({ kind: 'storage', name: 'documents', provider: 'new-storage', retained: false, bindingState: 'unbound' }),
      expect.objectContaining({ kind: 'storage', name: 'documents', provider: 'example-storage', retained: true }),
    ]));
  });

  it('discovers retained import and migration markers written by the actual lifecycle', () => {
    // import-provider persists platformBindings.previousDatabase; database
    // migration retains dataMigrationPreviousTarget and a typed candidate row;
    // storage migration persists previousTarget and dataMigrationCandidates.
    const env = { ...environment, platformBindings: { ...environment.platformBindings,
      previousDatabase: { provider: 'old-db', engine: 'postgres', externalId: 'old-primary', providerScope: { projectId: 'old' } },
      dataMigrationCandidates: { storage: { documents: { externalId: 'candidate-bucket' } } },
    } };
    const db = { ...component, bindings: { ...component.bindings, dataMigrationPreviousTarget: { provider: 'old-migration-db', externalId: 'previous' } } };
    const candidate = { ...component, id: 'candidate', type: 'data-migration:move:postgres' };
    const resources = resolveBackupPolicies(projectSpec(), [env], [db, candidate]).production.resources;
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'database', provider: 'old-db', retained: true, bindingState: 'unknown' }),
      expect.objectContaining({ kind: 'database', provider: 'old-migration-db', retained: true, bindingState: 'unknown' }),
      expect.objectContaining({ kind: 'database', name: expect.stringContaining('candidate'), retained: true, bindingState: 'unknown' }),
      expect.objectContaining({ kind: 'storage', name: '__migration-candidates__', retained: true, bindingState: 'unknown' }),
    ]));
  });

  it('represents malformed retained maps and previous databases instead of dropping them', () => {
    const env = { ...environment, platformBindings: { serviceVolumes: null, storage: [], storageCreateRecovery: null } };
    const db = { ...component, bindings: { ...component.bindings, previousProvider: 'old-db' } };
    const policy = resolveBackupPolicies(projectSpec(), [env], [db]).production;
    expect(policy.resources.filter(resource => resource.bindingState === 'unknown').map(resource => resource.kind)).toEqual(expect.arrayContaining(['database', 'volume', 'storage']));
    expect(JSON.stringify(policy)).not.toContain('must-not-escape');
  });

  it('observes each capability read-only without provider-name branching', async () => {
    const f = factory();
    const report = await observeBackupPolicy({ spec, environment, components: [component], adapterFactory: f.adapters });
    expect(report.resources.map(item => item.state)).toEqual(['scheduled', 'needs-configuration', 'scheduled']);
    expect(f.db.observe).toHaveBeenCalledWith({ environment, component });
    expect(f.volume.observe).toHaveBeenCalledWith({ target: environment.platformBindings.serviceVolumes && (environment.platformBindings.serviceVolumes as any).web.target, externalId: 'volume-1' });
    expect(f.storage.observe).toHaveBeenCalledWith({ environment, context: { projectId: 'native' }, externalId: 'bucket-1' });
    expect(f.db.configureDaily).not.toHaveBeenCalled();
    expect(f.volume.configureDaily).not.toHaveBeenCalled();
    expect(f.storage.configureDaily).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('must-not-escape');
  });

  it('disabled intent performs no native observation or resolution', async () => {
    const f = factory();
    const report = await observeBackupPolicy({ spec: { ...spec, backups: { mode: 'disabled', reason: 'Disposable fixtures' } }, environment, components: [component], adapterFactory: f.adapters });
    expect(report.policy).toMatchObject({ mode: 'disabled', source: 'explicit', reason: 'Disposable fixtures' });
    expect(report.resources.every(item => item.state === 'disabled')).toBe(true);
    expect(f.adapters.getDatabaseAdapter).not.toHaveBeenCalled();
    expect(f.adapters.getProviderAdapter).not.toHaveBeenCalled();
    expect(f.adapters.getStorageAdapter).not.toHaveBeenCalled();
  });

  it('distinguishes unavailable observation from unsupported capability', async () => {
    const f = factory();
    f.db.observe.mockRejectedValue(new Error('secret credential must-not-escape'));
    vi.mocked(f.adapters.getStorageAdapter).mockResolvedValue({ success: true, adapter: { name: 'example-storage' } as never });
    const report = await observeBackupPolicy({ spec, environment, components: [component], adapterFactory: f.adapters });
    expect(report.resources.find(item => item.resource.kind === 'database')?.state).toBe('unknown');
    expect(report.resources.find(item => item.resource.kind === 'storage')?.state).toBe('unsupported');
    expect(JSON.stringify(report)).not.toContain('must-not-escape');
  });

  it('rejects malformed or wrong-provider normalized evidence', async () => {
    const f = factory();
    f.db.observe.mockResolvedValue({ ...known, source: { ...source, provider: 'other' } });
    f.volume.observe.mockResolvedValue({ ...known, policyFingerprint: undefined });
    const report = await observeBackupPolicy({ spec, environment, components: [component], adapterFactory: f.adapters });
    expect(report.resources.filter(item => item.resource.kind !== 'storage').every(item => item.state === 'unknown')).toBe(true);
  });

  it('does not report a schedule complete when its fingerprint cannot authorize reconciliation', async () => {
    const f = factory();
    f.db.observe.mockResolvedValue({ ...known, policyFingerprint: 'not-a-sha256' });
    const report = await observeBackupPolicy({ spec, environment, components: [component], adapterFactory: f.adapters });
    expect(report.resources[0].state).toBe('unknown');
  });

  it.each(['missing', 'malformed'])('keeps %s stronger-policy preservation evidence unknown', async shape => {
    const f = factory();
    const { preservationFingerprint: _preservation, ...withoutPreservation } = known;
    f.db.observe.mockResolvedValue(shape === 'missing' ? withoutPreservation : { ...known, preservationFingerprint: 'invalid' });
    const report = await observeBackupPolicy({ spec, environment, components: [component], adapterFactory: f.adapters });
    expect(report.resources[0].state).toBe('unknown');
  });

  it('keeps first-use resources unbound and never contacts providers before provisioning', async () => {
    const f = factory();
    const report = await observeBackupPolicy({ spec, components: [], adapterFactory: f.adapters });
    expect(report.resources).toHaveLength(3);
    expect(report.resources.every(item => item.state === 'unknown' && item.resource.bindingState === 'unbound')).toBe(true);
    expect(f.adapters.getDatabaseAdapter).not.toHaveBeenCalled();
    expect(f.adapters.getProviderAdapter).not.toHaveBeenCalled();
    expect(f.adapters.getStorageAdapter).not.toHaveBeenCalled();
  });

  it('keeps unbound and incomplete staged filesystems visible without observing wrong resources', async () => {
    const f = factory();
    const env = { ...environment, platformBindings: { serviceVolumes: { web: { provider: 'example-host', target: (environment.platformBindings.serviceVolumes as any).web.target, state: 'staged', components: { filesystem: { state: 'creating' } } } } } };
    const report = await observeBackupPolicy({ spec, environment: env, components: [], adapterFactory: f.adapters });
    expect(report.resources.every(item => item.state === 'unknown')).toBe(true);
    expect(f.volume.observe).not.toHaveBeenCalled();
  });

  it('apply rederives bound targets and never authorizes a removed or retargeted descriptor', async () => {
    const f = factory();
    const report = await observeBackupPolicy({ spec, environment, components: [component], adapterFactory: f.adapters });
    const item = report.resources[0];
    const reviewed = { source, policyFingerprint: known.policyFingerprint };
    expect(await configureBackupPolicyItem({ item, reviewed, spec, environment, components: [], adapterFactory: f.adapters })).toMatchObject({ success: false });
    expect(f.db.configureDaily).not.toHaveBeenCalled();
    expect(await configureBackupPolicyItem({ item, reviewed, spec, environment, components: [component], adapterFactory: f.adapters })).toMatchObject({ success: true });
    expect(f.db.configureDaily).toHaveBeenCalledWith({ environment, component }, reviewed);
  });
});
