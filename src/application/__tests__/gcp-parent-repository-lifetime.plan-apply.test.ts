import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import { resolvePlanActionAuthority } from '../../domain/plan/action-authority.js';
import { writeRepoBindingsForEnvironment, mergeRepoPlatformBindings } from '../../domain/spec/repo-bindings-file.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { GoogleAuth, UserRefreshClient } from 'google-auth-library';
import { retainedDeleteTargetHash } from '../../domain/ports/retained-cleanup.port.js';
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
async function fixture(localDefault = false) {
  if (localDefault) {
    vi.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue(new UserRefreshClient());
    vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('synthetic-transient-token');
  }
  directory = mkdtempSync(path.join(tmpdir(), 'hv-parent-repository-lifetime-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  let ctx = createCommandContext();
  const connection = ctx.repos.connections.create({ provider: 'cloudrun', credentialsEncrypted: getSecretStore().encryptObject({ authMode: 'default', projectId: 'gcp-project' }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  const project = ctx.repos.projects.create({ name: 'parent-repository-retirement', defaultPlatform: 'cloudrun' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { provider: 'cloudrun', projectId: 'gcp-project' } });
  const source = new SpecStore().replace(project, { version: 1, project: project.name,
    environments: { test: { hosting: { provider: 'cloudrun' }, services: {} } } });
  const id = 'projects/gcp-project/locations/us-central1/repositories/owned-test';
  const native = { createTime: '2026-10-27T16:25:34.122685Z' as string | undefined, description: 'hypervibe:operator-registry:' + 'a'.repeat(64) + ':11111111-1111-4111-8111-111111111111', mode: 'STANDARD_REPOSITORY', format: 'DOCKER', deleted: false, reads: 0, beforeRead: (() => {}) as () => void, reply: ((value: unknown) => value) as (value: unknown) => unknown, list: ((_kind: string, _page: string) => Response.json({})) as (kind: string, page: string) => Response };
  vi.stubEnv('HYPERVIBE_ARTIFACT_DELETE_ATTEMPTS', '1');
  const operations: string[] = [];
  const behavior = { deleteCompletes: true, deleteReply: () => Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/delete-owned', done: true, response: {} }), operationReply: () => Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/delete-owned', done: true, response: {} }) };
  const lists: string[] = [];
  const writes: string[] = [];
  let loseDeleteAcknowledgement = false;
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
      writes.push(id);
      if (loseDeleteAcknowledgement) throw new TypeError('Synthetic lost DELETE acknowledgement');
      if (behavior.deleteCompletes) native.deleted = true;
      return behavior.deleteReply();
    }
    if (parsed.pathname.startsWith('/v1/projects/gcp-project/locations/us-central1/operations/') && method === 'GET') {
      operations.push(parsed.pathname); return behavior.operationReply();
    }
    throw Error(`Unexpected synthetic transport ${method}`);
  }));
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async () => {
    const adapter = new CloudRunAdapter();
    if (localDefault) await adapter.connect({ projectId: 'gcp-project', authMode: 'default' });
    else await adapter.connect({ projectId: 'gcp-project', credentials: JSON.stringify({ type: 'service_account', project_id: 'gcp-project',
      private_key: 'synthetic-unused-key', client_email: 'test@gcp-project.iam.gserviceaccount.com' }) });
    if (!localDefault) Object.assign(adapter, { accessToken: 'synthetic-transient-token', tokenExpiry: new Date(Date.now() + 60_000) });
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
    specRevision: source.revision, planId: planned.planRunId, confirmActions: planned.actions.filter(action => action.requiresConfirm).map(action => action.id) });
  const retained = () => ctx.repos.environments.findById(environment.id)!.platformBindings.previousResource;
  const restart = () => {
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(directory!, 'state.db')).migrate();
    ctx = createCommandContext();
  };
  return { ctx, project, source, environment, native, writes, lists, operations, behavior, importTarget, plan, apply, retained, restart,
    loseDeleteAcknowledgement: () => { loseDeleteAcknowledgement = true; } };
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

it('retains an uncertain native DELETE across SQLite restart and only reads it back', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true);
  const planned = await f.plan(); f.loseDeleteAcknowledgement();
  expect(await f.apply(planned)).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(f.writes).toHaveLength(1);
  expect.soft(f.retained()).toMatchObject({ deleteRecovery: { state: 'attempted' } });
  f.restart();
  const recovery = await f.plan();
  expect.soft(recovery.actions).toMatchObject([{ type: 'update', requiresConfirm: false,
    metadata: { operation: 'retainedResourceRecover' } }]);
  expect(await f.apply(recovery)).toMatchObject({ kind: 'executed', result: { success: false } });
  expect.soft(f.writes).toHaveLength(1);
  expect.soft(f.retained()).toMatchObject({ deleteRecovery: { state: 'attempted' } });
  // Native absence is an independent later observation, not inferred from the
  // missing acknowledgment, the operation name, or an archived publication.
  f.native.deleted = true;
  expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.writes).toHaveLength(1);
  expect(f.retained()).toBeUndefined();
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


it.each(['pending', 'denied', 'missing', 'wrong-id', 'malformed', 'failed'])('keeps an acknowledged deletion read-only when operation is %s', async variant => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true);
  f.behavior.deleteCompletes = false;
  expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(f.retained()).toMatchObject({ deleteRecovery: { state: 'acknowledged', operation: 'projects/gcp-project/locations/us-central1/operations/delete-owned' } });
  f.restart();
  f.behavior.operationReply = () => {
    if (variant === 'denied' || variant === 'missing') return Response.json({ message: 'synthetic-credential-echo' }, { status: variant === 'denied' ? 403 : 404 });
    if (variant === 'malformed') return Response.json(null);
    return Response.json({ name: `projects/gcp-project/locations/us-central1/operations/${variant === 'wrong-id' ? 'different' : 'delete-owned'}`,
      done: variant !== 'pending', ...(variant !== 'pending' && variant !== 'failed' ? { response: {} } : {}), ...(variant === 'failed' ? { error: { code: 7, message: 'synthetic-credential-echo' } } : {}) });
  };
  const result = await f.apply(await f.plan());
  expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(JSON.stringify(result)).not.toContain('synthetic-credential-echo');
  expect(f.operations).toHaveLength(2); expect(f.writes).toHaveLength(1); expect(f.retained()).toBeDefined();
});

it('requires current repository absence even after the exact operation completes', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); f.behavior.deleteCompletes = false;
  await f.apply(await f.plan()); f.restart();
  expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(f.writes).toHaveLength(1); expect(f.operations).toHaveLength(2);
  f.native.deleted = true;
  expect(await f.apply(await f.plan())).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.retained()).toBeUndefined(); expect(f.writes).toHaveLength(1);
});

it.each(['different-project', 'traversal', 'malformed'])('preserves attempted state for invalid DELETE response %s without leaking content', async variant => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); f.behavior.deleteCompletes = false;
  f.behavior.deleteReply = () => Response.json(variant === 'malformed' ? { error: 'synthetic-credential-echo' }
    : { name: variant === 'traversal' ? 'projects/gcp-project/locations/us-central1/operations/..' : 'projects/other/locations/us-central1/operations/owned', done: true });
  const result = await f.apply(await f.plan());
  expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(JSON.stringify(result)).not.toContain('synthetic-credential-echo');
  expect(f.retained()).toMatchObject({ deleteRecovery: { state: 'attempted' } });
  f.restart(); await f.apply(await f.plan()); expect(f.writes).toHaveLength(1);
});

it('stops before native DELETE when write-ahead binding CAS loses a concurrent update', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); const planned = await f.plan();
  vi.spyOn(f.ctx.repos.environments, 'compareAndSwapPlatformBindings').mockReturnValue(null);
  expect(await f.apply(planned)).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(f.writes).toEqual([]); expect(f.retained()).not.toHaveProperty('deleteRecovery');
});

it('cannot clear the target when absence readback races unrelated binding changes', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true); f.loseDeleteAcknowledgement();
  await f.apply(await f.plan()); f.native.deleted = true; const planned = await f.plan();
  f.native.beforeRead = () => { f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { unrelatedConcurrent: 'preserve' }); };
  expect(await f.apply(planned)).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.unrelatedConcurrent).toBe('preserve');
  expect(f.retained()).toBeDefined(); expect(f.writes).toHaveLength(1);
});


it('reloads an identical stale repository export without losing local uncertain deletion evidence', async () => {
  const f = await fixture(); expect((await f.importTarget()).ok).toBe(true);
  const original = f.retained(); f.loseDeleteAcknowledgement(); await f.apply(await f.plan());
  const checkpoint = f.retained();
  const repository = path.join(directory!, 'repository'); mkdirSync(path.join(repository, '.hypervibe'), { recursive: true });
  execFileSync('git', ['init', '-q', repository]);
  execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://github.com/example/retained-cleanup.git']);
  writeFileSync(path.join(repository, '.hypervibe/spec.json'), JSON.stringify(f.source.spec));
  writeFileSync(path.join(repository, '.hypervibe/bindings.json'), JSON.stringify({ version: 1, project: f.project.name,
    environments: { test: { platformBindings: { previousResource: original } } } }));
  f.restart(); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  await runWithWorkspaceDirectories([repository], async () => {
    const restarted = createCommandContext();
    expect(restarted.resolveProjectOrThrow({ project: f.project.name }).id).toBe(f.project.id);
    expect(restarted.repos.environments.findById(f.environment.id)!.platformBindings.previousResource).toEqual(checkpoint);
    const result = await f.apply(await f.plan());
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    const projected = writeRepoBindingsForEnvironment(f.project, restarted.repos.environments.findById(f.environment.id)!, repository)!;
    expect(JSON.parse(readFileSync(projected, 'utf8')).environments.test.platformBindings.previousResource).toBeUndefined();
  });
  expect(f.writes).toHaveLength(1); expect(f.retained()).toEqual(checkpoint);
  expect((await f.importTarget()).ok).toBe(false);
  const local = { previousResource: checkpoint };
  expect(mergeRepoPlatformBindings(local, {})).toEqual(local);
  expect(() => mergeRepoPlatformBindings({}, local)).toThrow(/local/i);
  expect(() => mergeRepoPlatformBindings(local, { previousResource: { ...(original as object), externalId: 'replacement' } })).toThrow(/replace/i);
});

it('classifies actual recovery as a read-only update and rejects changed authority envelopes', async () => {
  const f = await fixture(); await f.importTarget(); f.loseDeleteAcknowledgement(); await f.apply(await f.plan());
  const action = (await f.plan()).actions[0];
  expect(resolvePlanActionAuthority(action)?.capability).toBe('provider-resource.retained.recover');
  for (const modified of [ { ...action, type: 'noop' as const }, { ...action, type: 'destroy' as const },
    { ...action, requiresConfirm: true }, { ...action, dataBearing: true },
    { ...action, id: 'different' }, { ...action, metadata: { ...action.metadata, recoveryHash: undefined } } ])
    expect(resolvePlanActionAuthority(modified)).toBeNull();
  expect(f.writes).toHaveLength(1);
});

it('keeps durable parent deletion opt-in and leaves every other registered provider unchanged', () => {
  const retained = providerRegistry.all().filter(provider => provider.retainedCleanup);
  expect(retained.map(provider => [provider.metadata.name, !!provider.retainedCleanup?.durableDelete]).sort()).toEqual([
    ['cloudrun', true], ['cloudsql', false],
  ]);
});


it('does not accept arbitrary terminal operation payload as a deletion receipt', async () => {
  const f = await fixture(); await f.importTarget(); f.behavior.deleteCompletes = false;
  f.behavior.deleteReply = () => Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/delete-owned', done: true,
    response: { name: 'different-resource', credential: 'synthetic-credential-echo' } });
  const result = await f.apply(await f.plan());
  expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(JSON.stringify(result)).not.toContain('synthetic-credential-echo');
  expect(f.retained()).toMatchObject({ deleteRecovery: { state: 'attempted' } });
  expect(f.writes).toHaveLength(1);
});


it('rejects a first acknowledgment without a saved pre-dispatch attempt', async () => {
  const f = await fixture(); await f.importTarget(); const planned = await f.plan();
  vi.spyOn(providerRegistry.get('cloudrun')!.retainedCleanup!.durableDelete!, 'destroy').mockImplementation(async (_adapter, target, lifecycle) => {
    await lifecycle.persist({ version: 1, attemptId: '11111111-1111-4111-8111-111111111111',
      targetHash: retainedDeleteTargetHash({ provider: 'cloudrun', resource: target.resource, externalId: target.id, name: target.name, providerScope: target.providerScope }),
      state: 'acknowledged', operation: 'projects/gcp-project/locations/us-central1/operations/delete-owned' });
    return { success: false, message: 'invalid adapter transition' };
  });
  expect(await f.apply(planned)).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(f.retained()).not.toHaveProperty('deleteRecovery'); expect(f.writes).toEqual([]);
});


it('never persists an exact access-token echo as a native operation identity', async () => {
  const f = await fixture(); await f.importTarget(); f.behavior.deleteCompletes = false;
  f.behavior.deleteReply = () => Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/synthetic-transient-token', done: true, response: {} });
  const result = await f.apply(await f.plan());
  expect(JSON.stringify(result)).not.toContain('synthetic-transient-token');
  expect(JSON.stringify(f.retained())).not.toContain('synthetic-transient-token');
  expect(f.retained()).toMatchObject({ deleteRecovery: { state: 'attempted' } });
  expect(f.writes).toHaveLength(1);
});


it('rejects done=true without a documented Empty response or error', async () => {
  const f = await fixture(); await f.importTarget(); f.behavior.deleteCompletes = false;
  f.behavior.deleteReply = () => Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/delete-owned', done: true });
  await f.apply(await f.plan());
  expect(f.retained()).toMatchObject({ deleteRecovery: { state: 'attempted' } });
  expect(f.writes).toHaveLength(1);
});

it('uses actual local-default authentication without a cached service-account token', async () => {
  const f = await fixture(true); expect((await f.importTarget()).ok).toBe(true);
  f.behavior.deleteCompletes = false;
  f.behavior.deleteReply = () => Response.json({ name: 'projects/gcp-project/locations/us-central1/operations/synthetic-transient-token', done: true, response: {} });
  const result = await f.apply(await f.plan());
  expect(JSON.stringify(result)).not.toContain('synthetic-transient-token');
  expect(JSON.stringify(f.retained())).not.toContain('synthetic-transient-token');
  expect(f.retained()).toMatchObject({ deleteRecovery: { state: 'attempted' } });
  expect(f.writes).toHaveLength(1);
});
