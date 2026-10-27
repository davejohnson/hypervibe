import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../../../application/providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../../application/context.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { specToBootstrapParams } from '../../spec/spec-bootstrap.js';
import { adapterFactory } from '../adapter.factory.js';
import { resolveBootstrapRuntimeInputs } from '../bootstrap-runtime-inputs.js';
import type { RuntimeSecretReference } from '../../ports/secret-destination.port.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hv-runtime-inputs-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  vi.stubGlobal('fetch', async () => { throw new Error('Network is disabled for runtime input projection tests'); });
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(join(directory, 'state.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
function fixture(extra: Record<string, unknown> = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'runtime-inputs', defaultPlatform: 'ecs' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'ecs' }, database: { provider: 'rds', engine: 'postgres' },
    services: { web: { databaseEnvAliases: { APP_DATABASE_URL: 'DATABASE_URL' } }, worker: { workloadKind: 'worker' } },
    envVars: { SETTING: 'ordinary', DATABASE_URL: 'explicit-database-reference', GENERATED_TOKEN: 'unaccepted-example' }, ...extra });
  ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', bindings: { provider: 'rds',
    connectionUrl: 'postgresql://app:synthetic-password@db.internal:5432/app', password: 'synthetic-password', username: 'app', database: 'app' } });
  ctx.repos.components.create({ environmentId: environment.id, type: 'redis', bindings: { connectionUrl: 'redis://cache.internal:6379' } });
  const params = { ...specToBootstrapParams(project.name, 'staging', environmentSpec), envVarsByService: { worker: { WORKER_SETTING: 'worker' } } };
  return { ctx, project, environment, environmentSpec, params };
}
describe('shared transient bootstrap runtime inputs', () => {
  it('preserves component/alias precedence and caller-approved generated/delegated values without regeneration', async () => {
    const f = fixture(); const paramsBefore = structuredClone(f.params);
    const managedSecretValues = { GENERATED_TOKEN: 'accepted-stable-generated-value', DELEGATED_TOKEN: 'accepted-delegated-value' };
    const resolved = await resolveBootstrapRuntimeInputs({ ...f, managedSecretValues });
    expect(resolved.envVars).toMatchObject({ SETTING: 'ordinary', DATABASE_URL: 'explicit-database-reference',
      DIRECT_URL: 'postgresql://app:synthetic-password@db.internal:5432/app', DATABASE_PASSWORD: 'synthetic-password',
      REDIS_URL: 'redis://cache.internal:6379', ...managedSecretValues });
    expect(resolved.envVarsByService).toEqual({ web: { APP_DATABASE_URL: 'postgresql://app:synthetic-password@db.internal:5432/app' }, worker: { WORKER_SETTING: 'worker' } });
    expect(await resolveBootstrapRuntimeInputs({ ...f, managedSecretValues })).toEqual(resolved);
    expect(f.params).toEqual(paramsBefore);
    expect((await resolveBootstrapRuntimeInputs(f)).envVars).not.toHaveProperty('DELEGATED_TOKEN');
    expect((await resolveBootstrapRuntimeInputs(f)).envVars?.GENERATED_TOKEN).toBe('unaccepted-example');
  });

  it('shares existing queue and per-service storage projection while preserving database aliases', async () => {
    const f = fixture({ queues: { jobs: {} }, storage: { uploads: { provider: 's3', type: 'bucket', region: 'us-west-2', injectInto: ['web'] } } });
    f.environment.platformBindings = { storage: { uploads: { provider: 's3', externalId: 'owned-upload-bucket', region: 'us-west-2', services: ['web'], envKeys: [],
      instanceScope: { accountId: '123456789012', region: 'us-west-2' } } } };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { capabilities: { queues: { backend: 'postgres' } } } } as any);
    const getRuntimeEnv = vi.fn(async () => ({ S3_BUCKET: 'owned-upload-bucket' }));
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter: { capabilities: { usesWorkloadIdentity: false }, getRuntimeEnv } } as any);
    const resolved = await resolveBootstrapRuntimeInputs(f);
    expect(resolved.queueEnvVars).toEqual({ QUEUE_BACKEND: 'postgres', QUEUE_NAMES: 'jobs' });
    expect(resolved.envVarsByService).toEqual({ web: { S3_BUCKET: 'owned-upload-bucket', APP_DATABASE_URL: 'postgresql://app:synthetic-password@db.internal:5432/app' } });
    expect(getRuntimeEnv).toHaveBeenCalledWith(f.environment, { accountId: '123456789012', region: 'us-west-2' }, 'owned-upload-bucket', 'uploads', expect.objectContaining({ serviceName: 'web' }));
  });

  it('retains immutable native references and refuses supplied plaintext for their keys', async () => {
    const f = fixture(); const reference: RuntimeSecretReference = { destination: { provider: 'gcp-secret-manager', projectId: 'owned-project', projectNumber: '123456789012', secretId: 'api-token' }, version: '3' };
    const params = { ...f.params, secretVersionRefs: { NATIVE_TOKEN: reference } };
    const resolved = await resolveBootstrapRuntimeInputs({ ...f, params });
    expect(resolved.secretVersionRefs).toEqual({ NATIVE_TOKEN: reference }); expect(resolved.envVars).not.toHaveProperty('NATIVE_TOKEN');
    await expect(resolveBootstrapRuntimeInputs({ ...f, params, managedSecretValues: { NATIVE_TOKEN: 'synthetic-do-not-materialize' } })).rejects.toThrow(/conflicting literal/);
  });

  it('rejects component lookup across app or environment scope', async () => {
    const f = fixture();
    await expect(resolveBootstrapRuntimeInputs({ ...f, environment: { ...f.environment, projectId: 'another-app' } })).rejects.toThrow(/exact project and environment/);
    await expect(resolveBootstrapRuntimeInputs({ ...f, params: { ...f.params, environmentName: 'production' } })).rejects.toThrow(/exact project and environment/);
  });
});
