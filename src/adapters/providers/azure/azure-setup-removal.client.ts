import { azureCiRoleDefinitions } from './azure-ci-roles.js';
import { ARM_SCOPE, GRAPH_SCOPE, azureTokenFor, type AzureSignInSession } from './azure-entra.client.js';

/**
 * Reads and deletes what one-time Azure setup (azure-setup.client.ts) created
 * for a project. Used only by setup removal, with the same owner sign-in setup
 * used. Every read answers present, absent or unknown: only a 200 is present,
 * only Azure's own "not found" is absent, and anything else is unknown.
 */
const ARM = 'https://management.azure.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const ARM_NOT_FOUND = ['ResourceGroupNotFound', 'ResourceNotFound'];
const GRAPH_NOT_FOUND = ['Request_ResourceNotFound'];

type Fetch = typeof fetch;
interface Answer { status: number; body: Record<string, unknown> }

export interface AzureSetupRemovalTarget {
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  vaultName: string;
  appName: string;
  /** The deploy app's appId and its service principal's object id, as setup saved them. */
  clientId: string;
  servicePrincipalId: string;
}
export interface AzureRemovalTokens { arm: string; graph: string }
export interface AzureRemovalWait { sleep: (milliseconds: number) => Promise<void>; delayMs?: number }

export interface AzureSetupFound {
  /** `not-ours`: a group with the expected name that lacks the tag setup applies. */
  group: 'absent' | 'ours' | 'not-ours';
  /** Everything in the group other than the project Key Vault setup created. */
  otherResources: string[];
  vault?: { purgeProtected: boolean; retentionDays: number };
  /** The project vault after deletion, while Azure still keeps it. */
  deletedVault?: { purgeProtected: boolean; location: string; scheduledPurgeDate?: string };
  /** Ids of the deploy identity's role assignments on the group or inside it. */
  identityAssignments: string[];
  /** Scopes outside the group where the deploy identity holds a role; setup never grants these. */
  identityAssignmentsElsewhere: string[];
  /** Roles on the group held by anyone other than the deploy identity. */
  otherGroupAssignments: string[];
  ciRoles: Array<{ guid: string; name: string; ours: boolean }>;
  /** The app registration with the saved appId. `ours`: it has the name and tag setup gave it. */
  application?: { objectId: string; ours: boolean };
  /** appId of a different app registration that has the expected name. */
  sameNameApplication?: string;
  servicePrincipal: 'absent' | 'ours' | 'not-ours';
}
export type AzureSetupObservation = ({ state: 'known' } & AzureSetupFound) | { state: 'unknown'; reason: string };
export type AzureRemovalOutcome = { state: 'removed'; kept?: true } | { state: 'failed'; reason: string } | { state: 'unconfirmed'; reason: string };

const same = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
const groupScope = (target: Pick<AzureSetupRemovalTarget, 'subscriptionId' | 'resourceGroup'>) => `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`;
const vaultId = (target: AzureSetupRemovalTarget) => `${groupScope(target)}/providers/Microsoft.KeyVault/vaults/${target.vaultName}`;

/** Tokens for the directory setup ran in, from the sign-in; in memory only. */
export async function azureRemovalTokens(session: AzureSignInSession, tenantId: string, fetchImpl: Fetch = fetch): Promise<AzureRemovalTokens> {
  return {
    arm: tenantId === session.tenantId ? session.accessToken : await azureTokenFor(session, { tenantId, scope: ARM_SCOPE }, fetchImpl),
    graph: await azureTokenFor(session, { tenantId, scope: GRAPH_SCOPE }, fetchImpl),
  };
}

async function send(fetchImpl: Fetch, token: string, method: string, url: string): Promise<Answer | undefined> {
  try {
    const response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* an unreadable body carries no fields, so it never reads as present */ }
    return { status: response.status, body };
  } catch { return undefined; }
}

/** Status and Azure's error code only: provider messages and tokens never reach output. */
function describe(answer: Answer | undefined): string {
  if (!answer) return 'no answer';
  const code = codeOf(answer);
  return `HTTP ${answer.status}${code ? ` ${code}` : ''}`;
}
function codeOf(answer: Answer): string | undefined {
  const code = (answer.body.error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(code) ? code : undefined;
}

type Read = { is: 'present'; body: Record<string, unknown> } | { is: 'absent' } | { is: 'unknown'; reason: string };
async function read(fetchImpl: Fetch, token: string, url: string, what: string, notFound: string[]): Promise<Read> {
  const answer = await send(fetchImpl, token, 'GET', url);
  if (answer?.status === 200) return { is: 'present', body: answer.body };
  if (answer?.status === 404 && notFound.includes(codeOf(answer) ?? '')) return { is: 'absent' };
  return { is: 'unknown', reason: `Reading ${what} did not give a clear answer (${describe(answer)}).` };
}

/** A whole Resource Manager list, following every `nextLink`. A page that fails makes the list unknown, never shorter. */
async function list(fetchImpl: Fetch, token: string, url: string, what: string): Promise<{ entries: Array<Record<string, unknown>> } | { reason: string }> {
  const entries: Array<Record<string, unknown>> = [];
  let next: string | undefined = url;
  for (let page = 0; next; page++) {
    if (page >= 50 || !next.startsWith(`${ARM}/`)) return { reason: `Azure's list of ${what} was incomplete.` };
    const answer = await send(fetchImpl, token, 'GET', next);
    if (answer?.status !== 200 || !Array.isArray(answer.body.value)) return { reason: `Listing ${what} did not give a clear answer (${describe(answer)}).` };
    for (const entry of answer.body.value) {
      if (!entry || typeof entry !== 'object') return { reason: `Azure's list of ${what} was not readable.` };
      entries.push(entry as Record<string, unknown>);
    }
    const link: unknown = answer.body.nextLink;
    if (link != null && typeof link !== 'string') return { reason: `Azure's list of ${what} was incomplete.` };
    next = link || undefined;
  }
  return { entries };
}

const groupUrl = (target: AzureSetupRemovalTarget) => `${ARM}${groupScope(target)}?api-version=2021-04-01`;
const vaultUrl = (target: AzureSetupRemovalTarget) => `${ARM}${vaultId(target)}?api-version=2023-07-01`;

async function readDeletedVault(fetchImpl: Fetch, token: string, target: AzureSetupRemovalTarget): Promise<{ is: 'present'; vault: NonNullable<AzureSetupFound['deletedVault']> } | { is: 'absent' } | { is: 'unknown'; reason: string }> {
  const listed = await list(fetchImpl, token, `${ARM}/subscriptions/${target.subscriptionId}/providers/Microsoft.KeyVault/deletedVaults?api-version=2023-07-01`, 'deleted Key Vaults');
  if ('reason' in listed) return { is: 'unknown', reason: listed.reason };
  // Only the vault that lived in this project's group; the same name deleted from another group is not setup's.
  const entry = listed.entries.find((candidate) => same((candidate.properties as { vaultId?: unknown } | undefined)?.vaultId, vaultId(target)));
  if (!entry) return { is: 'absent' };
  const properties = entry.properties as { location?: unknown; scheduledPurgeDate?: unknown; purgeProtectionEnabled?: unknown; tags?: Record<string, unknown> };
  // A deleted vault keeps its tags. One without Hypervibe's tag is not known to be setup's, and a purge cannot be undone.
  if (properties.tags?.['managed-by'] !== 'hypervibe') return { is: 'unknown', reason: `A deleted Key Vault named ${target.vaultName} does not carry Hypervibe's tag, so Hypervibe will not purge it.` };
  if (typeof properties.location !== 'string' || !/^[a-z0-9]{3,40}$/i.test(properties.location)) return { is: 'unknown', reason: 'Azure listed the deleted Key Vault without its region.' };
  return { is: 'present', vault: { purgeProtected: properties.purgeProtectionEnabled === true, location: properties.location,
    ...(typeof properties.scheduledPurgeDate === 'string' ? { scheduledPurgeDate: properties.scheduledPurgeDate } : {}) } };
}

/** Read-only: everything setup created for the project, and anything that now depends on it. */
export async function readAzureSetup(fetchImpl: Fetch, tokens: AzureRemovalTokens, target: AzureSetupRemovalTarget): Promise<AzureSetupObservation> {
  const unknown = (reason: string): AzureSetupObservation => ({ state: 'unknown', reason });
  const scope = groupScope(target);
  const found: AzureSetupFound = { group: 'absent', otherResources: [], identityAssignments: [], identityAssignmentsElsewhere: [], otherGroupAssignments: [], ciRoles: [], servicePrincipal: 'absent' };

  // A sign-in that cannot see the subscription would make every later "not found" meaningless.
  const subscription = await read(fetchImpl, tokens.arm, `${ARM}/subscriptions/${target.subscriptionId}?api-version=2022-12-01`, `subscription ${target.subscriptionId}`, []);
  if (subscription.is !== 'present' || !same(subscription.body.subscriptionId, target.subscriptionId)) {
    return unknown(subscription.is === 'unknown' ? subscription.reason : `Azure did not confirm subscription ${target.subscriptionId} for this sign-in.`);
  }

  const group = await read(fetchImpl, tokens.arm, groupUrl(target), `resource group ${target.resourceGroup}`, ['ResourceGroupNotFound']);
  if (group.is === 'unknown') return unknown(group.reason);
  if (group.is === 'present') {
    if (!same(group.body.id, scope)) return unknown(`Azure answered for a different resource group than ${target.resourceGroup}.`);
    found.group = (group.body.tags as Record<string, unknown> | undefined)?.['managed-by'] === 'hypervibe' ? 'ours' : 'not-ours';
  }

  if (found.group === 'ours') {
    const vault = await read(fetchImpl, tokens.arm, vaultUrl(target), `Key Vault ${target.vaultName}`, ARM_NOT_FOUND);
    if (vault.is === 'unknown') return unknown(vault.reason);
    const vaultIsOurs = vault.is === 'present' && same(vault.body.id, vaultId(target)) && (vault.body.tags as Record<string, unknown> | undefined)?.['managed-by'] === 'hypervibe';
    if (vault.is === 'present' && vaultIsOurs) {
      const properties = (vault.body.properties ?? {}) as { enablePurgeProtection?: unknown; softDeleteRetentionInDays?: unknown };
      // Azure keeps a deleted vault 90 days unless the vault says otherwise.
      found.vault = { purgeProtected: properties.enablePurgeProtection === true, retentionDays: typeof properties.softDeleteRetentionInDays === 'number' ? properties.softDeleteRetentionInDays : 90 };
    }
    const resources = await list(fetchImpl, tokens.arm, `${ARM}${scope}/resources?api-version=2021-04-01`, `what is in ${target.resourceGroup}`);
    if ('reason' in resources) return unknown(resources.reason);
    for (const resource of resources.entries) {
      if (typeof resource.id !== 'string' || typeof resource.type !== 'string' || typeof resource.name !== 'string') return unknown(`Azure listed something in ${target.resourceGroup} without a name.`);
      if (!(vaultIsOurs && same(resource.id, vaultId(target)))) found.otherResources.push(`${resource.type} ${resource.name}`);
    }
    const onGroup = await list(fetchImpl, tokens.arm, `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent('atScope()')}`, `role assignments on ${target.resourceGroup}`);
    if ('reason' in onGroup) return unknown(onGroup.reason);
    for (const entry of onGroup.entries) {
      const properties = (entry.properties ?? {}) as { scope?: unknown; principalId?: unknown; principalType?: unknown; roleDefinitionId?: unknown };
      if (typeof properties.scope !== 'string' || typeof properties.principalId !== 'string' || typeof properties.roleDefinitionId !== 'string') return unknown(`Azure listed a role assignment on ${target.resourceGroup} without its details.`);
      // The list also carries roles inherited from the subscription; those are not on the group.
      if (same(properties.scope, scope) && !same(properties.principalId, target.servicePrincipalId)) {
        found.otherGroupAssignments.push(`${typeof properties.principalType === 'string' ? properties.principalType : 'principal'} ${properties.principalId} (role ${properties.roleDefinitionId.split('/').at(-1)})`);
      }
    }
  }

  const held = await list(fetchImpl, tokens.arm, `${ARM}/subscriptions/${target.subscriptionId}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${encodeURIComponent(`principalId eq '${target.servicePrincipalId}'`)}`, 'the deploy identity\'s role assignments');
  if ('reason' in held) return unknown(held.reason);
  for (const entry of held.entries) {
    const properties = (entry.properties ?? {}) as { scope?: unknown; principalId?: unknown };
    if (typeof entry.id !== 'string' || typeof properties.scope !== 'string' || typeof properties.principalId !== 'string') return unknown('Azure listed a role assignment of the deploy identity without its details.');
    if (!same(properties.principalId, target.servicePrincipalId)) continue;
    const at = properties.scope.toLowerCase();
    if (at !== scope.toLowerCase() && !at.startsWith(`${scope.toLowerCase()}/`)) { found.identityAssignmentsElsewhere.push(properties.scope); continue; }
    if (!/^\/subscriptions\/[^?#\s]+\/providers\/Microsoft\.Authorization\/roleAssignments\/[0-9a-f-]{36}$/i.test(entry.id) || !entry.id.toLowerCase().startsWith(`${scope.toLowerCase()}/`)) return unknown('Azure listed a role assignment of the deploy identity with an unexpected id.');
    found.identityAssignments.push(entry.id);
  }
  found.identityAssignments.sort();

  for (const role of Object.values(azureCiRoleDefinitions(target.subscriptionId, target.resourceGroup))) {
    const observed = await read(fetchImpl, tokens.arm, `${ARM}${role.id}?api-version=2022-04-01`, `role ${role.properties.roleName}`, ['RoleDefinitionDoesNotExist']);
    if (observed.is === 'unknown') return unknown(observed.reason);
    if (observed.is === 'absent') continue;
    const properties = (observed.body.properties ?? {}) as { roleName?: unknown; type?: unknown; assignableScopes?: unknown };
    const scopes = Array.isArray(properties.assignableScopes) ? properties.assignableScopes : [];
    found.ciRoles.push({ guid: role.guid, name: role.properties.roleName,
      ours: properties.roleName === role.properties.roleName && properties.type === 'CustomRole' && scopes.length === 1 && same(scopes[0], scope) });
  }

  const deleted = await readDeletedVault(fetchImpl, tokens.arm, target);
  if (deleted.is === 'unknown') return unknown(deleted.reason);
  if (deleted.is === 'present') found.deletedVault = deleted.vault;

  const application = await read(fetchImpl, tokens.graph, `${GRAPH}/applications(appId='${target.clientId}')?$select=id,appId,uniqueName,tags`, `app registration ${target.appName}`, GRAPH_NOT_FOUND);
  if (application.is === 'unknown') return unknown(application.reason);
  if (application.is === 'present') {
    if (typeof application.body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(application.body.id) || !same(application.body.appId, target.clientId)) return unknown(`Microsoft answered for a different app registration than ${target.appName}.`);
    found.application = { objectId: application.body.id,
      ours: application.body.uniqueName === target.appName && Array.isArray(application.body.tags) && application.body.tags.includes('hypervibe') };
  } else {
    const named = await read(fetchImpl, tokens.graph, `${GRAPH}/applications(uniqueName='${encodeURIComponent(target.appName)}')?$select=id,appId`, `app registration ${target.appName}`, GRAPH_NOT_FOUND);
    if (named.is === 'unknown') return unknown(named.reason);
    if (named.is === 'present') found.sameNameApplication = String(named.body.appId ?? 'unknown id');
  }
  const principal = await read(fetchImpl, tokens.graph, `${GRAPH}/servicePrincipals/${target.servicePrincipalId}?$select=id,appId`, 'the deploy identity', GRAPH_NOT_FOUND);
  if (principal.is === 'unknown') return unknown(principal.reason);
  if (principal.is === 'present') found.servicePrincipal = same(principal.body.id, target.servicePrincipalId) && same(principal.body.appId, target.clientId) ? 'ours' : 'not-ours';
  return { state: 'known', ...found };
}

/**
 * The delete was sent; this reads until Azure confirms the thing is gone. A refused
 * delete is a failure, and an accepted or unanswered one that never reads as gone
 * is unconfirmed: neither is reported as removed.
 */
async function settle(answer: Answer | undefined, accepted: number[], gone: () => Promise<'present' | 'absent' | 'unknown'>, wait: AzureRemovalWait, attempts: number, what: string): Promise<AzureRemovalOutcome> {
  let now = await gone();
  if (answer !== undefined && !accepted.includes(answer.status)) {
    return now === 'absent' ? { state: 'removed' } : { state: 'failed', reason: `Azure did not delete ${what} (${describe(answer)}).` };
  }
  for (let attempt = 0; now !== 'absent' && attempt < attempts; attempt++) {
    await wait.sleep(wait.delayMs ?? 5000);
    now = await gone();
  }
  return now === 'absent' ? { state: 'removed' } : { state: 'unconfirmed', reason: `Hypervibe asked Azure to delete ${what} but could not confirm it is gone.` };
}

/** Role Assignments - Delete, one per id, each read again afterwards. */
export async function deleteAzureRoleAssignments(fetchImpl: Fetch, tokens: AzureRemovalTokens, ids: string[], wait: AzureRemovalWait): Promise<AzureRemovalOutcome> {
  for (const id of ids) {
    const url = `${ARM}${id}?api-version=2022-04-01`;
    const outcome = await settle(await send(fetchImpl, tokens.arm, 'DELETE', url), [200, 204],
      async () => (await read(fetchImpl, tokens.arm, url, 'a role assignment', ['RoleAssignmentNotFound'])).is, wait, 10, 'a role assignment of the deploy identity');
    if (outcome.state !== 'removed') return outcome;
  }
  return { state: 'removed' };
}

/** Role Definitions - Delete for the fixed CI roles. Azure refuses while anything is still assigned one. */
export async function deleteAzureCiRoles(fetchImpl: Fetch, tokens: AzureRemovalTokens, target: AzureSetupRemovalTarget, guids: string[], groupExists: boolean, wait: AzureRemovalWait): Promise<AzureRemovalOutcome> {
  for (const role of Object.values(azureCiRoleDefinitions(target.subscriptionId, target.resourceGroup)).filter((candidate) => guids.includes(candidate.guid))) {
    const scope = groupExists ? groupScope(target) : `/subscriptions/${target.subscriptionId}`;
    const answer = await send(fetchImpl, tokens.arm, 'DELETE', `${ARM}${scope}/providers/Microsoft.Authorization/roleDefinitions/${role.guid}?api-version=2022-04-01`);
    const outcome = await settle(answer, [200, 204],
      async () => (await read(fetchImpl, tokens.arm, `${ARM}${role.id}?api-version=2022-04-01`, 'a role', ['RoleDefinitionDoesNotExist'])).is, wait, 10, `role ${role.properties.roleName}`);
    if (outcome.state !== 'removed') return outcome;
  }
  return { state: 'removed' };
}

/** Vaults - Delete. Azure keeps the vault soft-deleted afterwards. */
export async function deleteAzureProjectVault(fetchImpl: Fetch, tokens: AzureRemovalTokens, target: AzureSetupRemovalTarget, wait: AzureRemovalWait): Promise<AzureRemovalOutcome> {
  return settle(await send(fetchImpl, tokens.arm, 'DELETE', vaultUrl(target)), [200, 204],
    async () => (await read(fetchImpl, tokens.arm, vaultUrl(target), 'the Key Vault', ARM_NOT_FOUND)).is, wait, 20, `Key Vault ${target.vaultName}`);
}

/** Vaults - Purge Deleted: permanent. Polled until the vault leaves Azure's list of deleted vaults. */
export async function purgeAzureProjectVault(fetchImpl: Fetch, tokens: AzureRemovalTokens, target: AzureSetupRemovalTarget, wait: AzureRemovalWait, justDeleted = false): Promise<AzureRemovalOutcome> {
  let deleted = await readDeletedVault(fetchImpl, tokens.arm, target);
  // A vault deleted a moment ago may not be listed yet; "not listed" proves nothing until it has shown up.
  for (let attempt = 0; justDeleted && deleted.is === 'absent' && attempt < 10; attempt++) {
    await wait.sleep(wait.delayMs ?? 5000);
    deleted = await readDeletedVault(fetchImpl, tokens.arm, target);
  }
  if (deleted.is === 'absent') return justDeleted ? { state: 'unconfirmed', reason: `Azure does not list the deleted Key Vault ${target.vaultName} yet, so it could not be purged.` } : { state: 'removed' };
  if (deleted.is === 'unknown') return { state: 'failed', reason: deleted.reason };
  if (deleted.vault.purgeProtected) return { state: 'failed', reason: `Key Vault ${target.vaultName} has purge protection, so Azure will not purge it.` };
  const answer = await send(fetchImpl, tokens.arm, 'POST', `${ARM}/subscriptions/${target.subscriptionId}/providers/Microsoft.KeyVault/locations/${deleted.vault.location}/deletedVaults/${target.vaultName}/purge?api-version=2023-07-01`);
  return settle(answer, [200, 202], async () => (await readDeletedVault(fetchImpl, tokens.arm, target)).is, wait, 60, `the deleted Key Vault ${target.vaultName} for good`);
}

/** What is in the group right now, for the last check before the group is deleted. */
export async function readAzureGroupContents(fetchImpl: Fetch, tokens: AzureRemovalTokens, target: AzureSetupRemovalTarget): Promise<{ contents: string[] } | { reason: string }> {
  const resources = await list(fetchImpl, tokens.arm, `${ARM}${groupScope(target)}/resources?api-version=2021-04-01`, `what is in ${target.resourceGroup}`);
  if ('reason' in resources) return resources;
  return { contents: resources.entries.map((resource) => `${String(resource.type)} ${String(resource.name)}`) };
}

/** Resource Groups - Delete: long-running, polled until Azure says the group is not found (up to ten minutes). */
export async function deleteAzureResourceGroup(fetchImpl: Fetch, tokens: AzureRemovalTokens, target: AzureSetupRemovalTarget, wait: AzureRemovalWait): Promise<AzureRemovalOutcome> {
  return settle(await send(fetchImpl, tokens.arm, 'DELETE', groupUrl(target)), [200, 202],
    async () => (await read(fetchImpl, tokens.arm, groupUrl(target), 'the resource group', ['ResourceGroupNotFound'])).is, wait, 120, `resource group ${target.resourceGroup}`);
}

/**
 * Deletes an app registration or service principal, then removes it from
 * Microsoft's 30-day deleted items. `kept`: deleted, but still in deleted items.
 */
export async function deleteAzureDirectoryObject(fetchImpl: Fetch, tokens: AzureRemovalTokens, kind: 'applications' | 'servicePrincipals', objectId: string, what: string, wait: AzureRemovalWait): Promise<AzureRemovalOutcome> {
  const url = `${GRAPH}/${kind}/${objectId}`;
  const deleted = await settle(await send(fetchImpl, tokens.graph, 'DELETE', url), [204],
    async () => (await read(fetchImpl, tokens.graph, `${url}?$select=id`, what, GRAPH_NOT_FOUND)).is, wait, 20, what);
  if (deleted.state !== 'removed') return deleted;
  const kept = `${GRAPH}/directory/deletedItems/${objectId}`;
  const purged = await settle(await send(fetchImpl, tokens.graph, 'DELETE', kept), [204],
    async () => (await read(fetchImpl, tokens.graph, `${kept}?$select=id`, what, GRAPH_NOT_FOUND)).is, wait, 10, what);
  return purged.state === 'removed' ? { state: 'removed' } : { state: 'removed', kept: true };
}
