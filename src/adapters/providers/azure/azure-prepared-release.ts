import { createHash } from 'node:crypto';
import type { RuntimeSecretReference } from '../../../domain/ports/secret-destination.port.js';
import type { CloudDeploymentConnectionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import { preparedHostingMarkerSchema } from '../../../domain/ports/hosting-prepared.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import type { BranchDeployTarget } from '../../../domain/ports/ci-deploy.port.js';
import { azureObservedHoldingConfiguration, azurePreparedCoordinates, azurePreparedDigest, azurePreparedGrantId, azurePreparedGrantDescription } from './azure-prepared-hosting.js';

export interface AzurePreparedApplicationInput {
  identityId: string; environmentId: string; registryServer: string; envVars: Record<string, string>;
  secretVersionRefs: Record<string, RuntimeSecretReference>; startCommand: string | null; healthCheckPath: string | null;
}
/** Self-contained renderer also emitted into CI. No secret value is read. */
export function azurePreparedApplicationConfiguration(input: AzurePreparedApplicationInput) {
  const fail = (): never => { throw new Error('The reviewed first Azure application configuration is unavailable.'); };
  if (!/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[A-Za-z0-9_().-]+\/providers\/Microsoft.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9_-]+$/i.test(input.identityId)
    || !/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[A-Za-z0-9_().-]+\/providers\/Microsoft.App\/managedEnvironments\/[a-z0-9-]+$/i.test(input.environmentId)
    || !/^[a-z0-9]{5,50}\.azurecr\.io$/.test(input.registryServer)
    || input.startCommand !== null && (typeof input.startCommand !== 'string' || !input.startCommand.trim())
    || input.healthCheckPath !== null && !/^\/[\x21-\x7e]*$/.test(input.healthCheckPath)) fail();
  const env: Array<{ name: string; value?: string; secretRef?: string }> = [], secrets: Array<{ name: string; keyVaultUrl: string; identity: string }> = [];
  for (const [name, value] of Object.entries(input.envVars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || name.startsWith('HYPERVIBE_') || typeof value !== 'string' || Object.hasOwn(input.secretVersionRefs, name)) fail();
    env.push({ name, value });
  }
  for (const [index, [key, reference]] of Object.entries(input.secretVersionRefs).sort(([a], [b]) => a.localeCompare(b)).entries()) {
    const d = reference.destination;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || key.startsWith('HYPERVIBE_') || d.provider !== 'azure-key-vault'
      || !/^[a-z][a-z0-9-]{1,22}[a-z0-9]$/.test(d.vaultName) || !/^[A-Za-z0-9-]{1,127}$/.test(d.secretName) || !/^[a-f0-9]{32}$/.test(reference.version)) return fail();
    const name = `reference-${index}`;
    env.push({ name: key, secretRef: name }); secrets.push({ name, keyVaultUrl: `https://${d.vaultName}.vault.azure.net/secrets/${d.secretName}/${reference.version}`, identity: input.identityId });
  }
  if (input.startCommand) env.push({ name: 'HYPERVIBE_START_COMMAND', value: input.startCommand });
  env.push({ name: 'HYPERVIBE_HEALTH_CHECK_PATH', value: input.healthCheckPath ?? '/' });
  env.sort((a, b) => a.name.localeCompare(b.name));
  return { identity: { type: 'UserAssigned', userAssignedIdentities: { [input.identityId]: {} } }, properties: {
    managedEnvironmentId: input.environmentId, workloadProfileName: 'Consumption',
    configuration: { activeRevisionsMode: 'Single', ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false },
      identitySettings: [{ identity: input.identityId, lifecycle: 'None' }], registries: [{ server: input.registryServer, identity: input.identityId }], secrets },
    template: { containers: [{ name: 'main', env, resources: { cpu: 0.25, memory: '0.5Gi' },
      ...(input.startCommand ? { command: ['sh'], args: ['-lc', input.startCommand] } : {}), probes: [{ type: 'Liveness', httpGet: { path: input.healthCheckPath ?? '/', port: 8080, scheme: 'HTTP' },
        initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 }] }], scale: { minReplicas: 0, maxReplicas: 4 } } } };
}
export type AzurePreparedApplicationConfiguration = ReturnType<typeof azurePreparedApplicationConfiguration>;
export const azurePreparedApplicationDigest = (value: AzurePreparedApplicationConfiguration) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Projection shared by native readback and emitted CI; unknown runtime fields fail. */
export function azureObservedPreparedApplicationConfiguration(value: unknown): AzurePreparedApplicationConfiguration {
  const fail = (): never => { throw new Error('Azure application configuration could not be verified.'); };
  const r = value as Record<string, any>, p = r?.properties, c = p?.configuration, t = p?.template;
  const keys = (value: any, allowed: string[]) => value && typeof value === 'object' && Object.keys(value).every(key => allowed.includes(key));
  const empty = (value: any) => value === undefined || Array.isArray(value) && value.length === 0;
  const assigned = Object.keys(r?.identity?.userAssignedIdentities ?? {});
  if (r?.identity?.type !== 'UserAssigned' || assigned.length !== 1 || typeof p?.managedEnvironmentId !== 'string' || p.workloadProfileName !== 'Consumption'
    || c?.activeRevisionsMode !== 'Single' || c.ingress?.external !== true || c.ingress.targetPort !== 8080 || c.ingress.transport !== 'auto' || c.ingress.allowInsecure !== false
    || !empty(c.ingress.customDomains) || !empty(c.ingress.ipSecurityRestrictions) || !empty(c.ingress.additionalPortMappings)
    || c.dapr?.enabled === true || !keys(c, ['activeRevisionsMode', 'ingress', 'identitySettings', 'registries', 'secrets', 'dapr', 'maxInactiveRevisions'])
    || !Array.isArray(c.identitySettings) || c.identitySettings.length !== 1 || c.identitySettings[0].identity !== assigned[0] || c.identitySettings[0].lifecycle !== 'None'
    || !Array.isArray(c.registries) || c.registries.length !== 1 || c.registries[0].identity !== assigned[0] || typeof c.registries[0].server !== 'string'
    || !keys(c.registries[0], ['server', 'identity']) || !Array.isArray(c.secrets) || !Array.isArray(t?.containers) || t.containers.length !== 1
    || !empty(t.initContainers) || !empty(t.volumes) || (t.scale?.minReplicas ?? 0) !== 0 || t.scale?.maxReplicas !== 4 || !empty(t.scale.rules)
    || !keys(t, ['containers', 'initContainers', 'volumes', 'scale', 'revisionSuffix', 'terminationGracePeriodSeconds'])) fail();
  const container = t.containers[0], entries = container.env ?? [];
  if (container.name !== 'main' || container.resources?.cpu !== 0.25 || container.resources.memory !== '0.5Gi' || !empty(container.volumeMounts)
    || !keys(container, ['name', 'image', 'env', 'resources', 'command', 'args', 'probes', 'volumeMounts']) || !Array.isArray(entries)
    || new Set(entries.map((entry: any) => entry.name)).size !== entries.length) fail();
  const env = entries.filter((entry: any) => !['HYPERVIBE_DEPLOY_SHA', 'HYPERVIBE_IMAGE_DIGEST'].includes(entry.name)).map((entry: any) => {
    if (!keys(entry, ['name', 'value', 'secretRef']) || typeof entry.name !== 'string' || typeof entry.value === 'string' === (typeof entry.secretRef === 'string')) fail();
    return typeof entry.secretRef === 'string' ? { name: entry.name, secretRef: entry.secretRef } : { name: entry.name, value: entry.value };
  }).sort((a: any, b: any) => a.name.localeCompare(b.name));
  const secrets = c.secrets.map((entry: any) => {
    if (!keys(entry, ['name', 'keyVaultUrl', 'identity']) || typeof entry.name !== 'string' || typeof entry.keyVaultUrl !== 'string' || entry.identity !== assigned[0]) fail();
    return { name: entry.name, keyVaultUrl: entry.keyVaultUrl, identity: entry.identity };
  }).sort((a: any, b: any) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (new Set(secrets.map((entry: any) => entry.name)).size !== secrets.length || env.filter((entry: any) => entry.secretRef).length !== secrets.length
    || secrets.some((secret: any) => env.filter((entry: any) => entry.secretRef === secret.name).length !== 1)) fail();
  const start = env.find((entry: any) => entry.name === 'HYPERVIBE_START_COMMAND')?.value, health = env.find((entry: any) => entry.name === 'HYPERVIBE_HEALTH_CHECK_PATH')?.value;
  if (typeof health !== 'string' || !/^\/[\x21-\x7e]*$/.test(health) || start && (JSON.stringify(container.command) !== JSON.stringify(['sh']) || JSON.stringify(container.args) !== JSON.stringify(['-lc', start]))
    || !start && (!empty(container.command) || !empty(container.args))) fail();
  const probes = [{ type: 'Liveness', httpGet: { path: health, port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 }];
  const probe = container.probes?.[0];
  if (!Array.isArray(container.probes) || container.probes.length !== 1 || !keys(probe, ['type', 'httpGet', 'initialDelaySeconds', 'periodSeconds', 'timeoutSeconds', 'failureThreshold'])
    || !keys(probe.httpGet, ['path', 'port', 'scheme']) || probe.type !== 'Liveness' || probe.httpGet.path !== health || probe.httpGet.port !== 8080 || probe.httpGet.scheme !== 'HTTP'
    || probe.initialDelaySeconds !== 10 || probe.periodSeconds !== 10 || probe.timeoutSeconds !== 5 || probe.failureThreshold !== 6) fail();
  return { identity: { type: 'UserAssigned', userAssignedIdentities: { [assigned[0]]: {} } }, properties: {
    managedEnvironmentId: p.managedEnvironmentId, workloadProfileName: 'Consumption', configuration: { activeRevisionsMode: 'Single',
      ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false }, identitySettings: [{ identity: assigned[0], lifecycle: 'None' }],
      registries: [{ server: c.registries[0].server, identity: assigned[0] }], secrets },
    template: { containers: [{ name: 'main', env, resources: { cpu: 0.25, memory: '0.5Gi' }, ...(start ? { command: ['sh'], args: ['-lc', start] } : {}), probes }], scale: { minReplicas: 0, maxReplicas: 4 } } } };
}

export function azurePreparedHoldingTransition(connection: CloudDeploymentConnectionV1, environment: Environment, workload: string, native: any) {
  const prepared = connection.preparedResources?.workloads.find(item => item.workload === workload); if (!prepared) return null;
  const runtime = connection.runtimeIdentities.find(item => item.workload === workload)?.principal;
  if (runtime?.kind !== 'azure-managed-identity' || prepared.holding.principal.kind !== 'azure-managed-identity') throw new Error('Azure prepared identity is unavailable.');
  const assigned = Object.keys(native?.identity?.userAssignedIdentities ?? {});
  if (assigned.length === 1 && assigned[0].toLowerCase() === runtime.identityResourceId.toLowerCase() && native?.properties?.template?.containers?.[0]?.image !== prepared.holding.image) return null;
  const marker = preparedHostingMarkerSchema.parse(environment.platformBindings.preparedHosting), boundImage = parseHostingBindings(environment).services?.[workload]?.imageUri;
  if (marker.installationId !== connection.installationId || marker.planDigest !== connection.planDigest || marker.receiptDigest !== canonicalJsonSha256(connection)
    || !marker.pendingFirstRelease.includes(workload) || !marker.firstReleaseConfigurationDigests?.[workload] || boundImage && boundImage !== prepared.holding.image) throw new Error('Azure first rollout authority is unavailable.');
  const configuration = azureObservedHoldingConfiguration(native, { id: prepared.id, lifetimeId: prepared.lifetimeId, image: prepared.holding.image,
    revision: prepared.holding.revision, identityId: prepared.holding.principal.identityResourceId, environmentId: azurePreparedCoordinates(connection).managedEnvironment, publicAccess: true });
  if (azurePreparedDigest(configuration) !== prepared.holding.configurationDigest) throw new Error('Azure holding configuration changed.');
  return { prepared, principal: runtime, configurationDigest: marker.firstReleaseConfigurationDigests[workload], deploymentId: native.properties.latestReadyRevisionName as string };
}

/** The same native projections guard local handoff and the executed CI program. */
export function buildAzurePreparedReleaseRuntime(target: BranchDeployTarget): string {
  const connection = target.deploymentAccess?.connection;
  if (!connection?.preparedResources) return '';
  const marker = preparedHostingMarkerSchema.parse(target.preparedRuntime?.preparation), c = azurePreparedCoordinates(connection);
  if (marker.installationId !== connection.installationId || marker.planDigest !== connection.planDigest || marker.receiptDigest !== canonicalJsonSha256(connection)) throw new Error('Azure first release preparation is unavailable.');
  const entries = connection.preparedResources.workloads.map(prepared => {
    const workload = connection.deployment.workloads.find(item => item.name === prepared.workload), runtime = connection.runtimeIdentities.find(item => item.workload === prepared.workload)?.principal;
    const desired = target.runtimeResources?.find(item => item.logicalName === prepared.workload);
    if (!workload || workload.kind !== 'web' || runtime?.kind !== 'azure-managed-identity' || prepared.holding.principal.kind !== 'azure-managed-identity'
      || !desired || desired.providerResourceId !== prepared.id || desired.providerResourceUid !== prepared.lifetimeId || !prepared.holding.revision) throw new Error('Azure first release target is incomplete.');
    const pending = marker.pendingFirstRelease.includes(prepared.workload);
    const configuration = azurePreparedApplicationConfiguration({ identityId: runtime.identityResourceId, environmentId: c.managedEnvironment, registryServer: c.registryServer,
      envVars: target.preparedRuntime!.envVars, secretVersionRefs: Object.fromEntries(workload.runtimeSecrets.map(item => [item.key, item.reference])),
      startCommand: desired.startCommand, healthCheckPath: desired.healthCheckPath });
    if (pending && azurePreparedApplicationDigest(configuration) !== marker.firstReleaseConfigurationDigests?.[prepared.workload]) throw new Error('Azure first runtime configuration requires a reviewed preparation plan.');
    const grants = [{ key: `runtime-${prepared.workload}:pull`, scope: c.registry, role: '7f951dda-4ed3-4680-a7ca-43fe172d538d' },
      ...[...new Set(workload.runtimeSecrets.map(({ reference }) => {
        const d = reference.destination; if (d.provider !== 'azure-key-vault') throw new Error('Azure reader scope is invalid.');
        return `/subscriptions/${d.subscriptionId}/resourceGroups/${d.resourceGroup}/providers/Microsoft.KeyVault/vaults/${d.vaultName}`;
      }))].map(scope => ({ key: `runtime-${prepared.workload}:vault:${scope.toLowerCase()}`, scope, role: '4633458b-17de-408a-b874-0445c86b69e6' }))]
      .map(grant => ({ id: azurePreparedGrantId(c.owner, grant.key, grant.scope), scope: grant.scope, role: `/subscriptions/${connection.nativeScope.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${grant.role}`,
        description: azurePreparedGrantDescription(c.owner, grant.key) }));
    return { prepared, runtime, pending, configuration, grants };
  });
  return `${azureObservedHoldingConfiguration.toString()}
${azureObservedPreparedApplicationConfiguration.toString()}
const hvPreparedReleases = ${JSON.stringify(entries)};
const hvPreparedScope = ${JSON.stringify({ environmentId: c.managedEnvironment, registryServer: c.registryServer, owner: c.owner, installationId: connection.installationId })};
const hvPreparedDigest = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function hvPreparedRelease(current, id, exactImage, sha, operations) {
  const fail = () => { throw new Error('Azure prepared release could not be verified.'); };
  const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const entry = hvPreparedReleases.find(item => item.prepared.id === id); if (!entry) fail();
  const nativeRequest = async (method, resourceId, version, body) => {
    const token = (await hvDeploymentSession('resource-manager')).token;
    return hvAzureJson('https://management.azure.com' + resourceId + '?api-version=' + version, { method,
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  const verifyLifetime = app => {
    if (!same(app?.id, id) || app?.systemData?.createdAt !== entry.prepared.lifetimeId || app.tags?.hypervibeDeployment !== hvPreparedScope.owner
      || app.tags?.hypervibeInstallation !== hvPreparedScope.installationId || !same(app.properties?.managedEnvironmentId, hvPreparedScope.environmentId)) fail();
  };
  const verifyPrincipal = (app, principal) => {
    const assigned = Object.entries(app?.identity?.userAssignedIdentities || {}), identity = assigned.find(([id]) => same(id, principal.identityResourceId))?.[1];
    if (app?.identity?.type !== 'UserAssigned' || assigned.length !== 1 || identity?.clientId !== principal.clientId || identity?.principalId !== principal.principalId) fail();
  };
  verifyLifetime(current);
  if (!exactImage.startsWith(hvPreparedScope.registryServer + '/') || exactImage === entry.prepared.holding.image || !/@sha256:[a-f0-9]{64}$/.test(exactImage) || !/^[a-f0-9]{40}$/.test(sha)) fail();
  const isHolding = current.properties?.template?.containers?.[0]?.image === entry.prepared.holding.image;
  let configuration;
  if (isHolding) {
    if (!entry.pending || process.env.DEPLOY_OPERATION === 'rollback') fail();
    verifyPrincipal(current, entry.prepared.holding.principal);
    const holding = azureObservedHoldingConfiguration(current, { id, lifetimeId: entry.prepared.lifetimeId, revision: entry.prepared.holding.revision,
      image: entry.prepared.holding.image, identityId: entry.prepared.holding.principal.identityResourceId, environmentId: hvPreparedScope.environmentId, publicAccess: true });
    if (hvPreparedDigest(holding) !== entry.prepared.holding.configurationDigest) fail();
    configuration = entry.configuration;
  } else {
    verifyPrincipal(current, entry.runtime);
    configuration = azureObservedPreparedApplicationConfiguration(current);
    if (JSON.stringify(configuration.properties.configuration.secrets) !== JSON.stringify(entry.configuration.properties.configuration.secrets)) fail();
  }
  const expectedConfiguration = hvPreparedDigest(configuration);
  const identity = await nativeRequest('GET', entry.runtime.identityResourceId, '2024-11-30');
  if (!same(identity?.id, entry.runtime.identityResourceId) || identity.properties?.clientId !== entry.runtime.clientId || identity.properties?.principalId !== entry.runtime.principalId
    || !same(identity.properties?.tenantId, entry.runtime.tenantId) || identity.tags?.hypervibeDeployment !== hvPreparedScope.owner || identity.tags?.hypervibeInstallation !== hvPreparedScope.installationId) fail();
  for (const grant of entry.grants) {
    const native = await nativeRequest('GET', grant.id, '2022-04-01'), p = native?.properties;
    if (!same(native?.id, grant.id) || !same(p?.principalId, entry.runtime.principalId) || !same(p?.roleDefinitionId, grant.role) || !same(p?.scope, grant.scope)
      || p?.principalType !== 'ServicePrincipal' || p?.condition != null || p?.description !== grant.description) fail();
  }
  const digest = exactImage.split('@')[1], container = configuration.properties.template.containers[0];
  const revisionSuffix = 'hv-' + sha.slice(0, 10) + (operations.length ? '-c-' + hvPreparedDigest([...new Set(operations)].sort()).slice(0, 12) : '');
  const expectedRevision = operations.length ? id.split('/').at(-1) + '--' + revisionSuffix : undefined;
  const body = { ...configuration, properties: { ...configuration.properties, template: { ...configuration.properties.template, revisionSuffix,
    containers: [{ ...container, image: exactImage, env: [...container.env, { name: 'HYPERVIBE_DEPLOY_SHA', value: sha }, { name: 'HYPERVIBE_IMAGE_DIGEST', value: digest }] }] } } };
  const isReady = app => {
    verifyLifetime(app); verifyPrincipal(app, entry.runtime);
    const p = app.properties, active = p.template?.containers?.[0], env = active?.env || [];
    return (!expectedRevision || p.latestReadyRevisionName === expectedRevision) && p.provisioningState === 'Succeeded' && typeof p.latestRevisionName === 'string' && p.latestReadyRevisionName === p.latestRevisionName
      && active.image === exactImage && env.find(item => item.name === 'HYPERVIBE_DEPLOY_SHA')?.value === sha
      && env.find(item => item.name === 'HYPERVIBE_IMAGE_DIGEST')?.value === digest
      && hvPreparedDigest(azureObservedPreparedApplicationConfiguration(app)) === expectedConfiguration;
  };
  let ready = !isHolding && isReady(current) ? current : undefined;
  if (!ready) {
    // Exactly one update; a lost acknowledgment remains uncertain and is never
    // retried by this execution. Old holding code has no secretRef entries and
    // lifecycle None denies its container access to the reader token endpoint.
    await nativeRequest('PATCH', id, '2026-01-01', body);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const observed = await nativeRequest('GET', id, '2026-01-01');
      verifyLifetime(observed);
      if (['Failed', 'Canceled'].includes(observed.properties?.provisioningState)) fail();
      if (observed.properties?.provisioningState === 'Succeeded' && observed.properties.latestReadyRevisionName === observed.properties.latestRevisionName && isReady(observed)) { ready = observed; break; }
      if (attempt < 119) await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  const fqdn = ready?.properties?.configuration?.ingress?.fqdn, health = configuration.properties.template.containers[0].env.find(item => item.name === 'HYPERVIBE_HEALTH_CHECK_PATH')?.value;
  if (!fqdn || !/^[a-z0-9.-]+$/.test(fqdn) || !health?.startsWith('/')) fail();
  const response = await fetch('https://' + fqdn + health, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  void response.body?.cancel().catch(() => {}); if (!response.ok) fail();
  return ready.properties.latestReadyRevisionName;
}
`;
}
