import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { createCommandContext } from '../../application/context.js';
import { CommandRegistry } from '../../application/commands.js';
import {
  HYPERVIBE_CLOUD_CONNECTION_PROVIDER,
  type HypervibeCloudPairingClient,
  type VerifiedHypervibeCloudConnection,
} from '../../application/cloud-pairing.js';
import { registerHvCloudTools } from '../hv-cloud.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-cloud-tools-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function createFixture(client: HypervibeCloudPairingClient) {
  const context = createCommandContext();
  const registry = new CommandRegistry();
  registerHvCloudTools(registry, context, {
    detectRepository: () => 'northstar/launchpad',
    createClient: () => client,
    now: () => new Date('2026-08-27T20:00:00.000Z'),
  });
  return { context, registry };
}

describe('hv_cloud_pair', () => {
  it('stores the device secret encrypted and returns only browser-safe approval data', async () => {
    const deviceCode = 'A'.repeat(43);
    const client: HypervibeCloudPairingClient = {
      start: vi.fn(async () => ({
        deviceCode,
        expiresAt: '2026-08-27T20:10:00.000Z',
        intervalSeconds: 2,
        repository: 'northstar/launchpad',
        userCode: '2345-6789',
        verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
      })),
      exchange: vi.fn(),
    };
    const { context, registry } = createFixture(client);

    const result = await registry.execute('hv_cloud_pair', {});

    expect(result).toMatchObject({
      ok: true,
      data: {
        status: 'pending',
        repository: 'northstar/launchpad',
        userCode: '2345-6789',
      },
    });
    expect(JSON.stringify(result)).not.toContain(deviceCode);
    const stored = new ConnectionRepository().findByProviderAndScope(
      HYPERVIBE_CLOUD_CONNECTION_PROVIDER,
      'northstar/launchpad'
    )!;
    expect(stored.credentialsEncrypted).not.toContain(deviceCode);
    expect(context.secretStore.decryptObject(stored.credentialsEncrypted)).toMatchObject({
      status: 'pending',
      deviceCode,
      repository: 'northstar/launchpad',
    });
  });

  it('completes the one-time exchange and never returns environment tokens', async () => {
    const environmentToken = `hvc_12345678-1234-1234-1234-123456789abc_${'B'.repeat(43)}`;
    const client: HypervibeCloudPairingClient = {
      start: vi.fn(async () => ({
        deviceCode: 'A'.repeat(43),
        expiresAt: '2026-08-27T20:10:00.000Z',
        intervalSeconds: 2,
        repository: 'northstar/launchpad',
        userCode: '2345-6789',
        verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
      })),
      exchange: vi.fn(async () => ({
        applied: 2,
        skipped: 0,
        status: 'completed' as const,
        project: { id: 'project-1', name: 'Launchpad' },
        credentials: [
          {
            environment: { id: 'env-preview', key: 'preview', name: 'Preview' },
            token: environmentToken,
          },
          {
            environment: { id: 'env-staging', key: 'staging', name: 'Staging' },
            token: `hvc_87654321-4321-4321-4321-cba987654321_${'C'.repeat(43)}`,
          },
        ],
      })),
    };
    const { context, registry } = createFixture(client);
    await registry.execute('hv_cloud_pair', {});

    const result = await registry.execute('hv_cloud_pair', { action: 'status' });

    expect(result).toMatchObject({
      ok: true,
      data: {
        status: 'verified',
        repository: 'northstar/launchpad',
        project: { name: 'Launchpad' },
        environments: [
          { key: 'preview', name: 'Preview' },
          { key: 'staging', name: 'Staging' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(environmentToken);
    expect(JSON.stringify(result)).not.toContain('Production');
    const stored = new ConnectionRepository().findByProviderAndScope(
      HYPERVIBE_CLOUD_CONNECTION_PROVIDER,
      'northstar/launchpad'
    )!;
    expect(stored.status).toBe('verified');
    const verified = context.secretStore.decryptObject<VerifiedHypervibeCloudConnection>(
      stored.credentialsEncrypted
    );
    expect(verified.environments[0].token).toBe(environmentToken);
  });

  it('does not call the server when the current repository is not GitHub', async () => {
    const client: HypervibeCloudPairingClient = {
      start: vi.fn(),
      exchange: vi.fn(),
    };
    const context = createCommandContext();
    const registry = new CommandRegistry();
    registerHvCloudTools(registry, context, {
      detectRepository: () => null,
      createClient: () => client,
    });

    const result = await registry.execute('hv_cloud_pair', {});

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(client.start).not.toHaveBeenCalled();
  });
});
