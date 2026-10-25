import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver, type CloudInstallationIntent } from '../../../domain/ports/cloud-installation.port.js';
import type { CloudDeploymentTopologyV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { CloudDeploymentAccessError, parseCloudDeploymentConnectionV1, parseCloudDeploymentTopologyV1 } from '../../../domain/services/cloud-deployment-authentication.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { AZURE_HOST_FEDERATION_AUDIENCE, createAzureDeploymentTokenProvider } from './azure-federated-auth.js';

const ARM = 'https://management.azure.com';
const MI_API = '2024-11-30';
const scope = z.object({ tenantId: z.string().guid(), subscriptionId: z.string().guid(),
  resourceGroup: z.string().regex(/^[A-Za-z0-9_().-]{1,90}$/).refine(value => !value.endsWith('.')),
  location: z.string().regex(/^[a-z][a-z0-9]{1,39}$/) }).strict();
const fail = () => new CloudDeploymentAccessError('scope_mismatch');
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
export const azureDeploymentContract = { provider: 'azure' as const, hostingProvider: 'azure-container-apps',
  parseScope(value: unknown): Record<string, string> { try { return scope.parse(value); } catch { throw fail(); } } };

export function azureDeploymentCoordinates(value: Pick<CloudInstallationIntent, 'customerId' | 'appId' | 'environment' | 'installationId' | 'nativeScope'>) {
  const nativeScope = scope.parse(value.nativeScope);
  const group = `/subscriptions/${nativeScope.subscriptionId}/resourceGroups/${nativeScope.resourceGroup}`;
  const owner = createHash('sha256').update(JSON.stringify([value.customerId, value.appId, value.environment, value.installationId, nativeScope])).digest('hex');
  const identity = (purpose: string) => `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${resourceName(purpose,
    { scope: [value.customerId, value.appId, value.environment, value.installationId], minLength: 3, maxLength: 128 })}`;
  return { nativeScope, group, owner, identity };
}
function topology(value: unknown, nativeScope: Record<string, string>) {
  const result = parseCloudDeploymentTopologyV1(value);
  if (result.hostingProvider !== azureDeploymentContract.hostingProvider || result.region !== nativeScope.location
    || result.workloads.some(workload => workload.kind !== 'web' || workload.runtimeSecrets.some(({ reference }) => {
      const d = reference.destination;
      return d.provider !== 'azure-key-vault' || !same(d.tenantId, nativeScope.tenantId) || !same(d.subscriptionId, nativeScope.subscriptionId);
    }))) throw fail();
  return result;
}
function prepareIntent(spec: ProjectSpec, intent: CloudInstallationIntent): CloudDeploymentTopologyV1 {
  const environment = spec.environments[intent.environment];
  if (!environment || environment.hosting.provider !== azureDeploymentContract.hostingProvider
    || environment.database || environment.cache || Object.keys(environment.storage ?? {}).length || Object.keys(environment.queues ?? {}).length
    || environment.domain || environment.loadBalancer || environment.domainRegistration || environment.dataMigration || environment.migrations
    || environment.email.enabled || environment.messaging || environment.payments || environment.ios
    || Object.values(environment.services).some(service => service.workloadKind !== 'web' || service.volume || service.releaseCommand
      || Object.keys(service.databaseEnvAliases ?? {}).length)) throw new CloudDeploymentAccessError('unsupported');
  const runtimeSecrets = Object.entries(environment.secretDestinations ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, reference]) => ({ key, reference: runtimeSecretReferenceSchema.parse(reference) }));
  return topology({ hostingProvider: environment.hosting.provider, region: environment.hosting.region ?? intent.nativeScope.location,
    workloads: Object.entries(environment.services).sort(([a], [b]) => a.localeCompare(b)).map(([name, service]) => ({ name, kind: service.workloadKind, runtimeSecrets })) }, intent.nativeScope);
}
function parseConnection(value: unknown) {
  const connection = parseCloudDeploymentConnectionV1(value, azureDeploymentContract);
  const coordinates = azureDeploymentCoordinates(connection); topology(connection.deployment, coordinates.nativeScope);
  for (const purpose of ['provision', 'release'] as const) {
    const principal = connection.principals[purpose];
    if (principal.kind !== 'azure-managed-identity' || !same(principal.identityResourceId, coordinates.identity(purpose))) throw fail();
  }
  for (const runtime of connection.runtimeIdentities) if (runtime.principal.kind !== 'azure-managed-identity'
    || !same(runtime.principal.identityResourceId, coordinates.identity(`runtime-${runtime.workload}`)) || runtime.owner !== coordinates.owner) throw fail();
  return connection;
}

/** Separate deployment authority. Fresh native creates stay blocked until atomic ownership is proven. */
export function createAzureDeploymentInstallationDriver(options: { fetch?: typeof fetch; deadlineMs?: number } = {}): CloudInstallationDriver {
  const request = options.fetch ?? fetch;
  const action = (intent: CloudInstallationIntent): CloudInstallationAction => {
    const c = azureDeploymentCoordinates(intent); topology(intent.deployment, c.nativeScope);
    if (intent.purpose !== 'deployment' || intent.stage !== 'deployment' || intent.mode !== 'connect' || intent.keys.length) throw fail();
    return { id: 'azure:deployment', type: 'create', resource: { kind: 'project', name: c.nativeScope.resourceGroup, provider: 'azure' }, verified: false,
      requiresConfirm: true, reason: 'Prepare separate provision, release and workload identities only after native creation ownership is verified.',
      metadata: { operation: 'azureDeploymentInstallation', category: 'identity', execution: 'api', native: { scopeDigest: c.owner, resourceGroupId: c.group } } };
  };
  const driver: CloudInstallationDriver = {
    provider: 'azure', parseScope: azureDeploymentContract.parseScope,
    parseAction(value, intent) { const expected = action(intent); if (!isDeepStrictEqual(value, expected)) throw fail(); return expected; },
    // No release of this installer has completed an Azure deployment installation.
    // Do not fabricate historical ownership or accept copied native identities.
    parseEvidence() { throw new CloudInstallationBoundaryError('create_ownership_unverified'); },
    connections() { return []; },
    deployment: { hostingProvider: azureDeploymentContract.hostingProvider, prepareIntent,
      connection() { throw new CloudInstallationBoundaryError('create_ownership_unverified'); },
      assertSourcePlacement(spec, connection) {
        const checked = parseConnection(connection);
        const proposed = prepareIntent(spec, { ...checked, stage: 'deployment', mode: 'connect', keys: [] });
        if (!isDeepStrictEqual(proposed, checked.deployment)) throw fail();
      },
      async issueSession(input) {
        const budget = new DestinationBudget({ signal: input.signal, deadlineMs: options.deadlineMs });
        try {
          const connection = parseConnection(input.connection);
          if (input.capability !== 'provision' && input.capability !== 'release'
            || input.target !== undefined && input.target !== 'resource-manager' && input.target !== 'container-registry') throw fail();
          const principal = connection.principals[input.capability];
          if (principal.kind !== 'azure-managed-identity') throw fail();
          const target = input.target ?? 'resource-manager';
          const host = await budget.wait(input.host.verifyIdentity(budget.signal));
          if (!isDeepStrictEqual(host, connection.hostIdentity)) throw fail();
          const exchange = createAzureDeploymentTokenProvider({ tenantId: principal.tenantId, clientId: principal.clientId,
            getGoogleIdToken: (audience, signal) => input.host.getIdToken(audience, signal) }, { fetch: request, deadlineMs: options.deadlineMs });
          await budget.wait(input.beforeIssue());
          // This private ARM token is never returned before native UID/trust reads.
          const proof = await budget.wait(exchange('resource-manager', budget.signal));
          const native = await destinationJson(request, budget, `${ARM}${principal.identityResourceId}?api-version=${MI_API}`, proof.token);
          const properties = native.properties as Record<string, unknown> | undefined;
          const tags = native.tags as Record<string, unknown> | undefined;
          const c = azureDeploymentCoordinates(connection);
          if (!same(native.id, principal.identityResourceId) || !same(properties?.tenantId, principal.tenantId)
            || !same(properties?.clientId, principal.clientId) || !same(properties?.principalId, principal.principalId)
            || tags?.hypervibeInstallation !== connection.installationId || tags?.hypervibeDeployment !== c.owner || tags?.hypervibePurpose !== input.capability) throw fail();
          const federationId = `${principal.identityResourceId}/federatedIdentityCredentials/hypervibe`;
          const federation = await destinationJson(request, budget, `${ARM}${federationId}?api-version=${MI_API}`, proof.token);
          const trust = federation.properties as Record<string, unknown> | undefined;
          if (!same(federation.id, federationId) || trust?.issuer !== host.issuer || trust?.subject !== host.subject
            || !isDeepStrictEqual(trust?.audiences, [AZURE_HOST_FEDERATION_AUDIENCE])) throw fail();
          if (!isDeepStrictEqual(await budget.wait(input.host.verifyIdentity(budget.signal)), host)) throw fail();
          await budget.wait(input.beforeIssue());
          const access = await budget.wait(exchange(target, budget.signal));
          return { kind: 'azure-federation', principal, target, ...access };
        } catch { throw new CloudDeploymentAccessError('authorization_unavailable'); }
        finally { budget.close(); }
      },
    },
    async plan(context) {
      const proposed = action(context.intent), c = azureDeploymentCoordinates(context.intent);
      const budget = new DestinationBudget({ signal: context.signal, deadlineMs: options.deadlineMs });
      try {
        if (!context.authentication.administrator) throw new CloudInstallationBoundaryError('authorization_expired');
        const token = await budget.wait(context.authentication.administrator.getAccessToken(`${ARM}/.default`, budget.signal));
        const native = await destinationJson(request, budget, `${ARM}/subscriptions/${c.nativeScope.subscriptionId}?api-version=2022-12-01`, token);
        if (!same(native.subscriptionId, c.nativeScope.subscriptionId) || !same(native.tenantId, c.nativeScope.tenantId) || native.state !== 'Enabled') throw fail();
        const runtime = context.intent.deployment!.workloads;
        return { actions: [proposed], blockedReason: 'create_ownership_unverified', review: {
          resources: [{ kind: 'resource-group', name: c.nativeScope.resourceGroup, scope: `/subscriptions/${c.nativeScope.subscriptionId}` },
            ...['provision', 'release', ...runtime.map(item => `runtime-${item.name}`)].map(purpose => ({ kind: 'managed-identity', name: c.identity(purpose), scope: c.group }))],
          permissions: [{ principal: c.identity('provision'), scope: c.group, purpose: 'deployment-provision', actions: [
            'Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write', 'Microsoft.App/managedEnvironments/read', 'Microsoft.App/managedEnvironments/write',
            'Microsoft.ContainerRegistry/registries/read', 'Microsoft.ContainerRegistry/registries/write', 'Microsoft.ManagedIdentity/userAssignedIdentities/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'] },
          { principal: c.identity('release'), scope: c.group, purpose: 'deployment-release', actions: [
            'Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write', 'Microsoft.ContainerRegistry/registries/read', 'Microsoft.ContainerRegistry/registries/pull/read', 'Microsoft.ContainerRegistry/registries/push/write'] },
          ...runtime.flatMap(workload => workload.runtimeSecrets.map(({ reference }) => ({ principal: c.identity(`runtime-${workload.name}`),
            scope: reference.destination.provider === 'azure-key-vault' ? `/subscriptions/${reference.destination.subscriptionId}/resourceGroups/${reference.destination.resourceGroup}/providers/Microsoft.KeyVault/vaults/${reference.destination.vaultName}` : '',
            purpose: 'runtime-reader' as const, actions: ['Microsoft.KeyVault/vaults/secrets/getSecret/action'] })))],
          costs: [{ resource: c.group, description: 'Container Apps compute and a container registry incur usage and storage charges after a separate reviewed workload plan. This blocked installation creates no resources.', pricingUrl: 'https://azure.microsoft.com/pricing/details/container-apps/' }],
          warnings: ['Azure first installation is blocked before any writes: native create-only ownership for resource groups and managed identities is unverified.',
            'Sign-in and subscription visibility do not prove permission to install. Effective installation permissions and scoped native grants still require implementation and live validation.',
            'Provisioning, release, collection and runtime identities are separate. Deployment can change code running with runtime access.',
            'Already issued access tokens remain usable until expiry; removing federation does not invalidate them immediately.'],
        } };
      } finally { budget.close(); }
    },
    async inspect() { return { state: 'unknown', reason: 'create_ownership_unverified' }; },
    async recover() { return { state: 'unknown', reason: 'create_ownership_unverified' }; },
    async mutate() { return { state: 'rejected', reason: 'create_ownership_unverified' }; },
  };
  return driver;
}
