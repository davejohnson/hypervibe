import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/providers.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { AdapterFactory } from '../adapter.factory.js';

// Generic provider resolution must not reinterpret a database/storage connection
// as hosting authority. Real registration/SQLite/factory boundary; factory objects
// are synthetic and make no claim of native provider compatibility.
describe('non-hosting connections alongside exact prepared hosting', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-prepared-adapter-'));
    vi.stubEnv('HYPERVIBE_DATA_DIR', directory); SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  function fixture(provider: string) {
    const project = new ProjectRepository().create({ name: 'prepared-host', gitRemoteUrl: 'https://github.com/owner/app.git' });
    const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'test', platformBindings: {
      provider: 'cloudrun', projectId: 'native-project', localPreparedHosting: { installationId: 'retained-hosting', planDigest: 'a'.repeat(64) },
    } });
    const connectionProvider = providerRegistry.connectionProviders(provider)[0];
    new ConnectionRepository().upsertVerifiedBatch([{ provider: connectionProvider, scope: 'owner/app',
      credentialsEncrypted: getSecretStore().encryptObject({ authMode: 'default' }) }]);
    const factory = vi.spyOn(providerRegistry, 'createAdapter').mockResolvedValue({ name: provider } as never);
    return { project, environment, factory, connectionProvider };
  }
  it.each(['cloudsql', 'gcs', 'rds', 's3', 'azure-postgres', 'azureblob'])('resolves %s without using unrelated hosting proof', async provider => {
    expect(providerRegistry.get(provider), 'Named provider registration must exist.').toBeDefined();
    const f = fixture(provider);
    expect(await new AdapterFactory().getProviderAdapter(provider, f.project, undefined, f.environment.name))
      .toMatchObject({ success: true, adapter: { name: provider }, connectionProvider: f.connectionProvider });
    expect(new EnvironmentRepository().findById(f.environment.id)?.platformBindings).toEqual(f.environment.platformBindings);
  });
  it('still blocks hosting without its original valid prepared receipt', async () => {
    const f = fixture('cloudrun');
    expect(await new AdapterFactory().getProviderAdapter('cloudrun', f.project, undefined, f.environment.name)).toMatchObject({ success: false });
  });
  it.each(['unknown-provider', 'cloudsql'])('does not bypass hosting proof using a returned %s adapter', async name => {
    const f = fixture('cloudrun'); f.factory.mockResolvedValue({ name } as never);
    expect(await new AdapterFactory().getProviderAdapter('cloudrun', f.project, undefined, f.environment.name)).toMatchObject({ success: false });
  });
});
