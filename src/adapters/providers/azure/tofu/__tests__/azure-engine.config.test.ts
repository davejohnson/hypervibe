import { describe, expect, it } from 'vitest';
import {
  azureCron, azureProjectVaultName, azureSecretName, azureSharedNames, azureStorageAccountName, azureVaultSecretName, buildAzureConfiguration,
  buildAzureEnvironmentConfiguration, buildAzureSharedConfiguration,
} from '../azure-engine.config.js';
import { azureEngineAuthentication, azureEngineBackend, azureResourceGroupId } from '../azure-engine.backend.js';
import { fullEnvironmentInput, fullSharedInput } from './azure-fixtures.js';

type Resources = Record<string, Record<string, Record<string, unknown>>>;
const resourcesOf = (config: ReturnType<typeof buildAzureConfiguration>, file: string) => (config.files[file] as { resource: Resources }).resource;

describe('Azure shared configuration (server and registry)', () => {
  it('keeps the administrator password out of configuration, plan and state, with Entra administration and TLS by default', () => {
    const config = buildAzureSharedConfiguration(fullSharedInput);
    const file = config.files['database.tf.json'] as { ephemeral: Resources; resource: Resources };
    const server = file.resource.azurerm_postgresql_flexible_server!.postgres!;
    expect(server).not.toHaveProperty('administrator_password');
    expect(server.administrator_password_wo).toBe('${ephemeral.random_password.postgres_admin.result}');
    expect(server).toMatchObject({ sku_name: 'B_Standard_B1ms', storage_mb: 32768, version: '17', tags: { 'hv-shared': 'testing' } });
    expect(file.resource.azurerm_postgresql_flexible_server_active_directory_administrator!.deploy).toMatchObject({ object_id: fullSharedInput.deployPrincipalId, principal_type: 'ServicePrincipal' });
    expect(config.resources['azurerm_postgresql_flexible_server.postgres']).toMatchObject({ actionId: 'shared:database', dataBearing: true, billable: true });
    expect(resourcesOf(config, 'registry.tf.json').azurerm_container_registry!.images).toMatchObject({ sku: 'Basic', admin_enabled: false });
    expect(JSON.stringify(config.files)).not.toMatch(/require_secure_transport/);
  });

  it('has only a registry when no environment in the group has a database', () => {
    const { database: _database, ...withoutDatabase } = fullSharedInput;
    expect(Object.keys(buildAzureSharedConfiguration(withoutDatabase).resources)).toEqual(['azurerm_container_registry.images']);
  });
});

describe('Azure environment configuration', () => {
  const config = buildAzureEnvironmentConfiguration(fullEnvironmentInput);
  const apps = resourcesOf(config, 'apps.tf.json').azurerm_container_app!;

  it('scales the web service to zero and reads its secrets from the project vault by reference', () => {
    expect(resourcesOf(config, 'base.tf.json').azurerm_container_app_environment!.main).not.toHaveProperty('workload_profile');
    // Azure adds its own Consumption profile; that must not read as drift.
    expect(resourcesOf(config, 'base.tf.json').azurerm_container_app_environment!.main).toMatchObject({ lifecycle: [{ ignore_changes: ['workload_profile'] }] });
    const web = apps.web as { template: Array<{ min_replicas: number; container: Array<{ env: Array<Record<string, string>> }> }>; secret: unknown[]; registry: unknown[]; depends_on: string[] };
    expect(web.template[0]!.min_replicas).toBe(0);
    expect(web.secret).toContainEqual({ name: 'database-url', key_vault_secret_id: 'https://hv-billforge-abc123.vault.azure.net/secrets/test--database-url', identity: '${azurerm_user_assigned_identity.runtime.id}' });
    expect(web.registry).toEqual([{ server: 'hvbillforgeshared123456.azurecr.io', identity: '${azurerm_user_assigned_identity.runtime.id}' }]);
    expect(web.template[0]!.container[0]!.env).toContainEqual({ name: 'DATABASE_URL', secret_name: 'database-url' });
    // The worker's counting login is for its scale rule only, never an app variable.
    expect(web.template[0]!.container[0]!.env.map((entry) => entry.name)).not.toContain('HV_WAKER_URL');
    expect(web.depends_on).toEqual(['time_sleep.roles']);
  });

  it('starts the on-demand worker from zero with a once-a-minute PostgreSQL count, and runs cron as a Container Apps Job', () => {
    const worker = apps.worker as { ingress?: unknown; template: Array<Record<string, unknown>> };
    expect(worker.ingress).toBeUndefined();
    expect(worker.template[0]).toMatchObject({ min_replicas: 0, max_replicas: 1, polling_interval_in_seconds: 60,
      custom_scale_rule: [{ custom_rule_type: 'postgresql', metadata: { query: "SELECT count(*) FROM jobs WHERE status = 'queued'", activationTargetQueryValue: '0' },
        authentication: [{ secret_name: 'hv-waker-url', trigger_parameter: 'connection' }] }] });
    const job = resourcesOf(config, 'jobs.tf.json').azurerm_container_app_job!.nightly!;
    expect(job).toMatchObject({ schedule_trigger_config: [{ cron_expression: '0 3 * * *', parallelism: 1 }], replica_retry_limit: 0,
      lifecycle: [{ ignore_changes: ['template[0].container[0].image'] }] });
    expect(() => azureCron('0 3 * *')).toThrow(/five cron fields/);
  });

  it('lets the app identity read only its own secrets, pull images and use its own storage', () => {
    const assignments = resourcesOf(config, 'base.tf.json').azurerm_role_assignment!;
    const scopes = Object.values(assignments).map((assignment) => String(assignment.scope));
    expect(scopes).toContain(`${fullEnvironmentInput.vault.id}/secrets/test--database-url`);
    expect(scopes).toContain(`${fullEnvironmentInput.vault.id}/secrets/test--hv-waker-url`);
    expect(scopes).not.toContain(fullEnvironmentInput.vault.id);
    expect(new Set(Object.values(assignments).map((assignment) => String(assignment.role_definition_id).split('/').pop()))).toEqual(new Set([
      '4633458b-17de-408a-b874-0445c86b69e6', '7f951dda-4ed3-4680-a7ca-43fe172d538d', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
    ]));
    expect(resourcesOf(config, 'storage.tf.json').azurerm_storage_account!.files).toMatchObject({ shared_access_key_enabled: false, allow_nested_items_to_be_public: false });
    // Every address the configuration declares maps to a reviewed Hypervibe action.
    for (const [type, entries] of Object.entries({ ...resourcesOf(config, 'base.tf.json'), ...resourcesOf(config, 'apps.tf.json'), ...resourcesOf(config, 'jobs.tf.json'), ...resourcesOf(config, 'storage.tf.json') })) {
      for (const name of Object.keys(entries)) expect(config.resources[`${type}.${name}`], `${type}.${name}`).toBeDefined();
    }
  });

  it('writes plain values literally and refuses variables Hypervibe sets', () => {
    const escaped = buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, services: [{ ...fullEnvironmentInput.services![0]!, env: { GREETING: 'cost ${HOME} 100%{x}' } }] });
    const env = ((resourcesOf(escaped, 'apps.tf.json').azurerm_container_app!.web as { template: Array<{ container: Array<{ env: unknown[] }> }> }).template[0]!.container[0]!.env);
    expect(env).toContainEqual({ name: 'GREETING', value: 'cost $${HOME} 100%%{x}' });
    expect(() => buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, services: [{ ...fullEnvironmentInput.services![0]!, env: { DATABASE_URL: 'x' } }] })).toThrow(/set by Hypervibe/);
    expect(() => buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, secretKeys: ['API_KEY', 'api_key'] })).toThrow(/same Key Vault name/);
  });
});

describe('Azure names', () => {
  it('derives stable, valid global names', () => {
    const shared = azureSharedNames(fullSharedInput);
    expect(shared).toEqual(azureSharedNames(fullSharedInput));
    expect(shared.registry).toMatch(/^[a-z0-9]{5,50}$/);
    expect(shared.server).toMatch(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/);
    expect(azureStorageAccountName({ ...fullEnvironmentInput })).toMatch(/^[a-z0-9]{3,24}$/);
    expect(azureProjectVaultName(fullEnvironmentInput.subscriptionId, 'A Very Long Project Name')).toMatch(/^[a-z][a-z0-9-]{1,22}[a-z0-9]$/);
    expect(azureSecretName('STRIPE_SECRET_KEY')).toBe('stripe-secret-key');
    expect(azureVaultSecretName('pr-12', 'JWT_SECRET')).toBe('pr-12--jwt-secret');
  });
});

describe('Azure engine backend', () => {
  it('pins exact providers and redacts the client secret', () => {
    expect(azureEngineBackend.providerRequirements.azurerm).toMatchObject({ source: 'hashicorp/azurerm', version: '5.11.0' });
    for (const requirement of Object.values(azureEngineBackend.providerRequirements)) expect(requirement.lockHashes).toHaveLength(15);
    const auth = azureEngineAuthentication({ tenantId: fullEnvironmentInput.tenantId, subscriptionId: fullEnvironmentInput.subscriptionId, clientId: fullSharedInput.deployPrincipalId,
      deployPrincipalId: fullSharedInput.deployPrincipalId, clientSecret: 'super-secret-value-123', clientSecretExpiresAt: '2027-01-01T00:00:00Z', resourceGroup: 'hv-billforge', location: 'eastus2' });
    expect(auth.env.ARM_CLIENT_SECRET).toBe('super-secret-value-123');
    expect(auth.redact).toEqual(['super-secret-value-123']);
  });

  it('probes with data sources only, against exactly the resource group', () => {
    const probe = azureEngineBackend.buildAuthenticationProbe({ projectId: azureResourceGroupId(fullEnvironmentInput.subscriptionId, 'hv-billforge') });
    expect(probe.resources).toEqual({});
    expect(probe.files['probe.tf.json']).not.toHaveProperty('resource');
    expect(() => azureEngineBackend.buildAuthenticationProbe({ projectId: fullEnvironmentInput.subscriptionId })).toThrow(/resource group id/);
  });
});
