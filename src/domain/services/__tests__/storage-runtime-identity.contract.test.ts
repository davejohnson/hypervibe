import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { applyStorageAction, planStorage, resolveStorageServiceEnvVars } from '../storage-plan.service.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { EnvironmentSpec } from '../../spec/spec.schema.js';

const projectId = 'cloud-project';
const principal = `runtime@${projectId}.iam.gserviceaccount.com`;
const spec = environmentSpecSchema.parse({ hosting: { provider: 'cloudrun', region: 'us-central1' },
  services: { web: {} }, storage: { documents: { provider: 'gcs', type: 'bucket', region: 'us-central1', injectInto: ['web'] } } });
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

function fixture(options: { cron?: boolean; missingImage?: boolean; retainLegacyKey?: boolean } = {}) {
  const name = options.cron ? 'cron' : 'web';
  const resource = `projects/${projectId}/locations/us-central1/${options.cron ? 'jobs' : 'services'}/bound-${name}`;
  const project = new ProjectRepository().create({ name: 'runtime-identity', defaultPlatform: 'cloudrun' });
  const connectionRepo = new ConnectionRepository();
  const connection = connectionRepo.create({ provider: 'cloudrun', credentialsEncrypted: getSecretStore().encryptObject({
    projectId, runtimeServiceAccountEmail: principal, credentials: JSON.stringify({
      type: 'service_account', project_id: projectId, private_key: 'synthetic-management-key',
      client_email: `deploy@${projectId}.iam.gserviceaccount.com`,
    }),
  }) });
  connectionRepo.updateStatus(connection.id, 'verified');
  new ServiceRepository().create({ projectId: project.id, name,
    buildConfig: options.cron ? cronSpec.services.cron : { workloadKind: 'web' } });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'test', platformBindings: {
    projectId, environmentId: 'us-central1', region: 'us-central1', services: {
      [name]: { serviceId: `bound-${name}`, ...(options.cron ? { jobName: 'bound-cron', resourceUid: 'cron-resource-uid' } : {}) },
    },
    storage: { documents: { provider: 'gcs', externalId: 'documents-bucket', region: 'us-central1',
      instanceScope: { projectId }, services: [], envKeys: [] } },
  } });
  // Supply a cached synthetic access token; all resource calls still traverse
  // the real hosting/storage adapters and the serialized provider transport.
  const original = adapterFactory.getProviderAdapter.bind(adapterFactory);
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async (...args) => {
    const result = await original(...args);
    Object.assign(result.adapter!, { accessToken: 'synthetic-token', tokenExpiry: new Date(Date.now() + 60_000) });
    return result;
  });
  const task = { serviceAccount: principal, containers: [{
    ...(options.missingImage ? {} : { image: `registry.example/app@sha256:${'a'.repeat(64)}` }),
    env: [{ name: 'GOOGLE_CLOUD_CREDENTIALS_JSON', value: 'legacy-management-key' }],
  }] };
  let current: Record<string, any> = { name: resource, uid: 'cron-resource-uid', etag: 'current-etag',
    generation: '1', observedGeneration: '1', reconciling: false,
    terminalCondition: { state: 'CONDITION_SUCCEEDED' }, template: options.cron ? { template: task } : task };
  const writes: Record<string, any>[] = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(`https://run.googleapis.com/v2/${resource}`);
    if ((init?.method ?? 'GET') === 'GET') return Response.json(current);
    expect(init?.method).toBe('PATCH');
    const body = JSON.parse(String(init?.body)); writes.push(structuredClone(body));
    current = { ...current, template: { ...current.template, ...body.template } };
    if (options.retainLegacyKey) {
      const updatedTask = options.cron ? current.template.template : current.template;
      updatedTask.containers[0].env = updatedTask.containers[0].env.map((entry: { name: string; value: string }) =>
        entry.name === 'GOOGLE_CLOUD_CREDENTIALS_JSON' ? { ...entry, value: 'legacy-management-key' } : entry);
    }
    return Response.json({ name: `projects/${projectId}/locations/us-central1/operations/env-update`,
      done: true, response: { name: resource } });
  });
  vi.stubGlobal('fetch', request);
  return { project, environment, request, writes };
}

const runtimeKeys = ['OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_STORAGE_BUCKET', 'GOOGLE_CLOUD_CREDENTIALS_JSON'];
function wiringPlan(environment: Environment, environmentSpec: EnvironmentSpec = spec) {
  return planStorage({ environment, environmentSpec, observed: {
    provider: 'cloudrun', observedAt: new Date().toISOString(), projectExists: true,
    databases: [], partial: false, warnings: [],
    services: Object.keys(environmentSpec.services).map((name) => ({ name, externalId: `bound-${name}`,
      status: 'running' as const, workloadKind: environmentSpec.services[name].workloadKind,
      customDomains: [], config: {}, envVarKeys: runtimeKeys, envVarHashes: {} })),
    storage: [{ provider: 'gcs', kind: 'object', name: 'documents', externalId: 'documents-bucket',
      instanceScope: { projectId }, region: 'us-central1', status: 'ready' }],
  } }).actions.filter((action) => action.id.includes(':wiring:') || action.id.includes(':unwiring:'));
}

describe('shared storage runtime credential boundary', () => {
  it('resolves each consumer through the actual hosting identity and keeps alias keys out of desired env', async () => {
    const f = fixture();
    const vars = await resolveStorageServiceEnvVars(f.project, spec, f.environment);
    expect(vars?.web.GOOGLE_CLOUD_CREDENTIALS_JSON).toBe('');
    expect(JSON.stringify(vars)).not.toContain('synthetic-management-key');
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.writes).toEqual([]);
  });

  it('applies native wiring through the real provider update and clears a retained legacy key', async () => {
    const f = fixture();
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec,
      action: wiringPlan(f.environment)[0] });
    expect(result.success).toBe(true);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].template.containers[0].env).toContainEqual({ name: 'GOOGLE_CLOUD_CREDENTIALS_JSON', value: '' });
    expect(JSON.stringify(f.writes)).not.toContain('management-key');
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect(wiringPlan(refreshed)[0].type).toBe('noop');
  });

  it('resolves a confirmed-absent new consumer before its local service row exists', async () => {
    const f = fixture();
    const services = new ServiceRepository();
    services.delete(services.findByProjectAndName(f.project.id, 'web')!.id);
    f.environment.platformBindings.services = {};
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
    const vars = await resolveStorageServiceEnvVars(f.project, spec, f.environment);
    expect(vars?.web.GOOGLE_CLOUD_CREDENTIALS_JSON).toBe('');
    expect(services.findByProjectAndName(f.project.id, 'web')).toBeNull();
  });

  it('does not persist runtime convergence when the provider update fails', async () => {
    const f = fixture();
    const transport = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, init) => init?.method === 'PATCH'
      ? Response.json({ error: { message: 'Synthetic update failure' } }, { status: 400 })
      : transport(input, init));
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: spec,
      action: wiringPlan(f.environment)[0] });
    expect(result.success).toBe(false);
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect((refreshed.platformBindings.storage as Record<string, any>).documents.runtimeContracts).toBeUndefined();
    expect(wiringPlan(refreshed)[0].type).toBe('update');
  });

  it('does not mark cron wiring converged when accepted PATCH readback retains the legacy credential', async () => {
    const f = fixture({ cron: true, retainLegacyKey: true });
    const result = await applyStorageAction({ project: f.project, envName: 'test', environmentSpec: cronSpec,
      action: wiringPlan(f.environment, cronSpec)[0] });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].template.template.containers[0].env).toContainEqual({ name: 'GOOGLE_CLOUD_CREDENTIALS_JSON', value: '' });
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

  it('marks cron wiring converged after ready readback verifies the legacy key was cleared', async () => {
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
    expect(first[0].metadata?.runtimeContract).toBe('gcs-native-adc-v1:cloudrun');
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
    expect(f.request).not.toHaveBeenCalled();
  });
});
