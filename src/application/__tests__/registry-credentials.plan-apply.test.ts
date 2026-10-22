import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { railwayHttpFixture, projectId, stagingId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { createRailwayDatabaseAdapter } from '../../adapters/providers/railway/railway-database.factory.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService, type PlanOptions } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { createCommandRegistry } from '../commands.js';
import { registerCommandRegistry, type McpToolResponse } from '../../interfaces/mcp/adapter.js';
import { runCli } from '../../interfaces/cli/run.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import '../providers.js';

// User requirement: a credential repair on an existing cron must not require
// unrelated billable backup setup. Synthetic state, real planner and Railway
// serialized transport against the pinned official GraphQL schema. This does
// not establish the cause of the reported production image-pull failure.
describe('registry credential maintenance', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hv-registry-repair-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true });
  });

  async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
    const ctx = createCommandContext();
    const wire = await railwayHttpFixture(options);
    const railwayFetch = globalThis.fetch;
    const registryRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://ghcr.io') return railwayFetch(input, init);
      registryRequests.push(url.toString());
      expect(init?.redirect).toBe('error');
      if (url.pathname === '/token') {
        expect(url.searchParams.get('scope')).toBe('repository:acme/app:pull');
        expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('owner:synthetic-pull-token').toString('base64')}`);
        return Response.json({ token: 'synthetic-short-lived-grant' });
      }
      expect(init?.method).toBe('HEAD');
      expect(url.pathname).toBe(`/v2/acme/app/manifests/sha256:${'a'.repeat(64)}`);
      return new Response(null, { headers: { 'docker-content-digest': `sha256:${'a'.repeat(64)}` } });
    }));
    const cron = wire.addService('cron-staging', 'cron', stagingId);
    cron.instances.get(stagingId)!.source = { image: `ghcr.io/acme/app@sha256:${'a'.repeat(64)}` };
    wire.addService('postgres-staging', 'postgres', stagingId);
    wire.addVolume('postgres-staging', stagingId, '/var/lib/postgresql/data');
    const project = ctx.repos.projects.create({ name: 'registry-repair', defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/acme/app' });
    const spec = new SpecStore().replace(project, { version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
      environments: { staging: { hosting: { provider: 'railway' }, envFile: { mode: 'off' },
        services: { cron: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '*/5 * * * *' } },
        database: { provider: 'railway', engine: 'postgres' }, email: { enabled: false },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } } } });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'railway', projectId, environmentId: stagingId, appliedSpecHash: 'existing-contract',
      services: { cron: { serviceId: 'cron-staging' } },
    } });
    ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'postgres-staging',
      bindings: { provider: 'railway', resourceKind: 'service', serviceId: 'postgres-staging', providerScope: { projectId, environmentId: stagingId } } });
    for (const [provider, credentials] of Object.entries({ railway: { apiToken: 'synthetic-host-token' },
      github: { apiToken: 'synthetic-api-token', login: 'owner', packageReadToken: 'synthetic-pull-token' } })) {
      const connection = ctx.repos.connections.create({ provider, scope: 'acme/app',
        credentialsEncrypted: getSecretStore().encryptObject(credentials) });
      ctx.repos.connections.updateStatus(connection.id, 'verified');
    }
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: wire.adapter });
    vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true,
      adapter: createRailwayDatabaseAdapter({ hostingAdapter: wire.adapter, envRepo: ctx.repos.environments, project }) });
    const plan = (overrides: Partial<PlanOptions> = {}) => new PlanService().plan(project, 'staging', {
      scope: 'registry-credentials', serviceFilter: ['cron'], includeEnvFile: false, ...overrides,
    });
    const apply = (planId: string, confirmActions: string[] = []) => executePlanApply(ctx, {
      project, spec: spec.spec, specRevision: spec.revision, planId, confirmActions,
    });
    return { ctx, wire, cron, project, environment, spec, plan, apply, registryRequests };
  }

  it('plans only the existing cron credential repair while database backups remain unconfigured', async () => {
    const { plan, wire, ctx } = await fixture();
    const result = await plan();
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.scope).toBe('registry-credentials');
    expect(result.actions).toMatchObject([{ type: 'update', resource: { kind: 'service', name: 'cron' },
      metadata: { operation: 'registryCredentialsRepair' } }]);
    expect(result.actions).toHaveLength(1);
    expect(result.blocked).toEqual([]);
    expect(wire.mutations).toEqual([]);
    expect(JSON.stringify(ctx.repos.runs.findById(result.planRunId)!.plan)).not.toContain('synthetic-pull-token');
  });

  it('updates only credentials and keeps runtime verification pending, without repeating the write on retry', async () => {
    const f = await fixture();
    const result = await f.plan();
    if ('error' in result) throw new Error(result.error);
    const before = structuredClone(f.cron.instances.get(stagingId));
    expect(planRunDocumentSchema.safeParse(f.ctx.repos.runs.findById(result.planRunId)!.plan).success).toBe(true);
    expect(await f.apply(result.planRunId)).toMatchObject({ kind: 'executed', result: { success: false,
      receipts: [{ status: 'pending', data: { credentialWrite: 'acknowledged', runtimeVerified: false } }] } });
    expect(f.wire.mutations).toEqual([{ field: 'serviceInstanceUpdate', args: {
      serviceId: 'cron-staging', environmentId: stagingId,
      input: { registryCredentials: { username: 'owner', password: 'synthetic-pull-token' } },
    } }]);
    expect(f.cron.instances.get(stagingId)).toEqual(before);
    expect(f.ctx.repos.environments.findById(f.environment.id)?.platformBindings.appliedSpecHash).toBe('existing-contract');
    await f.apply(result.planRunId);
    expect(f.wire.mutations).toHaveLength(1);
    expect(f.wire.contractErrors).toEqual([]);
    const retry = await f.plan();
    if ('error' in retry) throw new Error(retry.error);
    expect(retry.actions[0].requiresConfirm).toBe(true);
    await f.apply(retry.planRunId);
    expect(f.wire.mutations).toHaveLength(1);
  });

  it.each(['image', 'identity', 'scope'] as const)('rejects %s drift after planning without a write', async change => {
    const f = await fixture();
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    const instance = f.cron.instances.get(stagingId)!;
    if (change === 'image') instance.source.image = `ghcr.io/acme/app@sha256:${'b'.repeat(64)}`;
    if (change === 'identity') instance.id = 'replacement';
    if (change === 'scope') instance.environmentId = 'another-environment';
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.wire.mutations).toEqual([]);
  });

  it('retains uncertain writes and requires a separately confirmed fresh plan before resending', async () => {
    const options = { dropRegistryResponse: false };
    const f = await fixture(options);
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    options.dropRegistryResponse = true;
    const result = await f.apply(plan.planRunId);
    expect(result).toMatchObject({ kind: 'executed', result: { success: false,
      receipts: [{ status: 'pending', data: { credentialWrite: 'uncertain' } }] } });
    expect(JSON.stringify(result)).not.toContain('synthetic-pull-token');
    const attempts = () => f.wire.requests.filter(request => request.query.includes('mutation RepairRegistryCredentials')).length;
    expect(attempts()).toBe(1);
    expect(f.wire.registryCredentials.get(`cron-staging/${stagingId}`)).toEqual({ username: 'owner', password: 'synthetic-pull-token' });
    await f.apply(plan.planRunId);
    expect(attempts()).toBe(1);
    const retry = await f.plan();
    if ('error' in retry) throw new Error(retry.error);
    await f.apply(retry.planRunId);
    expect(attempts()).toBe(1);
    options.dropRegistryResponse = false;
    await f.apply(retry.planRunId, [retry.actions[0].id]);
    expect(attempts()).toBe(2);
  });

  it('leaves the full deployment backup gate intact', async () => {
    const f = await fixture();
    expect(await f.plan({ scope: 'full' })).toHaveProperty('error', expect.stringMatching(/daily backup/i));
    expect(f.wire.mutations).toEqual([]);
  });

  it('retains the pre-write marker if recording acknowledgment fails after the provider accepts credentials', async () => {
    const f = await fixture();
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    const update = f.ctx.repos.environments.updatePlatformBindings.bind(f.ctx.repos.environments);
    vi.spyOn(f.ctx.repos.environments, 'updatePlatformBindings').mockImplementation((...args) => {
      if (JSON.stringify(args[1]).includes('acknowledged')) throw new Error('Synthetic local persistence failure');
      return update(...args);
    });
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { receipts: [{ status: 'pending' }] } });
    await f.apply(plan.planRunId);
    expect(f.wire.mutations).toHaveLength(1);
    expect(f.ctx.repos.environments.findById(f.environment.id)?.platformBindings.registryCredentialRepairs)
      .toMatchObject({ cron: { planId: plan.planRunId, state: 'uncertain' } });
  });

  it('does not leak a credential echoed by the provider', async () => {
    const f = await fixture({ responseOverride: request => request.query.includes('mutation RepairRegistryCredentials')
      ? Response.json({ errors: [{ message: 'Invalid synthetic-pull-token' }] }) : undefined });
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    const result = await f.apply(plan.planRunId);
    expect(result).toMatchObject({ kind: 'executed', result: { receipts: [{ status: 'pending' }] } });
    expect(JSON.stringify(result)).not.toContain('synthetic-pull-token');
    expect(JSON.stringify(f.ctx.repos.runs.findByEnvironmentId(f.environment.id))).not.toContain('synthetic-pull-token');
  });

  it('reports an explicit rejected write as failed and never repeats that plan', async () => {
    const f = await fixture({ responseOverride: request => request.query.includes('mutation RepairRegistryCredentials')
      ? Response.json({ data: { serviceInstanceUpdate: false } }) : undefined });
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: false,
        receipts: [{ status: 'failed', data: { mutationAttempted: true } }] } });
    }
    expect(f.wire.requests.filter(request => request.query.includes('mutation RepairRegistryCredentials'))).toHaveLength(1);
  });

  it('does not use a package-read connection belonging to another repository', async () => {
    const f = await fixture();
    const selected = f.ctx.repos.connections.findAllByProvider('github')[0];
    f.ctx.repos.connections.updateStatus(selected.id, 'failed');
    const unrelated = f.ctx.repos.connections.create({ provider: 'github', scope: 'another/repository',
      credentialsEncrypted: getSecretStore().encryptObject({ login: 'owner', packageReadToken: 'other-repo-token' }) });
    f.ctx.repos.connections.updateStatus(unrelated.id, 'verified');
    expect(await f.plan()).toHaveProperty('error');
    expect(f.registryRequests).toEqual([]);
    expect(f.wire.mutations).toEqual([]);
  });

  it.each([{ serviceFilter: [] }, { serviceFilter: ['cron', 'other'] }, { envVarOverrides: {} },
    { envFile: '' }, { secretRefs: {} }, { includeEnvFile: true }])('rejects incompatible input %j before provider access', async input => {
    const f = await fixture();
    expect(await f.plan(input)).toHaveProperty('error');
    expect(f.wire.requests).toEqual([]);
    expect(f.registryRequests).toEqual([]);
  });

  it('uses frozen credentials, preserving all other services and the second environment', async () => {
    const f = await fixture();
    const before = structuredClone(f.wire.services);
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    const connection = f.ctx.repos.connections.findAllByProvider('github')[0];
    f.ctx.repos.connections.updateCredentials(connection.id, getSecretStore().encryptObject({
      login: 'owner', apiToken: 'changed', packageReadToken: 'changed-after-plan',
    }));
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { receipts: [{ status: 'pending' }] } });
    expect(f.wire.services).toEqual(before);
    expect([...f.wire.registryCredentials.keys()]).toEqual([`cron-staging/${stagingId}`]);
    expect(f.wire.requests.some(request => /DailyBackup|BackupSchedule|mutation .*Deploy/.test(request.query))).toBe(false);
  });

  it.each(['missing', 'duplicate', 'unknown'] as const)('blocks %s identity evidence without creating or adopting a target', async state => {
    const f = await fixture({ responseOverride: request => state === 'unknown' && request.query.includes('RegistryCredentialTarget')
      ? Response.json({ errors: [{ message: 'Provider temporarily unavailable' }] }) : undefined });
    if (state === 'missing') f.wire.services.delete('cron-staging');
    if (state === 'duplicate') f.ctx.repos.environments.updatePlatformBindings(f.environment.id, {
      services: { cron: { serviceId: 'cron-staging' }, alias: { serviceId: 'cron-staging' } },
    });
    expect(await f.plan()).toHaveProperty('error');
    expect(f.wire.mutations).toEqual([]);
  });

  it('rejects broadening the persisted repair into a deploy, noop, or environment input', async () => {
    const f = await fixture();
    const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    const saved = f.ctx.repos.runs.findById(plan.planRunId)!.plan! as Record<string, unknown>;
    for (const patch of [
      { actions: [{ ...plan.actions[0], type: 'noop' }] },
      { actions: [...plan.actions, { id: 'service:cron', type: 'update', verified: true, reason: 'Deploy', resource: plan.actions[0].resource }] },
      { overrides: { ...saved.overrides as object, services: ['cron'] } },
      { scope: 'full' },
    ]) expect(planRunDocumentSchema.safeParse({ ...saved, ...patch }).success).toBe(false);
    expect(await executePlanApply(f.ctx, { project: f.project, spec: f.spec.spec, specRevision: f.spec.revision,
      planId: plan.planRunId, confirmActions: [], alwaysRunBootstrap: true })).toMatchObject({ kind: 'blocked' });
    expect(f.wire.mutations).toEqual([]);
  });

  it('exposes the same narrow plan through MCP and CLI without dotenv preparation', async () => {
    const f = await fixture();
    const registry = createCommandRegistry(f.ctx);
    const callbacks = new Map<string, (input: unknown) => Promise<McpToolResponse>>();
    registerCommandRegistry({
      server: { getClientCapabilities: () => ({ roots: {} }), listRoots: async () => ({ roots: [{ uri: pathToFileURL(dir).href }] }) },
      registerTool: (name: string, _schema: unknown, callback: (input: unknown) => Promise<McpToolResponse>) => callbacks.set(name, callback),
    } as unknown as McpServer, registry);
    const mcp = await callbacks.get('hv_plan')!({ project: f.project.name, env: 'staging', scope: 'registry-credentials', services: ['cron'] });
    let stdout = '';
    const code = await runWithWorkspaceDirectories([dir], () => runCli(['plan', '--project', f.project.name,
      '--env', 'staging', '--scope', 'registry-credentials', '--services', 'cron', '--json'], {
      registry, initialize: false, io: { writeOut: text => { stdout += text; }, writeErr: () => {},
        readStdin: async () => '', confirm: async () => false, stdinIsTTY: false },
    }));
    expect(code, stdout).toBe(0);
    for (const result of [mcp.structuredContent, JSON.parse(stdout)]) {
      expect(result).toMatchObject({ ok: true, data: { scope: 'registry-credentials', pendingActionCount: 1 } });
      expect(result.data).not.toHaveProperty('localEnv');
      expect(JSON.stringify(result)).not.toContain('synthetic-pull-token');
    }
    expect(f.wire.mutations).toEqual([]);
  });
});
