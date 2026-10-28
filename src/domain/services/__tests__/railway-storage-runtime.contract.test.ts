import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphQLClient } from 'graphql-request';
import { execute, parse, validate } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { RailwayAdapter } from '../../../adapters/providers/railway/railway.adapter.js';
import { createRailwayStorageAdapter } from '../../../adapters/providers/railway/railway-storage.factory.js';
import { schema } from '../../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { adapterFactory } from '../adapter.factory.js';
import { applyStorageAction, planStorage } from '../storage-plan.service.js';
import { S3_STORAGE_RUNTIME_ENV_KEYS } from '../storage-runtime-env.js';
import type { Environment } from '../../entities/environment.entity.js';

const scope = { projectId: 'storage-project', environmentId: 'storage-environment' };
const contract = 'railway-s3-url-style-v1:railway';
const observation = JSON.parse(fs.readFileSync('test/provider-contracts/railway/storage-credentials.observation.json', 'utf8'));
const addressing = [
  { nativeStyle: 'path', canonicalStyle: 'path' },
  { nativeStyle: 'virtual', canonicalStyle: 'virtual' },
  { nativeStyle: observation.observation.archiveNativeUrlStyle as string, canonicalStyle: 'virtual' },
];
const spec = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: { web: {}, worker: { workloadKind: 'worker' } },
  storage: { documents: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: ['web', 'worker'] } } });
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-railway-storage-runtime-'));
  SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'test.db'));
});
afterEach(() => {
  vi.restoreAllMocks(); SqliteAdapter.resetInstance(); fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const project = new ProjectRepository().create({ name: 'storage-runtime', defaultPlatform: 'railway' });
  for (const name of ['web', 'worker']) new ServiceRepository().create({ projectId: project.id, name,
    buildConfig: { workloadKind: name === 'web' ? 'web' : 'worker' } });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'hosting-project', environmentId: 'hosting-environment',
    services: { web: { serviceId: 'bound-web' }, worker: { serviceId: 'bound-worker' } },
    storage: { documents: { provider: 'railway', externalId: 'bucket-id', region: 'sjc', instanceScope: scope,
      services: ['web', 'worker'], envKeys: [...S3_STORAGE_RUNTIME_ENV_KEYS] } },
  } });
  return { project, environment };
}

function wiring(environment: Environment) {
  return planStorage({ environment, environmentSpec: spec, observed: {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true, databases: [], partial: false, warnings: [],
    services: ['web', 'worker'].map(name => ({ name, externalId: `bound-${name}`, status: 'running' as const,
      workloadKind: name === 'web' ? 'web' as const : 'worker' as const,
      customDomains: [], config: {}, envVarKeys: [...S3_STORAGE_RUNTIME_ENV_KEYS], envVarHashes: {} })),
    storage: [{ name: 'documents', provider: 'railway', kind: 'object', externalId: 'bucket-id',
      instanceScope: scope, region: 'sjc', status: 'ready' }],
  } }).actions.filter(action => action.id.includes(':wiring:'));
}

// Railway documents both native addressing modes, including older path-style
// buckets. These are synthetic credential responses through the pinned SDL;
// the public contract, not the existing projection, determines the expectation.
// https://docs.railway.com/storage-buckets#url-style
function transport(urlStyle: string, unavailable = false) {
  const requests: Array<{ query: string; variables: Record<string, string> }> = [];
  const railway = new RailwayAdapter();
  const client = new GraphQLClient('https://runtime-contract.invalid/graphql/v2', { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const document = parse(body.query); expect(validate(schema, document)).toEqual([]);
    return Response.json(await execute({ schema, document, variableValues: body.variables, rootValue: {
      bucketS3Credentials: () => unavailable ? [] : [{ endpoint: 'https://storage.example.invalid', region: 'auto',
        bucketName: 'documents-example', accessKeyId: 'private-access-sentinel', secretAccessKey: 'private-secret-sentinel', urlStyle }],
    } }));
  } });
  Object.assign(railway, { client });
  return { adapter: createRailwayStorageAdapter(railway), requests };
}

describe('Railway storage runtime addressing contract', () => {
  it.each(addressing)('preserves reference credentials and canonicalizes observed $nativeStyle addressing', async ({ nativeStyle, canonicalStyle }) => {
    const f = fixture(), provider = transport(nativeStyle);
    const result = await provider.adapter.getRuntimeEnv(f.environment, scope, 'bucket-id', 'documents');
    expect(result).toEqual({ AWS_ENDPOINT_URL: '${{documents.ENDPOINT}}', AWS_ACCESS_KEY_ID: '${{documents.ACCESS_KEY_ID}}',
      AWS_SECRET_ACCESS_KEY: '${{documents.SECRET_ACCESS_KEY}}', AWS_S3_BUCKET_NAME: '${{documents.BUCKET}}',
      AWS_DEFAULT_REGION: '${{documents.REGION}}', AWS_S3_URL_STYLE: canonicalStyle });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].variables).toEqual({ ...scope, bucketId: 'bucket-id' });
    expect(parse(provider.requests[0].query).definitions.every(definition => definition.kind !== 'OperationDefinition'
      || definition.operation === 'query')).toBe(true);
  });

  it.each(addressing)('retains the existing non-Railway runtime projection with canonical $nativeStyle addressing', async ({ nativeStyle, canonicalStyle }) => {
    const f = fixture(), provider = transport(nativeStyle);
    f.environment.platformBindings.provider = 'fly';
    const result = await provider.adapter.getRuntimeEnv(f.environment, scope, 'bucket-id', 'documents');
    expect(result).toEqual({ AWS_ENDPOINT_URL: 'https://storage.example.invalid', AWS_ACCESS_KEY_ID: 'private-access-sentinel',
      AWS_SECRET_ACCESS_KEY: 'private-secret-sentinel', AWS_S3_BUCKET_NAME: 'documents-example',
      AWS_DEFAULT_REGION: 'auto', AWS_S3_URL_STYLE: canonicalStyle });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].variables).toEqual({ ...scope, bucketId: 'bucket-id' });
  });

  it('does not guess a runtime style when credential metadata cannot be observed', async () => {
    const f = fixture(), provider = transport('path', true);
    await expect(provider.adapter.getRuntimeEnv(f.environment, scope, 'bucket-id', 'documents')).rejects.toThrow();
    expect(provider.requests).toHaveLength(1);
  });

  it('requires the new projection per existing consumer even when every variable name is present', () => {
    const { environment } = fixture();
    const binding = (environment.platformBindings.storage as Record<string, any>).documents;
    expect(wiring(environment).map(action => action.type)).toEqual(['update', 'update']);
    expect(wiring(environment).map(action => action.metadata?.runtimeContract)).toEqual([contract, contract]);
    binding.runtimeContracts = { web: contract, worker: 'obsolete-contract:railway' };
    expect(wiring(environment).map(action => action.type)).toEqual(['noop', 'update']);
    binding.runtimeContracts.worker = contract;
    expect(wiring(environment).map(action => action.type)).toEqual(['noop', 'noop']);
  });

  it('rejects a versionless reviewed wiring action before provider access', async () => {
    const f = fixture();
    const action = wiring(f.environment)[0]; action.type = 'update'; delete action.metadata!.runtimeContract;
    const getStorage = vi.spyOn(adapterFactory, 'getStorageAdapter').mockRejectedValue(new Error('Unexpected provider access.'));
    await expect(applyStorageAction({ project: f.project, envName: f.environment.name, environmentSpec: spec, action }))
      .resolves.toMatchObject({ success: false, status: 'blocked' });
    expect(getStorage).not.toHaveBeenCalled();
  });

  it('records the new projection only after applying the canonical style with unchanged references', async () => {
    const f = fixture(), provider = transport('path');
    vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter: provider.adapter });
    const writes: Record<string, string>[] = [];
    const hosting = new RailwayAdapter();
    vi.spyOn(hosting, 'setEnvVars').mockImplementation(async (_environment, _service, variables) => {
      writes.push(variables); return { success: true, message: 'Synthetic applied environment update.' };
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: hosting });
    const result = await applyStorageAction({ project: f.project, envName: f.environment.name, environmentSpec: spec,
      action: wiring(f.environment)[0] });
    expect(result.success).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ AWS_S3_URL_STYLE: 'path', AWS_ACCESS_KEY_ID: '${{documents.ACCESS_KEY_ID}}',
      AWS_SECRET_ACCESS_KEY: '${{documents.SECRET_ACCESS_KEY}}' });
    expect(JSON.stringify(writes)).not.toContain('private-');
    const refreshed = new EnvironmentRepository().findById(f.environment.id)!;
    expect((refreshed.platformBindings.storage as Record<string, any>).documents.runtimeContracts).toEqual({ web: contract });
    expect(wiring(refreshed).map(action => action.type)).toEqual(['noop', 'update']);
  });
});
