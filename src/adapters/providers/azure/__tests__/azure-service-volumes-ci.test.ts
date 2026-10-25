import * as crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractGitHubScript } from '../../../../domain/services/__tests__/managed-ci-workflow.test-utils.js';
import { azureRegistryName, buildAzureContainerAppsGitHubActionsSteps } from '../azure-container-apps-ci.workflow.js';
import { buildAzureContainerAppsPortableRuntime } from '../azure-container-apps-ci.recipe.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const group = '/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/staging';
const appId = `${group}/providers/Microsoft.App/containerApps/web`;
const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const registry = `${azureRegistryName(group)}.azurecr.io`;

async function execute(kind: 'github' | 'portable', loseMount: boolean, changeIdentity?: (app: any) => void, operationId?: string) {
  let app: any = { id: appId, identity: { type: 'SystemAssigned, UserAssigned', principalId: '33333333-3333-4333-8333-333333333333', tenantId: '11111111-1111-4111-8111-111111111111', userAssignedIdentities: { [`${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/retained`]: { principalId: '44444444-4444-4444-8444-444444444444', clientId: '55555555-5555-4555-8555-555555555555' } } }, properties: { provisioningState: 'Succeeded', latestRevisionName: 'ready', latestReadyRevisionName: 'ready', configuration: { ingress: { fqdn: 'web.example.test' } }, template: {
    volumes: [{ name: 'hypervibe-data', storageType: 'AzureFile', storageName: 'web' }],
    containers: [{ name: 'main', image: 'old@' + digest, env: [], volumeMounts: [{ volumeName: 'hypervibe-data', mountPath: '/data' }] }],
  } } };
  const mutations: any[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === 'login.microsoftonline.com') return new Response(JSON.stringify({ access_token: 'private-token' }));
    if (url.hostname === 'web.example.test') return new Response('ok');
    if (url.pathname.toLowerCase().includes('/registries/')) return new Response(JSON.stringify({ id: url.pathname, properties: { loginServer: registry } }));
    expect(url.pathname).toBe(appId);
    if (init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      mutations.push(payload);
      expect(payload.properties.template.volumes).toEqual(app.properties.template.volumes);
      expect(payload.properties.template.containers[0].volumeMounts).toEqual(app.properties.template.containers[0].volumeMounts);
      app = { ...app, properties: { ...app.properties, template: payload.properties.template, ...(operationId ? { latestRevisionName: 'web--' + payload.properties.template.revisionSuffix, latestReadyRevisionName: 'web--' + payload.properties.template.revisionSuffix } : {}) } };
      if (loseMount) app.properties.template.containers[0].volumeMounts = [];
      changeIdentity?.(app);
    }
    return new Response(JSON.stringify(app));
  };
  const process = { env: { HYPERVIBE_CREDENTIAL_OPERATIONS: operationId ? JSON.stringify({ web: { serviceId: appId, operationId } }) : '{}', AZURE_TENANT_ID: 'tenant', AZURE_SUBSCRIPTION_ID: '22222222-2222-4222-8222-222222222222', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'private-secret', AZURE_RESOURCE_GROUP_ID: group, AZURE_CONTAINER_APP_IDS_JSON: JSON.stringify([appId]), IMAGE_URI: `${registry}/app@${digest}`, DEPLOY_SHA: sha, AZURE_REGISTRY_SERVER: registry, CI_REGISTRY: 'registry.example.test', CI_REGISTRY_USER: 'ci', CI_REGISTRY_PASSWORD: 'private-ci', CI_PROJECT_PATH: 'team/app', HYPERVIBE_REPOSITORY: 'team/app', HYPERVIBE_ENVIRONMENT: 'staging', HYPERVIBE_PROGRAM_FINGERPRINT: 'program' }, stdout: { write: () => {} } };
  if (kind === 'github') {
    const output = buildAzureContainerAppsGitHubActionsSteps({ environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: true, serviceNames: ['web'], providerProjectId: group, providerServiceIds: [appId] });
    const script = extractGitHubScript(`jobs:\n  deploy:\n    steps:\n${output.steps}`, 'Release exact digest to bound Azure Container Apps');
    await new AsyncFunction('fetch', 'process', 'require', 'core', script)(fetch, process, () => crypto, { setOutput: (name: string, value: string) => { if (name === 'credential_deployments') expect(JSON.parse(value)).toEqual([{ serviceId: appId, deploymentIds: [app.properties.latestReadyRevisionName] }]); } });
  } else {
    const script = buildAzureContainerAppsPortableRuntime().replace(/^import .*;\n/gm, '');
    await new AsyncFunction('fetch', 'process', 'createHash', 'readFile', 'writeFile', 'execFileSync', script)(fetch, process, crypto.createHash,
      async (path: string) => path === '.hypervibe-deploy-sha' ? sha : 'registry.example.test/team/app:' + sha,
      async () => {}, () => `digest: ${digest}`);
  }
  return mutations;
}

it.each(['github', 'portable'] as const)('forces a fresh but retry-stable Azure revision for same-commit credential activation (%s)', async kind => {
  const first = await execute(kind, false, undefined, 'accepted-operation-a');
  const retry = await execute(kind, false, undefined, 'accepted-operation-a');
  const next = await execute(kind, false, undefined, 'accepted-operation-b');
  const suffix = first[0].properties.template.revisionSuffix;
  expect(suffix).not.toBe('hv-' + sha.slice(0, 10));
  expect(retry[0].properties.template.revisionSuffix).toBe(suffix);
  expect(next[0].properties.template.revisionSuffix).not.toBe(suffix);
});

describe.each(['github', 'portable'] as const)('Azure Files %s deployment preservation', (kind) => {
  it('preserves existing filesystem mounts during exact-image release and rollback', async () => {
    expect(await execute(kind, false)).toHaveLength(1);
  });
  it('refuses success if the provider revision dropped the filesystem mount', async () => {
    await expect(execute(kind, true)).rejects.toThrow(/volume|mount/i);
  });
  // Actual emitted scripts execute against reconstructed ARM response shapes.
  // https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/get?view=rest-resource-manager-containerapps-2026-01-01
  it.each([
    ['principal', (app: any) => { app.identity.principalId = 'replacement-principal'; }],
    ['tenant', (app: any) => { app.identity.tenantId = 'replacement-tenant'; }],
    ['identity type', (app: any) => { app.identity.type = 'UserAssigned'; }],
    ['retained user identity', (app: any) => { app.identity.userAssignedIdentities = {}; }],
    ['main-container availability', (app: any) => { app.properties.configuration.identitySettings = [{ identity: 'system', lifecycle: 'None' }]; }],
  ] as const)('rejects changed %s after release without claiming success', async (_label, corrupt) => {
    await expect(execute(kind, false, corrupt)).rejects.toThrow(/identity/i);
  });
});
