import type { EngineAuthentication, InfrastructureEngineBackend } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { AzureEngineCredentials } from '../azure-engine.adapter.js';
import { buildAzureConfiguration, type AzureEngineInput } from './azure-engine.config.js';

/** Pinned hashicorp/azurerm provider (released 2026-10-23, at least two weeks old when pinned) and its lock hashes. */
export const AZURERM_PROVIDER_VERSION = '5.11.0';
const AZURERM_PROVIDER_LOCK_HASHES = [
  'h1:7CyLshMh/xUC0+6hZtB5TuMky46Npr/GH51jrLSHGqE=',
  'h1:7mq6+e6WRhZGfWhXQ/PjBE7Wi8mz9ViS8K6q3tatKLE=',
  'h1:IZMiwYi45A8yjti+mNcPvErcQmZ5x/SsgBgEW4KvpKs=',
  'h1:KdZ+P9xmMKZTsNmSiYGiTQG4a2fmLFaEWUEVaOF8ea0=',
  'h1:LgorwR5rwW4cCtGOFZlZoK4CpsECCAHqsQYxkyLagbQ=',
  'h1:RuoC3AlQ494STcpvuotsWA8Jx9nnKZxvHV5C68xV6jA=',
  'h1:Sbij2NM6hjNjV92kqIIeUw/oPlhfnjEzceffuPa6yXs=',
  'h1:T9ir7bSG3iZ/1RZse29iErGcgLSQZ2TFWotXXVFmCAc=',
  'h1:TrZRTr4PjlKIPOfWpvQVQWPYDbcw+76HD42Qd+gZVzk=',
  'h1:bu6WVN4sOu/MXdDZwbXfng/HxdQ3dBf/FagrA3q183U=',
  'h1:c9mfVbtD2uA+hvjfnNkYlPukUlZMXnPwixxrDC7oSXA=',
  'h1:sxkgO4hTyPHFwh1C0O5pLc6pxLsJZzPjFGJxtk7W7PM=',
  'h1:t+sb/n7Sen8JuUUhopgzHQyBPTDXaGilrLIi9/ES/rI=',
  'h1:woX58eC5oUqyPD66goC0+NCSG3lflePWu/7fhnv8K7A=',
  'h1:zf9cw84gk2qDRsmylIU/fKWAni8BQmSJeBwUVvIB5fg=',
];

/** hashicorp/random (released 2026-09-11): its ephemeral random_password generates the database administrator password. */
export const RANDOM_PROVIDER_VERSION = '3.9.1';
const RANDOM_PROVIDER_LOCK_HASHES = [
  'h1:38E2VQmQDhws/3AL3D/EzBGuCseepyZRIswAOx8CqoQ=',
  'h1:7+qv9kpOpBC9EUPCubnPxh603tu3l9EIMMBkpbt1H1Y=',
  'h1:CEQeHfnUDB3uqAkKoEWfWgbj+kpoQHgcuPbAjPzbh+U=',
  'h1:HPYO9tf8KUSHqSdz1uOL97MLeaVHPaWPY1JW6tKU19E=',
  'h1:KYXiC06Pr3WJcIUbDq9MgdAbInO5zcRyHFqV1x5UcJg=',
  'h1:MygjbYH8CrPv8RUe75tZAFmrFNIzQLT45fiyYx7u2tI=',
  'h1:RMSARNOw4qZx+VmHYnVMGljsFVfCV1P+nJjKrN2XIOI=',
  'h1:U/71jbSbfsfVLxWpSlhyVHh/DnQXQhjoJCGkyongkBA=',
  'h1:WwLLvRE1q95CTGxyTjKpctXJ0ooVs9d22JAQS9fC3uo=',
  'h1:ZtRBSqoyfQAhngjUjM0NRPtj6NdSJ/JBENFwT8D276s=',
  'h1:cfxedZLduhHD1UtqQDjAQZNAEhr/bWDAZ4nU9rSdySg=',
  'h1:i45mo4de0QKOreStMqUQ7qyZL3ucFq42l178Fm5/hMU=',
  'h1:v3SAJKN4D3dOM95xKwgKGIWELe5nUBbyXdb5HNz7icw=',
  'h1:v3vTk/STekrzNc6NG3jL9/05zhvF1QVCgyRRbvSHPcI=',
  'h1:zHgFWtRBgOycqhw8HdLSvMVNWGJtIjOAPYOcAdE7cL0=',
];

/**
 * OpenTofu runs as the project's deploy identity. azurerm takes the client
 * secret itself (it has no way to accept a pre-issued access token), so the
 * secret is passed only through the engine process environment and redacted
 * from every output; the deploy identity's roles stop at the project's resource group.
 */
export function azureEngineAuthentication(connection: AzureEngineCredentials): EngineAuthentication {
  return {
    env: {
      ARM_TENANT_ID: connection.tenantId, ARM_SUBSCRIPTION_ID: connection.subscriptionId,
      ARM_CLIENT_ID: connection.clientId, ARM_CLIENT_SECRET: connection.clientSecret,
    },
    redact: [connection.clientSecret],
  };
}

/** The probe's projectId is the resource group's id: /subscriptions/<id>/resourceGroups/<name>. */
export function azureResourceGroupId(subscriptionId: string, resourceGroup: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
}

export const azureEngineBackend: InfrastructureEngineBackend<AzureEngineInput> = {
  provider: 'azure',
  engine: 'opentofu',
  capabilities: ['hosting'],
  providerRequirements: {
    azurerm: { source: 'hashicorp/azurerm', version: AZURERM_PROVIDER_VERSION, lockHashes: AZURERM_PROVIDER_LOCK_HASHES },
    random: { source: 'hashicorp/random', version: RANDOM_PROVIDER_VERSION, lockHashes: RANDOM_PROVIDER_LOCK_HASHES },
  },
  buildConfiguration: buildAzureConfiguration,
  // Reads only: who OpenTofu authenticated as, and that it can see exactly the project's resource group.
  buildAuthenticationProbe: ({ projectId }) => {
    const match = /^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/(hv-[a-z0-9-]{1,60})$/i.exec(projectId);
    if (!match) throw new Error('The Azure probe needs the resource group id.');
    return {
      files: {
        'provider.tf.json': { provider: { azurerm: [{ subscription_id: match[1], resource_provider_registrations: 'none', features: [{}] }] } },
        'probe.tf.json': {
          data: { azurerm_client_config: { current: {} }, azurerm_resource_group: { project: { name: match[2] } } },
          output: {
            identity: { value: '${data.azurerm_client_config.current.object_id}' },
            client_id: { value: '${data.azurerm_client_config.current.client_id}' },
            tenant_id: { value: '${data.azurerm_client_config.current.tenant_id}' },
            project_id: { value: '${data.azurerm_resource_group.project.id}' },
            location: { value: '${data.azurerm_resource_group.project.location}' },
          },
        },
      },
      resources: {},
    };
  },
};
