import { describe, expect, it, vi } from 'vitest';
import '../../../ci/providers.js';
import '../../../adapters/providers/gcp/gcs.adapter.js';
import '../../../adapters/providers/azure/azure-blob.adapter.js';
import '../../../adapters/providers/aws/s3.adapter.js';
import type { Component } from '../../entities/component.entity.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { Project } from '../../entities/project.entity.js';
import type { DailyBackupObservation } from '../../ports/daily-backup.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import type { BackupPolicyContext } from '../backup-policy.service.js';
import { resolveManagedBackupTarget } from '../managed-backup-target.service.js';

function fixture() {
  const now = new Date();
  const scope = { projectId: 'native-project', environmentId: 'native-environment' };
  const bucket = { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: [] };
  const spec = environmentSpecSchema.parse({ hosting: { provider: 'railway' }, services: {},
    database: { provider: 'railway', engine: 'postgres' },
    storage: { documents: bucket, vault: { ...bucket, purpose: 'backup' } },
    backups: { mode: 'daily', destination: 'vault', runnerImage: `ghcr.io/example/helper@sha256:${'a'.repeat(64)}`,
      fileReferenceQueries: [{ storageName: 'documents', query: 'SELECT key FROM documents' }] },
  });
  const binding = (externalId: string) => ({ provider: 'railway', externalId, instanceScope: { ...scope }, region: 'sjc', services: [], envKeys: [] });
  const storage = { documents: binding('document-bucket'), vault: binding('backup-bucket') };
  const environment: Environment = { id: 'env', projectId: 'project', name: 'production', createdAt: now, updatedAt: now,
    platformBindings: { provider: 'railway', ...scope, storage } };
  const project: Project = { id: 'project', name: 'test-project', defaultPlatform: 'railway', policies: {}, createdAt: now, updatedAt: now };
  const component: Component = { id: 'db', environmentId: environment.id, type: 'postgres', externalId: 'database-service',
    bindings: { provider: 'railway', projectId: scope.projectId, providerScope: { ...scope } }, createdAt: now, updatedAt: now };
  const observation: Extract<DailyBackupObservation, { state: 'known' }> = { state: 'known', daily: true, mechanism: 'snapshot', policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64),
    source: { provider: 'railway', primaryExternalId: 'database-service', providerScope: { ...scope }, resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'volume-instance' } } };
  const observe = vi.fn(async () => observation), configureDaily = vi.fn();
  const getCredentials = vi.fn();
  const factory = {
    getDatabaseAdapter: vi.fn(async (provider: string) => ({ success: true, adapter: { name: provider, dailyBackups: { observe, configureDaily } } })),
    getProviderAdapter: vi.fn(),
    getStorageAdapter: vi.fn(async (provider: string) => ({ success: true, adapter: { name: provider,
      ...(provider === 'railway' ? { capabilities: { recoveryCredentialScope: 'bucket' }, getCredentials } : {}) } })),
  };
  const context: BackupPolicyContext = { spec, project, environment, components: [component], adapterFactory: factory as unknown as BackupPolicyContext['adapterFactory'] };
  return { context, spec, environment, component, storage, observation, observe, configureDaily, getCredentials, factory };
}

describe('managed backup target admission', () => {
  it('admits object-only recovery without unrelated hosting identifiers', async () => {
    const f = fixture();
    delete f.spec.database;
    f.context.components = [];
    f.spec.hosting.provider = 'vercel';
    f.environment.platformBindings = { provider: 'vercel', storage: f.storage };
    if (f.spec.backups?.mode === 'daily') f.spec.backups.fileReferenceQueries = [];
    const result = await resolveManagedBackupTarget(f.context);
    expect(result.state).toBe('ready');
    if (result.state === 'ready') expect(result.providerCredentialNames).toEqual(['RAILWAY_API_TOKEN']);
    expect(f.observe).not.toHaveBeenCalled();
  });

  it.each(['projectId', 'environmentId', 'both'])(
    'blocks private database recovery when hosting placement lacks %s', async missing => {
      const f = fixture();
      if (missing !== 'environmentId') delete f.environment.platformBindings.projectId;
      if (missing !== 'projectId') delete f.environment.platformBindings.environmentId;
      // A valid, independently observed DB source does not place the private
      // runner: Railway's network is isolated to its project/environment.
      // https://docs.railway.com/networking/private-networking
      const result = await resolveManagedBackupTarget(f.context);
      expect(result.state).toBe('blocked');
      if (result.state === 'blocked') expect(result.issues).toContain('The complete backup execution contract is not available yet.');
      expect(f.getCredentials).not.toHaveBeenCalled();
      expect(f.configureDaily).not.toHaveBeenCalled();
    });

  it('blocks a database provider outside the hosting adapter private-reference contract', async () => {
    const f = fixture();
    // Railway private DNS is scoped to its own project/environment; a Cloud SQL
    // connection requires its own VPC/connector path, which this executor lacks.
    // https://docs.railway.com/networking/private-networking
    f.spec.database!.provider = 'cloudsql'; f.component.bindings.provider = 'cloudsql';
    f.component.bindings.providerScope = { projectId: 'external-gcp-project' };
    f.observation.source.provider = 'cloudsql';
    f.observation.source.providerScope = { projectId: 'external-gcp-project' };
    f.observation.source.resourceIdentity = { instanceId: 'database-service' };
    const result = await resolveManagedBackupTarget(f.context);
    expect(result.state).toBe('blocked');
    if (result.state === 'blocked') expect(result.issues.join(' ')).toMatch(/private.*database provider/);
    expect(f.getCredentials).not.toHaveBeenCalled();
    expect(f.configureDaily).not.toHaveBeenCalled();
  });

  it('resolves exact SQL and file identities with registered provider contracts without retrieving credentials or writing', async () => {
    const f = fixture();
    const result = await resolveManagedBackupTarget(f.context);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error(JSON.stringify(result.issues));
    expect(result.target).toMatchObject({ database: { componentId: 'db', source: f.observation.source },
      destination: { name: 'vault', identity: { provider: 'railway', externalId: 'backup-bucket', instanceScope: f.storage.vault.instanceScope } },
      objects: [{ name: 'documents', identity: { provider: 'railway', externalId: 'document-bucket', instanceScope: f.storage.documents.instanceScope } }] });
    expect(result.providerCredentialNames).toEqual(['RAILWAY_API_TOKEN']);
    expect(result.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.observe).toHaveBeenCalledWith({ environment: f.environment, component: f.component });
    expect(f.getCredentials).not.toHaveBeenCalled(); expect(f.configureDaily).not.toHaveBeenCalled();
  });

  it.each(['helper', 'destination', 'scope', 'storage-provider', 'region', 'references'])(
    'blocks a missing or mismatched %s prerequisite', async change => {
      const f = fixture();
      if (change === 'helper' && f.spec.backups?.mode === 'daily') delete f.spec.backups.runnerImage;
      if (change === 'destination') delete (f.storage as Partial<typeof f.storage>).vault;
      if (change === 'scope') f.storage.vault.instanceScope = {} as typeof f.storage.vault.instanceScope;
      if (change === 'storage-provider') f.storage.documents.provider = 'gcs';
      if (change === 'region') f.storage.documents.region = 'different-region';
      if (change === 'references' && f.spec.backups?.mode === 'daily') f.spec.backups.fileReferenceQueries = [];
      const result = await resolveManagedBackupTarget(f.context);
      expect(result.state).toBe('blocked');
      if (result.state !== 'blocked') return;
      expect(result.issues.join(' ')).toMatch(change === 'helper' ? /published immutable/ : change === 'references' ? /file-reference query/ : /storage identity/);
      expect(f.getCredentials).not.toHaveBeenCalled(); expect(f.configureDaily).not.toHaveBeenCalled();
    });

  it.each(['gcs', 'azureblob'])('explicitly blocks combined SQL/%s without a reviewed worker credential handoff', async provider => {
    const f = fixture();
    expect(providerRegistry.getMetadata(provider)?.name).toBe(provider);
    f.spec.storage!.documents.provider = provider;
    f.storage.documents.provider = provider;
    const result = await resolveManagedBackupTarget(f.context);
    expect(result.state).toBe('blocked');
    if (result.state !== 'blocked') return;
    expect(result.issues).toContain(`${provider} has no reviewed private-worker credential handoff for combined SQL/files recovery.`);
    expect(f.factory.getStorageAdapter).toHaveBeenCalledWith(provider, f.context.project);
    expect(f.getCredentials).not.toHaveBeenCalled();
  });

  it.each(['provider', 'scope'])('does not accept a database observation from a different %s with the same resource ID', async change => {
    const f = fixture();
    if (change === 'provider') f.observation.source.provider = 'cloudsql';
    if (change === 'scope') f.observation.source.providerScope.environmentId = 'another-environment';
    const result = await resolveManagedBackupTarget(f.context);
    expect(result.state).toBe('blocked');
    expect(f.getCredentials).not.toHaveBeenCalled();
  });

  it('does not hand a broad S3 account key to the private worker merely because getCredentials exists', async () => {
    const f = fixture();
    f.spec.storage!.documents.provider = 's3'; f.storage.documents.provider = 's3';
    f.factory.getStorageAdapter.mockImplementation(async provider => ({ success: true, adapter: { name: provider,
      ...(provider === 'railway' ? { capabilities: { recoveryCredentialScope: 'bucket' } } : {}), getCredentials: f.getCredentials } }));
    const result = await resolveManagedBackupTarget(f.context);
    expect(result.state).toBe('blocked');
    if (result.state === 'blocked') expect(result.issues.join(' ')).toMatch(/handoff|scope/);
    expect(f.getCredentials).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}])('blocks legacy or malformed durable database scope %s with reconciliation guidance', async providerScope => {
    const f = fixture();
    f.component.bindings.providerScope = providerScope;
    const result = await resolveManagedBackupTarget(f.context);
    expect(result.state).toBe('blocked');
    if (result.state === 'blocked') expect(result.issues.join(' ')).toMatch(/re-import|re-plan/);
    expect(f.observe).not.toHaveBeenCalled();
  });

  it('preserves external database scope while blocking an unsupported private worker', async () => {
    const f = fixture();
    f.spec.database!.provider = 'cloudsql'; f.component.bindings.provider = 'cloudsql';
    f.component.bindings.providerScope = { projectId: 'external-gcp-project' };
    f.observation.source.provider = 'cloudsql';
    f.observation.source.providerScope = { projectId: 'external-gcp-project', region: 'us-central1' };
    f.observation.source.resourceIdentity = { instanceId: 'database-service' };
    const result = await resolveManagedBackupTarget(f.context);
    expect(result.state).toBe('blocked');
    expect(f.observe).toHaveBeenCalledWith({ environment: f.environment, component: f.component });
    expect(f.component.bindings.providerScope).toEqual({ projectId: 'external-gcp-project' });
    if (result.state === 'blocked') expect(result.issues.join(' ')).toMatch(/private.*database provider/);
  });
});
