import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import { createCommandContext } from '../context.js';
import { importProvider } from '../import-provider.js';
import { executePlanApply } from '../apply-plan.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';

// User requires original creation/lifetime
// ownership before parent cleanup. Artifact Registry names are reusable, while
// repositories expose createTime; name equality must not select a replacement.
// https://docs.cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories
// Actual import/SQLite/saved plan/apply + adapter transport, synthetic responses.
let directory: string | undefined;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-parent-repository-lifetime-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  const ctx = createCommandContext();
  const connection = ctx.repos.connections.create({ provider: 'cloudrun', credentialsEncrypted: getSecretStore().encryptObject({ authMode: 'default', projectId: 'gcp-project' }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  const project = ctx.repos.projects.create({ name: 'parent-repository-retirement', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' } });
  const source = new SpecStore().replace(project, { version: 1, project: project.name,
    environments: { test: { hosting: { provider: 'cloudrun' }, services: {} } } });
  const id = 'projects/gcp-project/locations/us-central1/repositories/owned-test';
  const native = { createTime: '2026-10-27T16:25:34.122685Z' as string | undefined, description: 'hypervibe:operator-registry:' + 'a'.repeat(64) + ':11111111-1111-4111-8111-111111111111', mode: 'STANDARD_REPOSITORY', format: 'DOCKER', deleted: false, reads: 0, beforeRead: (() => {}) as () => void, reply: ((value: unknown) => value) as (value: unknown) => unknown, list: ((_kind: string, _page: string) => Response.json({})) as (kind: string, page: string) => Response };
  const lists: string[] = [];
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    if (url === `https://artifactregistry.googleapis.com/v1/${id}` && method === 'GET') {
      native.reads++; native.beforeRead();
      return native.deleted ? Response.json({}, { status: 404 }) : Response.json(native.reply({ name: id, format: native.format, mode: native.mode, createTime: native.createTime, description: native.description }));
    }
    const parsed = new URL(url);
    for (const kind of ['packages', 'files', 'attachments']) {
      if (parsed.pathname === `/v1/${id}/${kind}` && method === 'GET') { lists.push(kind); return native.list(kind, parsed.searchParams.get('pageToken') ?? ''); }
    }
    if (url === `https://artifactregistry.googleapis.com/v1/${id}` && method === 'DELETE') {
      writes.push(id); native.deleted = true;
      return Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/delete-owned', done: true });
    }
    throw Error(`Unexpected synthetic transport ${method}`);
  }));
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async () => {
    const adapter = new CloudRunAdapter();
    await adapter.connect({ projectId: 'gcp-project', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project',
      private_key: 'synthetic-unused-key', client_email: 'test@gcp-project.iam.gserviceaccount.com' }) });
    Object.assign(adapter, { accessToken: 'synthetic-transient-token', tokenExpiry: new Date(Date.now() + 60_000) });
    return { success: true, adapter };
  });
  const importTarget = () => importProvider(ctx, { provider: 'cloudrun', mode: 'retained-resource-cleanup', project: project.name,
    env: 'test', resource: 'artifact', id, region: 'us-central1', confirm: true });
  const plan = async () => {
    const result = await new PlanService().plan(project, 'test', { scope: 'retained-cleanup' });
    if ('error' in result) throw Error(result.error);
    return result;
  };
  const apply = async (planned: Awaited<ReturnType<typeof plan>>) => executePlanApply(ctx, { project, spec: source.spec,
    specRevision: source.revision, planId: planned.planRunId, confirmActions: planned.actions.map(action => action.id) });
  const retained = () => ctx.repos.environments.findById(environment.id)!.platformBindings.previousResource;
  return { ctx, environment, native, writes, lists, importTarget, plan, apply, retained };
}

it.each(['createTime', 'description'] as const)('blocks changed native %s after exact inspected cleanup was saved', async field => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true);
  const planned = await f.plan(); expect(planned.actions).toHaveLength(1); expect(f.writes).toEqual([]);
  f.native[field] = field === 'createTime' ? '2026-11-04T00:00:00Z' : 'hypervibe:operator-registry:' + 'b'.repeat(64) + ':11111111-1111-4111-8111-111111111111';
  const applied = await f.apply(planned);
  expect.soft(f.writes).toEqual([]);
  expect.soft(applied).toMatchObject({ kind: 'executed', result: { success: false } });
  expect.soft(f.retained()).toBeDefined();
});

it('blocks replacement during planning without changing the retained original lifetime', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true);
  const original = f.retained(); f.native.createTime = '2026-11-04T00:00:00Z';
  const planned = await f.plan();
  expect.soft(planned.actions[0].verified).toBe(false); expect(f.writes).toEqual([]); expect(f.retained()).toEqual(original);
});

it.each([4, 5])('rechecks the lifetime inside deletion before write (native read %i)', async read => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); const planned = await f.plan();
  f.native.beforeRead = () => { if (f.native.reads === read) f.native.createTime = '2026-11-04T00:00:00Z'; };
  const applied = await f.apply(planned);
  expect.soft(f.writes).toEqual([]); expect.soft(applied).toMatchObject({ kind: 'executed', result: { success: false } });
  expect.soft(f.retained()).toBeDefined();
});

it('does not retain an incomplete native lifetime for cleanup', async () => {
  const f = await fixture(); f.native.createTime = undefined;
  expect.soft((await f.importTarget()).ok).toBe(false); expect.soft(f.retained()).toBeUndefined(); expect(f.writes).toEqual([]);
});

it.each(['packages', 'files', 'attachments'])('blocks undeclared %s rather than cascading parent deletion', async kind => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); const planned = await f.plan();
  f.native.list = current => Response.json(current === kind ? { [kind]: [{ name: 'unrelated' }] } : {});
  const applied = await f.apply(planned);
  expect.soft(f.writes).toEqual([]); expect.soft(applied).toMatchObject({ kind: 'executed', result: { success: false } });
  expect.soft(f.retained()).toBeDefined();
});

it.each(['later-child', 'denied', 'malformed', 'repeated-token', 'error-envelope', 'wrong-collection'])('blocks incomplete or nonempty inventory: %s', async variant => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); const planned = await f.plan();
  f.native.list = (kind, page) => {
    if (kind !== 'packages') return Response.json({});
    if (variant === 'denied') return Response.json({ message: 'synthetic provider echo' }, { status: 403 });
    if (variant === 'malformed') return Response.json({ packages: null });
    if (variant === 'error-envelope') return Response.json({ error: { code: 403, message: 'synthetic denied envelope' } });
    if (variant === 'wrong-collection') return Response.json({ files: [{ name: 'unrelated' }] });
    if (variant === 'later-child') return Response.json(page ? { packages: [{ name: 'unrelated' }] } : { nextPageToken: 'second' });
    return Response.json({ nextPageToken: 'same' });
  };
  const applied = await f.apply(planned);
  expect.soft(f.writes).toEqual([]); expect.soft(applied).toMatchObject({ kind: 'executed', result: { success: false } });
  expect.soft(f.retained()).toBeDefined();
});

it('deletes only the unchanged empty repository and confirms absence', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); const planned = await f.plan();
  f.native.list = (kind, page) => Response.json(kind === 'packages' && !page ? { nextPageToken: 'second' } : {});
  expect(await f.apply(planned)).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.writes).toHaveLength(1); expect(f.lists).toEqual(['packages', 'packages', 'files', 'attachments']); expect(f.retained()).toBeUndefined();
});

it.each(['description', 'mode', 'format'] as const)('keeps %s outside the supported cleanup contract read-only', async field => {
  const f = await fixture(); f.native[field] = field === 'description' ? 'unowned repository' : 'UNKNOWN';
  expect((await f.importTarget()).ok).toBe(false); expect(f.retained()).toBeUndefined(); expect(f.writes).toEqual([]);
});
it('preserves a legacy binding without silently adopting the observed current lifetime', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true);
  const retained = f.retained() as Record<string, unknown>;
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { previousResource: { ...retained,
    providerScope: { projectId: 'gcp-project', location: 'us-central1' } } });
  const original = f.retained(); const planned = await f.plan();
  expect(planned.actions[0].verified).toBe(false); expect(f.retained()).toEqual(original); expect(f.writes).toEqual([]);
});

it('does not mistake HTTP200 null for confirmed absence or clear the original binding', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); const planned = await f.plan();
  const original = f.retained(); f.native.reply = () => null;
  const applied = await f.apply(planned);
  expect.soft(applied).toMatchObject({ kind: 'executed', result: { success: false } });
  expect.soft(f.retained()).toEqual(original); expect(f.writes).toEqual([]);
});
it('rejects a different exact repository name in the final native response', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); const planned = await f.plan();
  f.native.reply = value => f.native.reads === 5 ? { ...(value as Record<string, unknown>), name: 'projects/gcp-project/locations/us-central1/repositories/different' } : value;
  const applied = await f.apply(planned);
  expect.soft(f.writes).toEqual([]); expect.soft(applied).toMatchObject({ kind: 'executed', result: { success: false } });
  expect.soft(f.retained()).toBeDefined();
});
