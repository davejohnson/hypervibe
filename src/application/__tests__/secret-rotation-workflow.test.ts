import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { CommandRegistry } from '../commands.js';
import { registerHvSecretsTools } from '../../tools/hv-secrets.tools.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
import * as cloudRun from '../../adapters/providers/gcp/gcp-cloud-run.client.js';
import * as secretManager from '../../adapters/providers/gcp/gcp-secret-manager.client.js';
import * as infrastructure from '../infrastructure-engine.js';
import * as launch from '../launch.js';
import * as pastePage from '../local-paste-page.js';
import { rotateSecrets } from '../secret-rotation.js';

type Page = Parameters<typeof pastePage.serveMultiPastePage>[0];
const oldCreatedAt = '2025-01-01T00:00:00.000Z';
const parentKey = 'RECAPTCHA_SECRET_KEY';
const companionKey = 'RECAPTCHA_SITE_KEY';
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-rotation-workflow-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00.000Z'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://www.google.com/recaptcha/api/siteverify') {
      return Response.json({ 'error-codes': ['missing-input-response'] });
    }
    throw new Error('Unexpected network request in secret rotation regression');
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  SqliteAdapter.resetInstance();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(importedSecrets: string[], generatedSecrets: string[] = [], generatedEnvironment = 'staging') {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'rotation-workflow', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging' });
  ctx.repos.environments.updatePlatformBindings(environment.id, { engine: { kind: 'opentofu', importedSecrets } });
  const spec = projectSpecSchema.parse({
    version: 1, project: project.name,
    secrets: Object.fromEntries(generatedSecrets.map((key) => [key, {
      ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: [generatedEnvironment],
    }])),
    environments: {
      staging: { hosting: { provider: 'cloudrun' }, services: { web: {} } },
      ...(generatedEnvironment !== 'staging' ? { [generatedEnvironment]: { hosting: { provider: 'cloudrun' }, services: { web: {} } } } : {}),
    },
  });
  new ProjectSpecRepository().insert(project.id, 1, spec);
  const adapter = new CloudRunAdapter();
  vi.spyOn(adapter, 'engineAccessToken').mockResolvedValue('synthetic-control-plane-token');
  vi.spyOn(infrastructure, 'resolveEngineContext').mockImplementation(async () => ({
    adapter, environment: ctx.repos.environments.findById(environment.id)!,
    gcpProjectId: 'rotation-fixture', region: 'us-central1',
    runtimeServiceAccountEmail: 'runtime@rotation-fixture.iam.gserviceaccount.com',
    auth: { env: {}, redact: [] },
    state: { provider: 'gcp', projectId: project.id, environmentId: environment.id, partition: 'environment' },
  }));

  // Simulate provider acknowledgements and subsequent reads, while retaining the
  // real orchestration, ownership classification and durable rotation record.
  const keyById = new Map([...importedSecrets, ...generatedSecrets].map((key) => [infrastructure.engineSecretId('staging', key), key]));
  const createdAt = new Map([...keyById.keys()].map((id) => [id, oldCreatedAt]));
  const failedWrites = new Set<string>();
  const accepted: Array<{ key: string; value: string }> = [];
  const write = vi.spyOn(infrastructure, 'writeSecretVersion').mockImplementation(async (_token, _projectId, id, _labels, value) => {
    const key = keyById.get(id);
    if (!key) throw new Error('Unexpected secret write');
    if (failedWrites.has(key)) return { success: false, status: 'blocked', message: 'Synthetic save failure' };
    accepted.push({ key, value });
    createdAt.set(id, new Date().toISOString());
    return undefined;
  });
  const latest = vi.spyOn(secretManager, 'latestSecretVersion').mockImplementation(async (_token, _projectId, id) => {
    if (!createdAt.has(id)) throw new Error('Unexpected Secret Manager read');
    return Response.json({ createTime: createdAt.get(id) });
  });
  const enabledVersions = vi.spyOn(secretManager, 'enabledSecretVersions').mockImplementation(async (_token, _projectId, id) => {
    if (!createdAt.has(id)) throw new Error('Unexpected Secret Manager read');
    return Response.json({ versions: [{ name: `projects/rotation-fixture/secrets/${id}/versions/1` }] });
  });
  vi.spyOn(secretManager, 'disableSecretVersion').mockRejectedValue(new Error('Unexpected Secret Manager operation'));
  const launchSpy = vi.spyOn(launch, 'launchEnvironment').mockResolvedValue({ status: 'ready', phase: 'infrastructure', infrastructureRounds: 1 });
  const page = vi.spyOn(pastePage, 'serveMultiPastePage').mockResolvedValue({ status: 'waiting', provider: 'secret', scope: 'staging', message: 'Waiting for private input' });
  const rotate = (params: Omit<Parameters<typeof rotateSecrets>[1], 'project' | 'environmentName'> = {}) => rotateSecrets(ctx, { project, environmentName: 'staging', ...params });
  const rotation = () => (ctx.repos.environments.findById(environment.id)!.platformBindings as { engine: infrastructure.EngineBinding }).engine.rotation;
  const protect = (key: string) => new SpecStore().merge(project, { secrets: { [key]: {
    ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: [generatedEnvironment], replacementPolicy: 'immutable',
  } } });
  const registry = new CommandRegistry();
  registerHvSecretsTools(registry, ctx);
  const command = (action: 'rotate' | 'ages', input: Record<string, unknown> = {}) =>
    registry.execute('hv_secrets', { project: project.name, env: 'staging', action, ...input });
  const observePinnedWorkload = (keys: string[], version = '1') => {
    ctx.repos.environments.updatePlatformBindings(environment.id, { services: { web: { serviceId: 'web' } } });
    vi.spyOn(cloudRun, 'cloudRunGet').mockResolvedValue({ state: 'present', value: {
      latestReadyRevision: 'web-1', latestCreatedRevision: 'web-1', template: { containers: [{ env: keys.map((key) => ({
        valueSource: { secretKeyRef: { secret: infrastructure.engineSecretId('staging', key), version } },
      })) }] },
    } });
  };
  const binding = () => (ctx.repos.environments.findById(environment.id)!.platformBindings as { engine: infrastructure.EngineBinding }).engine;
  return { command, protect, environment, binding, observePinnedWorkload, rotate, rotation, page, write, latest, enabledVersions, accepted, failedWrites, launchSpy };
}

const waiting = { status: 'waiting' as const, provider: 'secret', scope: 'staging', message: 'Waiting for private input' };
const connected = { ...waiting, status: 'connected' as const };
const fieldIds = (page: Page) => page.spec.fields.map((field) => field.id);

describe('rotation generation requires declared ownership', () => {
  // The architecture distinguishes app-owned generation from externally issued
  // input. Neither an unfamiliar key nor a signing-secret name proves ownership.
  it.each(['GITHUB_TOKEN', 'SMTP_PASSWORD', 'JWT_SECRET'])('keeps imported %s as private input when generateInternal is requested', async (key) => {
    const f = fixture([key]);
    const result = await f.rotate({ generateInternal: true });
    expect(f.write).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'needs_input', keys: [key] });
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(f.rotation()?.keys).toEqual([key]);
  });

  it('offers no Generate option for imported credentials or companion settings', async () => {
    const f = fixture(['GITHUB_TOKEN', 'SMTP_PASSWORD', 'JWT_SECRET', parentKey, companionKey]);
    await f.rotate();
    const fields = f.page.mock.calls[0]![0].spec.fields;
    expect(fields.map((field) => field.id)).toEqual(['GITHUB_TOKEN', 'SMTP_PASSWORD', 'JWT_SECRET', parentKey, companionKey]);
    expect(fields.filter((field) => field.allowGenerate)).toEqual([]);
    expect(f.write).not.toHaveBeenCalled();
  });

  it('rejects Generate at the save callback for unknown keys, known external keys and settings', async () => {
    const keys = ['GITHUB_TOKEN', 'SMTP_PASSWORD', 'JWT_SECRET', parentKey, companionKey];
    const f = fixture(keys);
    const outcomes: Array<{ key: string; ok: boolean }> = [];
    f.page.mockImplementation(async (page) => {
      for (const key of keys) outcomes.push({ key, ok: (await page.accept(key, { generate: true })).ok });
      return waiting;
    });
    const result = await f.rotate();
    expect(outcomes).toEqual(keys.map((key) => ({ key, ok: false })));
    expect(f.write).not.toHaveBeenCalled();
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('needs_input');
  });

  it.each([false, true])('rotates an explicitly app-owned secret once (also imported: %s)', async (alsoImported) => {
    const f = fixture(alsoImported ? ['JWT_SECRET'] : [], ['JWT_SECRET']);
    const result = await f.rotate({ generateInternal: true });
    expect(result).toMatchObject({ status: 'rotated', rotated: ['JWT_SECRET'] });
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.accepted).toEqual([{ key: 'JWT_SECRET', value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }]);
    expect(f.page).not.toHaveBeenCalled();
    expect(f.launchSpy).toHaveBeenCalledOnce();
    expect(f.rotation()).toBeUndefined();
  });

  it('accepts an owner-supplied replacement for an unknown external credential', async () => {
    const f = fixture(['GITHUB_TOKEN']);
    f.page.mockImplementation(async (page) => {
      expect(await page.accept('GITHUB_TOKEN', 'synthetic-provider-issued-token')).toMatchObject({ ok: true });
      return connected;
    });
    expect(await f.rotate()).toMatchObject({ status: 'rotated', rotated: ['GITHUB_TOKEN'] });
    expect(f.accepted).toEqual([{ key: 'GITHUB_TOKEN', value: 'synthetic-provider-issued-token' }]);
    expect(f.launchSpy).toHaveBeenCalledOnce();
  });

  it('does not borrow generation ownership from another environment', async () => {
    const f = fixture(['JWT_SECRET'], ['JWT_SECRET'], 'production');
    const result = await f.rotate({ generateInternal: true });
    expect(f.write).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'needs_input', keys: ['JWT_SECRET'] });
    expect(f.launchSpy).not.toHaveBeenCalled();
  });
});

describe('immutable generated secrets through the registered rotation command', () => {
  const protectedKey = 'DOCUMENT_ENCRYPTION_KEY';
  const mutableKey = 'SESSION_SECRET';

  it.each([{ key: protectedKey }, { keys: [mutableKey, protectedKey] }])('rejects an explicit immutable selection before any effect', async (input) => {
    const f = fixture([protectedKey], [mutableKey, protectedKey]);
    f.protect(protectedKey);
    expect(await f.command('rotate', input)).toMatchObject({ ok: false, error: { message: expect.stringContaining(protectedKey) } });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(f.enabledVersions).not.toHaveBeenCalled();
    expect(f.rotation()).toBeUndefined();
  });

  it('omits the immutable key from default rotation, retirement and overdue advice', async () => {
    const f = fixture([], [protectedKey, mutableKey]);
    f.protect(protectedKey);
    f.observePinnedWorkload([protectedKey, mutableKey]);
    expect(await f.command('ages')).toMatchObject({ data: { secrets: expect.arrayContaining([
      expect.objectContaining({ key: protectedKey, kind: 'generated', overdue: false }),
      expect.objectContaining({ key: mutableKey, kind: 'generated', overdue: true }),
    ]) } });
    expect(await f.command('rotate')).toMatchObject({ ok: true, data: { status: 'rotated', rotated: [mutableKey] } });
    expect(f.accepted.map(({ key }) => key)).toEqual([mutableKey]);
    expect(f.enabledVersions.mock.calls.map(([, , id]) => id)).toEqual([infrastructure.engineSecretId('staging', mutableKey)]);
    expect(f.launchSpy).toHaveBeenCalledOnce();
  });

  it('leaves a default selection of only immutable keys untouched even if the age read fails', async () => {
    const f = fixture([], [protectedKey]);
    f.protect(protectedKey);
    f.latest.mockResolvedValue(new Response(null, { status: 403 }));
    expect(await f.command('rotate')).toMatchObject({ ok: false, error: { message: expect.stringContaining(protectedKey) } });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(f.rotation()).toBeUndefined();
  });

  it.each([true, false])('uses current policy when inventory changes before starting (explicit: %s)', async (explicit) => {
    const f = fixture([], [protectedKey, mutableKey]);
    f.latest.mockImplementationOnce(async () => {
      f.protect(protectedKey);
      return Response.json({ createTime: oldCreatedAt });
    });
    const result = await f.command('rotate', explicit ? { keys: [protectedKey, mutableKey] } : {});
    if (explicit) {
      expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(protectedKey) } });
      expect(f.write).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: true, data: { rotated: [mutableKey] } });
      expect(f.accepted.map(({ key }) => key)).toEqual([mutableKey]);
    }
    expect(f.rotation()).toBeUndefined();
  });

  it.each(['generated', 'pasted'])('rechecks policy after the native container read before a %s value write', async (source) => {
    const f = source === 'generated' ? fixture([], [protectedKey]) : fixture([protectedKey]);
    f.write.mockRestore();
    const resource = `projects/rotation-fixture/secrets/${infrastructure.engineSecretId('staging', protectedKey)}`;
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        urls.push(url);
        return Response.json({ name: `${resource}/versions/2` });
      }
      if (url.endsWith('/versions/latest')) {
        f.protect(protectedKey);
        return Response.json({ name: `${resource}/versions/1`, state: 'ENABLED' });
      }
      return Response.json({ name: resource, labels: { 'managed-by': 'hypervibe', 'hv-environment': f.environment.id } });
    }));
    if (source === 'pasted') {
      f.page.mockImplementationOnce(async (page) => {
        const saved = await page.accept(protectedKey, 'synthetic-provider-value');
        return saved.ok ? connected : waiting;
      });
    }
    const result = await f.command('rotate', { keys: [protectedKey] });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining(protectedKey) } });
    expect(urls).toEqual([]);
    expect(f.binding().secretMetadata).toBeUndefined();
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(f.rotation()?.keys).toEqual([protectedKey]);
  });

  it.each([true, false])('preserves a partial rotation record when a selected key becomes immutable (already saved: %s)', async (saved) => {
    const f = fixture(['EXTERNAL_TOKEN'], [protectedKey, mutableKey]);
    if (!saved) f.failedWrites.add(protectedKey);
    await f.command('rotate');
    const interrupted = f.rotation();
    expect(interrupted?.keys).toContain(protectedKey);
    f.protect(protectedKey);
    f.failedWrites.clear();
    f.write.mockClear();
    f.page.mockClear();
    expect(await f.command('rotate', { keys: [mutableKey] })).toMatchObject({ ok: false, error: { message: expect.stringContaining(protectedKey) } });
    expect(f.rotation()).toEqual(interrupted);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.page).not.toHaveBeenCalled();
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(f.enabledVersions).not.toHaveBeenCalled();
  });

  it('blocks replacement of a protected companion when its external key is selected', async () => {
    const f = fixture([parentKey, companionKey], [companionKey]);
    f.protect(companionKey);
    expect(await f.command('rotate', { keys: [parentKey] })).toMatchObject({ ok: false, error: { message: expect.stringContaining(companionKey) } });
    expect(f.page).not.toHaveBeenCalled();
    expect(f.rotation()).toBeUndefined();
  });

  it('rechecks protection before saving an already-open private form or rolling out its result', async () => {
    const f = fixture([parentKey, companionKey]);
    f.page.mockImplementationOnce(async (page) => {
      f.protect(companionKey);
      expect(await page.accept(companionKey, 'synthetic-replacement')).toMatchObject({ ok: false });
      return connected;
    });
    expect(await f.command('rotate', { keys: [parentKey] })).toMatchObject({ ok: false, error: { message: expect.stringContaining(companionKey) } });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(f.enabledVersions).not.toHaveBeenCalled();
  });

  it('preserves old versions when policy changes while checking workload adoption', async () => {
    const f = fixture([], [protectedKey]);
    f.observePinnedWorkload([protectedKey], '2');
    f.enabledVersions.mockImplementationOnce(async (_token, _projectId, secretId) => {
      f.protect(protectedKey);
      return Response.json({ versions: [{ name: `projects/rotation-fixture/secrets/${secretId}/versions/1` }] });
    });
    expect(await f.command('rotate')).toMatchObject({ ok: false, error: { message: expect.stringContaining(protectedKey) } });
    expect(secretManager.disableSecretVersion).not.toHaveBeenCalled();
    expect(f.rotation()?.keys).toContain(protectedKey);
  });

  it('reports a partial retirement and preserves the remaining version after the policy changes', async () => {
    const f = fixture([], [protectedKey]);
    f.observePinnedWorkload([protectedKey], '3');
    const versionPath = `projects/rotation-fixture/secrets/${infrastructure.engineSecretId('staging', protectedKey)}/versions`;
    f.enabledVersions.mockResolvedValueOnce(Response.json({ versions: [{ name: `${versionPath}/1` }, { name: `${versionPath}/2` }] }));
    vi.mocked(secretManager.disableSecretVersion).mockImplementationOnce(async () => {
      f.protect(protectedKey);
      return Response.json({});
    });
    const result = await f.command('rotate');
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('1 old version') } });
    expect(secretManager.disableSecretVersion).toHaveBeenCalledExactlyOnceWith(expect.any(String), `${versionPath}/1`);
    expect(f.rotation()?.keys).toContain(protectedKey);
  });

  it('blocks retirement if a selected key becomes immutable during rollout', async () => {
    const f = fixture([], [protectedKey]);
    f.launchSpy.mockImplementation(async () => {
      f.protect(protectedKey);
      return { status: 'ready', phase: 'infrastructure', infrastructureRounds: 1 };
    });
    expect(await f.command('rotate')).toMatchObject({ ok: false, error: { message: expect.stringContaining(protectedKey) } });
    expect(f.enabledVersions).not.toHaveBeenCalled();
    expect(f.rotation()?.keys).toContain(protectedKey);
  });
});

describe('rotation resumes every unfinished member of a selected credential group', () => {
  it.each([
    { savedFirst: parentKey, unfinished: companionKey },
    { savedFirst: companionKey, unfinished: parentKey },
  ])('asks only for $unfinished after $savedFirst was saved before interruption', async ({ savedFirst, unfinished }) => {
    const f = fixture([parentKey, companionKey, 'GITHUB_TOKEN']);
    f.page.mockImplementationOnce(async (page) => {
      expect(fieldIds(page)).toEqual([parentKey, companionKey]);
      expect(await page.accept(savedFirst, `synthetic-${savedFirst}`)).toMatchObject({ ok: true });
      return waiting;
    });
    expect((await f.rotate({ keys: [parentKey] })).status).toBe('needs_input');
    expect(f.launchSpy).not.toHaveBeenCalled();
    f.page.mockClear();

    const result = await f.rotate();
    expect(result).toMatchObject({ status: 'needs_input', keys: [unfinished] });
    expect(fieldIds(f.page.mock.calls[0]![0])).toEqual([unfinished]);
    expect(f.accepted.map(({ key }) => key)).toEqual([savedFirst]);
    expect(f.launchSpy).not.toHaveBeenCalled();
    expect(f.rotation()?.keys).toEqual([parentKey]);
    expect(f.enabledVersions).not.toHaveBeenCalled();
  });

  it('retries a failed companion save and launches only after that replacement succeeds', async () => {
    const f = fixture([parentKey, companionKey]);
    f.failedWrites.add(companionKey);
    f.page.mockImplementationOnce(async (page) => {
      expect(await page.accept(parentKey, 'synthetic-new-secret')).toMatchObject({ ok: true });
      expect(await page.accept(companionKey, 'synthetic-new-site')).toMatchObject({ ok: false });
      return waiting;
    });
    expect((await f.rotate({ keys: [companionKey] })).status).toBe('needs_input');
    expect(f.accepted.map(({ key }) => key)).toEqual([parentKey]);
    expect(f.launchSpy).not.toHaveBeenCalled();
    f.page.mockClear();
    f.failedWrites.delete(companionKey);
    f.page.mockImplementationOnce(async (page) => {
      expect(fieldIds(page)).toEqual([companionKey]);
      expect(f.launchSpy).not.toHaveBeenCalled();
      expect(await page.accept(companionKey, 'synthetic-new-site')).toMatchObject({ ok: true });
      return connected;
    });

    expect(await f.rotate()).toMatchObject({ status: 'rotated', rotated: [parentKey] });
    expect(f.page).toHaveBeenCalledOnce();
    expect(f.accepted.map(({ key }) => key)).toEqual([parentKey, companionKey]);
    expect(f.launchSpy).toHaveBeenCalledOnce();
    expect(f.rotation()).toBeUndefined();
  });

  it('resumes a fully saved group without asking again or rewriting either value', async () => {
    const f = fixture([parentKey, companionKey]);
    f.page.mockImplementationOnce(async (page) => {
      for (const key of [parentKey, companionKey]) expect(await page.accept(key, `synthetic-${key}`)).toMatchObject({ ok: true });
      return waiting;
    });
    expect((await f.rotate({ keys: [parentKey] })).status).toBe('needs_input');
    expect(f.launchSpy).not.toHaveBeenCalled();
    f.page.mockClear();

    expect(await f.rotate()).toMatchObject({ status: 'rotated', rotated: [parentKey] });
    expect(f.page).not.toHaveBeenCalled();
    expect(f.accepted.map(({ key }) => key)).toEqual([parentKey, companionKey]);
    expect(f.write).toHaveBeenCalledTimes(2);
    expect(f.launchSpy).toHaveBeenCalledOnce();
    expect(f.rotation()).toBeUndefined();
  });
});
