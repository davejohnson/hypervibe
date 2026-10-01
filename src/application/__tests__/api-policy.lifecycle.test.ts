import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import '../providers.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import type { Project } from '../../domain/entities/project.entity.js';

// User policy evidence: retained API versions must not disappear with a spec edit,
// and retirement must require exact action confirmation before any provider work.
describe('API policy through ordinary plan and apply', () => {
  let directory: string; let ctx: CommandContext; let project: Project;
  const desired = () => ({ version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
    runtime: { kind: 'node', version: '24' }, environments: { production: {
      hosting: { provider: 'railway' }, services: { api: {} }, deploy: { strategy: 'branch', trigger: 'ci', autoDeploy: false },
      api: { service: 'api', versions: { v1: { path: '/v1', contract: 'api/v1.json' } }, compatibility: { command: 'npm test' } },
    } } });
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-api-policy-'));
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext(); project = ctx.repos.projects.create({ name: 'api-policy', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/acme/api-policy.git' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider request is authorized in policy acceptance'));
  });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  const plan = async () => {
    const value = await new PlanService().plan(project, 'production');
    if ('error' in value) throw new Error(value.error);
    return value;
  };
  const apply = async (planId: string, confirmActions: string[] = []) => {
    const stored = new SpecStore().get(project)!;
    return executePlanApply(ctx, { project, spec: stored.spec, specRevision: stored.revision, planId, confirmActions });
  };
  it('records new policy without provider access and blocks its later omission', async () => {
    const store = new SpecStore(); store.replace(project, desired());
    const first = await plan(); expect(first.scope).toBe('api-policy');
    expect(first.actions).toHaveLength(1);
    expect(await apply(first.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(fetch).not.toHaveBeenCalled();
    const env = ctx.repos.environments.findByProjectAndName(project.id, 'production')!;
    expect(env.platformBindings.apiPolicy).toMatchObject({ versions: { v1: { status: 'supported' } } });
    store.merge(project, { environments: { production: { api: null } } });
    expect(await new PlanService().plan(project, 'production')).toMatchObject({ error: expect.stringMatching(/Retain the API policy/) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a policy plan from another project even when desired hashes and revisions match', async () => {
    const store = new SpecStore(); store.replace(project, desired());
    const first = await plan();
    const other = ctx.repos.projects.create({ name: 'other-app', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/acme/other-app.git' });
    const otherSpec = store.replace(other, { ...desired(), project: other.name, gitRemoteUrl: other.gitRemoteUrl });
    const otherEnv = ctx.repos.environments.create({ projectId: other.id, name: 'production' });
    const outcome = await executePlanApply(ctx, { project: other, spec: otherSpec.spec, specRevision: otherSpec.revision, planId: first.planRunId, confirmActions: [first.actions[0].id] });
    expect(outcome).toMatchObject({ kind: 'blocked' });
    expect(ctx.repos.environments.findById(otherEnv.id)!.platformBindings).not.toHaveProperty('apiPolicy');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('confirmation cannot cross environments or be stripped from retirement authority', async () => {
    const store = new SpecStore(); store.replace(project, desired());
    await apply((await plan()).planRunId);
    store.merge(project, { environments: { production: { api: { versions: { v1: { status: 'retired', retirement: { id: 'r1', reason: 'Replacement available' } } } } } } });
    const retirement = await plan();
    expect(retirement.actions[0].requiresConfirm).toBe(true);
    expect(await apply(retirement.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(ctx.repos.environments.findByProjectAndName(project.id, 'production')!.platformBindings.apiPolicy).toMatchObject({ versions: { v1: { status: 'supported' } } });
    const fresh = await plan();
    expect(await apply(fresh.planRunId, [fresh.actions[0].id])).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
