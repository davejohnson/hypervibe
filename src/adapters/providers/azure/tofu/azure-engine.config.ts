import crypto from 'crypto';
import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';

/**
 * Pure OpenTofu configurations for Azure. Two states per environment:
 *
 * - the **shared** state holds the PostgreSQL server and image registry. All of a
 *   project's testing environments share one (one database and login each);
 *   staging and production will each get their own.
 * - the **environment** state holds everything else: logs, the Container Apps
 *   environment, the runtime identity and its roles, storage and the workloads.
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
  database?: { version: number; skuName?: string; storageMb?: number };
}

export interface AzureSharedNames { server: string; registry: string }

export interface AzureEngineInput extends AzurePlacement {
  kind?: 'environment';
  /** Environment id stamped on owned resources so adoption can prove ownership. */
  environmentId: string;
  /** Environment name; prefixes this environment's Key Vault secret names. */
  environmentName: string;
  /** The shared registry (and server) this environment uses, by Azure id. */
  shared: { registryId: string; registryLoginServer: string };
  /** The project's Key Vault (created at setup). */
  vault: { id: string; uri: string };
  storage?: Array<{ name: string; container: string }>;
  services?: AzureWebServiceInput[];
  workers?: AzureWorkerInput[];
  jobs?: AzureJobInput[];
  /** Runtime secrets every workload reads, by environment variable name; each must exist in Key Vault before apply. */
  secretKeys?: string[];
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

function providerFile(input: AzurePlacement): unknown {
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

/** The server and registry a group of environments shares. */
export function buildAzureSharedConfiguration(input: AzureSharedInput): EngineConfiguration {
  checkPlacement(input);
  if (!UUID.test(input.deployPrincipalId)) throw new Error('Azure deploy identity id is invalid.');
  const names = azureSharedNames(input);
  const tags = { 'managed-by': 'hypervibe', 'hv-shared': input.label };
  const placed = { resource_group_name: input.resourceGroup, location: input.location, tags };
  const registry: EngineResourceMapping = { actionId: 'shared:registry', kind: 'service', name: 'shared image registry', billable: true };
  const resources: Record<string, EngineResourceMapping> = { 'azurerm_container_registry.images': registry };
  const files: Record<string, unknown> = {
    'provider.tf.json': providerFile(input),
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
    const server: EngineResourceMapping = { actionId: 'shared:database', kind: 'database', name: 'shared database server', dataBearing: true, billable: true };
    for (const address of ['azurerm_postgresql_flexible_server.postgres', 'azurerm_postgresql_flexible_server_active_directory_administrator.deploy',
      'azurerm_postgresql_flexible_server_firewall_rule.public']) resources[address] = server;
    files['database.tf.json'] = {
      ephemeral: { random_password: { postgres_admin: { length: 40, special: false } } },
      resource: {
        azurerm_postgresql_flexible_server: { postgres: {
          name: names.server, ...placed, version: String(input.database.version),
          sku_name: input.database.skuName ?? 'B_Standard_B1ms', storage_mb: input.database.storageMb ?? 32768, auto_grow_enabled: true,
          backup_retention_days: 7, geo_redundant_backup_enabled: false, public_network_access_enabled: true,
          administrator_login: 'hvadmin', administrator_password_wo: '${ephemeral.random_password.postgres_admin.result}', administrator_password_wo_version: 1,
          authentication: [{ active_directory_auth_enabled: true, password_auth_enabled: true, tenant_id: input.tenantId }],
          // Azure picks the availability zone; it is not drift.
          lifecycle: [{ ignore_changes: ['zone'] }],
        } },
        azurerm_postgresql_flexible_server_active_directory_administrator: { deploy: {
          server_name: '${azurerm_postgresql_flexible_server.postgres.name}', resource_group_name: input.resourceGroup, tenant_id: input.tenantId,
          object_id: input.deployPrincipalId, principal_name: input.deployPrincipalName, principal_type: 'ServicePrincipal',
        } },
        // Consumption-plan Container Apps have no fixed outbound address. TLS (required by default) and
        // generated passwords protect the endpoint, as with Aurora on AWS.
        azurerm_postgresql_flexible_server_firewall_rule: { public: { name: 'hypervibe-public-tls', server_id: '${azurerm_postgresql_flexible_server.postgres.id}',
          start_ip_address: '0.0.0.0', end_ip_address: '255.255.255.255' } },
      },
      output: { database_host: { value: '${azurerm_postgresql_flexible_server.postgres.fqdn}' } },
    };
  }
  return { files, resources };
}

/** One environment: everything except the shared server and registry. */
export function buildAzureEnvironmentConfiguration(input: AzureEngineInput): EngineConfiguration {
  checkPlacement(input);
  const tags = { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() };
  const placed = { resource_group_name: input.resourceGroup, location: input.location, tags };
  const resources: Record<string, EngineResourceMapping> = {};
  const roleAssignment = (scope: string, role: string, description: string) => ({
    scope, role_definition_id: `/subscriptions/${input.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${role}`,
    principal_id: '${azurerm_user_assigned_identity.runtime.principal_id}', principal_type: 'ServicePrincipal', description,
  });

  const workers = input.workers ?? [];
  const onDemand = workers.some((worker) => worker.pendingWorkQuery);
  const secretKeys = [...new Set([...(input.secretKeys ?? []), ...(onDemand ? [WAKER_SECRET_KEY] : [])])];
  const secrets = secretKeys.map((key) => ({ key, name: azureSecretName(key), vaultName: azureVaultSecretName(input.environmentName, key) }));
  const seen = new Map<string, string>();
  for (const { key, name } of secrets) {
    if (seen.has(name)) throw new Error(`Secrets ${seen.get(name)} and ${key} map to the same Key Vault name ${name}.`);
    seen.set(name, key);
  }

  // Base: logs, the Container Apps environment (consumption only), the runtime identity and its roles.
  const base: EngineResourceMapping = { actionId: 'environment:base', kind: 'service', name: 'environment', billable: true };
  const runtime: EngineResourceMapping = { actionId: 'identity:runtime', kind: 'service', name: 'runtime' };
  resources['azurerm_log_analytics_workspace.logs'] = base;
  resources['azurerm_container_app_environment.main'] = base;
  resources['azurerm_user_assigned_identity.runtime'] = runtime;
  resources['azurerm_role_assignment.runtime_pull'] = runtime;
  resources['time_sleep.roles'] = runtime;
  const assignments: Record<string, unknown> = {
    runtime_pull: roleAssignment(input.shared.registryId, ROLE.acrPull, 'Hypervibe: the app pulls its images'),
  };
  // One role per secret, so an environment reads only its own secrets in the project vault.
  for (const secret of secrets) {
    const key = `secret_${azureKey(secret.key)}`;
    assignments[key] = roleAssignment(`${input.vault.id}/secrets/${secret.vaultName}`, ROLE.keyVaultSecretsUser, `Hypervibe: the app reads ${secret.key}`);
    resources[`azurerm_role_assignment.${key}`] = runtime;
  }
  const buckets = input.storage ?? [];
  if (buckets.length) {
    assignments.runtime_storage = roleAssignment('${azurerm_storage_account.files.id}', ROLE.storageBlobDataContributor, 'Hypervibe: the app reads and writes its files');
    resources['azurerm_role_assignment.runtime_storage'] = runtime;
  }
  const files: Record<string, unknown> = {
    'provider.tf.json': providerFile(input),
    'base.tf.json': {
      resource: {
        azurerm_log_analytics_workspace: { logs: { name: `${input.prefix}-logs`, ...placed, sku: 'PerGB2018', retention_in_days: 30,
          // About 4.5 GB a month: inside Log Analytics' 5 GB monthly free allowance.
          daily_quota_gb: 0.15 } },
        // No workload profiles, private endpoint or maintenance window: those bill $0.10/hour per environment.
        azurerm_container_app_environment: { main: { name: `${input.prefix}-apps`, ...placed,
          log_analytics_workspace_id: '${azurerm_log_analytics_workspace.logs.id}', logs_destination: 'log-analytics',
          // Azure adds its own Consumption profile to a new environment; declaring none must not read as drift.
          lifecycle: [{ ignore_changes: ['workload_profile'] }] } },
        azurerm_user_assigned_identity: { runtime: { name: `${input.prefix}-runtime`, ...placed } },
        azurerm_role_assignment: assignments,
        // New role assignments take a minute or two to apply; the first revision pulls and reads secrets right away.
        time_sleep: { roles: { create_duration: '90s', depends_on: Object.keys(assignments).map((key) => `azurerm_role_assignment.${key}`) } },
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
          default_to_oauth_authentication: true, cross_tenant_replication_enabled: false } },
        azurerm_storage_container: containers,
      },
      output: { storage_blob_endpoint: { value: '${azurerm_storage_account.files.primary_blob_endpoint}' } },
    };
  }

  const container = (workload: AzureWorkloadInput, extra: Record<string, unknown> = {}) => {
    const conflicts = Object.keys(workload.env ?? {}).filter((name) => secretKeys.includes(name) || name === 'AZURE_CLIENT_ID');
    if (conflicts.length) throw new Error(`${conflicts.join(', ')} ${conflicts.length === 1 ? 'is' : 'are'} set by Hypervibe; remove ${conflicts.length === 1 ? 'it' : 'them'} from envVars.`);
    return {
      name: 'app', image: workload.initialImage, cpu: workload.cpu ?? 0.25, memory: `${workload.memory ?? 0.5}Gi`,
      ...(workload.command ? { command: workload.command } : {}),
      env: [
        // Literal values: OpenTofu would otherwise read ${...} and %{...} in them as templates.
        ...Object.entries(workload.env ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value: value.replace(/([$%])\{/g, '$1$1{') })),
        // DefaultAzureCredential picks the runtime identity with this; it is an id, not a secret.
        { name: 'AZURE_CLIENT_ID', value: '${azurerm_user_assigned_identity.runtime.client_id}' },
        ...secrets.filter(({ key }) => key !== WAKER_SECRET_KEY).map(({ key, name }) => ({ name: key, secret_name: name })),
      ],
      ...extra,
    };
  };
  const shared = {
    resource_group_name: input.resourceGroup, container_app_environment_id: '${azurerm_container_app_environment.main.id}', tags,
    identity: [{ type: 'UserAssigned', identity_ids: ['${azurerm_user_assigned_identity.runtime.id}'] }],
    registry: [{ server: input.shared.registryLoginServer, identity: '${azurerm_user_assigned_identity.runtime.id}' }],
    secret: secrets.map(({ name, vaultName }) => ({ name, key_vault_secret_id: `${input.vault.uri}secrets/${vaultName}`, identity: '${azurerm_user_assigned_identity.runtime.id}' })),
    // The pull and secret roles must have applied before the first revision starts.
    depends_on: ['time_sleep.roles'],
  };
  const checkName = (name: string) => {
    if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(name) || name.includes('--')) throw new Error(`Container App name ${name} is invalid.`);
  };

  const apps: Record<string, unknown> = {};
  const outputs: Record<string, unknown> = {};
  for (const service of input.services ?? []) {
    checkName(service.resourceName);
    const key = azureKey(service.logicalName);
    resources[`azurerm_container_app.${key}`] = { actionId: `service:${service.logicalName}`, kind: 'service', name: service.logicalName, billable: true };
    const probe = service.healthCheckPath ? { path: service.healthCheckPath, port: service.targetPort, transport: 'HTTP' } : undefined;
    apps[key] = {
      name: service.resourceName, revision_mode: 'Single', ...shared,
      ingress: [{ external_enabled: service.public, target_port: service.targetPort, transport: 'auto', allow_insecure_connections: false,
        traffic_weight: [{ latest_revision: true, percentage: 100 }] }],
      template: [{
        min_replicas: 0, max_replicas: service.maxReplicas ?? 2,
        container: [container(service, probe ? { readiness_probe: [probe], startup_probe: [probe] } : {})],
      }],
      // The release path (CI or hv_deploy) owns the image after creation.
      lifecycle: [{ ignore_changes: ['template[0].container[0].image'] }],
    };
    outputs[`service_${key}_url`] = { value: `https://\${azurerm_container_app.${key}.ingress[0].fqdn}` };
  }
  for (const worker of workers) {
    checkName(worker.resourceName);
    const key = azureKey(worker.logicalName);
    resources[`azurerm_container_app.${key}`] = { actionId: `service:${worker.logicalName}`, kind: 'service', name: worker.logicalName, billable: true };
    apps[key] = {
      name: worker.resourceName, revision_mode: 'Single', ...shared,
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
        container: [container(worker)],
      }],
      lifecycle: [{ ignore_changes: ['template[0].container[0].image'] }],
    };
  }
  if (Object.keys(apps).length) files['apps.tf.json'] = { resource: { azurerm_container_app: apps }, ...(Object.keys(outputs).length ? { output: outputs } : {}) };

  const jobs: Record<string, unknown> = {};
  for (const job of input.jobs ?? []) {
    checkName(job.resourceName);
    const key = azureKey(job.logicalName);
    resources[`azurerm_container_app_job.${key}`] = { actionId: `service:${job.logicalName}`, kind: 'service', name: job.logicalName, billable: true };
    const { container_app_environment_id, ...rest } = shared;
    jobs[key] = {
      name: job.resourceName, location: input.location, container_app_environment_id, ...rest,
      replica_timeout_in_seconds: job.timeoutSeconds ?? 1800, replica_retry_limit: 0,
      schedule_trigger_config: [{ cron_expression: azureCron(job.schedule), parallelism: 1, replica_completion_count: 1 }],
      template: [{ container: [container(job)] }],
      lifecycle: [{ ignore_changes: ['template[0].container[0].image'] }],
    };
  }
  if (Object.keys(jobs).length) files['jobs.tf.json'] = { resource: { azurerm_container_app_job: jobs } };

  files['outputs.tf.json'] = { output: {
    runtime_identity_client_id: { value: '${azurerm_user_assigned_identity.runtime.client_id}' },
    apps_environment_id: { value: '${azurerm_container_app_environment.main.id}' },
  } };
  return { files, resources };
}
