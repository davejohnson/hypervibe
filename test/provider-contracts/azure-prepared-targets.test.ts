import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildAzureContainerAppsGitHubActionsSteps } from '../../src/adapters/providers/azure/azure-container-apps-ci.workflow.js';
import { extractGitHubScript } from '../../src/domain/services/__tests__/managed-ci-workflow.test-utils.js';
import type { BranchDeployTarget } from '../../src/domain/ports/ci-deploy.port.js';
import '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import { azurePreparedFixture } from './helpers/azure-prepared-fixture.js';
import { verifyCloudDeploymentReleaseTargetsV1 } from '../../src/application/hosted/cloud-deployment-session.js';
import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';
import { azurePreparedCoordinates } from '../../src/adapters/providers/azure/azure-prepared-hosting.js';
import { canonicalJsonSha256 } from '../../src/lib/canonical-json.js';
import { azurePreparedApplicationConfiguration, azurePreparedApplicationDigest } from '../../src/adapters/providers/azure/azure-prepared-release.js';

// Reconstructed ARM responses via the real shared install/session/target boundary.
// The fixture's native response fields are independent of request template bodies.
// Scoped Role Definitions GET uses the official Authorization 2022-04-01 route.
async function fixture() {
  const f = await azurePreparedFixture(true), connection = f.driver.deployment!.connection(f.installed), prepared = connection.preparedResources!;
  const coordinates = azurePreparedCoordinates(connection);
  const references = Object.fromEntries(connection.deployment.workloads[0].runtimeSecrets.map(item => [item.key, item.reference]));
  const spec = projectSpecSchema.parse({ version: 1, project: 'sequence', secrets: { API_TOKEN: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } }, environments: { staging: {
    hosting: { provider: 'azure-container-apps', region: 'eastus' }, services: { web: { workloadKind: 'web', public: true, startCommand: 'node server.js', healthCheckPath: '/health' } },
    envVars: { NODE_ENV: 'production' }, secretDestinations: references, email: { enabled: false }, envFile: { mode: 'off' },
  } } });
  const runtime = connection.runtimeIdentities[0].principal;
  if (runtime.kind !== 'azure-managed-identity') throw new Error('Invalid fixture');
  const desired = azurePreparedApplicationConfiguration({ identityId: runtime.identityResourceId, environmentId: prepared.project.id,
    registryServer: coordinates.registryServer, envVars: spec.environments.staging.envVars, secretVersionRefs: references,
    startCommand: 'node server.js', healthCheckPath: '/health' });
  // The API permits a scoped role lookup while returning the canonical definition ID.
  for (const [id, value] of [...f.resources]) if (/^\/subscriptions\/[^/]+\/providers\/Microsoft.Authorization\/roleDefinitions\//.test(id))
    f.resources.set(`${coordinates.group}/providers/Microsoft.Authorization/roleDefinitions/${id.split('/').at(-1)}`, value);
  const bindings = { version: 1, project: spec.project, environments: { staging: { platformBindings: {
    provider: 'azure-container-apps', projectId: coordinates.group, environmentId: prepared.project.id,
    providerScope: { registryResourceId: prepared.registry.id, registryCreatedAt: prepared.registry.lifetimeId, registryServer: coordinates.registryServer,
      managedEnvironmentCreatedAt: prepared.project.lifetimeId },
    services: { web: { serviceId: prepared.workloads[0].id, resourceUid: prepared.workloads[0].lifetimeId, resourceType: 'service', workloadKind: 'web', imageUri: prepared.workloads[0].holding.image } },
    preparedHosting: { schemaVersion: 1, installationId: connection.installationId, planDigest: connection.planDigest, receiptDigest: canonicalJsonSha256(connection),
      pendingFirstRelease: ['web'], firstReleaseConfigurationDigests: { web: azurePreparedApplicationDigest(desired) } },
  } } } };
  const authorize = vi.fn(async () => true), input = { connection, driver: f.driver, spec, bindings, source: connection.source,
    authentication: { host: f.context.authentication.host }, authorize, signal: new AbortController().signal };
  f.events.splice(0);
  return { ...f, connection, prepared, coordinates, desired, runtime, input, bindings, authorize,
    verify: () => verifyCloudDeploymentReleaseTargetsV1(input) };
}

function applicationResponse(f: Awaited<ReturnType<typeof fixture>>, image: string, sha: string, revision: string) {
    const app = structuredClone(f.resources.get(f.prepared.workloads[0].id));
    // Independently authored native ACA 2026-01-01 projection, not the renderer's result.
    app.identity = { type: 'UserAssigned', userAssignedIdentities: { [f.runtime.identityResourceId]: {
      clientId: f.runtime.clientId, principalId: f.runtime.principalId } } };
    app.properties.latestRevisionName = app.properties.latestReadyRevisionName = revision;
    app.properties.configuration = { activeRevisionsMode: 'Single', ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false },
      identitySettings: [{ identity: f.runtime.identityResourceId, lifecycle: 'None' }], registries: [{ server: f.coordinates.registryServer, identity: f.runtime.identityResourceId }],
      secrets: [{ name: 'reference-0', identity: f.runtime.identityResourceId, keyVaultUrl: `https://reviewed-secrets.vault.azure.net/secrets/api-token/${'b'.repeat(32)}` }] };
    app.properties.template = { containers: [{ name: 'main', image, env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'API_TOKEN', secretRef: 'reference-0' },
      { name: 'HYPERVIBE_START_COMMAND', value: 'node server.js' }, { name: 'HYPERVIBE_HEALTH_CHECK_PATH', value: '/health' },
      { name: 'HYPERVIBE_DEPLOY_SHA', value: sha }, { name: 'HYPERVIBE_IMAGE_DIGEST', value: `sha256:${'e'.repeat(64)}` }],
      resources: { cpu: 0.25, memory: '0.5Gi' }, command: ['sh'], args: ['-lc', 'node server.js'],
      probes: [{ type: 'Liveness', httpGet: { path: '/health', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 }] }],
      scale: { minReplicas: 0, maxReplicas: 4 } };
    app.properties.workloadProfileName = 'Consumption';
    app.properties.configuration.ingress.fqdn = 'web.example.test';
    return app;
}
describe('Azure prepared release target enrollment', () => {
  it.each(['first', 'same-image-credential', 'lost-ack'] as const)('emits verified native deployment receipts for prepared %s rollout', async mode => {
    const f = await fixture(), p = f.bindings.environments.staging.platformBindings, id = f.prepared.workloads[0].id;
    const sha = 'a'.repeat(40), image = `${f.coordinates.registryServer}/app@sha256:${'e'.repeat(64)}`;
    const operationId = 'reviewed-credential-operation';
    const suffix = 'hv-' + sha.slice(0, 10) + (mode === 'same-image-credential' ? '-c-' + createHash('sha256').update(JSON.stringify([operationId])).digest('hex').slice(0, 12) : '');
    const revision = id.split('/').at(-1) + '--' + suffix;
    if (mode === 'same-image-credential') {
      f.resources.set(id, applicationResponse(f, image, sha, id.split('/').at(-1) + '--previous'));
      p.preparedHosting.pendingFirstRelease = [];
      p.preparedHosting.firstReleaseConfigurationDigests = {} as any;
    }
    const target: BranchDeployTarget = { environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: false,
      serviceNames: ['web'], providerProjectId: f.coordinates.group, providerServiceIds: [id], providerRegion: 'eastus', providerScope: p.providerScope,
      runtimeResources: [{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: id,
        providerResourceUid: f.prepared.workloads[0].lifetimeId, startCommand: 'node server.js', healthCheckPath: '/health' }],
      deploymentAccess: { origin: 'https://hypercloud.example', projectId: f.connection.appId, connectionId: f.connection.installationId,
        environment: 'staging', sourceBranch: 'main', connection: f.connection }, preparedRuntime: { envVars: { NODE_ENV: 'production' }, preparation: p.preparedHosting as any } };
    const generated = buildAzureContainerAppsGitHubActionsSteps(target);
    const script = extractGitHubScript(`jobs:\n  deploy:\n    steps:\n${generated.steps}`, 'Release exact digest to bound Azure Container Apps');
    const writes: any[] = [], outputs: unknown[][] = [];
    const fetch = async (input: string, init?: RequestInit) => {
      if (input.includes('/release-sessions')) return Response.json({ kind: 'azure-federation', principal: f.connection.principals.release,
        target: 'resource-manager', token: 'synthetic-private-arm', expiresAt: new Date(Date.now() + 300000).toISOString() });
      if (input.startsWith('https://web.example.test/')) return new Response('ok');
      const path = new URL(input).pathname;
      if (init?.method === 'PATCH') {
        expect(path).toBe(id); writes.push(JSON.parse(String(init.body)));
        f.resources.set(id, applicationResponse(f, image, sha, revision));
        if (mode === 'lost-ack') throw new Error('Synthetic response lost after server accepted update');
      }
      const resource = f.resources.get(path); if (!resource) throw new Error('Unexpected native read: ' + path);
      return Response.json(resource);
    };
    const core = { getIDToken: async () => 'synthetic-ci-proof', setSecret: () => {}, setOutput: (...args: unknown[]) => outputs.push(args) };
    const github = { rest: { repos: { getContent: async () => ({ data: { type: 'file', encoding: 'base64', content: 'e30=', size: 2 } }) } } };
    const run = () => new (Object.getPrototypeOf(async function () {}).constructor)('require', 'core', 'github', 'context', 'fetch', 'process', script)(
      createRequire(import.meta.url), core, github, { repo: { owner: 'studio', repo: 'sequence' }, ref: 'refs/heads/main', sha }, fetch,
      { env: { AZURE_RESOURCE_GROUP_ID: f.coordinates.group, AZURE_CONTAINER_APP_IDS_JSON: JSON.stringify([id]), IMAGE_URI: image, DEPLOY_SHA: sha,
        HYPERVIBE_CREDENTIAL_OPERATIONS: JSON.stringify(mode === 'same-image-credential' ? { registry: { serviceId: id, operationId } } : {}) } });
    if (mode === 'lost-ack') {
      await expect(run()).rejects.toThrow(); expect(outputs).toEqual([]);
      // A later execution observes the exact accepted deployment and emits its
      // receipt without replaying the uncertain write.
      await run();
      expect(outputs).toContainEqual(['credential_deployments', JSON.stringify([{ serviceId: id, deploymentIds: [revision] }])]);
    }
    else { await run(); expect(outputs).toContainEqual(['credential_deployments', JSON.stringify([{ serviceId: id, deploymentIds: [revision] }])]); }
    expect(writes).toHaveLength(1);
    expect(writes[0].properties.template.revisionSuffix).toBe(suffix);
  });
  it('verifies exact applied native app and registry lifetimes without infrastructure writes', async () => {
    const f = await fixture();
    expect(await f.verify()).toMatchObject({ provider: 'azure', environment: 'staging', targets: [{ workload: 'web', kind: 'service',
      service: { id: f.prepared.workloads[0].id, lifetimeId: f.prepared.workloads[0].lifetimeId }, registry: { id: f.prepared.registry.id, lifetimeId: f.prepared.registry.lifetimeId } }] });
    expect(f.events.every(event => event.method === 'GET')).toBe(true);
  });
  it.each(['bound-uid', 'native-uid', 'identity-access', 'role-widened', 'revoked-grant'] as const)('rejects %s before approval', async change => {
    const f = await fixture(), app = f.resources.get(f.prepared.workloads[0].id);
    if (change === 'bound-uid') f.bindings.environments.staging.platformBindings.services.web.resourceUid = '2024-01-01T00:00:00Z';
    if (change === 'native-uid') app.systemData.createdAt = '2024-01-01T00:00:00Z';
    if (change === 'identity-access') app.properties.configuration.identitySettings[0].lifecycle = 'All';
    if (change === 'role-widened') for (const value of f.resources.values()) if (value.properties?.permissions?.[0]?.actions?.includes('Microsoft.App/containerApps/write'))
      value.properties.permissions[0].actions = [...value.properties.permissions[0].actions, 'Microsoft.App/containerApps/listSecrets/action'];
    if (change === 'revoked-grant') {
      const release = f.connection.principals.release; if (release.kind !== 'azure-managed-identity') throw new Error('Invalid fixture');
      for (const [id, value] of f.resources) if (value.properties?.principalId === release.principalId && value.properties.roleDefinitionId?.endsWith('8311e382-0749-4cb8-b61a-304f252e45ec')) f.resources.delete(id);
    }
    await expect(f.verify()).rejects.toThrow(); expect(f.events.every(event => event.method === 'GET')).toBe(true);
  });
  it('withholds target evidence when authorization is revoked during native reads', async () => {
    const f = await fixture(), native = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, init) => { const response = await native(url, init);
      if (new URL(String(url)).pathname === f.prepared.workloads[0].id) f.authorize.mockResolvedValue(false); return response; });
    await expect(f.verify()).rejects.toThrow(); expect(f.events.every(event => event.method === 'GET')).toBe(true);
  });
  it('accepts the final native configuration only with the exact reviewed references and container identity disabled', async () => {
    const f = await fixture(), app = f.resources.get(f.prepared.workloads[0].id), image = `${f.coordinates.registryServer}/app@sha256:${'e'.repeat(64)}`;
    // Independently authored native ACA 2026-01-01 projection, not the renderer's result.
    app.identity = { type: 'UserAssigned', userAssignedIdentities: { [f.runtime.identityResourceId]: {
      clientId: f.runtime.clientId, principalId: f.runtime.principalId } } };
    app.properties.latestRevisionName = app.properties.latestReadyRevisionName = 'web--application';
    app.properties.configuration = { activeRevisionsMode: 'Single', ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false },
      identitySettings: [{ identity: f.runtime.identityResourceId, lifecycle: 'None' }], registries: [{ server: f.coordinates.registryServer, identity: f.runtime.identityResourceId }],
      secrets: [{ name: 'reference-0', identity: f.runtime.identityResourceId, keyVaultUrl: `https://reviewed-secrets.vault.azure.net/secrets/api-token/${'b'.repeat(32)}` }] };
    app.properties.template = { containers: [{ name: 'main', image, env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'API_TOKEN', secretRef: 'reference-0' },
      { name: 'HYPERVIBE_START_COMMAND', value: 'node server.js' }, { name: 'HYPERVIBE_HEALTH_CHECK_PATH', value: '/health' },
      { name: 'HYPERVIBE_DEPLOY_SHA', value: 'a'.repeat(40) }, { name: 'HYPERVIBE_IMAGE_DIGEST', value: `sha256:${'e'.repeat(64)}` }],
      resources: { cpu: 0.25, memory: '0.5Gi' }, command: ['sh'], args: ['-lc', 'node server.js'],
      probes: [{ type: 'Liveness', httpGet: { path: '/health', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 }] }],
      scale: { minReplicas: 0, maxReplicas: 4 } };
    expect(await f.verify()).toMatchObject({ targets: [{ service: { id: app.id } }] });
    app.properties.configuration.secrets[0].keyVaultUrl = `https://reviewed-secrets.vault.azure.net/secrets/api-token/${'c'.repeat(32)}`;
    await expect(f.verify()).rejects.toThrow();
    expect(f.events.every(event => event.method === 'GET')).toBe(true);
  });
});
