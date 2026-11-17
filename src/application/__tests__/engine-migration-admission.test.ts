import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { projectSpecSchema, type EnvironmentSpec } from '../../domain/spec/spec.schema.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { CommandRegistry } from '../commands.js';
import { createCommandContext } from '../context.js';
import { planAwsInfrastructureEngine } from '../infrastructure-engine-aws.js';
import { planAzureInfrastructureEngine } from '../infrastructure-engine-azure.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-migration-admission-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in migration admission tests'); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(provider: 'cloudrun' | 'aws' | 'azure', migrations?: EnvironmentSpec['migrations']) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'migration-admission', defaultPlatform: provider });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: {
    testing: { hosting: { provider }, services: { web: {} }, ...(migrations ? { migrations } : {}) },
  } });
  const commands = new CommandRegistry();
  registerCoreTools(commands, ctx);
  const connections = vi.spyOn(ConnectionRepository.prototype, 'findBestVerifiedMatch').mockReturnValue(null);
  return { ctx, project, spec, commands, connections };
}

// Independent contracts: unsupported desired state is refused before effects
// (support-matrix.md); release commands precede runtime workload changes (DG-050).
// Keep command validation, persistence and provider planners real. Missing access
// is a counterexample: admission must explain migrations before asking to connect.
describe('release migration admission', () => {
  for (const [provider, cloud, planner] of [
    ['aws', 'AWS', planAwsInfrastructureEngine],
    ['azure', 'Azure', planAzureInfrastructureEngine],
  ] as const) {
    it(`rejects new ${cloud} release migrations before saving the spec or resolving access`, async () => {
      const f = fixture(provider, { mode: 'releaseCommand', command: 'npm run migrate' });
      const result = await f.commands.execute('hv_spec', { project: f.project.name, spec: f.spec });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain(`migrations.mode=\\"releaseCommand\\" is not yet supported on ${cloud}`);
      expect(new ProjectSpecRepository().findLatest(f.project.id)).toBeNull();
      expect(f.connections).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it(`refuses persisted ${cloud} release migrations in every infrastructure planning entry before access`, async () => {
      const f = fixture(provider, { mode: 'releaseCommand', command: 'npm run migrate' });
      // Specs saved before the admission fix must not reach first-image builds
      // and workload creation through either command routing or the provider planner.
      new ProjectSpecRepository().insert(f.project.id, 1, f.spec);
      for (const scope of [undefined, 'full', 'infrastructure'] as const) {
        const result = await f.commands.execute('hv_plan', { project: f.project.name, env: 'testing', ...(scope ? { scope } : {}) });
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).toContain(`migrations.mode=\\"releaseCommand\\" is not yet supported on ${cloud}`);
      }
      const direct = await planner(f.ctx, { project: f.project, spec: f.spec, environmentName: 'testing', specRevision: 1 });
      expect(direct).toMatchObject({ blocked: [expect.stringContaining(`migrations.mode="releaseCommand" is not yet supported on ${cloud}`)] });
      expect(f.connections).not.toHaveBeenCalled();
      expect(f.ctx.repos.runs.findByProjectId(f.project.id)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it(`does not recommend unsupported release commands for ${cloud} tool migrations`, async () => {
      const f = fixture(provider, { mode: 'tool', command: 'npm run migrate' });
      const result = await f.commands.execute('hv_spec', { project: f.project.name, spec: f.spec });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain('migrations.mode=\\"tool\\" is not yet supported');
      expect(JSON.stringify(result)).not.toContain('use \\"releaseCommand\\"');
      expect(f.connections).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([undefined, { mode: 'none' } as const])(`keeps ordinary ${cloud} environments admitted with migrations=%j`, async migrations => {
      const f = fixture(provider, migrations);
      expect((await f.commands.execute('hv_spec', { project: f.project.name, spec: f.spec })).ok).toBe(true);
      f.connections.mockClear();
      const result = await planner(f.ctx, { project: f.project, spec: f.spec, environmentName: 'testing', specRevision: 1 });
      expect(result).toMatchObject({ blocked: [expect.stringContaining(`no ${cloud} access`)] });
      expect(f.connections).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it('keeps a valid Google Cloud release command available', async () => {
    const f = fixture('cloudrun', { mode: 'releaseCommand', command: 'npm run migrate' });
    expect((await f.commands.execute('hv_spec', { project: f.project.name, spec: f.spec })).ok).toBe(true);
    expect(new ProjectSpecRepository().findLatest(f.project.id)?.document).toMatchObject({ environments: {
      testing: { migrations: { mode: 'releaseCommand', command: 'npm run migrate' } },
    } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
