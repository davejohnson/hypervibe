import { describe, expect, it } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { planStorage, storageEnvKeys } from '../storage-plan.service.js';

const spec = environmentSpecSchema.parse({
  hosting: { provider: 'railway' }, services: { api: {} },
  storage: { uploads: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['api'] } },
});

function env(platformBindings: Record<string, unknown> = {}): Environment {
  return { id: 'local-env', projectId: 'project', name: 'staging', platformBindings, createdAt: new Date(), updatedAt: new Date() };
}

function observed(storage: ObservedState['storage'] = [], envVarKeys: string[] = []): ObservedState {
  return {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
    projectId: 'rp', environmentId: 're', databases: [], partial: false, warnings: [], storage,
    services: [{ name: 'api', externalId: 'svc', workloadKind: 'web', customDomains: [], config: {}, envVarKeys, envVarHashes: {}, status: 'running' }],
  };
}

describe('storage-plan.service', () => {
  it('uses the standard AWS S3 runtime variable contract', () => {
    expect(storageEnvKeys('uploads')).toEqual([
      'AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      'AWS_S3_BUCKET_NAME', 'AWS_DEFAULT_REGION', 'AWS_S3_URL_STYLE',
    ]);
  });
  it('plans bucket creation before explicit service wiring', () => {
    const result = planStorage({ environmentSpec: spec, environment: env(), observed: observed() });
    expect(result.actions.find((item) => item.id === 'storage:uploads')).toMatchObject({ type: 'create', billable: true });
    expect(result.actions.find((item) => item.id === 'storage:uploads:wiring:api')).toMatchObject({
      type: 'update', dependsOn: ['storage:uploads', 'service:api'],
    });
  });

  it('does not silently adopt a same-name live bucket', () => {
    const result = planStorage({
      environmentSpec: spec,
      environment: env(),
      observed: observed([{ provider: 'railway', kind: 'object', externalId: 'bucket-1', name: 'uploads', region: 'sjc', status: 'ready' }]),
    });
    expect(result.actions[0]).toMatchObject({ type: 'update', metadata: expect.objectContaining({ blockedReason: 'unmanaged_conflict' }) });
    expect(result.unmanaged).toContainEqual(expect.objectContaining({ name: 'uploads' }));
  });

  it('blocks immutable region drift and reports wiring in sync by key presence', () => {
    const environment = env({ storage: { uploads: { provider: 'railway', externalId: 'bucket-1', region: 'iad', services: ['api'], envKeys: storageEnvKeys('uploads') } } });
    const result = planStorage({
      environmentSpec: spec,
      environment,
      observed: observed([{ provider: 'railway', kind: 'object', externalId: 'bucket-1', name: 'uploads', region: 'iad', status: 'ready' }], storageEnvKeys('uploads')),
    });
    expect(result.actions.find((item) => item.id === 'storage:uploads')).toMatchObject({ metadata: expect.objectContaining({ blockedReason: 'immutable_region' }) });
    expect(result.actions.find((item) => item.id.endsWith('wiring:api'))?.type).toBe('noop');
  });

  it('confirmation-gates managed bucket deletion after unwiring', () => {
    const withoutStorage = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { api: {} } });
    const environment = env({ storage: { uploads: { provider: 'railway', externalId: 'bucket-1', region: 'sjc', services: ['api'], envKeys: storageEnvKeys('uploads') } } });
    const result = planStorage({ environmentSpec: withoutStorage, environment, observed: observed() });
    expect(result.actions.find((item) => item.id === 'storage:uploads:destroy')).toMatchObject({
      type: 'destroy', dataBearing: true, requiresConfirm: true, dependsOn: ['storage:uploads:unwiring:api'],
    });
  });
});
