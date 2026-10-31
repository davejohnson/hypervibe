import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { azurePreparedFixture } from './helpers/azure-prepared-fixture.js';
import { AzureContainerAppsAdapter } from '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import { buildAzureContainerAppsGitHubActionsSteps } from '../../src/adapters/providers/azure/azure-container-apps-ci.workflow.js';
import { extractGitHubScript } from '../../src/domain/services/__tests__/managed-ci-workflow.test-utils.js';
import { environmentSpecSchema } from '../../src/domain/spec/spec.schema.js';
import type { Environment } from '../../src/domain/entities/environment.entity.js';
import type { BranchDeployTarget } from '../../src/domain/ports/ci-deploy.port.js';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const f = await azurePreparedFixture(true), connection = f.driver.deployment!.connection(f.installed), principal = connection.principals.provision;
  if (principal.kind !== 'azure-managed-identity') throw new Error('Invalid native fixture');
  vi.stubGlobal('fetch', f.request);
  const adapter = new AzureContainerAppsAdapter();
  await adapter.connectTransient({ connection, capability: 'provision', authentication: { kind: 'azure-federation', principal,
    getAccessToken: async () => ({ token: 'synthetic-private-token', expiresAt: new Date(Date.now() + 300000).toISOString() }) } });
  const now = new Date(), environment: Environment = { id: 'local-environment', projectId: 'local-project', name: 'staging', platformBindings: {}, createdAt: now, updatedAt: now };
  const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'azure-container-apps', region: 'eastus' },
    services: { web: { workloadKind: 'web', startCommand: 'node server.js', healthCheckPath: '/health' } }, envVars: { NODE_ENV: 'production' },
    secretDestinations: Object.fromEntries(connection.deployment.workloads[0].runtimeSecrets.map(item => [item.key, item.reference])) });
  const observed = await adapter.preparedHosting!.inspect({ environment, environmentSpec });
  if (observed.state !== 'verified') throw new Error('Missing preparation');
  environment.platformBindings = { ...observed.bindings, preparedHosting: observed.preparation };
  const target: BranchDeployTarget = { environmentName: 'staging', branch: 'main', kind: 'staging', autoDeployOnPush: true, serviceNames: ['web'],
    providerProjectId: observed.bindings.projectId, providerEnvironmentId: observed.bindings.environmentId, providerRegion: 'eastus',
    providerScope: observed.bindings.providerScope, providerServiceIds: [connection.preparedResources!.workloads[0].id],
    runtimeResources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: connection.preparedResources!.workloads[0].id,
      providerResourceUid: connection.preparedResources!.workloads[0].lifetimeId, startCommand: 'node server.js', healthCheckPath: '/health' }],
    deploymentAccess: { origin: 'https://hypervibe.dev', projectId: connection.appId, connectionId: connection.installationId, environment: 'staging', sourceBranch: 'main', connection },
    preparedRuntime: { envVars: environmentSpec.envVars, preparation: observed.preparation } };
  const mutations: any[] = [], publicOutput: unknown[] = [], native = connection.preparedResources!.workloads[0];
  let uncertain = false;
  const fetch = async (input: string, init?: RequestInit) => {
    if (input.includes('/release-sessions')) return Response.json({ kind: 'azure-federation', principal: connection.principals.release, target: 'resource-manager',
      token: 'synthetic-private-release-token', expiresAt: new Date(Date.now() + 300000).toISOString() });
    if (input.startsWith('https://web.example.test')) return new Response('healthy');
    if (init?.method === 'PATCH') {
      expect(new URL(input).pathname).toBe(native.id);
      const body = JSON.parse(String(init.body)); mutations.push(body);
      if (uncertain) throw new Error('synthetic-private-release-token');
      const app = f.resources.get(native.id), runtime = connection.runtimeIdentities[0].principal;
      if (runtime.kind !== 'azure-managed-identity') throw new Error();
      app.identity = { type: 'UserAssigned', userAssignedIdentities: { [runtime.identityResourceId]: { clientId: runtime.clientId, principalId: runtime.principalId } } };
      app.properties = { ...app.properties, ...body.properties, latestRevisionName: 'web--candidate', latestReadyRevisionName: 'web--candidate', provisioningState: 'Succeeded' };
      app.properties.configuration.ingress.fqdn = 'web.example.test';
      return Response.json(app);
    }
    return f.request(input, init);
  };
  async function run() {
    const script = extractGitHubScript(`jobs:\n  deploy:\n    steps:\n${buildAzureContainerAppsGitHubActionsSteps(target).steps}`, 'Release exact digest to bound Azure Container Apps');
    const core = { getIDToken: async () => 'synthetic-ci-proof', setSecret: () => {}, setOutput: (...args: unknown[]) => publicOutput.push(args) };
    const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: 'e30=', size: 2 } }) } } };
    const context = { repo: { owner: 'studio', repo: 'sequence' }, ref: 'refs/heads/main', sha: 'c'.repeat(40) };
    const process = { env: { AZURE_RESOURCE_GROUP_ID: target.providerProjectId, AZURE_CONTAINER_APP_IDS_JSON: JSON.stringify(target.providerServiceIds),
      IMAGE_URI: `${target.providerScope!.registryServer}/sequence@sha256:${'d'.repeat(64)}`, DEPLOY_SHA: 'c'.repeat(40), DEPLOY_OPERATION: 'deploy' } };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction('require', 'core', 'github', 'context', 'fetch', 'process', script)(createRequire(import.meta.url), core, github, context, fetch, process);
  }
  return { ...f, target, connection, environment, environmentSpec, adapter, mutations, publicOutput, run, makeUncertain: () => { uncertain = true; } };
}
describe('Azure emitted first candidate rollout from independently installed holding resources', () => {
  it('updates candidate image, platform-only reader UAMI and immutable references together, then verifies ready revision', async () => {
    const f = await fixture();
    await f.run();
    expect(f.mutations).toHaveLength(1);
    const body = f.mutations[0], runtime = f.connection.runtimeIdentities[0].principal;
    if (runtime.kind !== 'azure-managed-identity') throw new Error();
    expect(Object.keys(body.identity.userAssignedIdentities)).toEqual([runtime.identityResourceId]);
    expect(body.properties.configuration.identitySettings).toEqual([{ identity: runtime.identityResourceId, lifecycle: 'None' }]);
    expect(body.properties.configuration.secrets).toEqual([{ name: 'reference-0', keyVaultUrl: `https://reviewed-secrets.vault.azure.net/secrets/api-token/${'b'.repeat(32)}`, identity: runtime.identityResourceId }]);
    expect(body.properties.template.containers[0]).toMatchObject({ image: `${f.target.providerScope!.registryServer}/sequence@sha256:${'d'.repeat(64)}`,
      env: expect.arrayContaining([{ name: 'API_TOKEN', secretRef: 'reference-0' }, { name: 'NODE_ENV', value: 'production' }, { name: 'HYPERVIBE_DEPLOY_SHA', value: 'c'.repeat(40) }]) });
    expect(JSON.stringify(f.publicOutput)).not.toContain('synthetic-private');
    const observed = await f.adapter.preparedHosting!.inspect({ environment: f.environment, environmentSpec: f.environmentSpec });
    expect(observed).toMatchObject({ state: 'verified', preparation: { pendingFirstRelease: [] } });
    expect(await f.adapter.observe(f.environment)).toMatchObject({ projectExists: true, services: [{ name: 'web', status: 'running', envVarSecretRefs: { API_TOKEN: expect.objectContaining({ version: 'b'.repeat(32) }) } }] });
  });
  it('retains original completed installation evidence after an authorized application rollout', async () => {
    const f = await fixture(); await f.run();
    const action = f.installed.plan.actions.find(item => item.id === 'azure:prepared:app:web')!, attempt = f.installed.attempts.find(item => item.actionId === action.id)!;
    const result = await f.driver.recover({ ...f.context, intent: f.intent, completed: f.installed.completed, action, attempt });
    expect(result).toMatchObject({ state: 'satisfied', evidence: f.installed.completed[action.id] });
  });
  it('normalizes native JSON object ordering when verifying a completed probe configuration', async () => {
    const f = await fixture(); await f.run();
    const app = f.resources.get(f.connection.preparedResources!.workloads[0].id);
    app.properties.template.containers[0].probes = [{ timeoutSeconds: 5, failureThreshold: 6, periodSeconds: 10, initialDelaySeconds: 10,
      httpGet: { scheme: 'HTTP', port: 8080, path: '/health' }, type: 'Liveness' }];
    expect((await f.adapter.preparedHosting!.inspect({ environment: f.environment, environmentSpec: f.environmentSpec })).state).toBe('verified');
  });
  it.each(['replaced', 'later-holding', 'removed-reader', 'unknown-config'] as const)('blocks %s before the emitted update', async mode => {
    const f = await fixture(), prepared = f.connection.preparedResources!.workloads[0], app = f.resources.get(prepared.id);
    if (mode === 'replaced') app.systemData.createdAt = '2026-10-26T12:00:00Z';
    if (mode === 'later-holding') app.properties.latestReadyRevisionName = app.properties.latestRevisionName = 'web--later';
    if (mode === 'unknown-config') app.properties.template.containers[0].env.push({ name: 'UNREVIEWED', value: 'changed' });
    if (mode === 'removed-reader') {
      for (const [id, value] of f.resources) if (value.properties?.roleDefinitionId?.endsWith('/4633458b-17de-408a-b874-0445c86b69e6')) f.resources.delete(id);
    }
    await expect(f.run()).rejects.toThrow();
    expect(f.mutations).toHaveLength(0);
  });
  it('never resubmits an uncertain candidate update or exposes provider-echoed credentials', async () => {
    const f = await fixture(); f.makeUncertain();
    await expect(f.run()).rejects.toThrow(/verified|unavailable/i);
    expect(f.mutations).toHaveLength(1);
  });
});
