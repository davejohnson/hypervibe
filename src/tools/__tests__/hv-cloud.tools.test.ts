import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { createCommandContext } from '../../application/context.js';
import { CommandRegistry } from '../../application/commands.js';
import {
  createHypervibeCloudPairingClient,
  HYPERVIBE_CLOUD_CONNECTION_PROVIDER,
  type HypervibeCloudPairingClient,
  type VerifiedHypervibeCloudConnection,
} from '../../application/cloud-pairing.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
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

function createGitTransportFixture() {
  const directory = path.join(tempDir, 'workspace');
  mkdirSync(directory);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  }).trim();
  git('init', '--quiet', '--initial-branch=integration/security');
  git('remote', 'add', 'origin', 'https://github.com/northstar/launchpad.git');
  git('-c', 'user.name=Pairing Test', '-c', 'user.email=pairing@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture');

  const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  // Synthetic server responses preserve the existing public pairing contract.
  // The owner-approved extension carries the setup branch only in the request;
  // it grants no deployment authority and adds no approval URL parameters.
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    if (String(url) === 'https://hypervibe.dev/api/v1/pairings') {
      return Response.json({
        deviceCode: 'A'.repeat(43), expiresAt: '2026-08-27T20:10:00.000Z',
        intervalSeconds: 2, repository: 'northstar/launchpad', userCode: '2345-6789',
        verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
      }, { status: 201 });
    }
    if (String(url) === 'https://hypervibe.dev/api/v1/pairing-exchanges') {
      return Response.json({ applied: 0, skipped: 0, status: 'pending', retryAfterSeconds: 2 });
    }
    throw new Error('Unexpected pairing request');
  });
  const context = createCommandContext();
  const registry = new CommandRegistry();
  registerHvCloudTools(registry, context, {
    createClient: baseUrl => createHypervibeCloudPairingClient({ baseUrl, fetchImpl }),
    now: () => new Date('2026-08-27T20:00:00.000Z'),
  });
  const run = (input: Record<string, unknown> = {}) => runWithWorkspaceDirectories(
    [directory], () => registry.execute('hv_cloud_pair', input)
  );
  const stored = () => context.repos.connections.findByProviderAndScope(
    HYPERVIBE_CLOUD_CONNECTION_PROVIDER, 'northstar/launchpad'
  );
  const pending = () => context.secretStore.decryptObject<Record<string, unknown>>(
    stored()!.credentialsEncrypted
  );
  return { git, run, requests, fetchImpl, stored, pending };
}

describe('hv_cloud_pair', () => {
  it('infers the symbolic branch from the same client workspace as the repository through the real HTTP client', async () => {
    const fixture = createGitTransportFixture();

    const result = await fixture.run();

    expect(result).toMatchObject({ ok: true, data: {
      status: 'pending', repository: 'northstar/launchpad', userCode: '2345-6789',
      verificationUrl: 'https://hypervibe.dev/pair?code=2345-6789',
    } });
    expect(fixture.requests).toEqual([{
      url: 'https://hypervibe.dev/api/v1/pairings', method: 'POST',
      body: { repositoryFullName: 'northstar/launchpad', sourceBranch: 'integration/security' },
    }]);
    expect(fixture.pending()).toMatchObject({ sourceBranch: 'integration/security' });
    expect(JSON.stringify(result)).not.toContain('A'.repeat(43));
  });

  it.each([false, true])('normalizes an explicit source branch instead of inferring one (detached: %s)', async detached => {
    const fixture = createGitTransportFixture();
    if (detached) fixture.git('checkout', '--quiet', '--detach', 'HEAD');

    const result = await fixture.run({ sourceBranch: '  review/credential-setup  ' });

    expect(result).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(fixture.requests[0]?.body).toEqual({
      repositoryFullName: 'northstar/launchpad', sourceBranch: 'review/credential-setup',
    });
    expect(fixture.pending()).toMatchObject({ sourceBranch: 'review/credential-setup' });
  });

  it('omits the source hint at detached HEAD instead of sending HEAD, a SHA, or a guessed branch', async () => {
    const fixture = createGitTransportFixture();
    fixture.git('checkout', '--quiet', '--detach', 'HEAD');

    const result = await fixture.run();

    expect(result).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(fixture.requests[0]?.body).toEqual({ repositoryFullName: 'northstar/launchpad' });
    expect(fixture.pending()).not.toHaveProperty('sourceBranch');
  });

  it.each([false, true])('preserves the original pending hint on branchless retries after the checkout changes (detached: %s)', async detached => {
    const fixture = createGitTransportFixture();
    if (detached) fixture.git('checkout', '--quiet', '--detach', 'HEAD');
    expect(await fixture.run()).toMatchObject({ ok: true, data: { status: 'pending' } });
    const before = fixture.stored();
    if (detached) expect(fixture.pending()).not.toHaveProperty('sourceBranch');
    else expect(fixture.pending()).toMatchObject({ sourceBranch: 'integration/security' });
    fixture.git('checkout', '--quiet', '-b', 'review/other-checkout');

    expect(await fixture.run()).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.stored()).toEqual(before);
    expect(await fixture.run({ action: 'status' })).toMatchObject({ ok: true, data: { status: 'pending' } });

    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toEqual({
      url: 'https://hypervibe.dev/api/v1/pairing-exchanges', method: 'POST',
      body: { deviceCode: 'A'.repeat(43) },
    });
    expect(fixture.stored()).toEqual(before);
  });

  it.each(['start', 'status'])('rejects an explicit changed pending source before %s can call the server or replace state', async action => {
    const fixture = createGitTransportFixture();
    expect(await fixture.run()).toMatchObject({ ok: true, data: { status: 'pending' } });
    const before = fixture.stored();
    expect(fixture.pending()).toMatchObject({ sourceBranch: 'integration/security' });

    const result = await fixture.run({ action, sourceBranch: 'review/different-setup' });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fixture.stored()).toEqual(before);
  });

  it.each(['start', 'status'])('accepts the same normalized pending hint on explicit %s retries', async action => {
    const fixture = createGitTransportFixture();
    expect(await fixture.run()).toMatchObject({ ok: true, data: { status: 'pending' } });
    const before = fixture.stored();
    fixture.git('checkout', '--quiet', '-b', 'review/other-checkout');

    const result = await fixture.run({ action, sourceBranch: '  integration/security  ' });

    expect(result).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(fixture.requests).toHaveLength(action === 'status' ? 2 : 1);
    expect(fixture.stored()).toEqual(before);
  });

  it.each(['HEAD', 'refs/heads/main', '../main', 'review..other', 'review:other', 'review branch'])('rejects non-branch source input %s before pairing or persistence', async sourceBranch => {
    const fixture = createGitTransportFixture();

    const result = await fixture.run({ sourceBranch });

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    expect(fixture.stored()).toBeNull();
  });

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
