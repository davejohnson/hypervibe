import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../ci/providers.js';
import { executeManagedBackup, managedRecoveryExecutionId, verifyManagedBackupAuthority } from '../managed-backup.js';
import { managedBackupTargetHash, type ManagedBackupTarget } from '../../domain/services/managed-backup-target.service.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import type { Environment } from '../../domain/entities/environment.entity.js';
import { compileBackupWorkflow } from '../../domain/services/backup-workflow.service.js';

function fixture() {
  const identity = (externalId: string) => ({ provider: 'railway', externalId, instanceScope: { projectId: 'p', environmentId: 'e' } });
  const image = `ghcr.io/owner/helper@sha256:${'a'.repeat(64)}`;
  const target: ManagedBackupTarget = { version: 1, project: 'hls', environment: 'production', runnerImage: image,
    hosting: { provider: 'railway', providerScope: { projectId: 'p', environmentId: 'e' } }, destination: { name: 'vault', identity: identity('vault') },
    objects: [{ name: 'documents', identity: identity('docs') }], fileReferenceQueries: [], retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 };
  const storage = { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: [] };
  const spec = { version: 1, project: 'hls', gitRemoteUrl: 'git@github.com:owner/hls.git',
    runtime: { kind: 'node', version: '24' }, environments: { production: { hosting: { provider: 'railway' }, services: {},
      backups: { mode: 'daily', runnerImage: image, destination: 'vault' }, storage: { documents: storage, vault: { ...storage, purpose: 'backup' } } } } };
  const bound = (externalId: string, purpose?: 'backup') => ({ ...identity(externalId), services: [], envKeys: [], region: 'sjc', ...(purpose ? { purpose } : {}) });
  const bindings = { version: 1, project: 'hls', environments: { production: { platformBindings: {
    provider: 'railway', projectId: 'p', environmentId: 'e', storage: { documents: bound('docs'), vault: bound('vault', 'backup') },
  } } } };
  const contractHash = managedBackupTargetHash(target);
  const files = new Map(compileBackupWorkflow({ project: 'hls', environment: 'production', contractHash,
    runnerImage: image, providerCredentialNames: ['RAILWAY_API_TOKEN'], contract: target }).map(file => [file.path, file.content]));
  files.set('.hypervibe/spec.json', JSON.stringify(spec)); files.set('.hypervibe/bindings.json', JSON.stringify(bindings));
  const sha = 'b'.repeat(40);
  const github = { getRepository: vi.fn(async () => ({ default_branch: 'main' })), getRef: vi.fn(async () => ({ object: { sha } })),
    getFileContent: vi.fn(async (_owner: string, _repo: string, path: string) => files.get(path) ?? null),
    listWorkflows: vi.fn(async () => ({ total_count: 1, workflows: [{ path: '.github/workflows/hypervibe-backup-production.yml', state: 'active' }] })),
  };
  return { target, spec, bindings, files, github, input: { target, contractHash, runnerImage: image, repository: 'owner/hls', sha, ref: 'refs/heads/main', github: github as any } };
}

describe('reviewed recurring backup authority', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['matching', 'missing', 'replaced', 'duplicate', 'wrong-component', 'wrong-provider', 'secret-shaped-extra'])(
    'checks the exported database binding before recurring execution: %s', async change => {
      const { input, target, spec, bindings, files } = fixture();
      target.database = { componentId: 'component-database', source: { provider: 'railway', primaryExternalId: 'database-service',
        providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'instance' } } };
      target.fileReferenceQueries = [{ storageName: 'documents', query: 'SELECT key FROM files' }];
      Object.assign(spec.environments.production, { database: { provider: 'railway', engine: 'postgres' } });
      Object.assign(spec.environments.production.backups, { fileReferenceQueries: target.fileReferenceQueries });
      const row = { componentId: 'component-database', provider: 'railway', engine: 'postgres', externalId: 'database-service' };
      const platform = bindings.environments.production.platformBindings as Record<string, unknown>;
      platform.recoveryDatabases = [row];
      if (change === 'missing') delete platform.recoveryDatabases;
      if (change === 'replaced') row.externalId = 'replacement-database';
      if (change === 'duplicate') platform.recoveryDatabases = [row, { ...row }];
      if (change === 'wrong-component') row.componentId = 'different-component';
      if (change === 'wrong-provider') row.provider = 'cloudsql';
      if (change === 'secret-shaped-extra') Object.assign(row, { connectionString: 'postgres://must-not-export' });
      input.contractHash = managedBackupTargetHash(target);
      for (const file of compileBackupWorkflow({ project: target.project, environment: target.environment,
        contractHash: input.contractHash, runnerImage: target.runnerImage, providerCredentialNames: ['RAILWAY_API_TOKEN'], contract: target })) files.set(file.path, file.content);
      files.set('.hypervibe/spec.json', JSON.stringify(spec)); files.set('.hypervibe/bindings.json', JSON.stringify(bindings));
      if (change === 'matching') expect(await verifyManagedBackupAuthority(input)).toMatchObject({ target });
      else await expect(verifyManagedBackupAuthority(input)).rejects.toThrow();
    });
  it('accepts only the published program and exact default-branch resource bindings', async () => {
    const { input } = fixture();
    expect(await verifyManagedBackupAuthority(input)).toMatchObject({ target: input.target, environment: { name: 'production' } });
  });
  it.each(['hash', 'image', 'branch', 'head', 'scope', 'source', 'workflow', 'disabled-workflow', 'incomplete-inventory', 'excluded', 'foreign-repository'])(
    'rejects changed %s before a recurring task may run', async change => {
      const { input, github, files, bindings, spec } = fixture();
      if (change === 'hash') input.contractHash = 'c'.repeat(64);
      if (change === 'image') input.runnerImage = input.runnerImage.replace('a'.repeat(64), 'd'.repeat(64));
      if (change === 'branch') input.ref = 'refs/heads/feature';
      if (change === 'head') github.getRef.mockResolvedValue({ object: { sha: 'c'.repeat(40) } });
      if (change === 'scope') bindings.environments.production.platformBindings.projectId = 'other';
      if (change === 'source') bindings.environments.production.platformBindings.storage.documents.externalId = 'other';
      if (change === 'workflow') files.set('.github/workflows/hypervibe-backup-production.yml', 'manual program');
      if (change === 'disabled-workflow') github.listWorkflows.mockResolvedValue({ total_count: 1, workflows: [{ path: '.github/workflows/hypervibe-backup-production.yml', state: 'disabled_manually' }] });
      if (change === 'incomplete-inventory') github.listWorkflows.mockResolvedValue({ total_count: 2, workflows: [{ path: '.github/workflows/hypervibe-backup-production.yml', state: 'active' }] });
      if (change === 'excluded') (spec.environments.production.backups as unknown) = { mode: 'disabled', reason: 'Owner choice' };
      if (change === 'foreign-repository') spec.gitRemoteUrl = 'git@github.com:another/hls.git';
      files.set('.hypervibe/spec.json', JSON.stringify(spec)); files.set('.hypervibe/bindings.json', JSON.stringify(bindings));
      await expect(verifyManagedBackupAuthority(input)).rejects.toThrow();
    });
  it.each(['destination', 'source'] as const)('never hands broad S3 %s credentials to a private database worker', async location => {
    const { target } = fixture();
    target.database = { componentId: 'db', source: { provider: 'railway', primaryExternalId: 'db-service',
      providerScope: { projectId: 'p', environmentId: 'e' }, resourceIdentity: { volumeId: 'v', volumeInstanceId: 'vi' } } };
    const s3 = { name: 'files', identity: { provider: 's3', externalId: 's3-files', instanceScope: { accountId: '123456789012', region: 'us-east-1' } } };
    if (location === 'destination') { target.destination = s3; target.objects = []; }
    else target.objects = [s3];
    const archive = { destroy: vi.fn() }, runJob = vi.fn(async () => { throw new Error('Worker must not run with broad credentials.'); });
    const broadCredentials = vi.fn(async () => { throw new Error('Broad credentials must remain controller-only.'); });
    const bucketCredentials = vi.fn(async () => ({ bucket: 'vault', endpoint: 'https://example.invalid', accessKeyId: 'bucket-key',
      secretAccessKey: 'bucket-secret', region: 'auto', urlStyle: 'path' }));
    const objects = [target.destination, ...target.objects];
    const objectAdapter = (provider: string) => ({ name: provider,
      capabilities: { ...(provider === 'railway' ? { recoveryCredentialScope: 'bucket' } : {}) },
      observe: async () => objects.filter(item => item.identity.provider === provider).map(item => ({ ...item.identity, status: 'ready' })),
      openObjectTransfer: async () => archive,
      getCredentials: provider === 's3' ? broadCredentials : bucketCredentials,
    });
    const railway = providerRegistry.get('railway')!;
    vi.spyOn(railway.derivedAdapters!, 'storage').mockImplementation(async () => objectAdapter('railway'));
    vi.spyOn(railway.derivedAdapters!, 'database').mockResolvedValue({ name: 'railway', dailyBackups: {
      observe: async () => ({ state: 'known', source: target.database!.source, daily: true,
        policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot' }),
    } });
    vi.spyOn(providerRegistry, 'createAdapter').mockImplementation(async provider => provider === 's3' ? objectAdapter('s3') : { runJob });
    const environment: Environment = { id: 'environment', name: 'production', projectId: 'project',
      platformBindings: { recoveryDatabases: [{ componentId: 'db', provider: 'railway', engine: 'postgres', externalId: 'db-service', resourceKind: 'service' }] },
      createdAt: new Date(), updatedAt: new Date() };
    await expect(executeManagedBackup({ target, environment,
      operation: 'backup', repository: 'owner/hls', runId: '123', credentials: {
        RAILWAY_API_TOKEN: 'controller-token', AWS_ACCESS_KEY_ID: 'controller-access', AWS_SECRET_ACCESS_KEY: 'controller-secret',
      } })).rejects.toThrow(/handoff is unsupported/);
    expect(runJob).not.toHaveBeenCalled(); expect(broadCredentials).not.toHaveBeenCalled();
    expect(archive.destroy).toHaveBeenCalled();
  });

  it('uses a stable per-repository run identity so a retry cannot claim a new operation', () => {
    expect(managedRecoveryExecutionId('owner/hls', '123')).toBe(managedRecoveryExecutionId('owner/hls', '123'));
    expect(managedRecoveryExecutionId('owner/hls', '123')).not.toBe(managedRecoveryExecutionId('other/hls', '123'));
    expect(() => managedRecoveryExecutionId('owner/hls', 'bad')).toThrow();
  });
});
