import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../application/devops-providers.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { createToolContext } from '../../../application/context.js';
import { PlanService } from '../../plan/plan.service.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import { mergeRepoPlatformBindings, writeRepoBindingsForEnvironment } from '../../spec/repo-bindings-file.js';
import { resolvePlanActionAuthority } from '../../plan/action-authority.js';
import { createCommandRegistry } from '../../../application/commands.js';
import { devOpsProviderRegistry } from '../../registry/devops.registry.js';

// Synthetic transport fixtures reconstructed from the official repository
// Actions-variable REST contract, not from adapter return types. No live writes.
const scope = 'owner/example';
const timestamp = '2026-10-28T12:00:00Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Variable = { name: string; value: string; created_at: string; updated_at: string };
const variable = (name: string, value: string): Variable => ({ name, value, created_at: timestamp, updated_at: timestamp });

describe('repository variables through persisted spec, plan and apply', () => {
  let directory: string;
  let variables: Variable[];
  let writes: Array<{ method: string; pathname: string; body: Record<string, string> }>;
  let repositoryId: number;
  let inventoryUnavailable: boolean;
  let loseWriteResponse: boolean;
  let hideReadbackAfterWrite: boolean;
  let mutationStatus: number | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-repository-vars-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(directory, 'state.db'));
    const connectionRepo = new ConnectionRepository();
    const connection = connectionRepo.create({ provider: 'github', scope,
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-test-token' }) });
    connectionRepo.updateStatus(connection.id, 'verified');
    variables = [variable('UNRELATED', 'ordinary-unrelated-value')];
    writes = [];
    repositoryId = 321;
    inventoryUnavailable = false;
    loseWriteResponse = false;
    hideReadbackAfterWrite = false;
    mutationStatus = undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.pathname === `/repos/${scope}`) {
        return Response.json({ id: repositoryId, full_name: scope, name: 'example', private: true,
          default_branch: 'main', html_url: `https://github.com/${scope}`,
          clone_url: `https://github.com/${scope}.git`, ssh_url: `git@github.com:${scope}.git` });
      }
      if (method === 'GET' && url.pathname === `/repos/${scope}/actions/variables`) {
        if (inventoryUnavailable) return Response.json({ message: 'private diagnostic value' }, { status: 403 });
        const page = Number(url.searchParams.get('page') ?? 1);
        const size = Number(url.searchParams.get('per_page') ?? 10);
        return Response.json({ total_count: variables.length, variables: variables.slice((page - 1) * size, page * size) });
      }
      if ((method === 'POST' || method === 'PATCH') && url.pathname.startsWith(`/repos/${scope}/actions/variables`)) {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        writes.push({ method, pathname: url.pathname, body });
        if (mutationStatus !== undefined) return Response.json({ message: 'private diagnostic value' }, { status: mutationStatus });
        const name = method === 'POST' ? body.name : decodeURIComponent(url.pathname.split('/').at(-1)!);
        variables = [...variables.filter(item => item.name !== name), variable(name, body.value)];
        if (hideReadbackAfterWrite) inventoryUnavailable = true;
        if (loseWriteResponse) throw new Error('synthetic lost acknowledgement with private diagnostic value');
        return new Response(null, { status: method === 'POST' ? 201 : 204 });
      }
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function setup(value = 'true', adoptExisting = false) {
    const project = new ProjectRepository().create({ name: 'review-policy', defaultPlatform: 'unconfigured',
      gitRemoteUrl: `https://github.com/${scope}.git` });
    const spec = projectSpecSchema.parse({ version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
      devops: { code: { provider: 'github', scope }, ci: { provider: 'github-actions',
        repositoryVariables: { PROJECT_HEALTH_ENABLED: { value, adoptExisting } } }, canonicalEnvironment: 'repository' }, environments: {} });
    return { project, stored: new SpecStore().replace(project, spec) };
  }

  async function planAndApply(fixture: ReturnType<typeof setup>) {
    const plan = await new PlanService().plan(fixture.project, 'repository');
    expect(plan).not.toHaveProperty('error');
    if ('error' in plan) throw new Error(plan.error);
    const result = await executePlanApply(createToolContext(), { project: fixture.project, spec: fixture.stored.spec,
      specRevision: fixture.stored.revision, planId: plan.planRunId, confirmActions: [] });
    return { plan, result };
  }

  function replaceVariables(fixture: ReturnType<typeof setup>, entries: Record<string, { value: string; adoptExisting?: boolean }> | undefined) {
    const ci = { ...fixture.stored.spec.devops!.ci! };
    if (entries === undefined) delete ci.repositoryVariables;
    else ci.repositoryVariables = entries as typeof ci.repositoryVariables;
    fixture.stored = new SpecStore().replace(fixture.project, projectSpecSchema.parse({ ...fixture.stored.spec,
      devops: { ...fixture.stored.spec.devops, ci } }));
  }

  async function applyPlan(fixture: ReturnType<typeof setup>, plan: Awaited<ReturnType<PlanService['plan']>>) {
    if ('error' in plan) throw new Error(plan.error);
    return executePlanApply(createToolContext(), { project: fixture.project, spec: fixture.stored.spec,
      specRevision: fixture.stored.revision, planId: plan.planRunId, confirmActions: [] });
  }

  it('creates only the declared variable, verifies readback and repeats with zero writes', async () => {
    const fixture = setup();
    const first = await planAndApply(fixture);
    expect(first.plan.actions).toHaveLength(1);
    expect(first.plan.actions[0]).toMatchObject({ type: 'create', resource: { kind: 'ci', provider: 'github-actions' },
      metadata: { repositoryId: '321', variableName: 'PROJECT_HEALTH_ENABLED', desiredHash: hash('true') } });
    expect(first.result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toEqual([{ method: 'POST', pathname: `/repos/${scope}/actions/variables`,
      body: { name: 'PROJECT_HEALTH_ENABLED', value: 'true' } }]);
    expect(variables).toContainEqual(variable('UNRELATED', 'ordinary-unrelated-value'));
    const second = await planAndApply(fixture);
    expect(second.plan.actions.every(action => action.type === 'noop')).toBe(true);
    expect(second.result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toHaveLength(1);
    const bindings = new EnvironmentRepository().findByProjectAndName(fixture.project.id, 'repository')!.platformBindings;
    expect(JSON.stringify({ first, second, bindings })).not.toContain('ordinary-unrelated-value');
    expect(JSON.stringify({ first, second, bindings })).not.toContain('synthetic-test-token');
  });

  it('requires explicit adoption of existing values and adopts with zero provider writes', async () => {
    variables.push(variable('PROJECT_HEALTH_ENABLED', 'true'));
    const fixture = setup();
    const blocked = await new PlanService().plan(fixture.project, 'repository');
    expect(blocked).toMatchObject({ error: expect.stringMatching(/adopt/i) });
    expect(writes).toEqual([]);
    fixture.stored = new SpecStore().replace(fixture.project, projectSpecSchema.parse({ ...fixture.stored.spec,
      devops: { ...fixture.stored.spec.devops, ci: { ...fixture.stored.spec.devops!.ci,
        repositoryVariables: { PROJECT_HEALTH_ENABLED: { value: 'true', adoptExisting: true } } } } }));
    const adopted = await planAndApply(fixture);
    expect(adopted.result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toEqual([]);
  });

  it('adopts a different existing value, then reviews exactly one update on the next plan', async () => {
    variables.push(variable('PROJECT_HEALTH_ENABLED', 'false'));
    const fixture = setup('true', true);
    expect((await planAndApply(fixture)).result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toEqual([]);
    expect(variables).toContainEqual(variable('PROJECT_HEALTH_ENABLED', 'false'));
    const next = await planAndApply(fixture);
    expect(next.plan.actions[0]).toMatchObject({ type: 'update', metadata: { mode: 'update' } });
    expect(next.result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toEqual([{ method: 'PATCH', pathname: `/repos/${scope}/actions/variables/PROJECT_HEALTH_ENABLED`, body: { name: 'PROJECT_HEALTH_ENABLED', value: 'true' } }]);
  });

  it.each(['identity', 'value', 'timestamp', 'denied'] as const)('blocks stale %s observations before any write', async kind => {
    variables.push(variable('PROJECT_HEALTH_ENABLED', 'false'));
    const fixture = setup('true', true);
    await planAndApply(fixture);
    const plan = await new PlanService().plan(fixture.project, 'repository');
    if (kind === 'identity') repositoryId = 987;
    if (kind === 'value') variables = variables.map(item => item.name === 'PROJECT_HEALTH_ENABLED' ? variable(item.name, 'another-value') : item);
    if (kind === 'timestamp') variables = variables.map(item => ({ ...item, updated_at: '2026-10-28T13:00:00Z' }));
    if (kind === 'denied') inventoryUnavailable = true;
    expect(await applyPlan(fixture, plan)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(writes).toEqual([]);
  });

  it('does not mistake a denied inventory for an absent variable or expose raw errors', async () => {
    const fixture = setup();
    inventoryUnavailable = true;
    const result = await new PlanService().plan(fixture.project, 'repository');
    expect(result).toHaveProperty('error');
    expect(JSON.stringify(result)).not.toContain('private diagnostic value');
    expect(writes).toEqual([]);
  });

  it('reconciles a lost creation acknowledgement without a second write', async () => {
    const fixture = setup();
    loseWriteResponse = true;
    const result = await planAndApply(fixture);
    expect(result.result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private diagnostic value');
  });

  it.each(['changed', 'omitted'] as const)('retains uncertainty after desired state is %s and recovers only by readback', async change => {
    const fixture = setup();
    loseWriteResponse = true;
    hideReadbackAfterWrite = true;
    const failed = await planAndApply(fixture);
    expect(failed.result).toMatchObject({ kind: 'executed', result: { success: false, receipts: [{ status: 'pending' }] } });
    const environment = new EnvironmentRepository().findByProjectAndName(fixture.project.id, 'repository')!;
    const retained = environment.platformBindings.repositoryVariableOwnership;
    expect(retained).toMatchObject({ pending: { desiredHash: hash('true') } });
    replaceVariables(fixture, change === 'changed' ? { PROJECT_HEALTH_ENABLED: { value: 'false' } } : undefined);
    inventoryUnavailable = false;
    hideReadbackAfterWrite = false;
    const recovery = await planAndApply(fixture);
    expect(recovery.plan.actions[0]).toMatchObject({ metadata: { mode: 'reconcile', desiredHash: hash('true') } });
    expect(recovery.result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toHaveLength(1);
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.repositoryVariableOwnership).toMatchObject({ pending: null });
    execFileSync('git', ['init', '-q', directory]);
    execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', `https://github.com/${scope}.git`]);
    fs.mkdirSync(path.join(directory, '.hypervibe'));
    fs.writeFileSync(path.join(directory, '.hypervibe', 'spec.json'), JSON.stringify(fixture.stored.spec));
    const disabled = process.env.HYPERVIBE_DISABLE_REPO_SPEC;
    try {
      process.env.HYPERVIBE_DISABLE_REPO_SPEC = '0';
      const exportedPath = writeRepoBindingsForEnvironment(fixture.project, { ...environment,
        platformBindings: { repositoryVariableOwnership: retained, unrelated: { id: 'other' } } }, directory);
      expect(exportedPath).not.toBeNull();
      const exported = JSON.parse(fs.readFileSync(exportedPath!, 'utf8'));
      expect(exported.environments.repository.platformBindings).toEqual({ unrelated: { id: 'other' } });
    } finally { process.env.HYPERVIBE_DISABLE_REPO_SPEC = disabled; }
    expect(mergeRepoPlatformBindings({ repositoryVariableOwnership: retained }, {})).toEqual({ repositoryVariableOwnership: retained });
    expect(() => mergeRepoPlatformBindings({}, { repositoryVariableOwnership: retained })).toThrow(/local only/i);
  });

  it('preserves owned and unrelated variables when declarations are omitted', async () => {
    const fixture = setup();
    await planAndApply(fixture);
    const before = new EnvironmentRepository().findByProjectAndName(fixture.project.id, 'repository')!.platformBindings;
    replaceVariables(fixture, undefined);
    const omitted = await planAndApply(fixture);
    expect(omitted.result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(omitted.plan.actions).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(variables).toEqual([variable('UNRELATED', 'ordinary-unrelated-value'), variable('PROJECT_HEALTH_ENABLED', 'true')]);
    expect(new EnvironmentRepository().findByProjectAndName(fixture.project.id, 'repository')!.platformBindings).toEqual(before);
  });

  it('rejects case-colliding declarations and an unsupported registered provider explicitly', async () => {
    const fixture = setup();
    replaceVariables(fixture, { FLAG: { value: 'one' }, flag: { value: 'two' } });
    expect(await new PlanService().plan(fixture.project, 'repository')).toMatchObject({ error: expect.stringMatching(/ambiguous/i) });
    fixture.stored = new SpecStore().replace(fixture.project, projectSpecSchema.parse({ ...fixture.stored.spec,
      gitRemoteUrl: 'https://gitlab.com/owner/example.git', devops: { ...fixture.stored.spec.devops,
        code: { provider: 'gitlab', scope: 'owner/example' }, ci: { provider: 'gitlab-ci', repositoryVariables: { FLAG: { value: 'one' } } } } }));
    expect(await new PlanService().plan(fixture.project, 'repository')).toMatchObject({ error: expect.stringMatching(/does not support repository configuration/i) });
    expect(writes).toEqual([]);
  });

  it('does not broaden deployment-secret authority or accept an altered action identity', async () => {
    const fixture = setup();
    const plan = await new PlanService().plan(fixture.project, 'repository');
    if ('error' in plan) throw new Error(plan.error);
    const action = plan.actions[0];
    expect(resolvePlanActionAuthority(action)?.capability).toBe('ci.repository-variable.sync');
    expect(resolvePlanActionAuthority({ ...action, resource: { ...action.resource, kind: 'secret' } })).toBeNull();
    expect(resolvePlanActionAuthority({ ...action, id: 'different-id' })).toBeNull();
    expect(resolvePlanActionAuthority({ ...action, metadata: { ...action.metadata, variableName: 'OTHER' } })).toBeNull();
  });

  it('concurrent applications of the same reviewed create cannot issue a second mutation', async () => {
    const fixture = setup();
    const plan = await new PlanService().plan(fixture.project, 'repository');
    await Promise.all([applyPlan(fixture, plan), applyPlan(fixture, plan)]);
    expect(writes).toHaveLength(1);
  });

  it('keeps every registered CI provider in the reviewed repository-configuration capability matrix', () => {
    expect(devOpsProviderRegistry.ciProviderIds().sort()).toEqual(['github-actions', 'gitlab-ci']);
    expect(typeof devOpsProviderRegistry.ciProvider('github-actions')!.repositoryConfiguration).toBe('function');
    expect(devOpsProviderRegistry.ciProvider('gitlab-ci')!.repositoryConfiguration).toBeUndefined();
  });

  it('does not write when the pending journal cannot be persisted', async () => {
    const fixture = setup();
    const plan = await new PlanService().plan(fixture.project, 'repository');
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockReturnValue(null);
    expect(await applyPlan(fixture, plan)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(writes).toEqual([]);
  });

  it('retains an acknowledged write when local acceptance fails, then verifies it without repeating the write', async () => {
    const fixture = setup();
    const real = EnvironmentRepository.prototype.updatePlatformBindings;
    let updates = 0;
    const persist = vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementation(function (this: EnvironmentRepository, ...args) {
      if (++updates === 2) return null;
      return real.apply(this, args);
    });
    const first = await planAndApply(fixture);
    expect(first.result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(writes).toHaveLength(1);
    expect(new EnvironmentRepository().findByProjectAndName(fixture.project.id, 'repository')!.platformBindings.repositoryVariableOwnership)
      .toMatchObject({ pending: { variableName: 'PROJECT_HEALTH_ENABLED' } });
    persist.mockRestore();
    expect((await planAndApply(fixture)).result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toHaveLength(1);
  });

  it('a definite permission rejection preserves prior ownership and permits a newly reviewed retry', async () => {
    const fixture = setup();
    mutationStatus = 403;
    const rejected = await planAndApply(fixture);
    expect(rejected.result).toMatchObject({ kind: 'executed', result: { success: false } });
    const environment = new EnvironmentRepository().findByProjectAndName(fixture.project.id, 'repository')!;
    expect(environment.platformBindings.repositoryVariableOwnership).toMatchObject({ variables: {}, pending: null });
    expect(JSON.stringify(rejected)).not.toContain('private diagnostic value');
    expect(variables).toEqual([variable('UNRELATED', 'ordinary-unrelated-value')]);
    mutationStatus = undefined;
    const retry = await planAndApply(fixture);
    expect(retry.plan.actions[0]).toMatchObject({ metadata: { mode: 'create' } });
    expect(retry.result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(writes).toHaveLength(2);
  });

  it('an ambiguous server failure stays pending and cannot blindly repeat a write', async () => {
    const fixture = setup();
    mutationStatus = 500;
    const failed = await planAndApply(fixture);
    expect(failed.result).toMatchObject({ kind: 'executed', result: { success: false, receipts: [{ status: 'pending' }] } });
    mutationStatus = undefined;
    const retry = await planAndApply(fixture);
    expect(retry.plan.actions[0]).toMatchObject({ metadata: { mode: 'reconcile' } });
    expect(retry.result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(writes).toHaveLength(1);
  });

  it('preserves malformed retained ownership and refuses to silently reset it', async () => {
    const fixture = setup();
    const repo = new EnvironmentRepository();
    const environment = repo.create({ projectId: fixture.project.id, name: 'repository',
      platformBindings: { repositoryVariableOwnership: { version: 1, pending: 'malformed' } } });
    expect(await new PlanService().plan(fixture.project, 'repository')).toMatchObject({ error: expect.stringMatching(/malformed/i) });
    expect(repo.findById(environment.id)!.platformBindings).toEqual(environment.platformBindings);
    expect(writes).toEqual([]);
  });

  it('blocks new ownership before its retained capacity would overflow', async () => {
    const fixture = setup();
    await planAndApply(fixture);
    const repo = new EnvironmentRepository();
    const environment = repo.findByProjectAndName(fixture.project.id, 'repository')!;
    const state = environment.platformBindings.repositoryVariableOwnership as Record<string, unknown>;
    const retained = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`OLD_${index}`, {
      name: `OLD_${index}`, valueHash: hash('old'), createdAt: timestamp, updatedAt: timestamp,
    }]));
    repo.updatePlatformBindings(environment.id, { repositoryVariableOwnership: { ...state, variables: retained } });
    variables = [variable('UNRELATED', 'ordinary-unrelated-value')];
    expect(await new PlanService().plan(fixture.project, 'repository')).toMatchObject({ error: expect.stringMatching(/ownership capacity/i) });
    expect(writes).toHaveLength(1);
    expect(repo.findById(environment.id)!.platformBindings.repositoryVariableOwnership).toMatchObject({ variables: retained });
  });

  it('redacts repository-variable values in the shared CLI/MCP spec response', async () => {
    const fixture = setup('ordinary-private-flag-value');
    const commands = createCommandRegistry(createToolContext());
    const readSpec = await commands.execute('hv_spec', { project: fixture.project.name });
    expect(readSpec.ok).toBe(true);
    expect(readSpec).toMatchObject({ data: { connections: { required: [expect.objectContaining({ provider: 'github' })] } } });
    expect(JSON.stringify(readSpec)).not.toContain('ordinary-private-flag-value');
  });

  it('exposes independent value-free inspection through the shared CLI/MCP command registry', async () => {
    const fixture = setup();
    const commands = createCommandRegistry(createToolContext());
    const inspected = await commands.execute('hv_inspect', { provider: 'github', project: fixture.project.name,
      resource: 'repository-variable', name: 'UNRELATED' });
    expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
    expect(inspected).toMatchObject({ ok: true, data: { observation: 'present', resource: 'repository-variable',
      variables: [{ name: 'UNRELATED', valueHash: hash('ordinary-unrelated-value') }] } });
    expect(JSON.stringify(inspected)).not.toContain('ordinary-unrelated-value');
    expect(writes).toEqual([]);
  });

  it('distinguishes a verified absent variable from unknown inspection without writes', async () => {
    const fixture = setup();
    const commands = createCommandRegistry(createToolContext());
    const input = { provider: 'github', project: fixture.project.name, resource: 'repository-variable', name: 'MISSING' };
    expect(await commands.execute('hv_inspect', input)).toMatchObject({ ok: true, data: { observation: 'absent', variables: [] } });
    inventoryUnavailable = true;
    const denied = await commands.execute('hv_inspect', input);
    expect(denied).toMatchObject({ ok: true, data: { observation: 'unknown' } });
    expect(JSON.stringify(denied)).not.toContain('private diagnostic value');
    expect(writes).toEqual([]);
  });
});
