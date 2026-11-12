import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunAdapter } from '../cloudrun.adapter.js';
import '../cloudsql.adapter.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import { compileDatabaseRestoreDrillFiles } from '../../../../domain/services/database-restore-drill.service.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import type { MaintenanceWorkloadSnapshot } from '../../../../domain/ports/maintenance.port.js';
import type { ProjectSpec } from '../../../../domain/spec/spec.schema.js';

const createdAt = new Date();
const environment: Environment = { id: 'env', projectId: 'project', name: 'production', createdAt, updatedAt: createdAt,
  platformBindings: { provider: 'cloudrun', projectId: 'gcp-project', environmentId: 'us-central1', services: { web: { serviceId: 'web', jobName: 'web-job', schedulerJobName: 'web-schedule' } } } };
const service: Service = { id: 'service', projectId: 'project', name: 'web', buildConfig: {}, envVarSpec: {}, createdAt, updatedAt: createdAt };
const parent = 'projects/gcp-project/locations/us-central1';

async function setup(state: 'running' | 'suspended' = 'running') {
  const adapter = new CloudRunAdapter();
  await adapter.connect({ projectId: 'gcp-project', region: 'us-central1', runtimeServiceAccountEmail: 'runtime@gcp-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project', private_key: 'dummy', client_email: 'deploy@gcp-project.iam.gserviceaccount.com' }) });
  Object.assign(adapter, { accessToken: 'token', tokenExpiry: new Date(Date.now() + 60_000) });
  const mutations: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith(':getIamPolicy')) return Response.json({ bindings: [], etag: 'policy-1' });
    if (method !== 'GET') {
      mutations.push(`${method} ${url}`);
      return Response.json({ error: { code: 403, status: 'PERMISSION_DENIED' } }, { status: 403 });
    }
    if (url.includes('cloudscheduler.googleapis.com')) return Response.json({ name: `${parent}/jobs/web-schedule`, state: state === 'running' ? 'ENABLED' : 'PAUSED', schedule: '* * * * *', timeZone: 'UTC', httpTarget: { uri: `https://run.googleapis.com/v2/${parent}/jobs/web-job:run`, httpMethod: 'POST' } });
    if (url.includes('/executions')) return Response.json({ executions: [] });
    if (url.includes('/jobs/')) return Response.json({ name: `${parent}/jobs/web-migration`, template: { template: { serviceAccount: 'runtime@gcp-project.iam.gserviceaccount.com' } } });
    return Response.json({ name: `${parent}/services/web`, scaling: state === 'running' ? { scalingMode: 'AUTOMATIC' } : { scalingMode: 'MANUAL', manualInstanceCount: 0 }, template: { containers: [{ image: `example.invalid/web@sha256:${'a'.repeat(64)}`, env: [] }] } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { adapter, mutations, fetchMock };
}

describe('GCP operational helpers respect engine ownership', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('blocks arbitrary environment tasks without creating or changing a job', async () => {
    const { adapter, mutations } = await setup();
    const result = await adapter.runJob(environment, service, 'npm run migrate');
    expect(mutations).toEqual([]);
    expect(result.receipt).toMatchObject({ success: false, data: { applied: 0, mutationAttempted: false } });
    expect(result.receipt.error).toMatch(/releaseCommand/);
    expect(adapter.capabilities.supportsOneOffTasks).toBe(false);
  });

  it('does not repair IAM or enable APIs from the logging helper', async () => {
    const { adapter, mutations } = await setup();
    const result = await adapter.repairLoggingAccess();
    expect(mutations).toEqual([]);
    expect(result).toMatchObject({ success: false, data: { applied: 0, mutationAttempted: false } });
    expect(result.error).toMatch(/setup|plan/i);
  });

  it.each(['web', 'cron'] as const)('blocks %s maintenance scaling and trigger changes outside a reviewed engine plan', async (workloadKind) => {
    for (const operation of ['suspend', 'resume'] as const) {
      const { adapter, mutations } = await setup(operation === 'suspend' ? 'running' : 'suspended');
      const snapshot: MaintenanceWorkloadSnapshot = { serviceId: 'web', workloadKind, wasRunning: true, cronSchedule: '* * * * *',
        providerState: { scaling: { scalingMode: 'AUTOMATIC' }, schedulerJobName: 'web-schedule', jobName: 'web-job', schedulerState: 'ENABLED', schedulerTimeZone: 'UTC', schedulerTarget: `https://run.googleapis.com/v2/${parent}/jobs/web-job:run` } };
      const result = operation === 'suspend' ? await adapter.suspendMaintenanceWorkload(environment, snapshot) : await adapter.resumeMaintenanceWorkload(environment, snapshot);
      expect(mutations).toEqual([]);
      expect(result).toMatchObject({ success: false, data: { applied: 0, mutationAttempted: false } });
      expect(result.error).toMatch(/plan/i);
    }
  });

  it('does not compile clone/delete workflows through Cloud SQL registry metadata', () => {
    const result = compileDatabaseRestoreDrillFiles({ project: { id: 'project', name: 'demo' } as any,
      spec: { version: 1, project: 'demo', environments: { production: { database: { provider: 'cloudsql', engine: 'postgres', resilience: { restoreDrill: { schedule: { cron: '0 4 * * 1' }, verificationQuery: 'SELECT 1' } } } } } } as unknown as ProjectSpec,
      environmentRepo: { findByProjectAndName: () => environment } as any,
      componentRepo: { findByEnvironmentAndType: () => ({ environmentId: 'env', type: 'postgres', externalId: 'db', bindings: { provider: 'cloudsql', instanceId: 'db', connectionName: 'gcp-project:us-central1:db', database: 'app' } }) } as any,
    });
    expect(result.files).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'database_restore_drill_unsupported' })]);
    expect(providerRegistry.getMetadata('cloudsql')?.orchestration?.databaseRestoreDrill).toBeUndefined();
  });
});
