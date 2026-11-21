import { createHash } from 'node:crypto';
import { clearEngineCiBinding, recordEngineCiBindings } from './engine-ci-bindings.js';
import { recordEngineWorkloadBindings } from './engine-workload-bindings.js';
import { projectAzureSharedApps, projectAzureWorkloadBindings } from '../adapters/providers/azure/azure-diagnostics.client.js';
import { commonEngineProblems, environmentProfile, type EnvironmentProfile } from '../domain/services/infrastructure-engine-selection.js';
import { secretServiceScopeProblems, secretServicesFor } from '../domain/services/secret-service-scope.js';
import { specWithoutEnvironment, openTofuEngine, planEngineSecrets, recordEnginePlan } from './engine-shared.js';
import crypto from 'crypto';
import { ARM, AZURE_SCOPES, azureRest, azureVaultUri } from '../adapters/providers/azure/azure-ops.client.js';
import { azureSelectedBuildRegistry, projectAzureCiRegistry, type AzureBuildRegistry } from '../adapters/providers/azure/azure-ci-registry.js';
import { AZURE_IMAGE_REPOSITORY } from '../adapters/providers/azure/azure-release.client.js';
export { AZURE_IMAGE_REPOSITORY } from '../adapters/providers/azure/azure-release.client.js';
import { AzureEngineCredentialsSchema, type AzureEngineCredentials } from '../adapters/providers/azure/azure-engine.adapter.js';
import { azureEngineAuthentication, azureEngineBackend } from '../adapters/providers/azure/tofu/azure-engine.backend.js';
import {
  WAKER_SECRET_KEY, azureAppsEnvironmentName, azureProjectVaultName, azureSharedNames, azureStorageAccountName, azureVaultSecretName, buildAzureEnvironmentConfiguration,
  buildAzureSharedConfiguration, buildAzureBuildConfiguration, type AzureEngineInput, type AzureSharedInput,
} from '../adapters/providers/azure/tofu/azure-engine.config.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { redactEngineOutput } from '../adapters/engine/opentofu/runner.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import { ConvergeExecutor, type ActionResult, type ConvergeResult, type PlanRunDocument } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import { engineSegmentOf, type EngineAuthentication, type EngineStateIdentity } from '../domain/ports/infrastructure-engine.port.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import {
  AzureTokens, azureDatabaseNames, azureKeyVaultSecretStore, deleteFailedAppEnvironment, emptyContainer, environmentDatabaseDrop, environmentDatabaseSetup, observeFailedAppEnvironment, purgeVaultSecrets, runAzureSetupSql, taggedResources,
  type AzureKeyVaultSecretStore,
} from '../adapters/providers/azure/azure-ops.client.js';
import { azureCiSetupReady, azureDeployAppName } from '../adapters/providers/azure/azure-setup.client.js';
import type { CommandContext } from './context.js';
import { engineCiIntent } from '../domain/spec/engine-ci.js';
import type { EngineSecretStore } from './engine-secrets.js';
import { engineOutsideKeys, isBuildTokenKey, optionalOutsideKeys } from './engine-secrets.js';
import { ENGINE_DATABASE_URL_KEY, engineSecretKeys, type InfrastructurePlanResult } from './infrastructure-engine.js';
import { localRepositoryFor } from './local-repository.js';

/**
 * The OpenTofu lifecycle for Azure environments: spec → configuration (a shared
 * state for the private network, app environment, server and registry; an
 * environment state for the rest), Hypervibe-owned secrets in the project Key
 * Vault, the app's database login over verified TLS with an Entra token while the
 * server is briefly open to this computer only, the first image built inside the same apply,
 * and the same reviewed-plan executor as GCP and AWS. See docs/opentofu-engine-azure.md.
 */
export const AZURE_SECRET_OPERATION = 'azureSecretEnsure';
export const AZURE_DATABASE_LOGIN_OPERATION = 'azureDatabaseLoginEnsure';
export const AZURE_IMAGE_BUILD_OPERATION = 'azureImageBuild';
export const AZURE_STORAGE_EMPTY_OPERATION = 'azureStorageEmpty';
export const AZURE_DATABASE_DROP_OPERATION = 'azureDatabaseDrop';
export const AZURE_TEARDOWN_CLEANUP_OPERATION = 'azureTeardownCleanup';
export const AZURE_FAILED_ENVIRONMENT_OPERATION = 'azureFailedAppEnvironment';

export type AzureProfile = EnvironmentProfile;
export const azureProfileFor = environmentProfile;

export function isAzureEngineEnvironment(spec: ProjectSpec, environmentName: string): boolean {
  const environment = spec.environments[environmentName];
  return environment?.hosting.provider === 'azure';
}

export interface AzureEngineBinding {
  database?: import('../domain/services/engine-database-access.service.js').AzureDatabaseBinding;
  kind?: 'opentofu';
  /** Digest-pinned image of the last build; new workloads are created from it. */
  image?: string;
  imageCommit?: string;
  /** Persisted from exact build state; retained on switch back to manual deploys. */
  buildRegistry?: AzureBuildRegistry;
  /** The app's database login exists and DATABASE_URL is in Key Vault. */
  databaseLoginAt?: string;
  /** The read-only login on-demand workers count pending work with exists. */
  wakerLoginAt?: string;
  tornDownAt?: string;
  /** 2: long names end in a distinguishing mark. Absent on environments made before that. */
  naming?: 2;
}

export function azureBinding(environment: Pick<Environment, 'platformBindings'>): AzureEngineBinding {
  return ((environment.platformBindings as { azure?: AzureEngineBinding } | undefined)?.azure) ?? {};
}

const azureSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
/** A name that fits `limit`. One that had to be cut ends in a mark of the whole name, so two long names never become one. */
function azureFitted(full: string, limit: number, legacy: boolean): string {
  const slug = azureSlug(full);
  const cut = slug.slice(0, limit).replace(/-+$/, '');
  if (legacy || slug.length <= limit) return cut;
  return `${slug.slice(0, limit - 7).replace(/-+$/, '')}-${createHash('sha256').update(full).digest('hex').slice(0, 6)}`;
}

/**
 * Environments made before long names got a distinguishing mark keep their plain cut names: renaming would replace their resources.
 * A new environment records `naming: 2` with the first thing saved about it.
 */
export function azureLegacyNames(environment: Pick<Environment, 'platformBindings'>): boolean {
  const binding = azureBinding(environment);
  return Object.keys(binding).length > 0 && binding.naming !== 2;
}

/** The binding to build a save from; it carries the naming of a new environment. */
export function azureBindingToSave(environment: Pick<Environment, 'platformBindings'>): AzureEngineBinding {
  return { ...azureBinding(environment), ...(azureLegacyNames(environment) ? {} : { naming: 2 as const }) };
}

/** Container App names allow 32 characters; the prefix keeps environments apart. */
export function azurePrefix(project: string, environmentName: string, legacy = false): string {
  return azureFitted(`hv-${project}-${environmentName}`, 20, legacy);
}

export function azureResourceName(prefix: string, service: string, legacy = false): string {
  return azureFitted(`${prefix}-${service}`, 32, legacy);
}

export function azureContainerName(storage: string): string {
  return storage.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').padEnd(3, '0').slice(0, 63);
}

/** Azure engine environments in the testing profile: they share one network, app environment, server and registry. */
export function azureTestingEnvironments(spec: ProjectSpec): string[] {
  return Object.keys(spec.environments).filter((name) => isAzureEngineEnvironment(spec, name) && azureProfileFor(name) === 'testing').sort();
}

/** Desired state the Azure engine cannot build yet; listed problems block planning instead of being ignored. */
/**
 * Secrets limited to named services in this environment: variable name → those services. On Azure each named
 * service runs as its own identity and no other workload's identity can read the secret.
 */
export function azureSecretServices(spec: ProjectSpec, environmentName: string): Record<string, string[]> {
  const declared = (spec.secrets ?? {}) as Record<string, { environments: string[]; services?: string[] } | undefined>;
  return Object.fromEntries(Object.keys(declared).filter((key) => declared[key]?.services && declared[key]!.environments.includes(environmentName)).sort()
    .map((key) => [key, secretServicesFor(spec, environmentName, key)]));
}

/** Limited secrets Azure cannot isolate: they are refused, never accepted with a weaker guarantee. */
function azureSecretScopeProblems(spec: ProjectSpec, environmentName: string): string[] {
  return Object.keys(azureSecretServices(spec, environmentName)).flatMap((key) => {
    if (isBuildTokenKey(key)) return [`Secret ${key} is a package token: on Azure only image builds read it and no service receives it, so it cannot be limited to named services. Remove "services" from the secret.`];
    if (key === WAKER_SECRET_KEY) return [`Secret ${key} is the read-only login Hypervibe creates for on-demand workers' scale rules; it cannot be limited to named services. Remove "services" from the secret.`];
    return [];
  });
}

export function azureEngineProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName]!;
  const problems: string[] = [...commonEngineProblems(environment), ...secretServiceScopeProblems(spec, environmentName), ...azureSecretScopeProblems(spec, environmentName)];
  if (azureProfileFor(environmentName) === 'production') {
    problems.push(`${environmentName} uses the production profile (its own server and registry, web always on), which the Azure engine does not build yet. Testing environments are supported.`);
  }
  if (environment.database && environment.database.provider !== 'azure-postgres') problems.push('The Azure engine manages databases only with provider "azure-postgres".');
  const versions = new Set(azureTestingEnvironments(spec).map((name) => spec.environments[name]!.database).filter(Boolean).map((database) => database!.version ?? 17));
  if (azureProfileFor(environmentName) === 'testing' && versions.size > 1) {
    problems.push(`Testing environments share one PostgreSQL server, so they need one version; the spec asks for ${[...versions].sort().join(' and ')}.`);
  }
  if (environment.cache) problems.push('Redis caches are not available on the Azure engine yet.');
  if (Object.keys(environment.queues ?? {}).length) problems.push('Queues are not available on the Azure engine yet.');
  if (environment.domain) problems.push('Custom domains are not available on the Azure engine yet; use the service URL or route traffic with domainTarget.');
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.onDemand && !environment.database) problems.push(`${name} starts on demand, which counts pending work in the database; add a database.`);
    if (service.workloadKind === 'cron' && service.timeZone && service.timeZone !== 'UTC') {
      problems.push(`${name}: Container Apps Jobs run schedules in UTC; write the schedule in UTC and remove timeZone.`);
    }
  }
  for (const setting of ['versioning', 'browserUploads'] as const) {
    if (new Set(Object.values(environment.storage ?? {}).map(storage => Boolean(storage[setting]))).size > 1) {
      problems.push(`Azure containers in this environment share one storage account. Choose the same ${setting} setting for each container.`);
    }
  }
  for (const [name, storage] of Object.entries(environment.storage ?? {})) {
    if (storage.provider !== 'azureblob') problems.push(`Storage ${name}: the Azure engine manages containers only with provider "azureblob".`);
    if (storage.access === 's3') problems.push(`Storage ${name}: Azure Blob Storage has no S3-compatible API; use the Azure SDK (access "native").`);
  }
  return problems;
}

export function resolveAzureConnection(project: Project): { connection: AzureEngineCredentials } | { blocked: string } {
  const scope = parseGitHubRepoFromRemote(project.gitRemoteUrl ?? undefined) ?? project.name;
  const stored = new ConnectionRepository().findBestVerifiedMatch('azure', scope);
  if (!stored) return { blocked: 'This project has no Azure access yet. Run hv_connections provider="azure" action="connect" (one sign-in).' };
  const parsed = AzureEngineCredentialsSchema.safeParse(getSecretStore().decryptObject(stored.credentialsEncrypted));
  if (!parsed.success) return { blocked: 'The Azure connection is not Hypervibe\'s deploy access. Run hv_connections provider="azure" action="connect" again.' };
  if (Date.parse(parsed.data.clientSecretExpiresAt) <= Date.now()) return { blocked: 'Hypervibe\'s Azure client secret has expired. Run hv_connections provider="azure" action="connect" again (one sign-in).' };
  return { connection: parsed.data };
}

export interface AzureEngineContext {
  project: Project;
  environmentName: string;
  connection: AzureEngineCredentials;
  auth: EngineAuthentication;
  tokens: AzureTokens;
  environment: Environment;
  prefix: string;
  /** Names are cut plainly, as this environment was created with. */
  legacyNames: boolean;
  state: EngineStateIdentity;
  buildState: EngineStateIdentity;
  shared: { label: string; prefix: string; state: EngineStateIdentity; registryId: string; registryLoginServer: string; appsEnvironmentId: string; serverId: string; serverName: string; databaseHost: string };
  vault: { name: string; id: string; uri: string };
}

/** Pure: names, ids and states of one environment and the shared group it belongs to. */
export function azureEngineLayout(project: Pick<Project, 'id' | 'name'>, environmentName: string, environmentId: string, connection: Pick<AzureEngineCredentials, 'subscriptionId' | 'resourceGroup'>, legacyNames = false) {
  const group = `/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}`;
  const label = azureProfileFor(environmentName) === 'testing' ? 'testing' : environmentName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  // Testing environments share one group, so its name cannot depend on which of them asks.
  const sharedPrefix = label === 'testing' ? azurePrefix(project.name, 'shared', true) : azurePrefix(project.name, `${environmentName}-own`, legacyNames);
  const names = azureSharedNames({ subscriptionId: connection.subscriptionId, prefix: sharedPrefix, label });
  const vaultName = azureProjectVaultName(connection.subscriptionId, project.name);
  return {
    legacyNames, prefix: azurePrefix(project.name, environmentName, legacyNames),
    state: { provider: 'azure', projectId: project.id, environmentId, partition: 'environment' } as EngineStateIdentity,
    buildState: { provider: 'azure', projectId: project.id, environmentId: `${environmentId}-build`, partition: 'environment' } as EngineStateIdentity,
    shared: {
      label, prefix: sharedPrefix,
      state: { provider: 'azure', projectId: project.id, environmentId: `shared-${label}`.slice(0, 120), partition: 'project-shared' } as EngineStateIdentity,
      registryId: `${group}/providers/Microsoft.ContainerRegistry/registries/${names.registry}`, registryLoginServer: `${names.registry}.azurecr.io`,
      appsEnvironmentId: `${group}/providers/Microsoft.App/managedEnvironments/${azureAppsEnvironmentName(sharedPrefix)}`,
      serverId: `${group}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${names.server}`, serverName: names.server, databaseHost: `${names.server}.postgres.database.azure.com`,
    },
    vault: { name: vaultName, id: `${group}/providers/Microsoft.KeyVault/vaults/${vaultName}`, uri: azureVaultUri(vaultName) },
  };
}

export async function resolveAzureEngineContext(ctx: CommandContext, project: Project, environmentName: string): Promise<AzureEngineContext | { blocked: string }> {
  const access = resolveAzureConnection(project);
  if ('blocked' in access) return access;
  const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName)
    ?? ctx.repos.environments.create({ projectId: project.id, name: environmentName });
  return {
    project, environmentName, connection: access.connection, auth: azureEngineAuthentication(access.connection), tokens: new AzureTokens(access.connection),
    environment, ...azureEngineLayout(project, environmentName, environment.id, access.connection, azureLegacyNames(environment)),
  };
}

/** The environment's slice of the project Key Vault, as the shared secret flows (collect, needs_secrets) see it. */
export function azureEnvironmentSecretStore(context: Pick<AzureEngineContext, 'tokens' | 'vault' | 'environmentName'>): AzureKeyVaultSecretStore {
  return azureKeyVaultSecretStore(context.tokens, context.vault.uri, (key) => azureVaultSecretName(context.environmentName, key));
}

export async function azureSecretStore(ctx: CommandContext, project: Project, environmentName: string): Promise<EngineSecretStore | { blocked: string }> {
  const context = await resolveAzureEngineContext(ctx, project, environmentName);
  if ('blocked' in context) return context;
  return azureEnvironmentSecretStore(context);
}

/** An environment's Azure region: its spec region, otherwise the one chosen at setup. */
export function azureLocationFor(spec: ProjectSpec, environmentName: string, connection: { location: string }): string {
  return spec.environments[environmentName]?.hosting.region?.trim() || connection.location;
}

/** The shared network, app environment, server and registry live where the environments sharing them are; they must agree. */
export function azureSharedLocation(spec: ProjectSpec, environments: string[], connection: { location: string }): string | { blocked: string } {
  const regions = [...new Set(environments.map((name) => azureLocationFor(spec, name, connection)))];
  if (regions.length > 1) return { blocked: `Testing environments ${environments.join(', ')} share one network, database server and registry, so they need one region; they are set to ${regions.join(' and ')}.` };
  return regions[0] ?? connection.location;
}

/** The shared server and registry for this environment's group, sized for the environments that remain in the spec. */
export function buildAzureSharedInput(spec: ProjectSpec, context: Pick<AzureEngineContext, 'connection' | 'shared' | 'project'>, environments: string[]): AzureSharedInput {
  const database = environments.map((name) => spec.environments[name]?.database).find(Boolean);
  const location = azureSharedLocation(spec, environments, context.connection);
  if (typeof location === 'object') throw new Error(location.blocked);
  return {
    kind: 'shared', tenantId: context.connection.tenantId, subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup,
    location, prefix: context.shared.prefix, label: context.shared.label,
    deployPrincipalId: context.connection.deployPrincipalId, deployPrincipalName: azureDeployAppName(context.project.name),
    ...(database ? { database: { version: database.version ?? 17 } } : {}),
  };
}

/** One environment's configuration input. Workloads are created from `image` (the last build, or the commit this apply builds). */
export function buildAzureEngineInput(spec: ProjectSpec, environmentName: string, context: Pick<AzureEngineContext, 'connection' | 'prefix' | 'shared' | 'vault'> & Partial<Pick<AzureEngineContext, 'legacyNames'>> & { environment: Pick<Environment, 'id'> & Partial<Pick<Environment, 'platformBindings'>> },
  extra: { secretKeys: string[]; image?: string }): AzureEngineInput {
  const environmentSpec = spec.environments[environmentName]!;
  const storageAccount = azureStorageAccountName({ subscriptionId: context.connection.subscriptionId, environmentId: context.environment.id, prefix: context.prefix });
  const services = extra.image ? Object.entries(environmentSpec.services).sort(([a], [b]) => a.localeCompare(b)) : [];
  const envFor = (service: string): Record<string, string> => {
    const buckets = Object.entries(environmentSpec.storage ?? {}).filter(([, storage]) => storage.injectInto.includes(service)).map(([name]) => name);
    if (buckets.length > 1) throw new Error(`Service ${service} can receive only one storage container's variables.`);
    // The runtime identity is the credential (the configuration adds AZURE_CLIENT_ID); storage accounts have no shared keys.
    const storage: Record<string, string> = buckets[0] ? {
      OBJECT_STORAGE_PROVIDER: 'azureblob', OBJECT_STORAGE_BUCKET: azureContainerName(buckets[0]), AZURE_STORAGE_ACCOUNT_NAME: storageAccount,
      AZURE_STORAGE_CONTAINER_NAME: azureContainerName(buckets[0]), AZURE_STORAGE_BLOB_ENDPOINT: `https://${storageAccount}.blob.core.windows.net/`,
    } : {};
    for (const key of Object.keys(storage)) if (key in environmentSpec.envVars) throw new Error(`Environment variable ${key} conflicts with storage ${buckets[0]}.`);
    return { PORT: '8080', ...Object.fromEntries(Object.entries(environmentSpec.envVars).filter(([key]) => !isBuildTokenKey(key))), ...storage };
  };
  const command = (startCommand?: string) => startCommand ? { command: ['sh', '-c', startCommand] } : {};
  const secretServices = azureSecretServices(spec, environmentName);
  return {
    kind: 'environment', tenantId: context.connection.tenantId, subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup,
    ...(engineCiIntent(spec, environmentName) ? { ci: engineCiIntent(spec, environmentName) } : {}),
    location: azureLocationFor(spec, environmentName, context.connection), prefix: context.prefix, environmentId: context.environment.id, environmentName,
    shared: { registryId: context.shared.registryId, registryLoginServer: context.shared.registryLoginServer, appsEnvironmentId: context.shared.appsEnvironmentId },
    ...(azureBinding(context.environment as Environment).buildRegistry ? { buildRegistry: azureBinding(context.environment as Environment).buildRegistry! } : {}),
    vault: { id: context.vault.id, uri: context.vault.uri },
    storage: Object.entries(environmentSpec.storage ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, storage]) => ({
      name, container: azureContainerName(name), ...(storage.versioning ? { versioning: true } : {}), ...(storage.browserUploads ? { browserUploads: true } : {}),
    })),
    services: services.filter(([, service]) => (service.workloadKind ?? 'web') === 'web').map(([logicalName, service]) => {
      const env = envFor(logicalName);
      const port = Number(env.PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Service ${logicalName}: PORT must be a port number.`);
      return { logicalName, resourceName: azureResourceName(context.prefix, logicalName, context.legacyNames), initialImage: extra.image!, public: service.public ?? true, targetPort: port, env,
        ...command(service.startCommand), ...(service.healthCheckPath ? { healthCheckPath: service.healthCheckPath } : {}) };
    }),
    workers: services.filter(([, service]) => service.workloadKind === 'worker').map(([logicalName, service]) => ({
      logicalName, resourceName: azureResourceName(context.prefix, logicalName, context.legacyNames), initialImage: extra.image!, env: envFor(logicalName), ...command(service.startCommand),
      ...(service.onDemand ? { pendingWorkQuery: service.onDemand.pendingWorkQuery } : {}),
    })),
    jobs: services.filter(([, service]) => service.workloadKind === 'cron').map(([logicalName, service]) => ({
      logicalName, resourceName: azureResourceName(context.prefix, logicalName, context.legacyNames), initialImage: extra.image!, env: envFor(logicalName),
      schedule: service.cronSchedule!, ...command(service.startCommand),
    })),
    secretKeys: extra.secretKeys.filter((key) => !isBuildTokenKey(key)),
    // Only an environment that limits a secret gets identities of its own; every other environment is generated as before.
    ...(Object.keys(secretServices).length ? { secretServices,
      storageServices: [...new Set(Object.values(environmentSpec.storage ?? {}).flatMap((storage) => storage.injectInto))].sort() } : {}),
    ...(extra.secretKeys.find((key) => isBuildTokenKey(key) && engineOutsideKeys(spec, environmentName).includes(key)) ? { packageTokenKey: extra.secretKeys.find((key) => isBuildTokenKey(key) && engineOutsideKeys(spec, environmentName).includes(key))! } : {}),
  };
}

/** Secrets an environment's workloads reference: Hypervibe-generated, outside keys, and the database URL. */
export function azureEnvironmentSecretKeys(spec: ProjectSpec, environmentName: string, importedSecrets: string[] = []): { generated: string[]; outside: string[]; all: string[]; build: string[] } {
  const generated = engineSecretKeys(spec, environmentName);
  const outside = engineOutsideKeys(spec, environmentName, importedSecrets);
  const all = [...new Set([...generated, ...outside, ...(spec.environments[environmentName]?.database ? [ENGINE_DATABASE_URL_KEY] : [])])].sort();
  return { generated, outside, all: all.filter((key) => !isBuildTokenKey(key)), build: outside.filter(isBuildTokenKey) };
}

const importedOf = (environment: Environment) => (environment.platformBindings as { engine?: { importedSecrets?: string[] } }).engine?.importedSecrets;

// Azure deletes can take over 20 minutes (a Container Apps environment drains before its workspace goes).
const engineFor = () => openTofuEngine({ timeoutMs: 60 * 60 * 1000 });

function recordPlan(project: Project, context: AzureEngineContext, params: { environmentName: string; specRevision: number }, actions: PlanAction[], warnings: string[], engine: Record<string, unknown>): InfrastructurePlanResult {
  return recordEnginePlan({ projectId: project.id, environmentId: context.environment.id, environmentName: params.environmentName, specRevision: params.specRevision, actions, warnings,
    engine: { state: context.state, azure: { subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup, prefix: context.prefix }, ...engine } });
}

const withDependencies = (actions: PlanAction[], dependencies: string[]) => dependencies.length
  ? actions.map((action) => action.type === 'noop' ? action : { ...action, dependsOn: [...new Set([...(action.dependsOn ?? []), ...dependencies])] })
  : actions;
/** Puts the removal of a failed app environment ahead of the shared steps, which then wait for it. */
export const withRepairFirst = (repair: PlanAction | undefined, actions: PlanAction[], prior: string[] = []): PlanAction[] => repair
  ? [{ ...repair, ...(prior.length ? { dependsOn: prior } : {}) }, ...withDependencies(actions, [repair.id])]
  : actions;
const changing = (actions: PlanAction[]) => actions.filter((action) => action.type !== 'noop').map((action) => action.id);

/**
 * The step that removes a shared app environment Azure failed to create, when one is in the way.
 * Nothing is planned for a working environment, one Hypervibe did not tag, or an unreadable answer.
 */
export async function azureFailedEnvironmentAction(context: Pick<AzureEngineContext, 'tokens' | 'shared' | 'connection'>): Promise<PlanAction | undefined> {
  const observed = await observeFailedAppEnvironment(context.tokens, context.shared.appsEnvironmentId, context.shared.label).catch(() => 'other' as const);
  if (observed !== 'failed') return undefined;
  const name = context.shared.appsEnvironmentId.split('/').at(-1)!;
  return {
    id: 'shared-repair:apps', type: 'destroy', verified: true, requiresConfirm: true, resource: { kind: 'service', name: 'failed shared app environment', provider: 'azure' },
    reason: `Azure failed to create the shared app environment ${name} in an earlier attempt and left it behind unusable. Hypervibe will delete it so it can be created again. It never ran anything.`,
    metadata: { operation: AZURE_FAILED_ENVIRONMENT_OPERATION, subscriptionId: context.connection.subscriptionId },
  };
}

/**
 * Role assignments the plan would create that already exist in Azure for the
 * environment's runtime identity, with the same scope and role: an earlier
 * apply created them and lost the reply. Unknown reads block the plan.
 */
export async function leftoverRoleAssignments(context: AzureEngineContext, input: AzureEngineInput, actions: PlanAction[]): Promise<{ adopt: Record<string, string> } | { unknown: string }> {
  const creating = actions.flatMap((action) => engineSegmentOf(action)?.addresses ?? []).filter((address) => address.startsWith('azurerm_role_assignment.'));
  if (!creating.length) return { adopt: {} };
  const group = `/subscriptions/${context.connection.subscriptionId}/resourceGroups/${context.connection.resourceGroup}`;
  const tokens = context.tokens;
  const configuration = buildAzureEnvironmentConfiguration(input);
  const base = (configuration.files['base.tf.json'] as { resource?: { azurerm_role_assignment?: Record<string, { scope: string; role_definition_id: string; principal_id: string }>; azurerm_user_assigned_identity?: Record<string, { name: string }> } }).resource ?? {};
  const desired = base.azurerm_role_assignment ?? {};
  const storageId = `${group}/providers/Microsoft.Storage/storageAccounts/${azureStorageAccountName({ subscriptionId: context.connection.subscriptionId, environmentId: context.environment.id, prefix: context.prefix })}`;
  // An assignment is taken over only from the identity it is planned for: the shared identity's role on a secret
  // must never be adopted as a service identity's, or the reverse.
  const identityOf = (address: string) => /^\$\{azurerm_user_assigned_identity\.([a-z0-9_]+)\.principal_id\}$/.exec(desired[address.replace(/^azurerm_role_assignment\./, '')]?.principal_id ?? '')?.[1];
  const adopt: Record<string, string> = {};
  for (const identityKey of [...new Set(creating.map(identityOf).filter((key): key is string => Boolean(key)))].sort((a, b) => Number(b === 'runtime') - Number(a === 'runtime') || a.localeCompare(b))) {
    const name = base.azurerm_user_assigned_identity?.[identityKey]?.name;
    if (!name) continue;
    const label = identityKey === 'runtime' ? 'the runtime identity' : `identity ${name}`;
    const identity = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}?api-version=2023-01-31`).catch(() => undefined);
    if (!identity) return { unknown: `Hypervibe could not read ${label} from Azure; try again.` };
    if (identity.status === 404) continue;
    const principalId = (identity.body.properties as { principalId?: string } | undefined)?.principalId;
    if (identity.status !== 200 || !principalId) return { unknown: `Hypervibe could not read ${label} from Azure (HTTP ${identity.status}).` };
    const listed = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${group}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(`principalId eq '${principalId}'`)}`).catch(() => undefined);
    if (!listed || listed.status !== 200) return { unknown: `Hypervibe could not list the roles of ${label} in Azure (HTTP ${listed?.status ?? 'none'}).` };
    const existing = ((listed.body.value ?? []) as Array<{ id?: string; properties?: { scope?: string; roleDefinitionId?: string; principalId?: string } }>)
      .filter((entry) => entry.properties?.principalId === undefined || entry.properties.principalId.toLowerCase() === principalId.toLowerCase());
    for (const address of creating.filter((entry) => identityOf(entry) === identityKey)) {
      const wanted = desired[address.replace(/^azurerm_role_assignment\./, '')]!;
      const scope = wanted.scope.replace('${azurerm_storage_account.files.id}', storageId).toLowerCase();
      const role = wanted.role_definition_id.split('/').pop()!.toLowerCase();
      const match = existing.find((entry) => entry.properties?.scope?.toLowerCase() === scope && entry.properties?.roleDefinitionId?.split('/').pop()?.toLowerCase() === role);
      if (match?.id) adopt[address] = match.id;
    }
  }
  return { adopt };
}

/** The local commit an infrastructure plan builds when the environment has no image yet. */
async function localCommit(project: Project): Promise<{ directory: string; commitSha: string } | undefined> {
  const directory = localRepositoryFor(project, new SpecStore().get(project)?.source as { kind?: string; path?: string } | undefined);
  if (!directory) return undefined;
  const { execFileSync } = await import('child_process');
  try {
    const commitSha = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(commitSha) ? { directory, commitSha } : undefined;
  } catch {
    return undefined;
  }
}

export async function planAzureInfrastructureEngine(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; environmentName: string;
}): Promise<InfrastructurePlanResult | { blocked: string[]; missingOutsideKeys?: string[] }> {
  const { project, spec, environmentName } = params;
  const environmentSpec = spec.environments[environmentName]!;
  const problems = azureEngineProblems(spec, environmentName);
  if (problems.length) return { blocked: problems };
  const context = await resolveAzureEngineContext(ctx, project, environmentName);
  if ('blocked' in context) return { blocked: [context.blocked] };

  if (engineCiIntent(spec, environmentName)) {
    const ready = await azureCiSetupReady(context.connection).catch(() => false);
    if (!ready) return { blocked: ['Azure CI access needs reviewed setup. Run hv_launch (or hv_connections provider="azure" action="connect") to update access.'] };
  }

  // Outside keys must already have a value; Hypervibe never invents them.
  const store = azureEnvironmentSecretStore(context);
  const keys = azureEnvironmentSecretKeys(spec, environmentName, importedOf(context.environment));
  const secrets = await planEngineSecrets({
    environmentName, generated: keys.generated, outside: keys.outside, optional: optionalOutsideKeys(spec, environmentName),
    observe: (key) => store.observe(key),
    action: (key, stored) => ({
      id: `secret:${key}`, type: stored ? 'noop' : 'create', verified: true, resource: { kind: 'secret', name: key, provider: 'azure' },
      reason: stored ? `Secret ${key} is stored in Key Vault.` : `Hypervibe will generate ${key} and store it in Key Vault (${context.vault.name}/${azureVaultSecretName(environmentName, key)}).`,
      metadata: { operation: AZURE_SECRET_OPERATION, subscriptionId: context.connection.subscriptionId, key },
    }),
  });
  if ('blocked' in secrets) return secrets;
  const secretActions = secrets.actions;

  const engine = await engineFor();
  if ('blocked' in engine) return { blocked: [engine.blocked] };
  // 1. The shared server and registry (a separate state, so other testing environments keep them).
  const sharedPlanId = crypto.randomUUID();
  const sharedLocation = azureSharedLocation(spec, azureTestingEnvironments(spec), context.connection);
  if (typeof sharedLocation === 'object') return { blocked: [sharedLocation.blocked] };
  const sharedInput = buildAzureSharedInput(spec, context, azureTestingEnvironments(spec));
  const sharedPlanned = await engine.plan({ backend: azureEngineBackend, configuration: buildAzureSharedConfiguration(sharedInput), auth: context.auth, state: context.shared.state, planId: sharedPlanId });
  if (!sharedPlanned.ok) return { blocked: [redactEngineOutput(sharedPlanned.error, context.auth.redact)] };
  if (sharedPlanned.blockers.length) return { blocked: sharedPlanned.blockers };
  // A failed earlier attempt can leave the app environment in Azure but not in the engine's state.
  const repair = sharedPlanned.actions.some((action) => action.id === 'shared:apps' && action.type === 'create') ? await azureFailedEnvironmentAction(context) : undefined;
  const sharedActions = withRepairFirst(repair, sharedPlanned.actions);
  const sharedChanging = changing(sharedActions);
  // Connections made before 2026-11-17 never turned on Azure networking; only the subscription Owner can.
  let networkingUnchecked = false;
  if (sharedChanging.includes('shared:network')) {
    const networking = await azureRest(context.tokens, AZURE_SCOPES.arm, 'GET', `${ARM}/subscriptions/${context.connection.subscriptionId}/providers/Microsoft.Network?api-version=2021-04-01`).catch(() => undefined);
    if (networking?.status === 200 && networking.body.registrationState !== 'Registered') {
      return { blocked: ['The database now lives in a private network, and networking (Microsoft.Network) is not turned on for this Azure subscription yet. Run hv_connections provider="azure" action="connect" (one sign-in) to turn it on, then plan again.'] };
    }
    networkingUnchecked = networking?.status !== 200;
  }

  const buildInput = buildAzureEngineInput(spec, environmentName, context, { secretKeys: [...keys.all, ...keys.build].filter((key) => !secrets.unset?.includes(key)) });
  const buildPlanId = crypto.randomUUID();
  const buildPlanned = await engine.plan({ backend: azureEngineBackend, configuration: buildAzureBuildConfiguration(buildInput), auth: context.auth, state: context.buildState, planId: buildPlanId });
  if (!buildPlanned.ok) return { blocked: [redactEngineOutput(buildPlanned.error, context.auth.redact)] };
  if (buildPlanned.blockers.length) return { blocked: buildPlanned.blockers };
  const buildInfrastructureActions = withDependencies(buildPlanned.actions, [...sharedChanging, ...changing(secretActions)]);

  // 2. The image. Built in this apply from the local commit when the environment has none, so the
  //    workloads are created in this same apply (no second plan round).
  const binding = azureBinding(context.environment);
  const workloads = Object.keys(environmentSpec.services).length;
  const commit = !binding.image && workloads ? await localCommit(project) : undefined;
  const buildRegistry = azureSelectedBuildRegistry(buildInput);
  const image = binding.image ?? (commit ? `${buildRegistry.loginServer}/${AZURE_IMAGE_REPOSITORY}:${commit.commitSha}` : undefined);
  const buildActions: PlanAction[] = commit ? [{
    id: 'build:image', type: 'create', verified: true, resource: { kind: 'service', name: 'image', provider: 'azure' },
    reason: `Hypervibe will build commit ${commit.commitSha.slice(0, 12)} with ACR Tasks (about 2 cents) so the workloads start from it.`,
    dependsOn: [...sharedChanging, ...changing(buildInfrastructureActions), ...changing(secretActions)],
    metadata: { operation: AZURE_IMAGE_BUILD_OPERATION, subscriptionId: context.connection.subscriptionId, commitSha: commit.commitSha, directory: commit.directory },
  }] : [];

  // 3. The environment's database and login on the server, before the workloads that read DATABASE_URL.
  const needsWaker = Object.values(environmentSpec.services).some((service) => service.onDemand);
  const loginActions: PlanAction[] = environmentSpec.database && (!binding.databaseLoginAt || (needsWaker && !binding.wakerLoginAt)) ? [{
    id: 'database-login:postgres', type: 'create', verified: true, resource: { kind: 'secret', name: ENGINE_DATABASE_URL_KEY, provider: 'azure' },
    reason: `Hypervibe will create ${environmentName}'s database and login on ${context.shared.serverName}${needsWaker ? ', and a read-only login for the worker\'s scale rule' : ''}, and store ${ENGINE_DATABASE_URL_KEY} in Key Vault. The server stays closed to the internet: the step runs as a short job inside the project's private network.`,
    // The setup job runs in the shared app environment, so it waits for that and its network as well as the server.
    dependsOn: sharedChanging.filter((id) => ['shared:database', 'shared:apps', 'shared:network'].includes(id)),
    metadata: { operation: AZURE_DATABASE_LOGIN_OPERATION, subscriptionId: context.connection.subscriptionId, host: context.shared.databaseHost, waker: needsWaker },
  }] : [];

  // 4. Everything else, in the environment's own state.
  // An optional key without a value is left out, so no workload references a Key Vault secret that does not exist.
  let input = buildAzureEngineInput(spec, environmentName, context, { secretKeys: keys.all.filter((key) => !secrets.unset?.includes(key)), ...(image ? { image } : {}) });
  let planId = crypto.randomUUID();
  let planned = await engine.plan({ backend: azureEngineBackend, configuration: buildAzureEnvironmentConfiguration(input), auth: context.auth, state: context.state, planId });
  if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
  if (planned.blockers.length) return { blocked: planned.blockers };
  // An apply interrupted after Azure created a role assignment leaves it unrecorded; take it over instead of colliding.
  const leftovers = await leftoverRoleAssignments(context, input, planned.actions);
  if ('unknown' in leftovers) return { blocked: [leftovers.unknown] };
  if (Object.keys(leftovers.adopt).length) {
    input = { ...input, adoptRoleAssignments: leftovers.adopt };
    planId = crypto.randomUUID();
    planned = await engine.plan({ backend: azureEngineBackend, configuration: buildAzureEnvironmentConfiguration(input), auth: context.auth, state: context.state, planId });
    if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
    if (planned.blockers.length) return { blocked: planned.blockers };
  }
  const prerequisites = [...sharedChanging, ...changing(secretActions), ...changing(buildInfrastructureActions), ...changing(buildActions), ...changing(loginActions)];
  const actions = [...sharedActions, ...secretActions, ...buildInfrastructureActions, ...buildActions, ...loginActions, ...withDependencies(planned.actions, prerequisites)];
  const warnings = [
    `Azure ${azureLocationFor(spec, environmentName, context.connection)}, testing profile: workloads scale to zero. All testing environments share one private network (about $26/month) and one database server (about $24/month with its private endpoint), which the internet cannot reach.`,
    ...(planned.actions.some((action) => action.id === 'environment:base' && action.type !== 'noop') ? [`${environmentName}'s apps move into the project's shared private app environment: they are recreated, are briefly unavailable, and get new addresses.`] : []),
    ...(networkingUnchecked ? ['Hypervibe could not check that networking (Microsoft.Network) is turned on for this subscription. If the apply reports that the subscription is not registered for it, run hv_connections provider="azure" action="connect" and apply again.'] : []),
    ...(Object.keys(input.secretServices ?? {}).length ? [`Limited secrets (${Object.entries(input.secretServices!).map(([key, services]) => `${key}: ${services.join(', ') || 'no service'}`).join('; ')}): each named service runs as its own identity, and no other workload's identity can read them. A value that other services held before this apply stays known to them; rotate it afterwards.`] : []),
    ...(!image && workloads ? ['Hypervibe could not find this project\'s local repository, so the workloads are created after the first image build: run hv_deploy after this apply, then plan again.'] : []),
  ];
  return recordPlan(project, context, params, actions, warnings, { planId, build: { planId: buildPlanId, state: context.buildState }, shared: { planId: sharedPlanId, state: context.shared.state } });
}

/**
 * Plans removing an Azure environment completely, as one reviewed plan with
 * every destructive action confirmed: storage is emptied, OpenTofu destroys the
 * environment's resources, its database and logins are dropped from the shared
 * server, the shared network, app environment, server and registry go only when no testing environment uses them,
 * and Hypervibe confirms nothing tagged for the environment remains.
 */
export async function planAzureTeardown(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; environmentName: string; deleteFinalSnapshot?: boolean;
}): Promise<InfrastructurePlanResult | { blocked: string[] }> {
  const { project, spec, environmentName } = params;
  if (!spec.environments[environmentName]) return { blocked: [`${environmentName} is not an environment in the spec.`] };
  if (params.deleteFinalSnapshot) {
    return { blocked: ['Azure Flexible Server has no final snapshot to keep or delete: a dropped database is gone, and the server\'s automatic backups (7 days) cover it only while the server exists. Plan the teardown without deleteFinalSnapshot.'] };
  }
  const context = await resolveAzureEngineContext(ctx, project, environmentName);
  if ('blocked' in context) return { blocked: [context.blocked] };
  const engine = await engineFor();
  if ('blocked' in engine) return { blocked: [engine.blocked] };
  const environmentSpec = spec.environments[environmentName]!;
  const binding = azureBinding(context.environment);
  const keys = azureEnvironmentSecretKeys(spec, environmentName, importedOf(context.environment));
  const input = buildAzureEngineInput(spec, environmentName, context, { secretKeys: keys.all, image: binding.image ?? `${context.shared.registryLoginServer}/${AZURE_IMAGE_REPOSITORY}:none` });
  const planId = crypto.randomUUID();
  const planned = await engine.plan({ backend: azureEngineBackend, configuration: buildAzureEnvironmentConfiguration(input), auth: context.auth, state: context.state, planId, destroy: true });
  if (!planned.ok) return { blocked: [redactEngineOutput(planned.error, context.auth.redact)] };
  if (planned.blockers.length) return { blocked: planned.blockers };
  const subscriptionId = context.connection.subscriptionId;
  const destroying = planned.actions.filter((action) => action.type !== 'noop');
  const account = azureStorageAccountName({ subscriptionId, environmentId: context.environment.id, prefix: context.prefix });
  const emptyActions: PlanAction[] = (input.storage ?? []).filter((bucket) => destroying.some((action) => action.id === `storage:${bucket.name}`)).map((bucket) => ({
    id: `storage-empty:${bucket.name}`, type: 'destroy', verified: true, dataBearing: true, requiresConfirm: true,
    resource: { kind: 'storage', name: bucket.name, provider: 'azure' },
    reason: `Hypervibe will permanently delete every file in ${account}/${bucket.container} so it can be removed.`,
    metadata: { operation: AZURE_STORAGE_EMPTY_OPERATION, subscriptionId, account, container: bucket.container },
  }));
  const environmentActions = withDependencies(destroying, changing(emptyActions));

  const buildPlanId = crypto.randomUUID();
  const buildPlanned = await engine.plan({ backend: azureEngineBackend, configuration: buildAzureBuildConfiguration({ ...input, ...(keys.build[0] ? { packageTokenKey: keys.build[0] } : {}) }), auth: context.auth, state: context.buildState, planId: buildPlanId, destroy: true });
  if (!buildPlanned.ok) return { blocked: [redactEngineOutput(buildPlanned.error, context.auth.redact)] };
  if (buildPlanned.blockers.length) return { blocked: buildPlanned.blockers };
  const buildActions = withDependencies(buildPlanned.actions.filter((action) => action.type !== 'noop'), changing(environmentActions));

  // The shared network, app environment, server and registry stay while another testing environment uses them.
  const remaining = azureTestingEnvironments(spec).filter((name) => name !== environmentName);
  let sharedActions: PlanAction[] = [];
  let shared: Record<string, unknown> = {};
  if (!remaining.length) {
    const sharedPlanId = crypto.randomUUID();
    const sharedPlanned = await engine.plan({ backend: azureEngineBackend, configuration: buildAzureSharedConfiguration(buildAzureSharedInput(spec, context, [environmentName])),
      auth: context.auth, state: context.shared.state, planId: sharedPlanId, destroy: true });
    if (!sharedPlanned.ok) return { blocked: [redactEngineOutput(sharedPlanned.error, context.auth.redact)] };
    if (sharedPlanned.blockers.length) return { blocked: sharedPlanned.blockers };
    sharedActions = withDependencies(sharedPlanned.actions.filter((action) => action.type !== 'noop'), [...changing(environmentActions), ...changing(buildActions)]);
    // The engine cannot destroy an app environment it never recorded; a failed one is removed directly,
    // before the log workspace it points at (which the engine did record under the same step).
    sharedActions = withRepairFirst(await azureFailedEnvironmentAction(context), sharedActions, [...changing(environmentActions), ...changing(buildActions)]);
    shared = { shared: { planId: sharedPlanId, state: context.shared.state } };
  }
  const dropActions: PlanAction[] = environmentSpec.database && remaining.length ? [{
    id: 'database-drop:postgres', type: 'destroy', verified: true, dataBearing: true, requiresConfirm: true,
    resource: { kind: 'database', name: `${environmentName} database`, provider: 'azure' },
    reason: `Hypervibe will permanently delete ${environmentName}'s database and logins from the shared server ${context.shared.serverName}. Other environments' databases are untouched. The server stays closed to the internet: the step runs as a short job inside the project's private network.`,
    ...(changing(environmentActions).length ? { dependsOn: changing(environmentActions) } : {}),
    metadata: { operation: AZURE_DATABASE_DROP_OPERATION, subscriptionId, host: context.shared.databaseHost },
  }] : [];
  const cleanup: PlanAction = {
    id: 'cleanup:leftovers', type: 'destroy', verified: true, requiresConfirm: true,
    resource: { kind: 'secret', name: 'environment leftovers', provider: 'azure' },
    reason: `Hypervibe will delete and purge ${environmentName}'s secrets in Key Vault (${context.vault.name}, names starting ${azureVaultSecretName(environmentName, 'x').slice(0, -1)}), confirm nothing tagged for it remains${!remaining.length ? ' (nor the shared network, app environment, server and registry)' : ''}, and remove it from the spec.`,
    dependsOn: [...changing(environmentActions), ...changing(buildActions), ...changing(sharedActions), ...changing(dropActions)],
    metadata: { operation: AZURE_TEARDOWN_CLEANUP_OPERATION, subscriptionId, sharedRemoved: !remaining.length },
  };
  if (!cleanup.dependsOn!.length) delete cleanup.dependsOn;
  const actions = [...emptyActions, ...environmentActions, ...buildActions, ...dropActions, ...sharedActions, cleanup];
  const warnings = [
    `Removes Azure environment ${environmentName} (${azureLocationFor(spec, environmentName, context.connection)}, resource group ${context.connection.resourceGroup}). This cannot be undone.`,
    ...(environmentSpec.database ? ['Azure keeps no final snapshot of a deleted database; export it first if you need the data.'] : []),
    !remaining.length ? 'No other testing environment uses the shared network, app environment, server and registry, so they are removed too.' : `The shared network, app environment, server and registry stay for ${remaining.join(', ')}.`,
    `Hypervibe's access (resource group, Key Vault, deploy identity) stays, for other environments of ${project.name}.`,
  ];
  return recordPlan(project, context, params, actions, warnings, { planId, teardown: true, build: { planId: buildPlanId, state: context.buildState }, ...shared });
}

export interface AzureApplyDependencies {
  /** Runs a psql script on the server from inside the project's private network; tests replace it. */
  setupSql?: (context: AzureEngineContext, host: string, script: string) => Promise<void>;
  /** Milliseconds between checks while waiting on Azure; tests use 0. */
  pollMs?: number;
  buildImage?: (context: AzureEngineContext, source: { directory: string; commitSha: string }) => Promise<{ image: string; logsUrl?: string } | { error: string; unknown?: boolean; logsUrl?: string }>;
}

function updateBinding(ctx: CommandContext, context: AzureEngineContext, patch: Partial<AzureEngineBinding>): void {
  const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
  ctx.repos.environments.updatePlatformBindings(current.id, { azure: { ...azureBindingToSave(current), kind: 'opentofu', ...patch } });
}

/** Handles one non-engine action of an Azure plan; exported for tests. */
export async function runAzureAction(ctx: CommandContext, context: AzureEngineContext, action: PlanAction, params: { project: Project; spec: ProjectSpec }, deps: AzureApplyDependencies = {}): Promise<ActionResult> {
  const metadata = (action.metadata ?? {}) as Record<string, unknown>;
  const store = azureEnvironmentSecretStore(context);
  const setupSql = deps.setupSql ?? ((c: AzureEngineContext, host: string, script: string) => runAzureSetupSql(c.tokens, {
    id: `/subscriptions/${c.connection.subscriptionId}/resourceGroups/${c.connection.resourceGroup}/providers/Microsoft.App/jobs/${azureResourceName(c.prefix, 'dbsetup', c.legacyNames)}`,
    environmentId: c.shared.appsEnvironmentId, host, user: azureDeployAppName(c.project.name),
  }, script));
  switch (metadata.operation) {
    case AZURE_SECRET_OPERATION: {
      const key = String(metadata.key);
      const existing = await store.observe(key);
      if (existing === 'present') return { success: true, message: `${key} already exists.` };
      if (typeof existing === 'object') return { success: false, status: 'blocked', message: existing.unknown };
      const failed = await store.write(key, crypto.randomBytes(32).toString('base64url'));
      return failed ? { success: false, message: failed } : { success: true, message: `Stored a generated ${key} in Key Vault.` };
    }
    case AZURE_IMAGE_BUILD_OPERATION: {
      if (engineCiIntent(params.spec, context.environmentName) && !azureBinding(context.environment).buildRegistry) {
        const engine = await engineFor();
        if ('blocked' in engine) return { success: false, status: 'blocked', message: engine.blocked };
        const observed = await engine.inspectState({ backend: azureEngineBackend,
          configuration: buildAzureBuildConfiguration(buildAzureEngineInput(params.spec, context.environmentName, context, { secretKeys: [] })),
          auth: context.auth, state: context.buildState,
          project: (state) => projectAzureCiRegistry(state, { subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup, environmentId: context.environment.id }),
        });
        if (!observed.ok || !observed.present) return { success: false, status: 'blocked', message: 'The applied environment build registry could not be verified; image builds stopped.' };
        updateBinding(ctx, context, { buildRegistry: observed.value });
        context.environment = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
      }
      const build = deps.buildImage ?? (await import('./infrastructure-engine-azure-release.js')).buildAzureImage;
      const built = await build(context, { directory: String(metadata.directory), commitSha: String(metadata.commitSha) });
      if ('error' in built) return { success: false, ...(built.unknown ? { status: 'pending' as const } : {}), message: built.error, error: built.error, ...(built.logsUrl ? { data: { buildLogsUrl: built.logsUrl } } : {}) };
      updateBinding(ctx, context, { image: built.image, imageCommit: String(metadata.commitSha) });
      return { success: true, message: `Built ${built.image}.`, data: { imageUri: built.image, ...(built.logsUrl ? { buildLogsUrl: built.logsUrl } : {}) } };
    }
    case AZURE_DATABASE_LOGIN_OPERATION: {
      const { script, ...urls } = environmentDatabaseSetup({ host: String(metadata.host), environmentName: context.environmentName, waker: Boolean(metadata.waker) });
      await setupSql(context, String(metadata.host), script);
      for (const [key, value] of [[ENGINE_DATABASE_URL_KEY, urls.databaseUrl], ...(urls.wakerUrl ? [[WAKER_SECRET_KEY, urls.wakerUrl]] : [])] as Array<[string, string]>) {
        const failed = await store.write(key, value);
        if (failed) return { success: false, message: failed };
      }
      const now = new Date().toISOString();
      updateBinding(ctx, context, { database: {
        serverId: context.shared.serverId,
        subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup, host: String(metadata.host),
        name: azureDatabaseNames(context.environmentName).database, owner: azureDatabaseNames(context.environmentName).login,
        secretUrl: `${context.vault.uri}secrets/${azureVaultSecretName(context.environmentName, ENGINE_DATABASE_URL_KEY)}`,
      }, databaseLoginAt: now, ...(urls.wakerUrl ? { wakerLoginAt: now } : {}) });
      return { success: true, message: `Created ${context.environmentName}'s database login and stored ${ENGINE_DATABASE_URL_KEY} in Key Vault.` };
    }
    case AZURE_STORAGE_EMPTY_OPERATION: {
      const emptied = await emptyContainer(context.tokens, String(metadata.account), String(metadata.container));
      if ('error' in emptied) return { success: false, message: emptied.error };
      return { success: true, message: 'gone' in emptied ? `${metadata.container} no longer exists.` : `Deleted ${emptied.deleted} file(s) from ${metadata.container}.` };
    }
    case AZURE_DATABASE_DROP_OPERATION: {
      await setupSql(context, String(metadata.host), environmentDatabaseDrop(context.environmentName));
      return { success: true, message: `Deleted ${context.environmentName}'s database and logins.` };
    }
    case AZURE_FAILED_ENVIRONMENT_OPERATION: {
      // Checked again now: only an environment that is still failed, and still Hypervibe's, is deleted.
      const observed = await observeFailedAppEnvironment(context.tokens, context.shared.appsEnvironmentId, context.shared.label);
      if (observed === 'absent') return { success: true, message: 'The failed shared app environment is already gone.' };
      if (typeof observed === 'object') return { success: false, status: 'blocked', message: observed.unknown };
      if (observed !== 'failed') return { success: false, status: 'blocked', message: 'The shared app environment is no longer in a failed state, so Hypervibe did not delete it. Run hv_plan again.' };
      const failed = await deleteFailedAppEnvironment(context.tokens, context.shared.appsEnvironmentId, { pollMs: deps.pollMs });
      return failed ? { success: false, message: failed } : { success: true, message: 'Deleted the shared app environment Azure had failed to create.' };
    }
    case AZURE_TEARDOWN_CLEANUP_OPERATION: {
      const purged = await purgeVaultSecrets(context.tokens, context.vault.uri, azureVaultSecretName(context.environmentName, 'x').slice(0, -1));
      if ('error' in purged) return { success: false, message: purged.error };
      const { subscriptionId, resourceGroup } = context.connection;
      const left = await taggedResources(context.tokens, subscriptionId, resourceGroup, 'hv-environment', context.environment.id.toLowerCase());
      if (!Array.isArray(left)) return { success: false, status: 'blocked', message: left.unknown };
      const sharedLeft = metadata.sharedRemoved ? await taggedResources(context.tokens, subscriptionId, resourceGroup, 'hv-shared', context.shared.label) : [];
      if (!Array.isArray(sharedLeft)) return { success: false, status: 'blocked', message: sharedLeft.unknown };
      if (left.length || sharedLeft.length) return { success: false, message: `These resources still exist: ${[...left, ...sharedLeft].join(', ')}. Run the teardown plan again.` };
      const current = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
      const { azure: _azure, engine: _engine, ...rest } = current.platformBindings as Record<string, unknown>;
      ctx.repos.environments.updatePlatformBindings(current.id, { ...rest, engine: {}, azure: { tornDownAt: new Date().toISOString() } });
      // The environment is gone; removing it from the spec keeps the next plan from recreating it.
      new SpecStore().merge(params.project, specWithoutEnvironment(params.spec, context.environmentName));
      return { success: true, message: `Purged ${purged.removed} secret(s) from Key Vault and confirmed nothing of ${context.environmentName} remains.` };
    }
    default:
      return { success: false, status: 'blocked', message: `No engine-stage authority exists for ${action.id}.` };
  }
}

export async function applyAzureInfrastructureEngine(ctx: CommandContext, params: {
  project: Project; spec: ProjectSpec; specRevision: number; planId: string; confirmActions: string[];
}, deps: AzureApplyDependencies = {}): Promise<{ kind: 'executed'; envName: string; result: ConvergeResult } | { kind: 'blocked'; reason: string }> {
  const executor = new ConvergeExecutor();
  const loaded = executor.loadPlan(params.planId);
  if ('error' in loaded) return { kind: 'blocked', reason: loaded.error };
  type Reviewed = { teardown?: boolean; planId: string; state: EngineStateIdentity; build?: { planId: string; state: EngineStateIdentity }; shared?: { planId: string; state: EngineStateIdentity }; azure?: { subscriptionId: string; resourceGroup: string; prefix: string } };
  const document = loaded.document as PlanRunDocument & { engine?: Reviewed };
  const environmentName = document.environmentName;
  const reviewed = document.engine;
  if (!reviewed?.azure || !isAzureEngineEnvironment(params.spec, environmentName)) return { kind: 'blocked', reason: 'This plan is not an Azure engine plan. Re-run hv_plan.' };
  const context = await resolveAzureEngineContext(ctx, params.project, environmentName);
  if ('blocked' in context) return { kind: 'blocked', reason: context.blocked };
  if (JSON.stringify(reviewed.state) !== JSON.stringify(context.state) || (reviewed.build && JSON.stringify(reviewed.build.state) !== JSON.stringify(context.buildState)) || (reviewed.shared && JSON.stringify(reviewed.shared.state) !== JSON.stringify(context.shared.state))
    || reviewed.azure.subscriptionId !== context.connection.subscriptionId || reviewed.azure.resourceGroup !== context.connection.resourceGroup || reviewed.azure.prefix !== context.prefix) {
    return { kind: 'blocked', reason: 'The reviewed plan targets a different Azure subscription, resource group or environment. Re-run hv_plan.' };
  }
  clearEngineCiBinding(ctx, context.environment);
  const engine = await engineFor();
  if ('blocked' in engine) return { kind: 'blocked', reason: engine.blocked };
  const result = await executor.execute({
    planRunId: params.planId, currentSpecRevision: params.specRevision, confirmActions: params.confirmActions,
    handler: async (action) => {
      if ((action.metadata as { subscriptionId?: string } | undefined)?.subscriptionId !== context.connection.subscriptionId) {
        return { success: false, status: 'blocked', message: 'Azure target changed; re-run hv_plan.' };
      }
      try {
        return await runAzureAction(ctx, context, action, params, deps);
      } catch (error) {
        return { success: false, message: redactEngineOutput(error instanceof Error ? `${error.name}: ${error.message}` : String(error), [...context.auth.redact]) };
      }
    },
    segmentHandler: async (segment, members) => {
      const addresses = [...new Set(members.flatMap((member) => engineSegmentOf(member)?.addresses ?? []))];
      const target = reviewed.shared && segment.id === `opentofu:${reviewed.shared.planId}` ? reviewed.shared : reviewed.build && segment.id === `opentofu:${reviewed.build.planId}` ? reviewed.build : { planId: reviewed.planId, state: context.state };
      const outcome = await engine.apply({ backend: azureEngineBackend, auth: context.auth, state: target.state, planId: target.planId,
        segment: { ...segment, addresses }, approvedAddresses: addresses });
      if (!reviewed.teardown && reviewed.build?.planId === target.planId && (engineCiIntent(params.spec, environmentName) || azureBinding(context.environment).buildRegistry)) {
        const inspected = await engine.inspectState({ backend: azureEngineBackend, configuration: buildAzureBuildConfiguration(buildAzureEngineInput(params.spec, environmentName, context, { secretKeys: [] })),
          auth: context.auth, state: context.buildState,
          project: (state) => projectAzureCiRegistry(state, { subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup, environmentId: context.environment.id }),
        });
        if (inspected.ok && inspected.present) {
          updateBinding(ctx, context, { buildRegistry: inspected.value });
          context.environment = ctx.repos.environments.findById(context.environment.id) ?? context.environment;
        } else if (addresses.includes('azurerm_container_registry.ci_images') && outcome.outcomes['azurerm_container_registry.ci_images'] === 'succeeded') {
          outcome.outcomes['azurerm_container_registry.ci_images'] = 'unknown';
          outcome.diagnostics.push('The build registry was applied but its exact state identity could not be verified; image builds stopped.');
        }
      }
      return { ...outcome, diagnostics: outcome.diagnostics.map((line) => redactEngineOutput(line, context.auth.redact)) };
    },
  });
  // This also repairs pre-diagnostics bindings on an ordinary no-op apply.
  // A teardown owns binding removal separately; never resurrect its identities.
  if (result.applyRunId && !(document.engine as { teardown?: boolean }).teardown) {
    const sharedApps = await engine.inspectState({ backend: azureEngineBackend, configuration: { files: {}, resources: {} }, auth: context.auth, state: context.shared.state, project: projectAzureSharedApps });
    const apps = sharedApps.ok && sharedApps.present && sharedApps.value.managedEnvironmentId?.toLowerCase() === context.shared.appsEnvironmentId.toLowerCase() ? sharedApps.value : {};
    const recorded = await recordEngineWorkloadBindings(ctx, engine, { environment: context.environment, backend: azureEngineBackend,
      auth: context.auth, state: context.state, provider: 'azure', projectId: context.connection.subscriptionId, environmentId: context.connection.resourceGroup,
      project: (state) => projectAzureWorkloadBindings(state, params.spec.environments[environmentName]!.services, { subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup, location: azureLocationFor(params.spec, environmentName, context.connection) }, apps) });
    if (!recorded.ok) return { kind: 'executed', envName: environmentName, result: { ...result, success: false, error: recorded.error } };
  }
  await recordEngineCiBindings(ctx, engine, { provider: 'azure', context, spec: params.spec, environmentName,
    location: azureLocationFor(params.spec, environmentName, context.connection),
    succeeded: Boolean(result.success && result.applyRunId && !(document.engine as { teardown?: boolean }).teardown) });
  return { kind: 'executed', envName: environmentName, result };
}
