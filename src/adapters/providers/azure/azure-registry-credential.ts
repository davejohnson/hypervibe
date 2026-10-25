import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { RegistryCredentialLifecycle, RegistryCredentialTarget } from '../../../domain/ports/registry-credential.port.js';
import type { AzureResourceManagerClient } from './azure-resource-manager.client.js';

const version = '2026-01-01';
const appSchema = z.object({ id: z.string(), properties: z.object({ environmentId: z.string().optional(), managedEnvironmentId: z.string().optional(),
  configuration: z.object({ registries: z.array(z.object({ server: z.string().min(1), username: z.string().optional(), passwordSecretRef: z.string().optional(), identity: z.string().optional() }).passthrough()), secrets: z.array(z.object({ name: z.string().min(1) }).passthrough()) }).passthrough(),
  template: z.object({ containers: z.array(z.object({ image: z.string().min(1) }).passthrough()).min(1) }).passthrough(),
}).passthrough() }).passthrough();
const secretSchema = z.object({ name: z.string().min(1), value: z.string().optional(), keyVaultUrl: z.string().optional(), identity: z.string().optional() }).passthrough();
const vaultValueSchema = z.object({ id: z.string().url(), value: z.string(), contentType: z.string().optional(), tags: z.record(z.string(), z.string()).optional(),
  attributes: z.object({ enabled: z.boolean().optional(), nbf: z.number().optional(), exp: z.number().optional() }).optional() });
function vaultReference(value: string): { base: string; pinned: boolean } {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-zA-Z0-9-]+\.vault\.azure\.net$/.test(url.hostname)
    || !/^\/secrets\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)?$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error();
  const segments = url.pathname.split('/'); return { base: `${url.origin}/${segments[1]}/${segments[2]}`, pinned: segments.length === 4 };
}

export function createAzureRegistryCredentialLifecycle(client: () => AzureResourceManagerClient): RegistryCredentialLifecycle {
  const observe = async (environment: Environment, service: string) => {
    const bindings = parseHostingBindings(environment); const serviceId = bindings.services?.[service]?.serviceId;
    if (bindings.provider !== 'azure-container-apps' || !bindings.projectId || !bindings.environmentId || !serviceId) throw new Error();
    const api = client(); const scope = api.parseResourceId(serviceId, 'Microsoft.App', 'containerApps');
    api.parseResourceId(bindings.environmentId, 'Microsoft.App', 'managedEnvironments');
    if (bindings.projectId.toLowerCase() !== `/subscriptions/${scope.subscriptionId}/resourceGroups/${scope.resourceGroup}`.toLowerCase()) throw new Error();
    const app = appSchema.parse(await api.getNullable(serviceId, version));
    if (app.id.toLowerCase() !== serviceId.toLowerCase() || (app.properties.environmentId ?? app.properties.managedEnvironmentId)?.toLowerCase() !== bindings.environmentId.toLowerCase()) throw new Error();
    const configurations = app.properties.template.containers.slice(0, 1).flatMap(container => {
      const host = container.image.split('/')[0];
      return app.properties.configuration.registries.filter(registry => registry.server === host && registry.passwordSecretRef && !registry.identity).map(registry => ({ container, registry }));
    });
    if (configurations.length !== 1) throw new Error();
    const { container, registry } = configurations[0]!;
    const references = app.properties.configuration.secrets.filter(secret => secret.name === registry.passwordSecretRef);
    if (references.length !== 1) throw new Error();
    const reference = secretSchema.parse(references[0]);
    const vault = reference.keyVaultUrl ? vaultReference(reference.keyVaultUrl) : undefined;
    const target: RegistryCredentialTarget = { provider: 'azure-container-apps', projectId: bindings.projectId, environmentId: bindings.environmentId, serviceId,
      instanceId: app.id, image: container.image, registry: registry.server, credentialReference: `${app.id}/secrets/${registry.passwordSecretRef}`,
      ...(vault ? { upstream: vault.base } : {}), activation: vault && !vault.pinned ? 'provider-rollout' : 'deferred' };
    return { api, app, registry, target };
  };
  const secrets = async (api: AzureResourceManagerClient, appId: string) => z.object({ value: z.array(secretSchema) }).parse(await api.request('POST', `${appId}/listSecrets`, version)).value;
  const port: RegistryCredentialLifecycle = {
    async inspect(environment, service) {
      try { return (await observe(environment, service)).target; }
      catch { throw new Error('The exact Azure container image and existing registry password reference cannot be verified. Managed-identity registries do not require a password copy.'); }
    },
    async update(environment, service, expected, credential, context) {
      let attempted = false;
      try {
        const { api, app, registry, target } = await observe(environment, service);
        if (!isDeepStrictEqual(expected, target) || !credential.username || !credential.token) throw new Error();
        const current = await secrets(api, app.id);
        if (new Set(current.map(item => item.name)).size !== current.length
          || app.properties.configuration.secrets.some(item => !current.some(secret => secret.name === item.name))) throw new Error();
        const selected = current.find(item => item.name === registry.passwordSecretRef);
        if (!selected || (!selected.keyVaultUrl && typeof selected.value !== 'string')) throw new Error();
        let acceptedVaultReference = selected.keyVaultUrl;
        if (selected.keyVaultUrl) {
          const vault = vaultReference(selected.keyVaultUrl);
          if (vault.base !== target.upstream || !selected.identity) throw new Error();
          const readVault = async (url: string) => {
            const result = vaultValueSchema.parse(await api.requestKeyVault('GET', url));
            if (vaultReference(result.id).base !== vault.base || !vaultReference(result.id).pinned || result.attributes?.enabled === false) throw new Error();
            return result;
          };
          const original = await readVault(selected.keyVaultUrl);
          if (original.value !== credential.token) {
            const latest = await readVault(vault.base);
            let accepted = latest;
            if (latest.value !== credential.token) {
              if (context?.retryUncertain) throw new Error();
              attempted = true;
              accepted = vaultValueSchema.parse(await api.requestKeyVault('PUT', vault.base, { value: credential.token,
                ...(original.contentType === undefined ? {} : { contentType: original.contentType }), ...(original.tags === undefined ? {} : { tags: original.tags }),
                ...(original.attributes === undefined ? {} : { attributes: original.attributes }) }));
              if (vaultReference(accepted.id).base !== vault.base || !vaultReference(accepted.id).pinned || accepted.value !== credential.token) throw new Error();
            }
            if (vault.pinned) acceptedVaultReference = accepted.id;
          }
        }
        if ((!selected.keyVaultUrl && selected.value !== credential.token) || acceptedVaultReference !== selected.keyVaultUrl || registry.username !== credential.username) {
          const configuration = { ...app.properties.configuration, registries: app.properties.configuration.registries.map(item => item === registry ? { ...item, username: credential.username } : item),
            secrets: current.map(item => item === selected ? selected.keyVaultUrl
              ? { ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'value')), keyVaultUrl: acceptedVaultReference }
              : { ...item, value: credential.token } : item) };
          attempted = true;
          await api.request('PATCH', app.id, version, { properties: { configuration } });
        }
        const after = await observe(environment, service); const values = await secrets(api, app.id);
        const actual = values.find(item => item.name === selected.name);
        if (!isDeepStrictEqual(after.target, target) || after.registry.username !== credential.username || !actual) throw new Error();
        if (selected.keyVaultUrl) {
          if (actual.keyVaultUrl !== acceptedVaultReference || actual.identity !== selected.identity) throw new Error();
          const value = vaultValueSchema.parse(await api.requestKeyVault('GET', actual.keyVaultUrl!));
          if (vaultReference(value.id).base !== target.upstream || value.value !== credential.token) throw new Error();
        } else if (actual.value !== credential.token) throw new Error();
        return { success: true, message: 'Azure registry credential readback verified. Existing revisions still require managed rollout and image-pull verification.', data: { mutationAttempted: attempted, configurationUpdated: true, credentialValueEvidence: 'readback', credentialUpdateActivation: target.activation, runtimeRolloutRequired: true } };
      } catch { return { success: false, message: attempted ? 'Azure registry credential write is uncertain; inspect the existing app secret and vault version before retrying.' : 'Azure registry target or existing secret value is unverified; no write attempted.', data: { mutationAttempted: attempted } }; }
    },
  };
  port.reconcile = (environment, service, expected, credential, context) => port.update(environment, service, expected, credential, { ...context, retryUncertain: true });
  return port;
}
