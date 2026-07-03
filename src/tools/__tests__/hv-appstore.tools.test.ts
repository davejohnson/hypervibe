import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseToolEnvelope } from './tool-result.js';
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
      return parseToolEnvelope(result) as Record<string, any>;
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
    expect(status.hint).toContain('appstoreconnect.apple.com/access/integrations/api');
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

const VERSION = { id: 'ver-1', versionString: '1.2.0', appStoreState: 'PREPARE_FOR_SUBMISSION', platform: 'IOS' };

describe('hv_appstore_submit', () => {
  function stubSubmittableVersion() {
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getEditableAppStoreVersion').mockResolvedValue(VERSION);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getAppStoreVersionBuild').mockResolvedValue({ id: 'build-1', version: '42' });
  }

  it('creates a review submission, adds the version as an item, and submits it', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions').mockResolvedValue([]);
    const create = vi.spyOn(AppStoreConnectAdapter.prototype, 'createReviewSubmission')
      .mockResolvedValue({ id: 'rs-1', state: 'READY_FOR_REVIEW', platform: 'IOS' });
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem').mockResolvedValue(undefined);
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission')
      .mockResolvedValue({ id: 'rs-1', state: 'WAITING_FOR_REVIEW', platform: 'IOS' });
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', { appIdentifier: 'com.example.app' });
    expect(res.ok).toBe(true);
    expect(create).toHaveBeenCalledWith('app-1', 'IOS');
    expect(addItem).toHaveBeenCalledWith('rs-1', 'ver-1');
    expect(submit).toHaveBeenCalledWith('rs-1');
    expect(res.data.version).toMatchObject({ id: 'ver-1', versionString: '1.2.0' });
    expect(res.data.reviewSubmission).toEqual({ id: 'rs-1', state: 'WAITING_FOR_REVIEW', reusedExistingSubmission: false });

    const audit = new AuditRepository().findByAction('appstore.submit');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ reviewSubmissionId: 'rs-1' });
    await t.close();
  });

  it('reuses an existing READY_FOR_REVIEW submission instead of creating one', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'READY_FOR_REVIEW', platform: 'IOS' }]);
    const create = vi.spyOn(AppStoreConnectAdapter.prototype, 'createReviewSubmission');
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem').mockResolvedValue(undefined);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission')
      .mockResolvedValue({ id: 'rs-9', state: 'WAITING_FOR_REVIEW', platform: 'IOS' });
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', { appIdentifier: 'com.example.app' });
    expect(res.ok).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith('rs-9', 'ver-1');
    expect(res.data.reviewSubmission).toEqual({ id: 'rs-9', state: 'WAITING_FOR_REVIEW', reusedExistingSubmission: true });
    await t.close();
  });

  it('fails clearly when a review submission is already in flight', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'WAITING_FOR_REVIEW', platform: 'IOS' }]);
    const addItem = vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem');
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', { appIdentifier: 'com.example.app' });
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('already WAITING_FOR_REVIEW');
    expect(res.error.message).toContain('rs-9');
    expect(addItem).not.toHaveBeenCalled();
    await t.close();
  });

  it('surfaces the provider error detail when adding the version item fails', async () => {
    seedConnection();
    stubSubmittableVersion();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listReviewSubmissions')
      .mockResolvedValue([{ id: 'rs-9', state: 'READY_FOR_REVIEW', platform: 'IOS' }]);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'addReviewSubmissionItem')
      .mockRejectedValue(new Error('App Store Connect API: This version is already added to another submission.'));
    const submit = vi.spyOn(AppStoreConnectAdapter.prototype, 'submitReviewSubmission');
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', { appIdentifier: 'com.example.app' });
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('Could not add version ver-1 to review submission rs-9');
    expect(res.error.message).toContain('already added to another submission');
    expect(submit).not.toHaveBeenCalled();
    await t.close();
  });

  it('returns VALIDATION when no version is ready for submission', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(APP);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getEditableAppStoreVersion').mockResolvedValue(null);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listAppStoreVersions')
      .mockResolvedValue([{ id: 'ver-0', versionString: '1.1.0', appStoreState: 'READY_FOR_SALE', platform: 'IOS' }]);
    const t = await makeClient();

    const res = await t.call('hv_appstore_submit', { appIdentifier: 'com.example.app' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('VALIDATION');
    expect(res.error.message).toContain('No version ready for submission');
    expect(res.error.details.currentVersions).toEqual([{ version: '1.1.0', state: 'READY_FOR_SALE', platform: 'IOS' }]);
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
