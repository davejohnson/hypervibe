import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import {
  SecretMappingRepository,
  SecretAccessLogRepository,
} from '../../../adapters/db/repositories/secret-mapping.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { secretManagerRegistry } from '../../registry/secretmanager.registry.js';
import type {
  ISecretManagerAdapter,
  ResolvedSecret,
  SecretReference,
} from '../../ports/secretmanager.port.js';
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

function seedDopplerConnection(credentials: Record<string, unknown> = { token: 'dp.st.test-token' }) {
  const repo = new ConnectionRepository();
  const conn = repo.create({
    provider: 'doppler',
    credentialsEncrypted: getSecretStore().encryptObject(credentials),
  });
  repo.updateStatus(conn.id, 'verified');
  return conn;
}

/**
 * Fake secret manager adapter keyed by the raw secret reference string,
 * matching how SecretResolver looks up batch results (secrets.get(ref.raw)).
 */
function createFakeSecretManagerAdapter(values: Record<string, ResolvedSecret>): ISecretManagerAdapter & {
  getSecretsCalls: SecretReference[][];
} {
  const getSecretsCalls: SecretReference[][] = [];
  return {
    name: 'doppler',
    capabilities: {
      supportsVersioning: false,
      supportsMultipleKeys: true,
      supportsRotation: false,
      supportsAuditLog: false,
      supportsDynamicSecrets: false,
    },
    getSecretsCalls,
    async connect() {},
    async verify() {
      return { success: true };
    },
    async getSecret(secretPath) {
      const match = Object.entries(values).find(([raw]) => raw.includes(secretPath));
      if (!match) {
        throw new Error(`Secret not found: ${secretPath}`);
      }
      return match[1];
    },
    async getSecrets(references) {
      getSecretsCalls.push(references);
      const result = new Map<string, ResolvedSecret>();
      for (const ref of references) {
        const value = values[ref.raw];
        if (value) {
          result.set(ref.raw, value);
        }
      }
      return result;
    },
    async setSecret(secretPath) {
      return { success: true, path: secretPath };
    },
    async deleteSecret(secretPath) {
      return { success: true, path: secretPath };
    },
    async listSecrets() {
      return [];
    },
  };
}

describe('SecretResolver.resolveForEnvironment', () => {
  it('resolves a mapped secret through the connected manager and logs the access', async () => {
    const project = new ProjectRepository().create({ name: 'resolver-happy-app', defaultPlatform: 'railway' });
    seedDopplerConnection({ token: 'dp.st.test-token' });
    new SecretMappingRepository().create({
      projectId: project.id,
      envVar: 'API_KEY',
      secretRef: 'doppler://backend/prod#API_KEY',
      environments: [],
    });

    const fakeAdapter = createFakeSecretManagerAdapter({
      'doppler://backend/prod#API_KEY': { value: 'super-secret-value' },
    });
    const createAdapter = vi.spyOn(secretManagerRegistry, 'createAdapter').mockReturnValue(fakeAdapter);

    const result = await new SecretResolver().resolveForEnvironment({
      projectId: project.id,
      environmentName: 'production',
    });

    expect(result.vars).toEqual({ API_KEY: 'super-secret-value' });
    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    // The registry seam receives the decrypted connection credentials.
    expect(createAdapter).toHaveBeenCalledWith('doppler', { token: 'dp.st.test-token' });

    const logs = new SecretAccessLogRepository().findByProjectId(project.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'read',
      provider: 'doppler',
      secretPath: 'backend/prod',
      projectId: project.id,
      environmentName: 'production',
      success: true,
      error: null,
    });
  });

  it('accumulates a missing-connection error instead of throwing', async () => {
    const project = new ProjectRepository().create({ name: 'resolver-no-conn-app', defaultPlatform: 'railway' });
    new SecretMappingRepository().create({
      projectId: project.id,
      envVar: 'API_KEY',
      secretRef: 'doppler://backend/prod#API_KEY',
      environments: [],
    });
    const createAdapter = vi.spyOn(secretManagerRegistry, 'createAdapter');

    const result = await new SecretResolver().resolveForEnvironment({
      projectId: project.id,
      environmentName: 'production',
    });

    expect(result.vars).toEqual({});
    expect(result.resolved).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      {
        envVar: 'API_KEY',
        secretRef: 'doppler://backend/prod#API_KEY',
        error: expect.stringContaining("No connection found for secret manager 'doppler'"),
      },
    ]);
    expect(createAdapter).not.toHaveBeenCalled();

    const logs = new SecretAccessLogRepository().findByProjectId(project.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'read',
      provider: 'doppler',
      secretPath: 'backend/prod',
      success: false,
    });
    expect(logs[0].error).toContain("No connection found for secret manager 'doppler'");
  });

  it('resolves one mapping and accumulates the other failure in the same result', async () => {
    const project = new ProjectRepository().create({ name: 'resolver-mixed-app', defaultPlatform: 'railway' });
    seedDopplerConnection();
    const mappingRepo = new SecretMappingRepository();
    mappingRepo.create({
      projectId: project.id,
      envVar: 'API_KEY',
      secretRef: 'doppler://backend/prod#API_KEY',
      environments: [],
    });
    mappingRepo.create({
      projectId: project.id,
      envVar: 'MISSING_KEY',
      secretRef: 'doppler://backend/prod#MISSING_KEY',
      environments: [],
    });

    const fakeAdapter = createFakeSecretManagerAdapter({
      'doppler://backend/prod#API_KEY': { value: 'super-secret-value' },
      'doppler://backend/prod#MISSING_KEY': {
        value: '',
        metadata: { error: 'Secret MISSING_KEY not found in Doppler config' },
      },
    });
    vi.spyOn(secretManagerRegistry, 'createAdapter').mockReturnValue(fakeAdapter);

    const result = await new SecretResolver().resolveForEnvironment({
      projectId: project.id,
      environmentName: 'production',
    });

    expect(result.vars).toEqual({ API_KEY: 'super-secret-value' });
    expect(result.resolved).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      {
        envVar: 'MISSING_KEY',
        secretRef: 'doppler://backend/prod#MISSING_KEY',
        error: 'Secret MISSING_KEY not found in Doppler config',
      },
    ]);

    const logs = new SecretAccessLogRepository().findByProjectId(project.id);
    expect(logs).toHaveLength(2);
    expect(logs.filter((log) => log.success)).toHaveLength(1);
    expect(logs.filter((log) => !log.success)).toHaveLength(1);
  });

  it('accumulates an invalid secret reference without touching the manager', async () => {
    const project = new ProjectRepository().create({ name: 'resolver-bad-ref-app', defaultPlatform: 'railway' });
    seedDopplerConnection();
    new SecretMappingRepository().create({
      projectId: project.id,
      envVar: 'BROKEN',
      secretRef: 'not-a-secret-ref',
      environments: [],
    });
    const createAdapter = vi.spyOn(secretManagerRegistry, 'createAdapter');

    const result = await new SecretResolver().resolveForEnvironment({
      projectId: project.id,
      environmentName: 'production',
    });

    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      {
        envVar: 'BROKEN',
        secretRef: 'not-a-secret-ref',
        error: 'Invalid secret reference format',
      },
    ]);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('caches the connected adapter per provider across resolutions', async () => {
    const project = new ProjectRepository().create({ name: 'resolver-cache-app', defaultPlatform: 'railway' });
    seedDopplerConnection();
    const mappingRepo = new SecretMappingRepository();
    mappingRepo.create({
      projectId: project.id,
      envVar: 'API_KEY',
      secretRef: 'doppler://backend/prod#API_KEY',
      environments: [],
    });
    mappingRepo.create({
      projectId: project.id,
      envVar: 'OTHER_KEY',
      secretRef: 'doppler://backend/prod#OTHER_KEY',
      environments: [],
    });

    const fakeAdapter = createFakeSecretManagerAdapter({
      'doppler://backend/prod#API_KEY': { value: 'value-one' },
      'doppler://backend/prod#OTHER_KEY': { value: 'value-two' },
    });
    const connect = vi.spyOn(fakeAdapter, 'connect');
    const createAdapter = vi.spyOn(secretManagerRegistry, 'createAdapter').mockReturnValue(fakeAdapter);

    const resolver = new SecretResolver();
    const first = await resolver.resolveForEnvironment({
      projectId: project.id,
      environmentName: 'production',
    });
    const second = await resolver.resolveForEnvironment({
      projectId: project.id,
      environmentName: 'production',
    });

    expect(first.vars).toEqual({ API_KEY: 'value-one', OTHER_KEY: 'value-two' });
    expect(second.vars).toEqual(first.vars);
    // Two secrets from the same manager are batched, and the second
    // resolution reuses the cached connected adapter.
    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(fakeAdapter.getSecretsCalls).toHaveLength(2);
    expect(fakeAdapter.getSecretsCalls[0]).toHaveLength(2);
  });
});
