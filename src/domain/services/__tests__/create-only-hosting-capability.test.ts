import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { RailwayAdapter } from '../../../adapters/providers/railway/railway.adapter.js';
import { FlyAdapter } from '../../../adapters/providers/fly/fly.adapter.js';
import { CloudRunAdapter } from '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../../../adapters/providers/aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../../../adapters/providers/azure/azure-container-apps.adapter.js';
import { DigitalOceanAdapter } from '../../../adapters/providers/digitalocean/digitalocean.adapter.js';
import { VercelAdapter } from '../../../adapters/providers/vercel/vercel.adapter.js';
import type { IProviderAdapter, ProviderCapabilities } from '../../ports/provider.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { adapterFactory } from '../adapter.factory.js';
import { executeBootstrap } from '../bootstrap.service.js';
import { DeployOrchestrator } from '../deploy.orchestrator.js';
import { CLOUD_PREPARE_PROFILES } from '../cloud-prepare.js';

// Constructors only; no credentials or provider requests. Deferred deployment
// allows reconfiguration of an existing workload and is not create-only proof.
const adapters: Record<string, IProviderAdapter> = {
  railway: new RailwayAdapter(), fly: new FlyAdapter(), cloudrun: new CloudRunAdapter(),
  ecs: new EcsExpressAdapter(), 'azure-container-apps': new AzureContainerAppsAdapter(),
  digitalocean: new DigitalOceanAdapter(), vercel: new VercelAdapter(),
};
// These admission expectations accompany the native create-vs-existing tests in
// cloudrun-secret-references.test.ts and ecs-secret-references.test.ts. Cloud Run
// POST service creation and ECS CreateExpressGatewayService refuse existing
// workloads; ACA's current PUT path has no verified creation-only condition.
const supported = ['railway', 'fly', 'cloudrun', 'ecs'];
const unsupported = ['azure-container-apps', 'digitalocean', 'vercel'];

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(':memory:').migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); });

function fixture(provider: string, capabilities: ProviderCapabilities = adapters[provider].capabilities) {
  const profile = CLOUD_PREPARE_PROFILES.cloudrun;
  const project = new ProjectRepository().create({ name: 'create-only-contract', defaultPlatform: provider,
    ...(provider === 'cloudrun' ? { policies: { cloudPreparation: { cloudrun: {
      provider: 'cloudrun', version: profile.version, preparedAt: new Date().toISOString(),
      gcpProjectId: 'native-project', deployServiceAccountEmail: 'deploy@native-project.iam.gserviceaccount.com',
      requiredApis: profile.requiredApis, requiredRoles: profile.requiredRoles,
    } } } } : {}),
  });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging',
    platformBindings: { provider, projectId: 'native-project', environmentId: 'native-environment', services: {} } });
  const service = new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {} });
  const ensureProject = vi.fn(async () => ({ success: true, message: 'Unexpected project mutation' }));
  const setEnvVars = vi.fn(async () => ({ success: true, message: 'Unexpected environment mutation' }));
  const deploy = vi.fn(async () => ({ serviceId: service.id, externalId: 'new-workload', status: 'configured' as const,
    receipt: { success: true, message: 'Unexpected workload mutation' } }));
  const adapter = { name: provider, capabilities, ensureProject, setEnvVars, deploy } as unknown as IProviderAdapter;
  return { project, environment, service, adapter, ensureProject, setEnvVars, deploy };
}

describe('creation-only hosting admission', () => {
  it('checks deferred cron activation against every registered hosting workload contract', () => {
    expect(Object.keys(adapters).sort()).toEqual(providerRegistry.namesFor('hosting').sort());
    const cronProviders = ['railway', 'cloudrun', 'digitalocean'];
    for (const [provider, adapter] of Object.entries(adapters)) {
      expect(providerRegistry.getMetadata(provider)?.lifecycle?.hosting?.workloadKinds.includes('cron'), provider).toBe(cronProviders.includes(provider));
      expect(adapter.capabilities.supportsDeferredCronActivation === true, provider).toBe(provider === 'cloudrun');
      expect(typeof adapter.activateSchedule === 'function', provider).toBe(provider === 'cloudrun');
    }
  });

  it('accounts for every named hosting adapter and admits only implemented creation-only boundaries', () => {
    expect(Object.keys(adapters).sort()).toEqual(providerRegistry.namesFor('hosting').sort());
    for (const [provider, adapter] of Object.entries(adapters)) {
      expect(Boolean(adapter.capabilities.supportsCreateOnlyDeploy), provider).toBe(supported.includes(provider));
    }
  });

  it.each(['cloudrun', 'ecs'])('passes %s references only into the explicitly guarded creation payload', async provider => {
    const f = fixture(provider);
    const reference = provider === 'cloudrun'
      ? { destination: { provider: 'gcp-secret-manager' as const, projectId: 'synthetic-project', projectNumber: '123456789012', secretId: 'api-token' }, version: '7' }
      : { destination: { provider: 'aws-secrets' as const, accountId: '123456789012', region: 'us-east-1', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:api-token-AbCdEf' }, version: 'a'.repeat(32) };
    expect(providerRegistry.getMetadata(provider)?.supportsCreateOnlyDeploy).toBe(true);
    const result = await new DeployOrchestrator().execute({ project: f.project, environment: f.environment,
      adapter: f.adapter, services: [f.service], ensureProject: false,
      envVars: { TEST_SETTING: 'present' }, secretVersionRefs: { API_TOKEN: reference },
      requireNewWorkload: true, deferProviderDeployment: true });
    expect(result.success, result.errors.join(' ')).toBe(true);
    expect(f.ensureProject).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled();
    expect(f.deploy).toHaveBeenCalledExactlyOnceWith(f.service, f.environment, { TEST_SETTING: 'present' }, {
      deferDeployment: true, requireNewWorkload: true, secretVersionRefs: { API_TOKEN: reference },
    });
    expect(new EnvironmentRepository().findById(f.environment.id)?.platformBindings.services).toMatchObject({ web: { serviceId: 'new-workload' } });
  });

  it.each(unsupported)('rejects %s creation-only orchestration before any provider effect', async provider => {
    const f = fixture(provider);
    const result = await new DeployOrchestrator().execute({ project: f.project, environment: f.environment,
      adapter: f.adapter, services: [f.service],
      envVars: { TEST_SETTING: 'present' }, requireNewWorkload: true, deferProviderDeployment: true });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/creation.only|create.only/i);
    expect(f.ensureProject).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
  });

  it.each(supported)('rejects %s creation-only bootstrap without an explicit adapter capability before provider effects', async provider => {
    const f = fixture(provider, { ...adapters[provider].capabilities, supportsCreateOnlyDeploy: undefined });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: f.adapter as never });
    const result = await executeBootstrap({ projectName: f.project.name, environmentName: f.environment.name,
      services: ['web'], envVars: { TEST_SETTING: 'present' }, provisionOnly: true, requireNewWorkload: true });
    expect(result.success).toBe(false);
    expect(result.summary.error).toMatch(/creation.only|create.only/i);
    expect(f.ensureProject).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
  });

  it.each(supported)('rejects %s creation-only bootstrap unless provisionOnly is explicitly set', async provider => {
    const f = fixture(provider);
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: f.adapter as never });
    const result = await executeBootstrap({ projectName: f.project.name, environmentName: f.environment.name,
      services: ['web'], requireNewWorkload: true });
    expect(result.success).toBe(false);
    expect(result.summary.error).toMatch(/creation.only|create.only/i);
    expect(f.ensureProject).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
  });

  it.each(supported)('rejects %s creation-only orchestration unless provider deployment is explicitly deferred', async provider => {
    const f = fixture(provider);
    const result = await new DeployOrchestrator().execute({ project: f.project, environment: f.environment,
      adapter: f.adapter, services: [f.service], requireNewWorkload: true });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/creation.only|create.only/i);
    expect(f.ensureProject).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
  });
});
