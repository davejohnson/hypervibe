import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import * as engine from '../infrastructure-engine.js';
import * as awsEngine from '../infrastructure-engine-aws.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-engine-plan-routing-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in command routing tests'); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(provider: 'aws' | 'cloudrun' | 'railway') {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'engine-plan-routing', defaultPlatform: provider });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    staging: { hosting: { provider, ...(provider === 'aws' ? { engine: 'opentofu' } : {}) }, services: { web: {} } },
  } });
  new ProjectSpecRepository().insert(project.id, 1, spec);
  const commands = new CommandRegistry();
  registerCoreTools(commands, ctx);
  const infrastructure = vi.spyOn(engine, 'planInfrastructureEngine').mockResolvedValue({ blocked: ['INFRASTRUCTURE_REACHED'] });
  const teardown = vi.spyOn(awsEngine, 'planAwsTeardown').mockResolvedValue({ blocked: ['AWS_TEARDOWN_REACHED'] });
  const scoped = vi.spyOn(PlanService.prototype, 'plan').mockResolvedValue({ error: 'SCOPED_PLANNER_REACHED' } as never);
  return { ctx, project, spec, commands, infrastructure, teardown, scoped };
}

// Contracts: GCP selects its engine automatically (ARCHITECTURE.md); AWS teardown
// includes optional final-snapshot deletion, including after spec removal
// (docs/opentofu-engine-aws.md). Terminal planners are replaced to forbid writes;
// the public command validation, persisted spec selection and dispatch stay real.
describe('engine hv_plan command boundaries', () => {
  it.each([undefined, false, true])('reaches AWS teardown with deleteFinalSnapshot=%s', async deleteFinalSnapshot => {
    const f = fixture('aws');
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'teardown',
      ...(deleteFinalSnapshot !== undefined ? { deleteFinalSnapshot } : {}) });
    expect(result).toMatchObject({ ok: false, error: { details: { blocked: ['AWS_TEARDOWN_REACHED'] } } });
    expect(f.teardown).toHaveBeenCalledExactlyOnceWith(f.ctx, {
      project: expect.objectContaining({ id: f.project.id }), spec: f.spec, specRevision: 1, environmentName: 'staging',
      ...(deleteFinalSnapshot ? { deleteFinalSnapshot } : {}),
    });
    expect(f.infrastructure).not.toHaveBeenCalled();
    expect(f.scoped).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps final snapshot cleanup reachable after the AWS environment leaves the spec', async () => {
    const f = fixture('aws');
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'removed-environment',
      scope: 'teardown', deleteFinalSnapshot: true });
    expect(result).toMatchObject({ ok: false, error: { details: { blocked: ['AWS_TEARDOWN_REACHED'] } } });
    expect(f.teardown).toHaveBeenCalledWith(f.ctx, expect.objectContaining({ environmentName: 'removed-environment', deleteFinalSnapshot: true }));
    expect(f.infrastructure).not.toHaveBeenCalled();
    expect(f.scoped).not.toHaveBeenCalled();
  });

  it('keeps AWS explicit infrastructure dispatch available', async () => {
    const f = fixture('aws');
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'infrastructure' });
    expect(result).toMatchObject({ ok: false, error: { details: { blocked: ['INFRASTRUCTURE_REACHED'] } } });
    expect(f.infrastructure).toHaveBeenCalledOnce();
    expect(f.teardown).not.toHaveBeenCalled();
    expect(f.scoped).not.toHaveBeenCalled();
  });

  it('does not apply Cloud Run-only scope guards to AWS', async () => {
    const f = fixture('aws');
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'backups' });
    expect(result).toMatchObject({ ok: false, error: { message: 'SCOPED_PLANNER_REACHED' } });
    expect(f.scoped).toHaveBeenCalledOnce();
    expect(f.infrastructure).not.toHaveBeenCalled();
    expect(f.teardown).not.toHaveBeenCalled();
  });

  it.each(['cloudrun', 'railway'] as const)('rejects teardown of %s before any planner', async provider => {
    const f = fixture(provider);
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'teardown' });
    expect(result.ok).toBe(false);
    expect(f.infrastructure).not.toHaveBeenCalled();
    expect(f.teardown).not.toHaveBeenCalled();
    expect(f.scoped).not.toHaveBeenCalled();
  });

  it.each([
    ['cloudrun', undefined], ['cloudrun', 'full'], ['cloudrun', 'credentials'],
    ['aws', 'full'], ['aws', 'infrastructure'], ['aws', 'credentials'],
    ['railway', undefined], ['railway', 'backups'],
  ] as const)('rejects teardown-only inputs for %s scope=%s', async (provider, scope) => {
    const f = fixture(provider);
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging',
      ...(scope ? { scope } : {}), deleteFinalSnapshot: false });
    expect(result).toMatchObject({ ok: false, error: { message: 'deleteFinalSnapshot applies to scope="teardown" only.' } });
    expect(f.infrastructure).not.toHaveBeenCalled();
    expect(f.teardown).not.toHaveBeenCalled();
    expect(f.scoped).not.toHaveBeenCalled();
  });

  it.each([
    { services: [] }, { envVars: {} }, { envFile: '' }, { includeEnvFile: false },
    { secretRefs: {} }, { credential: 'database-login' }, { intent: 'rotate' },
  ])('rejects deploy/credential inputs on AWS teardown: %j', async input => {
    const f = fixture('aws');
    const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'staging', scope: 'teardown', ...input });
    expect(result.ok).toBe(false);
    expect(f.infrastructure).not.toHaveBeenCalled();
    expect(f.teardown).not.toHaveBeenCalled();
    expect(f.scoped).not.toHaveBeenCalled();
  });
});
