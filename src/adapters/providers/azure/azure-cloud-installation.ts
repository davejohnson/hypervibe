import { CloudInstallationBoundaryError } from '../../../domain/ports/cloud-installation.port.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CloudInstallationAction, CloudInstallationAttempt, CloudInstallationDriver, CloudInstallationEvidence,
  CloudInstallationIntent, CloudInstallationMutation, CloudInstallationObservation, CloudInstallationProviderContext,
  CloudInstallationReason } from '../../../domain/ports/cloud-installation.port.js';
import { azureSecretDestinationSchema } from '../../../domain/ports/secret-destination.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { createAzureSecretDestinationDriver } from './azure-secret-destination.js';
import { AZURE_HOST_FEDERATION_AUDIENCE, createAzureFederatedTokenProvider } from './azure-federated-auth.js';
import { createAzureDeploymentInstallationDriver } from './azure-cloud-deployment.js';
import { azureDeploymentProvenanceSchema, createAzureInstallationDeployment, verifyAzureInstallationDeployment,
  rejectAzureCredentialEcho, type AzureInstallationTarget } from './azure-arm-installation.js';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = `${ARM}/.default`;
const MI_API = '2024-11-30';
const VAULT_API = '2024-11-01';
const RBAC_API = '2022-04-01';
const RESOURCE_API = '2022-09-01';
const uuid = z.string().guid();
const scopeSchema = z.object({ tenantId: uuid, subscriptionId: uuid,
  resourceGroup: z.string().regex(/^[A-Za-z0-9_().-]{1,90}$/).refine(value => !value.endsWith('.')),
  location: z.string().regex(/^[a-z][a-z0-9]{1,39}$/),
}).strict();
const kinds = ['managed-identity-provider', 'vault-provider', 'group', 'writer', 'vault', 'role', 'federation', 'grant', 'verify'] as const;
type Kind = typeof kinds[number];
const nativeSchema = z.object({ kind: z.enum(kinds), resourceId: z.string().min(1).max(2048), scopeDigest: z.string().regex(/^[a-f0-9]{64}$/), existingVaultCreatedAt: z.string().datetime({ offset: true }).optional(),
  lifecycle: z.literal('exclusive-arm-deployment-v1').optional() }).strict();
const actionSchema = z.object({ id: z.string(), type: z.enum(['create', 'update', 'destroy', 'noop']),
  resource: z.object({ kind: z.enum(['project', 'secret']), name: z.string(), provider: z.literal('azure') }).strict(),
  verified: z.boolean(), reason: z.string().max(1000), billable: z.boolean().optional(), dataBearing: z.boolean().optional(),
  requiresConfirm: z.boolean().optional(), dependsOn: z.array(z.string()).optional(),
  metadata: z.object({ operation: z.literal('azureCloudInstallation'), category: z.enum(['scope', 'identity', 'trust', 'secret-container', 'verification']),
    execution: z.literal('api'), native: nativeSchema }).strict(),
}).strict();
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(kinds), id: z.string().max(2048),
  identity: z.record(z.string(), z.string().max(2048)) }).strict()).max(9), native: z.object({ scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    installationId: uuid, attemptId: uuid.optional(), writerClientId: uuid.optional(), destinations: z.array(azureSecretDestinationSchema).max(100).optional(),
    deployment: azureDeploymentProvenanceSchema.optional(),
  }).strict() }).strict();
type Resource = Record<string, any>;
type Context = CloudInstallationProviderContext & { completed?: Record<string, CloudInstallationEvidence> };
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
class InstallationError extends CloudInstallationBoundaryError {
  constructor(readonly reason: CloudInstallationReason) { super(reason); }
}
function validated<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new InstallationError('identity_mismatch'); }
}
function reason(error: unknown): CloudInstallationReason {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof Error && ['authorization_revoked', 'authorization_expired', 'cancelled', 'timeout'].includes(error.message)) {
    return error.message as CloudInstallationReason;
  }
  if (error instanceof DestinationBoundaryError) return error.code === 'access_denied' ? 'insufficient_permissions'
    : error.code === 'deadline_exceeded' ? 'timeout' : 'provider_error';
  return 'provider_error';
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function guid(value: string) {
  const hash = digest(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function settings(intent: CloudInstallationIntent) {
  const scope = validated(() => scopeSchema.parse(intent.nativeScope));
  if (intent.provider !== 'azure') throw new InstallationError('identity_mismatch');
  const installationIds = intent.mode === 'disconnect' ? (intent.installed ?? []).map(item => validated(() => evidenceSchema.parse(item)).native.installationId) : [intent.installationId];
  if (!installationIds.length || new Set(installationIds).size !== 1) throw new InstallationError('ownership_mismatch');
  const installationId = installationIds[0];
  const namespace = [intent.customerId, intent.appId, intent.environment, installationId];
  const scopeDigest = digest({ namespace, tenantId: scope.tenantId.toLowerCase(), subscriptionId: scope.subscriptionId.toLowerCase(),
    resourceGroup: scope.resourceGroup.toLowerCase() });
  const subscription = `/subscriptions/${scope.subscriptionId}`;
  const group = `${subscription}/resourceGroups/${scope.resourceGroup}`;
  const migrationTargets = intent.migrationTargets?.map(target => ({ key: target.key, destination: validated(() => azureSecretDestinationSchema.parse(target.destination)) }));
  if (intent.mode === 'migrate' && !migrationTargets?.length || intent.mode === 'connect' && migrationTargets) throw new InstallationError('identity_mismatch');
  if (migrationTargets && (migrationTargets.length !== intent.keys.length || new Set(migrationTargets.map(target => target.key)).size !== intent.keys.length
    || migrationTargets.some(target => !intent.keys.includes(target.key) || !sameId(target.destination.tenantId, scope.tenantId)
      || !sameId(target.destination.subscriptionId, scope.subscriptionId) || !sameId(target.destination.resourceGroup, scope.resourceGroup))
    || new Set(migrationTargets.map(target => target.destination.vaultName)).size !== 1)) throw new InstallationError('identity_mismatch');
  const vaultName = migrationTargets?.[0].destination.vaultName ?? resourceName('secrets', { scope: namespace, maxLength: 24, minLength: 3 });
  const writerName = resourceName('writer', { scope: namespace, maxLength: 128, minLength: 3 });
  const vault = `${group}/providers/Microsoft.KeyVault/vaults/${vaultName}`;
  const writer = `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${writerName}`;
  const ids: Record<Kind, string> = { group, writer, vault,
    'managed-identity-provider': `${subscription}/providers/Microsoft.ManagedIdentity`, 'vault-provider': `${subscription}/providers/Microsoft.KeyVault`,
    role: `${subscription}/providers/Microsoft.Authorization/roleDefinitions/${guid(`${scopeDigest}:role`)}`,
    federation: `${writer}/federatedIdentityCredentials/hypervibe`,
    grant: `${vault}/providers/Microsoft.Authorization/roleAssignments/${guid(`${scopeDigest}:grant`)}`, verify: vault };
  const destinations = [...intent.keys].sort().map(key => migrationTargets?.find(target => target.key === key)?.destination ?? azureSecretDestinationSchema.parse({ provider: 'azure-key-vault',
    tenantId: scope.tenantId, subscriptionId: scope.subscriptionId, resourceGroup: scope.resourceGroup, vaultName,
    secretName: resourceName(key, { maxLength: 127 }) }));
  if (new Set(destinations.map(item => item.secretName)).size !== destinations.length) throw new InstallationError('identity_mismatch');
  return { scope, scopeDigest, subscription, ids, vaultName, destinations, installationId, migration: Boolean(migrationTargets),
    owner: `Hypervibe installation ${installationId}; scope ${scopeDigest}` };
}
function registrationKind(kind: Kind) { return kind === 'managed-identity-provider' || kind === 'vault-provider'; }
function registrationNamespace(kind: Kind) { return kind === 'managed-identity-provider' ? 'Microsoft.ManagedIdentity' : 'Microsoft.KeyVault'; }
function api(kind: Kind) { return registrationKind(kind) ? '2021-04-01' : kind === 'writer' || kind === 'federation' ? MI_API
  : kind === 'vault' || kind === 'verify' ? VAULT_API : kind === 'group' ? RESOURCE_API : RBAC_API; }
function sameId(a: unknown, b: string): boolean { return typeof a === 'string' && a.toLowerCase() === b.toLowerCase(); }
function canonical(value: unknown) { return JSON.stringify(value); }
const writerActions = ['Microsoft.KeyVault/vaults/read', 'Microsoft.KeyVault/vaults/secrets/readMetadata/action', 'Microsoft.KeyVault/vaults/secrets/setSecret/action'];
const writerPermissions = [{ actions: [writerActions[0]], notActions: [], dataActions: writerActions.slice(1), notDataActions: [] }];
function permissionSet(value: unknown) {
  const entries = z.array(z.object({ actions: z.array(z.string()), notActions: z.array(z.string()),
    dataActions: z.array(z.string()), notDataActions: z.array(z.string()) }).strict()).parse(value);
  return entries.map(entry => ({ actions: [...new Set(entry.actions.map(item => item.toLowerCase()))].sort(),
    notActions: [...new Set(entry.notActions.map(item => item.toLowerCase()))].sort(),
    dataActions: [...new Set(entry.dataActions.map(item => item.toLowerCase()))].sort(),
    notDataActions: [...new Set(entry.notDataActions.map(item => item.toLowerCase()))].sort() })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
const requiredActions = ['Microsoft.ManagedIdentity/userAssignedIdentities/write',
  'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/write', 'Microsoft.KeyVault/vaults/write',
  'Microsoft.Authorization/roleDefinitions/write', 'Microsoft.Authorization/roleAssignments/write'];
function matches(pattern: string, permission: string) {
  return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(permission);
}

/** Hosted ARM installer. Every mutation corresponds to one persisted action. */
export function createAzureCloudInstallationDriver(options: { fetch?: typeof fetch; deadlineMs?: number; holdingImage?: string } = {}): CloudInstallationDriver {
  const deployment = createAzureDeploymentInstallationDriver(options);
  const request = options.fetch ?? fetch;
  const call = async <T>(context: Context, run: (budget: DestinationBudget, token: string) => Promise<T>): Promise<T> => {
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: options.deadlineMs });
    try {
      if (!context.authentication.administrator) throw new InstallationError('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken(ARM_SCOPE, budget.signal));
      return await run(budget, token);
    } catch (error) { throw new InstallationError(reason(error)); }
    finally { budget.close(); }
  };
  const read = async (budget: DestinationBudget, token: string, id: string, version: string): Promise<Resource | null> => {
    try { const value = await destinationJson(request, budget, `${ARM}${id}?api-version=${version}`, token); rejectAzureCredentialEcho(value, token); return value; }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
  };
  const nativeIdentity = (intent: CloudInstallationIntent, kind: Kind, resource: Resource, attempt?: CloudInstallationAttempt,
    completed?: Record<string, CloudInstallationEvidence>): Record<string, string> => {
    const config = settings(intent);
    if (!sameId(resource.id, config.ids[kind])) throw new InstallationError('identity_mismatch');
    if (registrationKind(kind)) {
      if (resource.namespace !== registrationNamespace(kind)) throw new InstallationError('identity_mismatch');
      if (!['Registered', 'Registering'].includes(resource.registrationState)) throw new InstallationError('not_converged');
      return { namespace: resource.namespace };
    }
    const properties = resource.properties;
    if (!properties || typeof properties !== 'object') throw new InstallationError('not_converged');
    if ((kind === 'writer' || !config.migration && (kind === 'group' || kind === 'vault'))
      && resource.location !== config.scope.location) throw new InstallationError('identity_mismatch');
    if (['writer', ...(config.migration ? [] : ['group', 'vault'])].includes(kind) && (resource.tags?.hypervibeInstallation !== config.installationId
      || resource.tags?.hypervibeScope !== config.scopeDigest || attempt && resource.tags?.hypervibeAttempt !== attempt.id)) {
      throw new InstallationError('ownership_mismatch');
    }
    const retainedWriter = completed?.['azure:writer']?.resources.find(item => item.kind === 'writer');
    if (kind === 'writer') {
      if (!uuid.safeParse(properties.clientId).success || !uuid.safeParse(properties.principalId).success
        || !sameId(properties.tenantId, config.scope.tenantId)) throw new InstallationError('identity_mismatch');
      const identity = { tenantId: properties.tenantId.toLowerCase(), clientId: properties.clientId.toLowerCase(), principalId: properties.principalId.toLowerCase() };
      if (retainedWriter && !isDeepStrictEqual(retainedWriter.identity, identity)) throw new InstallationError('identity_mismatch');
      return identity;
    }
    if (kind === 'vault') {
      if (resource.tags?.hypervibeCustomerId !== intent.customerId || resource.tags?.hypervibeAppId !== intent.appId
        || resource.tags?.hypervibeEnvironment !== intent.environment) throw new InstallationError('ownership_mismatch');
      if (!sameId(properties.tenantId, config.scope.tenantId) || properties.vaultUri !== `https://${config.vaultName}.vault.azure.net/`
        || properties.enableRbacAuthorization !== true || !config.migration && (properties.enableSoftDelete !== true
        || properties.enablePurgeProtection !== true || properties.sku?.name?.toLowerCase() !== 'standard'
        || !Number.isSafeInteger(properties.softDeleteRetentionInDays) || properties.softDeleteRetentionInDays < 90)) throw new InstallationError('identity_mismatch');
      if (properties.provisioningState !== 'Succeeded') throw new InstallationError('not_converged');
      const createdAt = resource.systemData?.createdAt;
      if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new InstallationError('identity_mismatch');
      const identity = { tenantId: properties.tenantId.toLowerCase(), vaultUri: properties.vaultUri, createdAt };
      const retained = completed?.['azure:vault']?.resources.find(item => item.kind === 'vault');
      if (retained && !isDeepStrictEqual(retained.identity, identity)) throw new InstallationError('identity_mismatch');
      return identity;
    }
    if (kind === 'group') {
      if (properties.provisioningState !== 'Succeeded') throw new InstallationError('not_converged');
      return { scopeDigest: config.scopeDigest };
    }
    if (kind === 'role') {
      if (properties.type !== 'CustomRole' || properties.description !== config.owner
        || !Array.isArray(properties.assignableScopes) || properties.assignableScopes.length !== 1
        || !sameId(properties.assignableScopes[0], config.ids.group)
        || !isDeepStrictEqual(permissionSet(properties.permissions), permissionSet(writerPermissions))) throw new InstallationError('ownership_mismatch');
      return { roleDefinitionId: config.ids.role };
    }
    if (!retainedWriter) throw new InstallationError('identity_mismatch');
    if (kind === 'federation') {
      if (properties.issuer !== intent.hostIdentity.issuer || properties.subject !== intent.hostIdentity.subject
        || canonical(properties.audiences) !== canonical([AZURE_HOST_FEDERATION_AUDIENCE])) throw new InstallationError('ownership_mismatch');
      return { issuer: properties.issuer, subject: properties.subject, audience: AZURE_HOST_FEDERATION_AUDIENCE,
        writerPrincipalId: retainedWriter.identity.principalId };
    }
    if (kind === 'grant') {
      if (!sameId(properties.principalId, retainedWriter.identity.principalId) || !sameId(properties.roleDefinitionId, config.ids.role)
        || !sameId(properties.scope, config.ids.vault) || properties.description !== config.owner
        || properties.principalType !== 'ServicePrincipal' || properties.condition != null) throw new InstallationError('ownership_mismatch');
      return { principalId: properties.principalId.toLowerCase(), roleDefinitionId: config.ids.role, scope: config.ids.vault };
    }
    throw new InstallationError('identity_mismatch');
  };
  const evidence = (intent: CloudInstallationIntent, kind: Kind, identity: Record<string, string>, attempt?: CloudInstallationAttempt): CloudInstallationEvidence => ({
    resources: [{ kind, id: settings(intent).ids[kind], identity }],
    native: { scopeDigest: settings(intent).scopeDigest, installationId: settings(intent).installationId, ...(attempt ? { attemptId: attempt.id } : {}) },
  });
  const prerequisite = async (context: Context, budget: DestinationBudget, token: string, kind: Kind) => {
    const retained = context.completed?.[`azure:${kind}`]?.resources.find(item => item.kind === kind);
    if (!retained) throw new InstallationError('identity_mismatch');
    const config = settings(context.intent); const value = await read(budget, token, config.ids[kind], api(kind));
    if (!value) throw new InstallationError('not_installed');
    const identity = nativeIdentity(context.intent, kind, value, undefined, context.completed);
    if (!isDeepStrictEqual(retained.identity, identity)) throw new InstallationError('identity_mismatch');
    return identity;
  };
  const buildActions = (intent: CloudInstallationIntent, groupExists: boolean, existingVaultCreatedAt?: string, nativeLifecycle = false): CloudInstallationAction[] => {
    const config = settings(intent);
    const selected: Kind[] = intent.mode === 'disconnect' ? (['grant', 'federation'] as Kind[]).filter(kind =>
      intent.installed?.some(item => evidenceSchema.parse(item).resources.some(resource => resource.kind === kind))) : [...kinds];
    return selected.map(kind => ({ id: `azure:${kind}`, type: intent.mode === 'disconnect' ? 'destroy'
      : kind === 'verify' || kind === 'group' && groupExists || kind === 'vault' && config.migration ? 'noop' : registrationKind(kind) ? 'update' : 'create',
      resource: { kind: kind === 'group' || registrationKind(kind) ? 'project' : 'secret', name: kind, provider: 'azure' },
      verified: nativeLifecycle || intent.mode === 'disconnect' || kind === 'group' && groupExists || kind === 'vault' && config.migration, reason: intent.mode === 'disconnect' ? `Remove the exact owned Azure ${kind}; preserve stored secrets and runtime readers`
        : kind === 'verify' ? 'Verify hosted federation and value-free destination access' : `Prepare the isolated Azure ${kind}`,
      ...(kind === 'vault' && !config.migration ? { billable: true, dataBearing: true } : {}), requiresConfirm: kind !== 'verify' && !(kind === 'group' && groupExists) && !(kind === 'vault' && config.migration),
      dependsOn: intent.mode === 'disconnect' ? kind === 'federation' && selected.includes('grant') ? ['azure:grant'] : []
        : kind === 'group' || registrationKind(kind) ? [] : kind === 'writer' ? ['azure:group', 'azure:managed-identity-provider'] : kind === 'vault' ? ['azure:group', 'azure:vault-provider'] : kind === 'grant' ? ['azure:writer', 'azure:vault', 'azure:role']
          : kind === 'federation' ? ['azure:writer'] : kind === 'verify' ? ['azure:federation', 'azure:grant'] : ['azure:group'],
      metadata: { operation: 'azureCloudInstallation', category: kind === 'group' || registrationKind(kind) ? 'scope' : kind === 'writer' ? 'identity'
        : kind === 'vault' ? 'secret-container' : kind === 'verify' ? 'verification' : 'trust', execution: 'api',
        native: { kind, resourceId: config.ids[kind], scopeDigest: config.scopeDigest, ...(nativeLifecycle ? { lifecycle: 'exclusive-arm-deployment-v1' as const } : {}), ...(kind === 'vault' && config.migration && existingVaultCreatedAt ? { existingVaultCreatedAt } : {}) } },
    }));
  };
  const driver: CloudInstallationDriver = {
    deployment: deployment.deployment,
    provider: 'azure',
    parseScope(value) { return validated(() => scopeSchema.parse(value)); },
    async discoverScopes(context) {
      const budget = new DestinationBudget({ signal: context.signal, deadlineMs: options.deadlineMs });
      try {
        const source = z.object({ customerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), appId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
          environment: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), installationId: uuid }).strict().parse(context.sourceScope);
        const migration = context.migrationTargets === undefined ? undefined : z.array(z.object({ key: z.string().min(1).max(128), destination: azureSecretDestinationSchema }).strict()).min(1).max(100).parse(context.migrationTargets);
        const legacy = migration?.[0].destination;
        if (legacy && migration!.some(target => !sameId(target.destination.tenantId, legacy.tenantId) || !sameId(target.destination.subscriptionId, legacy.subscriptionId)
          || !sameId(target.destination.resourceGroup, legacy.resourceGroup) || target.destination.vaultName !== legacy.vaultName)) throw new InstallationError('identity_mismatch');
        const continuation = (value: string) => {
          const url = new URL(value); if (url.origin !== ARM || url.pathname !== '/subscriptions' || url.username || url.password || url.hash
            || url.searchParams.get('api-version') !== '2022-12-01' || value.length > 4096) throw new InstallationError('identity_mismatch');
          return url.toString();
        };
        const url = context.cursor ? continuation(context.cursor) : `${ARM}/subscriptions?api-version=2022-12-01`;
        if (!context.authentication.administrator) throw new InstallationError('authorization_expired');
        const token = await budget.wait(context.authentication.administrator.getAccessToken(ARM_SCOPE, budget.signal));
        const result = await destinationJson(request, budget, url, token);
        const subscriptions = z.array(z.object({ id: z.string(), subscriptionId: uuid, tenantId: uuid,
          state: z.enum(['Enabled', 'Warned', 'PastDue', 'Disabled', 'Deleted']), displayName: z.string().min(1).max(256) })).max(100).parse(result.value);
        const scopes: Array<{ nativeScope: Record<string, string>; label: string }> = [], seen = new Set<string>();
        for (const subscription of subscriptions) {
          if (!sameId(subscription.id, `/subscriptions/${subscription.subscriptionId}`) || seen.has(subscription.subscriptionId.toLowerCase())) throw new InstallationError('identity_mismatch');
          seen.add(subscription.subscriptionId.toLowerCase()); if (subscription.state !== 'Enabled') continue;
          if (legacy) {
            if (!sameId(subscription.subscriptionId, legacy.subscriptionId) || !sameId(subscription.tenantId, legacy.tenantId)) continue;
            const id = `/subscriptions/${legacy.subscriptionId}/resourceGroups/${legacy.resourceGroup}/providers/Microsoft.KeyVault/vaults/${legacy.vaultName}`;
            const vault = await read(budget, token, id, VAULT_API);
            if (!vault || !sameId(vault.id, id) || !sameId(vault.properties?.tenantId, legacy.tenantId)) throw new InstallationError('identity_mismatch');
            scopes.push({ label: token ? subscription.displayName.split(token).join('[redacted]') : subscription.displayName,
              nativeScope: scopeSchema.parse({ tenantId: legacy.tenantId, subscriptionId: legacy.subscriptionId, resourceGroup: legacy.resourceGroup, location: vault.location }) });
            continue;
          }
          const locations = await read(budget, token, `/subscriptions/${subscription.subscriptionId}/locations`, '2022-12-01');
          const regions = z.array(z.object({ name: scopeSchema.shape.location, type: z.enum(['Region', 'EdgeZone']).optional() })).max(300).parse(locations?.value)
            .filter(location => location.type === undefined || location.type === 'Region').map(location => location.name).sort();
          if (!regions.length) throw new InstallationError('identity_mismatch');
          const location = regions.includes('eastus') ? 'eastus' : regions[0];
          const resourceGroup = resourceName(source.environment, { scope: [source.customerId, source.appId, source.environment, source.installationId], maxLength: 90 });
          scopes.push({ label: token ? subscription.displayName.split(token).join('[redacted]') : subscription.displayName, nativeScope: scopeSchema.parse({ tenantId: subscription.tenantId, subscriptionId: subscription.subscriptionId, resourceGroup, location }) });
        }
        const cursor = result.nextLink == null ? undefined : continuation(z.string().parse(result.nextLink));
        return { state: cursor ? 'partial' : 'complete', scopes, authority: 'not-verified', ...(cursor ? { cursor } : {}) };
      } catch { return { state: 'unknown', scopes: [], authority: 'not-verified' }; }
      finally { budget.close(); }
    },

    parseAction(value, intent) {
      if (intent.purpose === 'deployment') return deployment.parseAction(value, intent);
      const parsed = validated(() => actionSchema.parse(value));
      if (parsed.metadata.native.kind === 'vault' && settings(intent).migration && !parsed.metadata.native.existingVaultCreatedAt) throw new InstallationError('identity_mismatch');
      const expected = buildActions(intent, parsed.metadata.native.kind === 'group' && parsed.type === 'noop', parsed.metadata.native.existingVaultCreatedAt,
        parsed.metadata.native.lifecycle === 'exclusive-arm-deployment-v1').find(action => action.id === parsed.id);
      if (!expected || !isDeepStrictEqual(expected, parsed)) throw new InstallationError('identity_mismatch');
      return parsed;
    },
    parseEvidence(value, intent) {
      if (intent.purpose === 'deployment') return deployment.parseEvidence(value, intent);
      const parsed = validated(() => evidenceSchema.parse(value)); const config = settings(intent);
      if (parsed.native.scopeDigest !== config.scopeDigest || parsed.native.installationId !== config.installationId
        || new Set(parsed.resources.map(item => item.kind)).size !== parsed.resources.length
        || !parsed.resources.length && (!parsed.native.deployment || !parsed.native.attemptId)) throw new InstallationError('identity_mismatch');
      if (parsed.native.deployment) {
        const operation = parsed.native.deployment.operation;
        const allowed = [config.subscription, config.ids.group].map(id => `${id}/providers/Microsoft.Resources/deployments/hv-${parsed.native.attemptId}`);
        if (!parsed.native.attemptId || !allowed.some(id => sameId(id, parsed.native.deployment!.id)) || parsed.resources.length > 1
          || operation && !operation.id.toLowerCase().startsWith(`${parsed.native.deployment.id.toLowerCase()}/operations/`)) throw new InstallationError('identity_mismatch');
      }
      for (const resource of parsed.resources) {
        if (!sameId(resource.id, config.ids[resource.kind])) throw new InstallationError('identity_mismatch');
        const shapes: Record<Kind, z.ZodTypeAny> = {
          'managed-identity-provider': z.object({ namespace: z.literal('Microsoft.ManagedIdentity') }).strict(),
          'vault-provider': z.object({ namespace: z.literal('Microsoft.KeyVault') }).strict(), group: z.object({ scopeDigest: z.literal(config.scopeDigest) }).strict(),
          writer: z.object({ tenantId: uuid.refine(value => sameId(value, config.scope.tenantId)), clientId: uuid, principalId: uuid }).strict(),
          vault: z.object({ tenantId: uuid.refine(value => sameId(value, config.scope.tenantId)), vaultUri: z.literal(`https://${config.vaultName}.vault.azure.net/`), createdAt: z.string().datetime({ offset: true }) }).strict(),
          role: z.object({ roleDefinitionId: z.literal(config.ids.role) }).strict(),
          federation: z.object({ issuer: z.literal(intent.hostIdentity.issuer), subject: z.literal(intent.hostIdentity.subject), audience: z.literal(AZURE_HOST_FEDERATION_AUDIENCE), writerPrincipalId: uuid }).strict(),
          grant: z.object({ principalId: uuid, roleDefinitionId: z.literal(config.ids.role), scope: z.literal(config.ids.vault) }).strict(),
          verify: z.never() };
        validated(() => shapes[resource.kind].parse(resource.identity));
      }
      if (parsed.native.destinations && !isDeepStrictEqual(parsed.native.destinations, config.destinations)) throw new InstallationError('identity_mismatch');
      return parsed;
    },
    async plan(context) {
      if (context.intent.purpose === 'deployment') return deployment.plan(context);
      const config = settings(context.intent);
      return call(context, async (budget, token) => {
        const subscription = await read(budget, token, config.subscription, '2022-12-01');
        if (!subscription || !sameId(subscription.subscriptionId, config.scope.subscriptionId)
          || !sameId(subscription.tenantId, config.scope.tenantId) || subscription.state !== 'Enabled') throw new InstallationError('identity_mismatch');
        const group = await read(budget, token, config.ids.group, RESOURCE_API);
        if (group && !sameId(group.id, config.ids.group)) throw new InstallationError('identity_mismatch');
        const permissions = await read(budget, token, `${group ? config.ids.group : config.subscription}/providers/Microsoft.Authorization/permissions`, RBAC_API);
        if (!permissions || !Array.isArray(permissions.value) || permissions.nextLink) throw new InstallationError('insufficient_permissions');
        const needed = context.intent.mode === 'disconnect' ? buildActions(context.intent, Boolean(group)).map(action => action.id === 'azure:grant'
          ? 'Microsoft.Authorization/roleAssignments/delete' : 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/delete')
          : [...requiredActions.filter(permission => context.intent.mode !== 'migrate' || permission !== 'Microsoft.KeyVault/vaults/write'),
            'Microsoft.Resources/deployments/write', 'Microsoft.Resources/deployments/read', 'Microsoft.Resources/deployments/operations/read',
            ...(!group ? ['Microsoft.Resources/subscriptions/resourceGroups/write'] : [])];
        if (!needed.every(permission => permissions.value.some((entry: any) => Array.isArray(entry.actions) && Array.isArray(entry.notActions)
          && entry.actions.every((action: unknown) => typeof action === 'string') && entry.notActions.every((action: unknown) => typeof action === 'string')
          && entry.actions.some((pattern: string) => matches(pattern, permission)) && !entry.notActions.some((pattern: string) => matches(pattern, permission))))) {
          throw new InstallationError('insufficient_permissions');
        }
        if (context.intent.mode !== 'disconnect' && group) {
          const authority = await read(budget, token, `${config.subscription}/providers/Microsoft.Authorization/permissions`, RBAC_API);
          if (!Array.isArray(authority?.value) || authority?.nextLink || !['Microsoft.Resources/deployments/write', 'Microsoft.Resources/deployments/read',
            'Microsoft.Resources/deployments/operations/read', 'Microsoft.Authorization/roleDefinitions/write']
            .every(permission => authority!.value.some((entry: any) => Array.isArray(entry.actions) && Array.isArray(entry.notActions)
              && entry.actions.some((pattern: unknown) => typeof pattern === 'string' && matches(pattern, permission))
              && !entry.notActions.some((pattern: unknown) => typeof pattern !== 'string' || matches(pattern, permission))))) throw new InstallationError('insufficient_permissions');
        }
        const registrations: string[] = [];
        if (context.intent.mode !== 'disconnect') for (const kind of ['managed-identity-provider', 'vault-provider'] as const) {
          const provider = await read(budget, token, config.ids[kind], api(kind));
          if (!provider || !sameId(provider.id, config.ids[kind]) || provider.namespace !== registrationNamespace(kind)
            || !['Registered', 'Registering', 'NotRegistered', 'Unregistered'].includes(provider.registrationState)) throw new InstallationError('identity_mismatch');
          if (!['Registered', 'Registering'].includes(provider.registrationState)) registrations.push(`${provider.namespace}/register/action`);
        }
        if (registrations.length) {
          const authority = await read(budget, token, `${config.subscription}/providers/Microsoft.Authorization/permissions`, RBAC_API);
          if (!Array.isArray(authority?.value) || authority?.nextLink || !registrations.every(permission => authority!.value.some((entry: any) =>
            Array.isArray(entry.actions) && Array.isArray(entry.notActions) && entry.actions.some((pattern: unknown) => typeof pattern === 'string' && matches(pattern, permission))
            && !entry.notActions.some((pattern: unknown) => typeof pattern !== 'string' || matches(pattern, permission))))) throw new InstallationError('insufficient_permissions');
        }
        if (context.intent.mode === 'disconnect') {
          const owned = new Set((context.intent.installed ?? []).flatMap(item => driver.parseEvidence(item, context.intent).resources.map(resource => resource.kind)));
          if (!owned.size || (owned.has('grant') || owned.has('federation')) && !owned.has('writer')
            || owned.has('grant') && (!owned.has('vault') || !owned.has('role'))) throw new InstallationError('ownership_mismatch');
        }
        let existingVaultCreatedAt: string | undefined;
        if (context.intent.mode === 'migrate') {
          if (!group) throw new InstallationError('not_installed');
          const vault = await read(budget, token, config.ids.vault, VAULT_API);
          if (!vault) throw new InstallationError('not_installed');
          existingVaultCreatedAt = nativeIdentity(context.intent, 'vault', vault).createdAt;
        }
        const nativeLifecycle = context.intent.mode !== 'disconnect' && (!group || config.migration);
        let blockedReason: CloudInstallationReason | undefined = context.intent.mode !== 'disconnect' && !nativeLifecycle ? 'ownership_mismatch' : undefined;
        if (nativeLifecycle) for (const kind of ['writer', ...(config.migration ? [] : ['vault']), 'role', 'federation', 'grant'] as Kind[]) {
          if (await read(budget, token, config.ids[kind], api(kind))) blockedReason = 'ownership_mismatch';
        }
        return { actions: buildActions(context.intent, Boolean(group), existingVaultCreatedAt, nativeLifecycle),
          ...(blockedReason ? { blockedReason } : {}), review: {
          resources: ['group', 'writer', 'vault', 'role', 'federation', 'grant'].map(kind => ({ kind, name: config.ids[kind as Kind], scope: config.ids.group })),
          permissions: [{ principal: config.ids.writer, scope: config.ids.vault, actions: [...writerActions], purpose: 'writer' as const },
            ...(nativeLifecycle ? [{ principal: 'Transient administrator', scope: config.subscription, actions: [...needed], purpose: 'installation-verification' as const }] : []),
            ...(registrations.length ? [{ principal: 'Transient administrator', scope: config.subscription, actions: registrations, purpose: 'installation-verification' as const }] : [])],
          costs: [{ resource: config.ids.vault, description: config.migration ? 'Key Vault operations use the existing vault pricing. Existing retention and purge protection settings are preserved on migration and disconnect.' : 'Standard Key Vault charges for operations; secrets and 90-day purge protection are retained on disconnect.', pricingUrl: 'https://azure.microsoft.com/en-us/pricing/details/key-vault/' }],
          warnings: [...(context.intent.mode !== 'disconnect' ? [
            'Approve exclusive management of this app/environment namespace and the exact listed resource IDs. Existing or unknown targets block installation; names and tags do not establish ownership.',
            'ARM uses create-or-update: an independently authorized concurrent writer can cause an overwrite between the absence check and native dispatch. Native deployment receipts detect conflicting outcomes after the write; they are not an atomic no-overwrite fence. Hypervibe serializes its own installation actions.',
            'Each new target uses a unique native deployment name. Missing native acknowledgment or incomplete operation evidence stays unknown without automatic resubmission. Uncertain resources are retained for review, never deleted by name.',
            ...(blockedReason ? ['A selected resource already exists outside this reviewed new installation. No installation writes are authorized by this blocked plan.'] : []),
          ] : []), ...(config.migration ? ['Migration prepares new writer trust on the exact dedicated RBAC vault without changing its secrets, retention settings or unrelated grants. The previous writer stays active until Hypercloud verifies and explicitly switches delivery. The reviewed writer role can set every secret in this vault; target names are an additional host restriction.'] : []), 'Required resource providers are registered at subscription scope and remain registered on disconnect; registration may continue region by region while each resource is independently verified.', 'The isolated vault is the native writer scope; reviewed target names are an additional Hypervibe restriction.',
            'Permission discovery is a readiness check; Azure enforces current authority on every installation operation.',
            'Removing federation does not instantly expire already issued tokens. Secrets and separately authorized runtime access are preserved.'],
        } };
      });
    },
    async inspect(input) { return input.intent.purpose === 'deployment' ? deployment.inspect(input) : observe(input, false); },
    async recover(input) { return input.intent.purpose === 'deployment' ? deployment.recover(input) : observe(input, true); },
    async mutate(input) {
      if (input.intent.purpose === 'deployment') return deployment.mutate(input);
      let started = false;
      try {
        const context = withInstalled(input); const action = driver.parseAction(input.action, input.intent);
        const kind = nativeSchema.parse(action.metadata.native).kind; const config = settings(input.intent);
        if (input.attempt.actionId !== action.id || !uuid.safeParse(input.attempt.id).success) throw new InstallationError('identity_mismatch');
        if (action.type === 'noop' || kind === 'verify') return { state: 'rejected', reason: 'not_converged' };
        return await call(context, async (budget, token): Promise<CloudInstallationMutation> => {
          const previous = await read(budget, token, config.ids[kind], api(kind));
          if (input.intent.mode === 'disconnect') {
            if (!previous) return { state: 'acknowledged' };
            await prerequisite(context, budget, token, 'writer');
            if (kind === 'grant') await prerequisite(context, budget, token, 'vault');
            const identity = nativeIdentity(input.intent, kind, previous, undefined, context.completed);
            const retained = context.completed?.[`azure:${kind}`]?.resources.find(item => item.kind === kind);
            if (!retained || !isDeepStrictEqual(retained.identity, identity)) throw new InstallationError('ownership_mismatch');
            await budget.wait(context.beforeMutation());
            started = true;
            const response = await budget.wait(request(`${ARM}${config.ids[kind]}?api-version=${api(kind)}`, {
              method: 'DELETE', redirect: 'error', signal: budget.signal, headers: { Authorization: `Bearer ${token}` },
            }));
            void response.body?.cancel().catch(() => {});
            if (!response.ok && response.status !== 404) throw new DestinationBoundaryError(response.status === 401 || response.status === 403 ? 'access_denied' : 'provider_unavailable', response.status);
            return { state: 'acknowledged' };
          }
          if (registrationKind(kind)) {
            if (!previous || !sameId(previous.id, config.ids[kind]) || previous.namespace !== registrationNamespace(kind)) throw new InstallationError('identity_mismatch');
            if (['Registered', 'Registering'].includes(previous.registrationState)) return { state: 'acknowledged' };
            if (!['NotRegistered', 'Unregistered'].includes(previous.registrationState)) throw new InstallationError('not_converged');
            if (!action.metadata.native.lifecycle) await retainedPrimitives(context, budget, token);
            await budget.wait(context.beforeMutation()); started = true;
            await destinationJson(request, budget, `${ARM}${config.ids[kind]}/register?api-version=${api(kind)}`, token, { method: 'POST' });
            return { state: 'acknowledged' };
          }
          if (previous) throw new InstallationError('ownership_mismatch');
          if (action.metadata.native.lifecycle === 'exclusive-arm-deployment-v1') {
            if (kind !== 'group') await prerequisite(context, budget, token, 'group');
            if (kind === 'federation' || kind === 'grant') await prerequisite(context, budget, token, 'writer');
            if (kind === 'grant') { await prerequisite(context, budget, token, 'vault'); await prerequisite(context, budget, token, 'role'); }
            const target = installationTarget(context.intent, kind);
            const tags = { hypervibeInstallation: config.installationId, hypervibeScope: config.scopeDigest, hypervibeAttempt: input.attempt.id,
              hypervibeCustomerId: input.intent.customerId, hypervibeAppId: input.intent.appId, hypervibeEnvironment: input.intent.environment };
            let resource: Record<string, unknown>;
            if (kind === 'group' || kind === 'writer') resource = { location: config.scope.location, tags };
            else if (kind === 'vault') resource = { location: config.scope.location, tags, properties: { tenantId: config.scope.tenantId,
              sku: { family: 'A', name: 'standard' }, accessPolicies: [], enableRbacAuthorization: true,
              enableSoftDelete: true, enablePurgeProtection: true, softDeleteRetentionInDays: 90 } };
            else if (kind === 'role') resource = { properties: { roleName: resourceName('Hypervibe writer', { scope: [config.scopeDigest], maxLength: 128 }),
              type: 'CustomRole', description: config.owner, assignableScopes: [config.ids.group], permissions: writerPermissions } };
            else if (kind === 'federation') resource = { properties: { issuer: input.intent.hostIdentity.issuer,
              subject: input.intent.hostIdentity.subject, audiences: [AZURE_HOST_FEDERATION_AUDIENCE] } };
            else if (kind === 'grant') resource = { scope: config.ids.vault, properties: { principalId: context.completed['azure:writer'].resources[0].identity.principalId,
              roleDefinitionId: config.ids.role, principalType: 'ServicePrincipal', description: config.owner } };
            else throw new InstallationError('identity_mismatch');
            const deployment = await createAzureInstallationDeployment({ request, budget, token, target, attempt: input.attempt, resource,
              beforeMutation: context.beforeMutation, dispatched() { started = true; } });
            return { state: 'acknowledged', evidence: { resources: [], native: { scopeDigest: config.scopeDigest,
              installationId: config.installationId, attemptId: input.attempt.id, deployment } } };
          }
          // These native PUTs are upserts. An absence read and our own tags do
          // not prove another actor did not create this name before the write.
          // No configuration switch may enable an unverified admission rule.
          if (['group', 'writer', 'vault'].includes(kind)) throw new InstallationError('create_ownership_unverified');
          await retainedPrimitives(context, budget, token);
          let body: Record<string, unknown>;
          if (kind === 'role') body = { properties: { roleName: resourceName('Hypervibe writer', { scope: [config.scopeDigest], maxLength: 128 }),
            type: 'CustomRole', description: config.owner, assignableScopes: [config.ids.group], permissions: writerPermissions } };
          else if (kind === 'federation') {
            await prerequisite(context, budget, token, 'writer');
            body = { properties: { issuer: input.intent.hostIdentity.issuer, subject: input.intent.hostIdentity.subject,
              audiences: [AZURE_HOST_FEDERATION_AUDIENCE] } };
          } else if (kind === 'grant') {
            const writer = await prerequisite(context, budget, token, 'writer');
            await prerequisite(context, budget, token, 'vault'); await prerequisite(context, budget, token, 'role');
            body = { properties: { principalId: writer.principalId, roleDefinitionId: config.ids.role,
              principalType: 'ServicePrincipal', description: config.owner } };
          } else throw new InstallationError('identity_mismatch');
          await budget.wait(context.beforeMutation());
          started = true;
          await destinationJson(request, budget, `${ARM}${config.ids[kind]}?api-version=${api(kind)}`, token, { method: 'PUT', body: JSON.stringify(body) });
          return { state: 'acknowledged' };
        });
      } catch (error) { const failure = reason(error);
        return { state: started && failure !== 'insufficient_permissions' ? 'uncertain' : 'rejected', reason: failure }; }
    },
    connections(record) {
      if (record.status !== 'ready' || !['connect', 'migrate'].includes(record.intent.mode)) throw new InstallationError('not_converged');
      const verified = driver.parseEvidence(record.completed['azure:verify'], record.intent); const config = settings(record.intent);
      const writer = verified.resources.find(item => item.kind === 'writer');
      if (!writer || !verified.native.destinations) throw new InstallationError('not_converged');
      return [...record.intent.keys].sort().map((key, index) => ({ key, destination: config.destinations[index], writerAuthorization: {
        hostSubject: record.intent.hostIdentity.subject, hostServiceAccountEmail: record.intent.hostIdentity.serviceAccountEmail, installationId: config.installationId,
        tenantId: config.scope.tenantId, subscriptionId: config.scope.subscriptionId,
        clientId: writer.identity.clientId, principalId: writer.identity.principalId, identityResourceId: config.ids.writer,
      } }));
    },
  };
  function installationTarget(intent: CloudInstallationIntent, kind: Kind): AzureInstallationTarget {
    const config = settings(intent);
    const types: Partial<Record<Kind, string>> = { group: 'Microsoft.Resources/resourceGroups', writer: 'Microsoft.ManagedIdentity/userAssignedIdentities',
      vault: 'Microsoft.KeyVault/vaults', role: 'Microsoft.Authorization/roleDefinitions',
      federation: 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials', grant: 'Microsoft.Authorization/roleAssignments' };
    const type = types[kind]; if (!type) throw new InstallationError('identity_mismatch');
    const name = kind === 'group' ? config.scope.resourceGroup : kind === 'federation' ? `${config.ids.writer.split('/').at(-1)!}/hypervibe` : config.ids[kind].split('/').at(-1)!;
    return { id: config.ids[kind], apiVersion: api(kind), type, name, location: config.scope.location,
      deploymentScope: kind === 'group' || kind === 'role' ? config.subscription : config.ids.group, subscriptionScope: kind === 'group' || kind === 'role' };
  }
  async function retainedPrimitives(context: Context, budget: DestinationBudget, token: string) {
    for (const kind of ['writer', 'vault'] as const) {
      if (!context.completed?.[`azure:${kind}`]) throw new InstallationError('create_ownership_unverified');
      await prerequisite(context, budget, token, kind);
    }
  }
  function withInstalled(context: Context): Context {
    if (context.intent.mode !== 'disconnect') return context;
    const completed = { ...context.completed };
    for (const raw of context.intent.installed ?? []) {
      const item = driver.parseEvidence(raw, context.intent);
      for (const resource of item.resources) completed[`azure:${resource.kind}`] = { resources: [resource], native: {
        scopeDigest: item.native.scopeDigest, installationId: item.native.installationId } };
    }
    return { ...context, completed };
  }
  async function observe(input: ActionContext, recovering: boolean): Promise<CloudInstallationObservation> {
    try {
      const context = withInstalled(input); const action = driver.parseAction(input.action, input.intent);
      const kind = nativeSchema.parse(action.metadata.native).kind; const config = settings(input.intent);
      return await call(context, async (budget, token) => {
        if (kind === 'verify') {
          const identities: CloudInstallationEvidence['resources'] = [];
          for (const prerequisiteKind of ['writer', 'vault', 'role', 'federation', 'grant'] as const) {
            identities.push({ kind: prerequisiteKind, id: config.ids[prerequisiteKind], identity: await prerequisite(context, budget, token, prerequisiteKind) });
          }
          const writer = identities.find(item => item.kind === 'writer')!;
          const verifiedHost = await budget.wait(context.authentication.host.verifyIdentity(budget.signal));
          if (!isDeepStrictEqual(verifiedHost, input.intent.hostIdentity)) throw new InstallationError('identity_mismatch');
          const getAccessToken = createAzureFederatedTokenProvider({ tenantId: config.scope.tenantId, clientId: writer.identity.clientId,
            getGoogleIdToken: (audience, signal) => context.authentication.host.getIdToken(audience, signal) }, options);
          const delivery = createAzureSecretDestinationDriver({ tenantId: config.scope.tenantId, subscriptionId: config.scope.subscriptionId, getAccessToken }, { fetch: request });
          for (const destination of config.destinations) {
            const observed = await budget.wait(delivery.observe(destination, { signal: budget.signal }));
            if (observed.status !== 'present') throw new InstallationError(observed.status === 'unknown' && observed.code === 'access_denied'
              ? 'insufficient_permissions' : 'not_converged');
          }
          return { state: 'satisfied', evidence: { resources: identities, native: { scopeDigest: config.scopeDigest, installationId: config.installationId,
            writerClientId: writer.identity.clientId, destinations: config.destinations } } };
        }
        const value = await read(budget, token, config.ids[kind], api(kind));
        if (input.intent.mode === 'disconnect') {
          const retained = context.completed?.[`azure:${kind}`];
          if (!retained) throw new InstallationError('ownership_mismatch');
          if (!value) return { state: 'satisfied', evidence: retained };
          await prerequisite(context, budget, token, 'writer');
          if (kind === 'grant') await prerequisite(context, budget, token, 'vault');
          const identity = nativeIdentity(input.intent, kind, value, undefined, context.completed);
          if (!isDeepStrictEqual(retained.resources[0].identity, identity)) throw new InstallationError('ownership_mismatch');
          return recovering ? { state: 'pending', reason: 'not_converged' } : { state: 'action-required' };
        }
        if (registrationKind(kind)) {
          if (!value || !sameId(value.id, config.ids[kind]) || value.namespace !== registrationNamespace(kind)) throw new InstallationError('identity_mismatch');
          if (['Registered', 'Registering'].includes(value.registrationState)) return { state: 'satisfied', evidence: evidence(input.intent, kind, nativeIdentity(input.intent, kind, value)) };
          if (!['NotRegistered', 'Unregistered'].includes(value.registrationState)) return { state: 'unknown', reason: 'not_converged' };
          return recovering ? { state: 'unknown', reason: 'not_converged' } : { state: 'action-required' };
        }
        if (action.metadata.native.lifecycle === 'exclusive-arm-deployment-v1' && action.type === 'create' && recovering) {
          if (!input.attempt?.evidence) return { state: 'unknown', reason: 'not_converged' };
          const retained = driver.parseEvidence(input.attempt.evidence, input.intent);
          if (!retained.native.deployment || retained.native.attemptId !== input.attempt.id) return { state: 'unknown', reason: 'not_converged' };
          const deployment = await verifyAzureInstallationDeployment({ request, budget, token, target: installationTarget(input.intent, kind),
            attempt: input.attempt, retained: azureDeploymentProvenanceSchema.parse(retained.native.deployment) });
          if (!value) return { state: 'unknown', reason: 'not_installed' };
          if (kind !== 'group') await prerequisite(context, budget, token, 'group');
          if (kind === 'federation' || kind === 'grant') await prerequisite(context, budget, token, 'writer');
          if (kind === 'grant') { await prerequisite(context, budget, token, 'vault'); await prerequisite(context, budget, token, 'role'); }
          const identity = nativeIdentity(input.intent, kind, value, input.attempt, context.completed);
          const result = evidence(input.intent, kind, identity, input.attempt);
          return { state: 'satisfied', evidence: { ...result, native: { ...result.native, deployment } } };
        }
        if (!value) return recovering ? { state: 'unknown', reason: 'not_installed' } : { state: 'action-required' };
        if (kind === 'vault' && config.migration && action.type === 'noop') {
          const identity = nativeIdentity(input.intent, kind, value);
          if (identity.createdAt !== action.metadata.native.existingVaultCreatedAt) throw new InstallationError('identity_mismatch');
          return { state: 'satisfied', evidence: evidence(input.intent, kind, identity) };
        }
        if (kind === 'group' && action.type === 'noop') {
          if (!sameId(value.id, config.ids.group) || value.properties?.provisioningState !== 'Succeeded') throw new InstallationError('identity_mismatch');
          return { state: 'satisfied', evidence: evidence(input.intent, kind, { scopeDigest: config.scopeDigest }) };
        }
        if (!recovering || !input.attempt) return { state: 'conflict', reason: 'ownership_mismatch' };
        if (kind === 'federation' || kind === 'grant') await prerequisite(context, budget, token, 'writer');
        if (kind === 'grant') { await prerequisite(context, budget, token, 'vault'); await prerequisite(context, budget, token, 'role'); }
        const identity = nativeIdentity(input.intent, kind, value, input.attempt, context.completed);
        return { state: 'satisfied', evidence: evidence(input.intent, kind, identity, input.attempt) };
      });
    } catch (error) {
      const failure = reason(error);
      return { state: failure === 'ownership_mismatch' || failure === 'identity_mismatch' ? 'conflict'
        : failure === 'not_converged' ? 'pending' : 'unknown', reason: failure };
    }
  }
  return driver;
}
