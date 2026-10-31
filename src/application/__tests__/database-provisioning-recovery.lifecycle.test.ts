import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../providers.js';
import { getDb, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { AdapterFactory } from '../../domain/services/adapter.factory.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { CloudSqlAdapter } from '../../adapters/providers/gcp/cloudsql.adapter.js';
import { executePlanApply } from '../apply-plan.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { projectRecoveryDatabases } from '../../domain/services/recovery-database-bindings.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-provisioning-recovery-'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

// Actual shared planner/SQLite and Cloud SQL adapter. Native shapes are
// reconstructed from the 2026-10-31 observation and Google's v1 instance/user/
// operation contracts. This is not native cloud recovery evidence.
async function fixture(state = 'RUNNABLE', options: { existing?: boolean; lostPasswordAck?: boolean; operationPending?: boolean;
  omittedUserType?: boolean; lostDatabaseAck?: boolean; denied?: boolean; operationTarget?: string } = {}) {
  const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'provisioning-recovery', defaultPlatform: 'cloudrun' });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { test: {
    hosting: { provider: 'cloudrun', region: 'us-central1' }, services: {}, database: { provider: 'cloudsql' },
    backups: { mode: 'disabled', reason: 'Synthetic provisioning recovery fixture' }, email: { enabled: false }, envVars: {},
  } } });
  new SpecStore().replace(project, spec);
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: {} });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'reviewed-postgres', bindings: {
    provider: 'cloudsql', instanceId: 'reviewed-postgres', providerScope: { projectId: 'reviewed-project', region: 'us-central1' },
    provisioningIncomplete: true, cleanupRequired: true,
  } });
  const adapter = new CloudSqlAdapter();
  await adapter.connect({ projectId: 'reviewed-project', region: 'us-central1', credentials: JSON.stringify({
    type: 'service_account', project_id: 'reviewed-project', private_key: 'synthetic', client_email: 'operator@reviewed-project.iam.gserviceaccount.com',
  }) });
  Object.assign(adapter, { accessToken: 'synthetic-access-token', tokenExpiry: new Date(Date.now() + 3_600_000) });
  const requests: { url: string; method: string }[] = [];
  let databasePresent = options.existing ?? false;
  let credentialSet = false;
  let nativeCreateTime = '2026-10-31T21:20:10.027Z';
  const operation = (name: string, operationType: string) => ({ name, operationType, targetProject: 'reviewed-project', targetId: options.operationTarget ?? 'reviewed-postgres', status: options.operationPending ? 'RUNNING' : 'DONE' });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'; requests.push({ url, method });
    if (method === 'PUT' && url.endsWith('/users?name=postgres')) {
      credentialSet = true;
      if (options.lostPasswordAck) throw new Error('Synthetic lost acknowledgment');
      return Response.json(operation('password-operation', 'UPDATE_USER'));
    }
    if (method === 'POST' && url.endsWith('/databases')) { databasePresent = true;
      if (options.lostDatabaseAck) throw new Error('Synthetic lost database acknowledgment');
      return Response.json(operation('database-operation', 'CREATE_DATABASE')); }
    if (method !== 'GET') throw new Error('Unexpected provider mutation');
    if (url.endsWith('/operations/password-operation')) return Response.json(operation('password-operation', 'UPDATE_USER'));
    if (url.endsWith('/operations/database-operation')) return Response.json(operation('database-operation', 'CREATE_DATABASE'));
    if (url.endsWith('/operations/original-create')) return Response.json(operation('original-create', 'CREATE'));
    if (url.endsWith('/instances/reviewed-postgres')) return options.denied ? new Response('', { status: 403 })
      : Response.json({ name: 'reviewed-postgres', project: 'reviewed-project', region: 'us-central1', databaseVersion: 'POSTGRES_15', state,
        createTime: nativeCreateTime, connectionName: 'reviewed-project:us-central1:reviewed-postgres', settings: { tier: 'db-f1-micro' } });
    if (url.endsWith('/instances/reviewed-postgres/users')) return Response.json({ kind: 'sql#usersList', items: [{ name: 'postgres', instance: 'reviewed-postgres', project: 'reviewed-project', ...(options.omittedUserType ? {} : { type: 'BUILT_IN' }) }] });
    if (url.endsWith('/instances/reviewed-postgres/databases/app')) return databasePresent
      ? Response.json({ name: 'app', instance: 'reviewed-postgres', project: 'reviewed-project' }) : new Response('', { status: 404 });
    throw new Error(`Unexpected read ${url}`);
  }));
  vi.spyOn(AdapterFactory.prototype, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter });
  vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
  const plan = async () => {
    const result = await new PlanService().plan(project, 'test', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);return result;
  };
  // Native control-plane transport is real; PostgreSQL authentication is a
  // separate substituted boundary here, covered by database-credential tests.
  vi.spyOn(adapter.credentialLifecycle, 'probe').mockImplementation(async () => ({ state: credentialSet ? 'authenticated' : 'rejected', tested: 'Synthetic SQL password proof' }));
  const apply = async (planId: string, confirms: string[]) => executePlanApply(ctx, { project, spec, specRevision: 1, planId, confirmActions: confirms });
  return { ctx, project, spec, environment, component, requests, plan, apply, adapter,
    replaceNative: () => { nativeCreateTime = '2026-11-01T00:00:00.000Z'; } };
}

describe('retained database provisioning recovery', () => {
  it('offers a separately confirmed credential repair on the same instance rather than deletion or another create', async () => {
    const f = await fixture(), plan = await f.plan();
    expect(plan.scope).toBe('database-provisioning-recovery');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: 'update', resource: { kind: 'database', provider: 'cloudsql' },
      requiresConfirm: true, dataBearing: true, verified: true });
    expect(plan.actions[0].reason).toMatch(/password/i);
    expect(plan.actions[0].metadata).toMatchObject({ target: { externalId: 'reviewed-postgres', providerScope: { projectId: 'reviewed-project', region: 'us-central1' } } });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    expect(f.ctx.repos.components.findById(f.component.id)?.bindings).toEqual(f.component.bindings);
  });

  it('keeps a native pending instance blocked without creating another resource or preparing a reset', async () => {
    const f = await fixture('PENDING_CREATE'), plan = await f.plan();
    expect(plan.scope).toBe('database-provisioning-recovery');
    expect(plan.actions).toEqual([]);
    expect(plan.blocked?.some(b => /pending|running|creation/i.test(b.reason))).toBe(true);
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('requires exact confirmation, then completes the retained instance and stores its private credential encrypted', async () => {
    const f = await fixture(), plan = await f.plan();
    expect(plan.actions).toHaveLength(1);
    await f.apply(plan.planRunId, []);
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    const result = await f.apply(plan.planRunId, [plan.actions[0].id]);
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    const saved = f.ctx.repos.components.findById(f.component.id)!;
    expect(saved.externalId).toBe('reviewed-postgres');
    expect(saved.bindings.provisioningIncomplete).toBeUndefined();
    expect(saved.bindings.password).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain(saved.bindings.password as string);
    const raw = getDb().prepare('SELECT bindings FROM components WHERE id = ?').get(saved.id) as { bindings: string };
    expect(raw.bindings).not.toContain(saved.bindings.password as string);
    expect(JSON.parse(raw.bindings)).toHaveProperty('__encrypted');
    const planRow = getDb().prepare('SELECT plan FROM runs WHERE id = ?').get(plan.planRunId) as { plan: string };
    expect(planRow.plan).not.toContain(saved.bindings.password as string);
    expect(f.requests.filter(r => r.method !== 'GET').map(r => r.method)).toEqual(['PUT', 'POST']);
  });

  it('preserves an existing logical database without posting it again', async () => {
    const f = await fixture('RUNNABLE', { existing: true }), plan = await f.plan();
    expect(plan.actions).toHaveLength(1);
    const result = await f.apply(plan.planRunId, [plan.actions[0].id]);
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.requests.filter(r => r.method !== 'GET').map(r => r.method)).toEqual(['PUT']);
  });

  it('retains a lost acknowledgment and recovers through password proof without repeating the reset', async () => {
    const f = await fixture('RUNNABLE', { lostPasswordAck: true }), first = await f.plan();
    expect(first.actions).toHaveLength(1);
    await f.apply(first.planRunId, [first.actions[0].id]);
    const restarted = await f.plan();
    expect(restarted.actions).toHaveLength(1);
    const result = await f.apply(restarted.planRunId, [restarted.actions[0].id]);
    expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
  });

  it('keeps the acknowledged password operation pending across restart with no second write', async () => {
    const f = await fixture('RUNNABLE', { operationPending: true }), first = await f.plan();
    expect(first.actions).toHaveLength(1);
    const result = await f.apply(first.planRunId, [first.actions[0].id]);
    expect(result).toMatchObject({ kind: 'executed', result: { success: false, receipts: [{ status: 'pending' }] } });
    const restarted = await f.plan();
    await f.apply(restarted.planRunId, [restarted.actions[0].id]);
    expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });

  it('normalizes the documented omitted built-in user type', async () => {
    const f = await fixture('RUNNABLE', { omittedUserType: true }), plan = await f.plan();
    expect(plan.actions).toHaveLength(1);
    expect(plan.blocked).toEqual([]);
  });

  it.each([{}, { projectId: 'reviewed-project' }, { projectId: 'reviewed-project', region: 'us-central1' }])(
    'rejects another environment bound to the same or ambiguously scoped instance: %j', async providerScope => {
      const f = await fixture();
      const other = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'another-environment', platformBindings: {} });
      f.ctx.repos.components.create({ environmentId: other.id, type: 'postgres', externalId: f.component.externalId,
        bindings: { provider: 'cloudsql', providerScope } });
      const plan = await f.plan();
      expect(plan.actions).toEqual([]);
      expect(plan.blocked?.length).toBeGreaterThan(0);
      expect(f.requests.every(r => r.method === 'GET')).toBe(true);
    });

  it('blocks changed native lifetime before a write', async () => {
    const f = await fixture(), plan = await f.plan(); f.replaceNative();
    const result = await f.apply(plan.planRunId, [plan.actions[0].id]);
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('keeps an acknowledged original create pending even if the instance is already RUNNABLE', async () => {
    const f = await fixture('RUNNABLE', { operationPending: true });
    f.ctx.repos.components.updateBindings(f.component.id, { provisioningRecovery: { schemaVersion: 1,
      phase: 'instance-operation', operationId: 'original-create', targetProject: 'reviewed-project', targetId: 'reviewed-postgres',
      region: 'us-central1', databaseVersion: 'POSTGRES_15', instanceCreateTime: '2026-10-31T21:20:10.027Z' } });
    const plan = await f.plan();
    expect(plan.actions).toEqual([]);
    expect(plan.blocked?.some(b => /running/i.test(b.reason))).toBe(true);
  });

  it('blocks a changed private credential even when the public identity fingerprint is unchanged', async () => {
    const f = await fixture(), plan = await f.plan();
    f.ctx.repos.components.updateBindings(f.component.id, { password: 'synthetic-concurrent-credential' });
    const result = await f.apply(plan.planRunId, [plan.actions[0].id]);
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('preserves unknown permission evidence without preparing a password reset', async () => {
    const f = await fixture('RUNNABLE', { denied: true }), plan = await f.plan();
    expect(plan.actions).toEqual([]);
    expect(plan.blocked?.length).toBeGreaterThan(0);
  });

  it('never resubmits a logical database create after a lost acknowledgment', async () => {
    const f = await fixture('RUNNABLE', { lostDatabaseAck: true }), first = await f.plan();
    await f.apply(first.planRunId, [first.actions[0].id]);
    const next = await f.plan();
    const result = await f.apply(next.planRunId, [next.actions[0].id]);
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(1);
  });

  it('rejects an operation for another instance and stops dependent creation', async () => {
    const f = await fixture('RUNNABLE', { operationTarget: 'different-instance' }), first = await f.plan();
    const result = await f.apply(first.planRunId, [first.actions[0].id]);
    expect(result).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(0);
  });

  it('keeps recovery values and journals out of portable bindings and rejects broadened saved actions', async () => {
    const f = await fixture(), plan = await f.plan();
    const document = f.ctx.repos.runs.findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    expect(planRunDocumentSchema.safeParse({ ...document, scope: 'full' }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [{ ...plan.actions[0], type: 'noop' }] }).success).toBe(false);
    await f.apply(plan.planRunId, [plan.actions[0].id]);
    const saved = f.ctx.repos.components.findById(f.component.id)!;
    const exported = projectRecoveryDatabases([saved], f.environment.id);
    expect(exported).toEqual([{ componentId: saved.id, provider: 'cloudsql', externalId: saved.externalId, engine: 'postgres' }]);
    expect(JSON.stringify(exported)).not.toContain(saved.bindings.password as string);
    expect(JSON.stringify(exported)).not.toContain('provisioningCompletion');
  });
});
