import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { CloudRunLogWatcher } from '../watchers/cloudrun.watcher.js';

describe('CloudRunLogWatcher', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-cloudrun-watcher-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedCloudRunConnection(): void {
    const secretStore = getSecretStore();
    const repo = new ConnectionRepository();
    const connection = repo.create({
      provider: 'cloudrun',
      credentialsEncrypted: secretStore.encryptObject({
        credentials: '{"type":"service_account"}',
        projectId: 'gcp-project-1',
        region: 'us-central1',
      }),
    });
    repo.updateStatus(connection.id, 'verified');
  }

  function seedEnvironment(provider: string): { projectId: string; environmentId: string } {
    const project = new ProjectRepository().create({ name: `app-${provider}`, defaultPlatform: provider });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider,
        projectId: 'gcp-project-1',
        environmentId: 'production',
        services: {
          web: { serviceId: 'web-prod', resourceType: 'service' },
        },
      },
    });
    return { projectId: project.id, environmentId: environment.id };
  }

  it('create() returns null without a cloudrun connection', async () => {
    expect(await CloudRunLogWatcher.create()).toBeNull();
  });

  it('create() connects and verifies through the adapter', async () => {
    seedCloudRunConnection();
    const connect = vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue(undefined);
    const verify = vi.spyOn(CloudRunAdapter.prototype, 'verify').mockResolvedValue({ success: true });

    const watcher = await CloudRunLogWatcher.create();
    expect(watcher).not.toBeNull();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('create() returns null when verification fails', async () => {
    seedCloudRunConnection();
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(CloudRunAdapter.prototype, 'verify').mockResolvedValue({ success: false, error: 'bad key' });

    expect(await CloudRunLogWatcher.create()).toBeNull();
  });

  it('canHandle() is true only for projects with cloudrun bindings', async () => {
    seedCloudRunConnection();
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(CloudRunAdapter.prototype, 'verify').mockResolvedValue({ success: true });
    const cloudrun = seedEnvironment('cloudrun');
    const railway = seedEnvironment('railway');

    const watcher = (await CloudRunLogWatcher.create())!;
    expect(await watcher.canHandle(cloudrun.projectId)).toBe(true);
    expect(await watcher.canHandle(railway.projectId)).toBe(false);
  });

  it('fetchErrors() normalizes grouped error logs from adapter.getLogs', async () => {
    seedCloudRunConnection();
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(CloudRunAdapter.prototype, 'verify').mockResolvedValue({ success: true });
    const { projectId, environmentId } = seedEnvironment('cloudrun');

    const getLogs = vi.spyOn(CloudRunAdapter.prototype, 'getLogs').mockResolvedValue([
      {
        timestamp: new Date('2026-07-01T10:00:00Z'),
        message: 'TypeError: Cannot read properties of undefined',
        severity: 'error',
        raw: 'TypeError: Cannot read properties of undefined',
      },
      {
        timestamp: new Date('2026-07-01T10:00:00Z'),
        message: '    at handler (/app/dist/server.js:10:5)',
        severity: 'error',
        raw: '    at handler (/app/dist/server.js:10:5)',
      },
    ]);

    const watcher = (await CloudRunLogWatcher.create())!;
    const errors = await watcher.fetchErrors(environmentId, 'web', { limit: 5 });

    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ id: environmentId }),
      'web',
      expect.objectContaining({ errorsOnly: true })
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: 'TypeError: Cannot read properties of undefined',
      errorType: 'TypeError',
      serviceName: 'web',
      environmentName: 'production',
      projectId,
    });
    expect(errors[0].stackTrace).toContain('at handler');
  });

  it('fetchErrors() returns [] for environments not bound to cloudrun', async () => {
    seedCloudRunConnection();
    vi.spyOn(CloudRunAdapter.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(CloudRunAdapter.prototype, 'verify').mockResolvedValue({ success: true });
    const getLogs = vi.spyOn(CloudRunAdapter.prototype, 'getLogs');
    const railway = seedEnvironment('railway');

    const watcher = (await CloudRunLogWatcher.create())!;
    expect(await watcher.fetchErrors(railway.environmentId, 'web')).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
  });
});
