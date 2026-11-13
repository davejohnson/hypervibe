import crypto from 'crypto';
import os from 'os';
import { azureProjectVaultName } from '../adapters/providers/azure/tofu/azure-engine.config.js';
import { ARM_SCOPE, GRAPH_SCOPE, azureTokenFor, type AzureSignInSession } from './azure-sign-in.js';

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
export const AZURE_SETUP_VERSION = 'azure-v1';
const ARM = 'https://management.azure.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
/** Resource providers the engine uses; registering them is free and needs the subscription Owner, so setup does it. */
export const AZURE_RESOURCE_PROVIDERS = ['Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.DBforPostgreSQL', 'Microsoft.KeyVault',
  'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights', 'Microsoft.Storage'] as const;

/** Built-in role ids (identical in every tenant). */
export const AZURE_ROLES = {
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7',
  roleBasedAccessControlAdministrator: 'f58310d9-a9f6-439a-9e8d-f62e7b41a168',
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d',
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6',
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
export function appRoleAssignmentCondition(): string {
  const roles = AZURE_APP_ROLES.join(', ');
  const constrain = (source: 'Request' | 'Resource') =>
    `@${source}[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${roles}} AND @${source}[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}`;
  return `((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (${constrain('Request')})) AND ((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR (${constrain('Resource')}))`;
}

export interface AzureRoleGrant { role: string; label: string; condition?: string }

/** Every role the deploy identity holds, all on the project's resource group. */
export function deployRoleGrants(): AzureRoleGrant[] {
  return [
    { role: AZURE_ROLES.contributor, label: 'Contributor' },
    { role: AZURE_ROLES.keyVaultSecretsOfficer, label: 'Key Vault Secrets Officer' },
    // Teardown empties storage before deleting it; accounts have no shared keys.
    { role: AZURE_ROLES.storageBlobDataContributor, label: 'Storage Blob Data Contributor' },
    { role: AZURE_ROLES.roleBasedAccessControlAdministrator, label: 'Role Based Access Control Administrator (only AcrPull, Key Vault Secrets User and Storage Blob Data Contributor, only for service principals)', condition: appRoleAssignmentCondition() },
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

/** Read-only: what setup would create or update in this subscription. */
export async function planAzureSetup(session: AzureSignInSession, target: AzureSetupTarget, fetchImpl: Fetch = fetch): Promise<AzureSetupPlan> {
  const { subscriptionId, tenantId } = target.subscription;
  const tokens = await tokensFor(session, tenantId, fetchImpl);
  const group = azureResourceGroupName(target.project);
  const appName = azureDeployAppName(target.project);
  const changes: AzureSetupChange[] = [];

  const unregistered: string[] = [];
  for (const namespace of AZURE_RESOURCE_PROVIDERS) {
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
  let rolesState: AzureSetupChange['state'] = 'create';
  if (principal?.status === 200 && existingGroup.status === 200) {
    const listed = ensure(await rest(fetchImpl, tokens.arm, 'GET', `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(`principalId eq '${String(principal.body.id)}'`)}`), 'Reading role assignments', [200]);
    const held = ((listed.body.value ?? []) as Array<{ properties?: { roleDefinitionId?: string; scope?: string; condition?: string } }>)
      .filter((entry) => entry.properties?.scope?.toLowerCase() === scope.toLowerCase());
    const matches = deployRoleGrants().every((grant) => held.some((entry) => entry.properties?.roleDefinitionId?.toLowerCase().endsWith(grant.role)
      && (entry.properties.condition ?? undefined) === grant.condition));
    rolesState = matches ? 'ok' : 'update';
  }
  changes.push({ id: 'roles', state: rolesState,
    change: `Roles on ${group} only (none on the subscription): ${deployRoleGrants().map((grant) => grant.label).join('; ')}` });
  changes.push({ id: 'local-secret', state: 'create',
    change: `A client secret for ${appName}, valid one year: lets this computer deploy; stored encrypted here and never shown` });
  return {
    tenantId, subscriptionId, subscriptionName: target.subscription.displayName, location: target.location, signedInAs: session.username,
    resourceGroup: group, appName, vaultName, ...(target.repository ? { repository: target.repository } : {}), environments: target.environments,
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
  for (const namespace of AZURE_RESOURCE_PROVIDERS) {
    // Registration finishes in the background within minutes; plans check it before building.
    ensure(await rest(fetchImpl, tokens.arm, 'POST', `${ARM}/subscriptions/${subscriptionId}/providers/${namespace}/register?api-version=2021-04-01`), `Turning on ${namespace}`, [200, 202]);
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

  for (const grant of deployRoleGrants()) {
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
