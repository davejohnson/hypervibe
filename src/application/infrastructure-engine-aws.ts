import { commonEngineProblems, environmentProfile, type EnvironmentProfile } from '../domain/services/infrastructure-engine-selection.js';
import { specWithoutEnvironment, openTofuEngine, planEngineSecrets, recordEnginePlan } from './engine-shared.js';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { AwsEngineCredentialsSchema, type AwsEngineCredentials } from '../adapters/providers/aws/aws-engine.adapter.js';
import {
  deleteFinalSnapshot, describeDatabaseCluster, dropAuroraEnvironmentDatabase, emptyBucket, ensureDatabaseLogin, ensureGeneratedParameter, newestAuroraVersion, parameterExists,
  putParameter, removeLeftovers, s3Endpoint, tlsRequiredByDefault, type AwsAccess, type AwsEnvironmentDatabase,
} from '../adapters/providers/aws/aws-engine.client.js';
import { awsAccessCurrent } from '../adapters/providers/aws/aws-setup.client.js';
import { awsEngineAuthentication, awsEngineBackend } from '../adapters/providers/aws/tofu/aws-engine.backend.js';
import {
  awsKey, awsRegistryUrl, awsSharedClusterArn, buildAwsBuildConfiguration, buildAwsSharedConfiguration, LAMBDA_RESERVED_ENV, type AwsEngineInput, type AwsSharedInput,
} from '../adapters/providers/aws/tofu/aws-engine.config.js';
import { localRepositoryFor } from './local-repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { redactEngineOutput } from '../adapters/engine/opentofu/runner.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import { ConvergeExecutor, type ConvergeResult, type PlanRunDocument } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { engineSegmentOf, type EngineAuthentication, type EngineStateIdentity } from '../domain/ports/infrastructure-engine.port.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { CommandContext } from './context.js';
import { ENGINE_DATABASE_URL_KEY, engineSecretKeys, type InfrastructurePlanResult } from './infrastructure-engine.js';
import { engineOutsideKeys, type EngineSecretStore } from './engine-secrets.js';

/**
 * The OpenTofu lifecycle for AWS environments: spec → configuration, Hypervibe-owned
 * secrets in Parameter Store, the database login through the Data API, and the same
 * reviewed-plan/approval executor as GCP. See docs/opentofu-engine-aws.md.
 */
export const AWS_PARAMETER_OPERATION = 'awsParameterEnsure';
export const AWS_DATABASE_LOGIN_OPERATION = 'awsDatabaseLoginEnsure';
export const AWS_BUCKET_EMPTY_OPERATION = 'awsBucketEmpty';
export const AWS_TEARDOWN_CLEANUP_OPERATION = 'awsTeardownCleanup';
export const AWS_SNAPSHOT_DELETE_OPERATION = 'awsSnapshotDelete';
export const AWS_IMAGE_BUILD_OPERATION = 'awsImageBuild';
export const AWS_DATABASE_DROP_OPERATION = 'awsDatabaseDrop';

export type AwsProfile = EnvironmentProfile;
export const awsProfileFor = environmentProfile;

export interface AwsEngineBinding {
  kind?: 'opentofu';
  /** Image built by the release path; services are created once it exists. */
  imageUri?: string;
  /** The app's database login exists and DATABASE_URL is in Parameter Store. */
  databaseLoginAt?: string;
  /** The environment's database is on the project's shared testing cluster (earlier versions gave each environment its own). */
  sharedDatabase?: boolean;
  /** Waker login secrets Hypervibe has written (workers can be added after the app login exists). */
  wakerLogins?: string[];
  services?: Record<string, { url?: string; resource: string }>;
  /** Set once a teardown removed the environment; its database's final snapshot, while it exists. */
  tornDownAt?: string;
  finalSnapshot?: { identifier: string; region: string };
}

export interface AwsEngineContext {
  connection: AwsEngineCredentials;
  auth: EngineAuthentication;
  environment: Environment;
  state: EngineStateIdentity;
  /** The registry and build project, applied before the environment so its first image is built in the same apply. */
  buildState: EngineStateIdentity;
  /** The project's shared testing cluster: its own state, kept while any testing environment uses it. */
  shared: { prefix: string; state: EngineStateIdentity; clusterIdentifier: string; clusterArn: string };
  /** This environment's database and logins on the shared cluster. */
  database: AwsEnvironmentDatabase;
  prefix: string;
  parameterPath: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

export function isAwsEngineEnvironment(spec: ProjectSpec, environmentName: string): boolean {
  const environment = spec.environments[environmentName];
  return environment?.hosting.provider === 'aws';
}

export function awsBinding(environment: Environment): AwsEngineBinding {
  return ((environment.platformBindings as { aws?: AwsEngineBinding }).aws) ?? {};
}

const awsAccess = (context: Pick<AwsEngineContext, 'connection' | 'credentials'>): AwsAccess => ({ region: context.connection.region, credentials: context.credentials });

export async function resolveAwsEngineContext(ctx: CommandContext, project: Project, environmentName: string): Promise<AwsEngineContext | { blocked: string }> {
  const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl ?? undefined) ?? project.name;
  const stored = new ConnectionRepository().findBestVerifiedMatch('aws', repository);
  if (!stored) return { blocked: 'This project has no AWS access yet. Run hv_connections provider="aws" action="connect" (one sign-in).' };
  const parsed = AwsEngineCredentialsSchema.safeParse(getSecretStore().decryptObject(stored.credentialsEncrypted));
  if (!parsed.success) return { blocked: 'The AWS connection is not Hypervibe\'s deploy access. Run hv_connections provider="aws" action="connect" again.' };
  let auth: EngineAuthentication;
  try { auth = await awsEngineAuthentication(parsed.data); } catch (error) {
    return { blocked: `Hypervibe could not use its AWS deploy role: ${error instanceof Error ? error.name : String(error)}.` };
  }
  const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName)
    ?? ctx.repos.environments.create({ projectId: project.id, name: environmentName });
  const prefix = `hv-${project.name}-${environmentName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 28).replace(/-+$/, '');
  const sharedPrefix = `hv-${project.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 21).replace(/-+$/, '') + '-shared';
  const databaseName = `app_${awsKey(environmentName)}`.slice(0, 40).replace(/_+$/, '');
  return {
    connection: parsed.data, auth, environment, prefix,
    shared: {
      prefix: sharedPrefix, clusterIdentifier: `${sharedPrefix}-postgres`,
      clusterArn: awsSharedClusterArn({ accountId: parsed.data.accountId, region: parsed.data.region, prefix: sharedPrefix }),
      state: { provider: 'aws', projectId: project.id, environmentId: 'shared-testing', partition: 'project-shared' },
    },
    database: { name: databaseName, owner: `${databaseName}_owner`, waker: `${databaseName}_waker` },
    parameterPath: `/hypervibe/${environment.id.toLowerCase()}/`,
    state: { provider: 'aws', projectId: project.id, environmentId: environment.id, partition: 'environment' },
    buildState: { provider: 'aws', projectId: project.id, environmentId: `${environment.id}-build`, partition: 'environment' },
    credentials: { accessKeyId: auth.env.AWS_ACCESS_KEY_ID!, secretAccessKey: auth.env.AWS_SECRET_ACCESS_KEY!, sessionToken: auth.env.AWS_SESSION_TOKEN! },
  };
}

/** Desired state the AWS engine cannot manage yet; listed problems block planning instead of being ignored. */
export function awsEngineProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName]!;
  const problems: string[] = commonEngineProblems(environment);
  if (environment.database && awsProfileFor(environmentName) === 'production') {
    problems.push(`${environmentName} uses the production profile (RDS db.t4g.micro), which the AWS engine does not build yet. Testing environments (Aurora that pauses when idle) are supported.`);
  }
  if (environment.cache) problems.push('Redis caches are not available on the AWS engine yet.');
  if (Object.keys(environment.queues ?? {}).length) problems.push('Queues are not available on the AWS engine yet.');
  if (environment.domain) problems.push('Custom domains are not available on the AWS engine yet; use the service URL or route traffic with domainTarget.');
  const reserved = Object.keys(environment.envVars).filter((key) => LAMBDA_RESERVED_ENV.has(key));
  if (reserved.length && Object.values(environment.services).some((service) => (service.workloadKind ?? 'web') === 'web')) {
    problems.push(`${reserved.join(', ')} ${reserved.length === 1 ? 'is' : 'are'} set by AWS Lambda itself and cannot be configured; remove ${reserved.length === 1 ? 'it' : 'them'} from envVars.`);
  }
  for (const [name, service] of Object.entries(environment.services)) {
    if (environment.database && service.onDemand && !service.onDemand.nextWorkAtQuery) {
      problems.push(`${name} starts on demand, and this database pauses when idle: add onDemand.nextWorkAtQuery (one SELECT returning the earliest time queued work becomes due) so work scheduled for later starts on time.`);
    }
  }
  for (const [name, storage] of Object.entries(environment.storage ?? {})) {
    if (storage.provider !== 's3') problems.push(`Storage ${name}: the AWS engine manages buckets only with provider "s3".`);
  }
  return problems;
}

/** The AWS name of a workload: its Lambda function, ECS service and task family. */
export function awsResourceName(prefix: string, service: string): string {
  return `${prefix}-${service}`.slice(0, 60);
}

export function buildAwsEngineInput(spec: ProjectSpec, environmentName: string, context: Pick<AwsEngineContext, 'connection' | 'prefix' | 'parameterPath' | 'environment' | 'shared' | 'database'>, extra: {
  secretKeys: string[];
  /** The image the plan builds first, when the environment has none yet. */
  image?: string;
}): AwsEngineInput {
  const environmentSpec = spec.environments[environmentName]!;
  const imageUri = awsBinding(context.environment).imageUri ?? extra.image;
  const name = (service: string) => awsResourceName(context.prefix, service);
  const services = Object.entries(environmentSpec.services).sort(([a], [b]) => a.localeCompare(b));
  // Workloads need an image in this environment's registry, so they are created after the first build.
  const withImage = imageUri ? services : [];
  const bucketName = (storage: string) => `${context.prefix}-${storage}-${context.connection.accountId}`.slice(0, 63);
  // The shared S3 contract, minus keys: the runtime role is the credential (Lambda puts its
  // AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN in the environment; Fargate serves it to SDKs).
  const envFor = (service: string): Record<string, string> => {
    const buckets = Object.entries(environmentSpec.storage ?? {}).filter(([, storage]) => storage.injectInto.includes(service)).map(([name]) => name);
    if (buckets.length > 1) throw new Error(`Service ${service} can receive only one bucket's variables.`);
    const storage: Record<string, string> = buckets[0] ? {
      OBJECT_STORAGE_PROVIDER: 's3', OBJECT_STORAGE_BUCKET: bucketName(buckets[0]), AWS_S3_BUCKET_NAME: bucketName(buckets[0]),
      AWS_ENDPOINT_URL: s3Endpoint(context.connection.region), AWS_DEFAULT_REGION: context.connection.region, AWS_S3_URL_STYLE: 'virtual',
    } : {};
    for (const key of Object.keys(storage)) if (key in environmentSpec.envVars) throw new Error(`Environment variable ${key} conflicts with storage ${buckets[0]}.`);
    return { ...environmentSpec.envVars, ...storage };
  };
  return {
    accountId: context.connection.accountId, region: context.connection.region, prefix: context.prefix,
    environmentId: context.environment.id, parameterPath: context.parameterPath,
    ...(environmentSpec.database ? { database: { clusterArn: context.shared.clusterArn, name: context.database.name } } : {}),
    storage: Object.keys(environmentSpec.storage ?? {}).sort().map((storage) => ({ name: storage, bucket: bucketName(storage) })),
    services: withImage.filter(([, service]) => (service.workloadKind ?? 'web') === 'web').map(([logicalName, service]) => ({
      logicalName, resourceName: name(logicalName), initialImageUri: imageUri!, public: service.public ?? true,
      env: envFor(logicalName), ...(service.healthCheckPath ? { healthCheckPath: service.healthCheckPath } : {}),
    })),
    workers: withImage.filter(([, service]) => service.workloadKind === 'worker').map(([logicalName, service]) => ({
      logicalName, resourceName: name(logicalName), initialImageUri: imageUri!, env: envFor(logicalName),
      ...(service.startCommand ? { command: ['sh', '-c', service.startCommand] } : {}),
      ...(service.onDemand ? { pendingWorkQuery: service.onDemand.pendingWorkQuery, ...(service.onDemand.nextWorkAtQuery ? { nextWorkAtQuery: service.onDemand.nextWorkAtQuery } : {}) } : {}),
    })),
    jobs: withImage.filter(([, service]) => service.workloadKind === 'cron').map(([logicalName, service]) => ({
      logicalName, resourceName: name(logicalName), initialImageUri: imageUri!, env: envFor(logicalName),
      schedule: service.cronSchedule!, timeZone: service.timeZone ?? 'UTC', ...(service.startCommand ? { command: ['sh', '-c', service.startCommand] } : {}),
    })),
    secretKeys: extra.secretKeys,
  };
}

/** AWS Parameter Store as an environment's secret store. */
export async function awsSecretStore(ctx: CommandContext, project: Project, environmentName: string): Promise<EngineSecretStore | { blocked: string }> {
  const context = await resolveAwsEngineContext(ctx, project, environmentName);
  if ('blocked' in context) return context;
  const access = awsAccess(context);
  return {
    name: 'AWS Parameter Store',
    observe: async (key) => parameterExists(access, `${context.parameterPath}${key}`),
    write: async (key, value) => {
      try {
        await putParameter(access, `${context.parameterPath}${key}`, value);
        return undefined;
      } catch (error) {
        return `Parameter Store did not accept ${key} (${error instanceof Error ? error.name : 'error'}).`;
      }
    },
  };
}

/** The AWS testing environments with a database: they share one cluster. */
export function awsSharedDatabaseEnvironments(spec: ProjectSpec): string[] {
  return Object.keys(spec.environments).filter((name) => isAwsEngineEnvironment(spec, name) && awsProfileFor(name) === 'testing' && spec.environments[name]!.database).sort();
}

/** The shared cluster's input, sized for the testing environments in the spec (which must agree on the Postgres major). */
async function awsSharedInputFor(context: AwsEngineContext, spec: ProjectSpec, environments: string[]): Promise<AwsSharedInput | { blocked: string[] }> {
  const majors = [...new Set(environments.map((name) => (spec.environments[name]!.database as { version?: number }).version ?? 17))];
  if (majors.length > 1) return { blocked: [`The AWS testing environments share one database cluster, so they must use the same Postgres version (${environments.join(', ')} use ${majors.join(' and ')}).`] };
  const major = majors[0]!;
  const engineVersion = await newestAuroraVersion(awsAccess(context), major).catch(() => undefined);
  if (!engineVersion) return { blocked: [`AWS does not offer Aurora PostgreSQL ${major} in ${context.connection.region}, or the versions could not be read.`] };
  // Only a confirmed default of 1 skips the explicit setting; unknown keeps it (TLS stays required either way).
  const tlsDefault = await tlsRequiredByDefault(awsAccess(context), engineVersion.split('.')[0]!).catch(() => undefined);
  return { accountId: context.connection.accountId, region: context.connection.region, prefix: context.shared.prefix, environmentId: 'shared-testing',
    database: { engineVersion, minCapacity: 0, maxCapacity: 2, ...(tlsDefault ? { tlsRequiredByDefault: true } : {}) } };
}

/** The engine configuration for an environment as it stands: what plans compare against and teardown destroys. */
async function awsEngineConfigurationFor(context: AwsEngineContext, spec: ProjectSpec, environmentName: string, ownedSecretKeys: string[], image?: string) {
  const environmentSpec = spec.environments[environmentName]!;
  const binding = awsBinding(context.environment);
  // The login is created in the same apply, before anything starts, so workloads are wired to DATABASE_URL from the start.
  const secretKeys = [...ownedSecretKeys, ...(environmentSpec.database ? [ENGINE_DATABASE_URL_KEY] : [])];
  const input = buildAwsEngineInput(spec, environmentName, context, { secretKeys, ...(image ? { image } : {}) });
  return { binding, input, configuration: awsEngineBackend.buildConfiguration(input), buildConfiguration: buildAwsBuildConfiguration(input) };
}

/**
 * Plans removing an AWS environment completely: OpenTofu destroys everything it
 * created, after Hypervibe empties the storage buckets (deleting their files is
 * confirmed separately). Then Hypervibe removes what it created outside OpenTofu:
 * the environment's Parameter Store settings, task revisions registered by
 * releases and the build log group. The database keeps a final snapshot.
 */
export async function planAwsTeardown(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; environmentName: string;
  /** Also delete the database's final snapshot, so nothing of the environment remains. */
  deleteFinalSnapshot?: boolean;
}): Promise<InfrastructurePlanResult | { blocked: string[] }> {
  const { project, spec, environmentName } = params;
  const existing = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
  const tornDown = existing ? awsBinding(existing) : {};
  if (!spec.environments[environmentName]) {
    // Already torn down: only its final snapshot can remain.
    if (!tornDown.tornDownAt) return { blocked: [`${environmentName} is not an environment in the spec.`] };
    if (!tornDown.finalSnapshot) return { blocked: [`${environmentName} was torn down and nothing of it remains on AWS.`] };
    if (!params.deleteFinalSnapshot) return { blocked: [`${environmentName} was torn down; only its final database snapshot (${tornDown.finalSnapshot.identifier}) remains. Plan again with deleteFinalSnapshot=true to delete it.`] };
  }
  const context = await resolveAwsEngineContext(ctx, project, environmentName);
  if ('blocked' in context) return { blocked: [context.blocked] };
  const access = await awsAccessCurrent(context.credentials, context.connection.accountId);
  if (access === 'outdated') return { blocked: ['This version of Hypervibe needs a small update to its AWS access (one sign-in, then approve on the page): run hv_connections provider="aws" action="connect".'] };
  if (typeof access === 'object') return { blocked: [access.unknown] };
  const snapshotAction = (identifier: string, dependsOn: string[]): PlanAction => ({
    id: 'database-snapshot:final', type: 'destroy', verified: true, dataBearing: true, requiresConfirm: true,
    resource: { kind: 'database', name: identifier, provider: 'aws' },
    reason: `Hypervibe will permanently delete the final database snapshot ${identifier}; the database can no longer be restored.`,
    ...(dependsOn.length ? { dependsOn } : {}),
    metadata: { operation: AWS_SNAPSHOT_DELETE_OPERATION, accountId: context.connection.accountId, identifier },
  });
  const record = (actions: PlanAction[], warnings: string[], engine: Record<string, unknown>) => recordEnginePlan({
    projectId: project.id, environmentId: context.environment.id, environmentName, specRevision: params.specRevision, actions, warnings, confirm: 'all',
    engine: { state: context.state, teardown: true, aws: { accountId: context.connection.accountId, region: context.connection.region, prefix: context.prefix }, ...engine },
  });
  if (!spec.environments[environmentName]) {
    return record([snapshotAction(tornDown.finalSnapshot!.identifier, [])], ['Deleting the snapshot cannot be undone.'], { planId: `snapshot-${crypto.randomUUID()}` });
  }
  const imported = engineOutsideKeys(spec, environmentName, (context.environment.platformBindings as { engine?: { importedSecrets?: string[] } }).engine?.importedSecrets);
  const built = await awsEngineConfigurationFor(context, spec, environmentName, [...engineSecretKeys(spec, environmentName), ...imported]);
  // The shared cluster goes with the last testing environment that uses it; otherwise only this environment's database is dropped.
  const ownCluster = Boolean(awsBinding(context.environment).databaseLoginAt && !awsBinding(context.environment).sharedDatabase);
  const usesShared = Boolean(spec.environments[environmentName]!.database) && !ownCluster;
  const lastOnShared = usesShared && awsSharedDatabaseEnvironments(spec).every((name) => name === environmentName);
  const engine = await openTofuEngine();
  if ('blocked' in engine) return { blocked: [engine.blocked] };
  const planId = crypto.randomUUID();
  const planned = await engine.plan({ backend: awsEngineBackend, configuration: built.configuration, auth: context.auth, state: context.state, planId, destroy: true });
  if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
  if (planned.blockers.length) return { blocked: planned.blockers };
  const buildPlanId = crypto.randomUUID();
  const buildPlanned = await engine.plan({ backend: awsEngineBackend, configuration: built.buildConfiguration, auth: context.auth, state: context.buildState, planId: buildPlanId, destroy: true });
  if (!buildPlanned.ok) return { blocked: [redactEngineOutput(buildPlanned.error, context.auth.redact)] };
  if (buildPlanned.blockers.length) return { blocked: buildPlanned.blockers };
  let sharedPlanned: Awaited<ReturnType<typeof engine.plan>> | undefined;
  const sharedPlanId = crypto.randomUUID();
  if (lastOnShared) {
    const sharedInput = await awsSharedInputFor(context, spec, [environmentName]);
    if ('blocked' in sharedInput) return sharedInput;
    sharedPlanned = await engine.plan({ backend: awsEngineBackend, configuration: buildAwsSharedConfiguration(sharedInput), auth: context.auth, state: context.shared.state, planId: sharedPlanId, destroy: true });
    if (!sharedPlanned.ok) return { blocked: [redactEngineOutput(sharedPlanned.error, context.auth.redact)] };
    if (sharedPlanned.blockers.length) return { blocked: sharedPlanned.blockers };
  }

  const accountId = context.connection.accountId;
  const destroying = planned.actions.filter((action) => action.type !== 'noop');
  const emptyActions: PlanAction[] = (built.input.storage ?? [])
    .filter((bucket) => destroying.some((action) => action.id === `storage:${bucket.name}`))
    .map((bucket) => ({
      id: `storage-empty:${bucket.name}`, type: 'destroy', verified: true, dataBearing: true, requiresConfirm: true,
      resource: { kind: 'storage', name: bucket.name, provider: 'aws' },
      reason: `Hypervibe will permanently delete every file in ${bucket.bucket} so the bucket can be removed.`,
      metadata: { operation: AWS_BUCKET_EMPTY_OPERATION, accountId, bucket: bucket.bucket },
    }));
  const environmentActions = destroying.map((action) => action.id.startsWith('storage:') && emptyActions.some((empty) => empty.id === `storage-empty:${action.resource.name}`)
    ? { ...action, dependsOn: [...(action.dependsOn ?? []), `storage-empty:${action.resource.name}`] } : action);
  // The registry and build project go after the workloads that pull from it.
  const buildActions = buildPlanned.actions.filter((action) => action.type !== 'noop')
    .map((action) => environmentActions.length ? { ...action, dependsOn: [...new Set([...(action.dependsOn ?? []), ...environmentActions.map((entry) => entry.id)])] } : action);
  const afterEnvironment = (action: PlanAction): PlanAction => environmentActions.length ? { ...action, dependsOn: [...new Set([...(action.dependsOn ?? []), ...environmentActions.map((entry) => entry.id)])] } : action;
  const sharedActions = sharedPlanned?.ok ? sharedPlanned.actions.filter((action) => action.type !== 'noop').map(afterEnvironment) : [];
  const dropActions: PlanAction[] = usesShared && !lastOnShared ? [afterEnvironment({
    id: 'database:postgres', type: 'destroy', verified: true, dataBearing: true, requiresConfirm: true,
    resource: { kind: 'database', name: context.database.name, provider: 'aws' },
    reason: `Hypervibe will permanently drop database ${context.database.name} and its logins from the shared testing cluster; the other testing environments keep theirs.`,
    metadata: { operation: AWS_DATABASE_DROP_OPERATION, accountId, clusterIdentifier: context.shared.clusterIdentifier, database: context.database },
  })] : [];
  const engineActions = [...environmentActions, ...buildActions, ...dropActions, ...sharedActions];
  const families = [...(built.input.workers ?? []), ...(built.input.jobs ?? [])].map((task) => task.resourceName);
  const cleanup: PlanAction = {
    id: 'cleanup:leftovers', type: 'destroy', verified: true, requiresConfirm: true,
    resource: { kind: 'secret', name: 'environment leftovers', provider: 'aws' },
    reason: `Hypervibe will delete this environment's settings in Parameter Store (${context.parameterPath}), the task revisions its releases registered and its build logs.`,
    ...(engineActions.length ? { dependsOn: engineActions.map((action) => action.id) } : {}),
    metadata: { operation: AWS_TEARDOWN_CLEANUP_OPERATION, accountId, parameterPath: context.parameterPath, families, logGroups: [`/hypervibe/${context.prefix}/builds`],
      ...(lastOnShared && !params.deleteFinalSnapshot ? { finalSnapshot: `${context.shared.prefix}-postgres-final` } : {}) },
  };
  const destroysDatabase = sharedActions.some((action) => action.id === 'shared:database');
  const snapshot = destroysDatabase && params.deleteFinalSnapshot ? [snapshotAction(`${context.shared.prefix}-postgres-final`, ['shared:database'])] : [];
  if (snapshot.length) cleanup.dependsOn = [...(cleanup.dependsOn ?? []), snapshot[0]!.id];
  const actions = [...emptyActions, ...engineActions, ...snapshot, cleanup];
  const warnings = [
    `Removes AWS environment ${environmentName} in ${context.connection.region} (account ${accountId}). This cannot be undone.`,
    ...(destroysDatabase ? [snapshot.length
      ? 'The database\'s final snapshot is deleted too, so its data cannot be restored.'
      : `This is the last testing environment on the shared database cluster, so the cluster is removed too. It keeps a final snapshot (${context.shared.prefix}-postgres-final) so its data can be restored; it costs a few cents per GB each month. Plan with deleteFinalSnapshot=true to remove it as well.`] : []),
    ...(dropActions.length ? [`${environmentName}'s database is dropped with no snapshot; the shared cluster's backups can restore the whole cluster to a point in the last day.`] : []),
    `Hypervibe's access to this account stays, for other environments of ${project.name}.`,
  ];
  return record(actions, warnings, { planId, build: { planId: buildPlanId, state: context.buildState }, ...(sharedActions.length ? { shared: { planId: sharedPlanId, state: context.shared.state } } : {}) });
}

export async function planAwsInfrastructureEngine(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; environmentName: string;
}): Promise<InfrastructurePlanResult | { blocked: string[]; missingOutsideKeys?: string[] }> {
  const { project, spec, environmentName } = params;
  const environmentSpec = spec.environments[environmentName]!;
  const problems = awsEngineProblems(spec, environmentName);
  if (problems.length) return { blocked: problems };
  const context = await resolveAwsEngineContext(ctx, project, environmentName);
  if ('blocked' in context) return { blocked: [context.blocked] };
  const setup = await awsAccessCurrent(context.credentials, context.connection.accountId);
  if (setup === 'outdated') {
    return { blocked: ['This version of Hypervibe needs a small update to its AWS access (one sign-in, then approve on the page): run hv_connections provider="aws" action="connect".'] };
  }
  if (typeof setup === 'object') return { blocked: [setup.unknown] };

  // Hypervibe-owned generated secrets, observed in Parameter Store (present, absent or unknown).
  const access = awsAccess(context);
  const generated = engineSecretKeys(spec, environmentName);
  // Outside keys (declared in the spec or copied by a migration) must have a value; Hypervibe never invents them.
  const imported = engineOutsideKeys(spec, environmentName, (context.environment.platformBindings as { engine?: { importedSecrets?: string[] } }).engine?.importedSecrets);
  const secrets = await planEngineSecrets({
    environmentName, generated, outside: imported,
    observe: (key) => parameterExists(access, `${context.parameterPath}${key}`),
    action: (key, stored) => {
      const name = `${context.parameterPath}${key}`;
      return {
        id: `secret:${key}`, type: stored ? 'noop' : 'create', verified: true,
        resource: { kind: 'secret', name: key, provider: 'aws' },
        reason: stored ? `Secret ${key} is stored in Parameter Store.` : `Hypervibe will generate ${key} and store it in Parameter Store (${name}).`,
        metadata: { operation: AWS_PARAMETER_OPERATION, accountId: context.connection.accountId, name },
      };
    },
  });
  if ('blocked' in secrets) return secrets;
  const secretActions = secrets.actions;

  // The first image is built in this apply from the local commit, so the workloads are created in the same reviewed plan.
  const workloads = Object.keys(environmentSpec.services).length;
  const commit = !awsBinding(context.environment).imageUri && workloads ? localCommit(project) : undefined;
  const firstImage = commit ? `${awsRegistryUrl({ accountId: context.connection.accountId, region: context.connection.region, prefix: context.prefix })}:${commit.commitSha}` : undefined;
  const built = await awsEngineConfigurationFor(context, spec, environmentName, [...generated, ...imported], firstImage);
  const { binding, input, configuration } = built;
  if (environmentSpec.database && binding.databaseLoginAt && !binding.sharedDatabase) {
    return { blocked: [`${environmentName} was created with its own database cluster, before testing environments shared one. Tear it down (hv_plan scope="teardown") and launch it again to move it onto the shared cluster.`] };
  }

  const engine = await openTofuEngine();
  if ('blocked' in engine) return { blocked: [engine.blocked] };
  // 0. The project's shared testing cluster (its own state, so other testing environments keep it).
  const sharedPlanId = crypto.randomUUID();
  let sharedActions: PlanAction[] = [];
  if (environmentSpec.database) {
    const sharedInput = await awsSharedInputFor(context, spec, awsSharedDatabaseEnvironments(spec));
    if ('blocked' in sharedInput) return sharedInput;
    const sharedPlanned = await engine.plan({ backend: awsEngineBackend, configuration: buildAwsSharedConfiguration(sharedInput), auth: context.auth, state: context.shared.state, planId: sharedPlanId });
    if (!sharedPlanned.ok) return { blocked: [redactEngineOutput(sharedPlanned.error, context.auth.redact)] };
    if (sharedPlanned.blockers.length) return { blocked: sharedPlanned.blockers };
    sharedActions = sharedPlanned.actions;
  }
  const sharedChanging = sharedActions.filter((action) => action.type !== 'noop').map((action) => action.id);
  // 1. Registry and build project (their own state, applied first).
  const buildPlanId = crypto.randomUUID();
  const buildPlanned = await engine.plan({ backend: awsEngineBackend, configuration: built.buildConfiguration, auth: context.auth, state: context.buildState, planId: buildPlanId });
  if (!buildPlanned.ok) return { blocked: [redactEngineOutput(buildPlanned.error, context.auth.redact)] };
  if (buildPlanned.blockers.length) return { blocked: buildPlanned.blockers };
  const buildChanging = buildPlanned.actions.filter((action) => action.type !== 'noop').map((action) => action.id);
  // 2. The first image.
  const imageActions: PlanAction[] = commit ? [{
    id: 'build:image', type: 'create', verified: true, resource: { kind: 'service', name: 'image', provider: 'aws' },
    reason: `Hypervibe will build commit ${commit.commitSha.slice(0, 12)} in CodeBuild (a few cents) so the services start from it.`,
    ...(buildChanging.length ? { dependsOn: buildChanging } : {}),
    metadata: { operation: AWS_IMAGE_BUILD_OPERATION, accountId: context.connection.accountId, commitSha: commit.commitSha, directory: commit.directory, image: firstImage },
  }] : [];
  // 3. Everything else.
  const planId = crypto.randomUUID();
  const planned = await engine.plan({ backend: awsEngineBackend, configuration, auth: context.auth, state: context.state, planId });
  if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
  if (planned.blockers.length) return { blocked: planned.blockers };

  const prerequisites = [...secretActions, ...buildPlanned.actions, ...imageActions].filter((action) => action.type !== 'noop').map((action) => action.id);
  const engineActions = planned.actions.map((action) => (action.type === 'create' || action.type === 'update' || action.type === 'replace') && prerequisites.length
    ? { ...action, dependsOn: [...new Set([...(action.dependsOn ?? []), ...prerequisites])] } : action);
  // The app login is created once; each on-demand worker's waker login once its secret exists.
  const wakers = (input.workers ?? []).filter((worker) => worker.pendingWorkQuery);
  const wakerSecrets = wakers.map((worker) => `hypervibe/${context.prefix}/${worker.resourceName}-waker`);
  const appLogin = !binding.databaseLoginAt;
  const missingWakers = wakerSecrets.filter((secret) => !(binding.wakerLogins ?? []).includes(secret));
  const loginDependsOn = [
    ...sharedChanging,
    ...wakers.map((worker) => engineActions.find((action) => action.id === `service:${worker.logicalName}`))
      .filter((action): action is PlanAction => Boolean(action && action.type !== 'noop')).map((action) => action.id),
  ];
  const loginActions: PlanAction[] = environmentSpec.database && (appLogin || missingWakers.length) ? [{
    id: appLogin ? 'database-login:postgres' : 'database-login:waker', type: 'create', verified: true,
    resource: { kind: 'secret', name: appLogin ? ENGINE_DATABASE_URL_KEY : 'worker waker login', provider: 'aws' },
    reason: appLogin
      ? `Hypervibe will create ${environmentName}'s database ${context.database.name} on the shared testing cluster with the app's login${wakerSecrets.length ? ' and a read-only login for the worker waker' : ''}, and store ${ENGINE_DATABASE_URL_KEY} in Parameter Store.`
      : 'Hypervibe will create the read-only database login the worker waker counts pending work with. The app login is unchanged.',
    ...(loginDependsOn.length ? { dependsOn: loginDependsOn } : {}),
    metadata: { operation: AWS_DATABASE_LOGIN_OPERATION, accountId: context.connection.accountId, clusterIdentifier: context.shared.clusterIdentifier,
      parameter: `${context.parameterPath}${ENGINE_DATABASE_URL_KEY}`, appLogin, wakerSecrets, database: context.database },
  }] : [];
  const actions = [...secretActions, ...sharedActions, ...buildPlanned.actions, ...imageActions, ...engineActions, ...loginActions];
  const warnings = [
    `AWS ${context.connection.region}, ${awsProfileFor(environmentName)} profile.`,
    ...(environmentSpec.database ? [`Testing environments share one Aurora Serverless cluster (${context.shared.clusterIdentifier}); ${environmentName} gets its own database and logins on it.`] : []),
    ...(!binding.imageUri && !commit && workloads ? ['Hypervibe could not find this project\'s local repository, so the services are created after the first image build: run hv_deploy after this apply, then plan again.'] : []),
  ];
  return recordEnginePlan({ projectId: project.id, environmentId: context.environment.id, environmentName, specRevision: params.specRevision, actions, warnings,
    engine: { planId, state: context.state, build: { planId: buildPlanId, state: context.buildState }, ...(sharedActions.length ? { shared: { planId: sharedPlanId, state: context.shared.state } } : {}), aws: { accountId: context.connection.accountId, region: context.connection.region, prefix: context.prefix } } });
}

export async function applyAwsInfrastructureEngine(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; planId: string; confirmActions: string[];
}): Promise<{ kind: 'executed'; envName: string; result: ConvergeResult } | { kind: 'blocked'; reason: string }> {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { kind: 'blocked', reason: loaded.error };
  const document = loaded.document as PlanRunDocument & { engine?: { planId: string; state: EngineStateIdentity; build?: { planId: string; state: EngineStateIdentity }; shared?: { planId: string; state: EngineStateIdentity }; aws?: { accountId: string; region: string; prefix: string } } };
  const environmentName = document.environmentName;
  const reviewed = document.engine;
  const snapshotOnly = Boolean((reviewed as { teardown?: boolean } | undefined)?.teardown) && !params.spec.environments[environmentName];
  if (!reviewed?.aws || (!snapshotOnly && !isAwsEngineEnvironment(params.spec, environmentName))) return { kind: 'blocked', reason: 'This plan is not an AWS engine plan. Re-run hv_plan.' };
  const context = await resolveAwsEngineContext(ctx, params.project, environmentName);
  if ('blocked' in context) return { kind: 'blocked', reason: context.blocked };
  if (JSON.stringify(reviewed.state) !== JSON.stringify(context.state) || (reviewed.build && JSON.stringify(reviewed.build.state) !== JSON.stringify(context.buildState))
    || (reviewed.shared && JSON.stringify(reviewed.shared.state) !== JSON.stringify(context.shared.state))
    || reviewed.aws.accountId !== context.connection.accountId
    || reviewed.aws.region !== context.connection.region || reviewed.aws.prefix !== context.prefix) {
    return { kind: 'blocked', reason: 'The reviewed plan targets a different AWS account, region or environment. Re-run hv_plan.' };
  }
  const engine = await openTofuEngine();
  if ('blocked' in engine) return { kind: 'blocked', reason: engine.blocked };
  const access = awsAccess(context);
  const result = await executor.execute({
    planRunId: params.planId, currentSpecRevision: params.specRevision, confirmActions: params.confirmActions,
    handler: async (action) => {
      const metadata = action.metadata as { operation?: string; accountId?: string } | undefined;
      if (metadata?.accountId !== context.connection.accountId) return { success: false, status: 'blocked', message: 'AWS target changed; re-run hv_plan.' };
      try {
        if (metadata.operation === AWS_PARAMETER_OPERATION) return await ensureGeneratedParameter(access, (action.metadata as { name: string }).name);
        if (metadata.operation === AWS_IMAGE_BUILD_OPERATION) {
          const { buildAwsCommitImage } = await import('./infrastructure-engine-aws-release.js');
          const { directory, commitSha, image } = action.metadata as { directory: string; commitSha: string; image: string };
          const target = { region: context.connection.region, accountId: context.connection.accountId, prefix: context.prefix, credentials: context.credentials };
          const built = await buildAwsCommitImage(target, params.spec, environmentName, directory, commitSha);
          if ('error' in built) return { success: false, ...(built.unknown ? { status: 'pending' as const } : {}), message: built.error, error: built.error };
          // Record the reference the reviewed plan creates the services from (the registry's tags are immutable), not the digest, or the next plan replaces them.
          const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
          ctx.repos.environments.updatePlatformBindings(current.id, { aws: { ...awsBinding(current), kind: 'opentofu', imageUri: image } });
          return { success: true, message: `Built ${built.imageUri}.`, data: { imageUri: built.imageUri } };
        }
        if (metadata.operation === AWS_SNAPSHOT_DELETE_OPERATION) {
          const deleted = await deleteFinalSnapshot(access, (action.metadata as { identifier: string }).identifier);
          if (deleted.success) {
            const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
            const { finalSnapshot: _snapshot, ...remaining } = awsBinding(current);
            ctx.repos.environments.updatePlatformBindings(current.id, { aws: remaining });
          }
          return deleted;
        }
        if (metadata.operation === AWS_BUCKET_EMPTY_OPERATION) return await emptyBucket(access, (action.metadata as { bucket: string }).bucket);
        if (metadata.operation === AWS_TEARDOWN_CLEANUP_OPERATION) {
          const removed = await removeLeftovers(access, { prefix: context.prefix, ...(action.metadata as { parameterPath: string; families: string[]; logGroups: string[] }) });
          if (removed.success) {
            // Nothing of this environment remains on AWS; forget its bindings so a later plan starts fresh.
            const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
            const { aws: _aws, engine: _engine, ...rest } = current.platformBindings as Record<string, unknown>;
            const kept = (action.metadata as { finalSnapshot?: string }).finalSnapshot;
            ctx.repos.environments.updatePlatformBindings(current.id, { ...rest, engine: {},
              aws: { tornDownAt: new Date().toISOString(), ...(kept ? { finalSnapshot: { identifier: kept, region: context.connection.region } } : {}) } });
            // The environment is gone; removing it from the spec keeps the next plan from recreating it.
            new SpecStore().merge(params.project, specWithoutEnvironment(params.spec, environmentName));
          }
          return removed;
        }
        if (metadata.operation === AWS_DATABASE_DROP_OPERATION) {
          const { clusterIdentifier, database } = action.metadata as { clusterIdentifier: string; database: AwsEnvironmentDatabase };
          const { clusterArn, secretArn } = await describeDatabaseCluster(access, clusterIdentifier);
          if (!clusterArn || !secretArn) return { success: false, status: 'blocked', message: `The shared cluster ${clusterIdentifier} could not be read; re-run hv_plan.` };
          return await dropAuroraEnvironmentDatabase(access, { clusterArn, masterSecretArn: secretArn, database });
        }
        if (metadata.operation === AWS_DATABASE_LOGIN_OPERATION) {
          // The cluster OpenTofu just created, read from RDS: its ARN, endpoint and RDS-managed master secret.
          const identifier = (action.metadata as { clusterIdentifier: string }).clusterIdentifier;
          const { clusterArn, secretArn, endpoint } = await describeDatabaseCluster(access, identifier);
          if (!clusterArn || !secretArn || !endpoint) return { success: false, status: 'blocked', message: `Database ${identifier} is not ready yet; re-run hv_plan.` };
          const login = action.metadata as { parameter: string; wakerSecrets: string[]; appLogin?: boolean; database: AwsEnvironmentDatabase };
          const created = await ensureDatabaseLogin(access, { parameter: login.parameter, wakerSecrets: login.wakerSecrets, ...(login.appLogin !== undefined ? { appLogin: login.appLogin } : {}),
            clusterArn, masterSecretArn: secretArn, endpoint, databaseUrlKey: ENGINE_DATABASE_URL_KEY, database: login.database });
          if (created.success) {
            const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
            const previous = awsBinding(current);
            const written = (action.metadata as { wakerSecrets: string[] }).wakerSecrets;
            ctx.repos.environments.updatePlatformBindings(current.id, { aws: { ...previous, kind: 'opentofu', sharedDatabase: true,
              databaseLoginAt: previous.databaseLoginAt ?? new Date().toISOString(), wakerLogins: [...new Set([...(previous.wakerLogins ?? []), ...written])] } });
          }
          return created;
        }
      } catch (error) {
        return { success: false, message: redactEngineOutput(error instanceof Error ? `${error.name}: ${error.message}` : String(error), context.auth.redact) };
      }
      return { success: false, status: 'blocked', message: `No engine-stage authority exists for ${action.id}.` };
    },
    segmentHandler: async (segment, members) => {
      const addresses = [...new Set(members.flatMap((member) => engineSegmentOf(member)?.addresses ?? []))];
      const target = [reviewed.build, reviewed.shared].find((entry) => entry && segment.id === `opentofu:${entry.planId}`) ?? { planId: reviewed.planId, state: context.state };
      const outcome = await engine.apply({ backend: awsEngineBackend, auth: context.auth, state: target.state, planId: target.planId,
        segment: { ...segment, addresses }, approvedAddresses: addresses });
      return { ...outcome, diagnostics: outcome.diagnostics.map((line) => redactEngineOutput(line, context.auth.redact)) };
    },
  });
  return { kind: 'executed', envName: environmentName, result };
}

/** The local commit an infrastructure plan builds when the environment has no image yet. */
function localCommit(project: Project): { directory: string; commitSha: string } | undefined {
  const directory = localRepositoryFor(project, new SpecStore().get(project)?.source as { kind?: string; path?: string } | undefined);
  if (!directory) return undefined;
  try {
    const commitSha = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(commitSha) ? { directory, commitSha } : undefined;
  } catch {
    return undefined;
  }
}
