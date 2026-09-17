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

async function execute(kind: 'github' | 'portable', loseMount: boolean) {
  let app: any = { id: appId, properties: { provisioningState: 'Succeeded', latestRevisionName: 'ready', latestReadyRevisionName: 'ready', configuration: { ingress: { fqdn: 'web.example.test' } }, template: {
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
      app = { ...app, properties: { ...app.properties, template: payload.properties.template } };
      if (loseMount) app.properties.template.containers[0].volumeMounts = [];
    }
    return new Response(JSON.stringify(app));
  };
  const process = { env: { AZURE_TENANT_ID: 'tenant', AZURE_SUBSCRIPTION_ID: '22222222-2222-4222-8222-222222222222', AZURE_CLIENT_ID: 'client', AZURE_CLIENT_SECRET: 'private-secret', AZURE_RESOURCE_GROUP_ID: group, AZURE_CONTAINER_APP_IDS_JSON: JSON.stringify([appId]), IMAGE_URI: `${registry}/app@${digest}`, DEPLOY_SHA: sha, AZURE_REGISTRY_SERVER: registry, CI_REGISTRY: 'registry.example.test', CI_REGISTRY_USER: 'ci', CI_REGISTRY_PASSWORD: 'private-ci', CI_PROJECT_PATH: 'team/app', HYPERVIBE_REPOSITORY: 'team/app', HYPERVIBE_ENVIRONMENT: 'staging', HYPERVIBE_PROGRAM_FINGERPRINT: 'program' }, stdout: { write: () => {} } };
  if (kind === 'github') {
    const output = buildAzureContainerAppsGitHubActionsSteps({ environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: true, serviceNames: ['web'], providerProjectId: group, providerServiceIds: [appId] });
    const script = extractGitHubScript(`jobs:\n  deploy:\n    steps:\n${output.steps}`, 'Release exact digest to bound Azure Container Apps');
    await new AsyncFunction('fetch', 'process', script)(fetch, process);
  } else {
    const script = buildAzureContainerAppsPortableRuntime().replace(/^import .*;\n/gm, '');
    await new AsyncFunction('fetch', 'process', 'readFile', 'writeFile', 'execFileSync', script)(fetch, process,
      async (path: string) => path === '.hypervibe-deploy-sha' ? sha : 'registry.example.test/team/app:' + sha,
      async () => {}, () => `digest: ${digest}`);
  }
  return mutations;
}

describe.each(['github', 'portable'] as const)('Azure Files %s deployment preservation', (kind) => {
  it('preserves existing filesystem mounts during exact-image release and rollback', async () => {
    expect(await execute(kind, false)).toHaveLength(1);
  });
  it('refuses success if the provider revision dropped the filesystem mount', async () => {
    await expect(execute(kind, true)).rejects.toThrow(/volume|mount/i);
  });
});
