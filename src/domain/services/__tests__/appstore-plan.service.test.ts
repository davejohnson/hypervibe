import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { AppStoreConnectAdapter } from '../../../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { applyIosAction, isIosAction, planIos } from '../appstore-plan.service.js';
import type { Project } from '../../entities/project.entity.js';
import type { Environment } from '../../entities/environment.entity.js';

const BUNDLE = 'com.example.app';

function envSpec(overrides: Record<string, unknown> = {}) {
  return environmentSpecSchema.parse({
    hosting: { provider: 'railway' },
    ios: {
      bundleId: BUNDLE,
      capabilities: ['PUSH_NOTIFICATIONS'],
      testflight: {
        groups: {
          'External Testers': { publicLinkEnabled: true, testers: ['a@example.com', 'b@example.com'] },
        },
      },
      ...overrides,
    },
  });
}

describe('appstore-plan.service', () => {
  let tempDir: string;
  let project: Project;
  let environment: Environment;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-ios-plan-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
    project = new ProjectRepository().create({ name: 'exampleapp', defaultPlatform: 'railway' });
    environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedConnection(): void {
    const repo = new ConnectionRepository();
    const connection = repo.create({
      provider: 'appstoreconnect',
      credentialsEncrypted: getSecretStore().encryptObject({ keyId: 'K1', issuerId: 'I1', privateKey: 'pk' }),
    });
    repo.updateStatus(connection.id, 'verified');
  }

  function spyObserve(state: {
    bundleId?: { id: string; identifier: string; name: string; platform: string } | null;
    capabilities?: Array<{ id: string; type: string }>;
    app?: { id: string; bundleId: string; name: string } | null;
    groups?: Array<Record<string, unknown>>;
    testersByGroup?: Record<string, string[]>;
  }): void {
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier').mockResolvedValue(state.bundleId ?? null);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'getBundleIdCapabilities').mockResolvedValue(state.capabilities ?? []);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(state.app ?? null);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaGroups').mockResolvedValue((state.groups ?? []) as never);
    vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters').mockImplementation(async (options) => {
      const emails = state.testersByGroup?.[options?.groupId ?? ''] ?? [];
      return emails.map((email, index) => ({ id: `tester-${index}`, email }));
    });
  }

  it('returns warnings only when no connection exists', async () => {
    const result = await planIos({ project, environmentSpec: envSpec(), environment });
    expect(result.actions).toEqual([]);
    expect(result.warnings[0]).toContain('Cannot plan iOS');
    expect(result.warnings[0]).toContain(BUNDLE);
  });

  it('plans the full chain with dependsOn when nothing exists', async () => {
    seedConnection();
    spyObserve({});

    const { actions, warnings } = await planIos({ project, environmentSpec: envSpec(), environment });
    expect(warnings).toEqual([]);
    const byId = Object.fromEntries(actions.map((action) => [action.id, action]));

    expect(byId[`ios:bundle-id:${BUNDLE}`]).toMatchObject({ type: 'create', verified: true });
    expect(byId[`ios:capabilities:${BUNDLE}`]).toMatchObject({
      type: 'update',
      dependsOn: [`ios:bundle-id:${BUNDLE}`],
    });
    expect(byId[`ios:app:${BUNDLE}`]).toMatchObject({ type: 'create' });
    expect(byId[`ios:app:${BUNDLE}`].metadata).toMatchObject({ manual: true });
    expect(byId['ios:group:External Testers']).toMatchObject({
      type: 'create',
      dependsOn: [`ios:app:${BUNDLE}`],
    });
    expect(byId['ios:testers:External Testers']).toMatchObject({
      type: 'update',
      dependsOn: ['ios:group:External Testers'],
    });
    expect(actions.every(isIosAction)).toBe(true);
  });

  it('plans all noops when everything is in sync', async () => {
    seedConnection();
    spyObserve({
      bundleId: { id: 'bid-1', identifier: BUNDLE, name: 'Example', platform: 'IOS' },
      capabilities: [{ id: 'cap-1', type: 'PUSH_NOTIFICATIONS' }],
      app: { id: 'app-1', bundleId: BUNDLE, name: 'Example' },
      groups: [{ id: 'grp-1', name: 'External Testers', isInternal: false, publicLinkEnabled: true }],
      testersByGroup: { 'grp-1': ['a@example.com', 'b@example.com'] },
    });

    const { actions, warnings } = await planIos({ project, environmentSpec: envSpec(), environment });
    expect(warnings).toEqual([]);
    expect(actions.every((action) => action.type === 'noop')).toBe(true);
    // bundle-id, capabilities, app, group, testers
    expect(actions).toHaveLength(5);
  });

  it('diffs group config drift and missing testers', async () => {
    seedConnection();
    spyObserve({
      bundleId: { id: 'bid-1', identifier: BUNDLE, name: 'Example', platform: 'IOS' },
      capabilities: [{ id: 'cap-1', type: 'PUSH_NOTIFICATIONS' }],
      app: { id: 'app-1', bundleId: BUNDLE, name: 'Example' },
      groups: [{ id: 'grp-1', name: 'External Testers', isInternal: false, publicLinkEnabled: false }],
      testersByGroup: { 'grp-1': ['a@example.com'] },
    });

    const { actions } = await planIos({ project, environmentSpec: envSpec(), environment });
    const group = actions.find((action) => action.id === 'ios:group:External Testers')!;
    expect(group.type).toBe('update');
    expect(group.diff).toEqual([{ field: 'publicLinkEnabled', from: 'false', to: 'true' }]);
    expect(group.metadata).toMatchObject({ groupId: 'grp-1' });

    const testers = actions.find((action) => action.id === 'ios:testers:External Testers')!;
    expect(testers.type).toBe('update');
    expect(testers.metadata?.missingTesters).toEqual(['b@example.com']);
  });

  it('warns on internal/external mismatch instead of planning an impossible patch', async () => {
    seedConnection();
    spyObserve({
      bundleId: { id: 'bid-1', identifier: BUNDLE, name: 'Example', platform: 'IOS' },
      capabilities: [{ id: 'cap-1', type: 'PUSH_NOTIFICATIONS' }],
      app: { id: 'app-1', bundleId: BUNDLE, name: 'Example' },
      groups: [{ id: 'grp-1', name: 'External Testers', isInternal: true }],
      testersByGroup: { 'grp-1': ['a@example.com', 'b@example.com'] },
    });

    const { warnings } = await planIos({ project, environmentSpec: envSpec(), environment });
    expect(warnings.some((warning) => warning.includes('cannot change this after creation'))).toBe(true);
  });

  it('degrades to unverified desired actions when observation throws', async () => {
    seedConnection();
    vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier').mockRejectedValue(new Error('ASC 500'));

    const { actions, warnings } = await planIos({ project, environmentSpec: envSpec(), environment });
    expect(warnings[0]).toContain('Could not observe App Store Connect');
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.verified === false)).toBe(true);
  });

  describe('applyIosAction', () => {
    it('registers a missing bundle id and persists the binding', async () => {
      seedConnection();
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier').mockResolvedValue(null);
      const register = vi.spyOn(AppStoreConnectAdapter.prototype, 'registerBundleId')
        .mockResolvedValue({ id: 'bid-new', identifier: BUNDLE, name: 'exampleapp', platform: 'IOS' });

      const result = await applyIosAction({
        project,
        envName: 'production',
        environmentSpec: envSpec(),
        action: {
          id: `ios:bundle-id:${BUNDLE}`,
          type: 'create',
          resource: { kind: 'ios', name: BUNDLE, provider: 'appstoreconnect' },
          verified: true,
          reason: 'test',
          metadata: { operation: 'iosBundleIdRegister' },
        },
      });

      expect(result.success).toBe(true);
      expect(register).toHaveBeenCalledWith(BUNDLE, 'exampleapp', 'IOS');
      const bindings = new EnvironmentRepository().findById(environment.id)!.platformBindings as Record<string, Record<string, unknown>>;
      expect(bindings.ios.bundleIdResourceId).toBe('bid-new');
    });

    it('fails capability enables with per-type errors in the receipt', async () => {
      seedConnection();
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findBundleIdByIdentifier')
        .mockResolvedValue({ id: 'bid-1', identifier: BUNDLE, name: 'Example', platform: 'IOS' });
      vi.spyOn(AppStoreConnectAdapter.prototype, 'enableCapabilities').mockResolvedValue({
        enabled: [],
        alreadyEnabled: [],
        errors: [{ type: 'BOGUS_CAP', error: 'invalid capability type' }],
      });

      const result = await applyIosAction({
        project,
        envName: 'production',
        environmentSpec: envSpec({ capabilities: ['BOGUS_CAP'] }),
        action: {
          id: `ios:capabilities:${BUNDLE}`,
          type: 'update',
          resource: { kind: 'ios', name: BUNDLE, provider: 'appstoreconnect' },
          verified: true,
          reason: 'test',
          metadata: { operation: 'iosCapabilitiesEnable', missingCapabilities: ['BOGUS_CAP'] },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('BOGUS_CAP');
    });

    it('app record apply re-checks and succeeds when the app now exists', async () => {
      seedConnection();
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId')
        .mockResolvedValue({ id: 'app-9', bundleId: BUNDLE, name: 'Example' });

      const result = await applyIosAction({
        project,
        envName: 'production',
        environmentSpec: envSpec(),
        action: {
          id: `ios:app:${BUNDLE}`,
          type: 'create',
          resource: { kind: 'ios', name: BUNDLE, provider: 'appstoreconnect' },
          verified: true,
          reason: 'test',
          metadata: { operation: 'iosAppRecord', manual: true },
        },
      });

      expect(result.success).toBe(true);
      expect(result.data?.appId).toBe('app-9');
      const bindings = new EnvironmentRepository().findById(environment.id)!.platformBindings as Record<string, Record<string, unknown>>;
      expect(bindings.ios.appId).toBe('app-9');
    });

    it('app record apply fails with manual guidance when the app is still missing', async () => {
      seedConnection();
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId').mockResolvedValue(null);

      const result = await applyIosAction({
        project,
        envName: 'production',
        environmentSpec: envSpec(),
        action: {
          id: `ios:app:${BUNDLE}`,
          type: 'create',
          resource: { kind: 'ios', name: BUNDLE, provider: 'appstoreconnect' },
          verified: true,
          reason: 'test',
          metadata: { operation: 'iosAppRecord', manual: true },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Create the app in App Store Connect');
    });

    it('creates a beta group and persists its id; updates when groupId is known', async () => {
      seedConnection();
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId')
        .mockResolvedValue({ id: 'app-1', bundleId: BUNDLE, name: 'Example' });
      const getOrCreate = vi.spyOn(AppStoreConnectAdapter.prototype, 'getOrCreateBetaGroup').mockResolvedValue({
        group: { id: 'grp-new', name: 'External Testers', isInternal: false, publicLink: 'https://testflight.apple.com/join/x' },
        created: true,
      });
      const update = vi.spyOn(AppStoreConnectAdapter.prototype, 'updateBetaGroup').mockResolvedValue(
        { id: 'grp-new', name: 'External Testers', isInternal: false, publicLinkEnabled: true }
      );

      const baseAction = {
        id: 'ios:group:External Testers',
        type: 'create' as const,
        resource: { kind: 'ios' as const, name: 'External Testers', provider: 'appstoreconnect' },
        verified: true,
        reason: 'test',
      };

      const created = await applyIosAction({
        project,
        envName: 'production',
        environmentSpec: envSpec(),
        action: { ...baseAction, metadata: { operation: 'iosBetaGroupEnsure', groupName: 'External Testers' } },
      });
      expect(created.success).toBe(true);
      expect(created.data).toMatchObject({ groupId: 'grp-new', created: true });
      expect(getOrCreate).toHaveBeenCalledTimes(1);

      const bindings = new EnvironmentRepository().findById(environment.id)!.platformBindings as Record<string, Record<string, unknown>>;
      expect((bindings.ios.testflight as Record<string, Record<string, Record<string, unknown>>>).groups['External Testers'].groupId).toBe('grp-new');

      const updated = await applyIosAction({
        project,
        envName: 'production',
        environmentSpec: envSpec(),
        action: { ...baseAction, type: 'update', metadata: { operation: 'iosBetaGroupEnsure', groupName: 'External Testers', groupId: 'grp-new' } },
      });
      expect(updated.success).toBe(true);
      expect(update).toHaveBeenCalledWith('grp-new', expect.objectContaining({ publicLinkEnabled: true }));
    });

    it('ensures testers through the shared addTestersToGroup path', async () => {
      seedConnection();
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findAppByBundleId')
        .mockResolvedValue({ id: 'app-1', bundleId: BUNDLE, name: 'Example' });
      vi.spyOn(AppStoreConnectAdapter.prototype, 'findBetaGroupByName')
        .mockResolvedValue({ id: 'grp-1', name: 'External Testers', isInternal: false });
      vi.spyOn(AppStoreConnectAdapter.prototype, 'listBetaTesters').mockResolvedValue([]);
      const getOrCreateTester = vi.spyOn(AppStoreConnectAdapter.prototype, 'getOrCreateBetaTester')
        .mockImplementation(async (input) => ({ tester: { id: `tester-${input.email}`, email: input.email }, created: true }));

      const result = await applyIosAction({
        project,
        envName: 'production',
        environmentSpec: envSpec(),
        action: {
          id: 'ios:testers:External Testers',
          type: 'update',
          resource: { kind: 'ios', name: 'External Testers', provider: 'appstoreconnect' },
          verified: true,
          reason: 'test',
          metadata: { operation: 'iosGroupTestersEnsure', groupName: 'External Testers', missingTesters: ['b@example.com'] },
        },
      });

      expect(result.success).toBe(true);
      expect(getOrCreateTester).toHaveBeenCalledTimes(1);
      expect(result.data?.added).toBe(1);
    });
  });
});
