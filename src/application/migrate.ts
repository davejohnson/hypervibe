import { browserApprovedRunActions } from './browser-approved-run.js';
import { acquireMigrationTargetLease, type MigrationTargetLease } from '../adapters/db/migration-target-lease.js';
import { cloudEngineFor } from './cloud-engines.js';
import { engineSecretStore } from './engine-secrets.js';
import { ConvergeExecutor } from '../domain/plan/converge.executor.js';
import { createCommandRegistry } from './commands.js';
import { MAINTENANCE_OPERATIONS } from '../domain/services/maintenance-plan.service.js';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { acquireManagedDatabaseAccess, type DatabaseAccessLease } from '../domain/services/database-access.service.js';
import { parsePostgresDatabaseIdentity } from '../domain/services/postgres-database-identity.js';
import { isDeepStrictEqual } from 'node:util';
import { finalCopyReceipt, migrationCutoverReadiness, protectForwardingTarget, targetWriteRecovery } from './migration-cutover-readiness.js';
import { desiredDomainServiceName } from '../domain/services/domain-attach-policy.js';
import { migrationDatabaseBindingConflict } from './migration-database-binding.js';
import { readHostingEnvVars } from '../domain/services/hosting-env.service.js';
import { bucketSummaries, compareMigrationBucket, hasVerifiedBuckets, missingDeployedBucket, prepareMigrationBuckets, selectMigrationBuckets } from './migration-storage.js';
import { launchEnvironment, type LaunchResult } from './launch.js';
import {
  ENGINE_DATABASE_URL_KEY,
  engineSecretId,
  observeSecret,
  resolveEngineContext,
  writeSecretVersion,
  type EngineBinding,
  type MigrationCopyEvidence,
} from './infrastructure-engine.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import { railwayExportPrefix } from '../domain/services/railway-export-prefix.js';
import { buildSourceBucketName } from '../domain/services/cloud-prepare.execute.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import {
  databaseExportScript,
  verifyTransferResourcesAbsent,
  recoverTerminalTransferResources,
  databaseManifestScript,
  storageCheckScript,
  databaseRestoreScript,
  parseTransferResult,
  signedObjectUrl,
  type DatabaseManifest,
  manifestsMatch,
  runTransferJob,
  transferCredentialHandoffProblem,
  databaseTransferScript,
  storageTransferScript,
  type DatabaseTransferResult,
  type StorageTransferResult,
  type TransferContext,
} from './migration-transfer-gcp.js';

/**
 * Moves an app from one environment (any provider Hypervibe can read) to a new
 * OpenTofu-managed environment, in one guided command.
 *
 * The source is only read. Hypervibe proposes the target from the source,
 * builds it with hv_launch, copies runtime secrets, the database and files
 * inside the target cloud, verifies the copy, then releases the app. Each step
 * that copies or replaces something stops for explicit approval first. Pausing
 * the source and moving its existing hostname (the final cutover) is a
 * separate, explicit step.
 */
export type MigrateResult =
  | LaunchResult
  | { status: 'needs_secret_import'; keys: string[]; leftOut?: string[]; message: string }
  | { status: 'needs_copy_approval'; database?: { tables: number; rows: string; version: string }; storage: string[]; message: string }
  | {
      status: 'migrated';
      target: string;
      urls: Record<string, string>;
      secretsImported: number;
      database?: { tables: number; rows: string; match: boolean; differences: string[]; restoreWarnings: number };
      storage: Array<{ name: string; files: number; bytes: number; match: boolean }>;
      /** Set when this run released an earlier verified copy instead of copying again. */
      dataCopiedAt?: string;
      next: string;
    }
  | { status: 'needs_cutover_approval'; domain: string; steps: string[]; message: string }
  | { status: 'cut_over'; domain: string; target: string; database?: { tables: number; rows: string; match: boolean; differences: string[] }; message: string }
  | {
      status: 'verified' | 'differs';
      target: string;
      /** Same tables, row counts and per-table content checksums. */
      database?: { tables: number; rows: string; match: boolean; differences: string[] };
      /** Same keys and file contents, verified by reading both copies. */
      storage: Array<{ name: string; files: number; bytes: number; match: boolean; differences: number }>;
      dataCopiedAt?: string;
      message: string;
    };

/** Settings providers manage themselves; these are regenerated on the target, never copied. */
const MANAGED_KEY = /^(DATABASE_URL|DATABASE_PUBLIC_URL|DATABASE_PRIVATE_URL|PG[A-Z0-9_]*|POSTGRES_[A-Z0-9_]*|PORT|HOSTNAME|RAILWAY_[A-Z0-9_]*|REDIS_URL|REDIS_[A-Z0-9_]*|QUEUE_[A-Z0-9_]*|OBJECT_STORAGE_[A-Z0-9_]*|GOOGLE_CLOUD_[A-Z0-9_]*|AWS_[A-Z0-9_]*|BUCKET[A-Z0-9_]*|HYPERVIBE_[A-Z0-9_]*|K_SERVICE|K_REVISION|K_CONFIGURATION|CLOUD_SQL_CONNECTION_NAME)$/;

/**
 * A value that points at the source's own data services (any name, for example
 * DIRECT_URL). Copying it would connect the target app back to the source.
 */
export function pointsAtSourceData(value: string): boolean {
  return /^(postgres(ql)?|mysql|redis|rediss|mongodb(\+srv)?|amqps?):\/\//i.test(value.trim());
}

/**
 * A setting named for the source environment (STAGING_* when moving staging) is
 * that environment's own credential, often guarded to its hostname. It is left
 * out and listed, never copied.
 */
export function scopedToEnvironment(key: string, environmentName: string): boolean {
  const prefix = environmentName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return prefix.length > 0 && key.startsWith(`${prefix}_`);
}

/** A target environment equivalent to the source on OpenTofu-managed Google Cloud. */
export function proposeTargetEnvironment(source: EnvironmentSpec, options: { region?: string; domain?: string; gcpProjectId?: string }): EnvironmentSpec {
  // Declared settings follow the same rule as settings read from the running source: nothing the
  // provider manages, and nothing that points back at the source's own data, is carried over.
  const envVars = Object.fromEntries(Object.entries(source.envVars).filter(([key, value]) => !MANAGED_KEY.test(key) && !pointsAtSourceData(value)));
  if (options.domain) {
    for (const [key, value] of Object.entries(envVars)) {
      // Keep URL settings consistent with the new hostname; anything else is copied as-is.
      if (/_URL$/.test(key) && source.domain && value.includes(source.domain)) envVars[key] = value.replaceAll(source.domain, options.domain);
    }
  }
  const target: Record<string, unknown> = {
    hosting: { provider: 'cloudrun', region: options.region ?? 'us-central1', ...(options.gcpProjectId ? { gcpProjectId: options.gcpProjectId } : {}) },
    services: Object.fromEntries(Object.entries(source.services).map(([name, service]) => [name, {
      workloadKind: service.workloadKind,
      ...(service.startCommand ? { startCommand: service.startCommand } : {}),
      ...(service.healthCheckPath ? { healthCheckPath: service.healthCheckPath } : {}),
      ...(service.cronSchedule ? { cronSchedule: service.cronSchedule } : {}),
      ...(service.timeZone ? { timeZone: service.timeZone } : {}),
      ...(service.public !== undefined ? { public: service.public } : {}),
    }])),
    envVars,
    ...(source.database ? { database: { provider: 'cloudsql' } } : {}),
    ...(source.cache ? { cache: { provider: 'memorystore', region: options.region ?? 'us-central1' } } : {}),
    ...(source.queues ? { queues: source.queues } : {}),
    ...(source.storage ? { storage: Object.fromEntries(Object.entries(source.storage).filter(([, storage]) => storage.purpose !== 'backup').map(([name, storage]) => [name, {
      provider: 'gcs', type: 'bucket', region: options.region ?? 'us-central1', injectInto: storage.injectInto,
      // Apps written for S3-style buckets (Railway, AWS) keep working unchanged.
      ...(['railway', 's3'].includes(storage.provider) ? { access: 's3' } : {}),
    }])) } : {}),
    // The engine runs schema migrations as a release step. A source that ran them through the
    // migration tool keeps its command in that form, so the move does not drop them.
    ...(source.migrations?.mode === 'releaseCommand' ? { migrations: source.migrations }
      : source.migrations?.mode === 'tool' && source.migrations.command ? { migrations: { mode: 'releaseCommand', command: source.migrations.command } } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
  };
  return target as EnvironmentSpec;
}

/**
 * One environment-wide value per setting name, from settings read service by service.
 * A name whose value differs between services has no single correct value, and a value the
 * provider could not resolve is not the real value; neither is copied. Both are reported.
 */
export function mergeServiceSettings(reads: Array<{ service: string; variables: Record<string, string>; unresolvedKeys?: string[] }>): { values: Record<string, string>; conflicting: string[]; unresolved: string[] } {
  const unresolved = new Set(reads.flatMap((read) => read.unresolvedKeys ?? []));
  const seen = new Map<string, Set<string>>();
  for (const read of reads) {
    for (const [key, value] of Object.entries(read.variables)) {
      if (!value || unresolved.has(key)) continue;
      seen.set(key, (seen.get(key) ?? new Set()).add(value));
    }
  }
  const conflicting = [...seen].filter(([, values]) => values.size > 1).map(([key]) => key).sort();
  const values = Object.fromEntries([...seen].filter(([, found]) => found.size === 1).map(([key, found]) => [key, [...found][0]!]));
  return { values, conflicting, unresolved: [...unresolved].sort() };
}

/** What the user is told about settings that could not be copied as one value. */
function notCopiedNote(notCopied: { conflicting: string[]; unresolved: string[] }): string {
  return (notCopied.conflicting.length ? ` Not copied because services use different values: ${notCopied.conflicting.join(', ')}. Set ${notCopied.conflicting.length === 1 ? 'it' : 'them'} on the target yourself.` : '')
    + (notCopied.unresolved.length ? ` Not copied because the source could not provide the real value: ${notCopied.unresolved.join(', ')}.` : '');
}

/** The runtime settings worth copying from a running source: not managed, not named for the source, not pointing at its data. */
async function sourceSettings(ctx: CommandContext, params: { project: Project; from: string; to: string; spec: ProjectSpec; sourceSpec: EnvironmentSpec; sourceEnvironment: Environment }):
Promise<{ values: Record<string, string>; keys: string[]; leftOut: string[]; notCopied: { conflicting: string[]; unresolved: string[] } } | { blocked: string }> {
  const reads: Parameters<typeof mergeServiceSettings>[0] = [];
  for (const serviceName of Object.keys(params.sourceSpec.services)) {
    const service = ctx.repos.services.findByProjectAndName(params.project.id, serviceName);
    if (!service) continue;
    const read = await readHostingEnvVars({ project: params.project, environment: params.sourceEnvironment, service });
    if (!read.success) return { blocked: `Could not read ${serviceName}'s settings on ${read.provider}: ${read.error}` };
    reads.push({ service: serviceName, variables: read.variables, ...(read.unresolvedKeys ? { unresolvedKeys: read.unresolvedKeys } : {}) });
  }
  const { values, conflicting, unresolved } = mergeServiceSettings(reads);
  const declared = new Set([...Object.keys(params.spec.environments[params.to]!.envVars), ...Object.entries(params.spec.secrets)
    .filter(([, secret]) => secret.ownership === 'hypervibe' && secret.environments.includes(params.to)).map(([key]) => key)]);
  const candidates = Object.keys(values).filter((key) => !declared.has(key) && !MANAGED_KEY.test(key) && !pointsAtSourceData(values[key]!)).sort();
  const leftOut = candidates.filter((key) => scopedToEnvironment(key, params.from));
  return { values, keys: candidates.filter((key) => !leftOut.includes(key)), leftOut, notCopied: { conflicting: conflicting.filter((key) => !declared.has(key) && !MANAGED_KEY.test(key)), unresolved: unresolved.filter((key) => !declared.has(key) && !MANAGED_KEY.test(key)) } };
}

/**
 * Migration into an engine that copies runtime settings only. The settings go
 * into the cloud's secret store after the user sees their names; the services
 * read them on the next infrastructure apply.
 */
async function migrateSettingsOnly(ctx: CommandContext, params: {
  project: Project; from: string; to: string; importSecrets?: boolean; copyData?: boolean; cutover?: boolean;
  spec: ProjectSpec; sourceSpec: EnvironmentSpec; sourceEnvironment: Environment;
}): Promise<MigrateResult> {
  const store = await engineSecretStore(ctx, params.project, params.spec, params.to);
  if ('blocked' in store) return { status: 'blocked', message: store.blocked };
  const target = ctx.repos.environments.findByProjectAndName(params.project.id, params.to);
  if (!target) return { status: 'blocked', message: `Environment ${params.to} has no local record yet. Run hv_plan scope="infrastructure" first.` };
  const environment = () => ctx.repos.environments.findById(target.id) ?? target;
  const engine = () => (environment().platformBindings as { engine?: EngineBinding }).engine ?? {};
  if (!engine().importedSecrets) {
    const settings = await sourceSettings(ctx, params);
    if ('blocked' in settings) return { status: 'blocked', message: settings.blocked };
    const { values, keys, leftOut, notCopied } = settings;
    if (!params.importSecrets) {
      return {
        status: 'needs_secret_import', keys, ...(leftOut.length ? { leftOut } : {}),
        message: `Hypervibe will copy ${keys.length} runtime setting(s) from ${params.from} into ${store.name} for ${params.to}. Values are copied directly and never shown.`
          + (leftOut.length ? ` ${leftOut.join(', ')} ${leftOut.length === 1 ? 'is' : 'are'} named for ${params.from} and stay${leftOut.length === 1 ? 's' : ''} there.` : '') + notCopiedNote(notCopied),
      };
    }
    for (const key of keys) {
      const failure = await store.write(key, values[key]!);
      if (failure) return { status: 'blocked', message: `${failure} Nothing was recorded as imported. Run the migration again.` };
    }
    ctx.repos.environments.updatePlatformBindings(target.id, { engine: { ...engine(), kind: 'opentofu', importedSecrets: keys } });
  }
  const imported = engine().importedSecrets ?? [];
  return { status: 'blocked', message: `${imported.length} runtime setting(s) are in ${store.name} for ${params.to}. Run hv_plan scope="infrastructure" and hv_apply so the services read them, then hv_deploy. Copying data to this cloud is not available yet.` };
}

interface MigrateParams {
  project: Project;
  from: string;
  to: string;
  gcpProjectId?: string;
  region?: string;
  domain?: string;
  billingAccountName?: string;
  gcpSetupPlanId?: string;
  browserAccess?: string;
  approveAccess?: string[];
  confirmActions?: string[];
  planId?: string;
  importSecrets?: boolean;
  copyData?: boolean;
  /** Copy the data again even though a verified copy exists (refresh before cutover). */
  refreshData?: boolean;
  /** Read-only: compare the source and target data (row counts and content checksums, downloaded file contents) without copying. */
  verifyOnly?: boolean;
  /**
   * Final move: pause the source behind its maintenance page, copy the data
   * again and verify it, then send the source's domain to the target.
   * Requires confirmCutover after the user approves the listed steps.
   */
  cutover?: boolean;
  confirmCutover?: boolean;
  sourceDirectory?: string;
}

export async function migrateEnvironment(ctx: CommandContext, params: MigrateParams): Promise<MigrateResult> {
  const lease = acquireMigrationTargetLease(params.project.id, params.to.trim());
  if (!lease) return { status: 'blocked', message: `A migration to ${params.to} is already running. Wait for it to finish before retrying.` };
  try {
    return await runMigration(ctx, params, lease);
  } finally {
    lease.close();
  }
}

async function runMigration(ctx: CommandContext, params: MigrateParams, lease: MigrationTargetLease): Promise<MigrateResult> {
  // Reject before even proposing or preparing a target. This applies equally
  // to every provider and to copy, refresh, verification and cutover resumes.
  if (params.from.trim() === params.to.trim()) {
    return { status: 'blocked', message: 'The migration source and target must be different environments. Migrating an environment into itself can erase its source data.' };
  }
  const store = new SpecStore();
  let specResult = store.get(params.project);
  if (!specResult) return { status: 'blocked', message: 'This project has no spec yet.' };
  const sourceSpec = specResult.spec.environments[params.from];
  if (!sourceSpec) return { status: 'blocked', message: `The spec has no source environment "${params.from}".` };
  const declaredTarget = specResult.spec.environments[params.to];
  if (params.gcpProjectId && declaredTarget && declaredTarget.hosting.gcpProjectId !== params.gcpProjectId) {
    return { status: 'blocked', message: `Migration target ${params.to} already selects ${declaredTarget.hosting.gcpProjectId ?? 'the repository default'}. Choose a new target environment to migrate to ${params.gcpProjectId}.` };
  }
  const sourceEnvironment = ctx.repos.environments.findByProjectAndName(params.project.id, params.from);
  if (!sourceEnvironment) return { status: 'blocked', message: `Environment ${params.from} has never been deployed by Hypervibe.` };
  const liveTarget = await protectForwardingTarget(params.project, specResult.spec, sourceEnvironment,
    ctx.repos.environments.findByProjectAndName(params.project.id, params.to), params.to, params);
  if (store.get(params.project)?.revision !== specResult.revision) return { status: 'blocked', message: `The routing configuration changed during the migration check. Verify the current route first. ${targetWriteRecovery}` };
  if (liveTarget) return liveTarget;
  const bindingConflict = () => migrationDatabaseBindingConflict(ctx, params.project, specResult!.spec,
    ctx.repos.environments.findById(sourceEnvironment.id) ?? sourceEnvironment,
    ctx.repos.environments.findByProjectAndName(params.project.id, params.to) ?? undefined);
  const initialConflict = bindingConflict();
  if (initialConflict) return { status: 'blocked', message: initialConflict };
  if (params.verifyOnly && sourceSpec.database?.provider === 'railway'
    && (!declaredTarget || declaredTarget.hosting.provider === 'cloudrun')) {
    return { status: 'blocked', message: 'Comparing private Railway PostgreSQL with Cloud SQL requires reviewed verification tasks on both providers. Hypervibe does not yet plan these tasks. Any saved copy receipt records the comparison at copy time.' };
  }


  // 1. Target: proposed from the source when it does not exist yet.
  if (!specResult.spec.environments[params.to]) {
    const proposed = proposeTargetEnvironment(sourceSpec, { region: params.region, domain: params.domain, gcpProjectId: params.gcpProjectId });
    specResult = store.merge(params.project, { environments: { [params.to]: proposed } });
  }
  const pendingTransfer = lease.pending();
  let sourcePlanApproval = false;
  if (params.planId) {
    const loaded = new ConvergeExecutor().loadPlan(params.planId);
    if ('error' in loaded) return { status: 'blocked', message: loaded.error };
    if (loaded.run.projectId !== params.project.id || ![params.from, params.to].includes(loaded.document.environmentName)) {
      return { status: 'blocked', message: 'The saved migration plan belongs to another project or environment.' };
    }
    sourcePlanApproval = loaded.document.environmentName === params.from;
    if (sourcePlanApproval && !params.cutover) return { status: 'blocked', message: 'A source-environment plan can be confirmed only during the reviewed cutover.' };
  }
  let spec = specResult.spec;
  if (cloudEngineFor(spec, params.to)?.migration === 'settings') {
    if (pendingTransfer) return { status: 'blocked', message: 'The previous Google Cloud transfer must finish cleanup before changing destinations.' };
    return migrateSettingsOnly(ctx, { ...params, spec, sourceSpec, sourceEnvironment });
  }
  const launchParams = {
    project: params.project, spec, specRevision: specResult.revision, environmentName: params.to,
    ...(params.billingAccountName ? { billingAccountName: params.billingAccountName } : {}),
    ...(params.gcpSetupPlanId ? { gcpSetupPlanId: params.gcpSetupPlanId } : {}),
    ...(params.browserAccess && { browserAccess: params.browserAccess }),
    ...(params.approveAccess ? { approveAccess: params.approveAccess } : {}),
    ...(!sourcePlanApproval && params.planId ? { planId: params.planId } : {}),
    ...(!sourcePlanApproval && params.confirmActions ? { confirmActions: params.confirmActions } : {}),
    ...(params.sourceDirectory ? { sourceDirectory: params.sourceDirectory } : {}),
  };

  // 2. Connect the target cloud and grant access (stop points pass through).
  const prepared = await launchEnvironment(ctx, { ...launchParams, stopAfter: 'prepare' });
  if (prepared.status !== 'ready') return prepared;
  const context = await resolveEngineContext(ctx, params.project, spec, params.to);
  if ('blocked' in context) return { status: 'blocked', message: context.blocked };
  const environmentLabel = context.environment.id.toLowerCase();

  const targetSpec = spec.environments[params.to]!;
  if (sourceSpec.database && targetSpec.database?.provider !== 'cloudsql') {
    return { status: 'blocked', message: 'The source database needs a matching Cloud SQL database in the target environment.' };
  }
  const selected = selectMigrationBuckets(sourceSpec, targetSpec, sourceEnvironment, context.gcpProjectId, params.to);
  if (!selected.buckets) return { status: 'blocked', message: selected.blocked };
  const buckets = selected.buckets;

  // 3. Review runtime-secret names. Containers are prepared through the engine before values move.
  let pendingSecretValues: Record<string, string> | undefined;
  if (pendingTransfer) {
    const scope = { gcpProjectId: context.gcpProjectId, region: context.region,
      token: () => context.adapter.engineAccessToken() };
    const retry = params.copyData && params.refreshData && !params.verifyOnly && !params.cutover;
    const cleared = await verifyTransferResourcesAbsent(scope, pendingTransfer)
      || (retry && await recoverTerminalTransferResources(scope, pendingTransfer));
    if (!cleared) {
      return { status: 'blocked', message: `Cleanup of the previous transfer into ${params.to} is unverified for job ${pendingTransfer.jobId}. A reviewed refresh can finish cleanup once its recorded execution is terminal. No replacement copy was started.` };
    }
    lease.record(null);
  }
  const environment = () => ctx.repos.environments.findById(context.environment.id) ?? context.environment;
  const recorded = (environment().platformBindings as { engine?: EngineBinding }).engine;
  if (recorded?.importedSecrets?.some((key) => scopedToEnvironment(key, params.from))) {
    ctx.repos.environments.updatePlatformBindings(context.environment.id, {
      engine: { ...recorded, importedSecrets: recorded.importedSecrets.filter((key) => !scopedToEnvironment(key, params.from)) },
    });
  }
  if (!(environment().platformBindings as { engine?: EngineBinding }).engine?.importedSecrets) {
    const settings = await sourceSettings(ctx, { project: params.project, from: params.from, to: params.to, spec, sourceSpec, sourceEnvironment });
    if ('blocked' in settings) return { status: 'blocked', message: settings.blocked };
    const { values, keys, leftOut, notCopied } = settings;
    if (!params.importSecrets) {
      return {
        status: 'needs_secret_import', keys, ...(leftOut.length ? { leftOut } : {}),
        message: `Hypervibe will copy ${keys.length} runtime setting(s) from ${params.from} into Google Secret Manager for ${params.to}. Values are copied directly and never shown.`
          + (leftOut.length ? ` ${leftOut.join(', ')} ${leftOut.length === 1 ? 'is' : 'are'} named for ${params.from} and stay${leftOut.length === 1 ? 's' : ''} there.` : '') + notCopiedNote(notCopied),
      };
    }
    pendingSecretValues = Object.fromEntries(keys.map((key) => [key, values[key]!]));
    const engine = (environment().platformBindings as { engine?: EngineBinding }).engine ?? {};
    ctx.repos.environments.updatePlatformBindings(context.environment.id, { engine: { ...engine, kind: 'opentofu', pendingImportedSecrets: keys } });
  }

  const migration = () => {
    const recorded = (environment().platformBindings as { engine?: EngineBinding }).engine?.migration;
    return recorded?.from === params.from ? recorded : undefined;
  };
  const recordMigration = (update: Partial<NonNullable<EngineBinding['migration']>>) => {
    const engine = (environment().platformBindings as { engine?: EngineBinding }).engine ?? {};
    ctx.repos.environments.updatePlatformBindings(context.environment.id, { engine: { ...engine, migration: { ...migration(), from: params.from, ...update } } });
  };
  const persistCopy = (expected: Environment, next: NonNullable<EngineBinding['migration']>) => {
    const engine = (expected.platformBindings as { engine?: EngineBinding }).engine ?? {};
    if (!ctx.repos.environments.replacePlatformBindingsIfUnchanged(expected,
      { ...expected.platformBindings, engine: { ...engine, migration: next } })) return false;
    ctx.repos.environments.syncRepoBindingsForId(expected.id);
    return true;
  };
  const deployedBuckets = () => (environment().platformBindings as { engine?: EngineBinding }).engine?.storage;
  const selectionProblem = () => {
    const latest = store.get(params.project)?.spec.environments;
    const sourceNow = ctx.repos.environments.findById(sourceEnvironment.id);
    const currentSource = latest?.[params.from];
    const currentTarget = latest?.[params.to];
    if (!sourceNow || !currentSource || !currentTarget || currentSource.database?.provider !== sourceSpec.database?.provider
      || (currentSource.database && currentTarget.database?.provider !== 'cloudsql')) return 'The migration environments or database selection changed. Review the migration again.';
    const selectedNow = selectMigrationBuckets(currentSource, currentTarget, sourceNow, context.gcpProjectId, params.to);
    if (!selectedNow.buckets) return selectedNow.blocked;
    const current = selectedNow.buckets;
    if (current.length !== buckets.length || !buckets.every(bucket => current.some(other => other.name === bucket.name && other.identity === bucket.identity))) {
      return 'The selected file buckets changed during migration. Review the migration again.';
    }
    return missingDeployedBucket(current, deployedBuckets());
  };
  const evidenceMatchesSelection = (evidence: MigrationCopyEvidence) => !selectionProblem()
    && (!sourceSpec.database || evidence.database?.match === true) && hasVerifiedBuckets(evidence, buckets);
  const sameAttempt = (copy: NonNullable<EngineBinding['migration']>, current = migration()) => Boolean(
    copy.copiedAt && current?.copiedAt === copy.copiedAt && current.copyAttempt?.id === copy.copyAttempt?.id
    && (!current.copyAttempt || current.copyAttempt.status === 'complete'));
  const copyIsCurrent = (copy: NonNullable<EngineBinding['migration']>) => {
    const current = migration();
    return !!current && sameAttempt(copy, current) && evidenceMatchesSelection(current);
  };
  const supersededResult = { status: 'blocked' as const, message: 'Another copy attempt changed this migration. This attempt cannot authorize release; review the latest copy state before retrying.' };
  const incomplete = migration()?.copyAttempt && migration()?.copyAttempt?.status !== 'complete';
  if (incomplete && (params.cutover || params.verifyOnly || !params.copyData || !params.refreshData)) {
    if (sourceSpec.domainTarget?.environment === params.to) return { status: 'blocked', message: `The current copy is incomplete and traffic may reach ${params.to}. ${targetWriteRecovery}` };
    return { status: 'blocked', message: `The latest copy into ${params.to} did not complete. Earlier copy evidence is historical and cannot authorize release or cutover. Run hv_migrate with copyData=true and refreshData=true to replace the target data with a fresh verified copy. If a cutover paused ${params.from}, it remains paused.` };
  }
  const completedCopy = Boolean(migration()?.copiedAt) && !incomplete;
  const reuseCopy = completedCopy && !params.refreshData;

  if (completedCopy && !params.verifyOnly && (params.cutover || reuseCopy) && !evidenceMatchesSelection(migration()!)) {
    if (sourceSpec.domainTarget?.environment === params.to) return { status: 'blocked', message: `Current transfer evidence for the routed target is incomplete. ${targetWriteRecovery}` };
    return { status: 'blocked', message: 'The saved copy does not prove that every requested database and file bucket matched. Run hv_migrate with copyData=true and refreshData=true to make a verified copy before releasing or moving traffic.' };
  }

  // A Railway export needs its signed download URL, other databases need their
  // source URL, and bucket transfers need source access keys inside the target job.
  const copyHandoff = transferCredentialHandoffProblem(!!sourceSpec.database || buckets.length > 0);
  if (params.cutover) {
    if (!completedCopy) return { status: 'blocked', message: `Migrate ${params.from} to ${params.to} and check the app there before the cutover.` };
    return cutoverEnvironment(ctx, params, lease, copyHandoff);
  }

  if (params.verifyOnly) {
    if (!completedCopy) return { status: 'blocked', message: `Nothing has been copied from ${params.from} to ${params.to} yet; run hv_migrate first.` };
    const copy = migration()!;
    const missing = selectionProblem();
    if (missing) return { status: 'blocked', message: missing };
    if (copyHandoff) return { status: 'blocked', message: copyHandoff };
    const prepared = await prepareMigrationBuckets(params.project, sourceEnvironment, buckets);
    if (!prepared.prepared) return { status: 'blocked', message: prepared.blocked };
    const result = await verifyMigratedCopy({ lease, buckets: prepared.prepared, project: params.project, from: params.from, to: params.to, sourceSpec, sourceEnvironment, spec, context, environmentLabel,
      instance: (environment().platformBindings as { engine?: EngineBinding }).engine?.database?.instanceName, copiedAt: copy.copiedAt });
    if (!sameAttempt(copy)) return supersededResult;
    const change = selectionProblem();
    return change ? { status: 'blocked', message: change } : result;
  }

  // 3b. The target database runs at least the source's PostgreSQL major version.
  if (sourceSpec.database && spec.environments[params.to]!.database) {
    // An earlier observation can size an independently prepared target while data
    // transfer is unavailable. It cannot establish the source version for a new copy.
    const known = reuseCopy || (sourceSpec.database.provider === 'railway' && copyHandoff) ? migration()?.sourceMajor : undefined;
    const hasKnownMajor = typeof known === 'number' && Number.isSafeInteger(known) && known > 0;
    if (!hasKnownMajor && sourceSpec.database.provider === 'railway') {
      return { status: 'blocked', message: `Checking the private Railway PostgreSQL version requires a reviewed task that Hypervibe does not yet plan. Use hv_launch for ${params.to} to prepare and test the empty target with its configured database version.` };
    }
    const sourceMajor = hasKnownMajor ? { major: known } : await sourceDatabaseMajor(params.project, sourceEnvironment);
    if ('blocked' in sourceMajor) return { status: 'blocked', message: sourceMajor.blocked };
    recordMigration({ sourceMajor: sourceMajor.major });
    const targetMajor = spec.environments[params.to]!.database!.version ?? 16;
    if (sourceMajor.major > targetMajor) {
      if (sourceMajor.major > 18) return { status: 'blocked', message: `The source runs PostgreSQL ${sourceMajor.major}, which Cloud SQL does not offer yet.` };
      specResult = store.merge(params.project, { environments: { [params.to]: { database: { version: sourceMajor.major } } } });
      spec = specResult.spec;
      Object.assign(launchParams, { spec: specResult.spec, specRevision: specResult.revision });
    }
  }

  // 4. Infrastructure for the target, without releasing code yet.
  const built = await launchEnvironment(ctx, { ...launchParams, stopAfter: 'infrastructure' });
  if (built.status !== 'ready') return built;
  const preparedConflict = bindingConflict();
  if (preparedConflict) return { status: 'blocked', message: preparedConflict };
  // This phase consumed its exact artifact approval; later rounds need their own review.
  delete launchParams.planId;
  delete launchParams.confirmActions;

  // Containers now exist under an approved saved engine plan. Values stay outside engine state.
  if (pendingSecretValues) {
    const token = await context.adapter.engineAccessToken();
    for (const [key, value] of Object.entries(pendingSecretValues)) {
      const failure = await writeSecretVersion(token, context.gcpProjectId, engineSecretId(params.to, key),
        { 'managed-by': 'hypervibe', 'hv-environment': environmentLabel, 'hv-imported': 'true' }, value);
      if (failure) return { status: 'blocked', message: failure.message };
    }
    const engine = (environment().platformBindings as { engine?: EngineBinding }).engine ?? {};
    ctx.repos.environments.updatePlatformBindings(context.environment.id, { engine: { ...engine, importedSecrets: Object.keys(pendingSecretValues), pendingImportedSecrets: [] } });
    const wired = await launchEnvironment(ctx, { ...launchParams, stopAfter: 'infrastructure' });
    if (wired.status !== 'ready') return wired;
  }


  // 5. Copy the data inside the target cloud, after the user approves replacing target data.
  const missing = selectionProblem();
  if (missing) return { status: 'blocked', message: missing };
  const storageNames = buckets.map(({ name }) => name);
  // Railway databases are private: export from inside Railway rather than opening a public port.
  const privateRailwaySource = sourceSpec.database?.provider === 'railway';
  if (reuseCopy) {
    const copy = migration()!;
    if (!copyIsCurrent(copy)) return supersededResult;
    const released = await launchEnvironment(ctx, launchParams);
    if (!copyIsCurrent(copy)) return supersededResult;
    if (released.status !== 'live') return released;
    return {
      status: 'migrated', target: params.to, urls: released.urls,
      secretsImported: ((environment().platformBindings as { engine?: EngineBinding }).engine?.importedSecrets ?? []).length,
      ...(copy.database ? { database: copy.database } : {}), storage: bucketSummaries(copy.storage ?? []), dataCopiedAt: copy.copiedAt,
      next: `${params.from} is unchanged and still serving. Check the app at ${Object.values(released.urls)[0] ?? 'its URL'}. The data was copied at ${copy.copiedAt}; run hv_migrate again with refreshData=true to copy it again before the final cutover.`,
    };
  }
  if (copyHandoff) return { status: 'blocked', message: copyHandoff };
  const sourceAccess = sourceSpec.database && !privateRailwaySource ? await acquireManagedDatabaseAccess(params.project, sourceEnvironment) : undefined;
  if (sourceAccess && !sourceAccess.ok) return { status: 'blocked', message: `Could not open the source database: ${sourceAccess.error}` };
  try {
    const summary = sourceAccess ? await summarizeDatabaseAccess(sourceAccess.lease) : undefined;
    if (params.copyData && sourceAccess?.lease.mode === 'data_api') return { status: 'blocked', message: 'Aurora Data API supports source inspection, but this migration requires a managed PostgreSQL private connector for data transfer. Hypervibe does not yet provide that connector.' };
    if (!params.copyData) {
      const what = summary ? `the ${params.from} database (${summary.tables} tables, about ${summary.rows} rows)`
        : privateRailwaySource ? `the whole ${params.from} database (exported privately inside Railway by a temporary task that is deleted afterwards)` : 'no database';
      return {
        status: 'needs_copy_approval',
        ...(summary ? { database: { tables: summary.tables, rows: summary.rows, version: summary.version } } : {}),
        storage: storageNames,
        message: `Hypervibe will copy ${what}${storageNames.length ? ` and every file in ${storageNames.join(', ')}` : ''} into ${params.to}, replacing anything there now. ${params.from}'s app, data and settings are not changed.`,
      };
    }
    const transfer: TransferContext = {
      recordTransferResources: lease.record,
      token: () => context.adapter.engineAccessToken(), gcpProjectId: context.gcpProjectId, region: context.region,
      runtimeServiceAccountEmail: context.runtimeServiceAccountEmail, environmentLabel,
    };
    const prepared = await prepareMigrationBuckets(params.project, sourceEnvironment, buckets);
    if (!prepared.prepared) return { status: 'blocked', message: prepared.blocked };
    const change = selectionProblem();
    if (change) return { status: 'blocked', message: change };
    const expected = environment();
    const prior = migration();
    const previousCopy = prior?.copiedAt
      ? { copiedAt: prior.copiedAt, ...(prior.database ? { database: prior.database } : {}), ...(prior.storage ? { storage: prior.storage } : {}) }
      : prior?.previousCopy;
    const copyAttempt = { id: randomUUID(), startedAt: new Date().toISOString(), status: 'incomplete' as const };
    if (!persistCopy(expected, { ...prior, from: params.from, copyAttempt,
      copiedAt: undefined, finalCopy: undefined, database: undefined, storage: undefined, ...(previousCopy ? { previousCopy } : {}) })) {
      return { status: 'blocked', message: 'Migration state changed before copying started. Review the latest migration state before retrying.' };
    }
    const superseded = () => migration()?.copyAttempt?.id !== copyAttempt.id || migration()?.copyAttempt?.status !== 'incomplete' || !!selectionProblem();
    let database: Extract<MigrateResult, { status: 'migrated' }>['database'];
    if (privateRailwaySource) {
      const copied = await copyPrivateRailwayDatabase(ctx, { project: params.project, sourceEnvironment, to: params.to, context, transfer, instance: (environment().platformBindings as { engine?: EngineBinding }).engine?.database?.instanceName });
      if ('blocked' in copied) return { status: 'blocked', message: copied.blocked, ...(copied.details ? { details: copied.details } : {}) };
      database = copied;
    } else if (sourceAccess && summary) {
      const major = Math.max(16, Math.floor(Number(summary.version) / 10000));
      const instance = (environment().platformBindings as { engine?: EngineBinding }).engine?.database?.instanceName;
      const secret = await observeSecret(await transfer.token(), context.gcpProjectId, engineSecretId(params.to, ENGINE_DATABASE_URL_KEY));
      if (!instance || secret.state !== 'present' || !secret.value.latestVersion) return { status: 'blocked', message: 'The target database is not ready yet. Run hv_migrate again.' };
      const result = await sourceAccess.lease.withConnection((sourceUrl) => runTransferJob<DatabaseTransferResult>(transfer, {
        purpose: 'database', image: `postgres:${major}-alpine`, script: databaseTransferScript(), env: {},
        sourceSecrets: { SOURCE_DATABASE_URL: sourceUrl },
        secretRefs: { DATABASE_URL: { secretId: engineSecretId(params.to, ENGINE_DATABASE_URL_KEY), version: secret.value.latestVersion! } },
        cloudSqlConnectionName: `${context.gcpProjectId}:${context.region}:${instance}`, timeoutSeconds: 3600,
      }));
      if (!result.ok) return { status: 'blocked', message: result.error ?? 'The database copy failed.' };
      const compared = manifestsMatch(result.source, result.target);
      database = { tables: Object.keys(result.source?.tables ?? {}).length, rows: result.source?.totalRows ?? '0', match: compared.match, differences: compared.differences, restoreWarnings: result.restoreWarnings ?? 0 };
      if (!compared.match) return { status: 'blocked', message: `The copied database does not match the source: ${compared.differences.slice(0, 5).join('; ')}`, details: database };
    }
    const storage: NonNullable<MigrationCopyEvidence['storage']> = [];
    for (const bucket of prepared.prepared) {
      if (superseded()) return supersededResult;
      const result = await runTransferJob<StorageTransferResult>(transfer, {
        purpose: 'storage', image: 'rclone/rclone:1.68.2', script: storageTransferScript(),
        env: bucket.env, sourceSecrets: bucket.sourceSecrets, timeoutSeconds: 3600,
      });
      const checked = compareMigrationBucket(bucket.name, result);
      if (checked.blocked !== undefined) return { status: 'blocked', message: checked.blocked };
      if (!checked.match) return { status: 'blocked', message: `The copied files in ${bucket.name} do not match the source.`, details: checked };
      storage.push({ name: bucket.name, files: checked.files, bytes: checked.bytes, match: true, downloadVerifiedFor: bucket.identity });
    }

    const current = environment();
    const currentMigration = (current.platformBindings as { engine?: EngineBinding }).engine?.migration;
    if (currentMigration?.from !== params.from || currentMigration.copyAttempt?.id !== copyAttempt.id
      || currentMigration.copyAttempt.status !== 'incomplete') return supersededResult;
    const completed = { ...currentMigration, copyAttempt: { ...copyAttempt, status: 'complete' as const },
      copiedAt: new Date().toISOString(), ...(database ? { database } : {}), storage };
    if (!evidenceMatchesSelection(completed) || !persistCopy(current, completed) || !copyIsCurrent(completed)) return supersededResult;

    // 6. Release the app on the target and verify it.
    const released = await launchEnvironment(ctx, launchParams);
    if (!copyIsCurrent(completed)) return supersededResult;
    if (released.status !== 'live') return released;
    return {
      status: 'migrated', target: params.to, urls: released.urls,
      secretsImported: ((environment().platformBindings as { engine?: EngineBinding }).engine?.importedSecrets ?? []).length,
      ...(database ? { database } : {}), storage: bucketSummaries(storage),
      next: `${params.from} is unchanged and still serving. Check the app at ${Object.values(released.urls)[0] ?? 'its URL'}. Run hv_migrate again with refreshData=true to copy the data again before the final cutover.`,
    };
  } finally {
    if (sourceAccess?.ok) await sourceAccess.lease.release().catch(() => undefined);
  }
}

/**
 * Private-network database copy for Railway: a temporary task inside the
 * source environment dumps over Railway's private network and uploads one
 * object through a single-use signed URL; a Google Cloud job restores it next
 * to the target database. No public database port is opened and no Google
 * credential enters Railway.
 */
async function copyPrivateRailwayDatabase(ctx: CommandContext, params: {
  project: Project; sourceEnvironment: Environment; to: string;
  context: Awaited<ReturnType<typeof resolveEngineContext>> & { gcpProjectId: string };
  transfer: TransferContext; instance?: string;
}): Promise<NonNullable<Extract<MigrateResult, { status: 'migrated' }>['database']> | { blocked: string; details?: unknown }> {
  const { context, transfer } = params;
  if (!('adapter' in context)) return { blocked: 'The target environment is not ready.' };
  const component = ctx.repos.components.findByEnvironmentAndType(params.sourceEnvironment.id, 'postgres');
  const bindings = params.sourceEnvironment.platformBindings as { projectId?: string; environmentId?: string };
  if (!component?.externalId || !bindings.projectId || !bindings.environmentId) return { blocked: 'The source Railway database is not tracked by Hypervibe.' };
  const railway = await adapterFactory.getProviderAdapter('railway', params.project);
  if (!railway.success || !(railway.adapter instanceof RailwayAdapter)) return { blocked: 'Hypervibe needs its Railway connection to export the database.' };
  const databaseServiceName = await railway.adapter.serviceName(component.externalId);
  if (!databaseServiceName) return { blocked: 'The source Railway database service could not be found.' };
  const secret = await observeSecret(await transfer.token(), context.gcpProjectId, engineSecretId(params.to, ENGINE_DATABASE_URL_KEY));
  if (!params.instance || secret.state !== 'present' || !secret.value.latestVersion) return { blocked: 'The target database is not ready yet. Run hv_migrate again.' };

  const key = JSON.parse(context.adapter.engineConnection().credentials) as { client_email: string; private_key: string };
  const bucket = buildSourceBucketName(context.gcpProjectId);
  const object = `${railwayExportPrefix(params.to)}${Date.now()}.dump`;
  const sign = (method: 'PUT' | 'GET') => signedObjectUrl({ clientEmail: key.client_email, privateKey: key.private_key, bucket, object, method, expiresSeconds: 3600 });
  // The newest client reads every supported older server.
  const exported = await railway.adapter.runPrivateTask({
    projectId: bindings.projectId, environmentId: bindings.environmentId, image: 'postgres:18-alpine', command: databaseExportScript(),
    variables: { SOURCE_DATABASE_URL: `\${{${databaseServiceName}.DATABASE_URL}}`, UPLOAD_URL: sign('PUT') }, timeoutMs: 30 * 60 * 1000,
  });
  const cleanedUp = railway.adapter.lastPrivateTaskCleanup;
  const exportResult = parseTransferResult(exported.output) as { ok?: boolean; source?: DatabaseManifest; sourceIdentity?: unknown } | undefined;
  if (exported.exitCode !== 0 || !exportResult?.ok || !exportResult.source) {
    return { blocked: `The private export inside Railway did not complete (${exported.error ?? `exit ${exported.exitCode ?? 'unknown'}`}).${cleanedUp ? '' : ' Its temporary task may still exist in Railway; Hypervibe will report it in hv_status.'}` };
  }
  // The temporary task can read the source database. Nothing is restored while it may still exist.
  if (!cleanedUp) return { blocked: 'The private export finished, but its temporary task could not be removed from Railway, and that task can read the source database. Remove the temporary Hypervibe task service in Railway (hv_status lists it), then run the migration again. The target was not changed.' };
  const sourceIdentity = parsePostgresDatabaseIdentity(exportResult.sourceIdentity);
  if (!sourceIdentity) return { blocked: 'The private export did not verify the source database identity; the target was not changed.' };
  const restored = await runTransferJob<{ ok: boolean; error?: string; target?: DatabaseManifest; restoreWarnings?: number }>(transfer, {
    purpose: 'database', image: 'postgres:18-alpine', script: databaseRestoreScript(), env: { SOURCE_DATABASE_IDENTITY: sourceIdentity },
    sourceSecrets: { DUMP_URL: sign('GET') },
    secretRefs: { DATABASE_URL: { secretId: engineSecretId(params.to, ENGINE_DATABASE_URL_KEY), version: secret.value.latestVersion } },
    cloudSqlConnectionName: `${context.gcpProjectId}:${context.region}:${params.instance}`, timeoutSeconds: 3600,
  });
  if (!restored.ok) return { blocked: restored.error ?? 'Restoring the database in Google Cloud failed.' };
  const compared = manifestsMatch(exportResult.source, restored.target);
  const result = { tables: Object.keys(exportResult.source.tables).length, rows: exportResult.source.totalRows, match: compared.match,
    differences: compared.differences, restoreWarnings: restored.restoreWarnings ?? 0 };
  const errors = (restored as { restoreErrors?: string[] }).restoreErrors ?? [];
  if (!compared.match) return { blocked: `The copied database does not match the source: ${compared.differences.slice(0, 5).join('; ')}${errors.length ? `. Restore errors: ${errors.join(' | ')}` : ''}`, details: result };
  return result;
}

/** Plans and applies the source environment, accepting only pause and traffic changes. */
async function applySourceStage(ctx: CommandContext, project: Project, environmentName: string, confirmActions: string[] | undefined, stage: string, planId?: string): Promise<'done' | MigrateResult> {
  const registry = createCommandRegistry(ctx);
  type SourcePlan = { planId: string; blocked?: unknown[]; actions: Array<{ id: string; type: string; reason?: string; requiresConfirm?: boolean; billable?: boolean; dataBearing?: boolean; metadata?: { operation?: string } }> };
  let reviewed: SourcePlan | undefined;
  if (planId) {
    const loaded = new ConvergeExecutor().loadPlan(planId);
    if ('error' in loaded) return { status: 'blocked', message: loaded.error };
    if (loaded.document.environmentName === environmentName) {
      const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
      if (loaded.run.projectId !== project.id || !environment || loaded.run.environmentId !== environment.id
        || loaded.document.specRevision !== new SpecStore().get(project)?.revision) {
        return { status: 'blocked', message: 'The saved source plan no longer matches this project, environment and spec. Review a new cutover plan.' };
      }
      reviewed = { planId, actions: loaded.document.actions };
      if (confirmActions === undefined) confirmActions = browserApprovedRunActions(loaded.run, project.id);
    }
  }

  for (let round = 0; round < 4; round++) {
    const usingReviewedPlan = reviewed !== undefined;
    let plan = reviewed;
    reviewed = undefined;
    if (!plan) {
      const planned = await registry.get('hv_plan')!.execute({ project: project.id, env: environmentName });
      if (!planned.ok) return { status: 'blocked', message: `Planning the ${stage} of ${environmentName} failed: ${planned.error?.message ?? 'unknown error'}` };
      plan = planned.data as SourcePlan;
    }
    if (plan.blocked?.length) return { status: 'blocked', message: `The ${stage} of ${environmentName} is blocked: ${JSON.stringify(plan.blocked).slice(0, 500)}` };
    const changes = plan.actions.filter((action) => action.type !== 'noop');
    if (!changes.length) return 'done';
    // Command output omits action metadata; pause and traffic actions are identified by their maintenance ids.
    const unrelated = changes.filter((action) => !action.id.startsWith(`maintenance:${environmentName}:`)
      && !Object.values(MAINTENANCE_OPERATIONS).includes(String(action.metadata?.operation) as never));
    if (unrelated.length) {
      return { status: 'blocked', message: `${environmentName} has other pending changes (${unrelated.map((action) => action.id).join(', ')}). Apply or undo them first; the cutover changes only the pause and the traffic route.` };
    }
    const required = changes.filter((action) => action.requiresConfirm || action.billable || action.dataBearing).map((action) => action.id);
    const exactApproval = usingReviewedPlan && JSON.stringify([...(confirmActions ?? [])].sort()) === JSON.stringify([...required].sort());
    if (required.length && !exactApproval) {
      return { status: 'needs_confirmation', planId: plan.planId, confirmActions: required, changes: changes.map((action) => ({ id: action.id, change: action.reason ?? action.type })), estimatedMonthlyCost: [] };
    }
    const applied = await registry.get('hv_apply')!.execute({ project: project.id, planId: plan.planId, ...(required.length ? { confirmActions: required } : {}) });
    const result = applied.data as { applied?: boolean; error?: string } | undefined;
    if (!applied.ok || !result?.applied) return { status: 'blocked', message: `The ${stage} of ${environmentName} did not complete: ${applied.error?.message ?? result?.error ?? 'unknown result'}. Run hv_migrate with cutover=true again after checking hv_status.` };
  }
  return { status: 'pending', message: `The ${stage} of ${environmentName} is still settling. Run hv_migrate with cutover=true again.`, receipts: [] };
}

/**
 * The final move. The source shows its maintenance page and its workloads are
 * suspended, so nothing writes while the data is copied again and verified;
 * then its existing domain forwards to the target. The source's resources and
 * DNS stay in place. Recovery after target writes needs the newer data.
 */
async function cutoverEnvironment(ctx: CommandContext, params: MigrateParams, lease: MigrationTargetLease, copyHandoff?: string): Promise<MigrateResult> {
  const store = new SpecStore();
  const { spec, revision } = store.get(params.project)!;
  const source = spec.environments[params.from]!;
  const target = spec.environments[params.to]!;
  const web = source.domainTarget?.environment === params.to ? source.domainTarget.service : desiredDomainServiceName(target);
  const environment = (name: string) => ctx.repos.environments.findByProjectAndName(params.project.id, name)!;
  const readiness = await migrationCutoverReadiness(params.project, environment(params.from), source, params.to, target, web);
  if (store.get(params.project)?.revision !== revision) return { status: 'blocked', message: 'The cutover configuration changed during the source check. Review the current cutover again.' };
  const recovery = targetWriteRecovery;
  const { domain } = readiness;
  if (domain && readiness.alreadyForwarding && readiness.problems.length) {
    return { status: 'cut_over', domain, target: params.to, message: `${domain} already forwards to ${params.to}. ${readiness.problems.join(' ')} ${recovery}` };
  }
  if (readiness.problems.length || !domain || !web) return { status: 'blocked', message: readiness.problems.join(' ') };
  // Settings that name the target's own public URL move to the source domain, which visitors keep using.
  const sourceOrigin = `https://${domain}`;
  const targetOrigin = target.domain ? `https://${target.domain.trim()}` : undefined;
  const retarget = Object.fromEntries(Object.entries(target.envVars ?? {})
    .filter(([, value]) => targetOrigin && value.replace(/\/$/, '') === targetOrigin).map(([key]) => [key, sourceOrigin]));
  const routed = source.domainTarget?.environment === params.to && source.maintenance?.page === 'off';
  const observeTrafficMove = async (): Promise<MigrateResult> => {
    const latest = store.get(params.project)!.spec;
    const observed = await migrationCutoverReadiness(params.project, environment(params.from), latest.environments[params.from]!,
      params.to, latest.environments[params.to]!, web);
    if (!observed.alreadyForwarding || observed.domain !== domain) return { status: 'pending', receipts: [],
      message: `Forwarding ${domain} to ${params.to} has not been verified. Keep the source paused and check the current route before another move. ${observed.problems.join(' ')}`.trim() };
    return { status: 'cut_over', domain, target: params.to, message: [`${domain} now forwards to ${params.to}.`, ...observed.problems, recovery].join(' ') };
  };
  if (routed) {
    const destination = environment(params.to);
    const migration = (destination.platformBindings.engine as EngineBinding | undefined)?.migration;
    const expected = finalCopyReceipt(environment(params.from), destination, domain, web, readiness.pauseFingerprint);
    if (!readiness.alreadyForwarding && (!expected || !isDeepStrictEqual(expected, migration?.finalCopy))) {
      return { status: 'blocked', message: `Traffic to ${params.to} needs a verified final copy made during the current source pause. Keep the source paused. Reconcile any writes accepted on the target before reviewing a new final copy under the maintenance page.` };
    }
    const done = await applySourceStage(ctx, params.project, params.from, params.confirmActions, 'traffic move', params.planId);
    if (done !== 'done') return done;
    return observeTrafficMove();
  }
  if (copyHandoff) return { status: 'blocked', message: copyHandoff };
  if (!params.confirmCutover) {
    return {
      status: 'needs_cutover_approval', domain,
      steps: [
        `Pause ${params.from}: ${domain} shows a maintenance page (HTTP 503) and its web and worker services are suspended. Let running jobs and uploads finish first.`,
        `Copy the ${params.from} database and files to ${params.to} again, replacing the earlier copy, and verify every table and file.`,
        ...(Object.keys(retarget).length ? [`Set ${Object.keys(retarget).join(', ')} on ${params.to} to ${sourceOrigin}, so links and logins use ${domain}.`] : []),
        `Send ${domain} to ${params.to} (${web}). ${params.from} stays paused with its data. ${recovery}`,
      ],
      message: `${domain} is unavailable from the pause until the traffic move, including time for the final copy, verification, and any outstanding approvals.`,
    };
  }
  // 1. Pause the source so nothing writes during the final copy.
  if (!(source.maintenance?.enabled && source.maintenance.mode === 'application')) {
    store.merge(params.project, { environments: { [params.from]: { maintenance: { enabled: true, mode: 'application', page: 'active' } } } });
  }
  const paused = await applySourceStage(ctx, params.project, params.from, params.confirmActions, 'pause', params.planId);
  if (paused !== 'done') return paused;
  const pausedSpec = store.get(params.project)!.spec;
  const pausedReadiness = await migrationCutoverReadiness(params.project, environment(params.from), pausedSpec.environments[params.from]!,
    params.to, pausedSpec.environments[params.to]!, web);
  if (pausedReadiness.problems.length || !pausedReadiness.pauseFingerprint) return {
    status: 'blocked', message: [`The final copy requires a verified pause for ${domain} and every source workload.`, ...pausedReadiness.problems].join(' '),
  };
  const previousAttempt = (environment(params.to).platformBindings.engine as EngineBinding)?.migration?.copyAttempt?.id;
  // 2. Point the target at the source domain (released with the copy), copy again and prove it matches.
  if (Object.keys(retarget).length) store.merge(params.project, { environments: { [params.to]: { envVars: retarget } } });
  const prior = params.planId ? new ConvergeExecutor().loadPlan(params.planId) : undefined;
  const sourceApprovalConsumed = prior && !('error' in prior) && prior.document.environmentName === params.from;
  const copied = await runMigration(ctx, { ...params, ...(sourceApprovalConsumed ? { planId: undefined, confirmActions: undefined } : {}), cutover: false, confirmCutover: false, copyData: true, refreshData: true }, lease);
  if (copied.status !== 'migrated') return copied;
  // The copy is proven by its own check: the paused source's checksums against the restored
  // target, taken before the target app can write. A later comparison would race the live target.
  if (copied.database && !copied.database.match) {
    return { status: 'blocked', message: `The final copy does not match the paused source (${copied.database.differences.slice(0, 3).join('; ')}), so ${domain} keeps showing the maintenance page.` };
  }
  // A long final copy may span a source or target policy change.
  const current = store.get(params.project)!;
  const currentSource = current.spec.environments[params.from];
  const currentTarget = current.spec.environments[params.to];
  if (!currentSource || !currentTarget || currentSource.domain !== source.domain
    || desiredDomainServiceName(currentTarget) !== web) return { status: 'blocked', message: 'The cutover domain or target service changed during the copy. Review the current cutover again.' };
  const finalReadiness = await migrationCutoverReadiness(params.project, environment(params.from), currentSource, params.to, currentTarget, web);
  if (finalReadiness.problems.length) return { status: 'blocked', message: finalReadiness.problems.join(' ') };
  if (store.get(params.project)?.revision !== current.revision) return { status: 'blocked', message: 'The cutover configuration changed before traffic moved. Review the current cutover again.' };
  const destination = environment(params.to);
  const engine = destination.platformBindings.engine as EngineBinding;
  const receipt = finalCopyReceipt(environment(params.from), destination, domain, web, finalReadiness.pauseFingerprint);
  if (!receipt || receipt.copyAttemptId === previousAttempt || receipt.pauseFingerprint !== pausedReadiness.pauseFingerprint || !engine.migration
    || !ctx.repos.environments.replacePlatformBindingsIfUnchanged(destination, {
      ...destination.platformBindings, engine: { ...engine, migration: { ...engine.migration, finalCopy: receipt } },
    })) return { status: 'blocked', message: 'The final copy or source pause changed before traffic moved. Keep the source paused and verify the current copy.' };
  ctx.repos.environments.syncRepoBindingsForId(destination.id);
  // 3. Send the domain to the target.
  store.merge(params.project, { environments: { [params.from]: { domainTarget: { environment: params.to, service: web }, maintenance: { enabled: true, mode: 'application', page: 'off' } } } });
  const moved = await applySourceStage(ctx, params.project, params.from, undefined, 'traffic move');
  if (moved !== 'done') return moved;
  const observed = await observeTrafficMove();
  return observed.status === 'cut_over' && copied.database ? { ...observed, database: copied.database } : observed;
}

/**
 * Read-only comparison of a migrated copy with its source. Nothing is copied
 * or changed: each side reports per-table row counts and content checksums
 * from where its data lives, and file stores are compared object by object.
 * A target app that has been used since the copy differs by design.
 */
async function verifyMigratedCopy(params: {
  lease: MigrationTargetLease;
  project: Project; from: string; to: string; sourceSpec: EnvironmentSpec; sourceEnvironment: Environment; spec: ProjectSpec;
  buckets: NonNullable<Awaited<ReturnType<typeof prepareMigrationBuckets>>['prepared']>;
  context: Awaited<ReturnType<typeof resolveEngineContext>> & { gcpProjectId: string }; environmentLabel: string; instance?: string; copiedAt?: string;
}): Promise<MigrateResult> {
  const { context } = params;
  if (!('adapter' in context)) return { status: 'blocked', message: 'The target environment is not ready.' };
  const transfer: TransferContext = {
    recordTransferResources: params.lease.record,
    token: () => context.adapter.engineAccessToken(), gcpProjectId: context.gcpProjectId, region: context.region,
    runtimeServiceAccountEmail: context.runtimeServiceAccountEmail, environmentLabel: params.environmentLabel,
  };
  let database: Extract<MigrateResult, { status: 'verified' | 'differs' }>['database'];
  if (params.sourceSpec.database && params.spec.environments[params.to]!.database) {
    const secret = await observeSecret(await transfer.token(), context.gcpProjectId, engineSecretId(params.to, ENGINE_DATABASE_URL_KEY));
    if (!params.instance || secret.state !== 'present' || !secret.value.latestVersion) return { status: 'blocked', message: 'The target database is not ready.' };
    const access = await acquireManagedDatabaseAccess(params.project, params.sourceEnvironment);
    if (!access.ok) return { status: 'blocked', message: `Could not open the source database: ${access.error}` };
    let checked: DatabaseTransferResult;
    try {
      checked = await access.lease.withConnection((sourceUrl) => runTransferJob<DatabaseTransferResult>(transfer, {
        purpose: 'database', image: 'postgres:18-alpine', script: databaseManifestScript(), env: {}, sourceSecrets: { SOURCE_DATABASE_URL: sourceUrl },
        secretRefs: { DATABASE_URL: { secretId: engineSecretId(params.to, ENGINE_DATABASE_URL_KEY), version: secret.value.latestVersion! } },
        cloudSqlConnectionName: `${context.gcpProjectId}:${context.region}:${params.instance}`, timeoutSeconds: 1800,
      }));
    } finally {
      await access.lease.release().catch(() => undefined);
    }
    if (!checked.ok) return { status: 'blocked', message: checked.error ?? 'Comparing the databases failed.' };
    const { source, target } = checked;
    const compared = manifestsMatch(source, target);
    database = { tables: Object.keys(source?.tables ?? {}).length, rows: source?.totalRows ?? '0', match: compared.match, differences: compared.differences };
  }
  const storage: Extract<MigrateResult, { status: 'verified' | 'differs' }>['storage'] = [];
  for (const bucket of params.buckets) {
    const result = await runTransferJob<StorageTransferResult>(transfer, {
      purpose: 'storage', image: 'rclone/rclone:1.68.2', script: storageCheckScript(),
      env: bucket.env, sourceSecrets: bucket.sourceSecrets, timeoutSeconds: 1800,
    });
    const checked = compareMigrationBucket(bucket.name, result);
    if (checked.blocked !== undefined) return { status: 'blocked', message: checked.blocked };
    storage.push(checked);
  }
  const same = (database?.match ?? true) && storage.every((entry) => entry.match);
  return {
    status: same ? 'verified' : 'differs', target: params.to, ...(database ? { database } : {}), storage,
    ...(params.copiedAt ? { dataCopiedAt: params.copiedAt } : {}),
    message: same
      ? `${params.to} holds the same data as ${params.from}: every table has the same rows and content checksum, and every file matches.`
      : `${params.to} differs from ${params.from}. That is expected when either app has been used since the copy (${params.copiedAt ?? 'unknown time'}); run hv_migrate with refreshData=true to copy again.`,
  };
}

/** Inspect the PostgreSQL major through the source's managed database connection. */
async function sourceDatabaseMajor(project: Project, sourceEnvironment: Environment): Promise<{ major: number } | { blocked: string }> {
  const access = await acquireManagedDatabaseAccess(project, sourceEnvironment);
  if (!access.ok) return { blocked: `Could not open the source database: ${access.error}` };
  try {
    const summary = await summarizeDatabaseAccess(access.lease);
    return { major: Math.floor(Number(summary.version) / 10000) };
  } finally {
    await access.lease.release().catch(() => undefined);
  }
}

async function summarizeDatabaseAccess(lease: DatabaseAccessLease): Promise<{ tables: number; rows: string; version: string }> {
  if (!lease.query) return lease.withConnection(summarizeDatabase);
  const result = await lease.query("SELECT current_setting('server_version_num') AS version, count(*)::text AS tables, COALESCE(sum(n_live_tup), 0)::text AS rows FROM pg_stat_user_tables", [], { readOnly: true });
  const row = result.rows?.[0];
  if (!result.success || !row || !/^\d+$/.test(String(row.version)) || !/^\d+$/.test(String(row.tables)) || !/^\d+$/.test(String(row.rows))) throw new Error('The source database summary could not be verified.');
  return { tables: Number(row.tables), rows: String(row.rows), version: String(row.version) };
}

async function summarizeDatabase(url: string): Promise<{ tables: number; rows: string; version: string }> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30_000, ssl: /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const version = (await client.query<{ v: string }>('SHOW server_version_num')).rows[0]?.v ?? '0';
    const { rows } = await client.query<{ tables: string; rows: string }>(`SELECT count(*)::text AS tables, COALESCE(sum(n_live_tup), 0)::text AS rows FROM pg_stat_user_tables`);
    return { tables: Number(rows[0]?.tables ?? 0), rows: rows[0]?.rows ?? '0', version };
  } finally {
    await client.end().catch(() => undefined);
  }
}
