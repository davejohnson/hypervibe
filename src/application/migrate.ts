import { createCommandRegistry } from './commands.js';
import { MAINTENANCE_OPERATIONS } from '../domain/services/maintenance-plan.service.js';
import pg from 'pg';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { acquireManagedDatabaseAccess } from '../domain/services/database-access.service.js';
import { readHostingEnvVars } from '../domain/services/hosting-env.service.js';
import { parseStorageBindings } from '../domain/services/storage-plan.service.js';
import { launchEnvironment, type LaunchResult } from './launch.js';
import {
  ENGINE_DATABASE_URL_KEY,
  engineBucketName,
  engineSecretId,
  observeSecret,
  resolveEngineContext,
  writeSecretVersion,
  type EngineBinding,
} from './infrastructure-engine.js';
import { RailwayAdapter } from '../adapters/providers/railway/railway.adapter.js';
import { buildSourceBucketName } from '../domain/services/cloud-prepare.execute.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import {
  databaseExportScript,
  databaseManifestScript,
  storageCheckScript,
  databaseRestoreScript,
  parseTransferResult,
  signedObjectUrl,
  type DatabaseManifest,
  manifestsMatch,
  runTransferJob,
  s3SourceRemote,
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
      /** Same objects, compared by hash where both stores provide one, otherwise by size. */
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
export function proposeTargetEnvironment(source: EnvironmentSpec, options: { region?: string; domain?: string }): EnvironmentSpec {
  const envVars = { ...source.envVars };
  if (options.domain) {
    for (const [key, value] of Object.entries(envVars)) {
      // Keep URL settings consistent with the new hostname; anything else is copied as-is.
      if (/_URL$/.test(key) && source.domain && value.includes(source.domain)) envVars[key] = value.replaceAll(source.domain, options.domain);
    }
  }
  const target: Record<string, unknown> = {
    hosting: { provider: 'cloudrun', region: options.region ?? 'us-central1', engine: 'opentofu' },
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
    ...(source.migrations?.mode === 'releaseCommand' ? { migrations: source.migrations } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
  };
  return target as EnvironmentSpec;
}

export async function migrateEnvironment(ctx: CommandContext, params: {
  project: Project;
  from: string;
  to: string;
  region?: string;
  domain?: string;
  billingAccountName?: string;
  approveAccess?: string[];
  confirmActions?: string[];
  importSecrets?: boolean;
  copyData?: boolean;
  /** Copy the data again even though a verified copy exists (refresh before cutover). */
  refreshData?: boolean;
  /** Read-only: compare the source and target data (row counts and content checksums, file hashes) without copying. */
  verifyOnly?: boolean;
  /**
   * Final move: pause the source behind its maintenance page, copy the data
   * again and verify it, then send the source's domain to the target.
   * Requires confirmCutover after the user approves the listed steps.
   */
  cutover?: boolean;
  confirmCutover?: boolean;
  sourceDirectory?: string;
}): Promise<MigrateResult> {
  const store = new SpecStore();
  let specResult = store.get(params.project);
  if (!specResult) return { status: 'blocked', message: 'This project has no spec yet.' };
  const sourceSpec = specResult.spec.environments[params.from];
  if (!sourceSpec) return { status: 'blocked', message: `The spec has no source environment "${params.from}".` };
  const sourceEnvironment = ctx.repos.environments.findByProjectAndName(params.project.id, params.from);
  if (!sourceEnvironment) return { status: 'blocked', message: `Environment ${params.from} has never been deployed by Hypervibe.` };

  // 1. Target: proposed from the source when it does not exist yet.
  if (!specResult.spec.environments[params.to]) {
    const proposed = proposeTargetEnvironment(sourceSpec, { region: params.region, domain: params.domain });
    specResult = store.merge(params.project, { environments: { [params.to]: proposed } });
  }
  let spec = specResult.spec;
  const launchParams = {
    project: params.project, spec, specRevision: specResult.revision, environmentName: params.to,
    ...(params.billingAccountName ? { billingAccountName: params.billingAccountName } : {}),
    ...(params.approveAccess ? { approveAccess: params.approveAccess } : {}),
    ...(params.confirmActions ? { confirmActions: params.confirmActions } : {}),
    ...(params.sourceDirectory ? { sourceDirectory: params.sourceDirectory } : {}),
  };

  // 2. Connect the target cloud and grant access (stop points pass through).
  const prepared = await launchEnvironment(ctx, { ...launchParams, stopAfter: 'prepare' });
  if (prepared.status !== 'ready') return prepared;
  const context = await resolveEngineContext(ctx, params.project, spec, params.to);
  if ('blocked' in context) return { status: 'blocked', message: context.blocked };
  const environmentLabel = context.environment.id.toLowerCase();

  // 3. Runtime secrets, copied from the running source after the user sees their names.
  const environment = () => ctx.repos.environments.findById(context.environment.id) ?? context.environment;
  const recorded = (environment().platformBindings as { engine?: EngineBinding }).engine;
  if (recorded?.importedSecrets?.some((key) => scopedToEnvironment(key, params.from))) {
    ctx.repos.environments.updatePlatformBindings(context.environment.id, {
      engine: { ...recorded, importedSecrets: recorded.importedSecrets.filter((key) => !scopedToEnvironment(key, params.from)) },
    });
  }
  if (!(environment().platformBindings as { engine?: EngineBinding }).engine?.importedSecrets) {
    const values: Record<string, string> = {};
    for (const serviceName of Object.keys(sourceSpec.services)) {
      const service = ctx.repos.services.findByProjectAndName(params.project.id, serviceName);
      if (!service) continue;
      const read = await readHostingEnvVars({ project: params.project, environment: sourceEnvironment, service });
      if (!read.success) return { status: 'blocked', message: `Could not read ${serviceName}'s settings on ${read.provider}: ${read.error}` };
      for (const [key, value] of Object.entries(read.variables)) if (value) values[key] ??= value;
    }
    const declared = new Set([...Object.keys(spec.environments[params.to]!.envVars), ...Object.entries(spec.secrets)
      .filter(([, secret]) => secret.ownership === 'hypervibe' && secret.environments.includes(params.to)).map(([key]) => key)]);
    const candidates = Object.keys(values).filter((key) => !declared.has(key) && !MANAGED_KEY.test(key) && !pointsAtSourceData(values[key]!)).sort();
    const leftOut = candidates.filter((key) => scopedToEnvironment(key, params.from));
    const keys = candidates.filter((key) => !leftOut.includes(key));
    if (!params.importSecrets) {
      return {
        status: 'needs_secret_import', keys, ...(leftOut.length ? { leftOut } : {}),
        message: `Hypervibe will copy ${keys.length} runtime setting(s) from ${params.from} into Google Secret Manager for ${params.to}. Values are copied directly and never shown.`
          + (leftOut.length ? ` ${leftOut.join(', ')} ${leftOut.length === 1 ? 'is' : 'are'} named for ${params.from} and stay${leftOut.length === 1 ? 's' : ''} there.` : ''),
      };
    }
    const token = await context.adapter.engineAccessToken();
    for (const key of keys) {
      const failure = await writeSecretVersion(token, context.gcpProjectId, engineSecretId(params.to, key),
        { 'managed-by': 'hypervibe', 'hv-environment': environmentLabel, 'hv-imported': 'true' }, values[key]!);
      if (failure) return { status: 'blocked', message: failure.message };
    }
    const engine = (environment().platformBindings as { engine?: EngineBinding }).engine ?? {};
    ctx.repos.environments.updatePlatformBindings(context.environment.id, { engine: { ...engine, kind: 'opentofu', importedSecrets: keys } });
  }

  const migration = () => {
    const recorded = (environment().platformBindings as { engine?: EngineBinding }).engine?.migration;
    return recorded?.from === params.from ? recorded : undefined;
  };
  const recordMigration = (update: Partial<NonNullable<EngineBinding['migration']>>) => {
    const engine = (environment().platformBindings as { engine?: EngineBinding }).engine ?? {};
    ctx.repos.environments.updatePlatformBindings(context.environment.id, { engine: { ...engine, migration: { ...migration(), from: params.from, ...update } } });
  };
  const reuseCopy = Boolean(migration()?.copiedAt) && !params.refreshData;

  if (params.cutover) {
    if (!migration()?.copiedAt) return { status: 'blocked', message: `Migrate ${params.from} to ${params.to} and check the app there before the cutover.` };
    return cutoverEnvironment(ctx, params);
  }

  if (params.verifyOnly) {
    if (!migration()?.copiedAt) return { status: 'blocked', message: `Nothing has been copied from ${params.from} to ${params.to} yet; run hv_migrate first.` };
    return verifyMigratedCopy(ctx, { project: params.project, from: params.from, to: params.to, sourceSpec, sourceEnvironment, spec, context, environmentLabel,
      instance: (environment().platformBindings as { engine?: EngineBinding }).engine?.database?.instanceName, copiedAt: migration()!.copiedAt });
  }

  // 3b. The target database runs at least the source's PostgreSQL major version.
  if (sourceSpec.database && spec.environments[params.to]!.database) {
    const known = reuseCopy ? migration()?.sourceMajor : undefined;
    const sourceMajor = known ? { major: known } : await sourceDatabaseMajor(ctx, params.project, sourceEnvironment, sourceSpec);
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

  // 5. Copy the data inside the target cloud, after the user approves replacing target data.
  const targetSpec = spec.environments[params.to]!;
  const storageNames = Object.keys(targetSpec.storage ?? {}).filter((name) => parseStorageBindings(sourceEnvironment)[name]);
  // Railway databases are private: export from inside Railway rather than opening a public port.
  const privateRailwaySource = sourceSpec.database?.provider === 'railway';
  if (reuseCopy) {
    const copy = migration()!;
    const released = await launchEnvironment(ctx, launchParams);
    if (released.status !== 'live') return released;
    return {
      status: 'migrated', target: params.to, urls: released.urls,
      secretsImported: ((environment().platformBindings as { engine?: EngineBinding }).engine?.importedSecrets ?? []).length,
      ...(copy.database ? { database: copy.database } : {}), storage: copy.storage ?? [], dataCopiedAt: copy.copiedAt,
      next: `${params.from} is unchanged and still serving. Check the app at ${Object.values(released.urls)[0] ?? 'its URL'}. The data was copied at ${copy.copiedAt}; run hv_migrate again with refreshData=true to copy it again before the final cutover.`,
    };
  }
  const sourceAccess = sourceSpec.database && !privateRailwaySource ? await acquireManagedDatabaseAccess(params.project, sourceEnvironment) : undefined;
  if (sourceAccess && !sourceAccess.ok) return { status: 'blocked', message: `Could not open the source database: ${sourceAccess.error}` };
  try {
    const summary = sourceAccess ? await sourceAccess.lease.withConnection(summarizeDatabase) : undefined;
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
      token: () => context.adapter.engineAccessToken(), gcpProjectId: context.gcpProjectId, region: context.region,
      runtimeServiceAccountEmail: context.runtimeServiceAccountEmail, environmentLabel,
    };
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
    const storage: Extract<MigrateResult, { status: 'migrated' }>['storage'] = [];
    for (const name of storageNames) {
      const binding = parseStorageBindings(sourceEnvironment)[name]!;
      const adapter = await adapterFactory.getStorageAdapter(binding.provider, params.project);
      if (!adapter.success || !adapter.adapter?.getCredentials || !binding.instanceScope) {
        return { status: 'blocked', message: `Copying files out of ${binding.provider} storage is not supported yet.` };
      }
      const credentials = await adapter.adapter.getCredentials(sourceEnvironment, binding.instanceScope, binding.externalId);
      const remote = s3SourceRemote(credentials);
      const result = await runTransferJob<StorageTransferResult>(transfer, {
        purpose: 'storage', image: 'rclone/rclone:1.68.2', script: storageTransferScript(),
        env: { ...remote.env, SOURCE_BUCKET: credentials.bucket, TARGET_BUCKET: engineBucketName(context.gcpProjectId, params.to, name) },
        sourceSecrets: remote.secrets, timeoutSeconds: 3600,
      });
      if (!result.ok) return { status: 'blocked', message: result.error ?? `Copying ${name} failed.` };
      const match = (result.differences ?? 1) === 0 && result.source?.count === result.target?.count;
      storage.push({ name, files: result.source?.count ?? 0, bytes: result.source?.bytes ?? 0, match });
      if (!match) return { status: 'blocked', message: `The copied files in ${name} do not match the source (${result.differences} difference(s)).`, details: result };
    }

    recordMigration({ copiedAt: new Date().toISOString(), ...(database ? { database } : {}), storage });

    // 6. Release the app on the target and verify it.
    const released = await launchEnvironment(ctx, launchParams);
    if (released.status !== 'live') return released;
    return {
      status: 'migrated', target: params.to, urls: released.urls,
      secretsImported: ((environment().platformBindings as { engine?: EngineBinding }).engine?.importedSecrets ?? []).length,
      ...(database ? { database } : {}), storage,
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
  const object = `migrations/${params.to}/${Date.now()}.dump`;
  const sign = (method: 'PUT' | 'GET') => signedObjectUrl({ clientEmail: key.client_email, privateKey: key.private_key, bucket, object, method, expiresSeconds: 3600 });
  // The newest client reads every supported older server.
  const exported = await railway.adapter.runPrivateTask({
    projectId: bindings.projectId, environmentId: bindings.environmentId, image: 'postgres:18-alpine', command: databaseExportScript(),
    variables: { SOURCE_DATABASE_URL: `\${{${databaseServiceName}.DATABASE_URL}}`, UPLOAD_URL: sign('PUT') }, timeoutMs: 30 * 60 * 1000,
  });
  const cleanedUp = railway.adapter.lastPrivateTaskCleanup;
  const exportResult = parseTransferResult(exported.output) as { ok?: boolean; source?: DatabaseManifest } | undefined;
  if (exported.exitCode !== 0 || !exportResult?.ok || !exportResult.source) {
    return { blocked: `The private export inside Railway did not complete (${exported.error ?? `exit ${exported.exitCode ?? 'unknown'}`}).${cleanedUp ? '' : ' Its temporary task may still exist in Railway; Hypervibe will report it in hv_status.'}` };
  }
  const restored = await runTransferJob<{ ok: boolean; error?: string; target?: DatabaseManifest; restoreWarnings?: number }>(transfer, {
    purpose: 'database', image: 'postgres:18-alpine', script: databaseRestoreScript(), env: {},
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
async function applySourceStage(ctx: CommandContext, project: Project, environmentName: string, confirmActions: string[] | undefined, stage: string): Promise<'done' | MigrateResult> {
  const registry = createCommandRegistry(ctx);
  for (let round = 0; round < 4; round++) {
    const planned = await registry.get('hv_plan')!.execute({ project: project.id, env: environmentName });
    if (!planned.ok) return { status: 'blocked', message: `Planning the ${stage} of ${environmentName} failed: ${planned.error?.message ?? 'unknown error'}` };
    const plan = planned.data as { planId: string; blocked?: unknown[]; actions: Array<{ id: string; type: string; reason?: string; requiresConfirm?: boolean; billable?: boolean; dataBearing?: boolean; metadata?: { operation?: string } }> };
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
    const missing = required.filter((id) => !(confirmActions ?? []).includes(id));
    if (missing.length) {
      return { status: 'needs_confirmation', confirmActions: required, changes: changes.map((action) => ({ id: action.id, change: action.reason ?? action.type })), estimatedMonthlyCost: [] };
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
 * DNS stay in place, so pointing the domain back is one more reviewed change.
 */
async function cutoverEnvironment(ctx: CommandContext, params: Parameters<typeof migrateEnvironment>[1]): Promise<MigrateResult> {
  const store = new SpecStore();
  const spec = store.get(params.project)!.spec;
  const source = spec.environments[params.from]!;
  const target = spec.environments[params.to]!;
  const domain = source.domain?.trim();
  if (!domain) return { status: 'blocked', message: `${params.from} has no custom domain to move.` };
  const web = Object.entries(target.services).find(([, service]) => service.workloadKind === 'web' && service.public !== false)?.[0];
  if (!web) return { status: 'blocked', message: `${params.to} has no public web service to receive ${domain}.` };
  // Settings that name the target's own public URL move to the source domain, which visitors keep using.
  const sourceOrigin = `https://${domain}`;
  const targetOrigin = target.domain ? `https://${target.domain.trim()}` : undefined;
  const retarget = Object.fromEntries(Object.entries(target.envVars ?? {})
    .filter(([, value]) => targetOrigin && value.replace(/\/$/, '') === targetOrigin).map(([key]) => [key, sourceOrigin]));
  const routed = source.domainTarget?.environment === params.to && source.maintenance?.page === 'off';
  if (routed) {
    const done = await applySourceStage(ctx, params.project, params.from, params.confirmActions, 'traffic move');
    if (done !== 'done') return done;
    return { status: 'cut_over', domain, target: params.to, message: `${domain} now forwards to ${params.to}. ${params.from} stays paused with its data and DNS in place; to send visitors back, set its domainTarget away and maintenance.page to "active", then resume.` };
  }
  if (!params.confirmCutover) {
    return {
      status: 'needs_cutover_approval', domain,
      steps: [
        `Pause ${params.from}: ${domain} shows a maintenance page (HTTP 503) and its web and worker services are suspended. Let running jobs and uploads finish first.`,
        `Copy the ${params.from} database and files to ${params.to} again, replacing the earlier copy, and verify every table and file.`,
        ...(Object.keys(retarget).length ? [`Set ${Object.keys(retarget).join(', ')} on ${params.to} to ${sourceOrigin}, so links and logins use ${domain}.`] : []),
        `Send ${domain} to ${params.to} (${web}). ${params.from} stays paused with its data, so moving back is one more reviewed step.`,
      ],
      message: `${domain} is unavailable from the pause until the traffic move, usually a few minutes plus the copy time.`,
    };
  }
  // 1. Pause the source so nothing writes during the final copy.
  if (!(source.maintenance?.enabled && source.maintenance.mode === 'application')) {
    store.merge(params.project, { environments: { [params.from]: { maintenance: { enabled: true, mode: 'application', page: 'active' } } } });
  }
  const paused = await applySourceStage(ctx, params.project, params.from, params.confirmActions, 'pause');
  if (paused !== 'done') return paused;
  // 2. Point the target at the source domain (released with the copy), copy again and prove it matches.
  if (Object.keys(retarget).length) store.merge(params.project, { environments: { [params.to]: { envVars: retarget } } });
  const copied = await migrateEnvironment(ctx, { ...params, cutover: false, confirmCutover: false, copyData: true, refreshData: true });
  if (copied.status !== 'migrated') return copied;
  // The copy is proven by its own check: the paused source's checksums against the restored
  // target, taken before the target app can write. A later comparison would race the live target.
  if (copied.database && !copied.database.match) {
    return { status: 'blocked', message: `The final copy does not match the paused source (${copied.database.differences.slice(0, 3).join('; ')}), so ${domain} keeps showing the maintenance page.` };
  }
  // 3. Send the domain to the target.
  store.merge(params.project, { environments: { [params.from]: { domainTarget: { environment: params.to, service: web }, maintenance: { enabled: true, mode: 'application', page: 'off' } } } });
  const moved = await applySourceStage(ctx, params.project, params.from, params.confirmActions, 'traffic move');
  if (moved !== 'done') return moved;
  return {
    status: 'cut_over', domain, target: params.to, ...(copied.database ? { database: copied.database } : {}),
    message: `${domain} now forwards to ${params.to}; the final copy matched the paused source. ${params.from} stays paused with its data and DNS in place.`,
  };
}

/**
 * Read-only comparison of a migrated copy with its source. Nothing is copied
 * or changed: each side reports per-table row counts and content checksums
 * from where its data lives, and file stores are compared object by object.
 * A target app that has been used since the copy differs by design.
 */
async function verifyMigratedCopy(ctx: CommandContext, params: {
  project: Project; from: string; to: string; sourceSpec: EnvironmentSpec; sourceEnvironment: Environment; spec: ProjectSpec;
  context: Awaited<ReturnType<typeof resolveEngineContext>> & { gcpProjectId: string }; environmentLabel: string; instance?: string; copiedAt?: string;
}): Promise<MigrateResult> {
  const { context } = params;
  if (!('adapter' in context)) return { status: 'blocked', message: 'The target environment is not ready.' };
  const transfer: TransferContext = {
    token: () => context.adapter.engineAccessToken(), gcpProjectId: context.gcpProjectId, region: context.region,
    runtimeServiceAccountEmail: context.runtimeServiceAccountEmail, environmentLabel: params.environmentLabel,
  };
  let database: Extract<MigrateResult, { status: 'verified' | 'differs' }>['database'];
  if (params.sourceSpec.database && params.spec.environments[params.to]!.database) {
    const secret = await observeSecret(await transfer.token(), context.gcpProjectId, engineSecretId(params.to, ENGINE_DATABASE_URL_KEY));
    if (!params.instance || secret.state !== 'present' || !secret.value.latestVersion) return { status: 'blocked', message: 'The target database is not ready.' };
    const targetJob = (sourceSecrets: Record<string, string>) => runTransferJob<{ ok: boolean; error?: string; source?: DatabaseManifest; target?: DatabaseManifest }>(transfer, {
      purpose: 'database', image: 'postgres:18-alpine', script: databaseManifestScript(), env: {}, sourceSecrets,
      secretRefs: { DATABASE_URL: { secretId: engineSecretId(params.to, ENGINE_DATABASE_URL_KEY), version: secret.value.latestVersion! } },
      cloudSqlConnectionName: `${context.gcpProjectId}:${context.region}:${params.instance}`, timeoutSeconds: 1800,
    });
    let source: DatabaseManifest | undefined;
    let target: DatabaseManifest | undefined;
    if (params.sourceSpec.database.provider === 'railway') {
      const component = ctx.repos.components.findByEnvironmentAndType(params.sourceEnvironment.id, 'postgres');
      const bindings = params.sourceEnvironment.platformBindings as { projectId?: string; environmentId?: string };
      const railway = await adapterFactory.getProviderAdapter('railway', params.project);
      if (!component?.externalId || !bindings.projectId || !bindings.environmentId || !railway.success || !(railway.adapter instanceof RailwayAdapter)) {
        return { status: 'blocked', message: 'Hypervibe needs its Railway connection and the tracked source database to compare the data.' };
      }
      const databaseServiceName = await railway.adapter.serviceName(component.externalId);
      if (!databaseServiceName) return { status: 'blocked', message: 'The source Railway database service could not be found.' };
      const read = await railway.adapter.runPrivateTask({
        projectId: bindings.projectId, environmentId: bindings.environmentId, image: 'postgres:18-alpine', command: databaseManifestScript(),
        variables: { SOURCE_DATABASE_URL: `\${{${databaseServiceName}.DATABASE_URL}}` }, timeoutMs: 20 * 60 * 1000,
      });
      const parsed = parseTransferResult(read.output) as { ok?: boolean; source?: DatabaseManifest } | undefined;
      if (read.exitCode !== 0 || !parsed?.ok || !parsed.source) return { status: 'blocked', message: `Reading the source database inside Railway did not complete (${read.error ?? `exit ${read.exitCode ?? 'unknown'}`}).` };
      source = parsed.source;
      const checked = await targetJob({});
      if (!checked.ok) return { status: 'blocked', message: checked.error ?? 'Reading the target database failed.' };
      target = checked.target;
    } else {
      const access = await acquireManagedDatabaseAccess(params.project, params.sourceEnvironment);
      if (!access.ok) return { status: 'blocked', message: `Could not open the source database: ${access.error}` };
      try {
        const checked = await access.lease.withConnection((sourceUrl) => targetJob({ SOURCE_DATABASE_URL: sourceUrl }));
        if (!checked.ok) return { status: 'blocked', message: checked.error ?? 'Comparing the databases failed.' };
        source = checked.source;
        target = checked.target;
      } finally {
        await access.lease.release().catch(() => undefined);
      }
    }
    const compared = manifestsMatch(source, target);
    database = { tables: Object.keys(source?.tables ?? {}).length, rows: source?.totalRows ?? '0', match: compared.match, differences: compared.differences };
  }
  const storage: Extract<MigrateResult, { status: 'verified' | 'differs' }>['storage'] = [];
  for (const name of Object.keys(params.spec.environments[params.to]!.storage ?? {})) {
    const binding = parseStorageBindings(params.sourceEnvironment)[name];
    if (!binding) continue;
    const adapter = await adapterFactory.getStorageAdapter(binding.provider, params.project);
    if (!adapter.success || !adapter.adapter?.getCredentials || !binding.instanceScope) return { status: 'blocked', message: `Reading ${binding.provider} storage is not supported yet.` };
    const credentials = await adapter.adapter.getCredentials(params.sourceEnvironment, binding.instanceScope, binding.externalId);
    const remote = s3SourceRemote(credentials);
    const result = await runTransferJob<StorageTransferResult>(transfer, {
      purpose: 'storage', image: 'rclone/rclone:1.68.2', script: storageCheckScript(),
      env: { ...remote.env, SOURCE_BUCKET: credentials.bucket, TARGET_BUCKET: engineBucketName(context.gcpProjectId, params.to, name) },
      sourceSecrets: remote.secrets, timeoutSeconds: 1800,
    });
    if (!result.ok) return { status: 'blocked', message: result.error ?? `Comparing ${name} failed.` };
    const differences = result.differences ?? 1;
    storage.push({ name, files: result.source?.count ?? 0, bytes: result.source?.bytes ?? 0, match: differences === 0 && result.source?.count === result.target?.count, differences });
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

/** The source database's PostgreSQL major version, read privately when the source is Railway. */
async function sourceDatabaseMajor(ctx: CommandContext, project: Project, sourceEnvironment: Environment, sourceSpec: EnvironmentSpec): Promise<{ major: number } | { blocked: string }> {
  if (sourceSpec.database?.provider === 'railway') {
    const component = ctx.repos.components.findByEnvironmentAndType(sourceEnvironment.id, 'postgres');
    const bindings = sourceEnvironment.platformBindings as { projectId?: string; environmentId?: string };
    const railway = await adapterFactory.getProviderAdapter('railway', project);
    if (!component?.externalId || !bindings.projectId || !bindings.environmentId || !railway.success || !(railway.adapter instanceof RailwayAdapter)) {
      return { blocked: 'The source Railway database is not reachable through Hypervibe.' };
    }
    const name = await railway.adapter.serviceName(component.externalId);
    const runProbe = () => (railway.adapter as RailwayAdapter).runPrivateTask({
      projectId: bindings.projectId!, environmentId: bindings.environmentId!, image: 'postgres:18-alpine', timeoutMs: 6 * 60 * 1000,
      command: 'echo "HV_SERVER_VERSION $(psql "$SOURCE_DATABASE_URL" -At -c "SHOW server_version_num")"',
      variables: { SOURCE_DATABASE_URL: `\${{${name}.DATABASE_URL}}` },
    });
    // A read-only probe; one retry absorbs Railway's occasional late logs.
    let probe = await runProbe();
    if (probe.exitCode === undefined) probe = await runProbe();
    const version = probe.output.match(/HV_SERVER_VERSION (\d+)/)?.[1];
    if (probe.exitCode !== 0 || !version) return { blocked: `Could not read the source database version (${probe.error ?? 'no output'}).` };
    return { major: Math.floor(Number(version) / 10000) };
  }
  const access = await acquireManagedDatabaseAccess(project, sourceEnvironment);
  if (!access.ok) return { blocked: `Could not open the source database: ${access.error}` };
  try {
    const summary = await access.lease.withConnection(summarizeDatabase);
    return { major: Math.floor(Number(summary.version) / 10000) };
  } finally {
    await access.lease.release().catch(() => undefined);
  }
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
