import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import type { IStorageAdapter } from '../../../domain/ports/storage.port.js';
import { environmentSpecSchema } from '../../../domain/spec/spec.schema.js';
import { adapterFactory } from '../../../domain/services/adapter.factory.js';
import { applyStorageAction, planStorage } from '../../../domain/services/storage-plan.service.js';

/** Real shared plan/apply/binding path; callers mock only their provider boundary. */
export async function verifyIsolatedStorageLifecycle(adapter: IStorageAdapter, region: string) {
  const directory = mkdtempSync(join(tmpdir(), 'hypervibe-storage-scope-'));
  SqliteAdapter.resetInstance();
  initializeDatabase(join(directory, 'state.db'));
  const factory = vi.spyOn(adapterFactory, 'getStorageAdapter').mockResolvedValue({ success: true, adapter });
  try {
    const project = new ProjectRepository().create({ name: 'scope-contract', defaultPlatform: 'railway' });
    const repository = new EnvironmentRepository();
    const spec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' }, services: {},
      storage: { documents: { provider: adapter.name, type: 'bucket', region, injectInto: [] } },
    });
    const targets = [];
    for (const name of ['production', 'staging']) {
      const environment = repository.create({ projectId: project.id, name, platformBindings: {} });
      const resolved = await adapter.ensureContext(project.name, environment, {}, region);
      expect(resolved.receipt.success).toBe(true);
      const context = resolved.context!;
      repository.update(environment.id, { platformBindings: { storageProviders: { [adapter.name]: context } } });
      const observe = async () => ({
        provider: 'railway', observedAt: new Date().toISOString(), projectExists: true,
        services: [], databases: [], partial: false, warnings: [],
        storage: await adapter.observe(environment, context),
      });
      const plan = async () => planStorage({
        environmentSpec: spec, environment: repository.findById(environment.id), observed: await observe(),
      });
      const action = (await plan()).actions[0];
      expect(action).toMatchObject({ type: 'create', billable: true });
      expect(await applyStorageAction({ project, envName: name, environmentSpec: spec, action }))
        .toMatchObject({ success: true });
      const live = (await observe()).storage;
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ name: 'documents', provider: adapter.name });
      expect((await plan()).actions.every((action) => action.type === 'noop')).toBe(true);
      targets.push({ environment, context, live });
    }
    const [production, staging] = targets;
    expect(staging.live[0].externalId).not.toBe(production.live[0].externalId);
    expect(await adapter.observe(production.environment, production.context)).toEqual(production.live);
    expect(await adapter.observe(staging.environment, staging.context)).toEqual(staging.live);
  } finally {
    factory.mockRestore();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  }
}
