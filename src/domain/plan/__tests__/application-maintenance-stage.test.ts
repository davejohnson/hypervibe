import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { PublicDnsClient } from '../../../adapters/dns/public-dns.client.js';
import '../../../adapters/providers/railway/railway.adapter.js';
import type { ObservedState } from '../../ports/observe.port.js';
import type { IProviderAdapter } from '../../ports/provider.port.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import * as maintenanceService from '../../services/environment-maintenance.service.js';
import { PlanService } from '../plan.service.js';

let directory: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-paused-plan-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.spyOn(PublicDnsClient.prototype, 'query').mockResolvedValue({ status: 'unknown' });
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function pausedApplication() {
  const project = new ProjectRepository().create({
    name: 'paused-app', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/example/paused-app',
  });
  for (const provider of ['railway', 'cloudflare']) {
    const connections = new ConnectionRepository();
    const connection = connections.create({ provider, credentialsEncrypted: 'unused-at-stubbed-provider-boundary' });
    connections.updateStatus(connection.id, 'verified');
  }
  const spec = {
    version: 1 as const, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    environments: { production: {
      hosting: { provider: 'railway' },
      domain: 'app.example.com',
      deploy: { strategy: 'branch' as const, trigger: 'native' as const, branch: 'release' },
      services: { web: { startCommand: 'npm run new-server' } },
      envVars: { APP_VERSION: 'new-version' },
      maintenance: { enabled: true, mode: 'application' as const },
    } },
  };
  new SpecStore().replace(project, spec);
  const environments = new EnvironmentRepository();
  const environment = environments.create({
    projectId: project.id, name: 'production',
    platformBindings: {
      provider: 'railway', projectId: 'provider-project', environmentId: 'provider-environment',
      services: { web: { serviceId: 'web-id' } },
      maintenance: {
        state: 'active', mode: 'application',
        edge: {
          hostname: 'app.example.com', accountId: 'account-id', zoneId: 'zone-id',
          routeId: 'route-id', scriptName: 'maintenance-script', contentHash: 'reviewed-content',
        },
        workloads: { web: { serviceId: 'web-id', workloadKind: 'web', wasRunning: true, numReplicas: 2 } },
      },
    },
  });
  const observed: ObservedState = {
    provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
    projectId: 'provider-project', environmentId: 'provider-environment',
    services: [{
      name: 'web', externalId: 'web-id', workloadKind: 'web', customDomains: [],
      config: { startCommand: 'npm run old-server' },
      source: { repo: 'example/paused-app', branch: 'old-release' }, sourceState: 'connected',
      envVarKeys: [], envVarHashes: {}, status: 'empty',
      maintenance: { state: 'suspended', numReplicas: 0 },
    }],
    databases: [], partial: false, warnings: [],
  };
  const adapter = {
    name: 'railway',
    capabilities: { supportsObserve: true },
    observe: vi.fn(async () => structuredClone(observed)),
    isGitHubRepoAccessible: vi.fn(async () => true),
  } as unknown as IProviderAdapter;
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter });
  vi.spyOn(maintenanceService, 'observeEnvironmentMaintenance').mockResolvedValue({
    state: 'active', mode: 'application', stage: 'verified',
    edge: { state: 'active', hostname: 'app.example.com', markerVerified: true },
    workloads: { web: { state: 'suspended', serviceId: 'web-id', workloadKind: 'web', numReplicas: 0 } },
    database: { state: 'unmanaged' },
  });
  return { project, spec, environment, environments };
}

describe('settled application maintenance remains an isolated full-plan stage', () => {
  it('keeps a paused app on maintenance noops despite desired runtime, source, env and domain drift', async () => {
    const { project } = pausedApplication();
    const result = await new PlanService().plan(project, 'production');
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions.every((action) => action.resource.kind === 'maintenance')).toBe(true);
    expect(result.actions.every((action) => action.type === 'noop')).toBe(true);
    expect(result.actions.map((action) => action.metadata?.operation)).toEqual([
      'maintenanceEdgeEnable', 'maintenanceWorkloadSuspend', 'maintenanceVerifyEnter',
    ]);
    expect(new RunRepository().findById(result.planRunId)?.plan).toMatchObject({ actions: result.actions });
  });

  it('rejects a service-filtered plan while the application pause is active and settled', async () => {
    const { project } = pausedApplication();
    const result = await new PlanService().plan(project, 'production', { serviceFilter: ['web'] });
    expect(result).toMatchObject({ error: expect.stringMatching(/maintenance.*full environment plan/i) });
  });

  it('exposes the same desired drift when no application pause is requested or bound', async () => {
    const { project, spec, environment, environments } = pausedApplication();
    const { maintenance: _intent, ...normal } = spec.environments.production;
    new SpecStore().replace(project, { ...spec, environments: { production: normal } });
    const { maintenance: _binding, ...platformBindings } = environment.platformBindings;
    environments.update(environment.id, { platformBindings });
    const result = await new PlanService().plan(project, 'production');
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.actions.some((action) => action.resource.kind === 'service' && action.type !== 'noop')).toBe(true);
    expect(result.actions.some((action) => action.resource.kind === 'maintenance')).toBe(false);
  });
});
