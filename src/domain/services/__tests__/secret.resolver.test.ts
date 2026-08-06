import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import type { ISecretManagerAdapter } from '../../ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../registry/secretmanager.registry.js';
import { SecretResolver } from '../secret.resolver.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-secret-resolver-'));
  initializeDatabase(path.join(tempDir, 'hypervibe.db'));
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedConnection(): void {
  const repo = new ConnectionRepository();
  const connection = repo.create({
    provider: 'doppler',
    credentialsEncrypted: getSecretStore().encryptObject({ token: 'dp.st.test-token' }),
  });
  repo.updateStatus(connection.id, 'verified');
}

function fakeAdapter(): ISecretManagerAdapter {
  return {
    name: 'doppler',
    async connect() {},
    async verify() { return { success: true }; },
    async getSecret(path, key) {
      expect(path).toBe('backend/prod');
      expect(key).toBe('API_KEY');
      return { value: 'super-secret-value', version: '7' };
    },
    async listSecrets() { return []; },
  };
}

describe('SecretResolver', () => {
  it('resolves one registered manager reference on demand', async () => {
    const project = new ProjectRepository().create({ name: 'resolver-app', defaultPlatform: 'railway' });
    seedConnection();
    const adapter = fakeAdapter();
    const connect = vi.spyOn(adapter, 'connect');
    vi.spyOn(secretManagerRegistry, 'createAdapter').mockReturnValue(adapter);

    const result = await new SecretResolver().resolveSecret(
      'doppler://backend/prod#API_KEY',
      { projectId: project.id, environmentName: 'production' }
    );

    expect(result).toEqual({ value: 'super-secret-value', version: '7' });
    expect(connect).toHaveBeenCalledWith({ token: 'dp.st.test-token' });
  });

  it('returns missing-connection guidance without touching an adapter', async () => {
    const createAdapter = vi.spyOn(secretManagerRegistry, 'createAdapter');
    const result = await new SecretResolver().resolveSecret('doppler://backend/prod#API_KEY');

    expect(result).toEqual({ error: expect.stringContaining("No connection found for secret manager 'doppler'") });
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('rejects unregistered provider references', async () => {
    const createAdapter = vi.spyOn(secretManagerRegistry, 'createAdapter');
    const result = await new SecretResolver().resolveSecret('infisical://backend/prod#API_KEY');

    expect(result).toEqual({ error: 'Invalid or unsupported secret reference' });
    expect(createAdapter).not.toHaveBeenCalled();
  });
});
