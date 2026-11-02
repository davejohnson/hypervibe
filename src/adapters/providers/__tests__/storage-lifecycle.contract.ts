import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../db/repositories/connection.repository.js';
import { getSecretStore } from '../../secrets/secret-store.js';
import type { IStorageAdapter } from '../../../domain/ports/storage.port.js';
import { environmentSpecSchema } from '../../../domain/spec/spec.schema.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { applyStorageAction, planStorage } from '../../../domain/services/storage-plan.service.js';

/** Real shared plan/apply/binding path; callers mock only their provider boundary. */
export async function verifyIsolatedStorageLifecycle(adapter: IStorageAdapter, region: string) {
  const directory = mkdtempSync(join(tmpdir(), 'hypervibe-storage-scope-'));
  SqliteAdapter.resetInstance();
  initializeDatabase(join(directory, 'state.db'));
  // Exercise real encrypted connection selection too. The existing mock always
  // returned an adapter and hid apply dropping the environment from its lookup.
  // Only native client construction is replaced; the provider transport remains
  // the caller's independent fixture. A distractor global account must not win.
  let selectedEnvironment = '';
  const selected: string[] = [];
  const factory = vi.spyOn(providerRegistry, 'createAdapter').mockImplementation(async (provider, credentials) => {
    expect(provider).toBe(adapter.name);
    expect(credentials).toEqual({ testEnvironment: selectedEnvironment });
    selected.push(selectedEnvironment);
    return adapter as never;
  });
  try {
    const project = new ProjectRepository().create({ name: 'scope-contract', defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/acme/scope-contract' });
    new ConnectionRepository().upsertVerifiedBatch(['production', 'staging', 'foreign-global'].map(name => ({
      provider: adapter.name, scope: name === 'foreign-global' ? null : `github.com/acme/scope-contract#environment=${name}`,
      credentialsEncrypted: getSecretStore().encryptObject({ testEnvironment: name }),
    })));
    const repository = new EnvironmentRepository();
    const spec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' }, services: {},
      storage: { documents: { provider: adapter.name, type: 'bucket', region, injectInto: [] } },
    });
    const targets = [];
    for (const name of ['production', 'staging']) {
      selectedEnvironment = name;
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
    expect(selected).toEqual(['production', 'staging']);
  } finally {
    factory.mockRestore();
    SqliteAdapter.resetInstance();
    rmSync(directory, { recursive: true, force: true });
  }
}
