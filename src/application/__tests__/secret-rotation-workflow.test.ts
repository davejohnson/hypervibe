import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { createCommandContext } from '../context.js';
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
  const reads = vi.spyOn(infrastructure, 'secretManagerFetch').mockImplementation(async (_token, url) => {
    const id = /\/secrets\/([^/]+)/.exec(url)?.[1];
    if (!id || !createdAt.has(id)) throw new Error('Unexpected Secret Manager read');
    if (url.endsWith('/versions/latest')) return Response.json({ createTime: createdAt.get(id) });
    if (url.endsWith('/versions?filter=state:ENABLED')) return Response.json({ versions: [
      { name: `projects/rotation-fixture/secrets/${id}/versions/1` },
    ] });
    throw new Error('Unexpected Secret Manager operation');
  });
  const launchSpy = vi.spyOn(launch, 'launchEnvironment').mockResolvedValue({ status: 'ready', phase: 'infrastructure', infrastructureRounds: 1 });
  const page = vi.spyOn(pastePage, 'serveMultiPastePage').mockResolvedValue({ status: 'waiting', provider: 'secret', scope: 'staging', message: 'Waiting for private input' });
  const rotate = (params: Omit<Parameters<typeof rotateSecrets>[1], 'project' | 'environmentName'> = {}) => rotateSecrets(ctx, { project, environmentName: 'staging', ...params });
  const rotation = () => (ctx.repos.environments.findById(environment.id)!.platformBindings as { engine: infrastructure.EngineBinding }).engine.rotation;
  return { rotate, rotation, page, write, reads, accepted, failedWrites, launchSpy };
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
    expect(f.reads.mock.calls.some(([, url]) => url.includes('?filter=state:ENABLED'))).toBe(false);
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
