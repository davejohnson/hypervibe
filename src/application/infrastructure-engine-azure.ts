import { AzureEngineCredentialsSchema, type AzureEngineCredentials } from '../adapters/providers/azure/azure-engine.adapter.js';
import { azureGlobalNames, type AzureEngineInput } from '../adapters/providers/azure/tofu/azure-engine.config.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../adapters/secrets/secret-store.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { azureDeployAppName } from './azure-setup.js';
import type { CommandContext } from './context.js';
import { ENGINE_DATABASE_URL_KEY, engineSecretKeys } from './infrastructure-engine.js';

/**
 * The OpenTofu lifecycle for Azure environments. This milestone builds the
 * configuration (see docs/opentofu-engine-azure.md); plans stay blocked until
 * Hypervibe can also write the environment's secrets to Key Vault, create the
 * app's database login and build images, so an apply can never leave an app
 * half-built.
 */
export type AzureProfile = 'production' | 'testing';

/** production and staging share one shape; everything else is a cheap testing environment. */
export function azureProfileFor(environmentName: string): AzureProfile {
  return /prod|stag/i.test(environmentName) ? 'production' : 'testing';
}

export function isAzureEngineEnvironment(spec: ProjectSpec, environmentName: string): boolean {
  const environment = spec.environments[environmentName];
  return environment?.hosting.engine === 'opentofu' && environment.hosting.provider === 'azure';
}

export interface AzureEngineBinding {
  kind?: 'opentofu';
  /** Image built by the release path; services are created once it exists. */
  image?: string;
  /** The app's database login exists and DATABASE_URL is in Key Vault. */
  databaseLoginAt?: string;
}

export function azureBinding(environment: Environment): AzureEngineBinding {
  return ((environment.platformBindings as { azure?: AzureEngineBinding }).azure) ?? {};
}

/** Container App names allow 32 characters; the prefix keeps environments apart. */
export function azurePrefix(project: string, environmentName: string): string {
  return `hv-${project}-${environmentName}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20).replace(/-+$/, '');
}

export function azureResourceName(prefix: string, service: string): string {
  return `${prefix}-${service}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 32).replace(/-+$/, '');
}

/** Desired state the Azure engine cannot build yet; listed problems block planning instead of being ignored. */
export function azureEngineProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName]!;
  const problems: string[] = [];
  if (azureProfileFor(environmentName) === 'production') {
    problems.push(`${environmentName} uses the production profile (always-on web and database), which the Azure engine does not build yet. Testing environments are supported.`);
  }
  if (environment.database && environment.database.provider !== 'azure-postgres') problems.push('The Azure engine manages databases only with provider "azure-postgres".');
  if (environment.cache) problems.push('Redis caches are not available on the Azure engine yet.');
  if (Object.keys(environment.queues ?? {}).length) problems.push('Queues are not available on the Azure engine yet.');
  if (environment.domain) problems.push('Custom domains are not available on the Azure engine yet; use the service URL or route traffic with domainTarget.');
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.workloadKind === 'worker') problems.push(`${name} is a background worker; workers (Container Apps scaled by KEDA) are not built on Azure yet.`);
    if (service.workloadKind === 'cron') problems.push(`${name} is a scheduled job; Container Apps Jobs are not built on Azure yet.`);
  }
  for (const [name, storage] of Object.entries(environment.storage ?? {})) {
    if (storage.provider !== 'azureblob') problems.push(`Storage ${name}: the Azure engine manages containers only with provider "azureblob".`);
    if (storage.access === 's3') problems.push(`Storage ${name}: Azure Blob Storage has no S3-compatible API; use the Azure SDK (access "native").`);
  }
  return problems;
}

/** What is not built yet for every Azure environment, whatever its spec. */
export const AZURE_PLAN_NOT_BUILT = 'Azure plans are not available yet. Hypervibe can connect Azure and build the environment\'s configuration, but cannot yet write its secrets to Key Vault, create the database login or build images on Azure, so applying would leave the app half-built.';

export function azureContainerName(storage: string): string {
  return storage.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').padEnd(3, '0').slice(0, 63);
}

export function buildAzureEngineInput(spec: ProjectSpec, environmentName: string, context: {
  connection: Pick<AzureEngineCredentials, 'tenantId' | 'subscriptionId' | 'resourceGroup' | 'location' | 'deployPrincipalId'>;
  project: string;
  environment: Pick<Environment, 'id'> & Partial<Pick<Environment, 'platformBindings'>>;
}, extra: { secretKeys: string[] }): AzureEngineInput {
  const environmentSpec = spec.environments[environmentName]!;
  const prefix = azurePrefix(context.project, environmentName);
  const image = context.environment.platformBindings ? azureBinding(context.environment as Environment).image : undefined;
  const storageAccount = azureGlobalNames({ subscriptionId: context.connection.subscriptionId, environmentId: context.environment.id, prefix }).storage;
  const services = Object.entries(environmentSpec.services).sort(([a], [b]) => a.localeCompare(b));
  const envFor = (service: string): Record<string, string> => {
    const buckets = Object.entries(environmentSpec.storage ?? {}).filter(([, storage]) => storage.injectInto.includes(service)).map(([name]) => name);
    if (buckets.length > 1) throw new Error(`Service ${service} can receive only one storage container's variables.`);
    // The runtime identity is the credential (the configuration adds AZURE_CLIENT_ID); storage accounts have no shared keys.
    const storage: Record<string, string> = buckets[0] ? {
      OBJECT_STORAGE_PROVIDER: 'azureblob', OBJECT_STORAGE_BUCKET: azureContainerName(buckets[0]), AZURE_STORAGE_ACCOUNT_NAME: storageAccount,
      AZURE_STORAGE_CONTAINER_NAME: azureContainerName(buckets[0]), AZURE_STORAGE_BLOB_ENDPOINT: `https://${storageAccount}.blob.core.windows.net/`,
    } : {};
    for (const key of Object.keys(storage)) if (key in environmentSpec.envVars) throw new Error(`Environment variable ${key} conflicts with storage ${buckets[0]}.`);
    return { PORT: '8080', ...environmentSpec.envVars, ...storage };
  };
  return {
    tenantId: context.connection.tenantId, subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup,
    location: context.connection.location, prefix, environmentId: context.environment.id,
    deployPrincipalId: context.connection.deployPrincipalId, deployPrincipalName: azureDeployAppName(context.project),
    ...(environmentSpec.database ? { database: { version: environmentSpec.database.version ?? 17 } } : {}),
    storage: Object.keys(environmentSpec.storage ?? {}).sort().map((name) => ({ name, container: azureContainerName(name) })),
    // Workloads need an image in this environment's registry, so they are created after the first build.
    services: (image ? services : []).filter(([, service]) => (service.workloadKind ?? 'web') === 'web').map(([logicalName, service]) => {
      const env = envFor(logicalName);
      const port = Number(env.PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Service ${logicalName}: PORT must be a port number.`);
      return {
        logicalName, resourceName: azureResourceName(prefix, logicalName), initialImage: image!, public: service.public ?? true, targetPort: port, env,
        ...(service.healthCheckPath ? { healthCheckPath: service.healthCheckPath } : {}),
      };
    }),
    secretKeys: extra.secretKeys,
  };
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

/**
 * Plans an Azure environment. Blocked for now: lists everything in the spec the
 * engine cannot build, then what is missing for every Azure environment.
 */
export async function planAzureInfrastructureEngine(_ctx: CommandContext, params: { project: Project; spec: ProjectSpec; environmentName: string }): Promise<{ blocked: string[] }> {
  const blocked = azureEngineProblems(params.spec, params.environmentName);
  const access = resolveAzureConnection(params.project);
  if ('blocked' in access) blocked.push(access.blocked);
  blocked.push(AZURE_PLAN_NOT_BUILT);
  return { blocked };
}

/** Secret keys an Azure environment's services reference (Hypervibe-owned secrets plus the database URL once its login exists). */
export function azureSecretKeys(spec: ProjectSpec, environmentName: string, binding: AzureEngineBinding): string[] {
  return [...engineSecretKeys(spec, environmentName), ...(spec.environments[environmentName]?.database && binding.databaseLoginAt ? [ENGINE_DATABASE_URL_KEY] : [])];
}
