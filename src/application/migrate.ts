import pg from 'pg';
import type { CommandContext } from './context.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
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
import {
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
  | { status: 'needs_secret_import'; keys: string[]; message: string }
  | { status: 'needs_copy_approval'; database?: { tables: number; rows: string; version: string }; storage: string[]; message: string }
  | {
      status: 'migrated';
      target: string;
      urls: Record<string, string>;
      secretsImported: number;
      database?: { tables: number; rows: string; match: boolean; differences: string[]; restoreWarnings: number };
      storage: Array<{ name: string; files: number; bytes: number; match: boolean }>;
      next: string;
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
  const spec = specResult.spec;
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
    const keys = Object.keys(values).filter((key) => !declared.has(key) && !MANAGED_KEY.test(key) && !pointsAtSourceData(values[key]!)).sort();
    if (!params.importSecrets) {
      return {
        status: 'needs_secret_import', keys,
        message: `Hypervibe will copy ${keys.length} runtime setting(s) from ${params.from} into Google Secret Manager for ${params.to}. Values are copied directly and never shown.`,
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

  // 4. Infrastructure for the target, without releasing code yet.
  const built = await launchEnvironment(ctx, { ...launchParams, stopAfter: 'infrastructure' });
  if (built.status !== 'ready') return built;

  // 5. Copy the data inside the target cloud, after the user approves replacing target data.
  const targetSpec = spec.environments[params.to]!;
  const storageNames = Object.keys(targetSpec.storage ?? {}).filter((name) => parseStorageBindings(sourceEnvironment)[name]);
  const sourceAccess = sourceSpec.database ? await acquireManagedDatabaseAccess(params.project, sourceEnvironment) : undefined;
  if (sourceAccess && !sourceAccess.ok) return { status: 'blocked', message: `Could not open the source database: ${sourceAccess.error}` };
  try {
    const summary = sourceAccess ? await sourceAccess.lease.withConnection(summarizeDatabase) : undefined;
    if (!params.copyData) {
      return {
        status: 'needs_copy_approval',
        ...(summary ? { database: { tables: summary.tables, rows: summary.rows, version: summary.version } } : {}),
        storage: storageNames,
        message: `Hypervibe will copy ${summary ? `the ${params.from} database (${summary.tables} tables, ${summary.rows} rows)` : 'no database'}${storageNames.length ? ` and every file in ${storageNames.join(', ')}` : ''} into ${params.to}, replacing anything there now. ${params.from} is only read.`,
      };
    }
    const transfer: TransferContext = {
      token: () => context.adapter.engineAccessToken(), gcpProjectId: context.gcpProjectId, region: context.region,
      runtimeServiceAccountEmail: context.runtimeServiceAccountEmail, environmentLabel,
    };
    let database: Extract<MigrateResult, { status: 'migrated' }>['database'];
    if (sourceAccess && summary) {
      const major = Math.floor(Number(summary.version) / 10000);
      if (major > 16) return { status: 'blocked', message: `The source runs PostgreSQL ${major}; the target database runs 16. Hypervibe will not copy into an older major version.` };
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

    // 6. Release the app on the target and verify it.
    const released = await launchEnvironment(ctx, launchParams);
    if (released.status !== 'live') return released;
    return {
      status: 'migrated', target: params.to, urls: released.urls,
      secretsImported: ((environment().platformBindings as { engine?: EngineBinding }).engine?.importedSecrets ?? []).length,
      ...(database ? { database } : {}), storage,
      next: `${params.from} is unchanged and still serving. Check the app at ${Object.values(released.urls)[0] ?? 'its URL'}. Run hv_migrate again with copyData to refresh the copy before the final cutover.`,
    };
  } finally {
    if (sourceAccess?.ok) await sourceAccess.lease.release().catch(() => undefined);
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
