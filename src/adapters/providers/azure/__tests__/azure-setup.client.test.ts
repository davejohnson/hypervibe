import { describe, expect, it } from 'vitest';
import { chooseAzureLocation } from '../../../../application/azure-connect.js';
import {
  AZURE_APP_ROLES, AZURE_RESOURCE_PROVIDERS, AZURE_ROLES, appRoleAssignmentCondition, applyAzureSetup, azureCiSetupReady, deployRoleGrants, githubSubjects, planAzureSetup,
  roleAssignmentName, type AzureSetupPlan,
} from '../azure-setup.client.js';
import type { AzureSignInSession } from '../azure-entra.client.js';
import { azureCiRoleDefinitions } from '../azure-ci-roles.js';

const SUB = '11111111-2222-3333-4444-555555555555';
const TENANT = '99999999-8888-7777-6666-555555555555';
const session = (): AzureSignInSession => ({ accessToken: 'arm-home', refreshToken: 'rt', tenantId: TENANT, userObjectId: 'u', username: 'owner@example.com', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
const json = (status: number, body: unknown = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });

type Route = [method: string, pattern: RegExp, respond: (body: unknown, url: string) => Response];
/** A fake Entra + Resource Manager + Graph: routes answer by method and URL; every call is recorded. */
function fakeAzure(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init?.body;
    calls.push({ method, url, body });
    if (url.startsWith('https://login.microsoftonline.com/')) return json(200, { access_token: url.includes(TENANT) && String(init?.body).includes('graph') ? 'graph' : 'arm' });
    const route = routes.find(([m, pattern]) => m === method && pattern.test(url));
    if (!route) throw new Error(`unexpected ${method} ${url}`);
    return route[2](body, url);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const target = { subscription: { subscriptionId: SUB, displayName: 'Pay-As-You-Go', tenantId: TENANT }, project: 'billforge', location: 'eastus2', repository: 'acme/billforge', environments: ['test'] };

describe('Azure setup access', () => {
  it('accepts only the exact fixed CI roles and conditional assignment authority', async () => {
    const connection = { tenantId: TENANT, subscriptionId: SUB, clientId: TENANT, deployPrincipalId: TENANT, clientSecret: 'local-secret-only', resourceGroup: 'hv-billforge', location: 'eastus2', clientSecretExpiresAt: '2027-01-01T00:00:00Z' };
    const roles = Object.values(azureCiRoleDefinitions(SUB, 'hv-billforge')); let widened = false; let incomplete = false;
    const azure = fakeAzure([
      ['GET', /\/roleDefinitions\//, (_body, url) => {
        const role = roles.find((r) => url.includes(r.guid))!;
        return json(200, { properties: widened ? { ...role.properties, permissions: [{ actions: ['*'] }] } : role.properties });
      }],
      ['GET', /\/roleAssignments\?/, () => json(200, { value: [{ properties: { principalId: TENANT, scope: `/subscriptions/${SUB}/resourceGroups/hv-billforge`,
        roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${AZURE_ROLES.roleBasedAccessControlAdministrator}`,
        condition: appRoleAssignmentCondition(roles.map((r) => r.guid)), conditionVersion: '2.0' } }], ...(incomplete ? { nextLink: 'unread-page' } : {}) })],
    ]);
    expect(await azureCiSetupReady(connection, azure.fetchImpl)).toBe(true);
    widened = true; expect(await azureCiSetupReady(connection, azure.fetchImpl)).toBe(false);
    widened = false; incomplete = true; expect(await azureCiSetupReady(connection, azure.fetchImpl)).toBe(false);
    expect(azure.calls.filter((c) => !c.url.startsWith('https://login.')).every((c) => c.method === 'GET')).toBe(true);
  });
  it('grants roles on the project resource group only, and lets the deploy identity assign nothing but the app data roles to service principals', () => {
    const roles = deployRoleGrants().map((grant) => grant.role);
    expect(roles).not.toContain('8e3af657-a8ff-443c-a75c-2fe8c4bcb635'); // Owner
    expect(roles).not.toContain('18d7d88d-d35e-4fb5-a5c3-7773c20a72d9'); // User Access Administrator
    const admin = deployRoleGrants().find((grant) => grant.role === AZURE_ROLES.roleBasedAccessControlAdministrator)!;
    expect(admin.condition).toBe(appRoleAssignmentCondition());
    for (const role of AZURE_APP_ROLES) expect(admin.condition).toContain(role);
    expect(admin.condition).not.toContain(AZURE_ROLES.contributor);
    expect(admin.condition!.match(/StringEqualsIgnoreCase \{'ServicePrincipal'\}/g)).toHaveLength(2);
    expect(admin.condition).toContain("ActionMatches{'Microsoft.Authorization/roleAssignments/write'}");
    expect(admin.condition).toContain("ActionMatches{'Microsoft.Authorization/roleAssignments/delete'}");
  });

  it('names role assignments stably and trusts GitHub per environment', () => {
    const name = roleAssignmentName('/subscriptions/x/resourceGroups/hv-a', 'p', 'r');
    expect(name).toBe(roleAssignmentName('/SUBSCRIPTIONS/x/resourceGroups/hv-a', 'p', 'r'));
    expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(githubSubjects('acme/app', ['test', 'pr-1', 'test'])).toEqual([
      { name: 'github-pr-1', subject: 'repo:acme/app:environment:pr-1' }, { name: 'github-test', subject: 'repo:acme/app:environment:test' },
    ]);
  });

  it('picks the region nearest the app\'s other environments', () => {
    expect(chooseAzureLocation(undefined)).toBe('eastus2');
    expect(chooseAzureLocation({ environments: { gcp: { hosting: { region: 'europe-west1' } } } } as never)).toBe('westeurope');
    expect(chooseAzureLocation({ environments: { aws: { hosting: { region: 'us-west-2' } } } } as never)).toBe('westus2');
  });
});

describe('Azure setup plan', () => {
  it('lists every change for a fresh subscription without writing anything', async () => {
    const azure = fakeAzure([
      ['GET', /\/providers\/Microsoft\.[A-Za-z]+\?/, () => json(200, { registrationState: 'NotRegistered' })],
      ['GET', /\/resourceGroups\/hv-billforge\?/, () => json(404, { error: { code: 'ResourceGroupNotFound' } })],
      ['GET', /applications\(uniqueName='hypervibe-deploy-billforge'\)/, () => json(404)],
    ]);
    const plan = await planAzureSetup(session(), target, azure.fetchImpl);
    expect(plan.changes.map((change) => [change.id, change.state])).toEqual([
      ['resource-providers', 'create'], ['resource-group', 'create'], ['key-vault', 'create'], ['deploy-identity', 'create'], ['github-oidc', 'create'], ['ci-roles', 'create'], ['roles', 'create'], ['local-secret', 'create'],
    ]);
    expect(plan.changes[0]!.change).toContain('Microsoft.App');
    expect(azure.calls.filter((call) => call.method !== 'GET' && !call.url.startsWith('https://login.'))).toEqual([]);
  });

  it('never treats an unreadable answer as absent, and refuses a resource group Hypervibe did not create', async () => {
    const providers: Route = ['GET', /\/providers\/Microsoft\.[A-Za-z]+\?/, () => json(200, { registrationState: 'Registered' })];
    await expect(planAzureSetup(session(), target, fakeAzure([providers, ['GET', /\/resourceGroups\/hv-billforge\?/, () => json(500)]]).fetchImpl))
      .rejects.toThrow(/Reading resource group hv-billforge failed \(HTTP 500\)/);
    await expect(planAzureSetup(session(), target, fakeAzure([providers, ['GET', /\/resourceGroups\/hv-billforge\?/, () => json(200, { tags: {} })]]).fetchImpl))
      .rejects.toThrow(/already exists and was not created by Hypervibe/);
  });
});

describe('Azure setup apply', () => {
  const plan: AzureSetupPlan = {
    tenantId: TENANT, subscriptionId: SUB, subscriptionName: 'Pay-As-You-Go', location: 'eastus2', signedInAs: 'owner@example.com',
    resourceGroup: 'hv-billforge', appName: 'hypervibe-deploy-billforge', vaultName: 'hv-billforge-abc123', repository: 'acme/billforge', environments: ['test'], changes: [], ready: false,
  };

  it('creates the identity, waits for it to reach Resource Manager, scopes roles to the group and returns the secret once', async () => {
    let principalNotFound = 1;
    const azure = fakeAzure([
      ['POST', /\/providers\/Microsoft\.[A-Za-z]+\/register\?/, () => json(200)],
      ['PUT', /\/resourceGroups\/hv-billforge\?/, () => json(201)],
      ['PUT', /\/vaults\/hv-billforge-abc123\?/, () => json(201)],
      ['PATCH', /applications\(uniqueName='hypervibe-deploy-billforge'\)$/, () => json(201)],
      ['GET', /applications\(uniqueName='hypervibe-deploy-billforge'\)\?/, () => json(200, { id: 'app-object', appId: 'client-id' })],
      ['GET', /servicePrincipals\(appId='client-id'\)/, () => json(404)],
      ['POST', /\/servicePrincipals$/, () => json(201, { id: 'sp-object' })],
      ['GET', /applications\/app-object\/federatedIdentityCredentials$/, () => json(200, { value: [] })],
      ['POST', /applications\/app-object\/federatedIdentityCredentials$/, () => json(201)],
      ['PUT', /\/roleAssignments\//, () => principalNotFound-- > 0 ? json(400, { error: { code: 'PrincipalNotFound' } }) : json(201)],
      ['GET', /\/roleAssignments\//, (_body, url) => json(200, { ...azure.calls.filter((call) => call.method === 'PUT' && call.url === url).at(-1)?.body as object, properties: { ...(azure.calls.filter((call) => call.method === 'PUT' && call.url === url).at(-1)?.body as { properties: object }).properties, scope: `/subscriptions/${SUB}/resourceGroups/hv-billforge` }, id: url.replace('https://management.azure.com', '').split('?')[0] })],
      ['GET', /\/roleDefinitions\//, (_body, url) => { const put = azure.calls.find((call) => call.method === 'PUT' && call.url.split('/roleDefinitions/')[1] === url.split('/roleDefinitions/')[1]); return put ? json(200, put.body) : json(404); }],
      ['PUT', /\/roleDefinitions\//, () => json(201)],
      ['POST', /applications\/app-object\/addPassword$/, () => json(200, { secretText: 'the-secret', endDateTime: '2027-11-12T00:00:00Z' })],
    ]);
    const applied = await applyAzureSetup(session(), plan, { createSecret: true, fetchImpl: azure.fetchImpl, retryDelayMs: 1 });
    expect(applied).toEqual({ clientId: 'client-id', servicePrincipalId: 'sp-object', resourceGroup: 'hv-billforge', secret: { value: 'the-secret', expiresAt: '2027-11-12T00:00:00Z' } });
    expect(azure.calls.filter((call) => call.url.includes('/register?'))).toHaveLength(AZURE_RESOURCE_PROVIDERS.length);
    // The deploy identity cannot create custom roles: reviewed owner setup must install them first.
    const definitions = azure.calls.filter((call) => call.method === 'PUT' && call.url.includes('/roleDefinitions/'));
    expect(definitions).toHaveLength(2);
    for (const definition of definitions) {
      expect(definition.body).toMatchObject({ properties: { type: 'CustomRole', assignableScopes: [`/subscriptions/${SUB}/resourceGroups/hv-billforge`] } });
      expect(JSON.stringify(definition.body)).not.toContain('Microsoft.Authorization/roleDefinitions/write');
    }
    const assignments = azure.calls.filter((call) => call.method === 'PUT' && call.url.includes('/roleAssignments/'));
    expect(assignments).toHaveLength(deployRoleGrants().length + 1);
    for (const call of assignments) {
      expect(call.url).toMatch(new RegExp(`^https://management\\.azure\\.com/subscriptions/${SUB}/resourceGroups/hv-billforge/providers/Microsoft\\.Authorization/roleAssignments/`));
      expect(call.body).toMatchObject({ properties: { principalId: 'sp-object', principalType: 'ServicePrincipal' } });
    }
    expect(azure.calls.find((call) => call.url.endsWith('/federatedIdentityCredentials') && call.method === 'POST')?.body).toMatchObject({
      issuer: 'https://token.actions.githubusercontent.com', subject: 'repo:acme/billforge:environment:test', audiences: ['api://AzureADTokenExchange'],
    });
  });

  it.each([false, true])('verifies existing role assignment conflicts before success (stale condition: %s)', async (stale) => {
    const azure = fakeAzure([
      ['POST', /\/register\?/, () => json(200)], ['PUT', /\/resourceGroups\/hv-billforge\?/, () => json(200)], ['PUT', /\/vaults\//, () => json(200)],
      ['PATCH', /applications\(uniqueName=/, () => json(204)], ['GET', /applications\(uniqueName=/, () => json(200, { id: 'app-object', appId: 'client-id' })],
      ['GET', /servicePrincipals\(appId=/, () => json(200, { id: 'sp-object' })], ['GET', /federatedIdentityCredentials$/, () => json(200, { value: [{ subject: 'repo:acme/billforge:environment:test' }] })],
      ['GET', /\/roleDefinitions\//, (_body, url) => { const put = azure.calls.find((call) => call.method === 'PUT' && call.url.split('/roleDefinitions/')[1] === url.split('/roleDefinitions/')[1]); return put ? json(200, put.body) : json(404); }], ['PUT', /\/roleDefinitions\//, () => json(201)],
      ['PUT', /\/roleAssignments\//, () => json(409, { error: { code: 'RoleAssignmentExists' } })],
      ['GET', /\/roleAssignments\//, (_body, url) => {
        const requested = azure.calls.filter((call) => call.method === 'PUT' && call.url === url).at(-1)?.body as { properties: Record<string, unknown> };
        return json(200, { id: url.replace('https://management.azure.com', '').split('?')[0], properties: { ...requested.properties, scope: `/subscriptions/${SUB}/resourceGroups/hv-billforge`,
          ...(stale && requested.properties.condition ? { condition: appRoleAssignmentCondition() } : {}) } });
      }],
    ]);
    const applying = applyAzureSetup(session(), plan, { createSecret: false, fetchImpl: azure.fetchImpl, retryDelayMs: 1 });
    if (stale) await expect(applying).rejects.toThrow(/role assignment|grant/i);
    else expect((await applying).secret).toBeUndefined();
    expect(azure.calls.some((call) => call.url.endsWith('/addPassword') || (call.method === 'POST' && call.url.endsWith('/federatedIdentityCredentials')))).toBe(false);
  });
});
