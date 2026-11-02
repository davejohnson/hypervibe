import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureContainerAppsAdapter } from '../../src/adapters/providers/azure/azure-container-apps.adapter.js';
import { environmentSpecSchema } from '../../src/domain/spec/spec.schema.js';
import type { Environment } from '../../src/domain/entities/environment.entity.js';
import type { Service } from '../../src/domain/entities/service.entity.js';
import { azurePreparedFixture } from './helpers/azure-prepared-fixture.js';
import { azurePreparedCoordinates, azurePreparedGrantId } from '../../src/adapters/providers/azure/azure-prepared-hosting.js';
import { observeRuntimeAccess, planRuntimeAccess } from '../../src/domain/services/runtime-access.service.js';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const f = await azurePreparedFixture(true), connection = f.driver.deployment!.connection(f.installed), principal = connection.principals.provision;
  if (principal.kind !== 'azure-managed-identity') throw new Error('Invalid native fixture');
  vi.stubGlobal('fetch', f.request);
  const adapter = new AzureContainerAppsAdapter();
  await adapter.connectTransient({ connection, capability: 'provision', authentication: { kind: 'azure-federation', principal,
    getAccessToken: async () => ({ token: 'synthetic-private-deployer-token', expiresAt: new Date(Date.now() + 300000).toISOString() }) } });
  const now = new Date(), environment: Environment = { id: 'local-staging-id', projectId: 'local-project', name: 'staging', createdAt: now, updatedAt: now, platformBindings: {} };
  const references = Object.fromEntries(connection.deployment.workloads[0].runtimeSecrets.map(item => [item.key, item.reference]));
  const environmentSpec = environmentSpecSchema.parse({ hosting: { provider: 'azure-container-apps', region: 'eastus' }, services: { web: { workloadKind: 'web', startCommand: 'node server.js', healthCheckPath: '/health' } },
    envVars: { NODE_ENV: 'production' }, secretDestinations: references });
  const service: Service = { id: 'local-web-id', projectId: environment.projectId, name: 'web', buildConfig: { workloadKind: 'web', startCommand: 'node server.js', healthCheckPath: '/health' }, envVarSpec: {}, createdAt: now, updatedAt: now };
  return { ...f, connection, adapter, environment, environmentSpec, service, references };
}
describe('Azure native prepared resources enter the shared first-release lifecycle', () => {
  it('binds the installed native namespace through the first local project stage without creating or granting anything', async () => {
    const f = await fixture(), before = f.events.filter(event => event.method !== 'GET').length;
    expect(await f.adapter.ensureProject('sequence', f.environment)).toMatchObject({ success: true, data: { projectId: f.connection.preparedResources!.project.parentId,
      environmentId: f.connection.preparedResources!.project.id, providerBindings: { providerScope: { registryResourceId: f.connection.preparedResources!.registry.id } } } });
    expect(f.environment.platformBindings).toEqual({});
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(before);
  });
  it('does not rearm a later holding revision that resembles the originally installed workload', async () => {
    const f = await fixture(), app = f.resources.get(f.connection.preparedResources!.workloads[0].id);
    app.properties.latestReadyRevisionName = app.properties.latestRevisionName = 'web--later-lookalike';
    expect((await f.adapter.preparedHosting!.inspect({ environment: f.environment, environmentSpec: f.environmentSpec })).state).toBe('unknown');
  });
  it('rejects omitted reviewed references at the initial read-only binding boundary', async () => {
    const f = await fixture();
    f.environmentSpec.secretDestinations = {};
    const observed = await f.adapter.preparedHosting!.inspect({ environment: f.environment, environmentSpec: f.environmentSpec });
    expect(observed.state).toBe('unknown');
  });
  it('rechecks the installed ACR reader grant after metadata binding and never repairs revocation', async () => {
    const f = await fixture(), observed = await f.adapter.preparedHosting!.inspect({ environment: f.environment, environmentSpec: f.environmentSpec });
    if (observed.state !== 'verified') throw new Error('Missing native preparation');
    f.environment.platformBindings = { ...observed.bindings, preparedHosting: observed.preparation };
    const c = azurePreparedCoordinates(f.connection);
    f.resources.delete(azurePreparedGrantId(c.owner, 'runtime-web:pull', c.registry));
    const before = f.events.filter(event => event.method !== 'GET').length;
    const runtime = await f.adapter.runtimeIdentities.inspect({ environment: f.environment, environmentSpec: f.environmentSpec, service: f.service, mode: 'ensure' });
    expect(runtime.state).toBe('unknown');
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(before);
  });
  it('verifies native lifetimes and returns a read-only exact binding with pending first configuration', async () => {
    const f = await fixture(), before = f.events.filter(event => event.method !== 'GET').length;
    const observed = await (f.adapter as any).preparedHosting?.inspect({ environment: f.environment, environmentSpec: f.environmentSpec });
    expect(observed).toMatchObject({ state: 'verified', bindings: { projectId: f.connection.preparedResources!.project.parentId,
      environmentId: f.connection.preparedResources!.project.id, services: { web: { serviceId: f.connection.preparedResources!.workloads[0].id,
        resourceUid: f.connection.preparedResources!.workloads[0].lifetimeId, imageUri: f.connection.deployment.preparation!.image } } },
      preparation: { pendingFirstRelease: ['web'], firstReleaseConfigurationDigests: { web: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(before);
  });
  it('binds an installed runtime reader without attaching it to holding code or writing IAM', async () => {
    const f = await fixture(), observed = await (f.adapter as any).preparedHosting?.inspect({ environment: f.environment, environmentSpec: f.environmentSpec });
    expect(observed?.state).toBe('verified');
    f.environment.platformBindings = { ...observed.bindings, preparedHosting: observed.preparation };
    const before = f.events.filter(event => event.method !== 'GET').length;
    const request = { environment: f.environment, environmentSpec: f.environmentSpec, service: f.service, mode: 'ensure' as const };
    const shared = await observeRuntimeAccess({ environment: f.environment, environmentSpec: f.environmentSpec, hosting: f.adapter, storageAdapters: {} });
    expect(planRuntimeAccess(shared)).toMatchObject([{ verified: true, metadata: { operation: 'runtimeIdentity', serviceName: 'web' } }]);
    const runtime = await f.adapter.runtimeIdentities.inspect(request);
    expect(runtime).toMatchObject({ state: 'action', step: { target: { phase: 'bind-existing' } } });
    if (runtime.state !== 'action') throw new Error('Missing reviewed native reader');
    const bound = await f.adapter.runtimeIdentities.apply({ ...request, step: runtime.step, attemptId: '77777777-7777-4777-8777-777777777777' });
    expect(bound.receipt.success).toBe(true);
    f.environment.platformBindings.runtimeIdentities = { web: bound.binding! };
    const result = await f.adapter.deploy(f.service, f.environment, { NODE_ENV: 'production' }, { deferDeployment: true, secretVersionRefs: f.references });
    expect(result.receipt).toMatchObject({ success: true, data: { runtimeRolloutRequired: true, deploymentDeferred: true, rolloutBaseline: { state: 'present', deploymentId: 'web--holding' } } });
    expect(f.events.filter(event => event.method !== 'GET')).toHaveLength(before);
    const app = f.resources.get(f.connection.preparedResources!.workloads[0].id);
    expect(app.properties.configuration.secrets).toEqual([]);
  });
});
