import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../providers.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { executePlanApply } from '../apply-plan.js';
import * as artifacts from '../../domain/services/operator-artifact.service.js';
import * as applications from '../../domain/services/operator-application.service.js';
import { runCli } from '../../interfaces/cli/run.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';

// Independent requirement: repair a selected existing workload's runtime access
// without reauthorizing another cloud or deploying code. The actual command,
// SQLite, plan parser and apply boundary are exercised; provider capability
// responses are synthetic and do not establish native label-repair compatibility.
describe('explicit runtime-access scope', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-runtime-access-scope-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true'); vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'state.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  function fixture(provider = 'cloudrun') {
    const ctx = createCommandContext(), registry = new CommandRegistry(); registerCoreTools(registry, ctx);
    const project = ctx.repos.projects.create({ name: 'runtime-scope-app', defaultPlatform: provider });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider, projectId: 'synthetic-project', environmentId: 'staging', appliedSpecHash: 'accepted-before-repair',
      services: { web: { serviceId: 'native-web' }, worker: { serviceId: 'native-worker' } },
      runtimeIdentities: { worker: { provider, evidence: { identityId: 'retained-worker' },
        pending: { attemptId: 'retained-worker-attempt', step: { operation: 'recover', target: { identityId: 'retained-worker' }, description: 'Retained unrelated recovery', requiresConfirm: false } } } },
    } });
    const store = new SpecStore(); store.replace(project, { version: 1, project: project.name, environments: { staging: {
      hosting: { provider }, services: { web: {}, worker: {} }, envFile: { mode: 'off' },
      operatorArtifacts: { templates: { provider: 's3', artifacts: ['aws-collection-template-v1'],
        nativeScope: { scopeKind: 's3-cloudformation-publication-v1', accountId: '123456789012', region: 'us-west-2' } } },
    } } });
    let repaired = false, observation = 'action'; const writes: string[] = [];
    const inspect = vi.fn(async ({ service }: { service: { name: string } }) => {
      if (service.name !== 'web') throw Error('Unselected runtime observation is forbidden');
      if (repaired || observation === 'ready') return { state: 'ready' as const };
      if (observation === 'unknown' || observation === 'waiting') return { state: observation, reason: 'Synthetic unknown runtime ownership' };
      return { state: 'action' as const, step: { operation: 'attach' as const, target: { nativeId: 'native-web', phase: 'ownership-metadata' }, description: 'Repair exact workload ownership metadata', requiresConfirm: true } };
    });
    const applyIdentity = vi.fn(async () => {
      expect((ctx.repos.environments.findById(environment.id)!.platformBindings.runtimeIdentities as any).web.pending.attemptId).toBeTruthy();
      writes.push('runtime:web'); repaired = true;
      return { receipt: { success: true, message: 'Synthetic exact metadata repair verified' }, binding: { provider, evidence: { nativeId: 'native-web' } } };
    });
    const adapter = { name: provider, configureTarget: vi.fn(), runtimeIdentities: { inspect, apply: applyIdentity } };
    const providers = vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: adapter as never });
    const hosting = vi.spyOn(adapterFactory, 'getHostingAdapter').mockRejectedValue(Error('Deployment is forbidden'));
    const observeEnvironment = vi.spyOn(PlanService.prototype, 'observeEnvironment').mockRejectedValue(Error('Broad environment observation is forbidden'));
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    const artifactPlan = vi.spyOn(artifacts, 'planOperatorArtifacts').mockRejectedValue(Error('AWS preparation is forbidden'));
    const applicationPlan = vi.spyOn(applications, 'planOperatorApplications').mockRejectedValue(Error('Registration is forbidden'));
    const args = { project: project.name, env: environment.name, scope: 'runtime-access', services: ['web'], includeEnvFile: false };
    const plan = (extra = {}) => registry.get('hv_plan')!.execute({ ...args, ...extra });
    const apply = (planId: string, confirmActions: string[] = [], alwaysRunBootstrap = false) => {
      const current = store.get(project)!;
      return executePlanApply(ctx, { project, spec: current.spec, specRevision: current.revision, planId, confirmActions, alwaysRunBootstrap });
    };
    return { ctx, registry, project, environment, store, args, plan, apply, inspect, applyIdentity, providers, hosting,
      observeEnvironment, artifactPlan, applicationPlan, writes, set observation(value: string) { observation = value; } };
  }
  it.each(['command', 'cli', 'mcp'])('reaches the selected saved runtime stage through %s without unrelated preparation', async transport => {
    const f = fixture(); let result: any;
    if (transport === 'cli') {
      let output = '';
      await runCli(['plan', '--input', '-', '--json'], { registry: f.registry, initialize: false, io: {
        readStdin: async () => JSON.stringify(f.args), writeOut: value => { output += value; }, writeErr: () => {}, confirm: async () => false, stdinIsTTY: false,
      } }); result = JSON.parse(output);
    } else if (transport === 'mcp') {
      const server = new McpServer({ name: 'runtime-scope', version: '1' }); registerCoreTools(createMcpCommandRegistrar(server), f.ctx);
      const client = new Client({ name: 'runtime-scope', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      try { result = (await client.callTool({ name: 'hv_plan', arguments: f.args })).structuredContent; }
      finally { await client.close(); await server.close(); }
    } else result = await f.plan();
    expect(result?.ok, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ scope: 'runtime-access', blocked: [], pendingActionCount: 1 });
    expect(result.data.actions.map((a: any) => a.id)).toEqual(['runtime-identity:web']);
    const saved = f.ctx.repos.runs.findById(result.data.planId)!.plan;
    expect(planRunDocumentSchema.parse(saved)).toMatchObject({ scope: 'runtime-access', observedFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), overrides: { services: ['web'] } });
    expect(f.inspect.mock.calls.every(([input]) => input.service.name === 'web')).toBe(true);
    expect(f.artifactPlan).not.toHaveBeenCalled(); expect(f.applicationPlan).not.toHaveBeenCalled(); expect(f.observeEnvironment).not.toHaveBeenCalled(); expect(f.hosting).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]); expect(existsSync(path.join(directory, '.env.staging'))).toBe(false);
  });
  it.each(['cloudrun', 'ecs', 'azure-container-apps'])('applies only confirmed selected runtime access for registered %s capability', async provider => {
    const f = fixture(provider), before = structuredClone(f.environment.platformBindings);
    const planned: any = await f.plan(); expect(planned.ok, JSON.stringify(planned)).toBe(true);
    expect(await f.apply(planned.data.planId)).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([]);
    expect(await f.apply(planned.data.planId, ['runtime-identity:web'])).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual(['runtime:web']);
    const after = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    expect((after.runtimeIdentities as any).worker).toEqual((before.runtimeIdentities as any).worker);
    expect(after.services).toEqual(before.services); expect(after.appliedSpecHash).toBe(before.appliedSpecHash);
    expect(f.hosting).not.toHaveBeenCalled(); expect(f.observeEnvironment).not.toHaveBeenCalled(); expect(f.artifactPlan).not.toHaveBeenCalled();
  });
  it.each([{ services: undefined }, { services: [] }, { services: ['web', 'web'] }, { services: ['missing'] },
    { envVars: {} }, { envFile: '' }, { secretRefs: {} }, { includeEnvFile: true }, { credential: 'database' }, { intent: 'adopt' }])('rejects invalid selection or deployment input %j before observation', async extra => {
    const f = fixture(); const result = await f.plan(extra);
    expect(result.ok).toBe(false); expect(f.inspect).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
  it.each(['unknown', 'waiting'])('does not turn selected %s ownership into an empty successful plan', async observation => {
    const f = fixture(); f.observation = observation;
    const result: any = await f.plan();
    expect(result.ok && result.data.blocked.length === 0 && result.data.actions.length === 0).toBe(false);
    expect(f.writes).toEqual([]);
  });
  it('preserves a selected uncertain attempt without authorizing a fresh attach', async () => {
    const f = fixture();
    const pending = { provider: 'cloudrun', evidence: { nativeId: 'native-web' }, pending: { attemptId: 'old-uncertain-attempt',
      step: { operation: 'attach', target: { nativeId: 'native-web' }, description: 'Original attach', requiresConfirm: true } } };
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { runtimeIdentities: {
      ...(f.environment.platformBindings.runtimeIdentities as any), web: pending,
    } });
    const planned: any = await f.plan();
    expect(planned.ok).toBe(true); expect(planned.data.blocked.length).toBeGreaterThan(0); expect(planned.data.actions).toEqual([]);
    expect(await f.apply(planned.data.planId, ['runtime-identity:web'])).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect((f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.runtimeIdentities as any).web).toEqual(pending);
    expect(f.writes).toEqual([]);
  });
  it('rechecks ready evidence before applying an empty selected plan', async () => {
    const f = fixture(); f.observation = 'ready';
    const planned: any = await f.plan(); expect(planned.ok).toBe(true); expect(planned.data.actions).toEqual([]); expect(planned.data.blocked).toEqual([]);
    f.observation = 'unknown';
    expect(await f.apply(planned.data.planId)).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([]); expect(f.hosting).not.toHaveBeenCalled();
  });
  it.each(['bootstrap', 'binding-uid', 'missing-service', 'changed-spec'])('rejects %s at apply before runtime mutation', async scenario => {
    const f = fixture(); const planned: any = await f.plan(); expect(planned.ok).toBe(true);
    if (scenario === 'binding-uid') f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: {
      ...(f.environment.platformBindings.services as any), web: { serviceId: 'native-web', resourceUid: 'different-native-lifetime' },
    } });
    if (scenario === 'missing-service') f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: {
      worker: (f.environment.platformBindings.services as any).worker,
    } });
    if (scenario === 'changed-spec') {
      const spec = structuredClone(f.store.get(f.project)!.spec); spec.environments.staging.services.web.startCommand = 'changed'; f.store.replace(f.project, spec);
    }
    expect(await f.apply(planned.data.planId, ['runtime-identity:web'], scenario === 'bootstrap')).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([]); expect(f.hosting).not.toHaveBeenCalled();
  });
  it.each(['duplicate-selection', 'empty-selection', 'other-service', 'forged-action-id', 'forged-resource', 'deploy-input', 'source-commit', 'bad-fingerprint', 'deployment-action'])('rejects a forged %s saved envelope', async scenario => {
    const f = fixture(); const planned: any = await f.plan(); expect(planned.ok).toBe(true);
    const saved: any = structuredClone(f.ctx.repos.runs.findById(planned.data.planId)!.plan);
    if (scenario === 'duplicate-selection') saved.overrides.services = ['web', 'web'];
    if (scenario === 'empty-selection') saved.overrides.services = [];
    if (scenario === 'other-service') saved.actions[0].metadata.serviceName = 'worker';
    if (scenario === 'forged-action-id') saved.actions[0].id = 'runtime-identity:worker';
    if (scenario === 'forged-resource') saved.actions[0].resource.name = 'worker';
    if (scenario === 'deploy-input') saved.overrides.envVarsEncrypted = 'synthetic-invalid-input';
    if (scenario === 'source-commit') saved.sourceCommitSha = 'a'.repeat(40);
    if (scenario === 'bad-fingerprint') saved.observedFingerprint = '';
    if (scenario === 'deployment-action') saved.actions[0].metadata.operation = 'serviceConverge';
    expect(planRunDocumentSchema.safeParse(saved).success).toBe(false);
    f.ctx.repos.runs.updatePlan(planned.data.planId, saved);
    expect(await f.apply(planned.data.planId, ['runtime-identity:web'])).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([]); expect(f.hosting).not.toHaveBeenCalled();
  });
  it('respects the existing environment apply lock', async () => {
    const f = fixture(); const planned: any = await f.plan(); expect(planned.ok).toBe(true);
    const spec = f.store.get(f.project)!;
    const competing = f.ctx.repos.runs.create({ projectId: f.project.id, environmentId: f.environment.id, type: 'plan',
      plan: f.ctx.repos.runs.findById(planned.data.planId)!.plan });
    expect(f.ctx.repos.runs.reserveApply({ projectId: f.project.id, environmentId: f.environment.id, planRunId: competing.id,
      environmentName: f.environment.name, specRevision: spec.revision }).reserved).toBe(true);
    expect(await f.apply(planned.data.planId, ['runtime-identity:web'])).not.toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.writes).toEqual([]);
  });
  it.each(['before-native', 'after-native'])('preserves concurrent unrelated binding changes %s', async phase => {
    const f = fixture(); const planned: any = await f.plan(); expect(planned.ok).toBe(true);
    const concurrent = { ...(f.environment.platformBindings.runtimeIdentities as any).worker, evidence: { identityId: 'concurrent-worker-update' } };
    const changeUnrelated = () => {
      const current = f.ctx.repos.environments.findById(f.environment.id)!;
      f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { runtimeIdentities: {
        ...(current.platformBindings.runtimeIdentities as any), worker: concurrent,
      } });
    };
    if (phase === 'before-native') {
      const inspect = f.inspect.getMockImplementation()!;
      f.inspect.mockImplementationOnce(async input => { changeUnrelated(); return inspect(input); });
    } else {
      const apply = f.applyIdentity.getMockImplementation()!;
      f.applyIdentity.mockImplementationOnce(async () => { const result = await apply(); changeUnrelated(); return result; });
    }
    expect(await f.apply(planned.data.planId, ['runtime-identity:web'])).not.toMatchObject({ kind: 'executed', result: { success: true } });
    const identities = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.runtimeIdentities as any;
    expect(identities.worker).toEqual(concurrent);
    expect(f.writes).toEqual(phase === 'before-native' ? [] : ['runtime:web']);
    if (phase === 'after-native') expect(identities.web.pending.attemptId).toBeTruthy();
  });
});
