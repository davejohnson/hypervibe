import { readFileSync } from 'node:fs';
import { executeSync, parse, validate } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../ci/providers.js';
import { executeManagedBackup } from '../managed-backup.js';
import { parseBackupHelperEnvironment } from '../../ci/backup-runner.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import type { ManagedBackupTarget } from '../../domain/services/managed-backup-target.service.js';
import type { StorageObjectClient } from '../../domain/ports/storage.port.js';
import { projectId, productionId, railwayHttpFixture, schema, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { createRailwayStorageAdapter } from '../../adapters/providers/railway/railway-storage.factory.js';
import * as retained from '../../domain/services/recovery-set-health.service.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const observation = JSON.parse(readFileSync('test/provider-contracts/railway/storage-credentials.observation.json', 'utf8'));

// Query/field types are checked against the pinned Railway schema. Credential
// contents and scope are reconstructed/synthetic. 'virtual-host' was independently
// classified from two live Railway bucket responses on 2026-10-28; all identifiers
// and credentials here are synthetic. Railway's URL-style docs and AWS virtual
// hosting docs establish its canonical virtual-hosted semantics. Object and task
// transports are stopped: the native credential adapter, controller serialization
// and worker parser all execute.
// This proves handoff compatibility, not a successful backup or live provider run.
async function fixture(style: string, environmentName: 'staging' | 'production') {
  const environmentId = environmentName === 'staging' ? stagingId : productionId;
  const credentials = new Map<string, Record<string, string>>([stagingId, productionId].flatMap(scope => ['archive', 'documents'].map(name => [
    `${scope}/bucket-${name}`,
    { endpoint: 'https://storage-contract.invalid', bucketName: `${name}-${scope}`, region: 'auto',
      accessKeyId: `synthetic-access-${name}-${scope}`, secretAccessKey: `synthetic-secret-${name}-${scope}`, urlStyle: style },
  ] as const)));
  const credentialScopes: Array<{ projectId: string; environmentId: string; bucketId: string }> = [];
  const http = await railwayHttpFixture({ responseOverride: ({ query, variables }) => {
    if (!query.includes('bucketS3Credentials')) return undefined;
    const document = parse(query);
    expect(validate(schema, document)).toEqual([]);
    const response = executeSync({ schema, document, variableValues: variables, rootValue: {
      bucketS3Credentials: (args: { projectId: string; environmentId: string; bucketId: string }) => {
        expect(args.projectId).toBe(projectId);
        const selected = credentials.get(`${args.environmentId}/${args.bucketId}`);
        expect(selected).toBeDefined();
        credentialScopes.push(args);
        return [selected];
      },
    } });
    expect(response.errors).toBeUndefined();
    return Response.json(response);
  } });
  http.environment.name = environmentName;
  http.environment.platformBindings.environmentId = environmentId;
  http.addService('database-service', 'postgres', environmentId);
  const volume = http.addVolume('database-service', environmentId, '/var/lib/postgresql/data');
  http.environment.platformBindings.recoveryDatabases = [{ componentId: 'database-component', provider: 'railway',
    engine: 'postgres', resourceKind: 'service', externalId: 'database-service' }];
  http.buckets.set('bucket-archive', { id: 'bucket-archive', name: 'archive', projectId });
  for (const scope of [stagingId, productionId]) http.environments.get(scope)!.config.buckets = {
    'bucket-archive': { region: 'sjc', isCreated: true, isDeleted: false },
    'bucket-documents': { region: 'sjc', isCreated: true, isDeleted: false },
  };
  const source = { provider: 'railway', primaryExternalId: 'database-service', providerScope: { projectId, environmentId },
    resourceIdentity: { volumeId: volume.id, volumeInstanceId: String(volume.instance.id) } };
  const identity = (externalId: string) => ({ provider: 'railway', externalId, instanceScope: { projectId, environmentId } });
  const target: ManagedBackupTarget = { version: 1, project: 'test', environment: environmentName,
    hosting: { provider: 'railway', providerScope: { projectId, environmentId } },
    runnerImage: `docker.io/example/recovery@sha256:${'a'.repeat(64)}`, database: { componentId: 'database-component', source },
    destination: { name: 'archive', identity: identity('bucket-archive') },
    objects: [{ name: 'documents', identity: identity('bucket-documents') }],
    fileReferenceQueries: [{ storageName: 'documents', query: 'SELECT storage_key AS key FROM documents' }],
    retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 };
  vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue(http.adapter);
  const storage = createRailwayStorageAdapter(http.adapter);
  const objects: StorageObjectClient = { list: vi.fn(), get: vi.fn(), put: vi.fn(), destroy: vi.fn() };
  storage.openObjectTransfer = vi.fn(async () => objects);
  vi.spyOn(providerRegistry.get('railway')!.derivedAdapters!, 'storage').mockResolvedValue(storage);
  const accepted: Array<ReturnType<typeof parseBackupHelperEnvironment>> = [];
  const run = vi.spyOn(http.adapter, 'runJob').mockImplementation(async (_environment, _service, command, options) => {
    expect(command).toBe('node /opt/hypervibe/dist/ci/backup-runner.js');
    const handoff = options!.managedRecoveryTask!;
    expect(handoff.variableReferences).toEqual([{ sourceServiceId: 'database-service', variableName: 'DATABASE_URL',
      targetName: 'HYPERVIBE_BACKUP_DATABASE_URL' }]);
    // Synthetic provider resolution supplies only the private DB references;
    // all config and storage bytes are the real controller's serialized output.
    accepted.push(parseBackupHelperEnvironment({ ...handoff.variables, ...handoff.selectedSecretValues,
      HYPERVIBE_BACKUP_DATABASE_URL: 'postgresql://test:synthetic-db-secret@postgres.railway.internal/railway',
      HYPERVIBE_BACKUP_PRIVATE_HOST: 'postgres.railway.internal' }));
    return { jobId: 'contract-only', status: 'failed', runner: 'railway-temp-service', durationMs: 0, mutationAttempted: false,
      diagnostic: { stage: 'task-preflight', category: 'unsupported' },
      receipt: { success: false, message: 'Contract test stops after worker input validation.', data: { cleanupVerified: true } } };
  });
  const record = vi.spyOn(retained, 'recordRecoveryExecution');
  const execute = () => executeManagedBackup({ target, environment: http.environment, operation: 'backup',
    repository: 'owner/project', runId: '123', credentials: { RAILWAY_API_TOKEN: 'synthetic-contract-token' } });
  return { http, environmentId, credentialScopes, run, record, accepted, execute, objects };
}

describe('native storage credentials through managed backup worker handoff', () => {
  it.each((['staging', 'production'] as const).flatMap(environmentName => [
    { environmentName, nativeStyle: 'path', canonicalStyle: 'path' },
    { environmentName, nativeStyle: 'virtual', canonicalStyle: 'virtual' },
    { environmentName, nativeStyle: observation.observation.archiveNativeUrlStyle as string, canonicalStyle: 'virtual' },
  ]))('passes $nativeStyle from the exact $environmentName bucket instances', async ({ environmentName, nativeStyle, canonicalStyle }) => {
    const f = await fixture(nativeStyle, environmentName);
    const failure = await f.execute().catch(error => error);
    expect(f.accepted).toHaveLength(1);
    expect(failure).toMatchObject({ diagnostic: { stage: 'task-preflight', category: 'unsupported',
      task: { mutationAttempted: false } } });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.accepted[0].credentials).toMatchObject({ bucket: `archive-${f.environmentId}`, urlStyle: canonicalStyle });
    expect(f.accepted[0].sourceCredentials.documents).toMatchObject({ bucket: `documents-${f.environmentId}`, urlStyle: canonicalStyle });
    expect(f.credentialScopes).toEqual([
      { projectId, environmentId: f.environmentId, bucketId: 'bucket-archive' },
      { projectId, environmentId: f.environmentId, bucketId: 'bucket-documents' },
    ]);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.objects.list).not.toHaveBeenCalled(); expect(f.objects.put).not.toHaveBeenCalled();
    expect(f.http.mutations).toEqual([]); expect(f.http.contractErrors).toEqual([]);
  });

  it('rejects unknown native styles before dispatch and without leaking rejected values', async () => {
    const f = await fixture('private-unrecognized-style', 'production');
    const failure = await f.execute().catch(error => error);
    expect(f.run.mock.calls).toHaveLength(0);
    expect(f.accepted).toEqual([]);
    expect(failure).toMatchObject({ diagnostic: { task: { mutationAttempted: false } } });
    expect(String(failure) + JSON.stringify(failure))
      .not.toMatch(/private-unrecognized-style|synthetic-access|synthetic-secret|synthetic-db-secret|synthetic-contract-token/);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.http.mutations).toEqual([]); expect(f.http.contractErrors).toEqual([]);
  });
});
