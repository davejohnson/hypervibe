import { afterEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import { engineWorkerStatus } from '../infrastructure-engine.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); });

it('reports explicit Cloud Run worker counts and leaves an omitted count unknown', async () => {
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(':memory:').migrate();
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'pause-status', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/example/pause-status' });
  const env = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  ctx.repos.environments.replacePlatformBindingsIfUnchanged(env, { projectId: 'demo-project', environmentId: 'us-central1',
    engine: { kind: 'opentofu' }, services: { worker: { workerPoolName: 'fixed-worker' } } });
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'cloudrun', scope: 'example/pause-status', credentialsEncrypted: getSecretStore().encryptObject({
    projectId: 'demo-project', runtimeServiceAccountEmail: 'runtime@demo-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', private_key: 'test-key', client_email: 'deploy@demo-project.iam.gserviceaccount.com' }),
  }) });
  connections.updateStatus(connection.id, 'verified');
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('test-token');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { staging: {
    hosting: { provider: 'cloudrun' }, services: { worker: { workloadKind: 'worker', workerPaused: true } },
  } } });
  for (const count of [1, 0, undefined]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('https://run.googleapis.com/v2/projects/demo-project/locations/us-central1/workerPools/fixed-worker');
      return Response.json({ scaling: { scalingMode: 'MANUAL', manualInstanceCount: count } });
    }));
    const status = await engineWorkerStatus(ctx, project, spec, 'staging');
    expect(status).toEqual({ workers: [{ service: 'worker', mode: 'pause-requested', ...(count === undefined ? {} : { instances: count }) }], warnings: [] });
  }
});
