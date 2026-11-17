import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../application/context.js';
import { createCommandRegistry } from '../../application/commands.js';
import { SpecStore } from '../../domain/spec/spec.store.js';

let directory: string;
beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance();
  directory = mkdtempSync(path.join(tmpdir(), 'hv-health-path-spec-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => {
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('health path validation through the CLI/MCP command registry', () => {
  it.each(['gcp', 'aws', 'azure'] as const)('rejects unsafe %s patches without changing the saved spec', async (provider) => {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'health-path-test', defaultPlatform: provider });
    const store = new SpecStore();
    store.replace(project, { version: 1, project: project.name, environments: { testing: {
      hosting: { provider: provider === 'gcp' ? 'cloudrun' : provider }, services: { web: { healthCheckPath: '/health' } },
    } } });
    const before = store.get(project);
    const registry = createCommandRegistry(ctx);
    const update = (healthCheckPath: string) => registry.execute('hv_spec', { project: project.name, spec: {
      environments: { testing: { services: { web: { healthCheckPath } } } },
    } });
    for (const healthCheckPath of ['https://outside.example/', '//outside.example/', '/\\outside.example/', '/health\ncheck']) {
      const rejected = await update(healthCheckPath);
      expect(rejected).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      expect(JSON.stringify(rejected)).toMatch(/Health check path/);
      expect(store.get(project)).toEqual(before);
    }
    const literalPath = '/health?ready=1&mode=full';
    const accepted = await update(literalPath);
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true });
    expect(store.get(project)!.spec.environments.testing!.services.web!.healthCheckPath).toBe(literalPath);
  });
});
