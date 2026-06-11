import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { AppStoreConnectAdapter } from '../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { XcodeAdapter } from '../../adapters/providers/xcode/xcode.adapter.js';
import { createToolContext } from '../context.js';
import { registerHvAppstoreTools } from '../hv-appstore.tools.js';

let tempDir: string;

beforeEach(() => {
  SqliteAdapter.resetInstance();
  tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-hv-appstore-'));
  SqliteAdapter.getInstance(path.join(tempDir, 'test.db')).migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedConnection() {
  new ConnectionRepository().create({
    provider: 'appstoreconnect',
    credentialsEncrypted: getSecretStore().encryptObject({
      keyId: 'KEY1',
      issuerId: 'ISSUER1',
      privateKey: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    }),
  });
}

async function makeClient() {
  const server = new McpServer({ name: 'hv-appstore-test', version: '1.0.0' });
  registerHvAppstoreTools(server, createToolContext());
  const client = new Client({ name: 'hv-appstore-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content as Array<{ type: string; text: string }>)[0];
      return JSON.parse(content.text) as Record<string, any>;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const APP = { id: 'app-1', bundleId: 'com.example.app', name: 'Example App' };
const BUILD = {
  id: 'build-1',
  version: '1.2.0',
  buildNumber: '42',
  processingState: 'VALID',
  usesNonExemptEncryption: false,
  uploadedDate: '2026-06-01T00:00:00Z',
  appId: 'app-1',
};
const GROUP = { id: 'group-1', name: 'External Testers', isInternal: false };

describe('hv_appstore_status', () => {
  it('aggregates builds and groups for an app (happy path)', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBuilds').mockResolvedValue([BUILD]);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue([GROUP]);
    const t = await makeClient();

    const status = await t.call('hv_appstore_status', {
      appIdentifier: 'com.example.app',
      include: ['builds', 'groups'],
    });
    expect(status.ok).toBe(true);
    expect(status.data.app).toEqual(APP);
    expect(status.data.builds).toHaveLength(1);
    expect(status.data.builds[0]).toMatchObject({ id: 'build-1', buildNumber: '42', processingState: 'VALID' });
    expect(status.data.groups).toEqual([GROUP]);
    expect(status.data.testers).toBeUndefined();
    expect(status.data.readiness).toBeUndefined();
    await t.close();
  });

  it('returns MISSING_CONNECTION with setup guidance when no connection exists', async () => {
    const t = await makeClient();
    const status = await t.call('hv_appstore_status', { appIdentifier: 'com.example.app' });
    expect(status.ok).toBe(false);
    expect(status.error.code).toBe('MISSING_CONNECTION');
    expect(status.hint).toContain('appstoreconnect.apple.com/access/api');
    await t.close();
  });
});

describe('hv_testflight_distribute', () => {
  it('attaches the resolved build to a group and adds testers', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'waitForProcessingAndSetCompliance').mockResolvedValue({
      build: BUILD,
      complianceSet: true,
    });
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getOrCreateBetaGroup').mockResolvedValue({ group: GROUP, created: true });
    const addBuild = vi.spyOn(AppStoreConnectAdapter.prototype, 'addBuildToBetaGroup').mockResolvedValue(undefined);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters').mockResolvedValue([]);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getOrCreateBetaTester').mockResolvedValue({
      tester: { id: 'tester-1', email: 'tester@example.com' },
      created: true,
    });
    const t = await makeClient();

    const res = await t.call('hv_testflight_distribute', {
      appIdentifier: 'com.example.app',
      testers: [{ email: 'tester@example.com' }],
    });
    expect(res.ok).toBe(true);
    expect(res.data.build.id).toBe('build-1');
    expect(res.data.group).toEqual(GROUP);
    expect(res.data.groupCreated).toBe(true);
    expect(res.data.testers).toHaveLength(1);
    expect(res.data.actions).toContain('Added build 42 to beta group: External Testers');
    expect(addBuild).toHaveBeenCalledWith('build-1', 'group-1');

    const audit = new AuditRepository().findByAction('testflight.distribute');
    expect(audit).toHaveLength(1);
    expect(audit[0].resourceId).toBe('build-1');
    await t.close();
  });
});

describe('hv_xcode_deploy', () => {
  it('dispatches action="devices" to the Xcode adapter', async () => {
    vi.spyOn(XcodeAdapter.prototype, 'listDevices').mockResolvedValue([
      { id: 'device-1', name: 'My iPhone', platform: 'iOS', osVersion: '19.0', available: true } as any,
    ]);
    const t = await makeClient();

    const res = await t.call('hv_xcode_deploy', { action: 'devices' });
    expect(res.ok).toBe(true);
    expect(res.data.count).toBe(1);
    expect(res.data.devices[0].id).toBe('device-1');
    await t.close();
  });
});
