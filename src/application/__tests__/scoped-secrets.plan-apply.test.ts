import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { railwayHttpFixture, projectId, stagingId, productionId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService, type PlanOptions } from '../../domain/plan/plan.service.js';
import { planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { parseDelegatedSecretBindings } from '../../domain/services/delegated-secret.service.js';
import { parseRuntimeRolloutBindings } from '../../domain/services/runtime-rollout.service.js';
import { syncHostingEnvVars } from '../../domain/services/hosting-env.service.js';
import { createCommandContext, type CommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { createCommandRegistry } from '../commands.js';
import { registerCommandRegistry, type McpToolResponse } from '../../interfaces/mcp/adapter.js';
import { runCli } from '../../interfaces/cli/run.js';
import { runWithWorkspaceDirectories } from '../../lib/workspace-context.js';
import '../providers.js';

// Real planner/apply and Railway GraphQL serialization. Synthetic provider
// state executes against the pinned official schema. Additive variables and
// deferred rollout follow Railway's documented rotate-secrets contract:
// https://docs.railway.com/integrations/api/manage-variables#rotate-secrets
// This is offline contract evidence, not a recorded live deployment.
const value = 'synthetic-explicit-staging-input';
const key = 'OPENAI_API_KEY';
describe('explicit secret-only plans', () => {
  let dir: string;
  let ctx: CommandContext;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'hv-scoped-secrets-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate();
    ctx = createCommandContext();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    SqliteAdapter.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}, managedEmail = false) {
    const wire = await railwayHttpFixture(options);
    for (const name of ['web', 'worker']) {
      wire.addService(`staging-${name}`, name, stagingId);
      wire.variables.set(`staging-${name}/${stagingId}`, { OPENAI_API_KEY: 'synthetic-old-value', KEEP_ME: 'unchanged' });
    }
    wire.variables.set(`production-web/${productionId}`, { OPENAI_API_KEY: 'synthetic-production-value' });
    wire.addService('staging-postgres', 'postgres-db', stagingId);
    wire.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const project = ctx.repos.projects.create({ name: 'scoped-secrets', defaultPlatform: 'railway',
      gitRemoteUrl: 'https://github.com/acme/scoped-secrets' });
    const spec = new SpecStore().replace(project, {
      version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl,
      secrets: {
        [key]: { ownership: 'delegated', principal: 'github:owner', environments: ['staging', 'production'], required: true, driftPolicy: 'preserve' },
        OTHER_REQUIRED_KEY: { ownership: 'delegated', principal: 'github:other', environments: ['staging'], required: true },
        GENERATED_KEY: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: ['staging'] },
        PRODUCTION_ONLY: { ownership: 'delegated', principal: 'github:owner', environments: ['production'] },
        ...(managedEmail ? {
          SENDGRID_API_KEY: { ownership: 'delegated', principal: 'github:owner', environments: ['staging', 'production'] },
        } : {}),
      },
      environments: {
        staging: { hosting: { provider: 'railway' }, envFile: { mode: 'off' },
          ...(managedEmail ? { email: { enabled: true } } : {}),
          services: { web: { workloadKind: 'web' }, worker: { workloadKind: 'worker' } },
          database: { provider: 'railway', engine: 'postgres' },
          deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } },
        production: { hosting: { provider: 'cloudrun' }, services: { web: {}, worker: { workloadKind: 'worker' } } },
      },
    });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'railway', projectId, environmentId: stagingId, appliedSpecHash: 'unchanged-accepted-contract',
      services: { web: { serviceId: 'staging-web' }, worker: { serviceId: 'staging-worker' } },
      databaseTopology: { primary: { provider: 'railway', externalId: 'staging-postgres' }, replicas: {} },
    } });
    ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'staging-postgres',
      bindings: { provider: 'railway', resourceKind: 'service', serviceId: 'staging-postgres',
        providerScope: { projectId, environmentId: stagingId } } });
    const production = ctx.repos.environments.create({ projectId: project.id, name: 'production',
      platformBindings: { provider: 'cloudrun', projectId: 'production-cloud-project', services: { web: { serviceId: 'production-web' } } } });
    for (const name of ['web', 'worker']) ctx.repos.services.create({ projectId: project.id, name, buildConfig: {}, envVarSpec: {} });
    const connection = ctx.repos.connections.create({ provider: 'railway',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-contract-token' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockImplementation(async provider => {
      if (provider !== 'railway') throw new Error('Unexpected provider lookup');
      return { success: true, adapter: wire.adapter };
    });
    const file = path.join(dir, '.env');
    writeFileSync(file, `${key}=${value}\nUNRELATED_LOCAL_SETTING=never-upload\n`, { mode: 0o600 });
    const input: PlanOptions = { scope: 'secrets' as PlanOptions['scope'], includeEnvFile: false,
      secretRefs: { [key]: `dotenv:${file}#${key}` } };
    const plan = async (overrides: Partial<PlanOptions> = {}) => {
      const result = await new PlanService().plan(project, 'staging', { ...input, ...overrides });
      if ('error' in result) throw new Error(result.error);
      return result;
    };
    const apply = (planId: string) => executePlanApply(ctx, { project, spec: spec.spec, specRevision: spec.revision, planId, confirmActions: [] });
    return { wire, project, environment, production, spec, file, input, plan, apply };
  }

  it('installs a separate sending key while keeping email setup credentials out of runtime', async () => {
    // Twilio recommends a restricted mail.send-only application credential:
    // https://www.twilio.com/docs/sendgrid/for-developers/sending-email/quickstart-nodejs#create-and-store-a-sendgrid-api-key
    // Email setup remains managed; this boundary uses real Railway serialization.
    const f = await fixture({}, true);
    const sendingKey = 'synthetic-mail-send-only-key';
    const setupKey = 'synthetic-domain-management-key';
    const connection = ctx.repos.connections.create({ provider: 'sendgrid',
      credentialsEncrypted: getSecretStore().encryptObject({ apiKey: setupKey }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
    f.wire.variables.set(`production-web/${productionId}`, { SENDGRID_API_KEY: 'separate-production-mail-key' });
    writeFileSync(f.file, `SENDGRID_API_KEY=${sendingKey}\nHYPERVIBE_SENDGRID_API_KEY=${setupKey}\n`, { mode: 0o600 });
    const overrides = { secretRefs: { SENDGRID_API_KEY: `dotenv:${f.file}#SENDGRID_API_KEY` } };
    const plan = await f.plan(overrides);
    expect(plan.actions).toMatchObject([{ id: 'secret:SENDGRID_API_KEY', type: 'update' }]);
    const storedPlan = ctx.repos.runs.findById(plan.planRunId)!.plan;
    expect(JSON.stringify(storedPlan)).not.toContain(sendingKey);
    expect(JSON.stringify(storedPlan)).not.toContain(setupKey);
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: true,
      receipts: [{ data: { appliedCount: 2, skippedCount: 0, failedCount: 0, deploymentDeferred: true } }] } });
    expect(f.wire.mutations).toHaveLength(2);
    for (const mutation of f.wire.mutations) {
      expect(mutation).toMatchObject({ field: 'variableCollectionUpsert', args: { input: {
        environmentId: stagingId, skipDeploys: true, replace: false,
        variables: { SENDGRID_API_KEY: sendingKey },
      } } });
      expect(JSON.stringify(mutation)).not.toContain(setupKey);
    }
    expect(f.wire.variables.get(`production-web/${productionId}`)).toEqual({ SENDGRID_API_KEY: 'separate-production-mail-key' });
    const second = await f.plan(overrides);
    expect(second.actions).toMatchObject([{ type: 'noop' }]);
    expect(await f.apply(second.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.wire.mutations).toHaveLength(2);
    expect(f.wire.contractErrors).toEqual([]);
  });

  it('updates only the selected staging secret despite pending backup setup, then replans to a mutation-free noop', async () => {
    const f = await fixture();
    const plan = await f.plan();
    expect(plan).toMatchObject({ scope: 'secrets', blocked: [], inputRequired: [] });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ id: `secret:${key}`, type: 'update',
      metadata: { services: ['web', 'worker'], inputProvided: true } });
    const saved = ctx.repos.runs.findById(plan.planRunId)!.plan as Record<string, unknown>;
    expect(planRunDocumentSchema.safeParse(saved).success).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(value);
    writeFileSync(f.file, `${key}=synthetic-changed-after-plan\n`, { mode: 0o600 });
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.wire.mutations).toHaveLength(2);
    for (const mutation of f.wire.mutations) {
      expect(mutation).toMatchObject({ field: 'variableCollectionUpsert', args: { input: {
        projectId, environmentId: stagingId, skipDeploys: true, replace: false, variables: { [key]: value },
      } } });
    }
    for (const name of ['web', 'worker']) expect(f.wire.variables.get(`staging-${name}/${stagingId}`)).toEqual({ [key]: value, KEEP_ME: 'unchanged' });
    expect(f.wire.variables.get(`production-web/${productionId}`)).toEqual({ [key]: 'synthetic-production-value' });
    expect(ctx.repos.environments.findById(f.production.id)).toEqual(f.production);
    expect(ctx.repos.environments.findById(f.environment.id)?.platformBindings.appliedSpecHash).toBe('unchanged-accepted-contract');
    expect(f.wire.requests.some(r => /DailyBackup|BackupSchedule|mutation .*Redeploy|mutation .*DeployService/.test(r.query))).toBe(false);
    writeFileSync(f.file, `${key}=${value}\n`, { mode: 0o600 });
    const second = await f.plan();
    expect(second.actions).toMatchObject([{ type: 'noop' }]);
    expect(await f.apply(second.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.wire.mutations).toHaveLength(2);
    expect(f.wire.contractErrors).toEqual([]);
  });

  it.each(['NOT_DECLARED', 'GENERATED_KEY', 'PRODUCTION_ONLY'])('rejects an unauthorized input %s before provider access', async suppliedKey => {
    const f = await fixture();
    const before = f.wire.requests.length;
    const result = await new PlanService().plan(f.project, 'staging', { ...f.input, secretRefs: { [suppliedKey]: `dotenv:${f.file}#${key}` } });
    expect(result).toHaveProperty('error');
    expect(f.wire.requests).toHaveLength(before);
    expect(f.wire.mutations).toEqual([]);
  });

  it.each([
    { serviceFilter: [] }, { envVarOverrides: {} }, { envFile: '' }, { includeEnvFile: true }, { secretRefs: {} },
  ])('rejects incompatible input %j without saving a plan', async incompatible => {
    const f = await fixture();
    const result = await new PlanService().plan(f.project, 'staging', { ...f.input, ...incompatible });
    expect(result).toHaveProperty('error');
    expect(f.wire.requests).toEqual([]);
  });

  it('keeps full release workflow planning separate from secret-only updates without requiring backups', async () => {
    const f = await fixture();
    const plan = await f.plan({ scope: 'full' });
    expect(plan.scope).toBe('managed-ci-publication');
    expect(plan.actions.some(action => action.resource.kind === 'secret')).toBe(false);
    expect(plan.actions.some(action => action.metadata?.operation === 'dailyBackupConfigure')).toBe(false);
    expect(f.wire.mutations).toEqual([]);
    const selected = await f.plan();
    const forced = await executePlanApply(ctx, { project: f.project, spec: f.spec.spec, specRevision: f.spec.revision,
      planId: selected.planRunId, confirmActions: [], alwaysRunBootstrap: true });
    expect(forced.kind).toBe('blocked');
    expect(f.wire.mutations).toEqual([]);
  });

  it.each(['removed', 'changed'] as const)('rejects selected-key drift after planning: %s', async change => {
    const f = await fixture();
    const plan = await f.plan();
    const vars = f.wire.variables.get(`staging-web/${stagingId}`)!;
    if (change === 'removed') delete vars[key];
    else vars[key] = 'synthetic-concurrent-rotation';
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.wire.mutations).toEqual([]);
  });

  it('preserves unrelated drift while revalidating delegated ownership', async () => {
    const f = await fixture();
    const plan = await f.plan();
    f.wire.variables.get(`staging-web/${stagingId}`)!.KEEP_ME = 'changed-elsewhere';
    const secret = f.spec.spec.secrets[key];
    if (secret.ownership !== 'delegated') throw new Error('Expected delegated fixture');
    secret.principal = 'github:different-owner';
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.wire.mutations).toEqual([]);
    secret.principal = 'github:owner';
    const retry = await f.plan();
    expect(await f.apply(retry.planRunId)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(f.wire.variables.get(`staging-web/${stagingId}`)!.KEEP_ME).toBe('changed-elsewhere');
  });

  it('stops after an uncertain write and retries only the still-missing destination', async () => {
    const options = { dropVariableResponse: true };
    const f = await fixture(options);
    const plan = await f.plan();
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: false,
      receipts: [{ status: 'failed', data: { appliedCount: 0, failedCount: 1, skippedCount: 1, bindingRecorded: false } }] } });
    expect(f.wire.mutations).toHaveLength(1);
    expect(f.wire.variables.get(`staging-web/${stagingId}`)![key]).toBe(value);
    expect(parseDelegatedSecretBindings(ctx.repos.environments.findById(f.environment.id)!)).toEqual([]);
    options.dropVariableResponse = false;
    const retry = await f.plan();
    expect(await f.apply(retry.planRunId)).toMatchObject({ kind: 'executed', result: { success: true,
      receipts: [{ data: { appliedCount: 1, skippedCount: 1, bindingRecorded: true, deploymentDeferred: true } }] } });
    expect(f.wire.mutations).toHaveLength(2);
    expect(f.wire.mutations[1].args.input.serviceId).toBe('staging-worker');
    expect(parseRuntimeRolloutBindings(ctx.repos.environments.findById(f.environment.id)!).map(item => item.service)).toEqual(['web', 'worker']);
    expect(f.wire.contractErrors).toEqual([]);
  });

  it('recovers acceptance after a local persistence failure without rewriting matching provider values', async () => {
    const f = await fixture();
    const plan = await f.plan();
    const repository = ctx.repos.environments;
    const prototype = Object.getPrototypeOf(repository) as typeof repository;
    const original = prototype.updatePlatformBindings;
    let fail = true;
    vi.spyOn(prototype, 'updatePlatformBindings').mockImplementation(function (this: typeof repository, id, patch) {
      if (fail && patch.delegatedEnvBindings) throw new Error('synthetic persistence failure');
      return original.call(this, id, patch);
    });
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(f.wire.mutations).toHaveLength(2);
    fail = false;
    const retry = await f.plan();
    expect(await f.apply(retry.planRunId)).toMatchObject({ kind: 'executed', result: { success: true,
      receipts: [{ data: { appliedCount: 0, bindingRecorded: true } }] } });
    expect(f.wire.mutations).toHaveLength(2);
  });

  it('requires secret deferral even when the broader deployment capability is absent', async () => {
    const f = await fixture();
    f.wire.adapter.capabilities.supportsDeferredDeploy = false;
    const service = ctx.repos.services.findByProjectAndName(f.project.id, 'web')!;
    expect(await syncHostingEnvVars({ project: f.project, environment: f.environment, service, vars: { [key]: value },
      deferDeployment: true, requireDeferredSecretUpdate: true })).toMatchObject({ success: true });
    expect(f.wire.mutations).toHaveLength(1);
    expect(f.wire.mutations[0].args.input.skipDeploys).toBe(true);
  });

  it('rechecks provider capability and refuses the ordinary writer as a fallback', async () => {
    const f = await fixture();
    const plan = await f.plan();
    f.wire.adapter.capabilities.supportsDeferredSecretUpdates = false;
    expect(await new PlanService().plan(f.project, 'staging', f.input)).toHaveProperty('error');
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'blocked' });
    const service = ctx.repos.services.findByProjectAndName(f.project.id, 'web')!;
    expect(await syncHostingEnvVars({ project: f.project, environment: f.environment, service, vars: { [key]: value },
      deferDeployment: true, requireDeferredSecretUpdate: true })).toMatchObject({ success: false });
    expect(f.wire.mutations).toEqual([]);
  });

  it('requires exact native bindings and deferral again at the provider write boundary', async () => {
    const f = await fixture();
    const service = ctx.repos.services.findByProjectAndName(f.project.id, 'web')!;
    expect(await f.wire.adapter.setEnvVars(f.environment, service, { [key]: value }, { requireDeferredSecretUpdate: true }))
      .toMatchObject({ success: false });
    const missing = { ...f.environment, platformBindings: { ...f.environment.platformBindings, services: {} } };
    expect(await f.wire.adapter.setEnvVars(missing, service, { [key]: value }, { requireDeferredSecretUpdate: true, deferDeployment: true }))
      .toMatchObject({ success: false });
    expect(f.wire.requests).toEqual([]);
    expect(f.wire.mutations).toEqual([]);
  });

  it.each(['missing', 'masked', 'permission'] as const)('blocks unknown variable observations: %s', async shape => {
    const f = await fixture({ responseOverride: request => {
      if (!request.query.includes('query GetVariables')) return;
      if (shape === 'permission') return Response.json({ errors: [{ message: 'Forbidden' }] }, { status: 403 });
      return Response.json({ data: shape === 'missing' ? {} : { variables: { [key]: null } } });
    } });
    expect(await new PlanService().plan(f.project, 'staging', f.input)).toHaveProperty('error');
    expect(f.wire.mutations).toEqual([]);
  });

  it.each([false, true])('re-observes deferred values before acceptance (eventually visible: %s)', async delayed => {
    let readsAfterWrite = 0;
    let mutated = false;
    const f = await fixture({ responseOverride: request => {
      if (request.query.includes('mutation UpsertVariables')) mutated = true;
      if (!mutated || !request.query.includes('query GetVariables')) return;
      if (delayed && ++readsAfterWrite > 2) return;
      return Response.json({ data: { variables: { [key]: 'synthetic-old-value', KEEP_ME: 'unchanged' } } });
    } });
    const plan = await f.plan();
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: delayed,
      receipts: [{ status: delayed ? 'succeeded' : 'pending', data: { bindingRecorded: delayed } }] } });
    expect(f.wire.mutations).toHaveLength(2);
    expect(parseDelegatedSecretBindings(ctx.repos.environments.findById(f.environment.id)!)).toHaveLength(delayed ? 1 : 0);
  });

  it('requires an acknowledged write and redacts an echoed provider input', async () => {
    const options: Parameters<typeof railwayHttpFixture>[0] = { responseOverride: request => {
      if (request.query.includes('mutation UpsertVariables')) return Response.json({ data: { variableCollectionUpsert: false } });
    } };
    const f = await fixture(options);
    const plan = await f.plan();
    const failed = await f.apply(plan.planRunId);
    expect(failed).toMatchObject({ kind: 'executed', result: { success: false } });
    options.responseOverride = request => request.query.includes('mutation UpsertVariables')
      ? Response.json({ errors: [{ message: `invalid value ${value}` }] }, { status: 400 }) : undefined;
    const retry = await f.plan();
    const echoed = await f.apply(retry.planRunId);
    expect(echoed).toMatchObject({ kind: 'executed', result: { success: false } });
    expect(JSON.stringify(echoed)).not.toContain(value);
    expect(parseDelegatedSecretBindings(ctx.repos.environments.findById(f.environment.id)!)).toEqual([]);
  });

  it('rejects ambiguous names and unknown bound identities without adopting or creating replacements', async () => {
    const f = await fixture({ pageSize: 1 });
    f.wire.addService('duplicate-web', 'web', stagingId);
    expect(await new PlanService().plan(f.project, 'staging', f.input)).toHaveProperty('error');
    f.wire.services.delete('duplicate-web');
    const plan = await f.plan();
    const saved = ctx.repos.runs.findById(plan.planRunId)!.plan as Record<string, unknown>;
    const wrongEnvironment = ctx.repos.runs.create({ projectId: f.project.id, environmentId: f.production.id, type: 'plan', plan: saved });
    expect(await f.apply(wrongEnvironment.id)).toMatchObject({ kind: 'blocked' });
    ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 'missing-web' }, worker: { serviceId: 'staging-worker' } } });
    expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'blocked' });
    expect(f.wire.mutations).toEqual([]);
  });

  it.each([{ services: [] }, { envVars: {} }, { envFile: '' }])('does not discard incompatible empty inputs at the public boundary: %j', async incompatible => {
    const f = await fixture();
    const registry = createCommandRegistry(ctx);
    let stdout = '';
    const code = await runWithWorkspaceDirectories([dir], () => runCli(['plan', '--input', '-', '--json'], {
      registry, initialize: false, io: { writeOut: text => { stdout += text; }, writeErr: () => {},
        readStdin: async () => JSON.stringify({ project: f.project.name, env: 'staging', ...f.input, ...incompatible }),
        confirm: async () => false, stdinIsTTY: false },
    }));
    expect(code).not.toBe(0);
    expect(JSON.parse(stdout).ok).toBe(false);
    expect(f.wire.requests).toEqual([]);
  });

  it('does not broaden a saved secrets plan to unrelated actions or ordinary overrides', async () => {
    const f = await fixture();
    const plan = await f.plan();
    const saved = ctx.repos.runs.findById(plan.planRunId)!.plan as Record<string, unknown>;
    for (const patch of [
      { actions: [{ id: 'service:web', type: 'update', resource: { kind: 'service', provider: 'railway', name: 'web' }, verified: true, reason: 'unrelated rollout' }] },
      { overrides: { ...(saved.overrides as object), envVarsEncrypted: getSecretStore().encryptObject({ OTHER: 'unrelated' }) } },
    ]) {
      const forged = ctx.repos.runs.create({ projectId: f.project.id, environmentId: f.environment.id, type: 'plan', plan: { ...saved, ...patch } });
      expect(await f.apply(forged.id)).toMatchObject({ kind: 'plan_not_found' });
    }
    expect(f.wire.mutations).toEqual([]);
  });

  it('blocks when live service identity changes after planning', async () => {
    const f = await fixture();
    const plan = await f.plan();
    f.wire.services.delete('staging-worker');
    f.wire.addService('replacement-worker', 'worker', stagingId);
    const result = await f.apply(plan.planRunId);
    expect(result.kind === 'blocked' || result.kind === 'executed' && !result.result.success).toBe(true);
    expect(f.wire.mutations).toEqual([]);
    expect(parseDelegatedSecretBindings(ctx.repos.environments.findById(f.environment.id)!)).toEqual([]);
  });

  it('exposes the same secret-only input and safe results through MCP and CLI', async () => {
    const f = await fixture();
    const registry = createCommandRegistry(ctx);
    expect(registry.get('hv_plan')!.inputSchema.safeParse({ project: f.project.name, env: 'staging', ...f.input }).success).toBe(true);
    const callbacks = new Map<string, (input: unknown) => Promise<McpToolResponse>>();
    registerCommandRegistry({
      server: { getClientCapabilities: () => ({ roots: {} }), listRoots: async () => ({ roots: [{ uri: pathToFileURL(dir).href }] }) },
      registerTool: (name: string, _schema: unknown, callback: (input: unknown) => Promise<McpToolResponse>) => callbacks.set(name, callback),
    } as unknown as McpServer, registry);
    expect([...callbacks.keys()].sort()).toEqual(registry.list().map(command => command.id).sort());
    const mcp = await callbacks.get('hv_plan')!({ project: f.project.name, env: 'staging', ...f.input });
    let stdout = '';
    let stderr = '';
    const code = await runWithWorkspaceDirectories([dir], () => runCli(['plan', '--project', f.project.name,
      '--env', 'staging', '--scope', 'secrets', '--secret-refs', JSON.stringify(f.input.secretRefs), '--json'], {
      registry, initialize: false, io: { writeOut: text => { stdout += text; }, writeErr: text => { stderr += text; },
        readStdin: async () => '', confirm: async () => false, stdinIsTTY: false },
    }));
    expect(code).toBe(0);
    const cli = JSON.parse(stdout);
    for (const result of [mcp.structuredContent, cli]) {
      expect(result).toMatchObject({ ok: true, data: { scope: 'secrets', environment: 'staging', pendingActionCount: 1 } });
      expect(JSON.stringify(result)).not.toContain(value);
      expect(result.data).not.toHaveProperty('localEnv');
    }
    expect(stderr).toBe('');
    expect(f.wire.mutations).toEqual([]);
  });
});
