import { OBSERVER_ARM_READER, OBSERVER_LOG_READER } from './tofu/azure-observer.config.js';
import { responseFields } from '../../../lib/provider-response-fields.js';
import { azureCiRoleDefinitions } from './azure-ci-roles.js';
import { azureDeployToken, type AzureEngineCredentials } from './azure-engine.adapter.js';
import crypto from 'crypto';
import os from 'os';
import { azureProjectVaultName } from './tofu/azure-engine.config.js';
import { ARM_SCOPE, GRAPH_SCOPE, azureTokenFor, type AzureSignInSession } from './azure-entra.client.js';

/**
 * One-time Azure setup, mirroring AWS: the person signs in once (an Owner of
 * the subscription), approves this exact list, and Hypervibe creates its own
 * limited access. Afterwards the sign-in is not used again.
 *
 * - hv-<project> (resource group): everything Hypervibe builds for the project.
 * - hypervibe-deploy-<project> (app registration and service principal): what
 *   OpenTofu deploys with, from this computer (a client secret stored
 *   encrypted here) and from the repository's GitHub Actions (federated
 *   credentials, no stored secret).
 * - Roles on the resource group only, never on the subscription: Contributor,
 *   Key Vault Secrets Officer (to write the app's secrets), and Role Based
 *   Access Control Administrator limited by a condition to the three data
 *   roles an app's identity needs, for service principals only. It is the
 *   Azure equivalent of the AWS permissions boundary: the deploy identity
 *   cannot grant itself or anyone else Owner, Contributor or role administration.
 */
export const AZURE_SETUP_VERSION = 'azure-v2';
const ARM = 'https://management.azure.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
/** Resource providers the engine uses; registering them is free and needs the subscription Owner, so setup does it. */
export const AZURE_RESOURCE_PROVIDERS = ['Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.DBforPostgreSQL', 'Microsoft.KeyVault',
  'Microsoft.ManagedIdentity', 'Microsoft.Network', 'Microsoft.OperationalInsights', 'Microsoft.Storage'] as const;

const monitoringProviders = ['Microsoft.Portal', 'Microsoft.Insights'];
const requiredProviders = (monitoring?: boolean) => monitoring ? [...AZURE_RESOURCE_PROVIDERS, ...monitoringProviders] : AZURE_RESOURCE_PROVIDERS;

/** Built-in role ids (identical in every tenant). */
export const AZURE_ROLES = {
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7',
  roleBasedAccessControlAdministrator: 'f58310d9-a9f6-439a-9e8d-f62e7b41a168',
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d',
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6',
  storageBlobDataReader: '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1',
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
} as const;
/** The only roles the deploy identity may assign: what an app's managed identity needs. */
export const AZURE_APP_ROLES = [AZURE_ROLES.acrPull, AZURE_ROLES.keyVaultSecretsUser, AZURE_ROLES.storageBlobDataContributor];

const slug = (project: string, length: number) => project.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, length).replace(/-$/, '');
export const azureResourceGroupName = (project: string) => `hv-${slug(project, 60)}`;
export const azureDeployAppName = (project: string) => `hypervibe-deploy-${slug(project, 40)}`;

/**
 * ABAC condition on the deploy identity's role-administration assignment: it may
 * add or remove only the app roles, and only for service principals (managed
 * identities are service principals).
 */
export function appRoleAssignmentCondition(ciRoleIds: string[] = [], bucketBackupReader = false, runtimeObservation = false): string {
  const roles = [...AZURE_APP_ROLES, ...(bucketBackupReader ? [AZURE_ROLES.storageBlobDataReader] : []), ...ciRoleIds, ...(runtimeObservation ? [OBSERVER_ARM_READER, OBSERVER_LOG_READER] : [])].join(', ');
  const constrain = (source: 'Request' | 'Resource') =>
    `@${source}[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${roles}} AND @${source}[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}`;
  return `((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (${constrain('Request')})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (${constrain('Resource')}))`;
}

export interface AzureRoleGrant { role: string; label: string; condition?: string }

/** Every role the deploy identity holds, all on the project's resource group. */
export function deployRoleGrants(ciRoleIds: string[] = [], bucketBackupReader = false, runtimeObservation = false): AzureRoleGrant[] {
  return [
    { role: AZURE_ROLES.contributor, label: 'Contributor' },
    { role: AZURE_ROLES.keyVaultSecretsOfficer, label: 'Key Vault Secrets Officer' },
    // Teardown empties storage before deleting it; accounts have no shared keys.
    { role: AZURE_ROLES.storageBlobDataContributor, label: 'Storage Blob Data Contributor' },
    { role: AZURE_ROLES.roleBasedAccessControlAdministrator, label: `Role Based Access Control Administrator (only app data roles${bucketBackupReader ? ', including Storage Blob Data Reader for scheduled file backups' : ''}${ciRoleIds.length ? ' and the two fixed CI roles' : ''}${runtimeObservation ? ', Reader and Log Analytics Data Reader for the observer' : ''}, only for service principals)`, condition: appRoleAssignmentCondition(ciRoleIds, bucketBackupReader, runtimeObservation) },
  ];
}

/** GitHub Actions subjects for the repository's environments (`environment:` in a workflow job). */
export function githubSubjects(repository: string, environments: string[]): Array<{ name: string; subject: string }> {
  return [...new Set(environments)].sort().slice(0, 20).map((environment) => ({
    name: `github-${slug(environment, 100) || 'env'}`, subject: `repo:${repository}:environment:${environment}`,
  }));
}

/** A stable role assignment name, so applying twice never duplicates an assignment. */
export function roleAssignmentName(scope: string, principalId: string, role: string): string {
  const hex = crypto.createHash('sha256').update(`${scope.toLowerCase()}|${principalId}|${role}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Fetch = typeof fetch;
interface RestResult { status: number; body: Record<string, unknown> }

async function rest(fetchImpl: Fetch, token: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<RestResult> {
  const response = await fetchImpl(url, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON error pages carry no detail */ }
  return { status: response.status, body: parsed };
}

function errorOf(result: RestResult): string {
  const error = (result.body.error ?? {}) as { code?: string; message?: string };
  return `HTTP ${result.status}${error.code ? ` ${error.code}` : ''}${error.message ? `: ${String(error.message).slice(0, 240)}` : ''}`;
}

/** Throws on anything but the expected statuses: an unreadable answer is never treated as "absent". */
function ensure(result: RestResult, what: string, ok: number[]): RestResult {
  if (!ok.includes(result.status)) throw new Error(`${what} failed (${errorOf(result)}).`);
  return result;
}

export interface AzureSubscription { subscriptionId: string; displayName: string; tenantId: string }

/** Enabled subscriptions the signed-in person can reach, across their directories. */
export async function listAzureSubscriptions(session: AzureSignInSession, fetchImpl: Fetch = fetch): Promise<{ subscriptions: AzureSubscription[]; unreachable: string[] }> {
  const tenants = ensure(await rest(fetchImpl, session.accessToken, 'GET', `${ARM}/tenants?api-version=2022-12-01`), 'Listing your Azure directories', [200]);
  const tenantIds = ((tenants.body.value ?? []) as Array<{ tenantId?: string }>).map((tenant) => tenant.tenantId).filter((id): id is string => Boolean(id));
  const subscriptions: AzureSubscription[] = [];
  const unreachable: string[] = [];
  for (const tenantId of tenantIds.slice(0, 10)) {
    let token: string;
    try { token = tenantId === session.tenantId ? session.accessToken : await azureTokenFor(session, { tenantId, scope: ARM_SCOPE }, fetchImpl); } catch (error) {
      unreachable.push(error instanceof Error ? error.message : tenantId);
      continue;
    }
    const listed = ensure(await rest(fetchImpl, token, 'GET', `${ARM}/subscriptions?api-version=2022-12-01`), `Listing subscriptions in directory ${tenantId}`, [200]);
    for (const entry of (listed.body.value ?? []) as Array<{ subscriptionId?: string; displayName?: string; state?: string; tenantId?: string }>) {
      if (entry.subscriptionId && entry.state === 'Enabled') subscriptions.push({ subscriptionId: entry.subscriptionId, displayName: entry.displayName ?? entry.subscriptionId, tenantId: entry.tenantId ?? tenantId });
    }
  }
  return { subscriptions, unreachable };
}

export interface AzureSetupChange { id: string; change: string; state: 'create' | 'update' | 'ok' }
export interface AzureSetupPlan {
  /** Register the monitoring namespaces only when this owner setup reviewed them. */
  monitoringResourceProviders?: true;
  bucketBackupReader?: true;
  runtimeObservation?: true;
  tenantId: string;
  subscriptionId: string;
  subscriptionName: string;
  location: string;
  signedInAs: string;
  resourceGroup: string;
  appName: string;
  vaultName: string;
  repository?: string;
  environments: string[];
  changes: AzureSetupChange[];
  /** True when every change is already in place. */
  ready: boolean;
}

export interface AzureSetupTarget {
  monitoringResourceProviders?: true;
  bucketBackupReader?: true;
  runtimeObservation?: true;
  subscription: AzureSubscription;
  project: string;
  location: string;
  repository?: string;
  /** Environment names that get a GitHub Actions credential. */
  environments: string[];
}

interface Tokens { arm: string; graph: string }

async function tokensFor(session: AzureSignInSession, tenantId: string, fetchImpl: Fetch): Promise<Tokens> {
  return {
    arm: tenantId === session.tenantId ? session.accessToken : await azureTokenFor(session, { tenantId, scope: ARM_SCOPE }, fetchImpl),
    graph: await azureTokenFor(session, { tenantId, scope: GRAPH_SCOPE }, fetchImpl),
  };
}

const appUrl = (name: string) => `${GRAPH}/applications(uniqueName='${encodeURIComponent(name)}')`;
const groupScope = (subscriptionId: string, group: string) => `/subscriptions/${subscriptionId}/resourceGroups/${group}`;
const roleDefinition = (subscriptionId: string, role: string) => `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${role}`;

function sameCiRole(observed: unknown, expected: ReturnType<typeof azureCiRoleDefinitions>['build']['properties']): boolean {
  const value = observed as typeof expected | undefined;
  const normalized = (properties: typeof expected) => JSON.stringify({ ...properties,
    assignableScopes: [...properties.assignableScopes].map((scope) => scope.toLowerCase()).sort(),
    permissions: properties.permissions.map((p) => ({ actions: [...p.actions].sort(), notActions: [...(p.notActions ?? [])].sort(), dataActions: [...(p.dataActions ?? [])].sort(), notDataActions: [...(p.notDataActions ?? [])].sort() })) });
  try { return !!value && normalized({ roleName: value.roleName, description: value.description, type: value.type, permissions: value.permissions, assignableScopes: value.assignableScopes }) === normalized(expected); } catch { return false; }
}

export async function azureMonitoringSetupReady(connection: AzureEngineCredentials, fetchImpl: Fetch = fetch): Promise<boolean> {
  const token = await azureDeployToken(connection, fetchImpl);
  for (const namespace of monitoringProviders) {
    const response = await rest(fetchImpl, token, 'GET', `${ARM}/subscriptions/${connection.subscriptionId}/providers/${namespace}?api-version=2021-04-01`);
    // A group-scoped deploy principal may lack subscription-wide read access. Owner setup recorded registration.
    if (response.status === 403 && connection.monitoringResourceProviders) continue;
    if (response.status !== 200 || response.body.registrationState !== 'Registered') return false;
  }
  return true;
}

/** Read-only upgrade detection; a missing or unverifiable grant cannot authorize branch releases. */
export async function azureCiSetupReady(connection: AzureEngineCredentials, fetchImpl: Fetch = fetch, runtimeObservation = false): Promise<boolean> {
  const token = await azureDeployToken(connection, fetchImpl);
  const roles = Object.values(azureCiRoleDefinitions(connection.subscriptionId, connection.resourceGroup));
  for (const role of roles) {
    const response = await rest(fetchImpl, token, 'GET', `${ARM}${role.id}?api-version=2022-04-01`);
    if (response.status !== 200 || !sameCiRole(response.body.properties, role.properties)) return false;
  }
  const scope = groupScope(connection.subscriptionId, connection.resourceGroup);
  const response = await rest(fetchImpl, token, 'GET', `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(`principalId eq '${connection.deployPrincipalId}'`)}`);
  if (response.status !== 200 || !Array.isArray(response.body.value) || response.body.nextLink) return false;
  return response.body.value.some((entry: { properties?: { principalId?: string; scope?: string; roleDefinitionId?: string; condition?: string; conditionVersion?: string } }) => {
    const p = entry.properties;
    return p?.principalId?.toLowerCase() === connection.deployPrincipalId.toLowerCase() && p.scope?.toLowerCase() === scope.toLowerCase()
      && p.roleDefinitionId?.toLowerCase().endsWith(AZURE_ROLES.roleBasedAccessControlAdministrator)
      && [false, true].some(reader => [true, runtimeObservation].some(observer => p.condition === appRoleAssignmentCondition(roles.map(role => role.guid), reader, observer))) && p.conditionVersion === '2.0';
  });
}

export async function azureBucketBackupAccessReady(connection: AzureEngineCredentials, fetchImpl: Fetch = fetch): Promise<boolean> {
  const scope = groupScope(connection.subscriptionId, connection.resourceGroup);
  const token = await azureDeployToken(connection, fetchImpl);
  const assignment = roleAssignmentName(scope, connection.deployPrincipalId, AZURE_ROLES.roleBasedAccessControlAdministrator);
  const response = await rest(fetchImpl, token, 'GET', ARM + scope + '/providers/Microsoft.Authorization/roleAssignments/' + assignment + '?api-version=2022-04-01');
  const p = response.body.properties as Record<string, unknown> | undefined;
  const ci = Object.values(azureCiRoleDefinitions(connection.subscriptionId, connection.resourceGroup)).map(role => role.guid);
  return response.status === 200 && String(p?.principalId).toLowerCase() === connection.deployPrincipalId.toLowerCase() && String(p?.scope).toLowerCase() === scope.toLowerCase() &&
    String(p?.roleDefinitionId).toLowerCase() === roleDefinition(connection.subscriptionId, AZURE_ROLES.roleBasedAccessControlAdministrator).toLowerCase() &&
    p?.conditionVersion === '2.0' && [[], ci].some(ids => [true, false].some(observer => p.condition === appRoleAssignmentCondition(ids, true, observer)));
}

/** Read-only: what setup would create or update in this subscription. */
export async function planAzureSetup(session: AzureSignInSession, target: AzureSetupTarget, fetchImpl: Fetch = fetch): Promise<AzureSetupPlan> {
  const { subscriptionId, tenantId } = target.subscription;
  const tokens = await tokensFor(session, tenantId, fetchImpl);
  const group = azureResourceGroupName(target.project);
  const appName = azureDeployAppName(target.project);
  const changes: AzureSetupChange[] = [];

  const unregistered: string[] = [];
  for (const namespace of requiredProviders(target.monitoringResourceProviders || target.runtimeObservation)) {
    const provider = ensure(await rest(fetchImpl, tokens.arm, 'GET', `${ARM}/subscriptions/${subscriptionId}/providers/${namespace}?api-version=2021-04-01`), `Reading ${namespace}`, [200]);
    if (provider.body.registrationState !== 'Registered') unregistered.push(namespace);
  }
  changes.push({ id: 'resource-providers', state: unregistered.length ? 'create' : 'ok',
    change: `Turn on the Azure services your app uses${unregistered.length ? ` (${unregistered.join(', ')})` : ''}` });

  const existingGroup = ensure(await rest(fetchImpl, tokens.arm, 'GET', `${ARM}${groupScope(subscriptionId, group)}?api-version=2021-04-01`), `Reading resource group ${group}`, [200, 404]);
  if (existingGroup.status === 200 && (existingGroup.body.tags as Record<string, string> | undefined)?.['managed-by'] !== 'hypervibe') {
    throw new Error(`A resource group named ${group} already exists and was not created by Hypervibe. Rename or remove it, then run setup again.`);
  }
  changes.push({ id: 'resource-group', state: existingGroup.status === 200 ? 'ok' : 'create',
    change: `Resource group ${group} in ${target.location}: holds everything Hypervibe builds for ${target.project}` });

  // The project's Key Vault exists before any plan, so outside keys can be collected first (like Parameter Store on AWS).
  const vaultName = azureProjectVaultName(subscriptionId, target.project);
  const vault = existingGroup.status === 200
    ? ensure(await rest(fetchImpl, tokens.arm, 'GET', `${ARM}${groupScope(subscriptionId, group)}/providers/Microsoft.KeyVault/vaults/${vaultName}?api-version=2023-07-01`), `Reading Key Vault ${vaultName}`, [200, 404])
    : undefined;
  changes.push({ id: 'key-vault', state: vault?.status === 200 ? 'ok' : 'create',
    change: `Key Vault ${vaultName}: your app's secrets, one name prefix per environment (free; a few cents per 10,000 reads)` });

  const app = ensure(await rest(fetchImpl, tokens.graph, 'GET', `${appUrl(appName)}?$select=id,appId`), `Reading app ${appName}`, [200, 404]);
  const appId = app.status === 200 ? String(app.body.appId) : undefined;
  const principal = appId ? ensure(await rest(fetchImpl, tokens.graph, 'GET', `${GRAPH}/servicePrincipals(appId='${appId}')?$select=id`), 'Reading the deploy identity', [200, 404]) : undefined;
  changes.push({ id: 'deploy-identity', state: principal?.status === 200 ? 'ok' : 'create',
    change: `App ${appName}: what Hypervibe deploys with, from this computer${target.repository ? ` and ${target.repository}'s GitHub Actions` : ''}` });

  if (target.repository && target.environments.length) {
    const wanted = githubSubjects(target.repository, target.environments);
    const existing = app.status === 200
      ? ((ensure(await rest(fetchImpl, tokens.graph, 'GET', `${GRAPH}/applications/${String(app.body.id)}/federatedIdentityCredentials`), 'Reading GitHub sign-in', [200]).body.value ?? []) as Array<{ subject?: string }>).map((entry) => entry.subject)
      : [];
    const missing = wanted.filter((entry) => !existing.includes(entry.subject));
    changes.push({ id: 'github-oidc', state: missing.length ? 'create' : 'ok',
      change: `GitHub sign-in for ${wanted.map((entry) => entry.subject.split(':environment:')[1]).join(', ')}, so CI deploys without stored keys` });
  }

  const scope = groupScope(subscriptionId, group);
  const ciRoles = target.repository ? Object.values(azureCiRoleDefinitions(subscriptionId, group)) : [];
  let ciRolesState: AzureSetupChange['state'] = 'ok';
  for (const role of ciRoles) {
    const observed = existingGroup.status === 200 ? ensure(await rest(fetchImpl, tokens.arm, 'GET', `${ARM}${role.id}?api-version=2022-04-01`), 'Reading fixed CI role', [200, 404]) : undefined;
    if (!observed || observed.status === 404) ciRolesState = 'create';
    else if (!sameCiRole(observed.body.properties, role.properties)) throw new Error('A fixed CI role has unexpected permissions or ownership. Preserve it and review Azure setup before continuing.');
  }
  if (ciRoles.length) changes.push({ id: 'ci-roles', state: ciRolesState,
    change: 'Two fixed CI roles: read and update existing apps/jobs; upload and run builds in the assigned registry. The deploy identity may assign these roles but cannot change their permissions.' });
  const ciRoleIds = ciRoles.map(role => role.guid);
  let withReader = target.bucketBackupReader === true;
  let withObserver = target.runtimeObservation === true;
  let grants = deployRoleGrants(ciRoleIds, withReader, withObserver);
  let rolesState: AzureSetupChange['state'] = 'create';
  if (principal?.status === 200 && existingGroup.status === 200) {
    const listed = ensure(await rest(fetchImpl, tokens.arm, 'GET', `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(`principalId eq '${String(principal.body.id)}'`)}`), 'Reading role assignments', [200]);
    const held = ((listed.body.value ?? []) as Array<{ properties?: { roleDefinitionId?: string; scope?: string; condition?: string } }>)
      .filter((entry) => entry.properties?.scope?.toLowerCase() === scope.toLowerCase());
    // Retain a previously approved ceiling when an unrelated setup request omits backup intent.
    for (const entry of held) {
      if (!entry.properties?.roleDefinitionId?.toLowerCase().endsWith(AZURE_ROLES.roleBasedAccessControlAdministrator)) continue;
      for (const ids of [[], ciRoleIds]) {
        for (const reader of [false, true]) for (const observer of [false, true]) {
          if (entry.properties.condition === appRoleAssignmentCondition(ids, reader, observer)) {
            withReader ||= reader; withObserver ||= observer;
          }
        }
      }
    }
    grants = deployRoleGrants(ciRoleIds, withReader, withObserver);
    const matches = grants.every((grant) => held.some((entry) => entry.properties?.roleDefinitionId?.toLowerCase().endsWith(grant.role)
      && (entry.properties.condition ?? undefined) === grant.condition));
    rolesState = matches ? 'ok' : 'update';
  }
  changes.push({ id: 'roles', state: rolesState,
    change: `Roles on ${group} only (none on the subscription): ${grants.map((grant) => grant.label).join('; ')}` });
  changes.push({ id: 'local-secret', state: 'create',
    change: `A client secret for ${appName}, valid one year: lets this computer deploy; stored encrypted here and never shown` });
  return {
    tenantId, subscriptionId, subscriptionName: target.subscription.displayName, location: target.location, signedInAs: session.username,
    resourceGroup: group, appName, vaultName, ...(target.monitoringResourceProviders || target.runtimeObservation ? { monitoringResourceProviders: true as const } : {}), ...(withReader ? { bucketBackupReader: true as const } : {}), ...(withObserver ? { runtimeObservation: true as const } : {}), ...(target.repository ? { repository: target.repository } : {}), environments: target.environments,
    changes, ready: changes.every((change) => change.state === 'ok'),
  };
}

export interface AzureSetupApplied {
  clientId: string;
  servicePrincipalId: string;
  resourceGroup: string;
  /** Present only when a new secret was created; the caller stores it encrypted and never prints it. */
  secret?: { value: string; expiresAt: string };
}

/**
 * Applies an approved plan. Every step is idempotent: names are fixed, existing
 * pieces are reused and role assignments have stable ids.
 */
export async function applyAzureSetup(session: AzureSignInSession, plan: AzureSetupPlan, options: { createSecret: boolean; fetchImpl?: Fetch; retryDelayMs?: number }): Promise<AzureSetupApplied> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.retryDelayMs ?? 5000;
  const tokens = await tokensFor(session, plan.tenantId, fetchImpl);
  const { subscriptionId } = plan;
  for (const namespace of requiredProviders(plan.monitoringResourceProviders)) {
    // Registration finishes in the background within minutes; plans check it before building.
    ensure(await rest(fetchImpl, tokens.arm, 'POST', `${ARM}/subscriptions/${subscriptionId}/providers/${namespace}/register?api-version=2021-04-01`), `Turning on ${namespace}`, [200, 202]);
  }
  if (plan.monitoringResourceProviders) {
    for (const namespace of monitoringProviders) {
      const url = `${ARM}/subscriptions/${subscriptionId}/providers/${namespace}?api-version=2021-04-01`;
      for (let attempt = 0; ; attempt++) {
        const response = ensure(await rest(fetchImpl, tokens.arm, 'GET', url), `Verifying ${namespace} registration`, [200]);
        if (response.body.registrationState === 'Registered') break;
        if (attempt >= 23) throw new Error(`Azure is still registering ${namespace}. Retry the same setup after registration completes.`);
        await new Promise(done => setTimeout(done, delay));
      }
    }
  }
  const scope = groupScope(subscriptionId, plan.resourceGroup);
  ensure(await rest(fetchImpl, tokens.arm, 'PUT', `${ARM}${scope}?api-version=2021-04-01`, { location: plan.location, tags: { 'managed-by': 'hypervibe' } }),
    `Creating resource group ${plan.resourceGroup}`, [200, 201]);
  ensure(await rest(fetchImpl, tokens.arm, 'PUT', `${ARM}${scope}/providers/Microsoft.KeyVault/vaults/${plan.vaultName}?api-version=2023-07-01`, {
    location: plan.location, tags: { 'managed-by': 'hypervibe' },
    properties: { tenantId: plan.tenantId, sku: { family: 'A', name: 'standard' }, enableRbacAuthorization: true, softDeleteRetentionInDays: 7, publicNetworkAccess: 'Enabled' },
  }), `Creating Key Vault ${plan.vaultName}`, [200, 201]);

  ensure(await rest(fetchImpl, tokens.graph, 'PATCH', appUrl(plan.appName), {
    displayName: plan.appName, signInAudience: 'AzureADMyOrg', tags: ['hypervibe'],
    notes: `Hypervibe deploys ${plan.resourceGroup} with this identity. Created by Hypervibe setup (${AZURE_SETUP_VERSION}).`,
  }, { Prefer: 'create-if-missing' }), `Creating app ${plan.appName}`, [200, 201, 204]);
  const app = ensure(await rest(fetchImpl, tokens.graph, 'GET', `${appUrl(plan.appName)}?$select=id,appId`), `Reading app ${plan.appName}`, [200]);
  const appObjectId = String(app.body.id);
  const clientId = String(app.body.appId);
  let principal = await rest(fetchImpl, tokens.graph, 'GET', `${GRAPH}/servicePrincipals(appId='${clientId}')?$select=id`);
  if (principal.status === 404) {
    principal = ensure(await rest(fetchImpl, tokens.graph, 'POST', `${GRAPH}/servicePrincipals`, { appId: clientId, tags: ['hypervibe'] }), 'Creating the deploy identity', [201]);
  }
  ensure(principal, 'Reading the deploy identity', [200, 201]);
  const servicePrincipalId = String(principal.body.id);

  if (plan.repository && plan.environments.length) {
    const existing = ((ensure(await rest(fetchImpl, tokens.graph, 'GET', `${GRAPH}/applications/${appObjectId}/federatedIdentityCredentials`), 'Reading GitHub sign-in', [200]).body.value ?? []) as Array<{ subject?: string }>).map((entry) => entry.subject);
    for (const entry of githubSubjects(plan.repository, plan.environments).filter((wanted) => !existing.includes(wanted.subject))) {
      ensure(await rest(fetchImpl, tokens.graph, 'POST', `${GRAPH}/applications/${appObjectId}/federatedIdentityCredentials`, {
        name: entry.name, issuer: GITHUB_ISSUER, subject: entry.subject, audiences: ['api://AzureADTokenExchange'], description: 'Hypervibe: GitHub Actions deploys',
      }), `Adding GitHub sign-in for ${entry.subject}`, [201]);
    }
  }

  const ciRoles = plan.repository ? Object.values(azureCiRoleDefinitions(subscriptionId, plan.resourceGroup)) : [];
  for (const role of ciRoles) {
    const observed = ensure(await rest(fetchImpl, tokens.arm, 'GET', `${ARM}${role.id}?api-version=2022-04-01`), 'Reading fixed CI role', [200, 404]);
    if (observed.status === 200) {
      if (!sameCiRole(observed.body.properties, role.properties)) throw new Error('The reviewed fixed CI role changed; no role assignment was granted. Review Azure setup again.');
    } else {
      ensure(await rest(fetchImpl, tokens.arm, 'PUT', `${ARM}${scope}/providers/Microsoft.Authorization/roleDefinitions/${role.guid}?api-version=2022-04-01`, { properties: role.properties }), 'Creating the reviewed fixed CI role', [200, 201]);
      const verified = ensure(await rest(fetchImpl, tokens.arm, 'GET', `${ARM}${role.id}?api-version=2022-04-01`), 'Verifying the fixed CI role', [200]);
      if (!sameCiRole(verified.body.properties, role.properties)) throw new Error('The new CI role permissions could not be verified; no dependent assignment was granted.');
    }
  }
  for (const grant of deployRoleGrants(ciRoles.map((role) => role.guid), plan.bucketBackupReader, plan.runtimeObservation)) {
    const url = `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments/${roleAssignmentName(scope, servicePrincipalId, grant.role)}?api-version=2022-04-01`;
    const body = { properties: {
      roleDefinitionId: roleDefinition(subscriptionId, grant.role), principalId: servicePrincipalId, principalType: 'ServicePrincipal',
      description: 'Hypervibe deploy access', ...(grant.condition ? { condition: grant.condition, conditionVersion: '2.0' } : {}),
    } };
    // A new service principal can take a minute to reach Resource Manager.
    for (let attempt = 0; ; attempt++) {
      const result = await rest(fetchImpl, tokens.arm, 'PUT', url, body);
      if ([200, 201].includes(result.status) || (result.body.error as { code?: string } | undefined)?.code === 'RoleAssignmentExists') break;
      if (attempt < 11 && (result.body.error as { code?: string } | undefined)?.code === 'PrincipalNotFound') { await new Promise((done) => setTimeout(done, delay)); continue; }
      ensure(result, `Granting ${grant.label.split(' (')[0]}`, [200, 201]);
    }
    // A successful PUT or conflict does not prove the exact requested grant.
    const verified = ensure(await rest(fetchImpl, tokens.arm, 'GET', url), 'Verifying the exact role assignment', [200]);
    const fields = responseFields('Azure role assignment verification');
    if (!verified.body || typeof verified.body !== 'object' || Array.isArray(verified.body)) {
      fields.reject('response body', 'must be an object');
    }
    fields.exact('id', verified.body.id, url.slice(ARM.length).split('?')[0]!, true);
    const properties = verified.body.properties as Record<string, unknown> | undefined;
    fields.exact('properties.principalId', properties?.principalId, servicePrincipalId, true);
    fields.oneOf('properties.principalType', properties?.principalType, ['ServicePrincipal']);
    fields.exact('properties.scope', properties?.scope, scope, true);
    fields.exact('properties.roleDefinitionId', properties?.roleDefinitionId, roleDefinition(subscriptionId, grant.role), true);
    if (grant.condition) {
      fields.exact('properties.condition', properties?.condition, grant.condition);
      fields.oneOf('properties.conditionVersion', properties?.conditionVersion, ['2.0']);
    } else if (properties?.condition != null) {
      fields.reject('properties.condition', 'must be absent for this assignment');
    }
  }

  if (!options.createSecret) return { clientId, servicePrincipalId, resourceGroup: plan.resourceGroup };
  const endDateTime = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const created = ensure(await rest(fetchImpl, tokens.graph, 'POST', `${GRAPH}/applications/${appObjectId}/addPassword`, {
    passwordCredential: { displayName: `hypervibe-local ${os.hostname()}`.slice(0, 100), endDateTime },
  }), 'Creating the local client secret', [200]);
  const value = String(created.body.secretText ?? '');
  if (!value) throw new Error('Microsoft did not return the new client secret.');
  return { clientId, servicePrincipalId, resourceGroup: plan.resourceGroup, secret: { value, expiresAt: String(created.body.endDateTime ?? endDateTime) } };
}
