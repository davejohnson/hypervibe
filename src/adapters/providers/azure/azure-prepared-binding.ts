import type { IPreparedHosting } from '../../../domain/ports/hosting-prepared.port.js';
import { preparedHostingMarkerSchema } from '../../../domain/ports/hosting-prepared.port.js';
import type { CloudDeploymentConnectionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { isDeepStrictEqual } from 'node:util';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { AzureResourceManagerClient } from './azure-resource-manager.client.js';
import { AZURE_PREPARED_API, azureObservedHoldingConfiguration, azurePreparedCoordinates, azurePreparedDigest,
  azurePreparedGrantDescription, azurePreparedGrantId, parseAzurePreparedResources } from './azure-prepared-hosting.js';
import { azureObservedPreparedApplicationConfiguration, azurePreparedApplicationConfiguration, azurePreparedApplicationDigest } from './azure-prepared-release.js';

export function azurePreparedHostingBinding(connection: () => CloudDeploymentConnectionV1 | undefined, client: () => AzureResourceManagerClient): IPreparedHosting {
  return { async inspect({ environment, environmentSpec }) {
    try {
      const approved = connection(); if (!approved?.preparedResources || approved.environment !== environment.name) throw new Error();
      const receipt = parseAzurePreparedResources(approved.preparedResources, approved), c = azurePreparedCoordinates(approved), nativeClient = client();
      const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
      const retained = environment.platformBindings.preparedHosting === undefined ? undefined : preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting);
      if (retained && (retained.installationId !== approved.installationId || retained.planDigest !== approved.planDigest || retained.receiptDigest !== canonicalJsonSha256(approved))) throw new Error();
      for (const [id, lifetimeId, version] of [[receipt.project.id, receipt.project.lifetimeId, AZURE_PREPARED_API.environment],
        [receipt.registry.id, receipt.registry.lifetimeId, AZURE_PREPARED_API.registry]]) {
        const native = await nativeClient.getNullable<any>(id, version);
        if (!native || !same(native.id, id) || native.systemData?.createdAt !== lifetimeId || native.properties?.provisioningState !== 'Succeeded'
          || native.tags?.hypervibeDeployment !== c.owner || native.tags?.hypervibeInstallation !== approved.installationId) throw new Error();
        if (id === receipt.registry.id && (native.properties.loginServer !== c.registryServer || native.properties.adminUserEnabled !== false)) throw new Error();
      }
      const existingBindings = parseHostingBindings(environment);
      const services: Record<string, { serviceId: string; resourceUid: string; resourceType: 'service'; workloadKind: 'web'; imageUri: string }> = {};
      const pending: string[] = [], configurations: Record<string, string> = {};
      for (const prepared of receipt.workloads) {
        const desired = environmentSpec.services[prepared.workload], topology = approved.deployment.workloads.find(item => item.name === prepared.workload);
        const runtime = approved.runtimeIdentities.find(item => item.workload === prepared.workload)?.principal;
        if (!desired || !topology || runtime?.kind !== 'azure-managed-identity' || prepared.holding.principal.kind !== 'azure-managed-identity') throw new Error();
        const supplied = Object.entries(environmentSpec.secretDestinations ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, reference]) => ({ key, reference: runtimeSecretReferenceSchema.parse(reference) }));
        if (!isDeepStrictEqual(supplied, [...topology.runtimeSecrets].sort((a, b) => a.key.localeCompare(b.key)))) throw new Error();
        for (const principal of [runtime, prepared.holding.principal]) {
          const native = await nativeClient.getNullable<any>(principal.identityResourceId, AZURE_PREPARED_API.identity);
          if (!native || !same(native.id, principal.identityResourceId) || native.properties?.principalId !== principal.principalId || native.properties?.clientId !== principal.clientId
            || !same(native.properties.tenantId, principal.tenantId) || native.tags?.hypervibeDeployment !== c.owner || native.tags?.hypervibeInstallation !== approved.installationId) throw new Error();
        }
        const pullKey = `runtime-${prepared.workload}:pull`, pullId = azurePreparedGrantId(c.owner, pullKey, receipt.registry.id);
        const pull = await nativeClient.getNullable<any>(pullId, AZURE_PREPARED_API.grant);
        if (!pull || !same(pull.id, pullId) || pull.properties?.principalId !== runtime.principalId
          || !same(pull.properties.roleDefinitionId, `/subscriptions/${approved.nativeScope.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d`)
          || !same(pull.properties.scope, receipt.registry.id) || pull.properties.condition != null || pull.properties.description !== azurePreparedGrantDescription(c.owner, pullKey)) throw new Error();
        const app = await nativeClient.getNullable<any>(prepared.id, AZURE_PREPARED_API.app);
        if (!app || !same(app.id, prepared.id) || app.systemData?.createdAt !== prepared.lifetimeId || app.properties?.provisioningState !== 'Succeeded'
          || app.properties.latestReadyRevisionName !== app.properties.latestRevisionName || typeof app.properties.latestRevisionName !== 'string'
          || app.tags?.hypervibeDeployment !== c.owner || app.tags?.hypervibeInstallation !== approved.installationId) throw new Error();
        const image = app.properties.template?.containers?.[0]?.image;
        if (image === prepared.holding.image) {
          if (retained && !retained.pendingFirstRelease.includes(prepared.workload)
            || existingBindings.services?.[prepared.workload]?.imageUri && existingBindings.services[prepared.workload].imageUri !== prepared.holding.image) throw new Error();
          const observed = azureObservedHoldingConfiguration(app, { id: prepared.id, lifetimeId: prepared.lifetimeId, image: prepared.holding.image,
            revision: prepared.holding.revision, identityId: prepared.holding.principal.identityResourceId, environmentId: receipt.project.id, publicAccess: true });
          if (azurePreparedDigest(observed) !== prepared.holding.configurationDigest) throw new Error();
          const configured = azurePreparedApplicationConfiguration({ identityId: runtime.identityResourceId, environmentId: receipt.project.id, registryServer: c.registryServer,
            envVars: environmentSpec.envVars, secretVersionRefs: Object.fromEntries(topology.runtimeSecrets.map(item => [item.key, item.reference])),
            startCommand: desired.startCommand ?? null, healthCheckPath: desired.healthCheckPath ?? null });
          pending.push(prepared.workload); configurations[prepared.workload] = azurePreparedApplicationDigest(configured);
        } else {
          const assigned = app.identity?.userAssignedIdentities;
          if (app.identity?.type !== 'UserAssigned' || Object.keys(assigned ?? {}).length !== 1 || assigned?.[runtime.identityResourceId]?.clientId !== runtime.clientId
            || assigned?.[runtime.identityResourceId]?.principalId !== runtime.principalId || typeof image !== 'string'
            || !image.startsWith(`${c.registryServer}/`) || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error();
          const observed = azureObservedPreparedApplicationConfiguration(app), env = app.properties.template.containers[0].env;
          if (retained?.pendingFirstRelease.includes(prepared.workload)
            && azurePreparedApplicationDigest(observed) !== retained.firstReleaseConfigurationDigests?.[prepared.workload]) throw new Error();
          if (!retained) throw new Error();
          if (!/^[a-f0-9]{40}$/.test(env.find((item: any) => item.name === 'HYPERVIBE_DEPLOY_SHA')?.value ?? '')
            || env.find((item: any) => item.name === 'HYPERVIBE_IMAGE_DIGEST')?.value !== image.split('@')[1]) throw new Error();
        }
        services[prepared.workload] = { serviceId: prepared.id, resourceUid: prepared.lifetimeId, resourceType: 'service', workloadKind: 'web', imageUri: image };
      }
      return { state: 'verified', bindings: { provider: 'azure-container-apps', projectId: c.group, environmentId: receipt.project.id,
        providerScope: { registryResourceId: receipt.registry.id, registryCreatedAt: receipt.registry.lifetimeId, registryServer: c.registryServer,
          managedEnvironmentCreatedAt: receipt.project.lifetimeId }, services },
        preparation: { schemaVersion: 1, installationId: approved.installationId, planDigest: approved.planDigest, receiptDigest: canonicalJsonSha256(approved),
          pendingFirstRelease: pending, ...(pending.length ? { firstReleaseConfigurationDigests: configurations } : {}) } };
    } catch { return { state: 'unknown' }; }
  } };
}
