import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brokerTarget } from '../../../../domain/services/__tests__/cloud-deployment-ci.fixture.js';
import { extractGitHubScript } from '../../../../domain/services/__tests__/managed-ci-workflow.test-utils.js';
import { buildAzureContainerAppsGitHubActionsSteps } from '../azure-container-apps-ci.workflow.js';
import { buildAzureContainerAppsPortableRecipe } from '../azure-container-apps-ci.recipe.js';
import '../azure-container-apps.adapter.js';

// Reconstructed ARM registry/ACR exchange responses from Microsoft's contracts:
// https://learn.microsoft.com/en-us/rest/api/container-registry/registries/get?view=rest-container-registry-2025-11-01
// https://learn.microsoft.com/en-us/rest/api/registry-dataplane/authentication/exchange-aad-access-token-for-acr-refresh-token?view=rest-registry-dataplane-2021-07-01
// https://github.com/Azure/acr/blob/main/docs/AAD-OAuth.md
// Synthetic retained deployment receipt; Azure native first-create is still blocked.
function target() {
  const value = brokerTarget(), connection = value.deploymentAccess!.connection;
  const subscriptionId = '12345678-1234-4678-8678-123456789012', tenantId = '22345678-1234-4678-8678-123456789012';
  const group = `/subscriptions/${subscriptionId}/resourceGroups/isolated-production`;
  const principal = (name: string, n: number) => ({ kind: 'azure-managed-identity' as const, tenantId, subscriptionId,
    clientId: `${n}2345678-1234-4678-8678-123456789012`, principalId: `${n}3345678-1234-4678-8678-123456789012`,
    identityResourceId: `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}` });
  connection.provider = 'azure'; connection.hostingProvider = 'azure-container-apps'; connection.nativeScope = { tenantId, subscriptionId, resourceGroup: 'isolated-production', location: 'canadacentral' };
  connection.deployment.hostingProvider = 'azure-container-apps'; connection.deployment.region = 'canadacentral';
  connection.principals = { provision: principal('provision', 3), release: principal('release', 4) };
  connection.runtimeIdentities = [{ workload: 'web', installationId: connection.installationId, owner: 'b'.repeat(64), principal: principal('runtime', 5) }];
  value.providerRegion = 'canadacentral'; value.providerProjectId = group; value.providerServiceIds = [`${group}/providers/Microsoft.App/containerApps/web`];
  value.providerScope = { registryResourceId: `${group}/providers/Microsoft.ContainerRegistry/registries/hvreviewedregistry`, registryServer: 'hvreviewedregistry.azurecr.io', registryCreatedAt: '2026-10-24T01:00:00Z' };
  value.runtimeResources = [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: value.providerServiceIds[0], providerResourceUid: '2026-10-24T02:00:00Z', startCommand: null, healthCheckPath: '/' }];
  return value;
}
async function login(mode: 'ok' | 'replaced' | 'echo' = 'ok') {
  const reviewed = target(), output = buildAzureContainerAppsGitHubActionsSteps(reviewed);
  const script = extractGitHubScript(`jobs:\n  deploy:\n    steps:\n${output.steps}`, 'Authenticate to Hypervibe-managed ACR');
  const calls: Array<{ url: string; body?: string }> = [], publicOutput: unknown[] = [], exec = vi.fn();
  const directory = mkdtempSync(path.join(tmpdir(), 'hv-azure-ci-'));
  const localRequire = createRequire(import.meta.url);
  const process = { env: { RUNNER_TEMP: directory, AZURE_REGISTRY_SERVER: reviewed.providerScope!.registryServer } };
  const core = { getIDToken: async () => 'synthetic-ci-proof', setSecret: vi.fn(), setOutput: (...args: unknown[]) => publicOutput.push(args),
    exportVariable: (key: string, value: string) => { publicOutput.push([key, value]); } };
  const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: Buffer.from('{}').toString('base64'), size: 2 } }) } } };
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push({ url: input, ...(init?.body ? { body: String(init.body) } : {}) });
    if (input.includes('/release-sessions')) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ kind: 'azure-federation', principal: reviewed.deploymentAccess!.connection.principals.release, target: body.target,
        token: body.target === 'resource-manager' ? 'private-arm-bearer' : 'private-acr-bearer', expiresAt: new Date(Date.now() + 300000).toISOString() });
    }
    if (input.startsWith('https://management.azure.com/')) return Response.json({ id: reviewed.providerScope!.registryResourceId,
      systemData: { createdAt: mode === 'replaced' ? '2026-10-25T01:00:00Z' : reviewed.providerScope!.registryCreatedAt }, properties: { loginServer: reviewed.providerScope!.registryServer, provisioningState: 'Succeeded' } });
    if (input.endsWith('/oauth2/exchange')) return mode === 'echo' ? new Response('private-acr-bearer', { status: 403 }) : Response.json({ refresh_token: 'private-acr-refresh' });
    throw new Error('Unexpected synthetic transport');
  };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('require', 'core', 'github', 'context', 'fetch', 'process', script)(
      (name: string) => name === 'node:child_process' ? { execFileSync: exec } : localRequire(name), core, github,
      { repo: { owner: 'example', repo: 'app' }, ref: 'refs/heads/main', sha: 'a'.repeat(40) }, fetch, process);
    return { calls, exec, publicOutput, core };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
async function release(replaceRuntime: boolean) {
  const reviewed = target(), runtime = reviewed.deploymentAccess!.connection.runtimeIdentities[0].principal;
  if (runtime.kind !== 'azure-managed-identity') throw new Error('Invalid synthetic fixture');
  const script = extractGitHubScript(`jobs:\n  deploy:\n    steps:\n${buildAzureContainerAppsGitHubActionsSteps(reviewed).steps}`, 'Release exact digest to bound Azure Container Apps');
  const digest = `sha256:${'d'.repeat(64)}`, mutations: any[] = [], calls: string[] = [], outputs: unknown[][] = [];
  let app: any = { id: reviewed.providerServiceIds[0], systemData: { createdAt: reviewed.runtimeResources![0].providerResourceUid },
    identity: { type: 'UserAssigned', userAssignedIdentities: { [runtime.identityResourceId]: { clientId: runtime.clientId, principalId: replaceRuntime ? '63345678-1234-4678-8678-123456789012' : runtime.principalId } } },
    properties: { provisioningState: 'Succeeded', latestRevisionName: 'revision', latestReadyRevisionName: 'revision',
      configuration: { ingress: { fqdn: 'web.example.test' }, secrets: [{ name: 'api-token', identity: runtime.identityResourceId, keyVaultUrl: 'https://vault.vault.azure.net/secrets/api/' + 'a'.repeat(32) }] },
      template: { containers: [{ name: 'web', image: 'old@' + digest, env: [{ name: 'API_TOKEN', secretRef: 'api-token' }] }] } } };
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes('/release-sessions')) return Response.json({ kind: 'azure-federation', principal: reviewed.deploymentAccess!.connection.principals.release, target: 'resource-manager', token: 'private-arm', expiresAt: new Date(Date.now() + 300000).toISOString() });
    if (url.startsWith('https://web.example.test')) return new Response('ok');
    expect(new URL(url).pathname).toBe(app.id);
    if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); mutations.push(body); app = { ...app, properties: { ...app.properties, template: body.properties.template } }; }
    return Response.json(app);
  };
  const context = { repo: { owner: 'example', repo: 'app' }, ref: 'refs/heads/main', sha: 'a'.repeat(40) }, core = { getIDToken: async () => 'ci-proof', setSecret: () => {}, setOutput: (...args: unknown[]) => outputs.push(args) };
  const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: 'e30=', size: 2 } }) } } };
  const process = { env: { AZURE_RESOURCE_GROUP_ID: reviewed.providerProjectId, AZURE_CONTAINER_APP_IDS_JSON: JSON.stringify(reviewed.providerServiceIds), IMAGE_URI: `${reviewed.providerScope!.registryServer}/app@${digest}`, DEPLOY_SHA: 'a'.repeat(40) } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let failure: unknown;
  try { await new AsyncFunction('require', 'core', 'github', 'context', 'fetch', 'process', script)(createRequire(import.meta.url), core, github, context, fetch, process); }
  catch (error) { failure = error; }
  return { mutations, calls, failure, app, outputs };
}
describe('Azure emitted broker authentication', () => {
  it('uses fresh ARM sessions for exact image rollout while retaining native secret references and rejecting a replaced runtime principal before mutation', async () => {
    const valid = await release(false); expect(valid.failure).toBeUndefined(); expect(valid.mutations).toHaveLength(1);
    expect(valid.outputs).toEqual([['credential_deployments', JSON.stringify([{ serviceId: valid.app.id, deploymentIds: ['revision'] }])]]);
    expect(valid.mutations[0].properties.template.containers[0].env).toContainEqual({ name: 'API_TOKEN', secretRef: 'api-token' });
    expect(valid.mutations[0].properties).not.toHaveProperty('configuration');
    expect(valid.calls.filter(url => url.includes('/release-sessions'))).toHaveLength(3);
    const replaced = await release(true); expect(replaced.failure).toBeInstanceOf(Error); expect(replaced.mutations).toHaveLength(0);
  });
  it('exchanges only a target-specific short-lived token after verifying the exact registry, then passes the password only over Docker stdin', async () => {
    const output = buildAzureContainerAppsGitHubActionsSteps(target());
    expect(output.requiredSecrets).toEqual([]); expect(output.steps).not.toContain('AZURE_CLIENT_SECRET'); expect(output.permissions).toContain('id-token: write');
    const f = await login(); const exchange = f.calls.find(call => call.url.endsWith('/oauth2/exchange'))!;
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toEqual({ grant_type: 'access_token', service: 'hvreviewedregistry.azurecr.io', tenant: '22345678-1234-4678-8678-123456789012', access_token: 'private-acr-bearer' });
    expect(f.exec.mock.calls[0][1]).toContain('--password-stdin'); expect(f.exec.mock.calls[0][2].input).toBe('private-acr-refresh');
    expect(JSON.stringify(f.publicOutput)).not.toMatch(/private-|Bearer/);
  });
  it('blocks replaced registry evidence and safely handles an echoing exchange error', async () => {
    await expect(login('replaced')).rejects.toThrow(/Azure.*verif/i);
    await expect(login('echo')).rejects.toThrow(/Azure.*verif/i);
  });
  it('requires native lifetime bindings and refuses unsupported portable broker auth before using legacy keys', () => {
    const incomplete = target(); delete incomplete.providerScope!.registryCreatedAt;
    expect(() => buildAzureContainerAppsGitHubActionsSteps(incomplete)).toThrow();
    expect(() => buildAzureContainerAppsPortableRecipe(target())).toThrow(/broker|federat|unsupported/i);
  });
});
