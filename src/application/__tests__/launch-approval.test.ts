import { describe, expect, it } from 'vitest';
import { approvalToken } from '../launch.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';

const action = (type: PlanAction['type'], reason = 'OpenTofu will create it.'): PlanAction =>
  ({ id: 'database:postgres', type, resource: { kind: 'database', name: 'postgres', provider: 'gcp' }, verified: true, reason });

describe('launch approvals', () => {
  it('never lets approval of a create authorize replacing, deleting or adopting the same resource', () => {
    expect(approvalToken(action('create'))).toBe('database:postgres');
    expect(approvalToken(action('replace'))).toBe('replace:database:postgres');
    expect(approvalToken(action('destroy'))).toBe('destroy:database:postgres');
    expect(approvalToken({ ...action('update'), metadata: { engineAdopt: true } })).toBe('adopt:database:postgres');
  });
});

describe('resource access listed with the billing choice', () => {
  it('names each add-on the environment needs, and none it does not', async () => {
    const { neededResourceAccess } = await import('../launch.js');
    const base = { hosting: { provider: 'cloudrun', engine: 'opentofu' }, envVars: {}, services: { web: { workloadKind: 'web' } } } as never;
    expect(neededResourceAccess(base)).toEqual([]);
    const full = {
      hosting: { provider: 'cloudrun', engine: 'opentofu' }, envVars: {},
      services: { web: { workloadKind: 'web' }, worker: { workloadKind: 'worker', onDemand: { pendingWorkQuery: 'SELECT 0' } } },
      storage: { files: { access: 's3' } }, cache: { provider: 'memorystore' }, queues: { emails: {} },
    } as never;
    expect(neededResourceAccess(full).map((entry) => entry.id)).toEqual(['storage', 'storage-s3', 'memorystore', 'workers', 'queues']);
  });
});

describe('CI release targets', () => {
  it('include worker pools, not only services and jobs', async () => {
    const { ciReleaseTargets } = await import('../launch.js');
    const spec = { services: { web: { workloadKind: 'web' }, worker: { workloadKind: 'worker' }, tick: { workloadKind: 'cron' } } } as never;
    const targets = ciReleaseTargets(spec, { web: { serviceId: 'web-1' }, worker: { workerPoolName: 'worker-1' }, tick: { jobName: 'tick-1' } },
      { region: 'us-central1', gcpProjectId: 'demo-project', environmentName: 'gcp' });
    expect(targets.map((entry) => [entry.name, entry.kind, entry.resource])).toEqual([['web', 'services', 'web-1'], ['worker', 'workerPools', 'worker-1'], ['tick', 'jobs', 'tick-1']]);
  });
});
