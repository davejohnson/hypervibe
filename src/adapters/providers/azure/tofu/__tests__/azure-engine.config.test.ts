import { describe, expect, it } from 'vitest';
import {
  azureCron, azureProjectVaultName, azureSecretName, azureSharedNames, azureStorageAccountName, azureVaultSecretName, buildAzureConfiguration,
  buildAzureBuildConfiguration, buildAzureEnvironmentConfiguration, buildAzureSharedConfiguration,
} from '../azure-engine.config.js';
import { azureEngineAuthentication, azureEngineBackend, azureResourceGroupId } from '../azure-engine.backend.js';
import { fullEnvironmentInput, fullSharedInput } from './azure-fixtures.js';

type Resources = Record<string, Record<string, Record<string, unknown>>>;
const resourcesOf = (config: ReturnType<typeof buildAzureConfiguration>, file: string) => (config.files[file] as { resource: Resources }).resource;

describe('Azure shared configuration (network, app environment, server and registry)', () => {
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

  // #728: the server was open to every address on the internet.
  it('keeps the database off the internet: no public access, no firewall rule, reached through a private endpoint', () => {
    const config = buildAzureSharedConfiguration(fullSharedInput);
    const database = resourcesOf(config, 'database.tf.json');
    expect(database.azurerm_postgresql_flexible_server!.postgres!.public_network_access_enabled).toBe(false);
    expect(database).not.toHaveProperty('azurerm_postgresql_flexible_server_firewall_rule');
    expect(JSON.stringify(config.files)).not.toMatch(/0\.0\.0\.0|255\.255\.255\.255/);
    expect(database.azurerm_private_endpoint!.postgres).toMatchObject({ subnet_id: '${azurerm_subnet.endpoints.id}',
      private_service_connection: [{ private_connection_resource_id: '${azurerm_postgresql_flexible_server.postgres.id}', subresource_names: ['postgresqlServer'] }],
      private_dns_zone_group: [{ private_dns_zone_ids: ['${azurerm_private_dns_zone.postgres.id}'] }] });
    // The server's usual host name resolves privately inside the network, so DATABASE_URL keeps it.
    expect(database.azurerm_private_dns_zone!.postgres!.name).toBe('privatelink.postgres.database.azure.com');
    expect(database.azurerm_private_dns_zone_virtual_network_link!.postgres!.virtual_network_id).toBe('${azurerm_virtual_network.main.id}');
    // A project that had the open rule gets a reviewed removal, not a blocked plan.
    expect(config.resources['azurerm_postgresql_flexible_server_firewall_rule.public']).toMatchObject({ actionId: 'shared:database' });
  });

  it('runs the group\'s apps in one environment inside the private network', () => {
    const config = buildAzureSharedConfiguration(fullSharedInput);
    const network = resourcesOf(config, 'network.tf.json');
    expect(network.azurerm_subnet!.apps).toMatchObject({ address_prefixes: ['10.61.0.0/23'], delegation: [{ service_delegation: [{ name: 'Microsoft.App/environments' }] }] });
    expect(network.azurerm_subnet!.endpoints).not.toHaveProperty('delegation');
    expect(resourcesOf(config, 'apps.tf.json').azurerm_container_app_environment!.main).toMatchObject({ name: 'hv-billforge-shared-apps',
      infrastructure_subnet_id: '${azurerm_subnet.apps.id}', workload_profile: [{ name: 'Consumption', workload_profile_type: 'Consumption' }] });
    for (const file of ['network.tf.json', 'apps.tf.json', 'database.tf.json', 'registry.tf.json']) {
      for (const [type, entries] of Object.entries(resourcesOf(config, file))) for (const name of Object.keys(entries)) expect(config.resources[`${type}.${name}`], `${type}.${name}`).toBeDefined();
    }
  });

  it('has no server or private endpoint when no environment in the group has a database', () => {
    const { database: _database, ...withoutDatabase } = fullSharedInput;
    const config = buildAzureSharedConfiguration(withoutDatabase);
    expect(config.files).not.toHaveProperty('database.tf.json');
    expect(Object.keys(config.resources).sort()).toEqual(['azurerm_container_app_environment.main', 'azurerm_container_registry.images', 'azurerm_log_analytics_workspace.logs',
      'azurerm_subnet.apps', 'azurerm_subnet.endpoints', 'azurerm_virtual_network.main']);
  });
});

describe('Azure environment configuration', () => {
  const config = buildAzureEnvironmentConfiguration(fullEnvironmentInput);
  const apps = resourcesOf(config, 'apps.tf.json').azurerm_container_app!;

  it('scales the web service to zero and reads its secrets from the project vault by reference', () => {
    // The apps run in the project's shared environment; an environment's own old one is removed by a reviewed action.
    expect(resourcesOf(config, 'base.tf.json')).not.toHaveProperty('azurerm_container_app_environment');
    expect(apps.web!.container_app_environment_id).toBe(fullEnvironmentInput.shared.appsEnvironmentId);
    expect(config.resources['azurerm_container_app_environment.main']).toMatchObject({ actionId: 'environment:base' });
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
      // Releases own the image; Azure assigns the Consumption profile.
      lifecycle: [{ ignore_changes: ['template[0].container[0].image', 'workload_profile_name'] }] });
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
    // An interrupted apply's role assignments are imported instead of recreated; only desired ones.
    const adopted = buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, adoptRoleAssignments: { 'azurerm_role_assignment.runtime_pull': '/subscriptions/s/x/roleAssignments/a1' } });
    expect(adopted.files['imports.tf.json']).toEqual({ import: [{ to: 'azurerm_role_assignment.runtime_pull', id: '/subscriptions/s/x/roleAssignments/a1' }] });
    expect(() => buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, adoptRoleAssignments: { 'azurerm_role_assignment.someone_else': 'x' } })).toThrow(/Only a desired role assignment/);
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


describe('Azure private package build task', () => {
  it('applies a separate identity with secret-scoped read access and keeps tokens out of runtime', () => {
    const input = { ...fullEnvironmentInput, packageTokenKey: 'NODE_AUTH_TOKEN', secretKeys: ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'API_KEY'] };
    const config = buildAzureBuildConfiguration(input);
    const resources = resourcesOf(config, 'builds.tf.json');
    const task = resources.azurerm_container_registry_task!.images! as any;
    expect(task.identity).toEqual([{ type: 'SystemAssigned' }]);
    const program = JSON.parse(Buffer.from(task.encoded_step[0].task_content, 'base64').toString());
    expect(program.secrets).toEqual([{ id: 'npmToken', keyvault: `${input.vault.uri}secrets/test--node-auth-token` }]);
    expect(program.env).toEqual(['DOCKER_BUILDKIT=1']);
    expect(program.steps[0].build).toContain('--secret id=npm_token,src=/run/hypervibe-build/npm_token');
    expect(program.steps[0].volumeMounts).toEqual([{ name: 'package-token', mountPath: '/run/hypervibe-build' }]);
    expect(resources.azurerm_role_assignment!.build_token).toMatchObject({ scope: `${input.vault.id}/secrets/test--node-auth-token`, principal_id: '${azurerm_container_registry_task.images.identity[0].principal_id}' });
    const runtime = JSON.stringify(buildAzureEnvironmentConfiguration(input).files);
    expect(runtime).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|node-auth-token|npm-token/);
    expect(runtime).toContain('API_KEY');
    expect(buildAzureBuildConfiguration(fullEnvironmentInput).resources).toEqual({});
  });
});
