import { describe, expect, it, vi } from 'vitest';
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
describe('Azure prepared release target enrollment', () => {
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
