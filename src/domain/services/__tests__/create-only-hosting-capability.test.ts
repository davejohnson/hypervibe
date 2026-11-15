import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { RailwayAdapter } from '../../../adapters/providers/railway/railway.adapter.js';
import { CloudRunAdapter } from '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { EcsExpressAdapter } from '../../../adapters/providers/aws/ecs-express.adapter.js';
import { AzureContainerAppsAdapter } from '../../../adapters/providers/azure/azure-container-apps.adapter.js';
import type { IProviderAdapter, IProviderLifecycleAdapter, ProviderCapabilities } from '../../ports/provider.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { adapterFactory } from '../adapter.factory.js';
import { executeBootstrap } from '../bootstrap.service.js';
import { DeployOrchestrator } from '../deploy.orchestrator.js';

// Constructors only; no credentials or provider requests. Deferred deployment
// allows reconfiguration of an existing workload and is not create-only proof.
const adapters: Record<string, IProviderAdapter> = {
  railway: new RailwayAdapter(), cloudrun: new CloudRunAdapter(),
  ecs: new EcsExpressAdapter(), 'azure-container-apps': new AzureContainerAppsAdapter(),
};
const unsupported = ['cloudrun', 'ecs', 'azure-container-apps'];

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(':memory:').migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); });

function fixture(provider: string, capabilities: ProviderCapabilities = adapters[provider].capabilities) {
  const project = new ProjectRepository().create({ name: 'create-only-contract', defaultPlatform: provider });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging',
    platformBindings: { provider, projectId: 'native-project', environmentId: 'native-environment', services: {} } });
  const service = new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {} });
  const ensureProject = vi.fn(async () => ({ success: true, message: 'Unexpected project mutation' }));
  const setEnvVars = vi.fn(async () => ({ success: true, message: 'Unexpected environment mutation' }));
  const deploy = vi.fn(async () => ({ serviceId: service.id, externalId: 'new-workload', status: 'configured' as const,
    receipt: { success: true, message: 'Unexpected workload mutation' } }));
  const adapter = { name: provider, capabilities, ensureProject, setEnvVars, deploy } as unknown as IProviderLifecycleAdapter;
  return { project, environment, service, adapter, ensureProject, setEnvVars, deploy };
}

describe('creation-only hosting admission', () => {
  it('checks deferred cron activation against every registered hosting workload contract', () => {
    expect(providerRegistry.namesFor('hosting')).toEqual(['railway']);
    for (const [provider, adapter] of Object.entries(adapters)) {
      expect(providerRegistry.supportsWorkloadKind(provider, 'cron'), provider).toBe(provider === 'railway');
      expect(adapter.capabilities.supportsDeferredCronActivation === true, provider).toBe(false);
      expect(typeof adapter.activateSchedule === 'function', provider).toBe(false);
    }
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

  it('rejects creation-only bootstrap without an explicit adapter capability before provider effects', async () => {
    const f = fixture('railway', { ...adapters.railway.capabilities, supportsCreateOnlyDeploy: undefined });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: f.adapter as never });
    const result = await executeBootstrap({ projectName: f.project.name, environmentName: f.environment.name,
      services: ['web'], envVars: { TEST_SETTING: 'present' }, provisionOnly: true, requireNewWorkload: true });
    expect(result.success).toBe(false);
    expect(result.summary.error).toMatch(/creation.only|create.only/i);
    expect(f.ensureProject).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
  });

  it('rejects creation-only bootstrap unless provisionOnly is explicitly set', async () => {
    const f = fixture('railway', { ...adapters.railway.capabilities, supportsCreateOnlyDeploy: true });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: f.adapter as never });
    const result = await executeBootstrap({ projectName: f.project.name, environmentName: f.environment.name,
      services: ['web'], requireNewWorkload: true });
    expect(result.success).toBe(false);
    expect(result.summary.error).toMatch(/creation.only|create.only/i);
    expect(f.ensureProject).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
  });

  it('rejects creation-only orchestration unless provider deployment is explicitly deferred', async () => {
    const f = fixture('railway', { ...adapters.railway.capabilities, supportsCreateOnlyDeploy: true });
    const result = await new DeployOrchestrator().execute({ project: f.project, environment: f.environment,
      adapter: f.adapter, services: [f.service], requireNewWorkload: true });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/creation.only|create.only/i);
    expect(f.ensureProject).not.toHaveBeenCalled(); expect(f.setEnvVars).not.toHaveBeenCalled(); expect(f.deploy).not.toHaveBeenCalled();
  });
});
