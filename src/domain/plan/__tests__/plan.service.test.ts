import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { PlanService } from '../plan.service.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import type { Project } from '../../entities/project.entity.js';

let project: Project;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  const dir = mkdtempSync(path.join(tmpdir(), 'hypervibe-plan-'));
  SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  project = new ProjectRepository().create({ name: 'plan-test', defaultPlatform: 'railway' });
  new SpecStore().replace(project, {
    version: 1,
    project: project.name,
    environments: {
      staging: {
        hosting: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } },
        envVars: { NODE_ENV: 'staging' },
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockObservingAdapter(observed: ObservedState) {
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({
    success: true,
    adapter: {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
        supportsCronSchedule: true,
        supportsReleaseCommand: false,
        supportsMultiEnvironment: true,
        managedTls: true,
        supportsObserve: true,
      },
      connect: async () => {},
      verify: async () => ({ success: true }),
      ensureProject: async () => ({ success: true, message: 'ok' }),
      ensureComponent: async () => { throw new Error('unused'); },
      deploy: async () => { throw new Error('unused'); },
      setEnvVars: async () => ({ success: true, message: 'ok' }),
      observe: async () => observed,
    },
  });
}

describe('PlanService.plan', () => {
  it('errors when the project has no spec', async () => {
    const bare = new ProjectRepository().create({ name: 'no-spec' });
    const result = await new PlanService().plan(bare, 'staging');
    expect(result).toMatchObject({ error: expect.stringContaining('hv_spec_set') });
  });

  it('errors when the environment is not in the spec', async () => {
    const result = await new PlanService().plan(project, 'production');
    expect(result).toMatchObject({ error: expect.stringContaining('production') });
  });

  it('produces a verified plan from observed state and persists the plan run', async () => {
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1', environmentId: 're-1', services: { web: { serviceId: 's-1' } } },
    });
    new ServiceRepository().create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
    mockObservingAdapter({
      provider: 'railway',
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: 'rp-1',
      environmentId: 're-1',
      services: [{
        name: 'web',
        externalId: 's-1',
        workloadKind: 'web',
        customDomains: [],
        config: { startCommand: 'node old.js' },
        envVarKeys: ['NODE_ENV'],
        envVarHashes: { NODE_ENV: hashEnvValue('staging') },
        status: 'running',
      }],
      databases: [],
      partial: false,
      warnings: [],
    });

    const result = await new PlanService().plan(project, 'staging');
    expect(result).not.toHaveProperty('error');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(true);
    const web = plan.actions.find((a) => a.id === 'service:web')!;
    expect(web.type).toBe('update');
    expect(web.diff).toContainEqual({ field: 'startCommand', from: 'node old.js', to: 'npm start' });

    const run = new RunRepository().findById(plan.planRunId)!;
    expect(run.type).toBe('plan');
    const doc = run.plan as Record<string, unknown>;
    expect(doc.kind).toBe('hv_plan');
    expect(doc.specRevision).toBe(plan.specRevision);
    expect(doc.observedFingerprint).toBeTruthy();
  });

  it('falls back to unverified local diff when the provider has no adapter', async () => {
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(false);
    expect(plan.actions.every((a) => !a.verified)).toBe(true);
    // Untracked environment surfaced as a create action and a local record was made.
    expect(plan.actions.find((a) => a.id === 'environment:staging')?.type).toBe('create');
    expect(new EnvironmentRepository().findByProjectAndName(project.id, 'staging')).toBeTruthy();
  });

  it('reports blocked providers without verified connections', async () => {
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });
    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.blocked).toContainEqual(expect.objectContaining({ provider: 'railway' }));
  });

  it('warns when observation fails for a tracked environment', async () => {
    new EnvironmentRepository().create({
      projectId: project.id,
      name: 'staging',
      platformBindings: { provider: 'railway', projectId: 'rp-1' },
    });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'no connection' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.verified).toBe(false);
    expect(plan.warnings.some((w) => w.includes('Cannot observe'))).toBe(true);
  });

  it('clears blocked when a verified connection exists', async () => {
    const connRepo = new ConnectionRepository();
    const created = connRepo.create({ provider: 'railway', credentialsEncrypted: 'x' });
    connRepo.updateStatus(created.id, 'verified');
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: false, error: 'mock' });

    const result = await new PlanService().plan(project, 'staging');
    const plan = result as Exclude<typeof result, { error: string }>;
    expect(plan.blocked).toEqual([]);
  });
});
