import crypto from 'crypto';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildSourceBucketName } from '../domain/services/cloud-prepare.execute.js';
import { isCloudPreparedForStorage } from '../domain/services/cloud-prepare.js';

const execFileAsync = promisify(execFile);
import type { CommandContext } from './context.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
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
import { normalizeGitRemoteForBuild } from '../lib/git-remote.js';
import { redactEngineOutput } from '../adapters/engine/opentofu/runner.js';
import {
  executeDatabaseCredential, observeDatabaseCredential, otherLogin,
  type DatabaseCredentialMetadata, type DatabaseCredentialObservation, type DatabaseLogin,
} from './infrastructure-engine-database.js';
import {
  DOMAIN_DNS_OPERATION, DOMAIN_DNS_REMOVE_OPERATION, DOMAIN_READY_OPERATION, DOMAIN_VERIFY_OPERATION,
  executeDomainAction, planDomain, planDomainDnsRemoval, type DomainPlanActions,
} from './infrastructure-engine-domain.js';

const DOMAIN_OPERATIONS = new Set([DOMAIN_VERIFY_OPERATION, DOMAIN_DNS_OPERATION, DOMAIN_READY_OPERATION, DOMAIN_DNS_REMOVE_OPERATION]);

/**
 * OpenTofu-managed GCP environments (pilot).
 *
 * Opt-in per environment with `hosting.engine: "opentofu"`. OpenTofu owns the
 * Cloud Run services; Hypervibe owns Secret Manager secrets and their values,
 * image builds and releases, health and bindings. The legacy Cloud Run service
 * writer never runs for these environments.
 */
export const ENGINE_SECRET_OPERATION = 'gcpSecretManagerEnsure';
export const ENGINE_SECRET_DELETE_OPERATION = 'gcpSecretManagerDelete';
export const ENGINE_PLAN_SCOPE = 'infrastructure-engine';
export const ENGINE_RELEASE_OPERATION = 'engineImageRelease';
export const ENGINE_STORAGE_ACCESS_BLOCKER = 'Storage buckets need one more Google Cloud permission for Hypervibe. Approve it with hv_launch approveAccess=true, or run hv_connections provider="cloudrun" action="prepare" gcsAccess="lifecycle" (preview, then confirm).';
export const ENGINE_DATABASE_CREDENTIAL_OPERATION = 'gcpDatabaseCredentialEnsure';
/** Hypervibe-owned runtime secret holding the complete database connection URL. */
export const ENGINE_DATABASE_URL_KEY = 'DATABASE_URL';
const ENGINE_DATABASE_NAME = 'app';
/** Google's public sample container, pinned by digest; serves until the first release. */
export const ENGINE_HOLDING_IMAGE = 'us-docker.pkg.dev/cloudrun/container/hello@sha256:1fde53e0b892bff3072b3cac1c0e37178e9c0b98cf0b01e83956915e02b828c7';
const DEFAULT_REGION = 'us-central1';

export function isEngineManaged(environmentSpec: EnvironmentSpec | undefined): boolean {
  return environmentSpec?.hosting.engine === 'opentofu';
}

/** Desired state the pilot cannot yet manage. Anything listed blocks planning instead of being ignored. */
export function engineEnvironmentProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName];
  if (!environment) return [`Spec has no environment "${environmentName}".`];
  const problems: string[] = [];
  if (environment.hosting.provider !== 'cloudrun') problems.push('The OpenTofu engine currently supports only hosting.provider="cloudrun".');
  const unsupported: Array<[string, unknown]> = [
    ['cache', environment.cache],
    ['queues', environment.queues], ['loadBalancer', environment.loadBalancer],
    ['domainTarget', environment.domainTarget], ['domainRecreateRevision', environment.domainRecreateRevision],
    ['domainRegistration', environment.domainRegistration], ['webhooks', environment.webhooks], ['ios', environment.ios],
    ['backups', environment.backups?.mode === 'daily' ? environment.backups : undefined],
    ['email', environment.email?.enabled ? environment.email : undefined],
    ['deploy.trigger="native"', environment.deploy?.trigger === 'native' ? environment.deploy : undefined],
    ['deploy.promoteFrom', environment.deploy?.promoteFrom], ['deploy.promotionTests', environment.deploy?.promotionTests],
  ];
  for (const [field, value] of unsupported) {
    if (value !== undefined && value !== null && !(typeof value === 'object' && Object.keys(value as object).length === 0)) {
      problems.push(`${field} is not yet managed by the OpenTofu engine; remove it from this environment or use the standard lifecycle.`);
    }
  }
  if (environment.domain) {
    if (environment.domainProxy) problems.push('domainProxy must be off: Google issues the certificate and needs DNS-only records.');
    if (domainServiceFor(environment) === undefined) problems.push('A custom domain needs exactly one public web service to point at.');
  }
  for (const [name, storage] of Object.entries(environment.storage ?? {})) {
    if (storage.provider !== 'gcs') problems.push(`Storage ${name}: the OpenTofu engine manages buckets only with provider "gcs".`);
    if (storage.purpose === 'backup') problems.push(`Storage ${name}: backup destinations are not yet managed by the OpenTofu engine.`);
    for (const service of storage.injectInto) {
      if (!environment.services[service]) problems.push(`Storage ${name}: injectInto names undeclared service ${service}.`);
    }
  }
  const database = environment.database;
  if (database) {
    if (database.provider !== 'cloudsql') problems.push('The OpenTofu engine manages databases only with provider "cloudsql".');
    for (const field of ['seedCommand', 'resilience', 'credentialAliases', 'freshInitialization'] as const) {
      if (database[field] !== undefined) problems.push(`database.${field} is not yet supported by the OpenTofu engine.`);
    }
  }
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.workloadKind === 'cron' && (!service.cronSchedule || !service.startCommand)) {
      problems.push(`Scheduled job ${name} needs cronSchedule and startCommand (the command each run executes).`);
    }
    if (service.volume) problems.push(`Service ${name}: filesystem volumes are not yet managed by the OpenTofu engine.`);
    if (service.releaseCommand) problems.push(`Service ${name}: release commands are not yet supported by the OpenTofu engine.`);
  }
  for (const [key, secret] of Object.entries(spec.secrets)) {
    if (secret.ownership !== 'hypervibe' && secret.environments.includes(environmentName)) {
      problems.push(`Secret ${key}: externally supplied secrets are not yet supported by the OpenTofu engine; only Hypervibe-generated secrets are.`);
    }
  }
  return problems;
}

function domainServiceFor(environment: EnvironmentSpec): string | undefined {
  const candidates = Object.entries(environment.services)
    .filter(([, service]) => service.workloadKind !== 'worker' && service.workloadKind !== 'cron' && service.public !== false)
    .map(([name]) => name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function engineSecretKeys(spec: ProjectSpec, environmentName: string): string[] {
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
  storage?: string[];
  /** Keyless CI release trust granted for this exact repository. */
  ci?: { repository: string; provider: string; releaseIdentity: string };
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

export async function resolveEngineContext(
  ctx: CommandContext,
  project: Project,
  spec: ProjectSpec,
  environmentName: string
): Promise<EngineContext | { blocked: string }> {
  const environmentSpec = spec.environments[environmentName]!;
  const adapterResult = await adapterFactory.getProviderAdapter('cloudrun', project);
  if (!adapterResult.success || !(adapterResult.adapter instanceof CloudRunAdapter)) {
    return { blocked: 'No verified GCP connection is available for this project. Connect GCP with hv_connections action="bootstrap", then re-run hv_plan.' };
  }
  const adapter = adapterResult.adapter;
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
    return { blocked: `Environment ${environmentName} has services managed by the standard lifecycle. Adopting them into the OpenTofu engine needs an explicit import, which is not available yet.` };
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
  const binding = (context.environment.platformBindings as { services?: Record<string, { serviceId?: string; jobName?: string }> }).services?.[serviceName];
  const bound = binding?.serviceId ?? binding?.jobName;
  return bound ?? resourceName(serviceName, { maxLength: 49, scope: [context.gcpProjectId, environmentName] });
}

export function buildEngineInput(spec: ProjectSpec, environmentName: string, context: Pick<EngineContext, 'gcpProjectId' | 'region' | 'runtimeServiceAccountEmail'> & {
  resourceNameFor: (service: string) => string;
  databaseWired?: boolean;
  /** Exact secret versions to pin; a new version then rolls services through a reviewed update. */
  secretVersions?: Record<string, string>;
}): GcpCloudRunEngineInput {
  const environmentSpec = spec.environments[environmentName]!;
  const secretKeys = [...engineSecretKeys(spec, environmentName), ...(context.databaseWired ? [ENGINE_DATABASE_URL_KEY] : [])];
  const secretEnv = Object.fromEntries(secretKeys
    .map((key) => [key, { secretId: engineSecretId(environmentName, key), version: context.secretVersions?.[key] ?? 'latest' }]));
  return {
    projectId: context.gcpProjectId,
    region: context.region,
    services: Object.entries(environmentSpec.services).sort(([a], [b]) => a.localeCompare(b)).map(([name, service]) => {
      const workload = service.workloadKind === 'cron' ? 'job' as const : service.workloadKind === 'worker' ? 'worker' as const : 'web' as const;
      return {
        logicalName: name,
        resourceName: context.resourceNameFor(name),
        workload,
        initialImage: ENGINE_HOLDING_IMAGE,
        runtimeServiceAccountEmail: context.runtimeServiceAccountEmail,
        env: { ...environmentSpec.envVars },
        secretEnv,
        public: service.public ?? workload === 'web',
        ...(service.healthCheckPath ? { healthCheckPath: service.healthCheckPath } : {}),
        ...(workload === 'job' ? { schedule: service.cronSchedule, timeZone: service.timeZone ?? 'UTC', jobCommand: service.startCommand } : {}),
      };
    }),
  };
}

// ---------------------------------------------------------------- Secret Manager (Hypervibe-owned)

type Observed<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown'; reason: string };

export async function secretManagerFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
}

interface ObservedSecret { labels: Record<string, string>; hasEnabledVersion: boolean; latestVersion?: string }

export async function observeSecret(token: string, gcpProjectId: string, secretId: string): Promise<Observed<ObservedSecret>> {
  const base = `https://secretmanager.googleapis.com/v1/projects/${gcpProjectId}/secrets/${secretId}`;
  const secret = await secretManagerFetch(token, base);
  if (secret.status === 404) return { state: 'absent' };
  if (!secret.ok) return { state: 'unknown', reason: `Secret Manager returned HTTP ${secret.status} for ${secretId}.` };
  const body = await secret.json() as { labels?: Record<string, string> };
  const version = await secretManagerFetch(token, `${base}/versions/latest`);
  if (version.status === 404) return { state: 'present', value: { labels: body.labels ?? {}, hasEnabledVersion: false } };
  if (!version.ok) return { state: 'unknown', reason: `Secret Manager returned HTTP ${version.status} for ${secretId} versions.` };
  const versionBody = await version.json() as { state?: string; name?: string };
  const latestVersion = versionBody.name?.split('/').pop();
  return { state: 'present', value: { labels: body.labels ?? {}, hasEnabledVersion: versionBody.state === 'ENABLED',
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
    const created = await secretManagerFetch(token, `${base}?secretId=${secretId}`, {
      method: 'POST', body: JSON.stringify({ replication: { automatic: {} }, labels }),
    });
    if (!created.ok && created.status !== 409) {
      return { success: false, message: `Creating secret ${secretId} failed (HTTP ${created.status}).`, error: `HTTP ${created.status}` };
    }
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

async function deleteSecret(token: string, action: PlanAction): Promise<ActionResult> {
  const { gcpProjectId, secretId, labels } = action.metadata as { gcpProjectId: string; secretId: string; labels: Record<string, string> };
  const observed = await observeSecret(token, gcpProjectId, secretId);
  if (observed.state === 'absent') return { success: true, message: `Secret ${secretId} is already absent.` };
  if (observed.state === 'unknown') return { success: false, status: 'blocked', message: observed.reason };
  if (observed.value.labels['hv-environment'] !== labels['hv-environment'] || observed.value.labels['managed-by'] !== 'hypervibe') {
    return { success: false, status: 'blocked', message: `Secret ${secretId} is not owned by this Hypervibe environment.` };
  }
  const response = await secretManagerFetch(token, `https://secretmanager.googleapis.com/v1/projects/${gcpProjectId}/secrets/${secretId}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) return { success: false, message: `Deleting secret ${secretId} failed (HTTP ${response.status}).`, error: `HTTP ${response.status}` };
  const after = await observeSecret(token, gcpProjectId, secretId);
  return after.state === 'absent'
    ? { success: true, message: `Secret ${secretId} was deleted.` }
    : { success: false, status: 'pending', message: `Deletion of ${secretId} could not be confirmed yet.` };
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

/** Creates or updates a Hypervibe-labelled secret and adds one version. The value is never returned. */
export async function writeSecretVersion(token: string, gcpProjectId: string, secretId: string, labels: Record<string, string>, value: string): Promise<ActionResult | undefined> {
  const base = `https://secretmanager.googleapis.com/v1/projects/${gcpProjectId}/secrets`;
  const observed = await observeSecret(token, gcpProjectId, secretId);
  if (observed.state === 'unknown') return { success: false, status: 'blocked', message: observed.reason };
  if (observed.state === 'absent') {
    const created = await secretManagerFetch(token, `${base}?secretId=${secretId}`, { method: 'POST', body: JSON.stringify({ replication: { automatic: {} }, labels }) });
    if (!created.ok && created.status !== 409) return { success: false, message: `Creating secret ${secretId} failed (HTTP ${created.status}).`, error: `HTTP ${created.status}` };
  } else {
    if (observed.value.labels['managed-by'] !== 'hypervibe' || observed.value.labels['hv-environment'] !== labels['hv-environment']) {
      return { success: false, status: 'blocked', message: `Secret ${secretId} is not owned by this Hypervibe environment.` };
    }
    const patched = await secretManagerFetch(token, `${base}/${secretId}?updateMask=labels`, { method: 'PATCH', body: JSON.stringify({ labels }) });
    if (!patched.ok) return { success: false, message: `Updating secret ${secretId} failed (HTTP ${patched.status}).`, error: `HTTP ${patched.status}` };
  }
  let added: Response;
  try {
    added = await secretManagerFetch(token, `${base}/${secretId}:addVersion`, {
      method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(value).toString('base64') } }),
    });
  } catch {
    return { success: false, status: 'pending', message: `The value write for ${secretId} has an unknown outcome. Run hv_plan again to observe it before retrying.` };
  }
  if (!added.ok) return { success: false, message: `Writing ${secretId} failed (HTTP ${added.status}).`, error: `HTTP ${added.status}` };
  return undefined;
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
}): Promise<InfrastructurePlanResult | { blocked: string[] }> {
  const { project, spec, environmentName } = params;
  const environmentSpec = spec.environments[environmentName];
  if (!isEngineManaged(environmentSpec)) return { blocked: [`Environment ${environmentName} is not managed by the OpenTofu engine (hosting.engine="opentofu").`] };
  const problems = engineEnvironmentProblems(spec, environmentName);
  if (problems.length) return { blocked: problems };
  const context = await resolveEngineContext(ctx, project, spec, environmentName);
  if ('blocked' in context) return { blocked: [context.blocked] };
  if (Object.keys(environmentSpec!.storage ?? {}).length && !isCloudPreparedForStorage(ctx.repos.projects.findById(project.id) ?? project)) {
    return { blocked: [ENGINE_STORAGE_ACCESS_BLOCKER] };
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
  const existing = await listEngineSecrets(token, context.gcpProjectId, context.environment.id);
  if (existing.state === 'unknown') return { blocked: [existing.reason] };
  const desiredIds = new Set([...desiredKeys.map((key) => engineSecretId(environmentName, key)), ...(databaseSpec ? [databaseSecretId] : [])]);
  const anyService = Object.keys(environmentSpec!.services).length > 0;

  // Custom domain: Hypervibe verifies ownership and writes DNS before OpenTofu maps it.
  const desiredDomain = environmentSpec!.domain?.trim().toLowerCase().replace(/\.$/, '');
  const domainService = desiredDomain ? domainServiceFor(environmentSpec!) : undefined;
  const domainContext = { adapter: context.adapter, gcpProjectId: context.gcpProjectId, region: context.region };
  let domainActions: DomainPlanActions = { before: [], after: [] };
  if (desiredDomain && domainService) {
    domainActions = await planDomain(domainContext, desiredDomain, environmentSpec!.services[domainService]!.healthCheckPath ?? '/');
    if (domainActions.blocked) return { blocked: [domainActions.blocked] };
  }
  const retiredDomains = [...new Set([...(engineBinding.domains ?? []), ...unfinishedDomainRemovals(context.environment.id)])]
    .filter((domain) => domain !== desiredDomain).sort();

  const binary = await ensureEngineBinary();
  if (!binary.ok) return { blocked: [binary.error] };
  const engine = new OpenTofuEngine({ binary: binary.binary, cipher: getSecretStore(), pluginCacheDir: enginePluginCacheDir() });
  const boundServices = Object.keys((context.environment.platformBindings as { services?: Record<string, unknown> }).services ?? {});
  const configure = (adopt?: { databaseInstance?: string; buckets?: string[] }) => buildCloudRunConfiguration({
    ...(adopt ? { adopt } : {}),
    environmentId: context.environment.id,
    ...buildEngineInput(spec, environmentName, {
      ...context, resourceNameFor: (service) => serviceResourceName(context, environmentName, service),
      databaseWired: databaseCredentialReady,
      secretVersions,
    }),
    retiredServices: boundServices.filter((name) => !environmentSpec!.services[name]),
    ...(databaseSpec ? { database: { instanceName, databaseName: ENGINE_DATABASE_NAME, wireServices: databaseCredentialReady } } : {}),
    ...(!databaseSpec && engineBinding.database ? { retiredDatabase: true } : {}),
    ...(desiredDomain && domainService ? { domains: [{ domain: desiredDomain, service: domainService }] } : {}),
    ...(retiredDomains.length ? { retiredDomains } : {}),
    runtimeServiceAccountEmail: context.runtimeServiceAccountEmail,
    storage: Object.entries(environmentSpec!.storage ?? {}).map(([name, storage]) => ({
      name, bucketName: engineBucketName(context.gcpProjectId, environmentName, name), location: storage.region, injectInto: storage.injectInto,
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
  if (planned.blockers.length) return { blocked: planned.blockers };

  const secretIds = secretActions.filter((a) => a.type !== 'noop').map((a) => a.id);
  const domainPrerequisites = domainActions.before.filter((a) => a.type !== 'noop').map((a) => a.id);
  const serviceActions = planned.actions.map((action) => {
    if (action.type !== 'create' && action.type !== 'update' && action.type !== 'replace') return action;
    const extra = [...secretIds, ...(action.id.startsWith('domain:') ? domainPrerequisites : [])];
    return extra.length ? { ...action, dependsOn: [...(action.dependsOn ?? []), ...extra] } : action;
  });
  const engineDomainAction = desiredDomain ? serviceActions.find((a) => a.id === `domain:${desiredDomain}`) : undefined;
  const domainAfter = domainActions.after.map((action) => action.type !== 'noop' && engineDomainAction && engineDomainAction.type !== 'noop'
    ? { ...action, dependsOn: [engineDomainAction.id] } : action);
  const domainRemovals = retiredDomains.map((domain) => planDomainDnsRemoval(domainContext, domain,
    serviceActions.filter((a) => a.id === `domain:${domain}` && a.type === 'destroy').map((a) => a.id)));
  // Secrets are deleted only after every service that could read them is gone.
  const existingIds = existing.state === 'present' ? existing.value : [];
  const deletes: PlanAction[] = existingIds.filter((id) => !desiredIds.has(id)).map((secretId) => ({
    id: `secret-delete:${secretId}`,
    type: 'destroy',
    resource: { kind: 'secret', name: secretId, provider: 'gcp' },
    verified: true,
    reason: `Secret ${secretId} is no longer declared for this environment and will be permanently deleted.`,
    dataBearing: true,
    requiresConfirm: true,
    dependsOn: serviceActions.filter((a) => a.type === 'destroy').map((a) => a.id),
    metadata: { operation: ENGINE_SECRET_DELETE_OPERATION, gcpProjectId: context.gcpProjectId, secretId, labels },
  }));
  const databaseAction = serviceActions.find((action) => action.id === 'database:postgres');
  const credentialActions = databaseSpec
    ? await planDatabaseCredential({
      token, context, environmentName, instanceName, databaseSecretId, labels, observation: databaseCredential,
      desiredGeneration: databaseSpec.passwordGeneration ?? 1,
      dependsOn: databaseAction && databaseAction.type !== 'noop' ? [databaseAction.id] : [],
      servicesUpdating: serviceActions.some((action) => action.id.startsWith('service:') && action.type !== 'noop'),
    })
    : [];
  if ('blocked' in credentialActions) return { blocked: [credentialActions.blocked] };
  // Array order matters: prerequisites precede the engine segment so it runs only once they complete.
  const actions = [...secretActions, ...domainActions.before, ...serviceActions, ...credentialActions, ...domainAfter, ...deletes, ...domainRemovals];
  const warnings = [
    'Infrastructure is planned by OpenTofu. Releasing application code is a separate step: run hv_deploy after this apply.',
    ...(!anyService ? ['This environment declares no services; any previously created services will be deleted.'] : []),
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

type WorkloadKind = 'services' | 'jobs';

/** Bound Cloud Run workloads: services record serviceId, scheduled jobs record jobName. */
function boundWorkloads(environment: Environment): Array<{ name: string; kind: WorkloadKind; resource: string }> {
  const bound = (environment.platformBindings as { services?: Record<string, { serviceId?: string; jobName?: string }> }).services ?? {};
  const workloads: Array<{ name: string; kind: WorkloadKind; resource: string }> = [];
  for (const [name, binding] of Object.entries(bound)) {
    if (binding.serviceId) workloads.push({ name, kind: 'services', resource: binding.serviceId });
    else if (binding.jobName) workloads.push({ name, kind: 'jobs', resource: binding.jobName });
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
  const document = loaded.document as PlanRunDocument & { engine?: { planId: string; state: EngineStateIdentity; gcpProjectId: string; region: string; observedGenerations?: Record<string, string>; database?: { instanceName: string } } };
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
      if (operation === ENGINE_SECRET_OPERATION) return ensureSecret(token, action);
      if (operation === ENGINE_SECRET_DELETE_OPERATION) return deleteSecret(token, action);
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
      if (operation === ENGINE_DATABASE_CREDENTIAL_OPERATION) {
        if ((action.metadata as { instanceName?: string }).instanceName !== reviewed.database?.instanceName) {
          return { success: false, status: 'blocked', message: 'Database target changed; re-run hv_plan.' };
        }
        return executeDatabaseCredential(token, JSON.parse(context.adapter.engineConnection().credentials) as Record<string, unknown>, action);
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
      // Record the attempted database identity first, so an interrupted create is found, not duplicated.
      if (reviewed.database?.instanceName && members.some((member) => member.id === 'database:postgres' && member.type !== 'destroy')) {
        const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
        const engineBinding = (current.platformBindings as { engine?: EngineBinding }).engine ?? {};
        ctx.repos.environments.updatePlatformBindings(current.id, {
          engine: { ...engineBinding, kind: 'opentofu', database: { instanceName: reviewed.database.instanceName } },
        });
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
    if (member.id.startsWith('storage:')) {
      const remaining = (engine.storage ?? []).filter((entry) => entry !== member.resource.name);
      engine = { ...engine, storage: member.type === 'destroy' ? remaining : [...remaining, member.resource.name].sort() };
      continue;
    }
    if (member.id.startsWith('domain:')) {
      const domain = member.resource.name;
      const remaining = (engine.domains ?? []).filter((entry) => entry !== domain);
      // A removed mapping keeps the domain recorded until its DNS is removed too.
      if (member.type !== 'destroy') engine = { ...engine, domains: [...remaining, domain].sort() };
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
  const context = await resolveEngineContext(ctx, params.project, spec, environmentName);
  if ('blocked' in context) return { blocked: context.blocked };
  const source = await resolveReleaseSource(params);
  if ('blocked' in source) return source;
  const workloads = new Map(boundWorkloads(context.environment).map((workload) => [workload.name, workload]));
  const selected = params.services?.length ? params.services : Object.keys(environmentSpec!.services);
  const missing = selected.filter((name) => !environmentSpec!.services[name] || !workloads.get(name));
  if (missing.length) return { blocked: `Create the infrastructure first: ${missing.join(', ')} has no engine-managed service. Run hv_plan scope="infrastructure" and hv_apply.` };

  // A release is a recorded plan run executed under the same per-environment
  // lock as infrastructure applies, so the two can never interleave.
  const actions: PlanAction[] = selected.map((name) => ({
    id: `release:${name}`,
    type: 'update',
    resource: { kind: 'service', name, provider: 'gcp' },
    verified: true,
    reason: `Build ${params.revision ?? 'main'} and release it to ${name}; only the running image changes.`,
    metadata: { operation: ENGINE_RELEASE_OPERATION, gcpProjectId: context.gcpProjectId, resource: workloads.get(name)!.resource, workloadKind: workloads.get(name)!.kind },
  }));
  const document = {
    kind: 'hv_plan', scope: ENGINE_PLAN_SCOPE, environmentName, specRevision: params.specRevision,
    observedFingerprint: null, actions, unmanaged: [], warnings: [],
    engine: { planId: `release-${crypto.randomUUID()}`, release: true },
  } as PlanRunDocument;
  const runRepo = new RunRepository();
  const planRun = runRepo.create({ projectId: params.project.id, environmentId: context.environment.id, type: 'plan', plan: document as unknown as Record<string, unknown> });
  runRepo.updateStatus(planRun.id, 'succeeded');

  const results: EngineReleaseResult[] = [];
  const execution = await new ConvergeExecutor().execute({
    planRunId: planRun.id,
    currentSpecRevision: params.specRevision,
    handler: async (action) => {
      const name = action.resource.name;
      const result = await releaseOne(context, params.project, spec, environmentName, name, String(action.metadata?.resource), source,
        action.metadata?.workloadKind === 'jobs' ? 'jobs' : 'services');
      results.push(result);
      const data = { ...(result.imageUri ? { imageUri: result.imageUri } : {}), ...(result.url ? { url: result.url } : {}), ...(result.health ? { health: result.health } : {}) };
      if (result.status === 'released') return { success: true, message: result.message, data };
      if (result.status === 'unknown') return { success: false, status: 'pending', message: result.message, data };
      return { success: false, message: result.message, error: result.message, data };
    },
  });
  if (!execution.applyRunId) return { blocked: execution.error ?? 'The release could not start.' };
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

async function releaseOne(
  context: EngineContext,
  project: Project,
  spec: ProjectSpec,
  environmentName: string,
  name: string,
  resource: string,
  source: ReleaseSource,
  kind: WorkloadKind = 'services'
): Promise<EngineReleaseResult> {
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
    return { service: name, status: 'failed', message: build.error ?? 'The build did not produce a digest-pinned image.', ...(build.logsUrl ? { buildLogsUrl: build.logsUrl } : {}) };
  }
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

/** Image-only, etag-guarded update of a scheduled job's task template; the next scheduled run uses it. */
async function releaseJobImage(token: string, context: EngineContext, resource: string, imageUri: string): Promise<Pick<EngineReleaseResult, 'status' | 'message' | 'url'>> {
  const url = `https://run.googleapis.com/v2/projects/${context.gcpProjectId}/locations/${context.region}/jobs/${resource}`;
  const observed = await cloudRunGet(token, context.gcpProjectId, context.region, resource, 'jobs');
  if (observed.state !== 'present') return { status: 'failed', message: observed.state === 'absent' ? `Job ${resource} does not exist.` : observed.reason };
  const containers = workloadContainers('jobs', observed.value).map((container) => ({ ...container }));
  if (containers.length !== 1) return { status: 'failed', message: `Job ${resource} must have exactly one container for an image release.` };
  containers[0]!.image = imageUri;
  const patch = await fetchWithRetry(`${url}?updateMask=template.template.containers`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ etag: observed.value.etag, template: { template: { containers } } }),
  });
  if (patch.status === 409 || patch.status === 412) return { status: 'failed', message: `Job ${resource} changed while releasing. Nothing was overwritten; retry hv_deploy.` };
  if (!patch.ok) return { status: 'failed', message: `Cloud Run rejected the job image release (HTTP ${patch.status}).` };
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
  const url = `https://run.googleapis.com/v2/projects/${context.gcpProjectId}/locations/${context.region}/services/${resource}`;
  const observed = await cloudRunGet(token, context.gcpProjectId, context.region, resource);
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
  if (!patch.ok) return { status: 'failed', message: `Cloud Run rejected the image release (HTTP ${patch.status}).` };
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
  const after = await cloudRunGet(token, context.gcpProjectId, context.region, resource);
  if (after.state !== 'present') return { status: 'unknown', message: 'The release finished but the service could not be observed.' };
  const running = after.value.template?.containers?.[0]?.image;
  const ready = after.value.terminalCondition?.state === 'CONDITION_SUCCEEDED' && after.value.latestReadyRevision === after.value.latestCreatedRevision;
  if (running !== imageUri || !ready) return { status: 'unknown', message: 'The service did not report the new image as ready.' };
  return { status: 'released', message: `Released ${imageUri.split('@')[0]} to ${resource}.`, url: after.value.uri };
}
