import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloudDeploymentConnectionV1, CloudDeploymentPreparedResourcesV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { cloudDeploymentPreparedResourcesSchema } from '../../../domain/services/cloud-deployment-authentication.js';
import { resourceName } from '../../../domain/services/resource-names.js';

export const AZURE_PREPARED_API = { group: '2022-09-01', identity: '2024-11-30', federation: '2024-11-30',
  role: '2022-04-01', grant: '2022-04-01', registry: '2025-11-01', environment: '2026-01-01', app: '2026-01-01', vault: '2024-11-01', provider: '2021-04-01' } as const;
export const azureHoldingImageSchema = z.string().max(2048)
  .regex(/^[a-z][a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/)
  .refine(value => value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
export const azurePreparedDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function azurePreparedGuid(value: unknown) { const h = azurePreparedDigest(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }
export function azurePreparedGrantId(owner: string, key: string, scope: string) { return `${scope}/providers/Microsoft.Authorization/roleAssignments/${azurePreparedGuid([owner, key])}`; }
export function azurePreparedGrantDescription(owner: string, key: string) { return `Hypervibe deployment ${owner}; ${azurePreparedDigest(`grant:${key}`)}`; }
export function azurePreparedCoordinates(connection: Pick<CloudDeploymentConnectionV1, 'customerId' | 'appId' | 'environment' | 'installationId' | 'nativeScope'>) {
  const s = connection.nativeScope, group = `/subscriptions/${s.subscriptionId}/resourceGroups/${s.resourceGroup}`;
  const parts = [connection.customerId, connection.appId, connection.environment, connection.installationId];
  const owner = azurePreparedDigest([...parts, s]);
  const identity = (purpose: string) => `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${resourceName(purpose, { scope: parts, minLength: 3, maxLength: 128 })}`;
  const registryName = `hv${createHash('sha256').update(group.toLowerCase(), 'utf8').digest('hex').slice(0, 30)}`;
  return { group, owner, identity, registry: `${group}/providers/Microsoft.ContainerRegistry/registries/${registryName}`,
    registryServer: `${registryName}.azurecr.io`, managedEnvironment: `${group}/providers/Microsoft.App/managedEnvironments/runtime`,
    app: (name: string) => `${group}/providers/Microsoft.App/containerApps/${resourceName(name, { minLength: 2, maxLength: 32 })}` };
}

/** Self-contained and emitted into CI; holding code receives no secret or reader grant. */
export function azureHoldingConfiguration(image: string, identityId: string, environmentId: string, publicAccess: boolean) {
  return { identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: {} } }, properties: {
    managedEnvironmentId: environmentId, workloadProfileName: 'Consumption',
    configuration: { activeRevisionsMode: 'Single', ingress: { external: publicAccess, targetPort: 8080, transport: 'auto', allowInsecure: false },
      secrets: [], registries: [], identitySettings: [{ identity: identityId, lifecycle: 'None' }] }, template: { containers: [{ name: 'main', image, env: [], resources: { cpu: 0.25, memory: '0.5Gi' } }],
      scale: { minReplicas: 0, maxReplicas: 1 } } } };
}
/** Normalize optional empty collections only. Unexpected executable configuration is rejected. */
export function azureObservedHoldingConfiguration(value: unknown, expected: { id: string; lifetimeId?: string; revision?: string; image: string; identityId: string; environmentId: string; publicAccess: boolean }) {
  const fail = (): never => { throw new Error('Azure prepared workload identity or configuration could not be verified.'); };
  const r = value as Record<string, any>, p = r?.properties, c = p?.configuration, t = p?.template;
  const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const empty = (v: unknown) => v === undefined || Array.isArray(v) && v.length === 0;
  const keys = (v: Record<string, unknown>, allowed: string[]) => v && Object.keys(v).every(key => allowed.includes(key));
  if (!same(r?.id, expected.id) || typeof r.systemData?.createdAt !== 'string' || !Number.isFinite(Date.parse(r.systemData.createdAt))
    || expected.lifetimeId && r.systemData.createdAt !== expected.lifetimeId || p?.provisioningState !== 'Succeeded'
    || typeof p.latestRevisionName !== 'string' || p.latestReadyRevisionName !== p.latestRevisionName
    || expected.revision && p.latestReadyRevisionName !== expected.revision
    || r.identity?.type !== 'UserAssigned' || Object.keys(r.identity.userAssignedIdentities ?? {}).length !== 1
    || !Object.keys(r.identity.userAssignedIdentities).some(id => same(id, expected.identityId))
    || !same(p.managedEnvironmentId, expected.environmentId) || p.workloadProfileName !== 'Consumption'
    || c?.activeRevisionsMode !== 'Single' || !empty(c.secrets) || !empty(c.registries) || c.dapr?.enabled === true
    || !keys(c, ['activeRevisionsMode', 'ingress', 'secrets', 'registries', 'dapr', 'maxInactiveRevisions', 'identitySettings'])
    || !Array.isArray(c.identitySettings) || c.identitySettings.length !== 1 || !same(c.identitySettings[0]?.identity, expected.identityId) || c.identitySettings[0]?.lifecycle !== 'None'
    || c.ingress?.external !== expected.publicAccess || c.ingress.targetPort !== 8080 || c.ingress.transport !== 'auto'
    || c.ingress.allowInsecure !== false || !empty(c.ingress.customDomains) || !empty(c.ingress.ipSecurityRestrictions)
    || !empty(c.ingress.additionalPortMappings) || c.ingress.clientCertificateMode && c.ingress.clientCertificateMode !== 'ignore'
    || !empty(t?.volumes) || !empty(t?.initContainers) || !Array.isArray(t?.containers) || t.containers.length !== 1
    || (t.scale?.minReplicas ?? 0) !== 0 || t.scale?.maxReplicas !== 1 || !empty(t.scale.rules)
    || !keys(t, ['containers', 'initContainers', 'volumes', 'scale', 'revisionSuffix', 'terminationGracePeriodSeconds'])) fail();
  const container = t.containers[0];
  if (container.name !== 'main' || container.image !== expected.image || !empty(container.env) || !empty(container.command)
    || !empty(container.args) || !empty(container.volumeMounts) || !empty(container.probes)
    || container.resources?.cpu !== 0.25 || container.resources?.memory !== '0.5Gi'
    || !keys(container, ['name', 'image', 'env', 'command', 'args', 'volumeMounts', 'probes', 'resources'])) fail();
  return { identity: { type: 'UserAssigned', userAssignedIdentities: { [expected.identityId]: {} } }, properties: {
    managedEnvironmentId: expected.environmentId, workloadProfileName: 'Consumption',
    configuration: { activeRevisionsMode: 'Single', ingress: { external: expected.publicAccess, targetPort: 8080, transport: 'auto', allowInsecure: false }, secrets: [], registries: [], identitySettings: [{ identity: expected.identityId, lifecycle: 'None' }] },
    template: { containers: [{ name: 'main', image: expected.image, env: [], resources: { cpu: 0.25, memory: '0.5Gi' } }], scale: { minReplicas: 0, maxReplicas: 1 } } } };
}
export function parseAzurePreparedResources(value: unknown, connection: CloudDeploymentConnectionV1): CloudDeploymentPreparedResourcesV1 {
  const parsed = cloudDeploymentPreparedResourcesSchema.parse(value), c = azurePreparedCoordinates(connection);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const date = (value: string) => z.string().datetime({ offset: true }).safeParse(value).success;
  if (!connection.deployment.preparation || !same(parsed.project.id, c.managedEnvironment) || !same(parsed.project.parentId ?? '', c.group)
    || !date(parsed.project.lifetimeId) || !same(parsed.registry.id, c.registry) || !date(parsed.registry.lifetimeId) || parsed.registry.owner !== c.owner
    || parsed.workloads.length !== connection.deployment.workloads.length) throw new Error('Azure prepared resource scope mismatch.');
  const secrets = [...new Set(connection.deployment.workloads.flatMap(workload => workload.runtimeSecrets.map(({ reference }) => {
    const d = reference.destination; if (d.provider !== 'azure-key-vault') throw new Error('Azure prepared secret scope mismatch.');
    return `/subscriptions/${d.subscriptionId}/resourceGroups/${d.resourceGroup}/providers/Microsoft.KeyVault/vaults/${d.vaultName}`.toLowerCase();
  })))].sort();
  if (JSON.stringify((parsed.secretTargets ?? []).map(item => item.id.toLowerCase()).sort()) !== JSON.stringify(secrets)
    || parsed.secretTargets?.some(item => !date(item.lifetimeId))) throw new Error('Azure prepared secret lifetime mismatch.');
  for (const workload of parsed.workloads) {
    const declared = connection.deployment.workloads.find(item => item.name === workload.workload), principal = workload.holding.principal;
    if (!declared || workload.kind !== 'service' || !same(workload.id, c.app(workload.workload)) || !date(workload.lifetimeId)
      || workload.owner !== c.owner || principal.kind !== 'azure-managed-identity' || !same(principal.identityResourceId, c.identity('holding'))
      || !same(principal.tenantId, connection.nativeScope.tenantId) || !same(principal.subscriptionId, connection.nativeScope.subscriptionId)
      || workload.holding.image !== connection.deployment.preparation.image
      || !workload.holding.revision || !/^[a-z0-9][a-z0-9-]{0,126}$/.test(workload.holding.revision)
      || workload.holding.configurationDigest !== azurePreparedDigest(azureHoldingConfiguration(workload.holding.image, c.identity('holding'), c.managedEnvironment, declared.public === true))) {
      throw new Error('Azure prepared workload scope mismatch.');
    }
  }
  return parsed;
}
