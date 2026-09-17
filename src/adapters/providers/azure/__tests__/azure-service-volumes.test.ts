import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureContainerAppsAdapter } from '../azure-container-apps.adapter.js';
import { resourceName } from '../../../../domain/services/resource-names.js';
import { observeServiceVolumes, planServiceVolumes, applyServiceVolumeAction, parseServiceVolumeBindings, retainedVolumeHostingBlock } from '../../../../domain/services/service-volume.service.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { ObservedState } from '../../../../domain/ports/observe.port.js';

// Synthetic transport state, not live certification. Shapes/semantics are sourced from:
// https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts
// https://learn.microsoft.com/en-us/rest/api/storagerp/file-shares/create?view=rest-storagerp-2025-08-01
// https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/managed-environments-storages/create-or-update?view=rest-resource-manager-containerapps-2026-01-01
const SUB = '22222222-2222-4222-8222-222222222222';
const GROUP = `/subscriptions/${SUB}/resourceGroups/staging`;
const ENV = `${GROUP}/providers/Microsoft.App/managedEnvironments/runtime`;
const APP = `${GROUP}/providers/Microsoft.App/containerApps/web`;
const PROVIDER = `/subscriptions/${SUB}/providers/Microsoft.Storage`;
const accountName = resourceName('files', { compact: true, maxLength: 24, minLength: 3, scope: [GROUP.toLowerCase(), APP.toLowerCase()] });
const ACCOUNT = `${GROUP}/providers/Microsoft.Storage/storageAccounts/${accountName}`;
const SHARE = `${ACCOUNT}/fileServices/default/shares/data`;
const STORAGE = `${ENV}/storages/${resourceName('web', { maxLength: 63 })}`;
const target = { projectId: GROUP, environmentId: ENV, serviceId: APP, mountPath: '/data', instanceScope: { location: 'canadacentral' } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fixture() {
  const resources = new Map<string, any>([
    [GROUP.toLowerCase(), { id: GROUP, location: 'canadacentral' }],
    [ENV.toLowerCase(), { id: ENV, location: 'canadacentral', properties: { provisioningState: 'Succeeded' } }],
    [APP.toLowerCase(), { id: APP, properties: { managedEnvironmentId: ENV, provisioningState: 'Succeeded', latestRevisionName: 'web--1', latestReadyRevisionName: 'web--1', template: { containers: [{ name: 'main', image: 'example@sha256:' + 'a'.repeat(64), env: [{ name: 'EXISTING', value: 'keep' }] }], scale: { minReplicas: 1, maxReplicas: 4 } } } }],
    [PROVIDER.toLowerCase(), { id: PROVIDER, registrationState: 'Registered' }],
  ]);
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const faults = new Map<string, number>();
  let lostWrite: string | undefined;
  let dropMounts = false;
  let revision = 1;
  let advanceReads: number | undefined;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return json({ access_token: 'private-test-token', expires_in: 3600 });
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const key = path.toLowerCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (faults.has(key)) return json({ error: 'private-test-token' }, faults.get(key));
    if (method === 'GET') {
      if (key === APP.toLowerCase() && advanceReads !== undefined && ++advanceReads === 2) resources.get(key).properties.template.containers[0].image = 'new-image@sha256:' + 'c'.repeat(64);
      return resources.has(key) ? json(resources.get(key)) : json({ error: 'NotFound' }, 404);
    }
    if (method === 'POST' && key.endsWith('/listkeys')) return json({ keys: [{ permissions: 'FULL', value: 'private-storage-key' }] });
    if (method === 'POST' && key.endsWith('/listsecrets')) return json({ value: [] });
    if (method === 'POST' && key === `${PROVIDER.toLowerCase()}/register`) {
      const registered = { id: PROVIDER, registrationState: 'Registered' };
      resources.set(PROVIDER.toLowerCase(), registered);
      return json(registered);
    }
    if (method === 'PUT') {
      let result: any;
      if (key === ACCOUNT.toLowerCase()) {
        expect(body).toMatchObject({ kind: 'StorageV2', sku: { name: 'Standard_LRS' }, properties: { supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false } });
        result = { id: ACCOUNT, location: 'canadacentral', kind: 'StorageV2', sku: { name: 'Standard_LRS' }, tags: body.tags, properties: { provisioningState: 'Succeeded', supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false, allowSharedKeyAccess: true } };
      } else if (key === SHARE.toLowerCase()) {
        expect(body.properties.enabledProtocols).toBe('SMB');
        result = { id: SHARE, properties: { enabledProtocols: 'SMB', shareQuota: 5 } };
      } else if (key === STORAGE.toLowerCase()) {
        expect(body).toEqual({ properties: { azureFile: { accountName, accountKey: 'private-storage-key', shareName: 'data', accessMode: 'ReadWrite' } } });
        result = { id: STORAGE, properties: { azureFile: { accountName, shareName: 'data', accessMode: 'ReadWrite' } } };
      } else throw new Error(`Unexpected PUT ${path}`);
      resources.set(key, result);
      if (lostWrite === key) throw new Error('connection lost private-storage-key');
      return json(result, 201);
    }
    if (method === 'PATCH' && key === APP.toLowerCase()) {
      expect(body.properties.template.volumes).toContainEqual({ name: 'hypervibe-data', storageType: 'AzureFile', storageName: 'web' });
      expect(body.properties.template.containers[0].volumeMounts).toContainEqual({ volumeName: 'hypervibe-data', mountPath: '/data' });
      const app = resources.get(key);
      revision++;
      resources.set(key, { ...app, properties: { ...app.properties, template: body.properties.template, latestRevisionName: `web--${revision}`, latestReadyRevisionName: `web--${revision}` } });
      if (dropMounts) resources.get(key).properties.template.containers[0].volumeMounts = [];
      return json(resources.get(key));
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  return { resources, calls, faults, loseWrite: (path: string) => { lostWrite = path.toLowerCase(); }, dropMounts: () => { dropMounts = true; }, advanceRuntime: () => { advanceReads = 0; } };
}

async function adapter() {
  const result = new AzureContainerAppsAdapter();
  await result.connect({ tenantId: '11111111-1111-4111-8111-111111111111', subscriptionId: SUB, clientId: '33333333-3333-4333-8333-333333333333', clientSecret: 'private-client-secret' });
  return result;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Azure Files component-scoped service volumes', () => {
  it('exposes separate account, share, registration and attachment actions instead of a compound create', async () => {
    fixture();
    const volumes = (await adapter() as any).serviceVolumes;
    expect(volumes?.staged).toBeDefined();
    expect(volumes.staged.components(target).map((item: any) => item.key)).toEqual(['storage-provider', 'account', 'share', 'environment-storage', 'attachment']);
    expect(await volumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
  });

  it('creates each exact resource separately and preserves the existing app runtime', async () => {
    const live = fixture();
    const staged = (await adapter() as any).serviceVolumes?.staged;
    expect(staged).toBeDefined();
    const bindings: Record<string, any> = {};
    for (const key of ['account', 'share', 'environment-storage', 'attachment']) {
      expect(await staged.observeComponent(target, key, bindings)).toEqual({ state: 'absent' });
      const before = live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method)).length;
      const receipt = await staged.applyComponent(target, key, bindings);
      expect(receipt).toMatchObject({ success: true, mutationAttempted: true });
      expect(live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method))).toHaveLength(before + 1);
      expect(JSON.stringify(receipt)).not.toContain('private-');
      bindings[key] = { state: 'bound', externalId: receipt.externalId };
      expect(await staged.observeComponent(target, key, bindings)).toMatchObject({ state: 'present', ready: true, externalId: receipt.externalId });
    }
    const template = live.resources.get(APP.toLowerCase()).properties.template;
    expect(template.containers[0].env).toEqual([{ name: 'EXISTING', value: 'keep' }]);
    expect(template.scale).toEqual({ minReplicas: 1, maxReplicas: 4 });
    expect(live.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('keeps forbidden and malformed observations unknown and never adopts an existing account', async () => {
    const live = fixture();
    const staged = (await adapter() as any).serviceVolumes?.staged;
    expect(staged).toBeDefined();
    live.faults.set(ACCOUNT.toLowerCase(), 403);
    expect(await staged.observeComponent(target, 'account', {})).toMatchObject({ state: 'unknown' });
    expect(await staged.applyComponent(target, 'account', {})).toMatchObject({ success: false, mutationAttempted: false });
    live.faults.clear();
    live.resources.set(ACCOUNT.toLowerCase(), { id: ACCOUNT });
    expect(await staged.observeComponent(target, 'account', {})).toMatchObject({ state: 'unknown' });
    expect(live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method))).toHaveLength(0);
  });

  it('does not synthesize an acknowledgement from a deterministic ARM path after a lost write', async () => {
    const live = fixture();
    const staged = (await adapter() as any).serviceVolumes?.staged;
    expect(staged).toBeDefined();
    live.loseWrite(ACCOUNT);
    const receipt = await staged.applyComponent(target, 'account', {});
    expect(receipt).toMatchObject({ success: false, mutationAttempted: true });
    expect(receipt.externalId).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('private-');
    expect(await staged.applyComponent(target, 'account', {})).toMatchObject({ success: false, mutationAttempted: false });
    expect(live.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('rejects sibling subscription or wrong managed environment before any write', async () => {
    const live = fixture();
    const staged = (await adapter() as any).serviceVolumes?.staged;
    expect(staged).toBeDefined();
    expect(await staged.applyComponent({ ...target, environmentId: `${GROUP}/providers/Microsoft.App/managedEnvironments/production` }, 'account', {})).toMatchObject({ success: false, mutationAttempted: false });
    expect(await staged.applyComponent({ ...target, projectId: GROUP.replace(SUB, '99999999-9999-4999-8999-999999999999') }, 'account', {})).toMatchObject({ success: false, mutationAttempted: false });
    expect(live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method))).toHaveLength(0);
  });

  it('resolves the observed placement and isolates another environment with the same service name', async () => {
    const live = fixture();
    const staged = (await adapter()).serviceVolumes.staged;
    const resolved = await staged.resolveTarget({ environment: { platformBindings: { projectId: GROUP, environmentId: ENV, services: { web: { serviceId: APP } } } }, environmentSpec: {} as any, serviceName: 'web', mountPath: '/data' });
    expect(resolved).toEqual(target);
    const otherGroup = GROUP.replace('/staging', '/production');
    const otherEnv = ENV.replace('/staging', '/production');
    const otherApp = APP.replace('/staging', '/production');
    for (const [oldId, newId] of [[GROUP, otherGroup], [ENV, otherEnv], [APP, otherApp]]) {
      const original = live.resources.get(oldId!.toLowerCase());
      live.resources.set(newId!.toLowerCase(), { ...original, id: newId, properties: { ...original.properties, ...(newId === otherApp ? { managedEnvironmentId: otherEnv } : {}) } });
    }
    expect(await staged.applyComponent(target, 'account', {})).toMatchObject({ success: true });
    const production = { ...target, projectId: otherGroup, environmentId: otherEnv, serviceId: otherApp };
    expect(await staged.observeComponent(production, 'account', {})).toEqual({ state: 'absent' });
    expect(live.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('registers the shared API alone and retains not-ready account identity without a second PUT', async () => {
    const live = fixture();
    const staged = (await adapter()).serviceVolumes.staged;
    live.resources.set(PROVIDER.toLowerCase(), { id: PROVIDER, registrationState: 'NotRegistered' });
    expect(await staged.applyComponent(target, 'storage-provider', {})).toMatchObject({ success: true, externalId: PROVIDER });
    expect(live.calls.filter((call) => call.method !== 'GET').map((call) => call.path)).toEqual([`${PROVIDER}/register`]);
    const created = await staged.applyComponent(target, 'account', {});
    const resource = live.resources.get(ACCOUNT.toLowerCase());
    resource.properties.provisioningState = 'Creating';
    const bindings = { account: { state: 'identified' as const, externalId: created.externalId } };
    expect(await staged.observeComponent(target, 'account', bindings)).toMatchObject({ state: 'present', ready: false, externalId: ACCOUNT });
    expect(await staged.applyComponent(target, 'account', bindings)).toMatchObject({ success: false, mutationAttempted: false });
    expect(live.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  });

  it('blocks conflicting mount paths instead of replacing another attachment', async () => {
    const live = fixture();
    const staged = (await adapter()).serviceVolumes.staged;
    const app = live.resources.get(APP.toLowerCase());
    app.properties.template.volumes = [{ name: 'other', storageType: 'EmptyDir' }];
    app.properties.template.containers[0].volumeMounts = [{ volumeName: 'other', mountPath: '/data' }];
    expect(await staged.observeComponent(target, 'attachment', {})).toMatchObject({ state: 'unknown' });
    expect(await staged.applyComponent(target, 'attachment', {})).toMatchObject({ success: false, mutationAttempted: false });
    expect(live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method))).toHaveLength(0);
  });

  it('runs real shared planning, confirmations, persisted intent, re-planning and retention through ARM transport', async () => {
    const live = fixture();
    const volumes = (await adapter()).serviceVolumes;
    let environment: Environment = { id: 'local-env', projectId: 'local-project', name: 'staging', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'azure-container-apps', projectId: GROUP, environmentId: ENV, services: { web: { serviceId: APP } } } };
    const spec = environmentSpecSchema.parse({ hosting: { provider: 'azure-container-apps' }, services: { web: { volume: { mountPath: '/data' } } } });
    const plan = async () => planServiceVolumes({ environment, environmentSpec: spec, observed: { serviceVolumes: await observeServiceVolumes({ environment, environmentSpec: spec, volumes }) } as ObservedState }).actions;
    const save = (serviceVolumes: any) => { environment = { ...environment, platformBindings: { ...environment.platformBindings, serviceVolumes } }; };
    for (const component of ['account', 'share', 'environment-storage', 'attachment']) {
      const actions = await plan();
      const action = actions.find((entry) => entry.type !== 'noop')!;
      expect(action?.metadata?.component).toBe(component);
      const mutationsBefore = live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method)).length;
      expect(await applyServiceVolumeAction({ environment, environmentSpec: spec, action, volumes, confirmedActionIds: new Set(), save })).toMatchObject({ success: false });
      expect(live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method))).toHaveLength(mutationsBefore);
      const result = await applyServiceVolumeAction({ environment, environmentSpec: spec, action, volumes, confirmedActionIds: new Set([action.id]), save });
      expect(result, JSON.stringify({ component, result, action })).toMatchObject({ success: true });
      expect(parseServiceVolumeBindings(environment)?.web?.components?.[component]?.state).toBe('bound');
    }
    expect((await plan()).every((entry) => entry.type === 'noop')).toBe(true);
    const writes = live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method)).length;
    expect((await plan()).every((entry) => entry.type === 'noop')).toBe(true);
    expect(live.calls.filter((call) => ['PUT', 'PATCH'].includes(call.method))).toHaveLength(writes);
    const omitted = environmentSpecSchema.parse({ hosting: { provider: 'azure-container-apps' }, services: { web: {} } });
    expect(retainedVolumeHostingBlock(environment, omitted, { id: 'destroy', type: 'destroy', resource: { kind: 'project', provider: 'azure-container-apps', name: 'staging' }, reason: 'test', verified: true })).toBeTruthy();
    expect(JSON.stringify(environment.platformBindings)).not.toContain('private-');
  });

  it('does not call a direct env rollout successful when the ready revision lost its mount', async () => {
    const live = fixture();
    const driver = await adapter();
    const bindings: Record<string, any> = {};
    for (const key of ['account', 'share', 'environment-storage', 'attachment']) {
      const receipt = await driver.serviceVolumes.staged.applyComponent(target, key, bindings);
      bindings[key] = { state: 'bound', externalId: receipt.externalId };
    }
    live.resources.get(APP.toLowerCase()).tags = { 'managed-by': 'hypervibe', 'hypervibe-environment-id': 'local-env' };
    live.dropMounts();
    const receipt = await driver.deleteEnvVars({ id: 'local-env', platformBindings: { services: { web: { serviceId: APP } } } } as any, { name: 'web' } as any, ['EXISTING']);
    expect(receipt.success).toBe(false);
    expect(receipt.error).toMatch(/mount|volume/i);
  });
  it('attaches using the freshest app runtime rather than restoring a stale image', async () => {
    const live = fixture();
    const driver = (await adapter()).serviceVolumes.staged;
    const bindings: Record<string, any> = {};
    for (const key of ['account', 'share', 'environment-storage']) {
      const receipt = await driver.applyComponent(target, key, bindings);
      bindings[key] = { state: 'bound', externalId: receipt.externalId };
    }
    live.advanceRuntime();
    expect(await driver.applyComponent(target, 'attachment', bindings)).toMatchObject({ success: true });
    expect(live.calls.find((call) => call.method === 'PATCH')?.body.properties.template.containers[0].image).toBe('new-image@sha256:' + 'c'.repeat(64));
  });
});
