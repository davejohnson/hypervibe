import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environments: Array<{ name: string; platformBindings: Record<string, unknown> }> = [];
const connections: Array<{ id: string; provider: string; scope: string; credentialsEncrypted: string }> = [];
const audits: Array<{ action: string }> = [];
vi.mock('../../adapters/db/repositories/environment.repository.js', () => ({ EnvironmentRepository: class { findByProjectId() { return environments; } } }));
vi.mock('../../adapters/db/repositories/project.repository.js', () => ({ ProjectRepository: class { findAll() { return [{ id: 'p1', name: 'demo' }]; } } }));
vi.mock('../../adapters/db/repositories/connection.repository.js', () => ({ ConnectionRepository: class {
  findAllByProvider(provider: string) { return connections.filter((entry) => entry.provider === provider); }
  delete(id: string) { const index = connections.findIndex((entry) => entry.id === id); if (index < 0) return false; connections.splice(index, 1); return true; }
} }));
vi.mock('../../adapters/db/repositories/audit.repository.js', () => ({ AuditRepository: class { create(entry: { action: string }) { audits.push(entry); } } }));
vi.mock('../../adapters/secrets/secret-store.js', () => ({ getSecretStore: () => ({ decryptObject: (value: string) => JSON.parse(value) }) }));

const { runAzureSetupRemoval } = await import('../azure-setup-removal.js');
const { azureProjectVaultName } = await import('../../adapters/providers/azure/tofu/azure-engine.config.js');
const { azureCiRoleDefinitions } = await import('../../adapters/providers/azure/azure-ci-roles.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const APP_OBJECT = '55555555-5555-4555-8555-555555555555';
const GROUP = 'hv-demo';
const APP = 'hypervibe-deploy-demo';
const VAULT = azureProjectVaultName(SUB, 'demo');
const SCOPE = `/subscriptions/${SUB}/resourceGroups/${GROUP}`;
const VAULT_ID = `${SCOPE}/providers/Microsoft.KeyVault/vaults/${VAULT}`;
const CI_ROLES = Object.values(azureCiRoleDefinitions(SUB, GROUP));
const CLIENT_SECRET = 'client-secret-value-never-shown';
const project = { id: 'p1', name: 'demo' } as never;
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const notFound = (code: string) => json(404, { error: { code, message: 'not found' } });

interface Assignment { id: string; principalId: string; scope: string; role: string }
interface Azure {
  group?: { tags: Record<string, string>; deleting?: number };
  /** Things in the group besides the project vault. */
  resources: Array<{ name: string; type: string }>;
  vault?: { tags: Record<string, string>; purgeProtection?: boolean };
  deletedVault?: { purgeProtection: boolean; purging?: number };
  assignments: Assignment[];
  roles: Map<string, { roleName: string }>;
  app?: { id: string; appId: string; uniqueName: string; tags: string[] };
  principal?: { id: string; appId: string };
  deletedItems: Set<string>;
  /** Every changing request, in order. */
  changes: string[];
  /** Answers a request instead of the fake when it returns a response. */
  intercept?: (method: string, target: string) => Response | undefined;
}
const assignment = (name: string, principalId = PRINCIPAL, scope = SCOPE, role = 'b24988ac-6180-42a0-ab88-20f7382dd24c'): Assignment =>
  ({ id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${name.repeat(8)}-${name.repeat(4)}-4${name.repeat(3)}-8${name.repeat(3)}-${name.repeat(12)}`, principalId, scope, role });
function azure(overrides: Partial<Azure> = {}): Azure {
  return {
    group: { tags: { 'managed-by': 'hypervibe' } }, resources: [], vault: { tags: { 'managed-by': 'hypervibe' } },
    assignments: [assignment('a'), assignment('b')], roles: new Map(CI_ROLES.map((role) => [role.guid, { roleName: role.properties.roleName }])),
    app: { id: APP_OBJECT, appId: CLIENT, uniqueName: APP, tags: ['hypervibe'] }, principal: { id: PRINCIPAL, appId: CLIENT },
    deletedItems: new Set(), changes: [], ...overrides,
  };
}

/**
 * A stand-in for Azure. Statuses and bodies follow Microsoft's REST reference for
 * the operation named beside each branch, not Hypervibe's own setup code.
 */
function respond(cloud: Azure, method: string, url: string, token: string | undefined): Response {
  const parsed = new URL(url);
  const target = decodeURIComponent(parsed.pathname);
  const filter = parsed.searchParams.get('$filter') ?? '';
  const answer = cloud.intercept?.(method, target);
  if (answer) return answer;
  if (method !== 'GET' && parsed.host !== 'login.microsoftonline.com') cloud.changes.push(`${method} ${target.replace(`/subscriptions/${SUB}`, '').replace('/v1.0', '')}`);
  const assignmentBody = (entry: Assignment) => ({ id: entry.id, name: entry.id.split('/').at(-1), type: 'Microsoft.Authorization/roleAssignments',
    properties: { roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${entry.role}`, principalId: entry.principalId, principalType: 'ServicePrincipal', scope: entry.scope } });

  if (parsed.host === 'management.azure.com') {
    if (token !== 'Bearer arm-token') return json(401, { error: { code: 'InvalidAuthenticationToken' } });
    // Subscriptions - Get
    if (target === `/subscriptions/${SUB}`) return json(200, { id: `/subscriptions/${SUB}`, subscriptionId: SUB, tenantId: TENANT, displayName: 'Pay-As-You-Go', state: 'Enabled' });
    if (target === SCOPE) {
      if (cloud.group?.deleting !== undefined && cloud.group.deleting-- <= 0) cloud.group = undefined;
      // Resource Groups - Get: 404 ResourceGroupNotFound once gone; Resource Groups - Delete: 202 Accepted, long-running.
      if (!cloud.group) return notFound('ResourceGroupNotFound');
      if (method === 'DELETE') { cloud.group.deleting = 2; return json(202); }
      return json(200, { id: SCOPE, name: GROUP, type: 'Microsoft.Resources/resourceGroups', location: 'westus2', tags: cloud.group.tags, properties: { provisioningState: cloud.group.deleting === undefined ? 'Succeeded' : 'Deleting' } });
    }
    // Resources - List By Resource Group
    if (target === `${SCOPE}/resources`) {
      if (!cloud.group) return notFound('ResourceGroupNotFound');
      return json(200, { value: [...(cloud.vault ? [{ id: VAULT_ID, name: VAULT, type: 'Microsoft.KeyVault/vaults', location: 'westus2' }] : []),
        ...cloud.resources.map((resource) => ({ id: `${SCOPE}/providers/${resource.type}/${resource.name}`, name: resource.name, type: resource.type, location: 'westus2' }))] });
    }
    if (target === VAULT_ID) {
      // Vaults - Get: 404 ResourceNotFound; Vaults - Delete: 200, after which the vault is soft-deleted.
      if (!cloud.vault || !cloud.group) return notFound(cloud.group ? 'ResourceNotFound' : 'ResourceGroupNotFound');
      if (method === 'DELETE') { cloud.deletedVault = { purgeProtection: cloud.vault.purgeProtection === true }; cloud.vault = undefined; return json(200); }
      return json(200, { id: VAULT_ID, name: VAULT, type: 'Microsoft.KeyVault/vaults', location: 'westus2', tags: cloud.vault.tags,
        properties: { tenantId: TENANT, sku: { family: 'A', name: 'standard' }, enableRbacAuthorization: true, enableSoftDelete: true, softDeleteRetentionInDays: 7,
          ...(cloud.vault.purgeProtection ? { enablePurgeProtection: true } : {}), vaultUri: `https://${VAULT}.vault.azure.net/`, provisioningState: 'Succeeded' } });
    }
    // Vaults - List Deleted
    if (target === `/subscriptions/${SUB}/providers/Microsoft.KeyVault/deletedVaults`) {
      if (cloud.deletedVault?.purging !== undefined && cloud.deletedVault.purging-- <= 0) cloud.deletedVault = undefined;
      return json(200, { value: cloud.deletedVault ? [{ id: `/subscriptions/${SUB}/providers/Microsoft.KeyVault/locations/westus2/deletedVaults/${VAULT}`, name: VAULT, type: 'Microsoft.KeyVault/deletedVaults',
        properties: { vaultId: VAULT_ID, location: 'westus2', deletionDate: '2026-11-22T10:00:00Z', scheduledPurgeDate: '2026-11-29T10:00:00Z', purgeProtectionEnabled: cloud.deletedVault.purgeProtection, tags: { 'managed-by': 'hypervibe' } } }] : [] });
    }
    // Vaults - Purge Deleted: 202 Accepted, long-running.
    if (method === 'POST' && target === `/subscriptions/${SUB}/providers/Microsoft.KeyVault/locations/westus2/deletedVaults/${VAULT}/purge`) { cloud.deletedVault!.purging = 1; return json(202); }
    if (target.endsWith('/providers/Microsoft.Authorization/roleAssignments')) {
      // Role Assignments - List For Scope ($filter=atScope()) and List For Subscription ($filter=principalId eq '{id}').
      if (target.startsWith(SCOPE) && !cloud.group) return notFound('ResourceGroupNotFound');
      const inherited = assignmentBody({ ...assignment('f', '99999999-9999-4999-8999-999999999999', `/subscriptions/${SUB}`), role: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635' });
      return json(200, { value: filter === 'atScope()' ? [inherited, ...cloud.assignments.filter((entry) => entry.scope === SCOPE).map(assignmentBody)]
        : cloud.assignments.filter((entry) => filter === `principalId eq '${entry.principalId}'`).map(assignmentBody) });
    }
    const held = cloud.assignments.findIndex((entry) => entry.id === target);
    if (target.includes('/roleAssignments/')) {
      // Role Assignments - Get By Id: 404 RoleAssignmentNotFound; Delete By Id: 200 with the deleted assignment, 204 when there was none.
      if (held < 0) return method === 'DELETE' ? json(204) : notFound('RoleAssignmentNotFound');
      const body = assignmentBody(cloud.assignments[held]!);
      if (method === 'DELETE') cloud.assignments.splice(held, 1);
      return json(200, body);
    }
    const guid = /\/providers\/Microsoft\.Authorization\/roleDefinitions\/([0-9a-f-]+)$/.exec(target)?.[1];
    if (guid) {
      // Role Definitions - Get By Id: 404 RoleDefinitionDoesNotExist; Role Definitions - Delete: 200, or 204 when there was none.
      const role = cloud.roles.get(guid);
      if (!role) return method === 'DELETE' ? json(204) : notFound('RoleDefinitionDoesNotExist');
      if (method === 'DELETE') cloud.roles.delete(guid);
      return json(200, { id: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${guid}`, name: guid, type: 'Microsoft.Authorization/roleDefinitions',
        properties: { roleName: role.roleName, type: 'CustomRole', description: 'Hypervibe CI access v1', assignableScopes: [SCOPE], permissions: [] } });
    }
  }
  if (parsed.host === 'graph.microsoft.com') {
    if (token !== 'Bearer graph-token') return json(401, { error: { code: 'InvalidAuthenticationToken' } });
    const gone = () => notFound('Request_ResourceNotFound');
    // Get application by appId or uniqueName (alternate keys).
    if (target === `/v1.0/applications(appId='${CLIENT}')`) return cloud.app?.appId === CLIENT ? json(200, cloud.app) : gone();
    if (target === `/v1.0/applications(uniqueName='${APP}')`) return cloud.app?.uniqueName === APP ? json(200, cloud.app) : gone();
    // Get / Delete application, Get / Delete servicePrincipal: delete answers 204 and moves the object to deleted items.
    for (const [prefix, key] of [['/v1.0/applications/', 'app'], ['/v1.0/servicePrincipals/', 'principal']] as const) {
      if (!target.startsWith(prefix)) continue;
      const object = cloud[key];
      if (!object || target !== `${prefix}${object.id}`) return gone();
      if (method === 'DELETE') { cloud.deletedItems.add(object.id); cloud[key] = undefined; return json(204); }
      return json(200, object);
    }
    // Get deleted item / Permanently delete an item (directory object): 204.
    if (target.startsWith('/v1.0/directory/deletedItems/')) {
      const id = target.split('/').at(-1)!;
      if (!cloud.deletedItems.has(id)) return gone();
      if (method === 'DELETE') { cloud.deletedItems.delete(id); return json(204); }
      return json(200, { id });
    }
  }
  // Microsoft identity platform token endpoint, refresh-token grant.
  if (parsed.host === 'login.microsoftonline.com') return json(200, { token_type: 'Bearer', expires_in: 3600, access_token: 'graph-token', refresh_token: 'refresh-token-2' });
  return json(500, { error: { code: 'UnexpectedRequest' } });
}

let dataDir: string;
let now: number;
let waits: number;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-azure-removal-')); now = 1_000_000; waits = 0;
  environments.length = 0; connections.length = 0; audits.length = 0;
  const credentials = { tenantId: TENANT, subscriptionId: SUB, clientId: CLIENT, deployPrincipalId: PRINCIPAL, clientSecret: CLIENT_SECRET, clientSecretExpiresAt: '2027-06-01T00:00:00Z', resourceGroup: GROUP, location: 'westus2' };
  connections.push({ id: 'c1', provider: 'azure', scope: 'o/demo', credentialsEncrypted: JSON.stringify(credentials) },
    { id: 'c2', provider: 'azure', scope: 'o/other', credentialsEncrypted: JSON.stringify({ ...credentials, resourceGroup: 'hv-other' }) });
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function run(cloud: Azure, input: { previewId?: string; confirm?: boolean; subscriptionId?: string } = {}) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => respond(cloud, init?.method ?? 'GET', url, (init?.headers as Record<string, string> | undefined)?.authorization));
  const result = await runAzureSetupRemoval({ project, ...(input.confirm ? { subscriptionId: SUB } : {}), ...input }, {
    signIn: async () => ({ status: 'signed_in', session: { accessToken: 'arm-token', refreshToken: 'refresh-token', tenantId: TENANT, username: 'owner@example.com', expiresAt: new Date(Date.now() + 3600_000).toISOString() } }),
    fetch: fetchImpl as never, now: () => now, sleep: async () => { waits++; }, dataDir });
  // No credential ever reaches a result.
  for (const secret of ['arm-token', 'graph-token', 'refresh-token', CLIENT_SECRET]) expect(JSON.stringify(result)).not.toContain(secret);
  return result;
}
const untouched = (cloud: Azure) => { expect(cloud.changes).toEqual([]); expect(connections).toHaveLength(2); };
const assignmentPath = (name: string) => `DELETE ${assignment(name).id.replace(`/subscriptions/${SUB}`, '')}`;
const ALL_CHANGES = [
  assignmentPath('a'), assignmentPath('b'),
  ...CI_ROLES.map((role) => `DELETE /resourceGroups/${GROUP}/providers/Microsoft.Authorization/roleDefinitions/${role.guid}`),
  `DELETE /resourceGroups/${GROUP}/providers/Microsoft.KeyVault/vaults/${VAULT}`,
  `POST /providers/Microsoft.KeyVault/locations/westus2/deletedVaults/${VAULT}/purge`,
  `DELETE /resourceGroups/${GROUP}`,
  `DELETE /servicePrincipals/${PRINCIPAL}`, `DELETE /directory/deletedItems/${PRINCIPAL}`,
  `DELETE /applications/${APP_OBJECT}`, `DELETE /directory/deletedItems/${APP_OBJECT}`,
];

describe('removing Hypervibe\'s Azure setup for a project', () => {
  it('previews exactly what it will delete without changing anything, then removes it in dependency order on confirm', async () => {
    const cloud = azure();
    const preview = await run(cloud);
    expect(preview).toMatchObject({ success: true, mode: 'preview', subscriptionId: SUB, resourceGroup: GROUP, previewId: expect.any(String) });
    expect(preview.willDelete).toEqual([
      'The deploy identity\'s 2 role assignment(s) on hv-demo',
      `Custom roles: ${CI_ROLES.map((role) => role.properties.roleName).join(', ')}`,
      `Key Vault ${VAULT} and every secret still in it`,
      'Resource group hv-demo',
      `The deploy identity (service principal of ${APP}), for good`,
      `App registration ${APP}, with its client secret and GitHub sign-in, for good`,
    ]);
    // Purging is permanent, so it is listed apart from the rest.
    expect(preview.willPurge).toEqual([expect.stringContaining(`Purge the deleted Key Vault ${VAULT}`)]);
    expect(preview.leftBehind).toEqual([expect.stringContaining('stay on')]);
    untouched(cloud);

    const done = await run(cloud, { previewId: preview.previewId, confirm: true });
    expect(done).toMatchObject({ success: true, mode: 'confirm', removedConnections: ['azure (o/demo)'] });
    expect(done.removed).toHaveLength(7);
    expect(cloud.changes).toEqual(ALL_CHANGES);
    expect(cloud).toMatchObject({ group: undefined, vault: undefined, deletedVault: undefined, assignments: [], app: undefined, principal: undefined });
    expect(cloud.roles.size + cloud.deletedItems.size).toBe(0);
    // The group and the purge are long-running: each was read until Azure showed it gone.
    expect(waits).toBeGreaterThanOrEqual(3);
    expect(connections.map((entry) => entry.id)).toEqual(['c2']);
    expect(audits.map((entry) => entry.action)).toEqual(['connection.deleted', 'azure.setup.removed']);
  });

  it('refuses while Hypervibe still records an environment, before signing in or reading Azure', async () => {
    environments.push({ name: 'preview', platformBindings: { azure: { kind: 'opentofu', image: 'x' } } }, { name: 'old', platformBindings: { engine: {}, azure: { tornDownAt: '2026-11-20T00:00:00Z' } } });
    const cloud = azure(); const requests = vi.fn();
    cloud.intercept = () => { requests(); return undefined; };
    expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('demo/preview'), found: ['environment demo/preview'] });
    expect(requests).not.toHaveBeenCalled(); untouched(cloud);
  });

  it('refuses when the resource group holds anything setup did not create, and lists it', async () => {
    const cloud = azure({ resources: [{ name: 'photos', type: 'Microsoft.Storage/storageAccounts' }] });
    const result = await run(cloud);
    expect(result).toMatchObject({ success: false, status: 'blocked', found: ['Microsoft.Storage/storageAccounts photos'] });
    expect(result.error).toContain(`https://portal.azure.com/#@${TENANT}/resource/subscriptions/${SUB}/resourceGroups/hv-demo/overview`);
    untouched(cloud);

    // A vault with the expected name that setup did not tag is someone else's, too.
    const foreignVault = azure({ vault: { tags: {} } });
    expect(await run(foreignVault)).toMatchObject({ status: 'blocked', found: [`Microsoft.KeyVault/vaults ${VAULT}`] });
    untouched(foreignVault);
  });

  it('refuses when someone else holds a role on the group, or the deploy identity holds one elsewhere', async () => {
    const teammate = azure(); teammate.assignments.push(assignment('c', '77777777-7777-4777-8777-777777777777'));
    expect(await run(teammate)).toMatchObject({ status: 'blocked', error: expect.stringContaining('/resourceGroups/hv-demo/users'), found: [expect.stringContaining('77777777-7777-4777-8777-777777777777')] });
    untouched(teammate);
    const elsewhere = azure(); elsewhere.assignments.push(assignment('d', PRINCIPAL, `/subscriptions/${SUB}/resourceGroups/other`));
    expect(await run(elsewhere)).toMatchObject({ status: 'blocked', found: [`access on /subscriptions/${SUB}/resourceGroups/other`] });
    untouched(elsewhere);
  });

  it.each([
    ['a failed list of the group', (_method: string, target: string) => target.endsWith('/resources') ? json(500, { error: { code: 'InternalServerError' } }) : undefined],
    ['a list that stops at a broken next page', (_method: string, target: string) => target.endsWith('/resources') ? json(200, { value: [], nextLink: 'https://elsewhere.example/next' }) : undefined],
    ['a forbidden read of the group', (_method: string, target: string) => target === SCOPE ? json(403, { error: { code: 'AuthorizationFailed' } }) : undefined],
    ['a "not found" that is not Azure saying the group is gone', (_method: string, target: string) => target === SCOPE ? json(404, { error: { code: 'SubscriptionNotFound' } }) : undefined],
    ['a subscription this sign-in cannot read', (_method: string, target: string) => target === `/subscriptions/${SUB}` ? json(404, { error: { code: 'SubscriptionNotFound' } }) : undefined],
    ['an unreadable app registration', (_method: string, target: string) => target.includes('/applications(appId') ? json(403, { error: { code: 'Authorization_RequestDenied' } }) : undefined],
    ['a deleted-vault list without a body', (_method: string, target: string) => target.endsWith('/deletedVaults') ? new Response('<html>', { status: 200 }) : undefined],
    ['no answer at all', (_method: string, target: string) => { if (target.endsWith('/roleAssignments')) throw new Error('socket hang up'); return undefined; }],
  ])('treats %s as unknown and deletes nothing', async (_what, intercept) => {
    const cloud = azure({ intercept });
    expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('nothing was deleted') });
    untouched(cloud);
  });

  it('leaves a same-named resource group that setup did not tag, and everything else, alone', async () => {
    const cloud = azure({ group: { tags: { owner: 'someone' } } });
    expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('does not carry Hypervibe\'s setup tag') });
    untouched(cloud);
  });

  it('leaves a same-named app registration that is not the one setup saved, and reports it', async () => {
    const other = { id: '66666666-6666-4666-8666-666666666666', appId: '88888888-8888-4888-8888-888888888888', uniqueName: APP, tags: ['hypervibe'] };
    const cloud = azure({ app: other, principal: undefined });
    const preview = await run(cloud);
    expect(preview.willDelete?.join(' ')).not.toContain('App registration');
    expect(preview.leftBehind).toContainEqual(expect.stringContaining('88888888-8888-4888-8888-888888888888'));
    await run(cloud, { previewId: preview.previewId, confirm: true });
    expect(cloud.app).toBe(other);
    expect(cloud.changes.some((change) => change.includes('/applications/'))).toBe(false);
  });

  it('stops when the saved app registration was renamed or untagged since setup', async () => {
    const renamed = azure({ app: { id: APP_OBJECT, appId: CLIENT, uniqueName: 'payroll', tags: [] } });
    expect(await run(renamed)).toMatchObject({ status: 'blocked', error: expect.stringContaining('no longer named') });
    untouched(renamed);
  });

  it('confirms only with the matching, unexpired preview of what Azure still holds', async () => {
    const cloud = azure();
    expect(await run(cloud, { confirm: true })).toMatchObject({ status: 'blocked', error: expect.stringContaining('Preview the removal first') });
    expect(await runAzureSetupRemoval({ project, previewId: 'x', confirm: true })).toMatchObject({ status: 'blocked', error: expect.stringContaining('subscriptionId') });
    expect(await run(cloud, { previewId: '6f1c2b1e-8f0a-4c56-9d55-0d1f3a6f6a10', confirm: true })).toMatchObject({ status: 'blocked', error: expect.stringContaining('Preview the removal again') });

    const wrong = await run(cloud);
    expect(await run(cloud, { previewId: '6f1c2b1e-8f0a-4c56-9d55-0d1f3a6f6a10', confirm: true })).toMatchObject({ status: 'blocked' });
    // A preview is used once: the right id no longer works after a wrong one.
    expect(await run(cloud, { previewId: wrong.previewId, confirm: true })).toMatchObject({ status: 'blocked' });

    const expired = await run(cloud); now += 10 * 60_000 + 1;
    expect(await run(cloud, { previewId: expired.previewId, confirm: true })).toMatchObject({ status: 'blocked' });

    // Azure changed after the preview: what would be deleted is no longer what was reviewed.
    const stale = await run(cloud); cloud.assignments.push(assignment('e'));
    expect(await run(cloud, { previewId: stale.previewId, confirm: true })).toMatchObject({ status: 'blocked', error: expect.stringContaining('no longer matches') });
    expect(await run(cloud, { previewId: stale.previewId, confirm: true, subscriptionId: '99999999-9999-4999-8999-999999999999' })).toMatchObject({ status: 'blocked', error: expect.stringContaining('no saved Azure setup') });
    untouched(cloud);
  });

  it('stops at the first failed delete, says what was and was not removed, and finishes on a second run', async () => {
    const cloud = azure();
    cloud.intercept = (method, target) => method === 'DELETE' && target === SCOPE ? json(409, { error: { code: 'ScopeLocked', message: 'locked' } }) : undefined;
    const preview = await run(cloud);
    const stopped = await run(cloud, { previewId: preview.previewId, confirm: true });
    expect(stopped).toMatchObject({ success: false, mode: 'confirm', error: expect.stringContaining('HTTP 409 ScopeLocked') });
    expect(stopped.status).toBeUndefined();
    expect(stopped.removed).toHaveLength(4);
    expect(stopped.notRemoved).toEqual(['Resource group hv-demo', expect.stringContaining('service principal'), expect.stringContaining('App registration')]);
    // Nothing after the failed step was attempted, and the saved access is kept so the removal can be finished.
    expect(cloud).toMatchObject({ group: { tags: {} }, app: { appId: CLIENT }, principal: { id: PRINCIPAL } });
    expect(connections).toHaveLength(2);

    cloud.intercept = undefined; cloud.changes.length = 0;
    const again = await run(cloud);
    expect(again.willDelete).toEqual(stopped.notRemoved);
    expect(again.willPurge).toEqual([]);
    expect(await run(cloud, { previewId: again.previewId, confirm: true })).toMatchObject({ success: true, removedConnections: ['azure (o/demo)'] });
    expect(cloud.changes).toEqual(ALL_CHANGES.slice(6));
    expect(cloud).toMatchObject({ group: undefined, app: undefined, principal: undefined });
  });

  it('does not delete a group that gained something after the reads, and reports a delete it cannot confirm as pending', async () => {
    const late = azure(); const preview = await run(late);
    late.intercept = (method, target) => { if (method === 'DELETE' && target === VAULT_ID) late.resources.push({ name: 'late', type: 'Microsoft.Storage/storageAccounts' }); return undefined; };
    expect(await run(late, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: false, error: expect.stringContaining('is not empty (Microsoft.Storage/storageAccounts late)') });
    expect(late.group).toBeDefined();

    const slow = azure(); const second = await run(slow);
    slow.intercept = (method, target) => method === 'DELETE' && target === SCOPE ? json(202) : undefined;
    const pending = await run(slow, { previewId: second.previewId, confirm: true });
    expect(pending).toMatchObject({ success: false, status: 'pending', error: expect.stringContaining('could not confirm') });
    expect(waits).toBeGreaterThanOrEqual(120);
    expect(slow.principal).toBeDefined(); expect(connections).toHaveLength(2);
  });

  it('never purges a Key Vault with purge protection: it reports the soft-deleted vault, when Azure removes it and where to see it', async () => {
    const cloud = azure({ vault: { tags: { 'managed-by': 'hypervibe' }, purgeProtection: true } });
    const preview = await run(cloud);
    expect(preview.willPurge).toEqual([]);
    expect(preview.leftBehind).toContainEqual(expect.stringMatching(/purge protection.*7 days.*https:\/\/portal\.azure\.com\/#browse\/Microsoft\.KeyVault%2Fvaults/));
    const done = await run(cloud, { previewId: preview.previewId, confirm: true });
    expect(done).toMatchObject({ success: true });
    expect(done.leftBehind).toContainEqual(expect.stringContaining('purge protection'));
    expect(cloud.changes.some((change) => change.includes('/purge'))).toBe(false);
    expect(cloud.deletedVault).toEqual({ purgeProtection: true });

    // Later, with everything else gone, the kept vault is still reported with its date and never purged.
    connections.push({ id: 'c1', provider: 'azure', scope: 'o/demo', credentialsEncrypted: connections[0]!.credentialsEncrypted.replace('hv-other', GROUP) });
    const later = await run(cloud);
    expect(later).toMatchObject({ success: true, willDelete: [], willPurge: [] });
    expect(later.leftBehind).toContainEqual(expect.stringContaining('on 2026-11-29'));
  });

  it('purges a soft-deleted vault left by an earlier run, and treats a just-deleted vault Azure does not list yet as unconfirmed', async () => {
    const leftover = azure({ group: undefined, vault: undefined, deletedVault: { purgeProtection: false }, assignments: [], roles: new Map(), app: undefined, principal: undefined });
    const preview = await run(leftover);
    expect(preview).toMatchObject({ willDelete: [], willPurge: [expect.stringContaining('Purge')] });
    expect(await run(leftover, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: true });
    expect(leftover.changes).toEqual([ALL_CHANGES[5]]);
    expect(leftover.deletedVault).toBeUndefined();

    connections.push({ id: 'c1', provider: 'azure', scope: 'o/demo', credentialsEncrypted: connections[0]!.credentialsEncrypted.replace('hv-other', GROUP) });
    const lagging = azure(); const second = await run(lagging);
    lagging.intercept = (_method, target) => target.endsWith('/deletedVaults') ? json(200, { value: [] }) : undefined;
    expect(await run(lagging, { previewId: second.previewId, confirm: true })).toMatchObject({ success: false, status: 'pending', error: expect.stringContaining('does not list the deleted Key Vault') });
    expect(lagging.group).toBeDefined();
  });

  it('asks for the Azure sign-in with a link and deletes nothing until it is done', async () => {
    const result = await runAzureSetupRemoval({ project }, { signIn: async () => ({ status: 'waiting', url: 'http://127.0.0.1:4455/', message: 'open' }), fetch: (() => { throw new Error('no request expected'); }) as never, dataDir });
    expect(result).toMatchObject({ success: false, status: 'blocked', signInUrl: 'http://127.0.0.1:4455/', error: expect.stringContaining('http://127.0.0.1:4455/') });
  });

  it('refuses a project with no saved Azure setup: without the record it cannot tell what it created', async () => {
    connections.length = 0;
    expect(await run(azure())).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('no saved Azure setup') });
  });
});
