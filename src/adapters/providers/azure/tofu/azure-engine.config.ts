import { addAzureMonitoring, addAzureSharedDatabaseMonitoring } from './azure-monitoring.config.js';
import type { ObserverFederation } from '../../../../domain/spec/runtime-observation.js';
import { azureCiRegistry, azureSelectedBuildRegistry, type AzureBuildRegistry } from '../azure-ci-registry.js';
import { azureBuildTaskContent, azureBuildTaskName } from '../azure-build-task.js';
import crypto from 'crypto';
import type { EngineCiIntent } from '../../../../domain/spec/engine-ci.js';
import { addAzureObserverConfiguration } from './azure-observer.config.js';
import { addAzureCiConfiguration } from './azure-engine-ci.config.js';
import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';

/**
 * Pure OpenTofu configurations for Azure. Two states per environment:
 *
 * - the **shared** state holds the private network, the Container Apps environment
 *   and its logs, the PostgreSQL server (reached only through a private endpoint in
 *   that network) and the image registry. All of a project's testing environments
 *   share them (one database and login each); staging and production will each
 *   get their own.
 * - the **environment** state holds everything else: the runtime identity and its
 *   roles, storage and the workloads.
 *
 * Values are non-secret. Runtime secrets live in the project's Key Vault (created
 * at setup, written by Hypervibe) and reach the apps as Key Vault references; the
 * server's administrator password is ephemeral and write-only. See
 * docs/opentofu-engine-azure.md.
 */
interface AzurePlacement {
  tenantId: string;
  subscriptionId: string;
  /** The project's resource group, created by setup; the deploy identity's roles stop at it. */
  resourceGroup: string;
  location: string;
  /** Short stable prefix for names, e.g. `hv-billforge-test` or `hv-billforge-shared`. */
  prefix: string;
}

export interface AzureSharedInput extends AzurePlacement {
  kind: 'shared';
  /** Which environments share these resources: `testing`, or one staging/production environment's name. */
  label: string;
  /** Object id and display name of the deploy identity: the server's Entra administrator. */
  deployPrincipalId: string;
  deployPrincipalName: string;
  /** PostgreSQL major version; omitted when no environment in the group has a database. */
  database?: { version: number; skuName?: string; storageMb?: number; monitorStorage?: true };
}

export interface AzureSharedNames { server: string; registry: string }

/** The shared Container Apps environment's name; a virtual network can only be chosen when it is created. */
export const azureAppsEnvironmentName = (sharedPrefix: string): string => `${sharedPrefix}-apps`;
/** Private address space of the shared network: apps in the first /23, private endpoints after it. */
export const AZURE_NETWORK = { space: '10.61.0.0/16', apps: '10.61.0.0/23', endpoints: '10.61.2.0/27' } as const;

export interface AzureEngineInput extends AzurePlacement {
  ci?: EngineCiIntent;
  observation?: ObserverFederation & { workspaceResourceId: string };
  monitoring?: { project: string; postgresServerId?: string };
  previousObserverServices?: string[];
  kind?: 'environment';
  /** Environment id stamped on owned resources so adoption can prove ownership. */
  environmentId: string;
  /** Environment name; prefixes this environment's Key Vault secret names. */
  environmentName: string;
  /** The shared registry and Container Apps environment this environment uses, by Azure id. */
  shared: { registryId: string; registryLoginServer: string; appsEnvironmentId: string };
  /** The project's Key Vault (created at setup). */
  vault: { id: string; uri: string };
  storage?: Array<{ name: string; container: string; versioning?: boolean; browserUploads?: boolean }>;
  services?: AzureWebServiceInput[];
  workers?: AzureWorkerInput[];
  jobs?: AzureJobInput[];
  /** Runtime secrets every workload reads, by environment variable name; each must exist in Key Vault before apply. */
  secretKeys?: string[];
  /**
   * Secrets limited to named services: environment variable name → logical service names. A named service runs as its
   * own identity, and only those identities may read the secret. Omitted: every workload shares the runtime identity.
   */
  secretServices?: Record<string, string[]>;
  /** Services that receive storage variables. Read only for a service with its own identity, which gets the storage role only when listed. */
  storageServices?: string[];
  /** Declared, present package token; only the build task can read it. */
  packageTokenKey?: string;
  /** Exact applied CI registry retained even when branch CI is disabled. */
  buildRegistry?: AzureBuildRegistry;
  /** Role assignments an interrupted apply created but the engine never recorded: address → Azure id, imported instead of recreated. */
  adoptRoleAssignments?: Record<string, string>;
}

interface AzureWorkloadInput {
  logicalName: string;
  /** Container App or job name (2-32 characters). */
  resourceName: string;
  /** Image for first creation; the release path owns it afterwards. */
  initialImage: string;
  /** Non-secret configuration only; secrets come from Key Vault references. */
  env?: Record<string, string>;
  command?: string[];
  /** vCPU and GiB; consumption pairs them (0.25/0.5, 0.5/1, ...). */
  cpu?: number;
  memory?: number;
}

export interface AzureWebServiceInput extends AzureWorkloadInput {
  public: boolean;
  targetPort: number;
  healthCheckPath?: string;
  maxReplicas?: number;
}

export interface AzureWorkerInput extends AzureWorkloadInput {
  /**
   * Scale from zero while this read-only count is above zero (KEDA's PostgreSQL
   * scaler, once a minute, with the waker login in WAKER_SECRET_KEY).
   */
  pendingWorkQuery?: string;
}

export interface AzureJobInput extends AzureWorkloadInput {
  /** Five-field cron, UTC. */
  schedule: string;
  timeoutSeconds?: number;
}

/** Key Vault secret holding the read-only connection string an on-demand worker's scale rule counts with. */
export const WAKER_SECRET_KEY = 'HV_WAKER_URL';

export const azureKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

/** Container Apps secret name for an environment variable: DATABASE_URL -> database-url. */
export function azureSecretName(key: string): string {
  const name = key.toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error(`Secret ${key} cannot be stored in Key Vault under a valid name.`);
  return name;
}

/** The project Key Vault keeps every environment's secrets; names start with the environment: test--database-url. */
export function azureVaultSecretName(environmentName: string, key: string): string {
  const environment = environmentName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${environment || 'env'}--${azureSecretName(key)}`;
}

const suffixOf = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('/')).digest('hex').slice(0, 6);
const compact = (value: string) => value.replace(/[^a-z0-9]/g, '');

/** Globally unique names get a short suffix from the subscription, so they are stable and never collide with another tenant's. */
export function azureSharedNames(input: Pick<AzureSharedInput, 'subscriptionId' | 'prefix' | 'label'>): AzureSharedNames {
  const suffix = suffixOf(input.subscriptionId, input.prefix, input.label);
  return { server: `${input.prefix.slice(0, 56).replace(/-+$/, '')}-${suffix}`, registry: `${compact(input.prefix).slice(0, 44)}${suffix}` };
}

export function azureStorageAccountName(input: Pick<AzureEngineInput, 'subscriptionId' | 'environmentId' | 'prefix'>): string {
  return `${compact(input.prefix).slice(0, 18)}${suffixOf(input.subscriptionId, input.environmentId)}`;
}

/** The project's Key Vault, created by setup: 3-24 characters, globally unique. */
export function azureProjectVaultName(subscriptionId: string, project: string): string {
  const slug = project.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 13).replace(/-+$/, '');
  return `hv-${slug || 'app'}-${suffixOf(subscriptionId, project)}`;
}

/** Five-field cron that Container Apps Jobs accept. */
export function azureCron(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*,/\-A-Za-z?]+$/.test(field))) throw new Error(`Schedule "${schedule}" must be five cron fields.`);
  return fields.join(' ');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d',
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6',
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
};

function checkPlacement(input: AzurePlacement): void {
  for (const [field, value] of [['tenant', input.tenantId], ['subscription', input.subscriptionId]] as const) {
    if (!UUID.test(value)) throw new Error(`Azure ${field} id is invalid.`);
  }
  if (!/^hv-[a-z0-9-]{1,60}$/.test(input.resourceGroup)) throw new Error('Azure resource group is invalid.');
  if (!/^[a-z][a-z0-9]{2,30}$/.test(input.location)) throw new Error('Azure location is invalid.');
  if (!/^[a-z][a-z0-9-]{2,24}[a-z0-9]$/.test(input.prefix)) throw new Error('Azure name prefix is invalid.');
}

export function azureProviderFile(input: AzurePlacement): unknown {
  return { provider: { azurerm: [{
    subscription_id: input.subscriptionId, tenant_id: input.tenantId,
    // Setup registered the resource providers with the subscription Owner; the deploy identity cannot.
    resource_provider_registrations: 'none',
    // Storage accounts have shared keys turned off, so the provider uses Entra ID for them too.
    storage_use_azuread: true,
    features: [{ resource_group: [{ prevent_deletion_if_contains_resources: true }] }],
  }] } };
}

export function buildAzureConfiguration(input: AzureEngineInput | AzureSharedInput): EngineConfiguration {
  return input.kind === 'shared' ? buildAzureSharedConfiguration(input) : buildAzureEnvironmentConfiguration(input);
}

/** The network, Container Apps environment, server and registry a group of environments shares. */
export function buildAzureSharedConfiguration(input: AzureSharedInput): EngineConfiguration {
  checkPlacement(input);
  if (!UUID.test(input.deployPrincipalId)) throw new Error('Azure deploy identity id is invalid.');
  const names = azureSharedNames(input);
  const tags = { 'managed-by': 'hypervibe', 'hv-shared': input.label };
  const placed = { resource_group_name: input.resourceGroup, location: input.location, tags };
  const registry: EngineResourceMapping = { actionId: 'shared:registry', kind: 'service', name: 'shared image registry', billable: true };
  const network: EngineResourceMapping = { actionId: 'shared:network', kind: 'service', name: 'shared private network', billable: true };
  const apps: EngineResourceMapping = { actionId: 'shared:apps', kind: 'service', name: 'shared app environment', billable: true };
  const resources: Record<string, EngineResourceMapping> = {
    'azurerm_container_registry.images': registry,
    'azurerm_virtual_network.main': network, 'azurerm_subnet.apps': network, 'azurerm_subnet.endpoints': network,
    'azurerm_log_analytics_workspace.logs': apps, 'azurerm_container_app_environment.main': apps,
  };
  const subnet = (name: string, range: string, extra: Record<string, unknown> = {}) => ({
    name, resource_group_name: input.resourceGroup, virtual_network_name: '${azurerm_virtual_network.main.name}', address_prefixes: [range], ...extra });
  const files: Record<string, unknown> = {
    'provider.tf.json': azureProviderFile(input),
    // The database is reachable only inside this network, so the apps must run in it. A Container Apps
    // environment can join a network only when it is created, which is why the group shares one.
    'network.tf.json': {
      resource: {
        azurerm_virtual_network: { main: { name: `${input.prefix}-net`, ...placed, address_space: [AZURE_NETWORK.space] } },
        azurerm_subnet: {
          apps: subnet('apps', AZURE_NETWORK.apps, { delegation: [{ name: 'apps', service_delegation: [{ name: 'Microsoft.App/environments',
            actions: ['Microsoft.Network/virtualNetworks/subnets/join/action'] }] }] }),
          endpoints: subnet('endpoints', AZURE_NETWORK.endpoints),
        },
      },
    },
    'apps.tf.json': {
      resource: {
        azurerm_log_analytics_workspace: { logs: { name: `${input.prefix}-logs`, ...placed, sku: 'PerGB2018', retention_in_days: 30,
          // About 4.5 GB a month: inside Log Analytics' 5 GB monthly free allowance.
          daily_quota_gb: 0.15 } },
        // Consumption profile only: no dedicated profile, private endpoint or maintenance window (those bill
        // $0.10/hour). Joining a network bills its load balancer and two public addresses instead.
        azurerm_container_app_environment: { main: { name: azureAppsEnvironmentName(input.prefix), ...placed,
          log_analytics_workspace_id: '${azurerm_log_analytics_workspace.logs.id}', logs_destination: 'log-analytics',
          infrastructure_subnet_id: '${azurerm_subnet.apps.id}',
          workload_profile: [{ name: 'Consumption', workload_profile_type: 'Consumption' }],
          // Azure fills in the profile's details and names the resource group holding the load balancer; neither is drift.
          lifecycle: [{ ignore_changes: ['workload_profile', 'infrastructure_resource_group_name'] }] } },
      },
      output: { apps_environment_id: { value: '${azurerm_container_app_environment.main.id}' }, log_workspace_id: { value: '${azurerm_log_analytics_workspace.logs.workspace_id}' } },
    },
    'registry.tf.json': {
      // Basic: $0.1666/day with 10 GB. Images build with ACR Tasks; no admin user or anonymous pull.
      resource: { azurerm_container_registry: { images: { name: names.registry, ...placed, sku: 'Basic', admin_enabled: false, anonymous_pull_enabled: false } } },
      output: { registry_id: { value: '${azurerm_container_registry.images.id}' }, registry_login_server: { value: '${azurerm_container_registry.images.login_server}' } },
    },
  };
  // The server: the administrator password is generated by an ephemeral resource and sent write-only, so
  // nobody (state included) holds it. Hypervibe administers it as the deploy identity with Entra tokens.
  if (input.database) {
    if (!Number.isInteger(input.database.version) || input.database.version < 13 || input.database.version > 18) throw new Error(`PostgreSQL ${input.database.version} is not supported.`);
    const server: EngineResourceMapping = { actionId: 'shared:database', kind: 'database', name: 'shared database server', dataBearing: true, billable: true,
      costAttributes: ['sku_name', 'storage_mb', 'storage_tier'] };
    for (const address of ['azurerm_postgresql_flexible_server.postgres', 'azurerm_postgresql_flexible_server_active_directory_administrator.deploy',
      'azurerm_private_dns_zone.postgres', 'azurerm_private_dns_zone_virtual_network_link.postgres', 'azurerm_private_endpoint.postgres',
      // Retired: the rule that let every address reach the server. Mapping it lets the plan remove it from older projects.
      'azurerm_postgresql_flexible_server_firewall_rule.public']) resources[address] = server;
    files['database.tf.json'] = {
      ephemeral: { random_password: { postgres_admin: { length: 40, special: false } } },
      resource: {
        azurerm_postgresql_flexible_server: { postgres: {
          name: names.server, ...placed, version: String(input.database.version),
          sku_name: input.database.skuName ?? 'B_Standard_B1ms', storage_mb: input.database.storageMb ?? 32768, auto_grow_enabled: true,
          backup_retention_days: 7, geo_redundant_backup_enabled: false,
          // Never reachable from the internet. Hypervibe creates logins from a job inside the network (runAzureSetupSql).
          public_network_access_enabled: false,
          administrator_login: 'hvadmin', administrator_password_wo: '${ephemeral.random_password.postgres_admin.result}', administrator_password_wo_version: 1,
          authentication: [{ active_directory_auth_enabled: true, password_auth_enabled: true, tenant_id: input.tenantId }],
          // Azure picks the zone; ordinary infrastructure also preserves native backup policy.
          lifecycle: [{ ignore_changes: ['zone', 'backup_retention_days', 'geo_redundant_backup_enabled'] }],
        } },
        azurerm_postgresql_flexible_server_active_directory_administrator: { deploy: {
          server_name: '${azurerm_postgresql_flexible_server.postgres.name}', resource_group_name: input.resourceGroup, tenant_id: input.tenantId,
          object_id: input.deployPrincipalId, principal_name: input.deployPrincipalName, principal_type: 'ServicePrincipal',
        } },
        // The apps reach the server through this endpoint; the zone makes the server's usual host name
        // resolve to its private address inside the network, so DATABASE_URL does not change.
        azurerm_private_dns_zone: { postgres: { name: 'privatelink.postgres.database.azure.com', resource_group_name: input.resourceGroup, tags } },
        azurerm_private_dns_zone_virtual_network_link: { postgres: { name: `${input.prefix}-net`,
          private_dns_zone_id: '${azurerm_private_dns_zone.postgres.id}', virtual_network_id: '${azurerm_virtual_network.main.id}', registration_enabled: false, tags } },
        azurerm_private_endpoint: { postgres: { name: `${input.prefix}-postgres`, ...placed, subnet_id: '${azurerm_subnet.endpoints.id}',
          private_service_connection: [{ name: 'postgres', private_connection_resource_id: '${azurerm_postgresql_flexible_server.postgres.id}',
            subresource_names: ['postgresqlServer'], is_manual_connection: false }],
          private_dns_zone_group: [{ name: 'default', private_dns_zone_ids: ['${azurerm_private_dns_zone.postgres.id}'] }],
          depends_on: ['azurerm_private_dns_zone_virtual_network_link.postgres'] } },
      },
      output: { database_host: { value: '${azurerm_postgresql_flexible_server.postgres.fqdn}' } },
    };
  }
  if (input.database?.monitorStorage) addAzureSharedDatabaseMonitoring(input, files, resources);
  return { files, resources };
}

/** One environment: everything except what its group shares. */
export function buildAzureEnvironmentConfiguration(input: AzureEngineInput): EngineConfiguration {
  checkPlacement(input);
  const tags = { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() };
  const placed = { resource_group_name: input.resourceGroup, location: input.location, tags };
  const resources: Record<string, EngineResourceMapping> = {};
  const roleAssignment = (scope: string, role: string, description: string, identity = 'runtime') => ({
    scope, role_definition_id: `/subscriptions/${input.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
    principal_id: `\${azurerm_user_assigned_identity.${identity}.principal_id}`, principal_type: 'ServicePrincipal', description,
  });

  const workers = input.workers ?? [];
  const onDemand = workers.some((worker) => worker.pendingWorkQuery);
  const secretKeys = [...new Set([...(input.secretKeys ?? []).filter((key) => !['NODE_AUTH_TOKEN', 'NPM_TOKEN'].includes(key)), ...(onDemand ? [WAKER_SECRET_KEY] : [])])];
  const secrets = secretKeys.map((key) => ({ key, name: azureSecretName(key), vaultName: azureVaultSecretName(input.environmentName, key) }));
  const seen = new Map<string, string>();
  for (const { key, name } of secrets) {
    if (seen.has(name)) throw new Error(`Secrets ${seen.get(name)} and ${key} map to the same Key Vault name ${name}.`);
    seen.set(name, key);
  }
  // A secret limited to named services is an access boundary: each named service runs as its own identity, and the
  // identity every other workload shares holds no role on that secret.
  const scopes = new Map(Object.entries(input.secretServices ?? {}));
  for (const key of scopes.keys()) {
    if (key === WAKER_SECRET_KEY || ['NODE_AUTH_TOKEN', 'NPM_TOKEN'].includes(key)) throw new Error(`Secret ${key} cannot be limited to named services on Azure.`);
  }
  const ownIdentity = new Set([...scopes.values()].flat());
  const identityOf = (logicalName: string) => ownIdentity.has(logicalName) ? `app_${azureKey(logicalName)}` : 'runtime';
  /** The secrets one workload may read. The shared identity never reads a limited secret, whoever asks. */
  const secretsOf = (logicalName: string, scaleRule: boolean) => ownIdentity.has(logicalName)
    ? secrets.filter(({ key }) => key === WAKER_SECRET_KEY ? scaleRule : (scopes.get(key)?.includes(logicalName) ?? true))
    : secrets.filter(({ key }) => !scopes.has(key));

  // Retired: each environment used to have its own Container Apps environment and logs, outside any network.
  // Mapping them lets the plan remove them from older environments, whose apps move to the shared one.
  const base: EngineResourceMapping = { actionId: 'environment:base', kind: 'service', name: 'old app environment', billable: true };
  const runtime: EngineResourceMapping = { actionId: 'identity:runtime', kind: 'service', name: 'runtime' };
  resources['azurerm_log_analytics_workspace.logs'] = base;
  resources['azurerm_container_app_environment.main'] = base;
  resources['azurerm_user_assigned_identity.runtime'] = runtime;
  resources['azurerm_role_assignment.runtime_pull'] = runtime;
  resources['time_sleep.roles'] = runtime;
  const assignments: Record<string, unknown> = {
    runtime_pull: roleAssignment(input.shared.registryId, ROLE.acrPull, 'Hypervibe: the app pulls its images'),
  };
  const buildRegistry = azureSelectedBuildRegistry(input);
  if (buildRegistry.id !== input.shared.registryId) {
    assignments.runtime_ci_pull = roleAssignment(buildRegistry.id, ROLE.acrPull, 'Hypervibe: the app pulls images built for this environment');
    resources['azurerm_role_assignment.runtime_ci_pull'] = runtime;
  }
  // One role per secret, so an environment reads only its own secrets in the project vault.
  for (const secret of secrets.filter(({ key }) => !scopes.has(key))) {
    const key = `secret_${azureKey(secret.key)}`;
    assignments[key] = roleAssignment(`${input.vault.id}/secrets/${secret.vaultName}`, ROLE.keyVaultSecretsUser, `Hypervibe: the app reads ${secret.key}`);
    resources[`azurerm_role_assignment.${key}`] = runtime;
  }
  const buckets = input.storage ?? [];
  if (buckets.length) {
    assignments.runtime_storage = roleAssignment('${azurerm_storage_account.files.id}', ROLE.storageBlobDataContributor, 'Hypervibe: the app reads and writes its files');
    resources['azurerm_role_assignment.runtime_storage'] = runtime;
  }
  // One identity for each service a limited secret names, holding what that service needs and nothing else:
  // image pulls, its own secrets, and storage when it uses storage.
  const identities: Record<string, unknown> = { runtime: { name: `${input.prefix}-runtime`, ...placed } };
  const sharedAssignments = Object.keys(assignments);
  const sleeps: Record<string, unknown> = {};
  const scaled = new Set(workers.filter((worker) => worker.pendingWorkQuery).map((worker) => worker.logicalName));
  for (const workload of [...(input.services ?? []), ...workers, ...(input.jobs ?? [])].filter((entry) => ownIdentity.has(entry.logicalName))) {
    const identity = identityOf(workload.logicalName);
    if (identity in identities) throw new Error(`Services limited to a secret need distinct names; ${workload.logicalName} repeats another service's.`);
    const mapping: EngineResourceMapping = { actionId: `identity:service:${workload.logicalName}`, kind: 'service', name: `${workload.logicalName} identity` };
    const own: string[] = [];
    const assign = (name: string, assignment: unknown) => {
      const key = `${identity}_${name}`;
      if (key in assignments) throw new Error(`Role assignment ${key} is ambiguous; rename service ${workload.logicalName}.`);
      assignments[key] = assignment; own.push(key);
      resources[`azurerm_role_assignment.${key}`] = mapping;
    };
    identities[identity] = { name: `${workload.resourceName}-id`, ...placed };
    resources[`azurerm_user_assigned_identity.${identity}`] = mapping;
    assign('pull', roleAssignment(input.shared.registryId, ROLE.acrPull, `Hypervibe: ${workload.logicalName} pulls its images`, identity));
    if (buildRegistry.id !== input.shared.registryId) assign('ci_pull', roleAssignment(buildRegistry.id, ROLE.acrPull, `Hypervibe: ${workload.logicalName} pulls images built for this environment`, identity));
    for (const secret of secretsOf(workload.logicalName, scaled.has(workload.logicalName))) {
      assign(`secret_${azureKey(secret.key)}`, roleAssignment(`${input.vault.id}/secrets/${secret.vaultName}`, ROLE.keyVaultSecretsUser, `Hypervibe: ${workload.logicalName} reads ${secret.key}`, identity));
    }
    if (buckets.length && (input.storageServices ?? []).includes(workload.logicalName)) {
      assign('storage', roleAssignment('${azurerm_storage_account.files.id}', ROLE.storageBlobDataContributor, `Hypervibe: ${workload.logicalName} reads and writes its files`, identity));
    }
    // A changed set of roles waits again, so the revision that first uses a new role starts after it applied.
    sleeps[`roles_${identity}`] = { create_duration: '90s', triggers: { roles: own.join(',') }, depends_on: own.map((key) => `azurerm_role_assignment.${key}`) };
    resources[`time_sleep.roles_${identity}`] = mapping;
  }
  for (const address of Object.keys(input.adoptRoleAssignments ?? {})) {
    if (!(address.replace(/^azurerm_role_assignment\./, '') in assignments)) throw new Error(`Only a desired role assignment can be adopted (${address}).`);
  }
  const files: Record<string, unknown> = {
    ...(Object.keys(input.adoptRoleAssignments ?? {}).length
      ? { 'imports.tf.json': { import: Object.entries(input.adoptRoleAssignments!).map(([to, id]) => ({ to, id })) } } : {}),
    'provider.tf.json': azureProviderFile(input),
    'base.tf.json': {
      resource: {
        azurerm_user_assigned_identity: identities,
        azurerm_role_assignment: assignments,
        // New role assignments take a minute or two to apply; the first revision pulls and reads secrets right away.
        // With a limited secret the shared wait is tied to the shared identity's role set, so it waits again when a
        // limit is added or removed (removing one gives the shared identity a new role its apps then rely on).
        time_sleep: { roles: { create_duration: '90s', depends_on: sharedAssignments.map((key) => `azurerm_role_assignment.${key}`),
          ...(scopes.size ? { triggers: { roles: [...sharedAssignments].sort().join(',') } } : {}) }, ...sleeps },
      },
    },
  };

  if (buckets.length) {
    const account: EngineResourceMapping = { actionId: 'storage:account', kind: 'storage', name: 'account', dataBearing: true, billable: true };
    resources['azurerm_storage_account.files'] = account;
    const containers: Record<string, unknown> = {};
    for (const bucket of buckets) {
      if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(bucket.container)) throw new Error(`Storage container name ${bucket.container} is invalid.`);
      const key = azureKey(bucket.name);
      containers[key] = { name: bucket.container, storage_account_id: '${azurerm_storage_account.files.id}', container_access_type: 'private' };
      resources[`azurerm_storage_container.${key}`] = { actionId: `storage:${bucket.name}`, kind: 'storage', name: bucket.name, dataBearing: true, billable: true };
    }
    files['storage.tf.json'] = {
      resource: {
        azurerm_storage_account: { files: { name: azureStorageAccountName(input), ...placed, account_kind: 'StorageV2', account_tier: 'Standard', account_replication_type: 'LRS',
          https_traffic_only_enabled: true, min_tls_version: 'TLS1_2', allow_nested_items_to_be_public: false, shared_access_key_enabled: false,
          default_to_oauth_authentication: true, cross_tenant_replication_enabled: false,
          ...(buckets[0]!.versioning || buckets[0]!.browserUploads ? { blob_properties: [{
            ...(buckets[0]!.versioning ? { delete_retention_policy: [{ days: 30 }] } : {}),
            ...(buckets[0]!.browserUploads ? { cors_rule: [{ allowed_methods: ['PUT', 'POST', 'GET', 'HEAD'], allowed_origins: ['*'],
              allowed_headers: ['*'], exposed_headers: ['ETag', 'x-ms-request-id'], max_age_in_seconds: 3600 }] } : {}),
          }] } : {}) } },
        azurerm_storage_container: containers,
      },
      output: { storage_blob_endpoint: { value: '${azurerm_storage_account.files.primary_blob_endpoint}' } },
    };
  }

  const container = (workload: AzureWorkloadInput, extra: Record<string, unknown> = {}, scaleRule = false) => {
    const conflicts = Object.keys(workload.env ?? {}).filter((name) => secretKeys.includes(name) || name === 'AZURE_CLIENT_ID');
    if (conflicts.length) throw new Error(`${conflicts.join(', ')} ${conflicts.length === 1 ? 'is' : 'are'} set by Hypervibe; remove ${conflicts.length === 1 ? 'it' : 'them'} from envVars.`);
    return {
      name: 'app', image: workload.initialImage, cpu: workload.cpu ?? 0.25, memory: `${workload.memory ?? 0.5}Gi`,
      ...(workload.command ? { command: workload.command } : {}),
      env: [
        // Literal values: OpenTofu would otherwise read ${...} and %{...} in them as templates.
        ...Object.entries(workload.env ?? {}).filter(([key]) => !['NODE_AUTH_TOKEN', 'NPM_TOKEN'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value: value.replace(/([$%])\{/g, '$1$1{') })),
        // DefaultAzureCredential picks the runtime identity with this; it is an id, not a secret.
        { name: 'AZURE_CLIENT_ID', value: `\${azurerm_user_assigned_identity.${identityOf(workload.logicalName)}.client_id}` },
        ...secretsOf(workload.logicalName, scaleRule).filter(({ key }) => key !== WAKER_SECRET_KEY).map(({ key, name }) => ({ name: key, secret_name: name })),
      ],
      ...extra,
    };
  };
  // Exactly one identity is attached to a workload: code inside it can ask for a token of any identity attached to it.
  const platform = (workload: AzureWorkloadInput, scaleRule = false) => {
    const identity = identityOf(workload.logicalName);
    const id = `\${azurerm_user_assigned_identity.${identity}.id}`;
    return {
      resource_group_name: input.resourceGroup, container_app_environment_id: input.shared.appsEnvironmentId, tags,
      identity: [{ type: 'UserAssigned', identity_ids: [id] }],
      registry: [...new Set([input.shared.registryLoginServer, buildRegistry.loginServer])].map((server) => ({ server, identity: id })),
      secret: secretsOf(workload.logicalName, scaleRule).map(({ name, vaultName }) => ({ name, key_vault_secret_id: `${input.vault.uri}secrets/${vaultName}`, identity: id })),
      // The pull and secret roles must have applied before the first revision starts.
      depends_on: [identity === 'runtime' ? 'time_sleep.roles' : `time_sleep.roles_${identity}`],
    };
  };
  const checkName = (name: string) => {
    if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(name) || name.includes('--')) throw new Error(`Container App name ${name} is invalid.`);
  };

  const apps: Record<string, unknown> = {};
  const outputs: Record<string, unknown> = {};
  for (const service of input.services ?? []) {
    checkName(service.resourceName);
    const key = azureKey(service.logicalName);
    resources[`azurerm_container_app.${key}`] = { actionId: `service:${service.logicalName}`, kind: 'service', name: service.logicalName, billable: true,
      costAttributes: ['template.*.container.*.cpu', 'template.*.container.*.memory', 'template.*.min_replicas', 'template.*.max_replicas'] };
    const probe = service.healthCheckPath ? { path: service.healthCheckPath, port: service.targetPort, transport: 'HTTP' } : undefined;
    apps[key] = {
      name: service.resourceName, revision_mode: 'Single', ...platform(service),
      ingress: [{ external_enabled: service.public, target_port: service.targetPort, transport: 'auto', allow_insecure_connections: false,
        traffic_weight: [{ latest_revision: true, percentage: 100 }] }],
      template: [{
        min_replicas: 0, max_replicas: service.maxReplicas ?? 2,
        container: [container(service, probe ? { readiness_probe: [probe], startup_probe: [probe] } : {})],
      }],
      // The release path (CI or hv_deploy) owns the image after creation.
      lifecycle: [{ ignore_changes: ['template[0].container[0].image', 'workload_profile_name'] }],
    };
    outputs[`service_${key}_url`] = { value: `https://\${azurerm_container_app.${key}.ingress[0].fqdn}` };
  }
  for (const worker of workers) {
    checkName(worker.resourceName);
    const key = azureKey(worker.logicalName);
    resources[`azurerm_container_app.${key}`] = { actionId: `service:${worker.logicalName}`, kind: 'service', name: worker.logicalName, billable: true,
      costAttributes: ['template.*.container.*.cpu', 'template.*.container.*.memory', 'template.*.min_replicas', 'template.*.max_replicas'] };
    apps[key] = {
      name: worker.resourceName, revision_mode: 'Single', ...platform(worker, Boolean(worker.pendingWorkQuery)),
      template: [{
        // On demand: KEDA counts pending work once a minute and starts one replica while it is above zero.
        // The server never pauses on Azure, so counting keeps nothing awake that would otherwise sleep.
        min_replicas: worker.pendingWorkQuery ? 0 : 1, max_replicas: 1,
        ...(worker.pendingWorkQuery ? {
          polling_interval_in_seconds: 60, cooldown_period_in_seconds: 300,
          custom_scale_rule: [{ name: 'pending-work', custom_rule_type: 'postgresql',
            metadata: { query: worker.pendingWorkQuery.trim().replace(/;\s*$/, '').replace(/([$%])\{/g, '$1$1{'), targetQueryValue: '1', activationTargetQueryValue: '0' },
            authentication: [{ secret_name: azureSecretName(WAKER_SECRET_KEY), trigger_parameter: 'connection' }] }],
        } : {}),
        container: [container(worker, {}, Boolean(worker.pendingWorkQuery))],
      }],
      lifecycle: [{ ignore_changes: ['template[0].container[0].image', 'workload_profile_name'] }],
    };
  }
  if (Object.keys(apps).length) files['apps.tf.json'] = { resource: { azurerm_container_app: apps }, ...(Object.keys(outputs).length ? { output: outputs } : {}) };

  const jobs: Record<string, unknown> = {};
  for (const job of input.jobs ?? []) {
    checkName(job.resourceName);
    const key = azureKey(job.logicalName);
    resources[`azurerm_container_app_job.${key}`] = { actionId: `service:${job.logicalName}`, kind: 'service', name: job.logicalName, billable: true,
      costAttributes: ['template.*.container.*.cpu', 'template.*.container.*.memory'] };
    const { container_app_environment_id, ...rest } = platform(job);
    jobs[key] = {
      name: job.resourceName, location: input.location, container_app_environment_id, ...rest,
      replica_timeout_in_seconds: job.timeoutSeconds ?? 1800, replica_retry_limit: 0,
      schedule_trigger_config: [{ cron_expression: azureCron(job.schedule), parallelism: 1, replica_completion_count: 1 }],
      template: [{ container: [container(job)] }],
      lifecycle: [{ ignore_changes: ['template[0].container[0].image', 'workload_profile_name'] }],
    };
  }
  if (Object.keys(jobs).length) files['jobs.tf.json'] = { resource: { azurerm_container_app_job: jobs } };
  addAzureCiConfiguration(input, files, resources);
  if (input.observation || input.previousObserverServices) {
    addAzureObserverConfiguration(input, files, resources);
  }
  if (input.monitoring || input.observation || input.previousObserverServices) addAzureMonitoring(input, files, resources);

  files['outputs.tf.json'] = { output: {
    runtime_identity_client_id: { value: '${azurerm_user_assigned_identity.runtime.client_id}' },
  } };
  return { files, resources };
}

/** The environment's private-package build identity, applied before its first image. */
export function buildAzureBuildConfiguration(input: AzureEngineInput): EngineConfiguration {
  checkPlacement(input);
  const files: Record<string, unknown> = { 'provider.tf.json': azureProviderFile(input) };
  const resources: Record<string, EngineResourceMapping> = {};
  const registry = azureSelectedBuildRegistry(input);
  const managedRegistry = Boolean(input.ci || input.buildRegistry);
  const resource: Record<string, unknown> = {};
  if (managedRegistry) {
    const expected = azureCiRegistry(input);
    resource.azurerm_container_registry = { ci_images: { name: expected.name, resource_group_name: input.resourceGroup, location: input.location,
      // Tasks get default data-plane access to their own registry only in RBAC-only mode.
      sku: 'Basic', admin_enabled: false, anonymous_pull_enabled: false, role_assignment_mode: 'LegacyRegistryPermissions',
      tags: { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() } } };
    resources['azurerm_container_registry.ci_images'] = { actionId: 'registry:ci-images', kind: 'service', name: 'CI image registry', billable: true, requiresConfirm: true };
  }
  // OpenTofu rejects an empty resource block, so the file exists only when something goes in it.
  if (!input.packageTokenKey && !managedRegistry) return { files, resources };
  files['builds.tf.json'] = { resource };
  if (input.packageTokenKey && !['NODE_AUTH_TOKEN', 'NPM_TOKEN'].includes(input.packageTokenKey)) throw new Error('Invalid package token key.');
  const secretName = input.packageTokenKey ? azureVaultSecretName(input.environmentName, input.packageTokenKey) : undefined;
  const mapping: EngineResourceMapping = { actionId: 'builds:images', kind: 'service', name: 'image builds' };
  Object.assign(resource, {
    azurerm_container_registry_task: { images: {
      name: azureBuildTaskName(input.prefix), container_registry_id: managedRegistry ? '${azurerm_container_registry.ci_images.id}' : registry.id,
      identity: [{ type: 'SystemAssigned' }], platform: [{ os: 'Linux', architecture: 'amd64' }],
      encoded_step: [{ task_content: Buffer.from(azureBuildTaskContent(secretName ? `${input.vault.uri}secrets/${secretName}` : undefined)).toString('base64'), values: { IMAGE_TAG: 'unrequested' } }],
      tags: { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() },
    } },
    ...(secretName ? { azurerm_role_assignment: { build_token: {
      scope: `${input.vault.id}/secrets/${secretName}`,
      role_definition_id: `/subscriptions/${input.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${ROLE.keyVaultSecretsUser}`,
      principal_id: '${azurerm_container_registry_task.images.identity[0].principal_id}', principal_type: 'ServicePrincipal',
      description: 'Hypervibe: image builds read the private package token',
    } },
    time_sleep: { build_roles: { create_duration: '90s', depends_on: ['azurerm_role_assignment.build_token'] } } } : {}),
  });
  for (const address of ['azurerm_container_registry_task.images', ...(secretName ? ['azurerm_role_assignment.build_token', 'time_sleep.build_roles'] : [])]) resources[address] = mapping;
  return { files, resources };
}
