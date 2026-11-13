import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { domainServiceFor, engineEnvironmentProblems, isEngineManaged } from '../domain/services/infrastructure-engine-selection.js';
export { engineEnvironmentProblems, isEngineManaged } from '../domain/services/infrastructure-engine-selection.js';
import { createCommandContext } from './context.js';
import { applyAwsInfrastructureEngine, isAwsEngineEnvironment, planAwsInfrastructureEngine } from './infrastructure-engine-aws.js';
import { applyAzureInfrastructureEngine, isAzureEngineEnvironment, planAzureInfrastructureEngine } from './infrastructure-engine-azure.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { registerEngineWebServiceResolver } from '../domain/services/domain-target.service.js';
import crypto from 'crypto';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import { S3_COMPATIBLE_SECRET_KEYS, iamDatabaseUser } from '../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildSourceBucketName } from '../domain/services/cloud-prepare.execute.js';
import { isCloudPreparedForCache, isCloudPreparedForQueues, isCloudPreparedForStorage, isCloudPreparedForWorkerWake } from '../domain/services/cloud-prepare.js';
import { buildQueueEnvVars, pubsubQueueResourceIds } from '../domain/services/queue-env.js';

const execFileAsync = promisify(execFile);
import type { CommandContext } from './context.js';
import { engineOutsideKeys, type EngineSecretStore } from './engine-secrets.js';
import { resourceName } from '../domain/services/resource-names.js';
import { ConvergeExecutor, type ActionResult, type ConvergeResult, type PlanRunDocument } from '../domain/plan/converge.executor.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import { ensureEngineBinary, enginePluginCacheDir } from '../adapters/engine/opentofu/install.js';
import { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import { CloudRunAdapter } from '../adapters/providers/gcp/cloudrun.adapter.js';
import {
  buildCloudRunConfiguration,
  gcpEngineAuthentication,
  gcpEngineBackend,
  type GcpCloudRunEngineInput,
} from '../adapters/providers/gcp/tofu/gcp-engine.backend.js';
import type { EngineAuthentication, EngineStateIdentity } from '../domain/ports/infrastructure-engine.port.js';
import { engineSegmentOf } from '../domain/ports/infrastructure-engine.port.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Service } from '../domain/entities/service.entity.js';
import type { ProjectRuntime } from '../domain/spec/project-runtime.js';
import type { EnvironmentSpec, ProjectSpec } from '../domain/spec/spec.schema.js';
import { normalizeGitRemoteForBuild, parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { redactEngineOutput } from '../adapters/engine/opentofu/runner.js';
import {
  executeDatabaseCredential, grantWorkerWakeRead, observeDatabaseCredential, otherLogin,
  type DatabaseCredentialMetadata, type DatabaseCredentialObservation, type DatabaseLogin,
} from './infrastructure-engine-database.js';
import {
  DOMAIN_DNS_OPERATION, DOMAIN_DNS_REMOVE_OPERATION, DOMAIN_READY_OPERATION, DOMAIN_VERIFY_OPERATION,
  executeDomainAction, planDomain, observeDomainMapping, type DomainPlanActions,
} from './infrastructure-engine-domain.js';
import { getDnsBindingIdentity, getDnsBindingSelection, getDnsOwnedDomain, hasOwnedDnsRecords, prepareDnsEnginePlan } from './dns-engine.js';
import { persistDnsPlanRun } from './dns-hosting.js';
import { verifyDnsTrafficAbsent } from './dns-absence.js';
import { verifyGcpDomainEngineOwnership } from './gcp-domain-ownership.js';
import { dnsZoneIdentity } from '../domain/services/dns-policy.service.js';
import type { DnsZoneIdentity } from '../domain/ports/dns.port.js';

const DOMAIN_OPERATIONS = new Set([DOMAIN_VERIFY_OPERATION, DOMAIN_DNS_OPERATION, DOMAIN_READY_OPERATION, DOMAIN_DNS_REMOVE_OPERATION]);

/**
 * OpenTofu-managed GCP environments.
 *
 * Cloud Run environments always use OpenTofu. OpenTofu owns the
 * Cloud Run services and Secret Manager containers; Hypervibe owns secret values,
 * image builds and releases, health and bindings. The legacy Cloud Run service
 * writer never runs for these environments.
 */
export const ENGINE_SECRET_OPERATION = 'gcpSecretManagerEnsure';
export const ENGINE_PLAN_SCOPE = 'infrastructure-engine';
export const ENGINE_RELEASE_OPERATION = 'engineImageRelease';
export const ENGINE_STORAGE_ACCESS_BLOCKER = 'Storage buckets need one more Google Cloud permission for Hypervibe. Approve it with hv_launch approveAccess=true, or run hv_connections provider="cloudrun" action="prepare" gcsAccess="lifecycle" (preview, then confirm).';
export const ENGINE_CACHE_CREDENTIAL_OPERATION = 'gcpCacheCredentialEnsure';
export const ENGINE_STORAGE_S3_KEY_OPERATION = 'gcpStorageS3KeyEnsure';
export const ENGINE_CACHE_URL_KEY = 'REDIS_URL';
export const ENGINE_CACHE_ACCESS_BLOCKER = 'Redis needs one more Google Cloud permission for Hypervibe. Approve it with hv_launch approveAccess=["memorystore"], or run hv_connections provider="cloudrun" action="prepare" memorystoreAccess="lifecycle" (preview, then confirm).';
export const ENGINE_DATABASE_CREDENTIAL_OPERATION = 'gcpDatabaseCredentialEnsure';
export const ENGINE_WORKER_WAKE_GRANT_OPERATION = 'gcpWorkerWakeGrant';
export const ENGINE_WORKER_ACCESS_BLOCKER = 'On-demand workers need one more Google Cloud permission for Hypervibe. Approve it with hv_launch approveAccess=["workers"], or run hv_connections provider="cloudrun" action="prepare" workerAccess="lifecycle" (preview, then confirm).';
/** Hypervibe-owned runtime secret holding the complete database connection URL. */
export const ENGINE_DATABASE_URL_KEY = 'DATABASE_URL';
const ENGINE_DATABASE_NAME = 'app';
/** Google's public sample container, pinned by digest; serves until the first release. */
export const ENGINE_HOLDING_IMAGE = 'us-docker.pkg.dev/cloudrun/container/hello@sha256:1fde53e0b892bff3072b3cac1c0e37178e9c0b98cf0b01e83956915e02b828c7';
const DEFAULT_REGION = 'us-central1';


// Traffic handoffs (domainTarget) to an engine-managed environment verify its exact live web service.
registerEngineWebServiceResolver(async ({ project, environment, environmentName, service }) => {
  const spec = new SpecStore().getForInspection(project)?.spec;
  if (!spec) return { unknown: 'The project has no spec.' };
  const context = await resolveEngineContext(createCommandContext(), project, spec, environmentName);
  if ('blocked' in context) return { unknown: context.blocked };
  const binding = ((environment.platformBindings as { services?: Record<string, { serviceId?: string }> }).services ?? {})[service];
  if (!binding?.serviceId) return { unknown: `The target service ${service} has not been created yet.` };
  const observed = await cloudRunGet(await context.adapter.engineAccessToken(), context.gcpProjectId, context.region, binding.serviceId);
  if (observed.state !== 'present') return { unknown: `The target service ${service} could not be read from Cloud Run.` };
  const value = observed.value;
  if (!value.uri || !value.uid || value.terminalCondition?.state !== 'CONDITION_SUCCEEDED' || value.latestReadyRevision !== value.latestCreatedRevision) {
    return { unknown: `The target service ${service} is not serving its latest revision.` };
  }
  return { provider: 'cloudrun', providerProjectId: context.gcpProjectId, providerEnvironmentId: context.region, serviceId: binding.serviceId, resourceUid: value.uid, url: value.uri };
});

export function engineSecretKeys(spec: ProjectSpec, environmentName: string): string[] {
  return Object.entries(spec.secrets)
    .filter(([, secret]) => secret.ownership === 'hypervibe' && secret.environments.includes(environmentName))
    .map(([key]) => key)
    .sort();
}

export function engineSecretId(environmentName: string, key: string): string {
  const id = `hv-${environmentName}-${key}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  if (id.length > 255) throw new Error(`Secret id for ${key} is too long.`);
  return id;
}

function labelValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63);
}

export interface EngineBinding {
  kind?: 'opentofu';
  database?: { instanceName: string; connectionName?: string };
  domains?: string[];
  /** Retained before attempting a mapping, including cancellation before DNS starts. */
  domainClaims?: Record<string, { zone: DnsZoneIdentity; connectionScope?: string }>;
  storage?: string[];
  cache?: { instanceName: string };
  queues?: string[];
  /** Cloud Run job that runs the release command. */
  releaseJob?: string;
  /** IAM database user that was granted read access for on-demand worker wakers. */
  workerWakeGrant?: string;
  /** When that grant was made; a later data copy replaces the tables and drops it. */
  workerWakeGrantAt?: string;
  /** An in-progress secret rotation, so hv_secrets action="rotate" resumes where it stopped. */
  rotation?: { startedAt: string; keys: string[]; databaseGeneration?: number };
  /** Runtime secrets copied from a migration source into Secret Manager. */
  importedSecrets?: string[];
  /** Import names awaiting approved container creation and direct value transfer. */
  pendingImportedSecrets?: string[];
  /** Container identities tracked in the environment engine state. */
  secrets?: string[];
  /** Non-secret credential metadata bound to an acknowledged exact Secret Manager version. */
  secretMetadata?: Record<string, { gcpProjectId: string; version: string; labels: Record<string, string> }>;
  /** Keyless CI release trust granted for this exact repository. */
  ci?: { repository: string; provider: string; releaseIdentity: string };
  /** Evidence of a verified migration copy; re-runs release without copying again. */
  migration?: {
    from: string;
    sourceMajor?: number;
    copiedAt?: string;
    database?: { tables: number; rows: string; match: boolean; differences: string[]; restoreWarnings: number };
    storage?: Array<{ name: string; files: number; bytes: number; match: boolean }>;
  };
}

/** Globally unique, stable bucket name; bucket names can be reused after deletion. */
export function engineBucketName(gcpProjectId: string, environmentName: string, storageName: string): string {
  const hash = crypto.createHash('sha256').update(`${gcpProjectId}/${environmentName}/${storageName}`).digest('hex').slice(0, 8);
  return `hv-${hash}-${environmentName}-${storageName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
}

export interface EngineContext {
  adapter: CloudRunAdapter;
  environment: Environment;
  gcpProjectId: string;
  region: string;
  runtimeServiceAccountEmail: string;
  auth: EngineAuthentication;
  state: EngineStateIdentity;
}

/**
 * The Google Cloud connection scoped to exactly this project's repository.
 * Global or other projects' connections are never used: they point at someone
 * else's Google Cloud project, and an engine environment must live in its own.
 */
export async function engineGcpAdapter(project: Pick<Project, 'gitRemoteUrl'>): Promise<CloudRunAdapter | undefined> {
  const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repository) return undefined;
  const connection = new ConnectionRepository().findByProviderAndScope('cloudrun', repository);
  if (!connection || connection.status !== 'verified') return undefined;
  const adapter = new CloudRunAdapter();
  await adapter.connect(getSecretStore().decryptObject(connection.credentialsEncrypted));
  return adapter;
}

export async function resolveEngineContext(
  ctx: CommandContext,
  project: Project,
  spec: ProjectSpec,
  environmentName: string
): Promise<EngineContext | { blocked: string }> {
  const environmentSpec = spec.environments[environmentName]!;
  const adapter = await engineGcpAdapter(project);
  if (!adapter) {
    return { blocked: 'This project has no Google Cloud connection of its own yet. Run hv_launch (or hv_connections action="bootstrap") to set one up.' };
  }
  const region = environmentSpec.hosting.region ?? DEFAULT_REGION;
  adapter.configureTarget({ region });
  const connection = adapter.engineConnection();
  if (!connection.runtimeServiceAccountEmail) {
    return { blocked: 'The GCP connection has no separate runtime identity. Re-run the GCP bootstrap so services never run as the deployment identity.' };
  }
  const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName)
    ?? ctx.repos.environments.create({ projectId: project.id, name: environmentName });
  const bindings = environment.platformBindings as { provider?: string; projectId?: string; environmentId?: string; engine?: { kind?: string } };
  if (bindings.projectId && (bindings.projectId !== connection.projectId || bindings.environmentId !== region)) {
    return { blocked: `Environment ${environmentName} is bound to ${bindings.projectId}/${bindings.environmentId}, not ${connection.projectId}/${region}. Hypervibe will not move it implicitly.` };
  }
  const services = (environment.platformBindings as { services?: Record<string, unknown> }).services ?? {};
  if (Object.keys(services).length > 0 && bindings.engine?.kind !== 'opentofu') {
    return { blocked: `Environment ${environmentName} has old GCP service bindings without OpenTofu ownership. Hypervibe cannot safely change those resources; explicit adoption is unavailable.` };
  }
  let auth: EngineAuthentication;
  try {
    auth = gcpEngineAuthentication(connection);
  } catch (error) {
    return { blocked: error instanceof Error ? error.message : String(error) };
  }
  return {
    adapter,
    environment,
    gcpProjectId: connection.projectId,
    region,
    runtimeServiceAccountEmail: connection.runtimeServiceAccountEmail,
    auth,
    state: { provider: 'gcp', projectId: project.id, environmentId: environment.id, partition: 'environment' },
  };
}

function serviceResourceName(context: EngineContext, environmentName: string, serviceName: string): string {
  const binding = (context.environment.platformBindings as { services?: Record<string, { serviceId?: string; jobName?: string; workerPoolName?: string }> }).services?.[serviceName];
  const bound = binding?.serviceId ?? binding?.jobName ?? binding?.workerPoolName;
  return bound ?? resourceName(serviceName, { maxLength: 49, scope: [context.gcpProjectId, environmentName] });
}

export function buildEngineInput(spec: ProjectSpec, environmentName: string, context: Pick<EngineContext, 'gcpProjectId' | 'region' | 'runtimeServiceAccountEmail'> & {
  resourceNameFor: (service: string) => string;
  databaseWired?: boolean;
  cacheWired?: boolean;
  /** Storage names whose S3-compatible access key has been published. */
  s3WiredStorage?: string[];
  /** Keys of secrets imported from a migration source. */
  importedSecrets?: string[];
  /** Exact secret versions to pin; a new version then rolls services through a reviewed update. */
  secretVersions?: Record<string, string>;
}): GcpCloudRunEngineInput {
  const environmentSpec = spec.environments[environmentName]!;
  const secretKeys = [...engineSecretKeys(spec, environmentName), ...(context.importedSecrets ?? []), ...(context.databaseWired ? [ENGINE_DATABASE_URL_KEY] : []),
    ...(context.cacheWired ? [ENGINE_CACHE_URL_KEY] : [])];
  const secretEnv = Object.fromEntries(secretKeys
    .filter((key) => context.secretVersions?.[key])
    .map((key) => [key, { secretId: engineSecretId(environmentName, key), version: context.secretVersions?.[key] ?? 'latest' }]));
  // S3-compatible keys go only to the services that use that bucket.
  const s3SecretEnvFor = (service: string) => Object.fromEntries(Object.entries(environmentSpec.storage ?? {})
    .filter(([storageName, storage]) => storage.access === 's3' && storage.injectInto.includes(service) && context.s3WiredStorage?.includes(storageName))
    .flatMap(([storageName]) => S3_COMPATIBLE_SECRET_KEYS.map((key) => {
      const secretKey = `${storageName}_${key}`;
      return [key, { secretId: engineSecretId(environmentName, secretKey), version: context.secretVersions?.[secretKey] ?? 'latest' }];
    })));
  const services = Object.entries(environmentSpec.services).sort(([a], [b]) => a.localeCompare(b)).map(([name, service]) => {
      const workload = service.workloadKind === 'cron' ? 'job' as const : service.workloadKind === 'worker' ? 'worker' as const : 'web' as const;
      return {
        logicalName: name,
        resourceName: context.resourceNameFor(name),
        workload,
        initialImage: ENGINE_HOLDING_IMAGE,
        runtimeServiceAccountEmail: context.runtimeServiceAccountEmail,
        // Queue names follow the shared Pub/Sub contract so apps see the same variables on every path.
        env: { ...buildQueueEnvVars({ environmentSpec, environment: { name: environmentName, platformBindings: { projectId: context.gcpProjectId } }, backend: environmentSpec.queues ? 'pubsub' : undefined, gcpProjectId: context.gcpProjectId }), ...environmentSpec.envVars },
        secretEnv: { ...secretEnv, ...s3SecretEnvFor(name) },
        public: service.public ?? workload === 'web',
        ...(service.healthCheckPath ? { healthCheckPath: service.healthCheckPath } : {}),
        ...(service.cpu ? { cpu: service.cpu } : {}),
        ...(service.memory ? { memory: service.memory } : {}),
        ...(workload === 'worker' && service.onDemand ? { pendingWorkQuery: service.onDemand.pendingWorkQuery } : {}),
        ...(workload === 'job' ? { schedule: service.cronSchedule, timeZone: service.timeZone ?? 'UTC', jobCommand: service.startCommand } : {}),
      };
    });
  // The release command runs with the web service's configuration (secrets, database, storage).
  const command = releaseCommandFor(environmentSpec);
  const primary = services.find((service) => service.workload === 'web') ?? services.find((service) => service.workload !== 'job');
  return {
    projectId: context.gcpProjectId,
    region: context.region,
    services,
    ...(command && primary ? { releaseJob: {
      ...primary, logicalName: 'release', resourceName: context.resourceNameFor('release-command'), workload: 'worker' as const,
      public: false, jobCommand: command, healthCheckPath: undefined,
    } } : {}),
  };
}

/** The reviewed migration command run before each release, when the spec asks for one. */
export function releaseCommandFor(environmentSpec: EnvironmentSpec): string | undefined {
  return environmentSpec.migrations?.mode === 'releaseCommand' ? environmentSpec.migrations.command?.trim() || undefined : undefined;
}

// ---------------------------------------------------------------- Secret Manager (Hypervibe-owned)

type Observed<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown'; reason: string };

export async function secretManagerFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
}

interface ObservedSecret { resourceName?: string; labels: Record<string, string>; containerLabels?: Record<string, string>; hasEnabledVersion: boolean; latestVersion?: string }

export async function observeSecret(token: string, gcpProjectId: string, secretId: string): Promise<Observed<ObservedSecret>> {
  const base = `https://secretmanager.googleapis.com/v1/projects/${gcpProjectId}/secrets/${secretId}`;
  const secret = await secretManagerFetch(token, base);
  if (secret.status === 404) return { state: 'absent' };
  if (!secret.ok) return { state: 'unknown', reason: `Secret Manager returned HTTP ${secret.status} for ${secretId}.` };
  const body = await secret.json() as { name?: string; labels?: Record<string, string> };
  const resourceName = body.name ?? `projects/${gcpProjectId}/secrets/${secretId}`;
  const version = await secretManagerFetch(token, `${base}/versions/latest`);
  if (version.status === 404) return { state: 'present', value: { resourceName, labels: body.labels ?? {}, hasEnabledVersion: false } };
  if (!version.ok) return { state: 'unknown', reason: `Secret Manager returned HTTP ${version.status} for ${secretId} versions.` };
  const versionBody = await version.json() as { state?: string; name?: string };
  if (versionBody.name && !versionBody.name.startsWith(`${resourceName}/versions/`)) return { state: 'unknown', reason: `Secret Manager returned a version for a different secret than ${secretId}.` };
  const latestVersion = versionBody.name?.split('/').pop();
  const containerLabels = body.labels ?? {};
  const environment = containerLabels['hv-environment'] ? new EnvironmentRepository().findById(containerLabels['hv-environment']) : undefined;
  const metadata = (environment?.platformBindings as { engine?: EngineBinding } | undefined)?.engine?.secretMetadata?.[secretId];
  if (metadata && (metadata.gcpProjectId !== gcpProjectId || metadata.version !== latestVersion)) {
    return { state: 'unknown', reason: `Secret ${secretId} has an unrecognized version; its credential metadata cannot be reused. Inspect the interrupted value write before retrying.` };
  }
  return { state: 'present', value: { resourceName, labels: metadata ? { ...metadata.labels, 'managed-by': containerLabels['managed-by']!, 'hv-environment': containerLabels['hv-environment']! } : containerLabels, containerLabels,
    hasEnabledVersion: versionBody.state === 'ENABLED',
    ...(latestVersion && /^[1-9][0-9]*$/.test(latestVersion) ? { latestVersion } : {}) } };
}

async function listEngineSecrets(token: string, gcpProjectId: string, environmentId: string): Promise<Observed<string[]>> {
  const filter = encodeURIComponent(`labels.managed-by=hypervibe AND labels.hv-environment=${labelValue(environmentId)}`);
  const ids: string[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const response = await secretManagerFetch(token,
      `https://secretmanager.googleapis.com/v1/projects/${gcpProjectId}/secrets?filter=${filter}&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
    if (!response.ok) return { state: 'unknown', reason: `Listing Secret Manager secrets returned HTTP ${response.status}.` };
    const body = await response.json() as { secrets?: Array<{ name: string }>; nextPageToken?: string };
    ids.push(...(body.secrets ?? []).map((secret) => secret.name.split('/').pop()!));
    if (!body.nextPageToken) return { state: 'present', value: ids.sort() };
    pageToken = encodeURIComponent(body.nextPageToken);
  }
  return { state: 'unknown', reason: 'Secret Manager listing exceeded its page bound.' };
}

async function ensureSecret(token: string, action: PlanAction): Promise<ActionResult> {
  const { gcpProjectId, secretId, labels } = action.metadata as { gcpProjectId: string; secretId: string; labels: Record<string, string> };
  const base = `https://secretmanager.googleapis.com/v1/projects/${gcpProjectId}/secrets`;
  const observed = await observeSecret(token, gcpProjectId, secretId);
  if (observed.state === 'unknown') return { success: false, status: 'blocked', message: observed.reason };
  if (observed.state === 'present') {
    if (observed.value.labels['managed-by'] !== 'hypervibe' || observed.value.labels['hv-environment'] !== labels['hv-environment']) {
      return { success: false, status: 'blocked', message: `Secret ${secretId} exists but is not owned by this Hypervibe environment.` };
    }
    if (observed.value.hasEnabledVersion) return { success: true, message: `Secret ${secretId} already has a value; it was preserved.` };
  } else {
    return { success: false, status: 'blocked', message: `Secret container ${secretId} is absent. Run hv_plan and apply its OpenTofu container action first.` };
  }
  // Hypervibe generates and writes the value; it never enters plans, engine state or output.
  const value = crypto.randomBytes(32).toString('base64url');
  let added: Response;
  try {
    added = await secretManagerFetch(token, `${base}/${secretId}:addVersion`, {
      method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(value).toString('base64') } }),
    });
  } catch {
    return { success: false, status: 'pending', message: `The value write for ${secretId} has an unknown outcome. Run hv_plan again to observe it before retrying.` };
  }
  if (!added.ok) return { success: false, message: `Writing the value of ${secretId} failed (HTTP ${added.status}).`, error: `HTTP ${added.status}` };
  const verified = await observeSecret(token, gcpProjectId, secretId);
  if (verified.state !== 'present' || !verified.value.hasEnabledVersion) {
    return { success: false, status: 'pending', message: `Secret ${secretId} was written but could not be verified yet.` };
  }
  return { success: true, message: `Secret ${secretId} was created with a Hypervibe-generated value.` };
}

// ---------------------------------------------------------------- Database login (Hypervibe-owned)

export async function sqlAdmin(token: string, gcpProjectId: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(`https://sqladmin.googleapis.com/v1/projects/${gcpProjectId}/${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

export async function waitForSqlOperation(token: string, gcpProjectId: string, operation: { name?: string; status?: string; error?: unknown }): Promise<'done' | 'failed' | 'unknown'> {
  if (operation.status === 'DONE') return operation.error ? 'failed' : 'done';
  if (!operation.name) return 'unknown';
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await sqlAdmin(token, gcpProjectId, `operations/${operation.name}`);
    if (!response.ok) continue;
    const body = await response.json() as { status?: string; error?: unknown };
    if (body.status === 'DONE') return body.error ? 'failed' : 'done';
  }
  return 'unknown';
}

/** Records only non-secret operational metadata; the engine owns container metadata. */
export function recordSecretVersionMetadata(gcpProjectId: string, secretId: string, version: string, labels: Record<string, string>): boolean {
  const repo = new EnvironmentRepository();
  const environment = repo.findById(labels['hv-environment'] ?? '');
  if (!environment || !/^[1-9][0-9]*$/.test(version)) return false;
  const engine = (environment.platformBindings as { engine?: EngineBinding }).engine ?? {};
  repo.updatePlatformBindings(environment.id, { engine: { ...engine,
    secretMetadata: { ...engine.secretMetadata, [secretId]: { gcpProjectId, version, labels } } } });
  return true;
}

/** A plan stops on missing outside keys with the one command that collects them all. */
export function missingOutsideKeysMessage(environmentName: string, keys: string[]): string {
  return `${environmentName} needs ${keys.length === 1 ? 'a key' : `${keys.length} keys`} Hypervibe cannot create: ${keys.join(', ')}. `
    + `Run hv_secrets action="collect" env="${environmentName}" to add ${keys.length === 1 ? 'it' : 'them all'} on one local page (hv_launch does this itself), then plan again.`;
}

/** Google Secret Manager as an environment's secret store. */
export async function gcpSecretStore(ctx: CommandContext, project: Project, spec: ProjectSpec, environmentName: string): Promise<EngineSecretStore | { blocked: string }> {
  const context = await resolveEngineContext(ctx, project, spec, environmentName);
  if ('blocked' in context) return context;
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': labelValue(context.environment.id), 'hv-imported': 'true' };
  const observe: EngineSecretStore['observe'] = async (key) => {
    const secretId = engineSecretId(environmentName, key);
    const observed = await observeSecret(await context.adapter.engineAccessToken(), context.gcpProjectId, secretId);
    if (observed.state === 'unknown') return { unknown: observed.reason };
    if (observed.state === 'absent') return { unknown: `Secret container ${secretId} is absent. Run hv_plan and apply its OpenTofu container action first, or continue with hv_launch.` };
    const ownership = observed.value.containerLabels ?? observed.value.labels;
    if (ownership['managed-by'] !== 'hypervibe' || ownership['hv-environment'] !== labels['hv-environment']) {
      return { unknown: `Secret ${secretId} is not owned by this Hypervibe environment.` };
    }
    return observed.value.hasEnabledVersion && observed.value.latestVersion ? 'present' : 'absent';
  };
  // Finish approved container creation before asking the user to paste private values.
  // This also covers explicit key requests, which can bypass the missing-value scan.
  const binding = (context.environment.platformBindings as { engine?: EngineBinding }).engine;
  for (const key of engineOutsideKeys(spec, environmentName, binding?.importedSecrets)) {
    const observed = await observe(key);
    if (typeof observed === 'object') return { blocked: observed.unknown };
  }
  return {
    name: 'Google Secret Manager', observe,
    write: async (key, value) => (await writeSecretVersion(await context.adapter.engineAccessToken(), context.gcpProjectId, engineSecretId(environmentName, key), labels, value))?.message,
  };
}

/** Writes a version only after the approved engine has created the owned container. */
export async function writeSecretVersion(token: string, gcpProjectId: string, secretId: string, labels: Record<string, string>, value: string): Promise<ActionResult | undefined> {
  const observed = await observeSecret(token, gcpProjectId, secretId);
  if (observed.state === 'unknown') return { success: false, status: 'blocked', message: observed.reason };
  if (observed.state === 'absent') return { success: false, status: 'blocked', message: `Secret container ${secretId} is absent. Run hv_plan and apply its OpenTofu container action first.` };
  if (observed.value.labels['managed-by'] !== 'hypervibe' || observed.value.labels['hv-environment'] !== labels['hv-environment']) {
    return { success: false, status: 'blocked', message: `Secret ${secretId} is not owned by this Hypervibe environment.` };
  }
  const environment = new EnvironmentRepository().findById(labels['hv-environment'] ?? '');
  if (!environment) return { success: false, status: 'blocked', message: 'The secret environment cannot be verified locally.' };
  // A lost addVersion acknowledgement must not let an old generation describe a new value.
  const currentBinding = (environment.platformBindings as { engine?: EngineBinding }).engine ?? {};
  new EnvironmentRepository().updatePlatformBindings(environment.id, { engine: { ...currentBinding, secretMetadata: {
    ...currentBinding.secretMetadata, [secretId]: { gcpProjectId, version: observed.value.latestVersion ?? 'pending', labels: observed.value.labels },
  } } });
  let added: Response;
  try {
    added = await secretManagerFetch(token, `https://secretmanager.googleapis.com/v1/projects/${gcpProjectId}/secrets/${secretId}:addVersion`, {
      method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(value).toString('base64') } }),
    });
  } catch {
    return { success: false, status: 'pending', message: `The value write for ${secretId} has an unknown outcome. Run hv_plan again to observe it before retrying.` };
  }
  if (!added.ok) return { success: false, message: `Writing ${secretId} failed (HTTP ${added.status}).`, error: `HTTP ${added.status}` };
  const result = await added.json() as { name?: string };
  const prefix = `${observed.value.resourceName}/versions/`;
  const version = result.name?.startsWith(prefix) ? result.name.slice(prefix.length) : undefined;
  if (!version || !recordSecretVersionMetadata(gcpProjectId, secretId, version, labels)) {
    return { success: false, status: 'pending', message: `The new version of ${secretId} could not be recorded with its credential metadata. Inspect the version before retrying.` };
  }
  return undefined;
}

// ---------------------------------------------------------------- Redis URL (Hypervibe-owned)

/** Publishes REDIS_URL from the instance's private address and Google-generated AUTH string. */
async function ensureCacheCredential(token: string, action: PlanAction): Promise<ActionResult> {
  const { gcpProjectId, region, instanceName, secretId, labels } = action.metadata as { gcpProjectId: string; region: string; instanceName: string; secretId: string; labels: Record<string, string> };
  const base = `https://redis.googleapis.com/v1/projects/${gcpProjectId}/locations/${region}/instances/${instanceName}`;
  const instanceResponse = await fetchWithRetry(base, { headers: { Authorization: `Bearer ${token}` } });
  if (instanceResponse.status === 404) return { success: false, status: 'blocked', message: `Redis instance ${instanceName} does not exist yet.` };
  if (!instanceResponse.ok) return { success: false, status: 'blocked', message: `Memorystore returned HTTP ${instanceResponse.status} for ${instanceName}.` };
  const instance = await instanceResponse.json() as { state?: string; host?: string; port?: number; labels?: Record<string, string> };
  if (instance.state !== 'READY' || !instance.host) return { success: false, status: 'pending', message: `Redis instance ${instanceName} is not ready yet.` };
  if (instance.labels?.['managed-by'] !== 'hypervibe') return { success: false, status: 'blocked', message: `Redis instance ${instanceName} is not managed by Hypervibe.` };
  const authResponse = await fetchWithRetry(`${base}/authString`, { headers: { Authorization: `Bearer ${token}` } });
  if (!authResponse.ok) return { success: false, status: 'blocked', message: `Reading the Redis AUTH string returned HTTP ${authResponse.status}.` };
  const authString = (await authResponse.json() as { authString?: string }).authString;
  if (!authString) return { success: false, status: 'pending', message: `Redis instance ${instanceName} has no AUTH string yet.` };
  const failure = await writeSecretVersion(token, gcpProjectId, secretId, labels, `redis://:${encodeURIComponent(authString)}@${instance.host}:${instance.port ?? 6379}`);
  if (failure) return failure;
  return { success: true, message: `REDIS_URL for ${instanceName} is stored in ${secretId}.` };
}

/** Creates a Cloud Storage HMAC key for the runtime identity and publishes both halves to Secret Manager. */
async function ensureStorageS3Key(token: string, action: PlanAction): Promise<ActionResult> {
  const { gcpProjectId, storageName, runtimeServiceAccountEmail, secretIds, labels } = action.metadata as {
    gcpProjectId: string; storageName: string; runtimeServiceAccountEmail: string; secretIds: Record<string, string>; labels: Record<string, string>;
  };
  for (const secretId of Object.values(secretIds)) {
    const container = await observeSecret(token, gcpProjectId, secretId);
    if (container.state !== 'present' || container.value.labels['managed-by'] !== 'hypervibe' || container.value.labels['hv-environment'] !== labels['hv-environment']) {
      return { success: false, status: 'blocked', message: 'Create the owned S3 credential containers with hv_plan/hv_apply before generating an access key.' };
    }
  }
  let created: Response;
  try {
    created = await fetch(`https://storage.googleapis.com/storage/v1/projects/${gcpProjectId}/hmacKeys?serviceAccountEmail=${encodeURIComponent(runtimeServiceAccountEmail)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { success: false, status: 'pending', message: `Creating the S3 access key for ${storageName} has an unknown outcome. Run the same command again.` };
  }
  if (!created.ok) return { success: false, message: `Cloud Storage could not create an S3 access key (HTTP ${created.status}): ${await googleErrorMessage(created)}` };
  const key = await created.json() as { secret?: string; metadata?: { accessId?: string } };
  if (!key.secret || !key.metadata?.accessId) return { success: false, message: 'Cloud Storage returned an incomplete S3 access key.' };
  for (const [name, value] of [['AWS_ACCESS_KEY_ID', key.metadata.accessId], ['AWS_SECRET_ACCESS_KEY', key.secret]] as const) {
    const failure = await writeSecretVersion(token, gcpProjectId, secretIds[name]!, labels, value);
    if (failure) return failure;
  }
  return { success: true, message: `An S3-compatible access key for ${storageName} is stored in Secret Manager.` };
}

// ---------------------------------------------------------------- Database login lifecycle

async function planDatabaseCredential(params: {
  token: string;
  context: EngineContext;
  environmentName: string;
  instanceName: string;
  databaseSecretId: string;
  labels: Record<string, string>;
  observation: DatabaseCredentialObservation;
  desiredGeneration: number;
  dependsOn: string[];
  servicesUpdating: boolean;
}): Promise<PlanAction[] | { blocked: string }> {
  const { observation } = params;
  const base = {
    id: 'database-credential:postgres',
    resource: { kind: 'secret' as const, name: ENGINE_DATABASE_URL_KEY, provider: 'gcp' },
    verified: true,
  };
  const metadata = (mode: DatabaseCredentialMetadata['mode'], login?: DatabaseLogin): DatabaseCredentialMetadata => ({
    operation: ENGINE_DATABASE_CREDENTIAL_OPERATION, mode, gcpProjectId: params.context.gcpProjectId, instanceName: params.instanceName,
    secretId: params.databaseSecretId, labels: params.labels, databaseName: ENGINE_DATABASE_NAME, generation: params.desiredGeneration,
    ...(login ? { login } : {}),
  });
  if (!observation.ready) {
    return [{ ...base, type: 'create', ...(params.dependsOn.length ? { dependsOn: params.dependsOn } : {}),
      reason: `Hypervibe will create two database logins that take turns, generate their passwords and store the connection URL in Secret Manager (${params.databaseSecretId}). Passwords never enter OpenTofu.`,
      metadata: metadata('initialize') as unknown as Record<string, unknown> }];
  }
  if (observation.retirePending) {
    // Revoke only once every service runs the published version; otherwise wait for the rollout.
    if (params.servicesUpdating) return [];
    const pinned = await pinnedDatabaseVersions(params.token, params.context);
    if ('blocked' in pinned) return pinned;
    if (pinned.versions.some((version) => version !== observation.latestVersion)) return [];
    return [{ ...base, type: 'update',
      reason: `Every service now uses the new database password; Hypervibe will revoke the previous password (${observation.retirePending}).`,
      metadata: metadata('revoke', observation.retirePending) as unknown as Record<string, unknown> }];
  }
  if (observation.generation < params.desiredGeneration) {
    const next = otherLogin(observation.login!);
    return [{ ...base, type: 'update',
      reason: `Hypervibe will rotate the database password with no downtime: set a new password on the idle login (${next}), then move services to it before revoking the old one.`,
      metadata: metadata('rotate', next) as unknown as Record<string, unknown> }];
  }
  return [];
}

/** The DATABASE_URL secret version each bound service currently runs. */
async function pinnedDatabaseVersions(token: string, context: EngineContext): Promise<{ versions: string[] } | { blocked: string }> {
  const versions: string[] = [];
  for (const workload of boundWorkloads(context.environment)) {
    const observed = await cloudRunGet(token, context.gcpProjectId, context.region, workload.resource, workload.kind);
    if (observed.state === 'unknown') return { blocked: observed.reason };
    if (observed.state === 'absent') continue;
    const env = (workloadContainers(workload.kind, observed.value)[0]?.env ?? []) as Array<{ name?: string; valueSource?: { secretKeyRef?: { version?: string } } }>;
    const entry = env.find((item) => item.name === ENGINE_DATABASE_URL_KEY);
    if (entry) versions.push(entry.valueSource?.secretKeyRef?.version ?? 'unknown');
  }
  return { versions };
}

// ---------------------------------------------------------------- Interrupted creates

/** Domains whose reviewed DNS removal an earlier apply attempted but did not complete. */
function unfinishedDomainRemovals(environmentId: string): string[] {
  const runs = new RunRepository();
  const pending = new Map<string, boolean>();
  // Oldest first, so a later successful removal clears an earlier unfinished one.
  for (const run of [...runs.findByEnvironmentId(environmentId, 100)].reverse()) {
    if (run.type !== 'apply') continue;
    const planRunId = (run.plan as { planRunId?: unknown } | undefined)?.planRunId;
    const plan = typeof planRunId === 'string' ? runs.findById(planRunId)?.plan as { actions?: PlanAction[] } | undefined : undefined;
    for (const action of plan?.actions ?? []) {
      if (action.metadata?.operation !== DOMAIN_DNS_REMOVE_OPERATION) continue;
      const done = (run.receipts ?? []).some((receipt) => receipt.step === action.id && receipt.status === 'success');
      pending.set(String(action.metadata.domain), !done);
    }
  }
  return [...pending].filter(([, unfinished]) => unfinished).map(([domain]) => domain);
}

/** Database identity of the most recent engine plan that an apply actually attempted. */
function lastAttemptedDatabaseInstance(environmentId: string): string | undefined {
  const runs = new RunRepository();
  for (const run of runs.findByEnvironmentId(environmentId, 100)) {
    if (run.type !== 'apply') continue;
    const planRunId = (run.plan as { planRunId?: unknown } | undefined)?.planRunId;
    if (typeof planRunId !== 'string') continue;
    const name = (runs.findById(planRunId)?.plan as { engine?: { database?: { instanceName?: unknown } } } | undefined)?.engine?.database?.instanceName;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/**
 * Finds resources the engine is about to create that already exist on Google
 * and carry Hypervibe's ownership evidence (recorded identity plus labels).
 * Anything with the same name but without that evidence blocks the plan.
 */
async function findOwnLeftovers(
  token: string,
  context: EngineContext,
  environmentName: string,
  actions: PlanAction[],
  instanceName: string | undefined,
  storageNames: string[]
): Promise<{ databaseInstance?: string; buckets: string[] } | { blocked: string }> {
  const creating = new Set(actions.filter((action) => action.type === 'create').map((action) => action.id));
  const result: { databaseInstance?: string; buckets: string[] } = { buckets: [] };
  if (instanceName && creating.has('database:postgres')) {
    const response = await sqlAdmin(token, context.gcpProjectId, `instances/${instanceName}`);
    if (response.ok) {
      const instance = await response.json() as { settings?: { userLabels?: Record<string, string> } };
      if (instance.settings?.userLabels?.['managed-by'] !== 'hypervibe') {
        return { blocked: `A Cloud SQL instance named ${instanceName} exists but is not managed by Hypervibe.` };
      }
      result.databaseInstance = instanceName;
    } else if (response.status !== 404) {
      return { blocked: `Cloud SQL returned HTTP ${response.status} while checking ${instanceName}; Hypervibe will not create a possible duplicate.` };
    }
  }
  for (const name of storageNames) {
    if (!creating.has(`storage:${name}`)) continue;
    const bucket = engineBucketName(context.gcpProjectId, environmentName, name);
    const response = await fetchWithRetry(`https://storage.googleapis.com/storage/v1/b/${bucket}`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 404) continue;
    if (!response.ok) return { blocked: `Bucket ${bucket} could not be checked (HTTP ${response.status}); it may belong to someone else.` };
    const labels = (await response.json() as { labels?: Record<string, string> }).labels ?? {};
    if (labels['managed-by'] !== 'hypervibe' || labels['hv-storage'] !== name) return { blocked: `Bucket ${bucket} exists but is not managed by Hypervibe.` };
    result.buckets.push(name);
  }
  return result;
}

// ---------------------------------------------------------------- Plan

export interface InfrastructurePlanResult {
  planRunId: string;
  environmentName: string;
  specRevision: number;
  actions: PlanAction[];
  confirmActions: string[];
  warnings: string[];
}

export async function planInfrastructureEngine(ctx: CommandContext, params: {
  project: Project;
  spec: ProjectSpec;
  specRevision: number;
  environmentName: string;
}): Promise<InfrastructurePlanResult | { blocked: string[]; missingOutsideKeys?: string[] }> {
  const { project, spec, environmentName } = params;
  const environmentSpec = spec.environments[environmentName];
  if (!isEngineManaged(environmentSpec)) return { blocked: [`Environment ${environmentName} is not managed by the OpenTofu engine. Use Cloud Run or select hosting.engine="opentofu" for AWS.`] };
  if (isAwsEngineEnvironment(spec, environmentName)) return planAwsInfrastructureEngine(ctx, params);
  if (isAzureEngineEnvironment(spec, environmentName)) return planAzureInfrastructureEngine(ctx, params);
  const problems = engineEnvironmentProblems(spec, environmentName);
  if (problems.length) return { blocked: problems };
  const context = await resolveEngineContext(ctx, project, spec, environmentName);
  if ('blocked' in context) return { blocked: [context.blocked] };
  if (Object.keys(environmentSpec!.storage ?? {}).length && !isCloudPreparedForStorage(ctx.repos.projects.findById(project.id) ?? project)) {
    return { blocked: [ENGINE_STORAGE_ACCESS_BLOCKER] };
  }
  if (environmentSpec!.cache && !isCloudPreparedForCache(ctx.repos.projects.findById(project.id) ?? project)) {
    return { blocked: [ENGINE_CACHE_ACCESS_BLOCKER] };
  }
  if (Object.values(environmentSpec!.services).some((service) => service.onDemand) && !isCloudPreparedForWorkerWake(ctx.repos.projects.findById(project.id) ?? project)) {
    return { blocked: [ENGINE_WORKER_ACCESS_BLOCKER] };
  }
  if (Object.keys(environmentSpec!.queues ?? {}).length && !isCloudPreparedForQueues(ctx.repos.projects.findById(project.id) ?? project, 'cloudrun')) {
    return { blocked: ['Queues need one more Google Cloud permission for Hypervibe. Approve it with hv_launch approveAccess=["queues"], or run hv_connections provider="cloudrun" action="prepare" queueAccess="lifecycle" (preview, then confirm).'] };
  }

  // Hypervibe-owned secrets: explicit, observed, tri-state.
  const token = await context.adapter.engineAccessToken();
  const desiredKeys = engineSecretKeys(spec, environmentName);
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': labelValue(context.environment.id) };
  const secretActions: PlanAction[] = [];
  const secretVersions: Record<string, string> = {};
  for (const key of desiredKeys) {
    const secretId = engineSecretId(environmentName, key);
    const observed = await observeSecret(token, context.gcpProjectId, secretId);
    if (observed.state === 'unknown') return { blocked: [observed.reason] };
    if (observed.state === 'present' && observed.value.labels['hv-environment'] !== labels['hv-environment']) {
      return { blocked: [`Secret Manager already has ${secretId}, but it is not owned by this Hypervibe environment.`] };
    }
    const ready = observed.state === 'present' && observed.value.hasEnabledVersion;
    if (ready && observed.value.latestVersion) secretVersions[key] = observed.value.latestVersion;
    secretActions.push({
      id: `secret:${key}`,
      type: ready ? 'noop' : observed.state === 'absent' ? 'create' : 'update',
      resource: { kind: 'secret', name: key, provider: 'gcp' },
      verified: true,
      reason: ready ? `Secret ${key} is stored in Secret Manager.` : `Hypervibe will generate ${key} and store it in Secret Manager (${secretId}).`,
      metadata: { operation: ENGINE_SECRET_OPERATION, gcpProjectId: context.gcpProjectId, secretId, labels },
    });
  }
  // Database: OpenTofu owns the instance; Hypervibe owns the login and the URL secret.
  const databaseSpec = environmentSpec!.database;
  const engineBinding = (context.environment.platformBindings as { engine?: EngineBinding }).engine ?? {};
  // Reuse a recorded identity before inventing one: an interrupted create may have succeeded on Google.
  const instanceName = engineBinding.database?.instanceName
    ?? lastAttemptedDatabaseInstance(context.environment.id)
    ?? `hv-${environmentName}-db-${crypto.randomBytes(3).toString('hex')}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const databaseSecretId = engineSecretId(environmentName, ENGINE_DATABASE_URL_KEY);
  let databaseCredential: DatabaseCredentialObservation = { ready: false, generation: 0 };
  if (databaseSpec) {
    const observed = await observeDatabaseCredential(token, context.gcpProjectId, databaseSecretId, instanceName, labels['hv-environment']);
    if ('blocked' in observed) return { blocked: [observed.blocked] };
    databaseCredential = observed;
    if (observed.ready && observed.latestVersion) secretVersions[ENGINE_DATABASE_URL_KEY] = observed.latestVersion;
  }
  const databaseCredentialReady = databaseCredential.ready;
  // Cache: OpenTofu owns the Redis instance; Hypervibe publishes REDIS_URL from Google's generated AUTH string.
  const cacheSpec = environmentSpec!.cache;
  const cacheInstanceName = engineBinding.cache?.instanceName
    ?? `hv-${environmentName}-cache-${crypto.randomBytes(3).toString('hex')}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  const cacheSecretId = engineSecretId(environmentName, ENGINE_CACHE_URL_KEY);
  let cacheReady = false;
  if (cacheSpec) {
    const observed = await observeSecret(token, context.gcpProjectId, cacheSecretId);
    if (observed.state === 'unknown') return { blocked: [observed.reason] };
    if (observed.state === 'present' && observed.value.labels['hv-environment'] !== labels['hv-environment']) {
      return { blocked: [`Secret Manager already has ${cacheSecretId}, but it is not owned by this Hypervibe environment.`] };
    }
    cacheReady = observed.state === 'present' && observed.value.hasEnabledVersion && observed.value.labels['hv-cache-instance'] === cacheInstanceName;
    if (cacheReady && observed.state === 'present' && observed.value.latestVersion) secretVersions[ENGINE_CACHE_URL_KEY] = observed.value.latestVersion;
  }
  // Outside values arrive only after the engine creates their reviewed containers.
  // Migration imports keep their private transfer stage instead of opening a collection page.
  const pendingImportedSecrets = engineBinding.pendingImportedSecrets ?? [];
  const importedSecrets = engineOutsideKeys(spec, environmentName, engineBinding.importedSecrets)
    .filter((key) => !pendingImportedSecrets.includes(key));
  const missingKeys: string[] = [];
  let outsideContainersMissing = false;
  for (const key of importedSecrets) {
    const secretId = engineSecretId(environmentName, key);
    const observed = await observeSecret(token, context.gcpProjectId, secretId);
    if (observed.state === 'unknown') return { blocked: [observed.reason] };
    if (observed.state === 'present') {
      const ownership = observed.value.containerLabels ?? observed.value.labels;
      if (ownership['managed-by'] !== 'hypervibe' || ownership['hv-environment'] !== labels['hv-environment']) {
        return { blocked: [`Secret Manager already has ${secretId}, but its ownership does not match this environment.`] };
      }
    } else outsideContainersMissing = true;
    if (observed.state !== 'present' || !observed.value.hasEnabledVersion || !observed.value.latestVersion) { missingKeys.push(key); continue; }
    secretVersions[key] = observed.value.latestVersion;
  }
  if (missingKeys.length && !outsideContainersMissing) {
    return { blocked: [missingOutsideKeysMessage(environmentName, missingKeys)], missingOutsideKeys: missingKeys };
  }
  // S3-compatible bucket access: Hypervibe-owned access keys, published before services are wired.
  const s3Storage = Object.entries(environmentSpec!.storage ?? {}).filter(([, storage]) => storage.access === 's3').map(([name]) => name);
  const s3Ready: string[] = [];
  const s3SecretIds: string[] = [];
  for (const storageName of s3Storage) {
    let ready = true;
    for (const key of S3_COMPATIBLE_SECRET_KEYS) {
      const secretKey = `${storageName}_${key}`;
      const secretId = engineSecretId(environmentName, secretKey);
      s3SecretIds.push(secretId);
      const observed = await observeSecret(token, context.gcpProjectId, secretId);
      if (observed.state === 'unknown') return { blocked: [observed.reason] };
      if (observed.state === 'present' && observed.value.labels['hv-environment'] !== labels['hv-environment']) {
        return { blocked: [`Secret Manager already has ${secretId}, but it is not owned by this Hypervibe environment.`] };
      }
      if (observed.state === 'present' && observed.value.hasEnabledVersion && observed.value.latestVersion) secretVersions[secretKey] = observed.value.latestVersion;
      else ready = false;
    }
    if (ready) s3Ready.push(storageName);
  }
  const existing = await listEngineSecrets(token, context.gcpProjectId, context.environment.id);
  if (existing.state === 'unknown') return { blocked: [existing.reason] };
  const desiredIds = new Set([...desiredKeys.map((key) => engineSecretId(environmentName, key)), ...(databaseSpec ? [databaseSecretId] : []),
    ...(cacheSpec ? [cacheSecretId] : []), ...s3SecretIds, ...[...importedSecrets, ...pendingImportedSecrets].map((key) => engineSecretId(environmentName, key))]);
  // Legacy owned containers enter engine state in one reviewed import round before retirement.
  const existingIds = existing.state === 'present' ? existing.value : [];
  const untrackedRetired = existingIds.filter((id) => !desiredIds.has(id) && !engineBinding.secrets?.includes(id));
  const retiredSecrets = (engineBinding.secrets ?? []).filter((id) => !desiredIds.has(id));
  const containers: NonNullable<GcpCloudRunEngineInput['secrets']> = [];
  const adoptSecrets: string[] = [];
  for (const secretId of [...new Set([...desiredIds, ...untrackedRetired, ...retiredSecrets])].sort()) {
    const observed = await observeSecret(token, context.gcpProjectId, secretId);
    if (observed.state === 'unknown') return { blocked: [observed.reason] };
    if (observed.state === 'present') {
      const ownership = observed.value.containerLabels ?? observed.value.labels;
      if (ownership['managed-by'] !== 'hypervibe' || ownership['hv-environment'] !== labels['hv-environment']) {
        return { blocked: [`Secret Manager already has ${secretId}, but its ownership does not match this environment.`] };
      }
      if (desiredIds.has(secretId) || untrackedRetired.includes(secretId)) {
        adoptSecrets.push(secretId);
        containers.push({ secretId, labels: ownership });
      }
    } else if (desiredIds.has(secretId)) containers.push({ secretId, labels });
  }
  const anyService = Object.keys(environmentSpec!.services).length > 0;

  // DNS and hosting use separate saved engine stages: proof, claim, traffic, readiness.
  const desiredDomain = environmentSpec!.domain?.trim().toLowerCase().replace(/\.$/, '');
  const domainService = desiredDomain ? domainServiceFor(environmentSpec!) : undefined;
  const domainContext = { adapter: context.adapter, gcpProjectId: context.gcpProjectId, region: context.region,
    ...(domainService ? { serviceName: serviceResourceName(context, environmentName, domainService) } : {}) };
  let domainActions: DomainPlanActions = { before: [], after: [] };
  if (desiredDomain && domainService) {
    if (!environmentSpec!.dns) return { blocked: ['Set environment.dns to the exact DNS provider and zone for this custom domain. Hosting and DNS can use different providers.'] };
    domainActions = await planDomain(domainContext, desiredDomain, environmentSpec!.services[domainService]!.healthCheckPath ?? '/', environmentSpec!.dns.zone.name);
    if (domainActions.blocked) return { blocked: [domainActions.blocked] };
    if (domainActions.mappingPresent) {
      const observed = await observeDomainMapping(domainContext, desiredDomain);
      const ownership = await verifyGcpDomainEngineOwnership(context, desiredDomain, observed);
      if (!ownership.ready) return { blocked: [ownership.reason ?? 'The live domain mapping is not owned by the saved engine state.'] };
    }
    if (!domainActions.ownershipPresent || domainActions.mappingPresent) {
      const prepared = await prepareDnsEnginePlan({ ctx, project, environment: context.environment, environmentSpec: environmentSpec!,
        owner: 'gcp-domain', domain: desiredDomain, records: domainActions.dnsRecords ?? [], retainExistingTypes: ['TXT'] });
      if (prepared.blocked) return { blocked: prepared.blocked };
      if (!prepared.ready) return persistDnsPlanRun(ctx, { project, environment: context.environment, environmentName,
        specRevision: params.specRevision, prepared, source: { kind: 'gcp-domain', environmentName, domain: desiredDomain,
          gcpProjectId: context.gcpProjectId, region: context.region, serviceName: domainContext.serviceName,
          sourceFingerprint: domainActions.sourceFingerprint, remove: false } });
    }
  }
  const ownedDomain = getDnsOwnedDomain(context.environment, 'gcp-domain');
  const retiredDomains = [...new Set([...(engineBinding.domains ?? []), ...(ownedDomain ? [ownedDomain] : []), ...unfinishedDomainRemovals(context.environment.id)])]
    .filter((domain) => domain !== desiredDomain).sort();
  const cancelledDomainProofs: Record<string, { zoneFingerprint: string; connectionId: string }> = {};
  const domainClaims = { ...engineBinding.domainClaims };
  for (const domain of retiredDomains) {
    if (!getDnsBindingIdentity(context.environment)) {
      const selected = engineBinding.domainClaims?.[domain];
      if (!selected) return { blocked: ['The retired domain has no verified engine DNS ownership or saved initial DNS selection. Explicitly adopt its exact DNS records before removing the hosting claim.'] };
      const absence = await verifyDnsTrafficAbsent({ ctx, project, domain, ...selected });
      if (!absence.ready) return { blocked: [absence.reason] };
      cancelledDomainProofs[domain] = absence;
      continue;
    }
    if (!hasOwnedDnsRecords(context.environment, 'gcp-domain')) {
      const selected = getDnsBindingSelection(context.environment)!;
      domainClaims[domain] = selected;
      const absence = await verifyDnsTrafficAbsent({ ctx, project, domain, ...selected });
      if (!absence.ready) return { blocked: [absence.reason] };
      cancelledDomainProofs[domain] = absence;
      continue;
    }
    const mapping = await observeDomainMapping(domainContext, domain);
    if (mapping.state === 'unknown') return { blocked: [mapping.reason] };
    const prepared = await prepareDnsEnginePlan({ ctx, project, environment: context.environment, environmentSpec: environmentSpec!,
      owner: 'gcp-domain', domain, records: [], remove: true });
    if (prepared.blocked) return { blocked: prepared.blocked };
    if (!prepared.ready) return persistDnsPlanRun(ctx, { project, environment: context.environment, environmentName,
      specRevision: params.specRevision, prepared, source: { kind: 'gcp-domain', environmentName, domain,
        gcpProjectId: context.gcpProjectId, region: context.region,
        sourceFingerprint: mapping.state === 'present' ? mapping.sourceFingerprint : 'absent', remove: true } });
  }

  const binary = await ensureEngineBinary();
  if (!binary.ok) return { blocked: [binary.error] };
  const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
  const boundServices = Object.keys((context.environment.platformBindings as { services?: Record<string, unknown> }).services ?? {});
  const configure = (adopt?: { databaseInstance?: string; buckets?: string[] }) => buildCloudRunConfiguration({
    adopt: { ...adopt, secrets: adoptSecrets },
    secrets: containers, retiredSecrets,
    environmentId: context.environment.id,
    ...buildEngineInput(spec, environmentName, {
      ...context, resourceNameFor: (service) => serviceResourceName(context, environmentName, service),
      databaseWired: databaseCredentialReady,
      cacheWired: cacheReady,
      s3WiredStorage: s3Ready,
      importedSecrets,
      secretVersions,
    }),
    retiredServices: boundServices.filter((name) => !environmentSpec!.services[name]),
    ...(databaseSpec ? { database: { instanceName, databaseName: ENGINE_DATABASE_NAME, wireServices: databaseCredentialReady,
      ...(databaseSpec.version ? { majorVersion: databaseSpec.version } : {}) } } : {}),
    ...(!databaseSpec && engineBinding.database ? { retiredDatabase: true } : {}),
    ...(cacheSpec ? { cache: {
      instanceName: cacheInstanceName, tier: (cacheSpec.tier === 'STANDARD_HA' ? 'STANDARD_HA' : 'BASIC') as 'BASIC' | 'STANDARD_HA',
      memorySizeGb: Math.max(1, parseInt(cacheSpec.size ?? '1', 10) || 1),
      network: cacheSpec.network ?? 'default', subnetwork: cacheSpec.subnetwork ?? cacheSpec.network ?? 'default', wireServices: cacheReady,
    } } : {}),
    ...(!cacheSpec && engineBinding.cache ? { retiredCache: true } : {}),
    ...(!releaseCommandFor(environmentSpec!) && engineBinding.releaseJob ? { retiredReleaseJob: true } : {}),
    queues: Object.entries(environmentSpec!.queues ?? {}).map(([name, queue]) => ({
      name, topicId: pubsubQueueResourceIds({ name: environmentName, platformBindings: { projectId: context.gcpProjectId } }, name, context.gcpProjectId).topicId,
      ...(queue.ackDeadlineSeconds ? { ackDeadlineSeconds: queue.ackDeadlineSeconds } : {}),
    })),
    retiredQueues: (engineBinding.queues ?? []).filter((name) => !environmentSpec!.queues?.[name]),
    ...(desiredDomain && domainService ? { domains: [{ domain: desiredDomain, service: domainService }] } : {}),
    ...(retiredDomains.length ? { retiredDomains } : {}),
    runtimeServiceAccountEmail: context.runtimeServiceAccountEmail,
    storage: Object.entries(environmentSpec!.storage ?? {}).map(([name, storage]) => ({
      name, bucketName: engineBucketName(context.gcpProjectId, environmentName, name), location: storage.region, injectInto: storage.injectInto,
      ...(storage.access === 's3' ? { s3: { wired: s3Ready.includes(name) } } : {}),
    })),
    retiredStorage: (engineBinding.storage ?? []).filter((name) => !environmentSpec!.storage?.[name]),
  });
  let configuration = configure();
  let planId = crypto.randomUUID();
  let planned = await engine.plan({ backend: gcpEngineBackend, configuration, auth: context.auth, state: context.state, planId });
  if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
  // A create for something that already exists means engine state lost track of it (for example,
  // an apply interrupted mid-create). Adopt it only with proof it is ours; otherwise block.
  const leftovers = await findOwnLeftovers(token, context, environmentName, planned.actions, databaseSpec ? instanceName : undefined,
    Object.keys(environmentSpec!.storage ?? {}));
  if ('blocked' in leftovers) return { blocked: [leftovers.blocked] };
  if (leftovers.databaseInstance || leftovers.buckets.length) {
    configuration = configure({ ...(leftovers.databaseInstance ? { databaseInstance: leftovers.databaseInstance } : {}), buckets: leftovers.buckets });
    planId = crypto.randomUUID();
    planned = await engine.plan({ backend: gcpEngineBackend, configuration, auth: context.auth, state: context.state, planId });
    if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
  }
  // Queues recorded only in engine state (for example, created before Hypervibe recorded queue
  // bindings) are Hypervibe's own: retire them by their state address, then plan again.
  const strayQueues = [...new Set(planned.unmanagedDeletes
    .map((address) => /^google_pubsub_(?:topic|subscription|topic_iam_member|subscription_iam_member)\.queue_([a-z0-9_]+?)(?:_publisher|_subscriber)?$/.exec(address)?.[1])
    .filter((key): key is string => Boolean(key)))].map((key) => key.replace(/_/g, '-'));
  if (strayQueues.length && planned.unmanagedDeletes.every((address) => address.startsWith('google_pubsub_'))
    && strayQueues.every((name) => !environmentSpec!.queues?.[name])) {
    engineBinding.queues = [...new Set([...(engineBinding.queues ?? []), ...strayQueues])];
    configuration = configure(leftovers.databaseInstance || leftovers.buckets.length ? { ...(leftovers.databaseInstance ? { databaseInstance: leftovers.databaseInstance } : {}), buckets: leftovers.buckets } : undefined);
    planId = crypto.randomUUID();
    planned = await engine.plan({ backend: gcpEngineBackend, configuration, auth: context.auth, state: context.state, planId });
    if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
  }
  if (planned.blockers.length) return { blocked: planned.blockers };

  const domainPrerequisites = domainActions.before.filter((a) => a.type !== 'noop').map((a) => a.id);
  const serviceActions = planned.actions.map((action) => {
    if (action.type !== 'create' && action.type !== 'update' && action.type !== 'replace') return action;
    const extra = action.id.startsWith('domain:') ? domainPrerequisites : [];
    return extra.length ? { ...action, dependsOn: [...(action.dependsOn ?? []), ...extra] } : action;
  });
  const engineDomainAction = desiredDomain ? serviceActions.find((a) => a.id === `domain:${desiredDomain}`) : undefined;
  const domainAfter = (domainActions.mappingPresent ? domainActions.after : []).map((action) => action.type !== 'noop' && engineDomainAction && engineDomainAction.type !== 'noop'
    ? { ...action, dependsOn: [engineDomainAction.id] } : action);
  const forgottenDomains: PlanAction[] = [];
  for (const domain of retiredDomains.filter(name => !serviceActions.some(action => action.id === `domain:${name}` && action.type !== 'noop'))) {
    const observed = await observeDomainMapping(domainContext, domain);
    if (observed.state !== 'absent') return { blocked: [observed.state === 'unknown' ? observed.reason : 'The retired mapping remains present without a corresponding engine removal action. Preserve its state and refresh the plan.'] };
    if (!cancelledDomainProofs[domain]) return { blocked: ['The cancelled domain still needs verified DNS cleanup before its ownership receipt can be retired.'] };
    forgottenDomains.push({ id: `domain-forget:${domain}`, type: 'update', resource: { kind: 'domain', name: domain, provider: 'gcp' }, verified: true,
      reason: 'Confirm the cancelled domain and traffic DNS are absent, then finish cleanup without changing infrastructure.',
      metadata: { operation: 'gcpDomainForget', domain, gcpProjectId: context.gcpProjectId, region: context.region } });
  }
  const secretDependencies = (ids: string[]) => serviceActions.filter((action) => action.type !== 'noop' && ids.includes(action.id.replace(/^secret-container:/, '')) && action.id.startsWith('secret-container:')).map((action) => action.id);
  for (const action of secretActions) {
    const dependencies = secretDependencies([String(action.metadata?.secretId)]);
    if (dependencies.length && action.type !== 'noop') action.dependsOn = dependencies;
  }
  const databaseAction = serviceActions.find((action) => action.id === 'database:postgres');
  const credentialActions = databaseSpec
    ? await planDatabaseCredential({
      token, context, environmentName, instanceName, databaseSecretId, labels, observation: databaseCredential,
      desiredGeneration: databaseSpec.passwordGeneration ?? 1,
      dependsOn: [...(databaseAction && databaseAction.type !== 'noop' ? [databaseAction.id] : []), ...secretDependencies([databaseSecretId])],
      servicesUpdating: serviceActions.some((action) => action.id.startsWith('service:') && action.type !== 'noop'),
    })
    : [];
  if ('blocked' in credentialActions) return { blocked: [credentialActions.blocked] };
  const onDemandWorkers = Object.entries(environmentSpec!.services).filter(([, service]) => service.workloadKind === 'worker' && service.onDemand).map(([name]) => name);
  const wakeUser = context.runtimeServiceAccountEmail ? iamDatabaseUser(context.runtimeServiceAccountEmail) : undefined;
  // A data copy (migration restore) recreates the tables, so a grant older than the copy is gone.
  const copiedAt = engineBinding.migration?.copiedAt;
  const grantStale = engineBinding.workerWakeGrant !== wakeUser
    || Boolean(copiedAt && (!engineBinding.workerWakeGrantAt || engineBinding.workerWakeGrantAt < copiedAt));
  const wakeGrantActions: PlanAction[] = databaseSpec && wakeUser && onDemandWorkers.length && grantStale ? [{
    id: 'worker-wake-grant:postgres', type: 'update', verified: true,
    resource: { kind: 'database', name: 'postgres', provider: 'gcp' },
    reason: `Hypervibe will let the on-demand worker waker read pending work: read-only access to the app's tables for ${wakeUser}.`,
    dependsOn: [databaseAction, ...credentialActions, ...serviceActions.filter((action) => onDemandWorkers.some((name) => action.id === `service:${name}`))]
      .filter((action): action is PlanAction => Boolean(action && action.type !== 'noop')).map((action) => action.id),
    metadata: { operation: ENGINE_WORKER_WAKE_GRANT_OPERATION, gcpProjectId: context.gcpProjectId, instanceName, databaseName: ENGINE_DATABASE_NAME,
      secretId: databaseSecretId, iamUser: wakeUser },
  }] : [];
  const cacheAction = serviceActions.find((action) => action.id === 'cache:redis');
  const s3CredentialActions: PlanAction[] = s3Storage.filter((name) => !s3Ready.includes(name)).map((storageName) => {
    const bucketAction = serviceActions.find((action) => action.id === `storage:${storageName}`);
    return {
      id: `storage-s3-key:${storageName}`, type: 'create', verified: true,
      resource: { kind: 'secret', name: `${storageName} S3 access key`, provider: 'gcp' },
      reason: `Hypervibe will create an S3-compatible access key for the app's runtime identity and store it in Secret Manager, so code written for S3 can use the ${storageName} bucket unchanged.`,
      dependsOn: [...(bucketAction && bucketAction.type !== 'noop' ? [bucketAction.id] : []), ...secretDependencies(S3_COMPATIBLE_SECRET_KEYS.map((key) => engineSecretId(environmentName, `${storageName}_${key}`)))],
      metadata: { operation: ENGINE_STORAGE_S3_KEY_OPERATION, gcpProjectId: context.gcpProjectId, storageName,
        runtimeServiceAccountEmail: context.runtimeServiceAccountEmail,
        secretIds: Object.fromEntries(S3_COMPATIBLE_SECRET_KEYS.map((key) => [key, engineSecretId(environmentName, `${storageName}_${key}`)])),
        labels: { ...labels, 'hv-storage': storageName } },
    };
  });
  const cacheCredentialActions: PlanAction[] = cacheSpec && !cacheReady ? [{
    id: 'cache-credential:redis', type: 'create', verified: true,
    resource: { kind: 'secret', name: ENGINE_CACHE_URL_KEY, provider: 'gcp' },
    reason: `Hypervibe will store the Redis connection URL in Secret Manager (${cacheSecretId}) so services can use it.`,
    dependsOn: [...(cacheAction && cacheAction.type !== 'noop' ? [cacheAction.id] : []), ...secretDependencies([cacheSecretId])],
    metadata: { operation: ENGINE_CACHE_CREDENTIAL_OPERATION, gcpProjectId: context.gcpProjectId, region: context.region,
      instanceName: cacheInstanceName, secretId: cacheSecretId, labels: { ...labels, 'hv-cache-instance': cacheInstanceName } },
  }] : [];
  // The complete engine segment creates containers before operational value writes.
  const actions = [...domainActions.before, ...serviceActions, ...secretActions, ...credentialActions, ...wakeGrantActions, ...cacheCredentialActions, ...s3CredentialActions, ...domainAfter, ...forgottenDomains];
  const warnings = [
    'Infrastructure is planned by OpenTofu. Releasing application code is a separate step: run hv_deploy after this apply.',
    ...(missingKeys.length ? [missingOutsideKeysMessage(environmentName, missingKeys)] : []),
    ...(!anyService ? ['This environment declares no services; any previously created services will be deleted.'] : []),
    ...(cacheSpec && !cacheReady && anyService
      ? ['Services are connected to Redis in the next infrastructure plan, once Hypervibe has published its URL.'] : []),
    ...(databaseSpec && !databaseCredentialReady && anyService
      ? ['Services are connected to the database in the next infrastructure plan, once Hypervibe has created its login. Run hv_plan scope="infrastructure" again after this apply.']
      : []),
  ];
  const observedGenerations = await serviceGenerations(token, context, environmentName);
  if ('blocked' in observedGenerations) return { blocked: [observedGenerations.blocked] };
  const document: PlanRunDocument = {
    kind: 'hv_plan', scope: ENGINE_PLAN_SCOPE, environmentName, specRevision: params.specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings,
    engine: {
      planId, state: context.state, gcpProjectId: context.gcpProjectId, region: context.region,
      observedGenerations: observedGenerations.generations, ...(databaseSpec ? { database: { instanceName } } : {}),
      ...(cacheSpec ? { cache: { instanceName: cacheInstanceName } } : {}),
      domainClaims: { ...domainClaims, ...(desiredDomain && environmentSpec!.dns ? {
        [desiredDomain]: { zone: dnsZoneIdentity(environmentSpec!.dns), connectionScope: environmentSpec!.dns.connectionScope },
      } : {}) }, cancelledDomainProofs,
    },
  } as PlanRunDocument;
  const runRepo = new RunRepository();
  const run = runRepo.create({ projectId: project.id, environmentId: context.environment.id, type: 'plan', plan: document as unknown as Record<string, unknown> });
  runRepo.updateStatus(run.id, 'succeeded');
  return {
    planRunId: run.id,
    environmentName,
    specRevision: params.specRevision,
    actions,
    confirmActions: actions.filter((a) => a.type !== 'noop' && (a.requiresConfirm || a.billable || a.dataBearing)).map((a) => a.id),
    warnings,
  };
}

// ---------------------------------------------------------------- Apply

/** Recheck the originating Google claim before an independently authenticated DNS apply. */
export async function verifyGcpDnsSource(ctx: CommandContext, project: Project, spec: ProjectSpec,
  source: Record<string, unknown>): Promise<{ ready: boolean; reason?: string }> {
  const fail = (reason: string) => ({ ready: false, reason });
  if (typeof source.environmentName !== 'string' || typeof source.domain !== 'string') return fail('The saved Google DNS source is incomplete.');
  const environmentSpec = spec.environments[source.environmentName];
  if (!environmentSpec || source.remove !== (environmentSpec.domain !== source.domain)) return fail('The custom-domain intent changed after review.');
  const context = await resolveEngineContext(ctx, project, spec, source.environmentName);
  if ('blocked' in context) return fail(context.blocked);
  if (source.gcpProjectId !== context.gcpProjectId || source.region !== context.region) return fail('The Google project or region changed after review.');
  const service = domainServiceFor(environmentSpec);
  const domainContext = { adapter: context.adapter, gcpProjectId: context.gcpProjectId, region: context.region,
    ...(!source.remove && service ? { serviceName: serviceResourceName(context, source.environmentName, service) } : {}) };
  if (!source.remove && source.serviceName !== domainContext.serviceName) return fail('The custom-domain service changed after review.');
  const observed = await observeDomainMapping(domainContext, source.domain);
  if (observed.state === 'unknown') return fail(observed.reason);
  const fingerprint = observed.state === 'present' ? observed.sourceFingerprint : 'absent';
  if (fingerprint !== source.sourceFingerprint) return fail('The Google domain mapping changed after DNS planning. Run hv_plan again.');
  if (observed.state === 'present') return verifyGcpDomainEngineOwnership(context, source.domain, observed);
  return { ready: true };
}

export type WorkloadKind = 'services' | 'jobs' | 'workerPools';

/** Bound Cloud Run workloads: services record serviceId, scheduled jobs jobName, workers workerPoolName. */
function boundWorkloads(environment: Environment): Array<{ name: string; kind: WorkloadKind; resource: string }> {
  const bound = (environment.platformBindings as { services?: Record<string, { serviceId?: string; jobName?: string; workerPoolName?: string }> }).services ?? {};
  const workloads: Array<{ name: string; kind: WorkloadKind; resource: string }> = [];
  for (const [name, binding] of Object.entries(bound)) {
    if (binding.serviceId) workloads.push({ name, kind: 'services', resource: binding.serviceId });
    else if (binding.jobName) workloads.push({ name, kind: 'jobs', resource: binding.jobName });
    else if (binding.workerPoolName) workloads.push({ name, kind: 'workerPools', resource: binding.workerPoolName });
  }
  return workloads;
}

/** The single container of a service, or of a job's task template. */
function workloadContainers(kind: WorkloadKind, value: Record<string, any>): Array<Record<string, any>> {
  const containers = kind === 'jobs' ? value.template?.template?.containers : value.template?.containers;
  return Array.isArray(containers) ? containers : [];
}

async function cloudRunGet(token: string, gcpProjectId: string, region: string, name: string, kind: WorkloadKind = 'services'): Promise<Observed<Record<string, any>>> {
  const response = await fetchWithRetry(`https://run.googleapis.com/v2/projects/${gcpProjectId}/locations/${region}/${kind}/${name}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return { state: 'absent' };
  if (!response.ok) return { state: 'unknown', reason: `Cloud Run returned HTTP ${response.status} for ${name}.` };
  return { state: 'present', value: await response.json() as Record<string, any> };
}

/**
 * Cloud Run generation of every bound service. A saved plan carries the
 * values it read at plan time (including the running image), so applying it
 * after any other write, such as a release, could roll that write back.
 */
async function serviceGenerations(token: string, context: EngineContext, environmentName: string): Promise<{ generations: Record<string, string> } | { blocked: string }> {
  void environmentName;
  const generations: Record<string, string> = {};
  for (const workload of boundWorkloads(context.environment)) {
    const observed = await cloudRunGet(token, context.gcpProjectId, context.region, workload.resource, workload.kind);
    if (observed.state === 'unknown') return { blocked: observed.reason };
    generations[workload.name] = observed.state === 'present' ? String(observed.value.generation ?? '') : 'absent';
  }
  return { generations };
}

export async function applyInfrastructureEngine(ctx: CommandContext, params: {
  project: Project;
  spec: ProjectSpec;
  specRevision: number;
  planId: string;
  confirmActions: string[];
}): Promise<{ kind: 'executed'; envName: string; result: ConvergeResult } | { kind: 'blocked'; reason: string }> {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { kind: 'blocked', reason: loaded.error };
  // AWS plans carry their target; a teardown's snapshot cleanup runs after the environment left the spec.
  if ((loaded.document as { engine?: { azure?: unknown } }).engine?.azure) return applyAzureInfrastructureEngine(ctx, params);
  if ((loaded.document as { engine?: { aws?: unknown } }).engine?.aws || isAwsEngineEnvironment(params.spec, (loaded.document as PlanRunDocument).environmentName)) return applyAwsInfrastructureEngine(ctx, params);
  const document = loaded.document as PlanRunDocument & { engine?: { planId: string; state: EngineStateIdentity; gcpProjectId: string; region: string; observedGenerations?: Record<string, string>; database?: { instanceName: string }; cache?: { instanceName: string };
    domainClaims?: EngineBinding['domainClaims']; cancelledDomainProofs?: Record<string, { zoneFingerprint: string; connectionId: string }> } };
  const environmentName = document.environmentName;
  if (!document.engine || !isEngineManaged(params.spec.environments[environmentName])) {
    return { kind: 'blocked', reason: 'This plan is not an OpenTofu engine plan for an engine-managed environment. Re-run hv_plan.' };
  }
  const context = await resolveEngineContext(ctx, params.project, params.spec, environmentName);
  if ('blocked' in context) return { kind: 'blocked', reason: context.blocked };
  const reviewed = document.engine;
  if (JSON.stringify(reviewed.state) !== JSON.stringify(context.state) || reviewed.gcpProjectId !== context.gcpProjectId || reviewed.region !== context.region) {
    return { kind: 'blocked', reason: 'The reviewed plan targets a different environment, GCP project or region. Re-run hv_plan.' };
  }
  const binary = await ensureEngineBinary();
  if (!binary.ok) return { kind: 'blocked', reason: binary.error };
  const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
  const token = await context.adapter.engineAccessToken();

  const result = await executor.execute({
    planRunId: params.planId,
    currentSpecRevision: params.specRevision,
    confirmActions: params.confirmActions,
    handler: async (action) => {
      const operation = action.metadata?.operation;
      const metadata = action.metadata as { gcpProjectId?: string } | undefined;
      if (metadata?.gcpProjectId !== context.gcpProjectId) return { success: false, status: 'blocked', message: 'Secret target changed; re-run hv_plan.' };
      if (operation === 'gcpDomainForget') {
        const domain = typeof action.metadata?.domain === 'string' ? action.metadata.domain : '';
        const selected = reviewed.domainClaims?.[domain];
        const expected = reviewed.cancelledDomainProofs?.[domain];
        const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
        if (!selected || !expected || hasOwnedDnsRecords(current, 'gcp-domain')) return { success: false, status: 'blocked', message: 'The cancelled domain still needs exact DNS cleanup evidence.' };
        const observed = await observeDomainMapping({ adapter: context.adapter, gcpProjectId: context.gcpProjectId, region: context.region }, domain);
        if (observed.state !== 'absent') return { success: false, status: 'blocked', message: 'The cancelled mapping is present or unknown. Its ownership is retained.' };
        const absence = await verifyDnsTrafficAbsent({ ctx, project: params.project, domain, ...selected, expected });
        if (!absence.ready) return { success: false, status: 'blocked', message: absence.reason };
        const saved = (current.platformBindings as { engine?: EngineBinding }).engine ?? {};
        const claims = { ...saved.domainClaims }; delete claims[domain];
        ctx.repos.environments.updatePlatformBindings(current.id, { engine: { ...saved, domains: (saved.domains ?? []).filter(value => value !== domain), domainClaims: claims } });
        return { success: true, message: 'Verified the cancelled domain is absent and finished its cleanup.' };
      }
      if (operation === ENGINE_SECRET_OPERATION) return ensureSecret(token, action);
      if (operation === 'gcpSecretManagerDelete') return { success: false, status: 'blocked', message: 'Secret containers are managed by OpenTofu. Run hv_plan again.' };
      if (typeof operation === 'string' && DOMAIN_OPERATIONS.has(operation)) {
        const result = await executeDomainAction({ adapter: context.adapter, gcpProjectId: context.gcpProjectId, region: context.region }, action);
        if (operation === DOMAIN_DNS_REMOVE_OPERATION && result.success) {
          const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
          const binding = (current.platformBindings as { engine?: EngineBinding }).engine ?? {};
          const domain = (action.metadata as { domain: string }).domain;
          ctx.repos.environments.updatePlatformBindings(current.id, {
            engine: { ...binding, kind: 'opentofu', domains: (binding.domains ?? []).filter((entry) => entry !== domain) },
          });
        }
        return result;
      }
      if (operation === ENGINE_CACHE_CREDENTIAL_OPERATION) return ensureCacheCredential(token, action);
      if (operation === ENGINE_STORAGE_S3_KEY_OPERATION) return ensureStorageS3Key(token, action);
      if (operation === ENGINE_DATABASE_CREDENTIAL_OPERATION) {
        if ((action.metadata as { instanceName?: string }).instanceName !== reviewed.database?.instanceName) {
          return { success: false, status: 'blocked', message: 'Database target changed; re-run hv_plan.' };
        }
        return executeDatabaseCredential(token, JSON.parse(context.adapter.engineConnection().credentials) as Record<string, unknown>, action);
      }
      if (operation === ENGINE_WORKER_WAKE_GRANT_OPERATION) {
        if ((action.metadata as { instanceName?: string }).instanceName !== reviewed.database?.instanceName) {
          return { success: false, status: 'blocked', message: 'Database target changed; re-run hv_plan.' };
        }
        const granted = await grantWorkerWakeRead(token, JSON.parse(context.adapter.engineConnection().credentials) as Record<string, unknown>, action);
        if (granted.success) {
          const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
          const binding = (current.platformBindings as { engine?: EngineBinding }).engine ?? {};
          ctx.repos.environments.updatePlatformBindings(current.id, { engine: { ...binding, kind: 'opentofu', workerWakeGrant: (action.metadata as { iamUser: string }).iamUser, workerWakeGrantAt: new Date().toISOString() } });
        }
        return granted;
      }
      return { success: false, status: 'blocked', message: `No engine-stage authority exists for ${action.id}.` };
    },
    segmentHandler: async (segment, members) => {
      const addresses = [...new Set(members.flatMap((member) => engineSegmentOf(member)?.addresses ?? []))];
      const current = await serviceGenerations(token, context, environmentName);
      if ('blocked' in current || JSON.stringify(current.generations) !== JSON.stringify(reviewed.observedGenerations ?? {})) {
        return {
          outcomes: Object.fromEntries(addresses.map((address) => [address, 'not_started' as const])),
          diagnostics: ['blocked' in current ? current.blocked : 'A service changed since this plan (for example, a release). Nothing was applied; re-run hv_plan so the new state is kept.'],
        };
      }
      for (const member of members.filter(action => action.id.startsWith('domain:'))) {
        const domain = member.resource.name;
        const observed = await observeDomainMapping({ adapter: context.adapter, gcpProjectId: context.gcpProjectId, region: context.region }, domain);
        const stop = (reason: string) => ({ outcomes: Object.fromEntries(addresses.map(address => [address, 'not_started' as const])), diagnostics: [reason] });
        if (observed.state === 'unknown') return stop(observed.reason);
        if (member.type === 'create' && observed.state !== 'absent') return stop('A domain mapping appeared after review. No creation or adoption is authorized.');
        if (observed.state === 'present') {
          const ownership = await verifyGcpDomainEngineOwnership(context, domain, observed);
          if (!ownership.ready) return stop(ownership.reason ?? 'The exact mapping is not owned by this engine state.');
        }
        if (member.type === 'destroy') {
          const selected = reviewed.domainClaims?.[domain] ?? getDnsBindingSelection(context.environment);
          const expected = reviewed.cancelledDomainProofs?.[domain];
          if (!selected || !expected) return stop('Domain removal needs reviewed native and public DNS absence. Run hv_plan again.');
          const absence = await verifyDnsTrafficAbsent({ ctx, project: params.project, domain, ...selected, expected });
          if (!absence.ready) return stop(absence.reason);
        }
      }
      const attemptingDomains = members.filter(member => member.id.startsWith('domain:') && member.type !== 'destroy').map(member => member.resource.name);
      if (attemptingDomains.length) {
        const environment = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
        const saved = (environment.platformBindings as { engine?: EngineBinding }).engine ?? {};
        ctx.repos.environments.updatePlatformBindings(environment.id, { engine: { ...saved, kind: 'opentofu',
          domains: [...new Set([...(saved.domains ?? []), ...attemptingDomains])],
          domainClaims: { ...saved.domainClaims, ...reviewed.domainClaims } } });
      }
      for (const member of members.filter((entry) => entry.id.startsWith('secret-container:'))) {
        const observed = await observeSecret(token, context.gcpProjectId, member.resource.name);
        const changed = observed.state === 'unknown'
          || (observed.state === 'present' && (member.type === 'create' || observed.value.labels['managed-by'] !== 'hypervibe' || observed.value.labels['hv-environment'] !== labelValue(context.environment.id)))
          || (observed.state === 'absent' && member.type !== 'create' && member.type !== 'destroy');
        if (changed) return { outcomes: Object.fromEntries(addresses.map((address) => [address, 'not_started' as const])), diagnostics: [`Secret container ${member.resource.name} changed identity or ownership after planning. Run hv_plan again.`] };
      }
      // Record the attempted database identity first, so an interrupted create is found, not duplicated.
      if (reviewed.cache?.instanceName && members.some((member) => member.id === 'cache:redis' && member.type !== 'destroy')) {
        const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
        const engineBinding = (current.platformBindings as { engine?: EngineBinding }).engine ?? {};
        ctx.repos.environments.updatePlatformBindings(current.id, { engine: { ...engineBinding, kind: 'opentofu', cache: { instanceName: reviewed.cache.instanceName } } });
      }
      if (reviewed.database?.instanceName && members.some((member) => member.id === 'database:postgres' && member.type !== 'destroy')) {
        const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
        const engineBinding = (current.platformBindings as { engine?: EngineBinding }).engine ?? {};
        ctx.repos.environments.updatePlatformBindings(current.id, {
          engine: { ...engineBinding, kind: 'opentofu', database: { instanceName: reviewed.database.instanceName } },
        });
      }
      const secretMembers = members.filter((member) => member.id.startsWith('secret-container:') && member.type !== 'destroy');
      if (secretMembers.length) {
        const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
        const binding = (current.platformBindings as { engine?: EngineBinding }).engine ?? {};
        const secretMetadata = { ...binding.secretMetadata };
        // A provider-confirmed absent container has no surviving versions to describe.
        for (const member of secretMembers) if (member.type === 'create') delete secretMetadata[member.resource.name];
        ctx.repos.environments.updatePlatformBindings(current.id, { engine: { ...binding, secretMetadata,
          secrets: [...new Set([...(binding.secrets ?? []), ...secretMembers.map((member) => member.resource.name)])].sort() } });
      }
      const outcome = await engine.apply({
        backend: gcpEngineBackend, auth: context.auth, state: context.state, planId: reviewed.planId,
        segment: { ...segment, addresses }, approvedAddresses: addresses,
      });
      await recordServiceBindings(ctx, context, environmentName, members, outcome.outcomes, token, reviewed.database?.instanceName);
      return { ...outcome, diagnostics: outcome.diagnostics.map((line) => redactEngineOutput(line, context.auth.redact)) };
    },
  });
  return { kind: 'executed', envName: environmentName, result };
}

async function recordServiceBindings(
  ctx: CommandContext,
  context: EngineContext,
  environmentName: string,
  members: PlanAction[],
  outcomes: Record<string, string>,
  token: string,
  databaseInstanceName?: string
): Promise<void> {
  const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
  const services = { ...((current.platformBindings as { services?: Record<string, Record<string, unknown>> }).services ?? {}) };
  let engine: EngineBinding = { ...((current.platformBindings as { engine?: EngineBinding }).engine ?? {}), kind: 'opentofu' };
  for (const member of members) {
    const addresses = engineSegmentOf(member)?.addresses ?? [];
    if (!addresses.every((address) => outcomes[address] === 'succeeded')) continue;
    if (member.id.startsWith('secret-container:')) {
      const remaining = (engine.secrets ?? []).filter((id) => id !== member.resource.name);
      const secretMetadata = { ...engine.secretMetadata };
      if (member.type === 'destroy') delete secretMetadata[member.resource.name];
      engine = { ...engine, secretMetadata, secrets: member.type === 'destroy' ? remaining : [...remaining, member.resource.name].sort() };
      continue;
    }
    if (member.id.startsWith('queue:')) {
      const remaining = (engine.queues ?? []).filter((entry) => entry !== member.resource.name);
      engine = { ...engine, queues: member.type === 'destroy' ? remaining : [...remaining, member.resource.name].sort() };
      continue;
    }
    if (member.id.startsWith('storage:')) {
      const remaining = (engine.storage ?? []).filter((entry) => entry !== member.resource.name);
      engine = { ...engine, storage: member.type === 'destroy' ? remaining : [...remaining, member.resource.name].sort() };
      continue;
    }
    if (member.id.startsWith('domain:')) {
      const domain = member.resource.name;
      const remaining = (engine.domains ?? []).filter((entry) => entry !== domain);
      // Planning removes and verifies owned DNS before releasing a hosting claim.
      engine = { ...engine, domains: member.type === 'destroy' ? remaining : [...remaining, domain].sort() };
      if (member.type === 'destroy') {
        const claims = { ...engine.domainClaims }; delete claims[domain];
        engine.domainClaims = claims;
      }
      continue;
    }
    if (member.id === 'release-job:migrations') {
      engine = member.type === 'destroy' ? { ...engine, releaseJob: undefined } : { ...engine, releaseJob: serviceResourceName(context, environmentName, 'release-command') };
      continue;
    }
    if (member.id === 'cache:redis') {
      if (member.type === 'destroy') engine = { ...engine, cache: undefined };
      continue;
    }
    if (member.id === 'database:postgres') {
      engine = member.type === 'destroy' ? { ...engine, database: undefined } : { ...engine, database: { instanceName: databaseInstanceName! } };
      continue;
    }
    const name = member.resource.name;
    if (member.type === 'destroy') {
      delete services[name];
      continue;
    }
    const resource = serviceResourceName(context, environmentName, name);
    if (addresses.some((address) => address.startsWith('google_cloud_run_v2_job.'))) {
      services[name] = { jobName: resource };
      continue;
    }
    if (addresses.some((address) => address.startsWith('google_cloud_run_v2_worker_pool.'))) {
      services[name] = { workerPoolName: resource };
      continue;
    }
    // A change to only a workload's companions (for example a worker's waker) keeps its binding.
    if (!addresses.some((address) => address.startsWith('google_cloud_run_v2_service.'))) continue;
    const observed = await cloudRunGet(token, context.gcpProjectId, context.region, resource);
    services[name] = {
      serviceId: resource,
      ...(observed.state === 'present' && typeof observed.value.uri === 'string' ? { url: observed.value.uri } : {}),
    };
  }
  ctx.repos.environments.updatePlatformBindings(current.id, {
    provider: 'cloudrun',
    projectId: context.gcpProjectId,
    environmentId: context.region,
    region: context.region,
    engine: JSON.parse(JSON.stringify(engine)) as EngineBinding,
    services,
  });
}

// ---------------------------------------------------------------- Release (image only)

export interface EngineReleaseResult {
  service: string;
  status: 'released' | 'failed' | 'unknown';
  imageUri?: string;
  url?: string;
  health?: { status: number; path: string };
  message: string;
  buildLogsUrl?: string;
}

/**
 * Releases application code to engine-managed services. Builds an immutable
 * image and changes only the running image, guarded by the service etag so a
 * concurrent infrastructure apply cannot be overwritten. Never creates
 * infrastructure: a missing service stops the release.
 */
export async function releaseEngineServices(ctx: CommandContext, params: {
  project: Project;
  spec: ProjectSpec;
  environmentName: string;
  specRevision: number;
  services?: string[];
  revision?: string;
  /** Local repository root; when present, the exact HEAD commit is built without any git credentials. */
  sourceDirectory?: string;
}): Promise<{ results: EngineReleaseResult[]; applyRunId: string; source?: ReleaseSource['summary'] } | { blocked: string }> {
  const { spec, environmentName } = params;
  const environmentSpec = spec.environments[environmentName];
  if (!isEngineManaged(environmentSpec)) return { blocked: 'Environment is not managed by the OpenTofu engine.' };
  if (isAwsEngineEnvironment(spec, environmentName)) {
    const { releaseAwsEngineServices } = await import('./infrastructure-engine-aws-release.js');
    return releaseAwsEngineServices(ctx, params);
  }
  if (isAzureEngineEnvironment(spec, environmentName)) {
    const { releaseAzureEngineServices } = await import('./infrastructure-engine-azure-release.js');
    return releaseAzureEngineServices(ctx, params);
  }
  const context = await resolveEngineContext(ctx, params.project, spec, environmentName);
  if ('blocked' in context) return { blocked: context.blocked };
  const source = await resolveReleaseSource(params);
  if ('blocked' in source) return source;
  // The engine runs every background worker as a worker pool; repair a binding recorded as a service.
  const stale = boundWorkloads(context.environment).filter((workload) => workload.kind === 'services' && environmentSpec!.services[workload.name]?.workloadKind === 'worker');
  if (stale.length) {
    const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
    const services = { ...((current.platformBindings as { services?: Record<string, Record<string, unknown>> }).services ?? {}) };
    for (const workload of stale) services[workload.name] = { workerPoolName: workload.resource };
    ctx.repos.environments.updatePlatformBindings(current.id, { services });
    context.environment = ctx.repos.environments.findById(current.id) ?? context.environment;
  }
  const workloads = new Map(boundWorkloads(context.environment).map((workload) => [workload.name, workload]));
  const selected = params.services?.length ? params.services : Object.keys(environmentSpec!.services);
  const missing = selected.filter((name) => !environmentSpec!.services[name] || !workloads.get(name));
  if (missing.length) return { blocked: `Create the infrastructure first: ${missing.join(', ')} has no engine-managed service. Run hv_plan scope="infrastructure" and hv_apply.` };

  // A release is a recorded plan run executed under the same per-environment
  // lock as infrastructure applies, so the two can never interleave.
  const releaseCommand = releaseCommandFor(environmentSpec!);
  const releaseJob = (context.environment.platformBindings as { engine?: EngineBinding }).engine?.releaseJob;
  if (releaseCommand && !releaseJob) return { blocked: 'The release-command job does not exist yet. Run hv_plan scope="infrastructure" and hv_apply first.' };
  const primaryService = selected.find((name) => environmentSpec!.services[name]?.workloadKind === 'web' || environmentSpec!.services[name]?.workloadKind === undefined) ?? selected[0]!;
  const actions: PlanAction[] = [
    ...(releaseCommand ? [{
      id: 'release-command:migrations', type: 'update' as const, verified: true,
      resource: { kind: 'service' as const, name: primaryService, provider: 'gcp' },
      reason: `Run the release command (${releaseCommand}) with the new code before any service switches.`,
      metadata: { operation: ENGINE_RELEASE_OPERATION, gcpProjectId: context.gcpProjectId, resource: releaseJob, workloadKind: 'release-command' },
    }] : []),
    ...selected.map((name): PlanAction => ({
    id: `release:${name}`,
    type: 'update',
    resource: { kind: 'service', name, provider: 'gcp' },
    verified: true,
    reason: `Build ${params.revision ?? 'main'} and release it to ${name}; only the running image changes.`,
    metadata: { operation: ENGINE_RELEASE_OPERATION, gcpProjectId: context.gcpProjectId, resource: workloads.get(name)!.resource, workloadKind: workloads.get(name)!.kind },
    ...(releaseCommand ? { dependsOn: ['release-command:migrations'] } : {}),
  }))];
  const document = {
    kind: 'hv_plan', scope: ENGINE_PLAN_SCOPE, environmentName, specRevision: params.specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings: [],
    engine: { planId: `release-${crypto.randomUUID()}`, release: true },
  } as PlanRunDocument;
  const runRepo = new RunRepository();
  const planRun = runRepo.create({ projectId: params.project.id, environmentId: context.environment.id, type: 'plan', plan: document as unknown as Record<string, unknown> });
  runRepo.updateStatus(planRun.id, 'succeeded');

  const results: EngineReleaseResult[] = [];
  const builtImages = new Map<string, { imageUri: string; logsUrl?: string }>();
  const execution = await new ConvergeExecutor().execute({
    planRunId: planRun.id,
    currentSpecRevision: params.specRevision,
    handler: async (action) => {
      const name = action.resource.name;
      if (action.metadata?.workloadKind === 'release-command') {
        const outcome = await runReleaseCommand(context, params.project, spec, environmentName, name, String(action.metadata.resource), source, builtImages);
        if (outcome.status !== 'released') results.push({ service: 'release command', ...outcome });
        return outcome.status === 'released'
          ? { success: true, message: outcome.message }
          : { success: false, ...(outcome.status === 'unknown' ? { status: 'pending' as const } : {}), message: outcome.message, error: outcome.message };
      }
      const result = await releaseOne(context, params.project, spec, environmentName, name, String(action.metadata?.resource), source,
        (['jobs', 'workerPools'] as const).find((kind) => kind === action.metadata?.workloadKind) ?? 'services', builtImages);
      results.push(result);
      const data = { ...(result.imageUri ? { imageUri: result.imageUri } : {}), ...(result.url ? { url: result.url } : {}), ...(result.health ? { health: result.health } : {}) };
      if (result.status === 'released') return { success: true, message: result.message, data };
      if (result.status === 'unknown') return { success: false, status: 'pending', message: result.message, data };
      return { success: false, message: result.message, error: result.message, data };
    },
  });
  if (!execution.applyRunId) return { blocked: execution.error ?? 'The release could not start.' };
  // Services skipped after an earlier failure were not released; never let
  // callers mistake an absent result for success.
  for (const name of selected) {
    if (!results.some((result) => result.service === name)) {
      results.push({ service: name, status: 'failed', message: `${name} was not released because an earlier release step did not finish. ${execution.error ?? ''}`.trim() });
    }
  }
  return { results, applyRunId: execution.applyRunId, source: source.summary };
}

interface ReleaseSource {
  archive?: Buffer;
  repoUrl?: string;
  summary: { kind: 'local-commit' | 'git-remote'; revision: string; commitSha?: string; uncommittedChangesExcluded?: boolean };
}

/**
 * Prefers the user's local repository: the exact HEAD commit is archived and
 * uploaded, so private repositories and unpushed commits deploy without any
 * git credentials. Falls back to cloning a public remote.
 */
async function resolveReleaseSource(params: { project: Project; spec: ProjectSpec; revision?: string; sourceDirectory?: string }): Promise<ReleaseSource | { blocked: string }> {
  if (params.sourceDirectory) {
    try {
      const git = async (args: string[]) => String((await execFileAsync('git', ['-C', params.sourceDirectory!, ...args])).stdout);
      const commitSha = (await git(['rev-parse', 'HEAD'])).trim();
      if (/^[0-9a-f]{40}$/.test(commitSha)) {
        const archive = (await execFileAsync('git', ['-C', params.sourceDirectory, 'archive', '--format=tar.gz', commitSha], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 })).stdout as Buffer;
        const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).trim().length > 0;
        return { archive, summary: { kind: 'local-commit', revision: commitSha, commitSha, ...(dirty ? { uncommittedChangesExcluded: true } : {}) } };
      }
    } catch {
      // Not a usable git checkout; fall back to the remote.
    }
  }
  const repoUrl = normalizeGitRemoteForBuild(params.project.gitRemoteUrl ?? params.spec.gitRemoteUrl);
  if (!repoUrl) return { blocked: 'Hypervibe needs either this project\'s local git repository or a git remote to build from.' };
  return { repoUrl, summary: { kind: 'git-remote', revision: params.revision ?? 'main' } };
}

/** Builds (or reuses) the digest-pinned image for one service from the release source. */
async function buildServiceImage(
  context: EngineContext, project: Project, spec: ProjectSpec, environmentName: string, name: string,
  source: ReleaseSource, builtImages: Map<string, { imageUri: string; logsUrl?: string }>
): Promise<{ success: true; imageUri: string; logsUrl?: string } | { success: false; error: string; logsUrl?: string }> {
  const cached = builtImages.get(name);
  if (cached) return { success: true, ...cached };
  const serviceSpec = spec.environments[environmentName]!.services[name]!;
  const now = new Date();
  const service: Service = {
    id: `engine-release:${name}`, projectId: project.id, name, envVarSpec: {}, createdAt: now, updatedAt: now,
    buildConfig: {
      workloadKind: serviceSpec.workloadKind,
      ...(serviceSpec.startCommand ? { startCommand: serviceSpec.startCommand } : {}),
      ...(spec.runtime ? { runtime: spec.runtime as ProjectRuntime } : {}),
    },
  };
  const build = source.archive
    ? await context.adapter.buildReleaseImageFromArchive(service, context.environment, { archive: source.archive, commitSha: source.summary.commitSha!, bucket: buildSourceBucketName(context.gcpProjectId) })
    : await context.adapter.buildReleaseImage(service, context.environment, { repoUrl: source.repoUrl!, revision: source.summary.revision });
  if (!build.success || !build.imageUri || !/@sha256:[0-9a-f]{64}$/.test(build.imageUri)) {
    return { success: false, error: build.error ?? 'The build did not produce a digest-pinned image.', ...(build.logsUrl ? { logsUrl: build.logsUrl } : {}) };
  }
  const built = { imageUri: build.imageUri, ...(build.logsUrl ? { logsUrl: build.logsUrl } : {}) };
  builtImages.set(name, built);
  return { success: true, ...built };
}

/**
 * Runs the reviewed release command in its job with the new image and waits for
 * the execution. Services switch only after it succeeds.
 */
async function runReleaseCommand(
  context: EngineContext, project: Project, spec: ProjectSpec, environmentName: string, primaryService: string,
  job: string, source: ReleaseSource, builtImages: Map<string, { imageUri: string; logsUrl?: string }>
): Promise<Pick<EngineReleaseResult, 'status' | 'message'>> {
  const build = await buildServiceImage(context, project, spec, environmentName, primaryService, source, builtImages);
  if (!build.success) return { status: 'failed', message: build.error };
  const token = await context.adapter.engineAccessToken();
  const updated = await releaseJobImage(token, context, job, build.imageUri);
  if (updated.status !== 'released') return updated;
  const url = `https://run.googleapis.com/v2/projects/${context.gcpProjectId}/locations/${context.region}/jobs/${job}:run`;
  let started: Response;
  try {
    started = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  } catch {
    return { status: 'unknown', message: 'Starting the release command had an unknown outcome. Check hv_logs before retrying.' };
  }
  if (!started.ok) return { status: 'failed', message: `The release command could not start (HTTP ${started.status}): ${await googleErrorMessage(started)}` };
  let operation = await started.json() as { name?: string; done?: boolean; error?: { message?: string }; response?: { succeededCount?: number; failedCount?: number } };
  const deadline = Date.now() + 30 * 60 * 1000;
  while (!operation.done && operation.name && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const polled = await fetchWithRetry(`https://run.googleapis.com/v2/${operation.name}`, { headers: { Authorization: `Bearer ${await context.adapter.engineAccessToken()}` } });
    if (polled.ok) operation = await polled.json() as typeof operation;
  }
  if (!operation.done) return { status: 'unknown', message: 'The release command is still running. Check hv_logs, then run hv_deploy again.' };
  if (operation.error || (operation.response?.failedCount ?? 0) > 0) {
    return { status: 'failed', message: `The release command failed: ${operation.error?.message ?? 'see hv_logs for the job output'}. No service was switched.` };
  }
  return { status: 'released', message: 'The release command finished successfully.' };
}

async function releaseOne(
  context: EngineContext,
  project: Project,
  spec: ProjectSpec,
  environmentName: string,
  name: string,
  resource: string,
  source: ReleaseSource,
  kind: WorkloadKind = 'services',
  builtImages: Map<string, { imageUri: string; logsUrl?: string }> = new Map()
): Promise<EngineReleaseResult> {
  const serviceSpec = spec.environments[environmentName]!.services[name]!;
  const build = await buildServiceImage(context, project, spec, environmentName, name, source, builtImages);
  if (!build.success) return { service: name, status: 'failed', message: build.error, ...(build.logsUrl ? { buildLogsUrl: build.logsUrl } : {}) };
  const released = await releaseImage(await context.adapter.engineAccessToken(), context, resource, build.imageUri, kind);
  const result: EngineReleaseResult = { service: name, imageUri: build.imageUri, ...(build.logsUrl ? { buildLogsUrl: build.logsUrl } : {}), ...released };
  if (released.status === 'released' && released.url && serviceSpec.workloadKind !== 'worker') {
    const path = serviceSpec.healthCheckPath ?? '/';
    try {
      const response = await fetchWithRetry(new URL(path, released.url), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      result.health = { status: response.status, path };
      if (response.status >= 500) {
        result.status = 'failed';
        result.message = `The new release is serving, but ${path} returned HTTP ${response.status}.`;
      }
    } catch {
      result.health = { status: 0, path };
      result.status = 'unknown';
      result.message = `The new release is ready, but ${path} could not be reached to verify health.`;
    }
  }
  return result;
}

/** Google's error message (never request content), bounded for display. */
async function googleErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return (body.error?.message ?? 'no details').slice(0, 300);
  } catch {
    return 'no details';
  }
}

/** Image-only, etag-guarded update of a scheduled job's task template; the next scheduled run uses it. */
async function releaseJobImage(token: string, context: EngineContext, resource: string, imageUri: string): Promise<Pick<EngineReleaseResult, 'status' | 'message' | 'url'>> {
  const url = `https://run.googleapis.com/v2/projects/${context.gcpProjectId}/locations/${context.region}/jobs/${resource}`;
  const observed = await cloudRunGet(token, context.gcpProjectId, context.region, resource, 'jobs');
  if (observed.state !== 'present') return { status: 'failed', message: observed.state === 'absent' ? `Job ${resource} does not exist.` : observed.reason };
  const containers = workloadContainers('jobs', observed.value).map((container) => ({ ...container }));
  if (containers.length !== 1) return { status: 'failed', message: `Job ${resource} must have exactly one container for an image release.` };
  containers[0]!.image = imageUri;
  // Jobs have no update mask: send the observed job back unchanged except for the image.
  // The etag still makes a concurrent change fail this release instead of being overwritten.
  const job = observed.value;
  const body = { ...job, template: { ...job.template, template: { ...job.template?.template, containers } } };
  const patch = await fetchWithRetry(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (patch.status === 409 || patch.status === 412) return { status: 'failed', message: `Job ${resource} changed while releasing. Nothing was overwritten; retry hv_deploy.` };
  if (!patch.ok) return { status: 'failed', message: `Cloud Run rejected the job image release (HTTP ${patch.status}): ${await googleErrorMessage(patch)}` };
  let operation = await patch.json() as { name?: string; done?: boolean; error?: { message?: string } };
  for (let attempt = 0; attempt < 100 && !operation.done && operation.name; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const polled = await fetchWithRetry(`https://run.googleapis.com/v2/${operation.name}`, { headers: { Authorization: `Bearer ${token}` } });
    if (polled.ok) operation = await polled.json() as typeof operation;
  }
  if (!operation.done) return { status: 'unknown', message: `The job release for ${resource} did not finish in time.` };
  if (operation.error) return { status: 'failed', message: `Cloud Run could not update job ${resource}: ${operation.error.message ?? 'unknown error'}` };
  const after = await cloudRunGet(token, context.gcpProjectId, context.region, resource, 'jobs');
  if (after.state !== 'present' || workloadContainers('jobs', after.value)[0]?.image !== imageUri) {
    return { status: 'unknown', message: `Job ${resource} did not report the new image.` };
  }
  return { status: 'released', message: `Released ${imageUri.split('@')[0]} to scheduled job ${resource}; its next run uses it.` };
}

async function releaseImage(token: string, context: EngineContext, resource: string, imageUri: string, kind: WorkloadKind = 'services'): Promise<Pick<EngineReleaseResult, 'status' | 'message' | 'url'>> {
  if (kind === 'jobs') return releaseJobImage(token, context, resource, imageUri);
  // Services and worker pools share the template shape and the masked image PATCH.
  const url = `https://run.googleapis.com/v2/projects/${context.gcpProjectId}/locations/${context.region}/${kind}/${resource}`;
  const observed = await cloudRunGet(token, context.gcpProjectId, context.region, resource, kind);
  if (observed.state !== 'present') {
    return { status: 'failed', message: observed.state === 'absent' ? `Service ${resource} does not exist. Re-run hv_plan scope="infrastructure".` : observed.reason };
  }
  const current = observed.value;
  const containers = Array.isArray(current.template?.containers) ? current.template.containers.map((c: Record<string, unknown>) => ({ ...c })) : [];
  if (containers.length !== 1) return { status: 'failed', message: `Service ${resource} must have exactly one container for an image release.` };
  containers[0].image = imageUri;
  // Only the image changes; every other field is sent back exactly as observed.
  const patch = await fetchWithRetry(`${url}?updateMask=template.containers`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ etag: current.etag, template: { containers } }),
  });
  if (patch.status === 409 || patch.status === 412) {
    return { status: 'failed', message: `Service ${resource} changed while releasing (concurrent update). Nothing was overwritten; retry hv_deploy.` };
  }
  if (!patch.ok) return { status: 'failed', message: `Cloud Run rejected the image release (HTTP ${patch.status}): ${await googleErrorMessage(patch)}` };
  const operation = await patch.json() as { name?: string; done?: boolean; error?: { message?: string } };
  const deadline = Date.now() + 10 * 60 * 1000;
  let done = operation.done === true;
  let error = operation.error;
  while (!done && operation.name && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const polled = await fetchWithRetry(`https://run.googleapis.com/v2/${operation.name}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!polled.ok) continue;
    const body = await polled.json() as { done?: boolean; error?: { message?: string } };
    done = body.done === true;
    error = body.error;
  }
  if (!done) return { status: 'unknown', message: `The release of ${resource} did not finish in time. Check hv_status before retrying.` };
  if (error) return { status: 'failed', message: `Cloud Run could not roll out the new image: ${error.message ?? 'unknown error'}` };
  const after = await cloudRunGet(token, context.gcpProjectId, context.region, resource, kind);
  if (after.state !== 'present') return { status: 'unknown', message: 'The release finished but the service could not be observed.' };
  const running = after.value.template?.containers?.[0]?.image;
  const ready = after.value.terminalCondition?.state === 'CONDITION_SUCCEEDED' && after.value.latestReadyRevision === after.value.latestCreatedRevision;
  if (running !== imageUri || !ready) return { status: 'unknown', message: 'The service did not report the new image as ready.' };
  return { status: 'released', message: `Released ${imageUri.split('@')[0]} to ${resource}.`, ...(typeof after.value.uri === 'string' ? { url: after.value.uri } : {}) };
}

// ---------------------------------------------------------------- Status

export interface EngineWorkerStatus {
  service: string;
  mode: 'on-demand' | 'always-on';
  instances?: number;
  waker?: { lastRunAt?: string; state?: string; pendingWork?: number; readError?: string };
}

/**
 * Read-only status of an engine environment's background workers. An
 * on-demand worker whose waker cannot read pending work keeps running (the
 * waker fails open), so that is reported as a warning with its cost.
 */
export async function engineWorkerStatus(ctx: CommandContext, project: Project, spec: ProjectSpec, environmentName: string): Promise<{ workers: EngineWorkerStatus[]; warnings: string[] } | { blocked: string }> {
  const environmentSpec = spec.environments[environmentName];
  if (!environmentSpec) return { blocked: `The spec has no environment "${environmentName}".` };
  const context = await resolveEngineContext(ctx, project, spec, environmentName);
  if ('blocked' in context) return { blocked: context.blocked };
  const token = await context.adapter.engineAccessToken();
  const bound = (context.environment.platformBindings as { services?: Record<string, { workerPoolName?: string }> }).services ?? {};
  const workers: EngineWorkerStatus[] = [];
  const warnings: string[] = [];
  for (const [name, service] of Object.entries(environmentSpec.services)) {
    if (service.workloadKind !== 'worker') continue;
    const resource = bound[name]?.workerPoolName;
    const status: EngineWorkerStatus = { service: name, mode: service.onDemand ? 'on-demand' : 'always-on' };
    if (resource) {
      const pool = await cloudRunGet(token, context.gcpProjectId, context.region, resource, 'workerPools');
      if (pool.state === 'present') status.instances = Number(pool.value.scaling?.manualInstanceCount ?? 0);
      if (service.onDemand) {
        const response = await fetchWithRetry(`https://workflowexecutions.googleapis.com/v1/projects/${context.gcpProjectId}/locations/${context.region}/workflows/${resource}-waker/executions?pageSize=1&view=FULL`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const latest = response.ok ? ((await response.json()) as { executions?: Array<{ state?: string; startTime?: string; result?: string }> }).executions?.[0] : undefined;
        if (latest) {
          let parsed: { pendingWork?: number | string; readError?: string } = {};
          try { const value = JSON.parse(latest.result ?? 'null'); if (value && typeof value === 'object') parsed = value; } catch { /* an older waker returns only a count */ }
          const pendingWork = parsed.pendingWork === undefined ? undefined : Number(parsed.pendingWork);
          status.waker = { ...(latest.startTime ? { lastRunAt: latest.startTime } : {}), ...(latest.state ? { state: latest.state } : {}),
            ...(pendingWork !== undefined && pendingWork >= 0 ? { pendingWork } : {}), ...(parsed.readError ? { readError: parsed.readError } : {}) };
          if (parsed.readError || pendingWork === -1) {
            warnings.push(`Worker ${name} is running all the time: its waker cannot read pending work (${parsed.readError || 'query failed'}). Run hv_plan scope="infrastructure" to repair its access.`);
          } else if (latest.state === 'FAILED') {
            warnings.push(`Worker ${name}'s waker failed its last run, so it cannot start or stop the worker. Check hv_logs.`);
          }
          if (latest.startTime && Date.now() - Date.parse(latest.startTime) > 10 * 60 * 1000) {
            warnings.push(`Worker ${name}'s waker has not run since ${latest.startTime}; new work may wait.`);
          }
        } else if (!response.ok) {
          warnings.push(`Worker ${name}'s waker could not be read (HTTP ${response.status}).`);
        }
      }
    }
    workers.push(status);
  }
  return { workers, warnings };
}
