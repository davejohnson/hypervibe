import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../../../application/providers.js';
import { createCommandRegistry } from '../../../application/commands.js';
import { createCommandContext } from '../../../application/context.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { PlanService } from '../../plan/plan.service.js';
import { ConvergeExecutor } from '../../plan/converge.executor.js';
import { adapterFactory } from '../adapter.factory.js';

// Product limitations, not HTTP fixtures: these intents must never reach a provider.
// DigitalOcean: https://docs.digitalocean.com/products/app-platform/how-to/store-data/
// Vercel: https://vercel.com/docs/functions/runtimes#file-system-support
let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hv-unsupported-volume-'));
  SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

describe('native unsupported filesystem mounts', () => {
  it.each(['digitalocean', 'vercel'])('rejects %s spec before creating project state', async (provider) => {
    const name = `rejected-mount-${provider}`;
    const providerAdapter = vi.spyOn(adapterFactory, 'getProviderAdapter');
    const hostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapter');
    const result = await createCommandRegistry(createCommandContext()).execute('hv_spec', {
      spec: { project: name, environments: { staging: {
        hosting: { provider }, services: { web: { volume: { mountPath: '/data' } } },
      } } },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION', details: {
      path: 'environments.staging.services.web.volume', volumeSupport: 'provider-unsupported',
    } } });
    expect(new ProjectRepository().findByName(name)).toBeNull();
    expect(providerAdapter).not.toHaveBeenCalled();
    expect(hostingAdapter).not.toHaveBeenCalled();
  });

  it.each(['digitalocean', 'vercel'])('rejects %s during planning before adapter resolution or persistence', async (provider) => {
    const project = new ProjectRepository().create({ name: `mount-${provider}` });
    new SpecStore().replace(project, {
      version: 1, project: project.name,
      environments: { staging: { hosting: { provider }, services: { web: { volume: { mountPath: '/data' } } } } },
    });
    const providerAdapter = vi.spyOn(adapterFactory, 'getProviderAdapter');
    const hostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapter');
    const result = await new PlanService().plan(project, 'staging');
    expect(result).toEqual({ error: expect.stringContaining('does not support persistent filesystem mounts') });
    expect(providerAdapter).not.toHaveBeenCalled();
    expect(hostingAdapter).not.toHaveBeenCalled();
    expect(new EnvironmentRepository().findByProjectId(project.id)).toEqual([]);
    expect(new RunRepository().findByProjectId(project.id)).toEqual([]);
  });

  it.each(['digitalocean', 'vercel'])('rejects %s apply before loading a plan or resolving adapters', async (provider) => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: `apply-mount-${provider}` });
    const providerAdapter = vi.spyOn(adapterFactory, 'getProviderAdapter');
    const hostingAdapter = vi.spyOn(adapterFactory, 'getHostingAdapter');
    const loadPlan = vi.spyOn(ConvergeExecutor.prototype, 'loadPlan');
    const result = await executePlanApply(ctx, {
      project, specRevision: 1, planId: 'intentionally-absent', confirmActions: [],
      spec: projectSpecSchema.parse({ version: 1, project: project.name, environments: { staging: {
        hosting: { provider }, services: { web: { volume: { mountPath: '/data' } } },
      } } }),
    });
    expect(result).toMatchObject({ kind: 'invalid_spec', details: { volumeSupport: 'provider-unsupported' } });
    expect(loadPlan).not.toHaveBeenCalled();
    expect(providerAdapter).not.toHaveBeenCalled();
    expect(hostingAdapter).not.toHaveBeenCalled();
    expect(ctx.repos.runs.findByProjectId(project.id)).toEqual([]);
    expect(ctx.repos.environments.findByProjectId(project.id)).toEqual([]);
  });
});
