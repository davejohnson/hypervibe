import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CloudDeploymentConnectionV1, CloudDeploymentReleaseTargetRequestV1, CloudDeploymentReleaseTargetV1,
  CloudDeploymentSessionRequestV1, CloudDeploymentSessionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { CloudDeploymentAccessError } from '../../../domain/services/cloud-deployment-authentication.js';
import { repoBindingsFileSchema } from '../../../domain/spec/repo-bindings.schema.js';
import { preparedHostingBindingsSchema, preparedHostingMarkerSchema } from '../../../domain/ports/hosting-prepared.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { rejectAzureCredentialEcho } from './azure-arm-installation.js';
import { AZURE_PREPARED_ROLES } from './azure-prepared-installation.js';
import { AZURE_PREPARED_API, azureObservedHoldingConfiguration, azurePreparedCoordinates, azurePreparedDigest,
  azurePreparedGrantDescription, azurePreparedGrantId, azurePreparedGuid, parseAzurePreparedResources } from './azure-prepared-hosting.js';
import { azureObservedPreparedApplicationConfiguration, azurePreparedApplicationConfiguration, azurePreparedApplicationDigest } from './azure-prepared-release.js';

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const unavailable = () => new CloudDeploymentAccessError('authorization_unavailable');
const targetSchema = z.array(z.object({ workload: z.string(), kind: z.literal('service'),
  service: z.object({ id: z.string().max(2048), lifetimeId: z.string().datetime({ offset: true }) }).strict(),
  registry: z.object({ id: z.string().max(2048), lifetimeId: z.string().datetime({ offset: true }) }).strict(),
}).strict()).min(1).max(8);

export function parseAzurePreparedReleaseTargets(value: unknown, connection: CloudDeploymentConnectionV1): CloudDeploymentReleaseTargetV1[] {
  try {
    const prepared = parseAzurePreparedResources(connection.preparedResources, connection), targets = targetSchema.parse(value);
    if (targets.length !== prepared.workloads.length || new Set(targets.map(item => item.workload)).size !== targets.length) throw unavailable();
    for (const item of targets) {
      const workload = prepared.workloads.find(value => value.workload === item.workload);
      if (!workload || !same(item.service.id, workload.id) || item.service.lifetimeId !== workload.lifetimeId
        || !same(item.registry.id, prepared.registry.id) || item.registry.lifetimeId !== prepared.registry.lifetimeId) throw unavailable();
    }
    return targets;
  } catch { throw unavailable(); }
}

/** Read-only enrollment of already applied bindings. Provisional native release
 * authentication remains private; no app, registry, identity or IAM repair exists here.
 */
export async function verifyAzurePreparedReleaseTargets(input: CloudDeploymentReleaseTargetRequestV1, options: {
  request: typeof fetch; deadlineMs?: number;
  issueSession(input: CloudDeploymentSessionRequestV1): Promise<CloudDeploymentSessionV1>;
}): Promise<CloudDeploymentReleaseTargetV1[]> {
  const budget = new DestinationBudget({ signal: input.signal, deadlineMs: options.deadlineMs });
  try {
    const connection = input.connection, prepared = parseAzurePreparedResources(connection.preparedResources, connection), coordinates = azurePreparedCoordinates(connection);
    const envelope = repoBindingsFileSchema.parse(input.bindings), raw = envelope.environments[connection.environment]?.platformBindings;
    if (envelope.project !== input.spec.project || !raw) throw unavailable();
    const bindings = preparedHostingBindingsSchema.parse({ provider: raw.provider, projectId: raw.projectId, environmentId: raw.environmentId,
      providerScope: raw.providerScope, services: Object.fromEntries(Object.entries((raw.services ?? {}) as Record<string, Record<string, unknown>>)
        .map(([name, service]) => [name, { serviceId: service.serviceId, resourceUid: service.resourceUid, resourceType: service.resourceType,
          workloadKind: service.workloadKind, imageUri: service.imageUri, ...(service.jobName ? { jobName: service.jobName } : {}) }])) });
    const marker = preparedHostingMarkerSchema.parse(raw.preparedHosting), environment = input.spec.environments[connection.environment];
    if (!environment || bindings.provider !== 'azure-container-apps' || !same(bindings.projectId, coordinates.group)
      || !same(bindings.environmentId, prepared.project.id) || !same(bindings.providerScope.registryResourceId, prepared.registry.id)
      || bindings.providerScope.registryCreatedAt !== prepared.registry.lifetimeId || bindings.providerScope.registryServer !== coordinates.registryServer
      || bindings.providerScope.managedEnvironmentCreatedAt !== prepared.project.lifetimeId || marker.installationId !== connection.installationId
      || marker.planDigest !== connection.planDigest || marker.receiptDigest !== canonicalJsonSha256(connection)
      || Object.keys(bindings.services).length !== prepared.workloads.length) throw unavailable();
    for (const workload of prepared.workloads) {
      const bound = bindings.services[workload.workload];
      if (!bound || !same(bound.serviceId, workload.id) || bound.resourceUid !== workload.lifetimeId || bound.resourceType !== 'service'
        || bound.workloadKind !== 'web' || bound.jobName) throw unavailable();
    }
    const issued = await budget.wait(options.issueSession({ connection, capability: 'release', target: 'resource-manager', host: input.host,
      signal: budget.signal, beforeIssue: input.beforeIssue }));
    if (issued.kind !== 'azure-federation' || issued.target !== 'resource-manager'
      || !isDeepStrictEqual(issued.principal, connection.principals.release)) throw unavailable();
    const read = async (id: string, version: string) => {
      const value = await destinationJson(options.request, budget, `https://management.azure.com${id}?api-version=${version}`, issued.token);
      rejectAzureCredentialEcho(value, issued.token); return value as Record<string, any>;
    };
    const own = (native: Record<string, any>, id: string, lifetimeId: string) => {
      if (!same(native.id, id) || native.systemData?.createdAt !== lifetimeId || native.properties?.provisioningState !== 'Succeeded'
        || native.tags?.hypervibeInstallation !== connection.installationId || native.tags?.hypervibeDeployment !== coordinates.owner) throw unavailable();
    };
    const registry = await read(prepared.registry.id, AZURE_PREPARED_API.registry), managed = await read(prepared.project.id, AZURE_PREPARED_API.environment);
    own(registry, prepared.registry.id, prepared.registry.lifetimeId); own(managed, prepared.project.id, prepared.project.lifetimeId);
    if (registry.properties.loginServer !== coordinates.registryServer || registry.properties.adminUserEnabled !== false) throw unavailable();
    const subscription = `/subscriptions/${connection.nativeScope.subscriptionId}`;
    const roleId = (key: keyof typeof AZURE_PREPARED_ROLES) => `${subscription}/providers/Microsoft.Authorization/roleDefinitions/${azurePreparedGuid([coordinates.owner, 'role', key])}`;
    for (const key of ['inspect', 'release', 'assign', 'join', ...(prepared.secretTargets?.length ? ['vault'] : [])] as Array<keyof typeof AZURE_PREPARED_ROLES>) {
      const native = await read(`${coordinates.group}/providers/Microsoft.Authorization/roleDefinitions/${roleId(key).split('/').at(-1)}`, AZURE_PREPARED_API.role), properties = native.properties;
      const permission = properties?.permissions;
      if (!same(native.id, roleId(key)) || properties?.type !== 'CustomRole'
        || properties.description !== `Hypervibe deployment ${coordinates.owner}; ${azurePreparedDigest(`role:${key}`)}`
        || !isDeepStrictEqual(properties.assignableScopes, [subscription]) || !Array.isArray(permission) || permission.length !== 1
        || !Array.isArray(permission[0].actions) || !isDeepStrictEqual([...permission[0].actions].sort(), [...AZURE_PREPARED_ROLES[key]].sort())
        || !isDeepStrictEqual(permission[0].notActions, []) || !isDeepStrictEqual(permission[0].dataActions, []) || !isDeepStrictEqual(permission[0].notDataActions, [])) throw unavailable();
    }
    const grant = async (key: string, scope: string, principalId: string, role: string) => {
      const id = azurePreparedGrantId(coordinates.owner, key, scope), native = await read(id, AZURE_PREPARED_API.grant), p = native.properties;
      if (!same(native.id, id) || !same(p?.principalId, principalId) || !same(p?.roleDefinitionId, role) || !same(p?.scope, scope)
        || p.principalType !== 'ServicePrincipal' || p.condition != null || p.description !== azurePreparedGrantDescription(coordinates.owner, key)) throw unavailable();
    };
    const release = issued.principal;
    await grant('release:inspect', coordinates.group, release.principalId, roleId('inspect'));
    await grant('release:join', prepared.project.id, release.principalId, roleId('join'));
    await grant('release:push', prepared.registry.id, release.principalId, `${subscription}/providers/Microsoft.Authorization/roleDefinitions/8311e382-0749-4cb8-b61a-304f252e45ec`);
    for (const vault of prepared.secretTargets ?? []) {
      const native = await read(vault.id, AZURE_PREPARED_API.vault), p = native.properties;
      if (!same(native.id, vault.id) || native.systemData?.createdAt !== vault.lifetimeId || p?.provisioningState !== 'Succeeded'
        || !same(p.tenantId, connection.nativeScope.tenantId) || p.enableRbacAuthorization !== true || native.tags?.hypervibeCustomerId !== connection.customerId
        || native.tags?.hypervibeAppId !== connection.appId || native.tags?.hypervibeEnvironment !== connection.environment) throw unavailable();
      await grant(`release:vault:${vault.id.toLowerCase()}`, vault.id, release.principalId, roleId('vault'));
    }
    for (const workload of prepared.workloads) {
      const declaration = connection.deployment.workloads.find(value => value.name === workload.workload)!, desired = environment.services[workload.workload];
      const runtime = connection.runtimeIdentities.find(value => value.workload === workload.workload)?.principal, holding = workload.holding.principal;
      if (runtime?.kind !== 'azure-managed-identity' || holding.kind !== 'azure-managed-identity' || !desired) throw unavailable();
      for (const principal of [runtime, holding]) {
        const native = await read(principal.identityResourceId, AZURE_PREPARED_API.identity), p = native.properties;
        if (!same(native.id, principal.identityResourceId) || !same(p?.tenantId, principal.tenantId) || !same(p?.principalId, principal.principalId)
          || !same(p?.clientId, principal.clientId) || native.tags?.hypervibeInstallation !== connection.installationId || native.tags?.hypervibeDeployment !== coordinates.owner) throw unavailable();
      }
      await grant(`release:app:${workload.workload}`, workload.id, release.principalId, roleId('release'));
      await grant(`release:assign:${workload.workload}`, runtime.identityResourceId, release.principalId, roleId('assign'));
      await grant(`runtime-${workload.workload}:pull`, prepared.registry.id, runtime.principalId, `${subscription}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d`);
      for (const vault of prepared.secretTargets ?? []) if (declaration.runtimeSecrets.some(({ reference }) => reference.destination.provider === 'azure-key-vault'
        && same(vault.id, `${subscription}/resourceGroups/${reference.destination.resourceGroup}/providers/Microsoft.KeyVault/vaults/${reference.destination.vaultName}`)))
        await grant(`runtime-${workload.workload}:vault:${vault.id.toLowerCase()}`, vault.id, runtime.principalId, `${subscription}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`);
      const native = await read(workload.id, AZURE_PREPARED_API.app); own(native, workload.id, workload.lifetimeId);
      if (typeof native.properties.latestRevisionName !== 'string' || !native.properties.latestRevisionName
        || native.properties.latestReadyRevisionName !== native.properties.latestRevisionName) throw unavailable();
      const expected = azurePreparedApplicationConfiguration({ identityId: runtime.identityResourceId, environmentId: prepared.project.id,
        registryServer: coordinates.registryServer, envVars: environment.envVars, secretVersionRefs: Object.fromEntries(declaration.runtimeSecrets.map(value => [value.key, value.reference])),
        startCommand: desired.startCommand ?? null, healthCheckPath: desired.healthCheckPath ?? null });
      const image = native.properties.template?.containers?.[0]?.image;
      if (image === workload.holding.image) {
        if (!marker.pendingFirstRelease.includes(workload.workload) || bindings.services[workload.workload].imageUri !== image
          || marker.firstReleaseConfigurationDigests?.[workload.workload] !== azurePreparedApplicationDigest(expected)) throw unavailable();
        const configuration = azureObservedHoldingConfiguration(native, { id: workload.id, lifetimeId: workload.lifetimeId, revision: workload.holding.revision,
          image, identityId: holding.identityResourceId, environmentId: prepared.project.id, publicAccess: true });
        if (azurePreparedDigest(configuration) !== workload.holding.configurationDigest) throw unavailable();
      } else {
        const assigned = native.identity?.userAssignedIdentities;
        if (typeof image !== 'string' || !image.startsWith(`${coordinates.registryServer}/`) || !/@sha256:[a-f0-9]{64}$/.test(image)
          || !same(assigned?.[runtime.identityResourceId]?.clientId, runtime.clientId) || !same(assigned?.[runtime.identityResourceId]?.principalId, runtime.principalId)
          || azurePreparedApplicationDigest(azureObservedPreparedApplicationConfiguration(native)) !== azurePreparedApplicationDigest(expected)) throw unavailable();
      }
    }
    await budget.wait(input.beforeIssue());
    return parseAzurePreparedReleaseTargets(prepared.workloads.map(workload => ({ workload: workload.workload, kind: 'service',
      service: { id: workload.id, lifetimeId: workload.lifetimeId }, registry: { id: prepared.registry.id, lifetimeId: prepared.registry.lifetimeId } })), connection);
  } catch { throw unavailable(); }
  finally { budget.close(); }
}
