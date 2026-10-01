import { afterEach, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import type { EnvironmentTaskOptions } from '../../../../domain/ports/hosting.port.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('rejects a managed recovery helper before reading or executing an application image', async () => {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', credentials: JSON.stringify({ type: 'service_account',
    project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'token', tokenExpiry: new Date(Date.now() + 60_000) });
  const fetch = vi.fn(async () => new Response('not found', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const now = new Date();
  const environment: Environment = { id: 'env', projectId: 'project', name: 'production', createdAt: now, updatedAt: now,
    platformBindings: { provider: 'cloudrun', projectId: 'gcp-project', services: { web: { serviceId: 'app-web' } } } };
  const service: Service = { id: 'service', projectId: 'project', name: 'web', buildConfig: { builder: 'dockerfile' },
    envVarSpec: {}, createdAt: now, updatedAt: now };
  const options: EnvironmentTaskOptions = { managedRecoveryTask: { variableMode: 'references', sweep: false,
    expectedImage: `ghcr.io/example/hypervibe-backup@sha256:${'a'.repeat(64)}`, executionId: 'recovery-1',
    databaseSource: { provider: 'cloudsql', primaryExternalId: 'database', providerScope: { projectId: 'gcp-project' }, resourceIdentity: {} },
    variableReferences: [], variables: {} } };
  const result = await adapter.runJob(environment, service, 'hypervibe-backup', options);
  expect(result.receipt).toMatchObject({ success: false, data: { applied: 0, skipped: 1, mutationAttempted: false } });
  expect(result.receipt.message).toContain('does not implement managed recovery tasks');
  expect(fetch).not.toHaveBeenCalled();
});
