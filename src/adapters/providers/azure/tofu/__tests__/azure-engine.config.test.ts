import { describe, expect, it } from 'vitest';
import { azureGlobalNames, azureSecretName, buildAzureConfiguration, type AzureEngineInput } from '../azure-engine.config.js';
import { azureEngineAuthentication, azureEngineBackend, azureResourceGroupId } from '../azure-engine.backend.js';

const base: AzureEngineInput = {
  tenantId: '11111111-2222-3333-4444-555555555555', subscriptionId: '66666666-7777-8888-9999-000000000000', resourceGroup: 'hv-billforge',
  location: 'eastus2', prefix: 'hv-billforge-test', environmentId: 'ENV1', deployPrincipalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', deployPrincipalName: 'hypervibe-deploy-billforge',
};
type Resources = Record<string, Record<string, Record<string, unknown>>>;
const resourcesOf = (config: ReturnType<typeof buildAzureConfiguration>, file: string) => (config.files[file] as { resource: Resources }).resource;

describe('Azure engine configuration', () => {
  it('keeps the database password out of configuration, plan and state, and the server TLS-only with Entra administration', () => {
    const config = buildAzureConfiguration({ ...base, database: { version: 17 } });
    const file = config.files['database.tf.json'] as { ephemeral: Resources; resource: Resources };
    const server = file.resource.azurerm_postgresql_flexible_server!.postgres!;
    expect(server).not.toHaveProperty('administrator_password');
    expect(server.administrator_password_wo).toBe('${ephemeral.random_password.postgres_admin.result}');
    expect(file.ephemeral.random_password!.postgres_admin).toMatchObject({ length: 40 });
    expect(server).toMatchObject({ sku_name: 'B_Standard_B1ms', storage_mb: 32768, version: '17', authentication: [{ active_directory_auth_enabled: true, password_auth_enabled: true }] });
    expect(file.resource.azurerm_postgresql_flexible_server_active_directory_administrator!.deploy).toMatchObject({ object_id: base.deployPrincipalId, principal_type: 'ServicePrincipal' });
    expect(config.resources['azurerm_postgresql_flexible_server.postgres']).toMatchObject({ dataBearing: true, billable: true });
    expect(JSON.stringify(config.files)).not.toMatch(/require_secure_transport/);
  });

  it('uses a consumption-only Container Apps environment that scales the web service to zero and reads secrets from Key Vault', () => {
    const config = buildAzureConfiguration({ ...base, secretKeys: ['DATABASE_URL', 'JWT_SECRET'],
      services: [{ logicalName: 'web', resourceName: 'hv-billforge-test-web', initialImage: 'r.azurecr.io/app:1', public: true, targetPort: 3000, env: { GREETING: 'cost ${HOME} 100%{x}' } }] });
    const environment = resourcesOf(config, 'base.tf.json').azurerm_container_app_environment!.main!;
    expect(environment).not.toHaveProperty('workload_profile');
    const app = resourcesOf(config, 'services.tf.json').azurerm_container_app!.web! as { template: Array<{ min_replicas: number; container: Array<{ env: Array<Record<string, string>> }> }>; secret: unknown[]; lifecycle: unknown };
    expect(app.template[0]!.min_replicas).toBe(0);
    expect(app.secret).toEqual([
      { name: 'database-url', key_vault_secret_id: '${azurerm_key_vault.secrets.vault_uri}secrets/database-url', identity: '${azurerm_user_assigned_identity.runtime.id}' },
      { name: 'jwt-secret', key_vault_secret_id: '${azurerm_key_vault.secrets.vault_uri}secrets/jwt-secret', identity: '${azurerm_user_assigned_identity.runtime.id}' },
    ]);
    const env = app.template[0]!.container[0]!.env;
    // Plain values stay literal: OpenTofu template syntax in them is escaped.
    expect(env).toContainEqual({ name: 'GREETING', value: 'cost $${HOME} 100%%{x}' });
    expect(env).toContainEqual({ name: 'DATABASE_URL', secret_name: 'database-url' });
    expect(env).toContainEqual({ name: 'AZURE_CLIENT_ID', value: '${azurerm_user_assigned_identity.runtime.client_id}' });
    expect(app.lifecycle).toEqual([{ ignore_changes: ['template[0].container[0].image'] }]);
  });

  it('gives the app identity only data roles on its own resources, and storage no shared keys', () => {
    const config = buildAzureConfiguration({ ...base, storage: [{ name: 'documents', container: 'documents' }] });
    const assignments = { ...resourcesOf(config, 'base.tf.json').azurerm_role_assignment, ...resourcesOf(config, 'storage.tf.json').azurerm_role_assignment };
    expect(Object.values(assignments).map((assignment) => String(assignment.role_definition_id).split('/').pop()).sort()).toEqual([
      '4633458b-17de-408a-b874-0445c86b69e6', '7f951dda-4ed3-4680-a7ca-43fe172d538d', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
    ]);
    for (const assignment of Object.values(assignments)) expect(assignment).toMatchObject({ principal_type: 'ServicePrincipal', scope: expect.stringMatching(/^\$\{azurerm_/) });
    expect(resourcesOf(config, 'storage.tf.json').azurerm_storage_account!.files).toMatchObject({ shared_access_key_enabled: false, allow_nested_items_to_be_public: false });
    expect(config.resources['azurerm_storage_container.documents']).toMatchObject({ dataBearing: true });
    expect((config.files['provider.tf.json'] as { provider: { azurerm: Array<Record<string, unknown>> } }).provider.azurerm[0]).toMatchObject({ resource_provider_registrations: 'none', storage_use_azuread: true });
  });

  it('derives stable, valid global names and refuses secrets that would collide in Key Vault', () => {
    const names = azureGlobalNames({ subscriptionId: base.subscriptionId, environmentId: 'ENV1', prefix: 'hv-a-very-long-proje' });
    expect(names).toEqual(azureGlobalNames({ subscriptionId: base.subscriptionId, environmentId: 'ENV1', prefix: 'hv-a-very-long-proje' }));
    expect(names.storage).toMatch(/^[a-z0-9]{3,24}$/);
    expect(names.vault).toMatch(/^[a-z][a-z0-9-]{1,22}[a-z0-9]$/);
    expect(names.registry).toMatch(/^[a-z0-9]{5,50}$/);
    expect(azureGlobalNames({ subscriptionId: base.subscriptionId, environmentId: 'ENV2', prefix: 'hv-a-very-long-proje' }).storage).not.toBe(names.storage);
    expect(azureSecretName('STRIPE_SECRET_KEY')).toBe('stripe-secret-key');
    expect(() => buildAzureConfiguration({ ...base, secretKeys: ['API_KEY', 'api_key'] })).toThrow(/same Key Vault name/);
  });
});

describe('Azure engine backend', () => {
  it('pins exact providers and redacts the client secret', () => {
    expect(azureEngineBackend.providerRequirements.azurerm).toMatchObject({ source: 'hashicorp/azurerm', version: '5.11.0' });
    expect(azureEngineBackend.providerRequirements.azurerm!.lockHashes).toHaveLength(15);
    const auth = azureEngineAuthentication({ tenantId: base.tenantId, subscriptionId: base.subscriptionId, clientId: base.deployPrincipalId, deployPrincipalId: base.deployPrincipalId,
      clientSecret: 'super-secret-value-123', clientSecretExpiresAt: '2027-01-01T00:00:00Z', resourceGroup: 'hv-billforge', location: 'eastus2' });
    expect(auth.env.ARM_CLIENT_SECRET).toBe('super-secret-value-123');
    expect(auth.redact).toEqual(['super-secret-value-123']);
  });

  it('probes with data sources only, against exactly the resource group', () => {
    const probe = azureEngineBackend.buildAuthenticationProbe({ projectId: azureResourceGroupId(base.subscriptionId, 'hv-billforge') });
    expect(probe.resources).toEqual({});
    expect(probe.files['probe.tf.json']).not.toHaveProperty('resource');
    expect(JSON.stringify(probe.files['probe.tf.json'])).toContain('"name":"hv-billforge"');
    expect(() => azureEngineBackend.buildAuthenticationProbe({ projectId: base.subscriptionId })).toThrow(/resource group id/);
  });
});
