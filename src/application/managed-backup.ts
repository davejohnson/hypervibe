import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { IDatabaseAdapter } from '../domain/ports/database.port.js';
import type { IHostingAdapter } from '../domain/ports/hosting.port.js';
import type { IStorageAdapter, StorageObjectClient } from '../domain/ports/storage.port.js';
import { providerRegistry } from '../domain/registry/provider.registry.js';
import { projectSpecSchema } from '../domain/spec/spec.schema.js';
import { repoBindingsFileSchema } from '../domain/spec/repo-bindings.schema.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { managedBackupCredentialKeys, managedBackupHostingScope, managedBackupProviderNames, managedBackupTargetHash, managedBackupTargetSchema, openRecoveryStorage, supportsManagedRecoveryDatabase, type ManagedBackupTarget } from '../domain/services/managed-backup-target.service.js';
import { resolveBackupStrategy, withBackupStorageDefaults } from '../domain/services/backup-strategy.service.js';
import { parseStorageBindings } from '../domain/services/storage-plan.service.js';
import { compileBackupWorkflow } from '../domain/services/backup-workflow.service.js';
import { createRecoverySet } from '../domain/services/recovery-set.service.js';
import { applyManagedRecoveryRetention, observeManagedRecoverySet, recordRecoveryExecution } from '../domain/services/recovery-set-health.service.js';
import { recoveryDatabaseBindings } from '../domain/services/recovery-database-bindings.js';
import { recoverySourceIdentityMatches, recoverySourceIdentitySchema } from '../domain/services/recovery-source.js';

export const backupReceiptSchema = z.object({ setId: z.string().uuid(), manifestKey: z.string().min(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  completedAt: z.string().datetime(), applied: z.literal(1), skipped: z.literal(0), databaseCount: z.number().int().min(0).max(1),
  objectCount: z.number().int().nonnegative(), restoreVerified: z.literal(true), cleanupVerified: z.literal(true) }).strict();

export function managedRecoveryExecutionId(repository: string, runId: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9]+$/.test(runId)) throw new Error('Recovery execution identity is invalid.');
  const hex = createHash('sha256').update(`${repository}\0${runId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function selectedCredentialNames(target: ManagedBackupTarget) {
  const names = new Set<string>();
  for (const provider of managedBackupProviderNames(target)) {
    const mapping = managedBackupCredentialKeys(provider);
    if (!mapping || !Object.keys(mapping).length) throw new Error('Recovery provider credential contract is unavailable.');
    Object.keys(mapping).forEach(name => names.add(name));
  }
  return [...names].sort();
}

/** Verify the reviewed default-branch program and durable bindings before credentials or writes. */
export async function verifyManagedBackupAuthority(params: {
  target: unknown; contractHash: string; runnerImage: string; repository: string; sha: string; ref: string;
  github: GitHubAdapter;
}): Promise<{ target: ManagedBackupTarget; environment: Environment }> {
  const target = managedBackupTargetSchema.parse(params.target);
  if (managedBackupTargetHash(target) !== params.contractHash || params.runnerImage !== target.runnerImage
    || !/^[a-f0-9]{40}$/.test(params.sha)) throw new Error('The reviewed backup program differs.');
  const [owner, repo, extra] = params.repository.split('/');
  if (!owner || !repo || extra) throw new Error('Backup repository scope is invalid.');
  const repository = await params.github.getRepository(owner, repo);
  if (params.ref !== `refs/heads/${repository.default_branch}`) throw new Error('Backup execution requires the default branch.');
  const reference = await params.github.getRef(owner, repo, `heads/${repository.default_branch}`);
  if (reference?.object.sha !== params.sha) throw new Error('The default branch changed before backup execution.');
  const spec = projectSpecSchema.parse(JSON.parse(await params.github.getFileContent(owner, repo, '.hypervibe/spec.json', params.sha) ?? ''));
  if ((spec.github?.repository ?? parseGitHubRepoFromRemote(spec.gitRemoteUrl)) !== params.repository) throw new Error('Backup desired state belongs to another repository.');
  const bindings = repoBindingsFileSchema.parse(JSON.parse(await params.github.getFileContent(owner, repo, '.hypervibe/bindings.json', params.sha) ?? ''));
  const raw = spec.environments[target.environment];
  if (!raw || spec.project !== target.project || bindings.project !== target.project || raw.backups?.mode !== 'daily'
    || raw.backups.runnerImage !== target.runnerImage) throw new Error('The current spec does not authorize this backup program.');
  const desired = withBackupStorageDefaults(raw);
  if (resolveBackupStrategy(desired).destination !== target.destination.name) {
    throw new Error('The selected backup destination changed or became ambiguous.');
  }
  const bound = bindings.environments[target.environment]?.platformBindings;
  if (!bound || bound.provider !== target.hosting.provider || desired.hosting.provider !== target.hosting.provider
    || canonicalJsonSha256(raw.backups.fileReferenceQueries ?? []) !== canonicalJsonSha256(target.fileReferenceQueries)) throw new Error('Backup scope or reference projections changed.');
  const now = new Date();
  const environment: Environment = { id: target.environment, name: target.environment, projectId: target.project,
    platformBindings: bound, createdAt: now, updatedAt: now };
  const hostingScope = managedBackupTargetSchema.shape.hosting.shape.providerScope
    .safeParse(managedBackupHostingScope(environment, Boolean(desired.database)));
  if (!hostingScope.success || canonicalJsonSha256(hostingScope.data) !== canonicalJsonSha256(target.hosting.providerScope)) {
    throw new Error('Backup hosting scope changed.');
  }
  const storage = parseStorageBindings(environment);
  const sourceNames = Object.entries(desired.storage ?? {}).filter(([, item]) => item.purpose !== 'backup').map(([name]) => name).sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(target.objects.map(item => item.name).sort())
    || desired.storage?.[target.destination.name]?.purpose !== 'backup') throw new Error('Backup source inventory changed.');
  for (const item of [target.destination, ...target.objects]) {
    const value = storage[item.name];
    if (!value || canonicalJsonSha256({ provider: value.provider, externalId: value.externalId, instanceScope: value.instanceScope }) !== canonicalJsonSha256(item.identity)
      || desired.storage?.[item.name]?.provider !== item.identity.provider || desired.storage[item.name].region !== value.region) throw new Error('Backup storage binding changed.');
  }
  if (Boolean(target.database) !== Boolean(desired.database) || (target.database && desired.database?.provider !== target.database.source.provider)) throw new Error('Backup database declaration changed.');
  if (target.database && !supportsManagedRecoveryDatabase(target.hosting.provider, target.database.source.provider)) {
    throw new Error('Private recovery execution is unsupported for the selected database provider.');
  }
  if (target.database) {
    const selected = target.database;
    const sources = recoveryDatabaseBindings(bound.recoveryDatabases);
    if (sources.filter(source => source.componentId === selected.componentId && source.provider === selected.source.provider
      && source.externalId === selected.source.primaryExternalId && source.engine === desired.database!.engine).length !== 1) {
      throw new Error('The exported database recovery source changed.');
    }
  }
  const files = compileBackupWorkflow({ project: target.project, environment: target.environment, contractHash: params.contractHash,
    runnerImage: target.runnerImage, providerCredentialNames: selectedCredentialNames(target), contract: target });
  for (const file of files) if (await params.github.getFileContent(owner, repo, file.path, params.sha) !== file.content) throw new Error('The published backup program differs from reviewed content.');
  const workflows = await params.github.listWorkflows(owner, repo);
  const workflowPath = `.github/workflows/hypervibe-backup-${target.environment}.yml`;
  const matches = workflows.workflows.filter(item => item.path === workflowPath);
  if (workflows.total_count !== workflows.workflows.length || matches.length !== 1 || matches[0].state !== 'active') throw new Error('The backup schedule is not active or its inventory is incomplete.');
  return { target, environment };
}

/** This controller holds provider access; the private worker receives only its DB reference and selected bucket credentials. */
export async function executeManagedBackup(params: {
  target: ManagedBackupTarget; environment: Environment; operation: 'backup' | 'health'; repository: string; runId: string;
  credentials: NodeJS.ProcessEnv;
}) {
  const { target, environment } = params;
  if (target.database && !supportsManagedRecoveryDatabase(target.hosting.provider, target.database.source.provider)) {
    throw new Error('Private recovery execution is unsupported for the selected database provider.');
  }
  const adapters = new Map<string, unknown>();
  async function adapter(provider: string) {
    if (adapters.has(provider)) return adapters.get(provider);
    const keys = managedBackupCredentialKeys(provider);
    if (!keys) throw new Error('Recovery credential mapping is absent.');
    const credentials = Object.fromEntries(Object.entries(keys).map(([key, property]) => {
      if (!params.credentials[key]) throw new Error('Recovery provider credential is absent.');
      return [property, params.credentials[key]];
    }));
    const result = await providerRegistry.createAdapter(provider, credentials); adapters.set(provider, result); return result;
  }
  async function storageAdapter(provider: string): Promise<IStorageAdapter> {
    const connected = await adapter(provider), derive = providerRegistry.get(provider)?.derivedAdapters?.storage;
    return (derive ? await derive(connected, {}) : connected) as IStorageAdapter;
  }
  if (target.database) {
    try {
      const selected = target.database;
      const rows = recoveryDatabaseBindings(environment.platformBindings.recoveryDatabases)
        .filter(row => row.componentId === selected.componentId && row.provider === selected.source.provider
          && row.externalId === selected.source.primaryExternalId);
      if (rows.length !== 1) throw new Error('Source binding differs.');
      const row = rows[0], now = new Date();
      const component: Component = { id: row.componentId, environmentId: environment.id, type: row.engine,
        externalId: row.externalId, bindings: { provider: row.provider, providerScope: selected.source.providerScope,
          ...(row.resourceKind === undefined ? {} : { resourceKind: row.resourceKind }) }, createdAt: now, updatedAt: now };
      const connected = await adapter(row.provider), derive = providerRegistry.get(row.provider)?.derivedAdapters?.database;
      const database = (derive ? await derive(connected, { environment }) : connected) as IDatabaseAdapter;
      if (database.name !== row.provider || !database.dailyBackups?.observe) throw new Error('Source observation is unavailable.');
      const observed = await database.dailyBackups.observe({ environment, component });
      if (observed.state !== 'known'
        || !recoverySourceIdentityMatches(recoverySourceIdentitySchema.parse(observed.source), selected.source)) {
        throw new Error('Native source differs or is unknown.');
      }
    } catch {
      throw new Error('The current database source is unverified or differs from the reviewed backup program. Re-plan before continuing.');
    }
  }
  const destinationAdapter = await storageAdapter(target.destination.identity.provider);
  const archive = await openRecoveryStorage(destinationAdapter, environment, target.destination.identity);
  const sources: StorageObjectClient[] = [];
  try {
    if (params.operation === 'backup') {
      const setId = managedRecoveryExecutionId(params.repository, params.runId);
      let jobId: string;
      if (target.database) {
        if (!providerRegistry.getMetadata(target.hosting.provider)?.lifecycle?.hosting?.recoveryTasks) throw new Error('Private recovery execution is unsupported.');
        const hosting = await adapter(target.hosting.provider) as IHostingAdapter;
        if (!hosting.runJob || destinationAdapter.capabilities?.recoveryCredentialScope !== 'bucket' || !destinationAdapter.getCredentials) throw new Error('Private recovery credential handoff is unsupported.');
        const archiveCredentials = await destinationAdapter.getCredentials(environment, target.destination.identity.instanceScope, target.destination.identity.externalId);
        const objectCredentials: Record<string, unknown> = {}, objects = [];
        for (const item of target.objects) {
          const storage = await storageAdapter(item.identity.provider);
          if (storage.capabilities?.recoveryCredentialScope !== 'bucket' || !storage.getCredentials) throw new Error('Private recovery storage handoff is unsupported.');
          const client = await openRecoveryStorage(storage, environment, item.identity); client.destroy();
          const credentials = await storage.getCredentials(environment, item.identity.instanceScope, item.identity.externalId);
          objectCredentials[item.name] = credentials; objects.push({ name: item.name, identity: item.identity, bucket: credentials.bucket });
        }
        const config = { version: 1, operation: 'recovery-set', runId: setId, project: target.project, environment: target.environment,
          contractHash: managedBackupTargetHash(target), database: { source: target.database.source }, destination: target.destination.identity,
          archiveBucket: archiveCredentials.bucket, objects, fileReferenceQueries: target.fileReferenceQueries };
        const now = new Date();
        const result = await hosting.runJob(environment, { id: 'hypervibe-recovery', projectId: target.project, name: 'hypervibe-recovery',
          buildConfig: { workloadKind: 'worker' }, envVarSpec: {}, createdAt: now, updatedAt: now },
        'node /opt/hypervibe/dist/ci/backup-runner.js', { timeoutMs: 45 * 60_000, managedRecoveryTask: {
          variableMode: 'references', sweep: false, expectedImage: target.runnerImage, executionId: setId,
          databaseSource: target.database.source,
          variableReferences: [{ sourceServiceId: target.database.source.primaryExternalId, variableName: 'DATABASE_URL', targetName: 'HYPERVIBE_BACKUP_DATABASE_URL' }],
          variables: { HYPERVIBE_BACKUP_CONFIG: JSON.stringify(config) },
          selectedSecretValues: { HYPERVIBE_BACKUP_STORAGE_CREDENTIALS_JSON: JSON.stringify(archiveCredentials), HYPERVIBE_BACKUP_OBJECTS_CREDENTIALS_JSON: JSON.stringify(objectCredentials) },
          ...(params.credentials.IMAGE_REGISTRY_USERNAME && params.credentials.IMAGE_REGISTRY_TOKEN
            ? { registryCredentials: { username: params.credentials.IMAGE_REGISTRY_USERNAME, token: params.credentials.IMAGE_REGISTRY_TOKEN } } : {}),
        } });
        if (!result.receipt.success || result.status !== 'completed' || result.exitCode !== 0
          || result.cleanupWarning || result.receipt.data?.cleanupVerified !== true) {
          throw new Error('Private backup execution or cleanup is unverified.');
        }
        // The private archive is the evidence boundary. Provider logs may include
        // secrets and are never needed to prove a completed recovery set.
        jobId = result.jobId;
      } else {
        const objects = [];
        for (const item of target.objects) {
          const client = await openRecoveryStorage(await storageAdapter(item.identity.provider), environment, item.identity);
          sources.push(client); objects.push({ name: item.name, identity: item.identity, client });
        }
        await createRecoverySet({ runId: setId, project: target.project, environment: target.environment,
          contractHash: managedBackupTargetHash(target), destination: target.destination.identity, archive, objects });
        jobId = `github-run-${params.runId}`;
      }
      await recordRecoveryExecution({ archive, target, setId, jobId });
      const retained = await applyManagedRecoveryRetention({ archive, target });
      if (!retained.success) return { version: 1 as const, environment: target.environment, status: 'unknown' as const,
        reasonCodes: ['retention-unknown'], counts: { applied: 1, skipped: 0 } };
    }
    const health = await observeManagedRecoverySet({ archive, target });
    return { version: 1 as const, environment: target.environment, status: health.status, reasonCodes: health.reasonCodes,
      ...(params.operation === 'backup' ? { counts: { applied: 1, skipped: 0 } } : {}) };
  } finally { archive.destroy(); for (const source of sources) source.destroy(); }
}
