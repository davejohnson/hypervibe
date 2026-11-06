import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { applyStorageAction, planStorage, resolveStorageServiceEnvVars } from '../storage-plan.service.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { EnvironmentSpec } from '../../spec/spec.schema.js';
import { z } from 'zod';
import { providerRegistry } from '../../registry/provider.registry.js';
import type { IProviderAdapter, IProviderLifecycleAdapter, ProviderRuntimeIdentity } from '../../ports/provider.port.js';
import type { IStorageAdapter } from '../../ports/storage.port.js';

const projectId = 'fixture-project';
const principal = 'fixture-workload-identity';
const spec = environmentSpecSchema.parse({ hosting: { provider: 'fixture-hosting', region: 'fixture-region' },
  services: { web: {} }, storage: { documents: { provider: 'fixture-storage', type: 'bucket', region: 'fixture-region', injectInto: ['web'] } } });
const cronSpec = environmentSpecSchema.parse({ ...spec,
  services: { cron: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 8 * * *' } },
  storage: { documents: { ...spec.storage!.documents, injectInto: ['cron'] } } });
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-runtime-identity-'));
  SqliteAdapter.resetInstance();
  initializeDatabase(path.join(directory, 'test.db'));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

// The shared planner consumes provider contracts, not a particular cloud's
// retired handwritten reconciler. These fixtures model each possible receipt
// without granting lifecycle capability to any production cloud provider.
function fixture(options: { cron?: boolean; missingImage?: boolean; unverifiedUpdate?: boolean;
  confirmedAbsent?: boolean; updateFails?: boolean } = {}) {
  const name = options.cron ? 'cron' : 'web';
  const project = new ProjectRepository().create({ name: 'runtime-identity', defaultPlatform: 'fixture-hosting' });
  new ServiceRepository().create({ projectId: project.id, name,
    buildConfig: options.cron ? cronSpec.services.cron : { workloadKind: 'web' } });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'test', platformBindings: {
    projectId, environmentId: 'fixture-region', region: 'fixture-region', services: {
      [name]: { serviceId: `bound-${name}` },
    },
    storage: { documents: { provider: 'fixture-storage', externalId: 'documents-bucket', region: 'fixture-region',
      instanceScope: { projectId }, services: [], envKeys: [] } },
  } });
  const originalMetadata = providerRegistry.getMetadata.bind(providerRegistry);
  vi.spyOn(providerRegistry, 'getMetadata').mockImplementation((provider) => provider === 'fixture-storage'
    ? { name: provider, displayName: 'Synthetic storage contract', category: 'storage',
      credentialsSchema: z.object({}), storageRuntimeContract: 'fixture-native-identity-v1' }
    : originalMetadata(provider));
  const identity: ProviderRuntimeIdentity = { provider: 'fixture-hosting', principal, scope: { projectId },
    source: options.confirmedAbsent ? 'configured' : 'observed' };
  const resolveIdentity = vi.fn<NonNullable<IProviderAdapter['resolveRuntimeIdentity']>>(async (_environment, service) => {
    expect(service.name).toBe(name);
    return identity;
  });
  const writes: Record<string, string>[] = [];
  const setEnvVars = vi.fn<IProviderLifecycleAdapter['setEnvVars']>(async (_environment, _service, vars) => {
    if (options.missingImage) return { success: true, message: 'Synthetic image is absent',
      data: { skipped: true, reason: 'missing_existing_job_image' } };
    if (options.updateFails) return { success: false, message: 'Synthetic update failure' };
    writes.push({ ...vars });
    if (options.unverifiedUpdate) return { success: false, message: 'Synthetic update accepted but readback differs',
      data: { pending: true } };
    return { success: true, message: 'Synthetic runtime update verified' };
  });
  const hosting = { name: 'fixture-hosting', resolveRuntimeIdentity: resolveIdentity, setEnvVars };
  const getRuntimeEnv = vi.fn<IStorageAdapter['getRuntimeEnv']>(async (_environment, context, externalId, _name, target) => {
    expect(context).toEqual({ projectId });
    expect(externalId).toBe('documents-bucket');
    expect(target).toEqual({ hostingProvider: 'fixture-hosting', connectionProvider: 'fixture-hosting', identity });
    return { OBJECT_STORAGE_PROVIDER: 'fixture-storage', OBJECT_STORAGE_BUCKET: externalId,
      FIXTURE_PROJECT: projectId, FIXTURE_BUCKET: externalId, FIXTURE_LEGACY_CREDENTIAL: '' };
  });
  const storage = { name: 'fixture-storage', capabilities: { usesWorkloadIdentity: true }, getRuntimeEnv };
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true,
    adapter: hosting as unknown as IProviderAdapter });
  vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true,
    connectionProvider: 'fixture-hosting', adapter: storage as unknown as IStorageAdapter });
  return { project, environment, resolveIdentity, writes, getRuntimeEnv, setEnvVars };
}

const runtimeKeys = ['OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'FIXTURE_PROJECT',
  'FIXTURE_BUCKET', 'FIXTURE_LEGACY_CREDENTIAL'];
function wiringPlan(environment: Environment, environmentSpec: EnvironmentSpec = spec) {
  return planStorage({ environment, environmentSpec, observed: {
    provider: 'fixture-hosting', observedAt: new Date().toISOString(), projectExists: true,
    databases: [], partial: false, warnings: [],
    services: Object.keys(environmentSpec.services).map((name) => ({ name, externalId: `bound-${name}`,
      status: 'running' as const, workloadKind: environmentSpec.services[name].workloadKind,
      customDomains: [], config: {}, envVarKeys: runtimeKeys, envVarHashes: {} })),
    storage: [{ provider: 'fixture-storage', kind: 'object', name: 'documents', externalId: 'documents-bucket',
      instanceScope: { projectId }, region: 'fixture-region', status: 'ready' }],
  } }).actions.filter((action) => action.id.includes(':wiring:') || action.id.includes(':unwiring:'));
}

describe('shared storage runtime credential boundary', () => {
  it('passes each consumer identity and connection alias to storage runtime projection', async () => {
    const f = fixture();
    const vars = await resolveStorageServiceEnvVars(f.project, spec, f.environment);
    expect(vars?.web.FIXTURE_LEGACY_CREDENTIAL).toBe('');
    expect(f.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(f.getRuntimeEnv).toHaveBeenCalledTimes(1);
    expect(f.writes).toEqual([]);
  });

  it('persists wiring only after a successful provider update and clears the legacy key', async () => {
    const f = fixture();
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec,
      action: wiringPlan(f.environment)[0] });
    expect(result.success).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ FIXTURE_LEGACY_CREDENTIAL: '' });
    expect(Object.keys(f.writes[0]).sort()).toEqual([...runtimeKeys].sort());
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect(wiringPlan(refreshed)[0].type).toBe('noop');
  });

  it('resolves a confirmed-absent new consumer before its local service row exists', async () => {
    const f = fixture({ confirmedAbsent: true });
    const services = new ServiceRepository();
    services.delete(services.findByProjectAndName(f.project.id, 'web')!.id);
    f.environment.platformBindings.services = {};
    const vars = await resolveStorageServiceEnvVars(f.project, spec, f.environment);
    expect(vars?.web.FIXTURE_LEGACY_CREDENTIAL).toBe('');
    expect(services.findByProjectAndName(f.project.id, 'web')).toBeNull();
  });

  it('does not persist runtime convergence when the provider update fails', async () => {
    const f = fixture({ updateFails: true });
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec,
      action: wiringPlan(f.environment)[0] });
    expect(result.success).toBe(false);
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect((refreshed.platformBindings.storage as Record<string, any>).documents.runtimeContracts).toBeUndefined();
    expect(wiringPlan(refreshed)[0].type).toBe('update');
  });

  it('does not mark cron wiring converged when the provider reports an unverified update', async () => {
    const f = fixture({ cron: true, unverifiedUpdate: true });
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: cronSpec,
      action: wiringPlan(f.environment, cronSpec)[0] });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ FIXTURE_LEGACY_CREDENTIAL: '' });
    expect(result.success).toBe(false);
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect((refreshed.platformBindings.storage as Record<string, any>).documents.runtimeContracts).toBeUndefined();
    expect(wiringPlan(refreshed, cronSpec)[0].type).toBe('update');
  });

  it('does not mark skipped cron wiring converged when no image can receive the variables', async () => {
    const f = fixture({ cron: true, missingImage: true });
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: cronSpec,
      action: wiringPlan(f.environment, cronSpec)[0] });
    expect(f.writes).toEqual([]);
    expect(result).toMatchObject({ success: false, data: { skipped: true, reason: 'missing_existing_job_image' } });
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect((refreshed.platformBindings.storage as Record<string, any>).documents.runtimeContracts).toBeUndefined();
    expect(wiringPlan(refreshed, cronSpec)[0].type).toBe('update');
  });

  it('marks cron wiring converged when the provider confirms the runtime update', async () => {
    const f = fixture({ cron: true });
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: cronSpec,
      action: wiringPlan(f.environment, cronSpec)[0] });
    expect(result.success).toBe(true);
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect(wiringPlan(refreshed, cronSpec)[0].type).toBe('noop');
  });

  it('retains the binding when cron unwiring skips a job without an image', async () => {
    const f = fixture({ cron: true, missingImage: true });
    const binding = (f.environment.platformBindings.storage as Record<string, any>).documents;
    binding.services = ['cron']; binding.envKeys = runtimeKeys;
    new EnvironmentRepository().updatePlatformBindings(f.environment.id, f.environment.platformBindings);
    const desired = environmentSpecSchema.parse({ ...cronSpec,
      storage: { documents: { ...cronSpec.storage!.documents, injectInto: [] } } });
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: desired,
      action: wiringPlan(f.environment, desired)[0] });
    expect(result).toMatchObject({ success: false, data: { skipped: true } });
    expect(f.writes).toEqual([]);
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect((refreshed.platformBindings.storage as Record<string, any>).documents.services).toEqual(['cron']);
  });

  it('rewires legacy key-complete consumers independently and reaches noop only after both converge', () => {
    const f = fixture();
    const twoConsumers = environmentSpecSchema.parse({ ...spec, services: { web: {}, worker: { workloadKind: 'worker' } },
      storage: { documents: { ...spec.storage!.documents, injectInto: ['web', 'worker'] } } });
    f.environment.platformBindings.services = { web: { serviceId: 'bound-web' }, worker: { serviceId: 'bound-worker' } };
    const binding = (f.environment.platformBindings.storage as Record<string, any>).documents;
    binding.services = ['web', 'worker']; binding.envKeys = runtimeKeys;
    const first = wiringPlan(f.environment, twoConsumers);
    expect(first.map((action) => action.type)).toEqual(['update', 'update']);
    expect(first[0].metadata?.runtimeContract).toBe('fixture-native-identity-v1:fixture-hosting');
    binding.runtimeContracts = { web: first[0].metadata!.runtimeContract };
    expect(wiringPlan(f.environment, twoConsumers).map((action) => action.type)).toEqual(['noop', 'update']);
    binding.runtimeContracts.worker = first[1].metadata!.runtimeContract;
    expect(wiringPlan(f.environment, twoConsumers).map((action) => action.type)).toEqual(['noop', 'noop']);
  });

  it('rejects stale runtime contract authority before any provider access', async () => {
    const f = fixture();
    const action = wiringPlan(f.environment)[0];
    action.metadata!.runtimeContract = 'obsolete-contract';
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec, action });
    expect(result).toMatchObject({ success: false, status: 'blocked' });
    expect(adapterFactory.getStorageAdapter).not.toHaveBeenCalled();
    expect(f.resolveIdentity).not.toHaveBeenCalled();
    expect(f.setEnvVars).not.toHaveBeenCalled();
  });
});
