import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { DeployOrchestrator } from '../deploy.orchestrator.js';
import type { IProviderAdapter } from '../../ports/provider.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';

beforeEach(() => { SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(':memory:').migrate(); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); });
afterEach(() => { SqliteAdapter.resetInstance(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function setup(withDisk: boolean) {
  const project = new ProjectRepository().create({ name: 'mount-bootstrap', defaultPlatform: 'fly' });
  const target = { projectId: 'app-owner', environmentId: 'staging', serviceId: 'empty-app', mountPath: '/data', instanceScope: { region: 'ord', sizeGb: '1', serviceName: 'web' } };
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'fly', projectId: 'app-owner', environmentId: 'staging', services: { web: { serviceId: 'empty-app' } },
    ...(withDisk ? { serviceVolumes: { web: { provider: 'fly', target, state: 'staged', components: { filesystem: { state: 'bound', externalId: 'volume-ack' } } } } } : {}),
  } });
  const service = new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: { builder: 'dockerfile' } });
  const deploy = vi.fn(async () => ({ serviceId: service.id, externalId: 'empty-app', status: 'ready', receipt: { success: true, message: 'fixture', data: { deploymentDeferred: true } } }));
  const adapter = { name: 'fly', capabilities: { supportsDeferredDeploy: true }, deploy,
    serviceVolumes: { staged: { runtimeMount: (t: typeof target, bindings: Record<string, { externalId: string }>) => ({ externalId: bindings.filesystem.externalId, mountPath: t.mountPath, target: t }) } },
  } as unknown as IProviderAdapter;
  vi.spyOn(providerRegistry, 'getMetadata').mockReturnValue({ lifecycle: { hosting: { serviceVolumes: { workloadKinds: ['web'], retention: 'retain-only', attachmentTiming: 'workload-create' } } } } as never);
  return { project, environment, service, adapter, deploy, target };
}

it('passes app-only authority independently of code-deployment deferral', async () => {
  const f = setup(false);
  const outcome = await new DeployOrchestrator().execute({ project: f.project, environment: f.environment, services: [f.service], adapter: f.adapter, ensureProject: false, deferProviderDeployment: true, deferWorkload: true } as any);
  expect(outcome.success).toBe(true);
  expect(f.deploy).toHaveBeenCalledWith(f.service, expect.anything(), {}, expect.objectContaining({ deferDeployment: true, deferWorkload: true }));
});

it('passes acknowledged backing identity on subsequent workload creation, not just a mount path', async () => {
  const f = setup(true);
  const outcome = await new DeployOrchestrator().execute({ project: f.project, environment: f.environment, services: [f.service], adapter: f.adapter, ensureProject: false, deferProviderDeployment: true });
  expect(outcome.success).toBe(true);
  expect(f.deploy).toHaveBeenCalledWith(f.service, expect.anything(), {}, expect.objectContaining({ serviceVolume: { externalId: 'volume-ack', mountPath: '/data', target: f.target } }));
});

it('refuses unresolved disk state before invoking workload deploy', async () => {
  const f = setup(true);
  new EnvironmentRepository().updatePlatformBindings(f.environment.id, { serviceVolumes: { web: { provider: 'fly', target: f.target, state: 'staged', components: { filesystem: { state: 'creating' } } } } });
  const outcome = await new DeployOrchestrator().execute({ project: f.project, environment: f.environment, services: [f.service], adapter: f.adapter, ensureProject: false, deferProviderDeployment: true });
  expect(outcome.success).toBe(false);
  expect(f.deploy).not.toHaveBeenCalled();
});
