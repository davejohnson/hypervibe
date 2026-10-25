import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationIntent, type CloudInstallationProviderContext, type CloudInstallationRecord, type CloudInstallationReason } from '../../../domain/ports/cloud-installation.port.js';
import type { CloudDeploymentConnectionV1, CloudDeploymentPrincipalV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { parseCloudDeploymentTopologyV1 } from '../../../domain/services/cloud-deployment-authentication.js';
import { DestinationBoundaryError, DestinationBudget, destinationJson } from '../secret-destination-http.js';
import { azureDeploymentProvenanceSchema, createAzureInstallationDeployment, verifyAzureInstallationDeployment,
  rejectAzureCredentialEcho, type AzureInstallationTarget } from './azure-arm-installation.js';
import { AZURE_PREPARED_API, azureHoldingConfiguration, azureObservedHoldingConfiguration, azurePreparedCoordinates,
  azurePreparedDigest, azurePreparedGuid, azureHoldingImageSchema, parseAzurePreparedResources } from './azure-prepared-hosting.js';
import { AZURE_HOST_FEDERATION_AUDIENCE, createAzureDeploymentTokenProvider } from './azure-federated-auth.js';
import { azureObservedPreparedApplicationConfiguration } from './azure-prepared-release.js';
import { verifyAzureHoldingImage } from './azure-holding-image.js';

const ARM = 'https://management.azure.com', SCOPE = `${ARM}/.default`;
const kindSchema = z.enum(['group', 'provider', 'identity', 'registry', 'environment', 'app', 'role', 'grant', 'federation', 'vault', 'verify']);
type Kind = z.infer<typeof kindSchema>;
type Context = CloudInstallationProviderContext;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: kindSchema, id: z.string().max(2048), identity: z.record(z.string(), z.string().max(2048)) }).strict()).max(1),
  native: z.object({ contract: z.literal('azure-prepared-v1'), installationId: z.string().guid(), owner: z.string().regex(/^[a-f0-9]{64}$/),
    actionId: z.string().max(256), attemptId: z.string().guid().optional(), deployment: azureDeploymentProvenanceSchema.optional() }).strict() }).strict();
export const AZURE_PREPARED_ROLES = {
  inspect: ['Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.App/managedEnvironments/read', 'Microsoft.App/containerApps/read',
    'Microsoft.ContainerRegistry/registries/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/read',
    'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/read', 'Microsoft.Authorization/roleAssignments/read',
    'Microsoft.Authorization/roleDefinitions/read', 'Microsoft.Resources/deployments/read', 'Microsoft.Resources/deployments/operations/read'],
  provision: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write', 'Microsoft.App/containerApps/delete'],
  release: ['Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/write'],
  assign: ['Microsoft.ManagedIdentity/userAssignedIdentities/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'],
  join: ['Microsoft.App/managedEnvironments/read', 'Microsoft.App/managedEnvironments/join/action'],
  vault: ['Microsoft.KeyVault/vaults/read', 'Microsoft.Authorization/roleAssignments/read'],
} as const;
const roles = AZURE_PREPARED_ROLES;
const builtIn = { pull: '7f951dda-4ed3-4680-a7ca-43fe172d538d', push: '8311e382-0749-4cb8-b61a-304f252e45ec', reader: '4633458b-17de-408a-b874-0445c86b69e6' };
const namespaces = ['Microsoft.ManagedIdentity', 'Microsoft.App', 'Microsoft.ContainerRegistry'];
const permissions = ['Microsoft.Resources/subscriptions/resourceGroups/write', 'Microsoft.Resources/deployments/write', 'Microsoft.Resources/deployments/read',
  'Microsoft.Resources/deployments/operations/read', 'Microsoft.ManagedIdentity/userAssignedIdentities/write', 'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action',
  'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/write', 'Microsoft.Authorization/roleDefinitions/write',
  'Microsoft.Authorization/roleAssignments/write', 'Microsoft.App/managedEnvironments/write', 'Microsoft.App/managedEnvironments/join/action', 'Microsoft.App/containerApps/write', 'Microsoft.ContainerRegistry/registries/write'];
function fail(reason: CloudInstallationReason = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function reason(error: unknown): CloudInstallationReason {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof Error && ['authorization_revoked', 'authorization_expired', 'cancelled'].includes(error.message)) return error.message as CloudInstallationReason;
  if (error instanceof DestinationBoundaryError) return error.status === 401 || error.status === 403 ? 'insufficient_permissions'
    : error.code === 'deadline_exceeded' ? 'timeout' : 'provider_error';
  return 'provider_error';
}
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
function original(intent: CloudInstallationIntent) {
  if (intent.mode !== 'disconnect') return intent;
  const ids = new Set((intent.installed ?? []).map(value => evidenceSchema.parse(value).native.installationId));
  if (ids.size !== 1) fail('ownership_mismatch');
  return { ...intent, installationId: [...ids][0] };
}
function settings(intent: CloudInstallationIntent) {
  const source = original(intent), c = azurePreparedCoordinates(source), topology = parseCloudDeploymentTopologyV1(source.deployment);
  if (source.provider !== 'azure' || source.purpose !== 'deployment' || source.stage !== 'deployment' || source.keys.length || source.mode === 'migrate'
    || topology.hostingProvider !== 'azure-container-apps' || topology.region !== source.nativeScope.location || !topology.preparation
    || topology.workloads.length > 8 || topology.workloads.some(workload => workload.kind !== 'web' || workload.public !== true)) fail();
  azureHoldingImageSchema.parse(topology.preparation.image);
  const subscription = `/subscriptions/${source.nativeScope.subscriptionId}`;
  const vaults = new Map<string, string>();
  for (const workload of topology.workloads) for (const { reference } of workload.runtimeSecrets) {
    const d = reference.destination;
    if (d.provider !== 'azure-key-vault' || !same(d.tenantId, source.nativeScope.tenantId) || !same(d.subscriptionId, source.nativeScope.subscriptionId)) fail();
    const id = `/subscriptions/${d.subscriptionId}/resourceGroups/${d.resourceGroup}/providers/Microsoft.KeyVault/vaults/${d.vaultName}`;
    vaults.set(id.toLowerCase(), id);
  }
  if (vaults.size > 16) fail();
  return { ...c, source, topology, subscription, vaults: [...vaults.values()].sort(),
    role: (key: keyof typeof roles) => `${subscription}/providers/Microsoft.Authorization/roleDefinitions/${azurePreparedGuid([c.owner, 'role', key])}` };
}
interface Target { key: string; kind: Kind; id: string; purpose?: string; role?: string; principal?: string; scope?: string; dependencies: string[]; hosted?: boolean }
function targets(intent: CloudInstallationIntent): Target[] {
  const s = settings(intent), result: Target[] = [{ key: 'group', kind: 'group', id: s.group, dependencies: [] }];
  for (const namespace of namespaces) result.push({ key: `provider:${namespace}`, kind: 'provider', id: `${s.subscription}/providers/${namespace}`, purpose: namespace, dependencies: [] });
  for (const purpose of ['provision', 'release', 'holding', ...s.topology.workloads.map(workload => `runtime-${workload.name}`)]) result.push({
    key: `identity:${purpose}`, kind: 'identity', id: s.identity(purpose), purpose, dependencies: ['group', 'provider:Microsoft.ManagedIdentity'] });
  result.push({ key: 'registry', kind: 'registry', id: s.registry, dependencies: ['group', 'provider:Microsoft.ContainerRegistry'] },
    { key: 'environment', kind: 'environment', id: s.managedEnvironment, dependencies: ['group', 'provider:Microsoft.App'] });
  for (const workload of s.topology.workloads) result.push({ key: `app:${workload.name}`, kind: 'app', id: s.app(workload.name), purpose: workload.name, dependencies: ['environment', 'identity:holding'] });
  for (const role of Object.keys(roles) as Array<keyof typeof roles>) result.push({ key: `role:${role}`, kind: 'role', id: s.role(role), role, dependencies: ['group'] });
  for (const id of s.vaults) result.push({ key: `vault:${azurePreparedDigest(id).slice(0, 16)}`, kind: 'vault', id, dependencies: [] });
  const addGrant = (key: string, principal: string, scope: string, role: string, dependencies: string[], hosted: boolean) => result.push({ key: `grant:${key}`, kind: 'grant',
    id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${azurePreparedGuid([s.owner, key])}`, principal, scope, role, dependencies: [`identity:${principal}`, ...dependencies], hosted });
  for (const purpose of ['provision', 'release'] as const) {
    result.push({ key: `federation:${purpose}`, kind: 'federation', id: `${s.identity(purpose)}/federatedIdentityCredentials/hypervibe`, purpose, hosted: true, dependencies: [`identity:${purpose}`] });
    addGrant(`${purpose}:inspect`, purpose, s.group, s.role('inspect'), ['role:inspect'], true);
    addGrant(`${purpose}:push`, purpose, s.registry, `${s.subscription}/providers/Microsoft.Authorization/roleDefinitions/${builtIn.push}`, ['registry'], true);
    addGrant(`${purpose}:join`, purpose, s.managedEnvironment, s.role('join'), ['environment', 'role:join'], true);
    for (const workload of s.topology.workloads) {
      addGrant(`${purpose}:app:${workload.name}`, purpose, s.app(workload.name), s.role(purpose), [`app:${workload.name}`, `role:${purpose}`], true);
      addGrant(`${purpose}:assign:${workload.name}`, purpose, s.identity(`runtime-${workload.name}`), s.role('assign'), [`identity:runtime-${workload.name}`, 'role:assign'], true);
    }
    for (const id of s.vaults) addGrant(`${purpose}:vault:${id.toLowerCase()}`, purpose, id, s.role('vault'), ['role:vault', `vault:${azurePreparedDigest(id).slice(0, 16)}`], true);
  }
  for (const workload of s.topology.workloads) {
    const principal = `runtime-${workload.name}`;
    addGrant(`${principal}:pull`, principal, s.registry, `${s.subscription}/providers/Microsoft.Authorization/roleDefinitions/${builtIn.pull}`, ['registry'], false);
    for (const id of [...new Set(workload.runtimeSecrets.map(({ reference }) => {
      const d = reference.destination; if (d.provider !== 'azure-key-vault') return fail();
      return `/subscriptions/${d.subscriptionId}/resourceGroups/${d.resourceGroup}/providers/Microsoft.KeyVault/vaults/${d.vaultName}`;
    }))]) addGrant(`${principal}:vault:${id.toLowerCase()}`, principal, id, `${s.subscription}/providers/Microsoft.Authorization/roleDefinitions/${builtIn.reader}`,
      [`vault:${azurePreparedDigest(id).slice(0, 16)}`], false);
  }
  result.push({ key: 'verify', kind: 'verify', id: s.group, dependencies: result.map(target => target.key) });
  return result;
}
function actionId(key: string) { return `azure:prepared:${key.length > 180 ? azurePreparedDigest(key) : key}`; }
function actions(intent: CloudInstallationIntent, vaultTimes: Record<string, string> = {}): CloudInstallationAction[] {
  const s = settings(intent), completedIds = new Set((intent.installed ?? []).map(value => evidenceSchema.parse(value).native.actionId));
  const all = targets(intent), selected = intent.mode === 'disconnect' ? all.filter(target => target.hosted && completedIds.has(actionId(target.key))) : all;
  return selected.map(target => ({ id: actionId(target.key), type: intent.mode === 'disconnect' ? 'destroy' : target.kind === 'verify' || target.kind === 'vault' ? 'noop' : target.kind === 'provider' ? 'update' : 'create',
    resource: { kind: 'project', name: target.id, provider: 'azure' }, verified: true, requiresConfirm: !['vault', 'verify'].includes(target.kind),
    ...(['registry', 'environment', 'app'].includes(target.kind) ? { billable: true, dataBearing: true } : {}),
    reason: intent.mode === 'disconnect' ? 'Remove this exact hosted deployment trust; preserve application resources and runtime readers.'
      : 'Prepare the reviewed app/environment namespace and native deployment resources; holding code receives no secrets.',
    dependsOn: intent.mode === 'disconnect' ? [] : target.dependencies.map(actionId),
    metadata: { operation: 'azurePreparedInstallation', category: target.kind === 'identity' ? 'identity' : target.kind === 'grant' || target.kind === 'federation' || target.kind === 'role' ? 'trust' : target.kind === 'verify' || target.kind === 'vault' ? 'verification' : 'scope',
      execution: 'api', native: { kind: target.kind, key: target.key, resourceId: target.id, owner: s.owner,
        ...(target.purpose ? { purpose: target.purpose } : {}), ...(target.kind === 'vault' && vaultTimes[target.id] ? { createdAt: vaultTimes[target.id] } : {}) } } }));
}
function api(target: Target) { return AZURE_PREPARED_API[target.kind === 'verify' ? 'group' : target.kind]; }
function deploymentTarget(intent: CloudInstallationIntent, target: Target): AzureInstallationTarget {
  const s = settings(intent), subscriptionScope = target.kind === 'group' || target.kind === 'role';
  const types: Partial<Record<Kind, string>> = { group: 'Microsoft.Resources/resourceGroups', identity: 'Microsoft.ManagedIdentity/userAssignedIdentities',
    registry: 'Microsoft.ContainerRegistry/registries', environment: 'Microsoft.App/managedEnvironments', app: 'Microsoft.App/containerApps',
    role: 'Microsoft.Authorization/roleDefinitions', grant: 'Microsoft.Authorization/roleAssignments', federation: 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials' };
  const type = types[target.kind]; if (!type) fail();
  const deploymentScope = subscriptionScope ? s.subscription : target.kind === 'grant' ? target.id.slice(0, target.id.toLowerCase().indexOf('/providers/')) : s.group;
  return { id: target.id, apiVersion: api(target), type, location: s.source.nativeScope.location, subscriptionScope,
    deploymentScope, name: target.kind === 'group' ? s.source.nativeScope.resourceGroup : target.kind === 'federation'
      ? `${s.identity(target.purpose!).split('/').at(-1)!}/hypervibe` : target.id.split('/').at(-1)! };
}
function grantsDescription(owner: string, target: Target) { return `Hypervibe deployment ${owner}; ${azurePreparedDigest(target.key)}`; }

export function createAzurePreparedInstallationDriver(options: { fetch?: typeof fetch; deadlineMs?: number } = {}): CloudInstallationDriver {
  const request = options.fetch ?? fetch;
  const read = async (budget: DestinationBudget, token: string, id: string, version: string): Promise<Record<string, any> | null> => {
    try { const value = await destinationJson(request, budget, `${ARM}${id}?api-version=${version}`, token); rejectAzureCredentialEcho(value, token); return value; }
    catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
  };
  const call = async <T>(context: Context, fn: (budget: DestinationBudget, token: string) => Promise<T>) => {
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: options.deadlineMs });
    try { if (!context.authentication.administrator) fail('authorization_expired');
      return await fn(budget, await budget.wait(context.authentication.administrator.getAccessToken(SCOPE, budget.signal))); }
    finally { budget.close(); }
  };
  function targetFor(action: CloudInstallationAction, intent: CloudInstallationIntent) {
    const target = targets(intent).find(target => actionId(target.key) === action.id); if (!target) fail(); return target;
  }
  function completed(context: Context) {
    const values = { ...context.completed };
    if (context.intent.mode === 'disconnect') for (const value of context.intent.installed ?? []) {
      const parsed = parseEvidence(value, context.intent); values[String(parsed.native.actionId)] = parsed;
    }
    return values;
  }
  function principal(context: Context, purpose: string): Extract<CloudDeploymentPrincipalV1, { kind: 'azure-managed-identity' }> {
    const s = settings(context.intent), resource = completed(context)[actionId(`identity:${purpose}`)]?.resources[0];
    if (!resource || !same(resource.id, s.identity(purpose)) || !z.string().guid().safeParse(resource.identity.clientId).success || !z.string().guid().safeParse(resource.identity.principalId).success) fail('ownership_mismatch');
    return { kind: 'azure-managed-identity', tenantId: s.source.nativeScope.tenantId, subscriptionId: s.source.nativeScope.subscriptionId,
      clientId: resource.identity.clientId, principalId: resource.identity.principalId, identityResourceId: resource.id };
  }
  function identity(context: Context, target: Target, native: Record<string, any>): Record<string, string> {
    const s = settings(context.intent), p = native.properties;
    if (!same(native.id, target.id)) fail();
    if (target.kind === 'provider') { if (native.namespace !== target.purpose || !['Registered', 'Registering'].includes(native.registrationState)) fail('not_converged'); return { namespace: target.purpose! }; }
    if (!p || typeof p !== 'object') fail('not_converged');
    if (['group', 'identity', 'registry', 'environment', 'app'].includes(target.kind) && (native.tags?.hypervibeInstallation !== s.source.installationId
      || native.tags?.hypervibeDeployment !== s.owner || native.tags?.hypervibePurpose !== (target.purpose ?? target.key) || native.location !== s.source.nativeScope.location)) fail('ownership_mismatch');
    if (target.kind === 'identity') {
      if (!same(p.tenantId, s.source.nativeScope.tenantId) || !z.string().guid().safeParse(p.clientId).success || !z.string().guid().safeParse(p.principalId).success) fail();
      return { clientId: p.clientId, principalId: p.principalId };
    }
    if (target.kind === 'federation') { if (p.issuer !== s.source.hostIdentity.issuer || p.subject !== s.source.hostIdentity.subject
      || !isDeepStrictEqual(p.audiences, [AZURE_HOST_FEDERATION_AUDIENCE])) fail('ownership_mismatch');
      return { issuer: p.issuer, subject: p.subject, audience: AZURE_HOST_FEDERATION_AUDIENCE }; }
    if (target.kind === 'role') {
      const permission = [{ actions: [...roles[target.role as keyof typeof roles]], notActions: [], dataActions: [], notDataActions: [] }];
      const normalize = (value: any[]) => value.map(item => ({ actions: [...item.actions].sort(), notActions: [...item.notActions].sort(), dataActions: [...item.dataActions].sort(), notDataActions: [...item.notDataActions].sort() }));
      if (p.type !== 'CustomRole' || p.description !== grantsDescription(s.owner, target) || !isDeepStrictEqual(p.assignableScopes, [s.subscription])
        || !Array.isArray(p.permissions) || !isDeepStrictEqual(normalize(p.permissions), normalize(permission))) fail('ownership_mismatch');
      return { owner: s.owner, permissionDigest: azurePreparedDigest(permission) };
    }
    if (target.kind === 'grant') {
      const nativePrincipal = principal(context, target.principal!);
      if (!same(p.principalId, nativePrincipal.principalId) || !same(p.roleDefinitionId, target.role!) || !same(p.scope, target.scope!)
        || p.principalType !== 'ServicePrincipal' || p.condition != null || p.description !== grantsDescription(s.owner, target)) fail('ownership_mismatch');
      return { principalId: nativePrincipal.principalId, roleDefinitionId: target.role!, scope: target.scope! };
    }
    if (p.provisioningState !== 'Succeeded') fail('not_converged');
    if (target.kind === 'group') return { owner: s.owner };
    if (!z.string().datetime({ offset: true }).safeParse(native.systemData?.createdAt).success) fail();
    if (target.kind === 'vault') {
      if (!same(p.tenantId, s.source.nativeScope.tenantId) || p.enableRbacAuthorization !== true || native.tags?.hypervibeCustomerId !== s.source.customerId
        || native.tags?.hypervibeAppId !== s.source.appId || native.tags?.hypervibeEnvironment !== s.source.environment) fail('ownership_mismatch');
    } else if (target.kind === 'registry') {
      if (p.adminUserEnabled !== false || p.loginServer !== s.registryServer || native.sku?.name !== 'Basic') fail();
    } else if (target.kind === 'environment') {
      if (p.appLogsConfiguration?.destination !== 'none' || p.zoneRedundant === true || p.vnetConfiguration?.internal === true
        || !Array.isArray(p.workloadProfiles) || p.workloadProfiles.length !== 1 || p.workloadProfiles[0].name !== 'Consumption' || p.workloadProfiles[0].workloadProfileType !== 'Consumption') fail();
    } else if (target.kind === 'app') {
      const retained = completed(context)[actionId(target.key)]?.resources[0];
      if (retained && p.template?.containers?.[0]?.image !== s.topology.preparation!.image) {
        const runtime = principal(context, `runtime-${target.purpose}`), assigned = native.identity?.userAssignedIdentities?.[runtime.identityResourceId];
        const projection = azureObservedPreparedApplicationConfiguration(native), image = p.template.containers[0].image, env = p.template.containers[0].env;
        const expected = [...s.topology.workloads.find(item => item.name === target.purpose)!.runtimeSecrets].sort((a, b) => a.key.localeCompare(b.key)).map(({ key, reference }, index) => {
          const d = reference.destination; if (d.provider !== 'azure-key-vault') return fail();
          return { key, name: `reference-${index}`, url: `https://${d.vaultName}.vault.azure.net/secrets/${d.secretName}/${reference.version}` };
        });
        if (retained.identity.createdAt !== native.systemData.createdAt || assigned?.clientId !== runtime.clientId || assigned?.principalId !== runtime.principalId
          || typeof image !== 'string' || !image.startsWith(`${s.registryServer}/`) || !/@sha256:[a-f0-9]{64}$/.test(image)
          || p.latestRevisionName !== p.latestReadyRevisionName || !/^[a-f0-9]{40}$/.test(env.find((item: any) => item.name === 'HYPERVIBE_DEPLOY_SHA')?.value ?? '')
          || env.find((item: any) => item.name === 'HYPERVIBE_IMAGE_DIGEST')?.value !== image.split('@')[1]
          || projection.properties.configuration.secrets.length !== expected.length || expected.some(item => !projection.properties.configuration.secrets.some(secret => secret.name === item.name && secret.keyVaultUrl === item.url && secret.identity === runtime.identityResourceId)
            || !env.some((entry: any) => entry.name === item.key && entry.secretRef === item.name && entry.value === undefined))) fail();
        return retained.identity;
      }
      const observed = azureObservedHoldingConfiguration(native, { id: target.id, image: s.topology.preparation!.image, identityId: s.identity('holding'), environmentId: s.managedEnvironment, publicAccess: true });
      return { createdAt: native.systemData.createdAt, owner: s.owner, configurationDigest: azurePreparedDigest(observed), revision: p.latestReadyRevisionName };
    } else fail();
    return { createdAt: native.systemData.createdAt, ...(target.kind === 'vault' ? {} : { owner: s.owner }) };
  }
  function parseEvidence(value: unknown, intent: CloudInstallationIntent): CloudInstallationEvidence {
    try {
      const parsed = evidenceSchema.parse(value), s = settings(intent), target = targets(intent).find(target => actionId(target.key) === parsed.native.actionId);
      if (!target || parsed.native.owner !== s.owner || parsed.native.installationId !== s.source.installationId
        || parsed.resources.some(resource => resource.kind !== target.kind || !same(resource.id, target.id))
        || !parsed.resources.length && (!parsed.native.attemptId || !parsed.native.deployment)) fail();
      const date = z.string().datetime({ offset: true }), owner = z.literal(s.owner), hash = z.string().regex(/^[a-f0-9]{64}$/);
      const shapes: Record<Kind, z.ZodType> = {
        group: z.object({ owner }).strict(), verify: z.object({ owner }).strict(), provider: z.object({ namespace: z.literal(target.purpose ?? '') }).strict(),
        identity: z.object({ clientId: z.string().guid(), principalId: z.string().guid() }).strict(),
        vault: z.object({ createdAt: date }).strict(), registry: z.object({ createdAt: date, owner }).strict(), environment: z.object({ createdAt: date, owner }).strict(),
        app: z.object({ createdAt: date, owner, configurationDigest: hash, revision: z.string().regex(/^[a-z0-9][a-z0-9-]{0,126}$/) }).strict(), role: z.object({ owner, permissionDigest: hash }).strict(),
        grant: z.object({ principalId: z.string().guid(), roleDefinitionId: z.literal(target.role ?? ''), scope: z.literal(target.scope ?? '') }).strict(),
        federation: z.object({ issuer: z.literal(s.source.hostIdentity.issuer), subject: z.literal(s.source.hostIdentity.subject), audience: z.literal(AZURE_HOST_FEDERATION_AUDIENCE) }).strict(),
      };
      for (const resource of parsed.resources) shapes[resource.kind].parse(resource.identity);
      if (parsed.native.deployment && parsed.native.deployment.id !== `${deploymentTarget(intent, target).deploymentScope}/providers/Microsoft.Resources/deployments/hv-${parsed.native.attemptId}`) fail();
      return parsed;
    } catch { return fail(); }
  }
  function receipt(context: Context, target: Target, native: Record<string, string>, attempt?: CloudInstallationAttempt): CloudInstallationEvidence {
    const s = settings(context.intent);
    return { resources: [{ kind: target.kind, id: target.id, identity: native }], native: { contract: 'azure-prepared-v1', installationId: s.source.installationId,
      owner: s.owner, actionId: actionId(target.key), ...(attempt ? { attemptId: attempt.id } : {}) } };
  }
  async function prerequisite(context: Context, budget: DestinationBudget, token: string, key: string) {
    const target = targets(context.intent).find(target => target.key === key), evidence = completed(context)[actionId(key)];
    if (!target || !evidence?.resources[0]) fail('ownership_mismatch');
    const native = await read(budget, token, target.id, api(target)); if (!native) fail('not_installed');
    const observed = identity(context, target, native);
    if (!isDeepStrictEqual(observed, evidence.resources[0].identity)) fail(); return observed;
  }
  async function observe(input: ActionContext, recovering: boolean) {
    try {
      driver.parseAction(input.action, input.intent); const target = targetFor(input.action, input.intent), s = settings(input.intent);
      return await call(input, async (budget, token) => {
        if (target.kind === 'verify') {
          for (const previous of targets(input.intent).filter(target => target.kind !== 'verify')) await prerequisite(input, budget, token, previous.key);
          if (!isDeepStrictEqual(await budget.wait(input.authentication.host.verifyIdentity(budget.signal)), input.intent.hostIdentity)) fail();
          for (const purpose of ['provision', 'release']) {
            const p = principal(input, purpose), exchange = createAzureDeploymentTokenProvider({ tenantId: p.tenantId, clientId: p.clientId,
              getGoogleIdToken: (audience, signal) => input.authentication.host.getIdToken(audience, signal) }, { fetch: request, deadlineMs: options.deadlineMs });
            const proof = await budget.wait(exchange('resource-manager', budget.signal));
            const native = await read(budget, proof.token, p.identityResourceId, AZURE_PREPARED_API.identity);
            if (!native || !same(native.properties?.clientId, p.clientId) || !same(native.properties?.principalId, p.principalId)) fail();
          }
          return { state: 'satisfied' as const, evidence: receipt(input, target, { owner: s.owner }) };
        }
        const native = await read(budget, token, target.id, api(target));
        if (input.intent.mode === 'disconnect') {
          const evidence = completed(input)[input.action.id]; if (!evidence) fail('ownership_mismatch');
          if (!native) return { state: 'satisfied' as const, evidence };
          if (target.principal || target.purpose) await prerequisite(input, budget, token, `identity:${target.principal ?? target.purpose}`);
          if (!isDeepStrictEqual(identity(input, target, native), evidence.resources[0].identity)) fail('ownership_mismatch');
          return recovering ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
        }
        if (target.kind === 'provider') {
          if (!native || !same(native.id, target.id) || native.namespace !== target.purpose) fail();
          if (['Registered', 'Registering'].includes(native.registrationState)) return { state: 'satisfied' as const, evidence: receipt(input, target, identity(input, target, native)) };
          if (!['NotRegistered', 'Unregistered'].includes(native.registrationState)) fail('not_converged');
          return recovering ? { state: 'unknown' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
        }
        if (target.kind === 'vault') {
          if (!native) fail('not_installed'); const observed = identity(input, target, native);
          if (observed.createdAt !== input.action.metadata.native.createdAt) fail();
          return { state: 'satisfied' as const, evidence: receipt(input, target, observed) };
        }
        if (!recovering) return native ? { state: 'conflict' as const, reason: 'ownership_mismatch' as const } : { state: 'action-required' as const };
        if (!input.attempt?.evidence) return { state: 'unknown' as const, reason: 'not_converged' as const };
        const previous = parseEvidence(input.attempt.evidence, input.intent);
        if (!previous.native.deployment || previous.native.attemptId !== input.attempt.id) fail('not_converged');
        const deployment = await verifyAzureInstallationDeployment({ request, budget, token, target: deploymentTarget(input.intent, target), attempt: input.attempt,
          retained: azureDeploymentProvenanceSchema.parse(previous.native.deployment) });
        if (!native) fail('not_installed');
        for (const key of target.dependencies) await prerequisite(input, budget, token, key);
        if (target.kind === 'app' && completed(input)[input.action.id] && native.properties?.template?.containers?.[0]?.image !== s.topology.preparation!.image) await prerequisite(input, budget, token, `identity:runtime-${target.purpose}`);
        const observed = identity(input, target, native), retained = completed(input)[input.action.id]?.resources[0];
        if (retained && !isDeepStrictEqual(retained.identity, observed)) fail();
        const evidence = receipt(input, target, observed, input.attempt);
        return { state: 'satisfied' as const, evidence: { ...evidence, native: { ...evidence.native, deployment } } };
      });
    } catch (error) { const why = reason(error); return { state: why === 'ownership_mismatch' || why === 'identity_mismatch' ? 'conflict' as const : why === 'not_converged' ? 'pending' as const : 'unknown' as const, reason: why }; }
  }
  const driver: CloudInstallationDriver = {
    provider: 'azure', parseScope(value) { return value as Record<string, string>; }, connections() { return []; },
    parseAction(value, intent) {
      const native = (value as CloudInstallationAction)?.metadata?.native;
      const expected = actions(intent, typeof native?.resourceId === 'string' && typeof native.createdAt === 'string' ? { [native.resourceId]: native.createdAt } : {}).find(action => action.id === (value as CloudInstallationAction)?.id);
      if (!expected || !isDeepStrictEqual(expected, value)) fail(); return expected;
    }, parseEvidence,
    async plan(context) {
      const s = settings(context.intent), all = targets(context.intent), times: Record<string, string> = {};
      return call(context, async (budget, token) => {
        if (context.intent.mode !== 'disconnect') await budget.wait(verifyAzureHoldingImage(s.topology.preparation!.image, { fetch: request, signal: budget.signal }));
        const subscription = await read(budget, token, s.subscription, '2022-12-01');
        if (!subscription || !same(subscription.subscriptionId, s.source.nativeScope.subscriptionId) || !same(subscription.tenantId, s.source.nativeScope.tenantId) || subscription.state !== 'Enabled') fail();
        const authority = await read(budget, token, `${s.subscription}/providers/Microsoft.Authorization/permissions`, '2022-04-01');
        const needed = context.intent.mode === 'disconnect' ? actions(context.intent).map(action => targetFor(action, context.intent).kind === 'federation'
          ? 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/delete' : 'Microsoft.Authorization/roleAssignments/delete') : permissions;
        const matches = (pattern: string, permission: string) => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(permission);
        const permits = (name: string) => Array.isArray(authority?.value) && !authority?.nextLink && authority!.value.some((entry: any) => Array.isArray(entry.actions) && Array.isArray(entry.notActions)
          && entry.actions.some((pattern: unknown) => typeof pattern === 'string' && matches(pattern, name)) && !entry.notActions.some((pattern: unknown) => typeof pattern !== 'string' || matches(pattern, name)));
        if (!needed.every(permits)) fail('insufficient_permissions');
        let blockedReason: CloudInstallationReason | undefined;
        if (context.intent.mode !== 'disconnect') for (const target of all.filter(target => target.kind !== 'verify')) {
          const native = await read(budget, token, target.id, api(target));
          if (target.kind === 'provider') {
            if (!native || !same(native.id, target.id) || native.namespace !== target.purpose || !['Registered', 'Registering', 'NotRegistered', 'Unregistered'].includes(native.registrationState)) fail();
            if (!['Registered', 'Registering'].includes(native.registrationState) && !permits(`${target.purpose}/register/action`)) fail('insufficient_permissions');
          } else if (target.kind === 'vault') { if (!native) fail('not_installed'); times[target.id] = identity(context, target, native).createdAt; }
          else if (native) blockedReason = 'ownership_mismatch';
        }
        return { actions: actions(context.intent, times), ...(blockedReason ? { blockedReason } : {}), review: {
          resources: all.filter(target => target.kind !== 'verify').map(target => ({ kind: target.kind, name: target.id, scope: s.group })),
          permissions: [{ principal: 'Transient administrator', scope: s.subscription, actions: [...needed], purpose: 'installation-verification' as const },
            ...all.filter(target => target.kind === 'grant').map(target => ({ principal: s.identity(target.principal!), scope: target.scope!, actions: [target.role!],
              purpose: target.principal === 'provision' ? 'deployment-provision' as const : target.principal === 'release' ? 'deployment-release' as const : 'runtime-reader' as const }))],
          costs: [{ resource: s.registry, description: 'Basic Azure Container Registry has a daily charge. Consumption Container Apps can incur compute and request charges; the reviewed holding app scales to zero with at most one replica. No paid log workspace or private endpoint is created.', pricingUrl: 'https://azure.microsoft.com/pricing/details/container-registry/' }],
          warnings: ['Approve exclusive management of this app/environment namespace. Existing or unknown targets block creation. Concurrent independent same-ID writes can be overwritten by Azure upsert before conflict is detected; this is not an atomic create guarantee.',
            'The reviewed immutable holding image receives no application secrets and has a separate unprivileged identity. A later reviewed candidate rollout must atomically change the image, runtime UAMI and versioned secret references.',
            'Provisioning, release and workload reader identities are separate. Hosting code changes can exercise runtime reader access. Removing hosted trust retains secrets, registries, workloads and runtime grants; issued tokens can remain usable until expiry.',
            'Missing native deployment acknowledgment or operation correlation stays unknown without automatic retry.'],
        } };
      });
    },
    inspect(input) { return observe(input, false); }, recover(input) { return observe(input, true); },
    async mutate(input) {
      let dispatched = false;
      try { driver.parseAction(input.action, input.intent); const target = targetFor(input.action, input.intent), s = settings(input.intent);
        if (input.attempt.actionId !== input.action.id || input.action.type === 'noop') fail();
        return await call(input, async (budget, token) => {
          const previous = await read(budget, token, target.id, api(target));
          if (input.intent.mode === 'disconnect') {
            const retained = completed(input)[input.action.id]; if (!retained || !target.hosted) fail('ownership_mismatch');
            if (!previous) return { state: 'acknowledged' as const };
            await prerequisite(input, budget, token, `identity:${target.principal ?? target.purpose}`);
            if (!isDeepStrictEqual(identity(input, target, previous), retained.resources[0].identity)) fail('ownership_mismatch');
            await budget.wait(input.beforeMutation()); dispatched = true;
            const response = await budget.wait(request(`${ARM}${target.id}?api-version=${api(target)}`, { method: 'DELETE', redirect: 'error', signal: budget.signal, headers: { Authorization: `Bearer ${token}` } }));
            void response.body?.cancel().catch(() => {}); if (!response.ok && response.status !== 404) fail('provider_error');
            return { state: 'acknowledged' as const };
          }
          if (target.kind === 'provider') {
            if (!previous || !same(previous.id, target.id) || previous.namespace !== target.purpose) fail();
            if (['Registered', 'Registering'].includes(previous.registrationState)) return { state: 'acknowledged' as const };
            if (!['NotRegistered', 'Unregistered'].includes(previous.registrationState)) fail();
            await budget.wait(input.beforeMutation()); dispatched = true;
            await destinationJson(request, budget, `${ARM}${target.id}/register?api-version=${api(target)}`, token, { method: 'POST' });
            return { state: 'acknowledged' as const };
          }
          if (previous) fail('ownership_mismatch');
          for (const key of target.dependencies) await prerequisite(input, budget, token, key);
          if (target.kind === 'app') await budget.wait(verifyAzureHoldingImage(s.topology.preparation!.image, { fetch: request, signal: budget.signal }));
          const tags = { hypervibeInstallation: s.source.installationId, hypervibeDeployment: s.owner, hypervibePurpose: target.purpose ?? target.key, hypervibeAttempt: input.attempt.id };
          let body: Record<string, unknown>;
          if (target.kind === 'group' || target.kind === 'identity') body = { location: s.source.nativeScope.location, tags };
          else if (target.kind === 'registry') body = { location: s.source.nativeScope.location, tags, sku: { name: 'Basic' }, properties: { adminUserEnabled: false, publicNetworkAccess: 'Enabled' } };
          else if (target.kind === 'environment') body = { location: s.source.nativeScope.location, tags, properties: { appLogsConfiguration: { destination: 'none' }, workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }], zoneRedundant: false } };
          else if (target.kind === 'app') body = { location: s.source.nativeScope.location, tags, ...azureHoldingConfiguration(s.topology.preparation!.image, s.identity('holding'), s.managedEnvironment, true) };
          else if (target.kind === 'federation') body = { properties: { issuer: s.source.hostIdentity.issuer, subject: s.source.hostIdentity.subject, audiences: [AZURE_HOST_FEDERATION_AUDIENCE] } };
          else if (target.kind === 'role') body = { properties: { roleName: `Hypervibe ${target.role} ${s.owner.slice(0, 12)}`, type: 'CustomRole', description: grantsDescription(s.owner, target), assignableScopes: [s.subscription],
            permissions: [{ actions: [...roles[target.role as keyof typeof roles]], notActions: [], dataActions: [], notDataActions: [] }] } };
          else if (target.kind === 'grant') body = { scope: target.scope, properties: { principalId: principal(input, target.principal!).principalId, principalType: 'ServicePrincipal', roleDefinitionId: target.role, description: grantsDescription(s.owner, target) } };
          else fail();
          const deployment = await createAzureInstallationDeployment({ request, budget, token, target: deploymentTarget(input.intent, target), resource: body,
            attempt: input.attempt, beforeMutation: input.beforeMutation, dispatched() { dispatched = true; } });
          return { state: 'acknowledged' as const, evidence: { resources: [], native: { contract: 'azure-prepared-v1', installationId: s.source.installationId,
            owner: s.owner, actionId: input.action.id, attemptId: input.attempt.id, deployment } } };
        });
      } catch (error) { const why = reason(error); return { state: dispatched && why !== 'insufficient_permissions' ? 'uncertain' as const : 'rejected' as const, reason: why }; }
    },
    deployment: { hostingProvider: 'azure-container-apps', parsePreparedResources: parseAzurePreparedResources,
      connection(record: CloudInstallationRecord): CloudDeploymentConnectionV1 {
        const s = settings(record.intent), context = { intent: record.intent, completed: record.completed } as Context;
        if (record.status !== 'ready' || record.intent.mode !== 'connect' || !record.completed[actionId('verify')]) fail('not_converged');
        for (const target of targets(record.intent)) if (!record.completed[actionId(target.key)]?.resources[0]) fail('not_converged');
        const holding = principal(context, 'holding'), identity = (key: string) => record.completed[actionId(key)].resources[0].identity;
        const connection: CloudDeploymentConnectionV1 = { schemaVersion: 1, purpose: 'deployment', installationId: s.source.installationId, planDigest: record.plan.digest,
          customerId: s.source.customerId, appId: s.source.appId, environment: s.source.environment, source: s.source.source, provider: 'azure', hostingProvider: 'azure-container-apps',
          nativeScope: s.source.nativeScope, hostIdentity: s.source.hostIdentity, deployment: s.topology, principals: { provision: principal(context, 'provision'), release: principal(context, 'release') },
          runtimeIdentities: s.topology.workloads.map(workload => ({ workload: workload.name, installationId: s.source.installationId, owner: s.owner, principal: principal(context, `runtime-${workload.name}`) })),
          preparedResources: { schemaVersion: 1, project: { id: s.managedEnvironment, parentId: s.group, lifetimeId: identity('environment').createdAt },
            registry: { id: s.registry, lifetimeId: identity('registry').createdAt, owner: s.owner },
            secretTargets: s.vaults.map(id => ({ id, lifetimeId: identity(`vault:${azurePreparedDigest(id).slice(0, 16)}`).createdAt })),
            workloads: s.topology.workloads.map(workload => ({ workload: workload.name, kind: 'service', id: s.app(workload.name), lifetimeId: identity(`app:${workload.name}`).createdAt,
              owner: s.owner, holding: { image: s.topology.preparation!.image, configurationDigest: identity(`app:${workload.name}`).configurationDigest, revision: identity(`app:${workload.name}`).revision, principal: holding } })) } };
        parseAzurePreparedResources(connection.preparedResources, connection); return connection;
      },
    },
  };
  return driver;
}
