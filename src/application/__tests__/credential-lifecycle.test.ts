import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { railwayHttpFixture, projectId, stagingId, productionId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService, type PlanOptions } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { planDelegatedSecrets } from '../../domain/services/delegated-secret.service.js';
import { credentialInventory } from '../credential-inventory.js';
import { createCommandRegistry } from '../commands.js';
import { runCli } from '../../interfaces/cli/run.js';
import { acceptedCredentialCiInputs } from '../../domain/services/accepted-credential-inputs.js';
import { parseStripeBindings, planStripeEnvironmentSync } from '../../domain/services/stripe-env.service.js';
import { hashEnvValue } from '../../domain/ports/observe.port.js';
import { registerCommandRegistry } from '../../interfaces/mcp/adapter.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import '../providers.js';

// Independent requirement: adoption preserves the existing value. Provider
// transport executes against the pinned Railway schema; state is synthetic.
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'hv-credential-lifecycle-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(dir, 'test.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}, github = false) {
  const ctx = createCommandContext();
  const wire = await railwayHttpFixture(options);
  wire.addService('staging-web', 'web', stagingId);
  wire.variables.set(`staging-web/${stagingId}`, { API_KEY: 'existing-value', ALIAS_KEY: 'existing-value', KEEP_ME: '${{shared.VALUE}}' });
  const project = ctx.repos.projects.create({ name: 'credential-lifecycle', defaultPlatform: 'railway', ...(github ? { gitRemoteUrl: 'https://github.com/acme/application' } : {}) });
  const file = path.join(dir, '.env');
  writeFileSync(file, 'INPUT=existing-value\n', { mode: 0o600 });
  const credential = { role: 'application-api', label: 'Application API', purpose: 'Authenticate application requests', source: `dotenv:${file}#INPUT`, kind: 'opaque' };
  const spec = new SpecStore().replace(project, { version: 1, project: project.name,
    ...(github ? { gitRemoteUrl: project.gitRemoteUrl, github: { repository: 'acme/application', canonicalEnvironment: 'staging' } } : {}),
    secrets: Object.fromEntries(['API_KEY', 'ALIAS_KEY'].map(key => [key, { ownership: 'delegated', principal: 'user:owner', environments: ['staging'], credential, ...(github ? { githubActions: key === 'API_KEY' ? { repository: true } : { environments: ['Production/eu'] } } : {}) }])),
    environments: { staging: { hosting: { provider: 'railway' }, envFile: { mode: 'off' }, services: { web: {} }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } } },
  });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'railway', projectId, environmentId: stagingId, services: { web: { serviceId: 'staging-web' } } } });
  ctx.repos.services.create({ projectId: project.id, name: 'web', buildConfig: {}, envVarSpec: {} });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: wire.adapter });
  const connection = ctx.repos.connections.create({ provider: 'railway', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-token' }) });
  ctx.repos.connections.updateStatus(connection.id, 'verified');
  const plan = (intent = 'adopt') => new PlanService().plan(project, 'staging', { scope: 'credentials', credential: 'application-api', intent } as unknown as PlanOptions);
  const apply = (planId: string, confirmActions: string[] = []) => executePlanApply(ctx, { project, spec: spec.spec, specRevision: spec.revision, planId, confirmActions });
  return { ctx, wire, project, environment, file, spec, plan, apply };
}

it('reviews value-preserving adoption for one declared source and two aliases', async () => {
  const f = await fixture();
  const plan = await f.plan();
  expect(plan).not.toHaveProperty('error');
  if ('error' in plan) return;
  expect(plan.scope).toBe('credentials');
  expect(plan.actions.every(a => a.requiresConfirm)).toBe(true);
  expect(f.wire.mutations).toEqual([]);
  expect(await f.apply(plan.planRunId)).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.mutations).toEqual([]);
  expect(f.wire.variables.get(`staging-web/${stagingId}`)).toEqual({ API_KEY: 'existing-value', ALIAS_KEY: 'existing-value', KEEP_ME: '${{shared.VALUE}}' });
  expect(JSON.stringify(f.ctx.repos.runs.findById(plan.planRunId)!.plan)).not.toContain('existing-value');
});

it('rejects adoption of a local replacement instead of silently rotating', async () => {
  const f = await fixture();
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  expect(await f.plan()).toMatchObject({ error: expect.stringMatching(/adoption.*match/i) });
  expect(f.wire.mutations).toEqual([]);
});

it('ordinary lifecycle cannot adopt an unreviewed tracked role', async () => {
  const f = await fixture();
  const { observed } = await new PlanService().observeEnvironment(f.project, f.environment, f.spec.spec.environments.staging, { hostingOnly: true });
  const planned = planDelegatedSecrets({ spec: f.spec.spec, environmentName: 'staging', environment: f.environment, hostingProvider: 'railway', observed, suppliedValues: { API_KEY: 'replacement-value' } });
  expect(planned.desiredEnvVars).toEqual({});
  expect(planned.blockers).toHaveLength(2);
});

it('freezes one replacement for all aliases and leaves rollout pending', async () => {
  const f = await fixture();
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  const plan = await f.plan('rotate');
  expect(plan).not.toHaveProperty('error');
  if ('error' in plan) return;
  writeFileSync(f.file, 'INPUT=another-local-edit\n');
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.variables.get(`staging-web/${stagingId}`)).toEqual({ API_KEY: 'replacement-value', ALIAS_KEY: 'replacement-value', KEEP_ME: '${{shared.VALUE}}' });
  expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.runtimeRollouts).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'web' })]));
  expect(f.wire.mutations.every(m => m.field === 'variableCollectionUpsert')).toBe(true);
});

it('reviews native configuration rollout effects without requiring a deferred-only writer', async () => {
  const f = await fixture();
  Object.assign(f.wire.adapter.capabilities, { supportsDeferredSecretUpdates: false, credentialUpdateActivation: 'provider-rollout', credentialValueEvidence: 'readback' });
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  const plan = await f.plan('rotate');
  expect(plan).not.toHaveProperty('error');
  if ('error' in plan) return;
  expect(plan.credentialReview?.targets).toEqual(expect.arrayContaining([expect.objectContaining({ activation: 'provider-rollout' })]));
  expect(plan.actions.every(action => action.reason.includes('rollout'))).toBe(true);
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
});

it('accepts acknowledged write-only hosting synchronization without inventing current-value proof', async () => {
  const f = await fixture();
  Object.assign(f.wire.adapter.capabilities, { credentialUpdateActivation: 'deferred', credentialValueEvidence: 'acknowledgement' });
  const observe = PlanService.prototype.observeEnvironment;
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockImplementation(async function (this: PlanService, ...args) {
    const result = await observe.apply(this, args);
    result.observed?.services.forEach(service => { delete service.envVarHashes.API_KEY; delete service.envVarHashes.ALIAS_KEY; });
    return result;
  });
  expect(await f.plan('adopt')).toMatchObject({ error: expect.stringMatching(/adoption|write.only/i) });
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  const plan = await f.plan('rotate');
  expect(plan).not.toHaveProperty('error');
  if ('error' in plan) return;
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  const inventory = await credentialInventory(f.ctx, f.project, 'staging');
  expect(inventory.roles.find(role => role.id === 'role:application-api')?.consumers.every(consumer => consumer.configuration.comparison === 'unknown')).toBe(true);
  const repeat = await f.plan('rotate');
  if ('error' in repeat) throw new Error(repeat.error);
  expect(repeat.actions.every(action => action.type === 'noop')).toBe(true);
  const observed = (await new PlanService().observeEnvironment(f.project, f.environment, f.spec.spec.environments.staging, { hostingOnly: true })).observed;
  const ordinary = planDelegatedSecrets({ spec: f.spec.spec, environmentName: 'staging', environment: f.ctx.repos.environments.findById(f.environment.id)!, hostingProvider: 'railway', observed });
  expect(ordinary.blockers).toEqual([]);
  expect(ordinary.actions.every(action => action.type === 'noop')).toBe(true);
});

it('inventory groups declared aliases and retains distinct source and date evidence', async () => {
  const f = await fixture();
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec,
    secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot, credential: { ...slot.credential, kind: 'anthropic' } }])) }));
  const railwayFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => new URL(String(input)).hostname === 'api.anthropic.com'
    ? Response.json({ data: [], has_more: false }) : railwayFetch(input, init)));
  const plan = await f.plan();
  if ('error' in plan) throw new Error(plan.error);
  await f.apply(plan.planRunId, plan.actions.map(a => a.id));
  expect((await credentialInventory(f.ctx, f.project, 'staging')).roles.find(r => r.id === 'role:application-api')?.validation.subject).toBe('accepted-plan-input');
  writeFileSync(f.file, 'INPUT=candidate-replacement\n');
  const candidate = await f.plan('rotate');
  if ('error' in candidate) throw new Error(candidate.error);
  const inventory = await credentialInventory(f.ctx, f.project, 'staging');
  const role = inventory.roles.find(r => r.id === 'role:application-api');
  expect(role).toMatchObject({ aliases: ['ALIAS_KEY', 'API_KEY'], source: { ref: `dotenv:${f.file}#INPUT` }, rotation: { lastRotatedAt: null, evidence: 'unknown', acceptedUpdateAt: expect.any(String) } });
  expect(role?.localCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'INPUT', comparisonToAccepted: 'different' })]));
  expect(role?.validation.subject).toBe('candidate-plan-input');
  expect(role?.source.lastReadAt).toEqual(expect.any(String));
  expect(role?.updates).toEqual(expect.arrayContaining([expect.objectContaining({ actionId: expect.stringContaining('credential:application-api:hosting:'), outcome: 'success' })]));
  expect(role?.updates).toHaveLength(2);
  expect(JSON.stringify(inventory)).not.toContain('candidate-replacement');
});

it('reports raw local file replacements as candidates without accepting or writing them', async () => {
  const f = await fixture();
  writeFileSync(f.file, 'existing-value\n');
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec,
    secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot, credential: { ...slot.credential, source: `file:${f.file}` } }])) }));
  const plan = await f.plan();
  if ('error' in plan) throw new Error(plan.error);
  await f.apply(plan.planRunId, plan.actions.map(a => a.id));
  writeFileSync(f.file, 'raw-file-replacement\n');
  const inventory = await credentialInventory(f.ctx, f.project, 'staging');
  expect(inventory.roles.find(r => r.id === 'role:application-api')?.localCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ path: f.file, comparisonToAccepted: 'different' })]));
  expect(JSON.stringify(inventory)).not.toContain('raw-file-replacement');
  expect(f.wire.mutations).toHaveLength(0);
});

it('recovers lost acknowledgements using readback without repeating writes', async () => {
  const f = await fixture({ dropVariableResponse: true });
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.mutations).toHaveLength(2);
});

it('restores rollout verification after interruption between a write and its local receipt', async () => {
  const f = await fixture();
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec, secrets: { API_KEY: f.spec.spec.secrets.API_KEY } }));
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  const update = EnvironmentRepository.prototype.updatePlatformBindings;
  const interruption = vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementation(function (this: EnvironmentRepository, id, patch) {
    if (patch.runtimeRollouts) throw new Error('synthetic interruption after provider write');
    return update.call(this, id, patch);
  });
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: false } });
  interruption.mockRestore();
  expect(f.wire.variables.get(`staging-web/${stagingId}`)!.API_KEY).toBe('replacement-value');
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.mutations).toHaveLength(1);
  expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.runtimeRollouts).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'web', actionIds: [plan.actions[0].id] })]));
});

it('recovers acceptance after a successful apply whose final local metadata update was interrupted', async () => {
  const f = await fixture();
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  const update = EnvironmentRepository.prototype.updatePlatformBindings;
  const interruption = vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementation(function (this: EnvironmentRepository, id, patch) {
    if ((patch.credentialUpdates as any)?.['application-api']?.state === 'accepted') throw new Error('synthetic interruption after successful apply');
    return update.call(this, id, patch);
  });
  await expect(f.apply(plan.planRunId, plan.actions.map(a => a.id))).rejects.toThrow('synthetic interruption');
  interruption.mockRestore();
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.mutations).toHaveLength(2);
  expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.credentialUpdates).toMatchObject({ 'application-api': { state: 'accepted', planId: plan.planRunId } });
});

it('does not reuse validation of a different Stripe account as proof of intended identity', async () => {
  const f = await fixture();
  const withAccount = (accountId: string) => new SpecStore().replace(f.project, { ...f.spec.spec,
    secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot, credential: { ...slot.credential, kind: 'stripe', identity: { accountId, mode: 'test' } } }])) });
  Object.assign(f.spec, withAccount('acct_first'));
  const railwayFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => new URL(String(input)).hostname === 'api.stripe.com'
    ? Response.json(String(input).endsWith('/account') ? { id: 'acct_first', object: 'account' } : { object: 'balance', livemode: false }) : railwayFetch(input, init)));
  const plan = await f.plan();
  if ('error' in plan) throw new Error(plan.error);
  await f.apply(plan.planRunId, plan.actions.map(a => a.id));
  expect((await credentialInventory(f.ctx, f.project, 'staging')).roles.find(r => r.id === 'role:application-api')?.identity.state).toBe('validated');
  Object.assign(f.spec, withAccount('acct_other_sandbox'));
  expect((await credentialInventory(f.ctx, f.project, 'staging')).roles.find(r => r.id === 'role:application-api')?.identity.state).toBe('unknown');
});

it('partial synchronization resumes only the remaining destination with the frozen value', async () => {
  let failSecond = true;
  const f = await fixture({ responseOverride: request => {
    if (failSecond && request.query.includes('mutation') && request.query.includes('variableCollectionUpsert') && request.variables.variables?.API_KEY) return Response.json({ errors: [{ message: 'synthetic interrupted transport' }] });
    return undefined;
  } });
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  const confirmed = plan.actions.map(a => a.id);
  expect(await f.apply(plan.planRunId, confirmed)).toMatchObject({ kind: 'executed', result: { success: false } });
  expect(f.wire.variables.get(`staging-web/${stagingId}`)!.ALIAS_KEY).toBe('replacement-value');
  expect(await f.plan('rotate')).toMatchObject({ error: expect.stringContaining(plan.planRunId) });
  const dispatch = await createCommandRegistry(f.ctx).execute('hv_ci_trigger', { project: f.project.name, definition: 'deploy.yml' });
  expect(JSON.stringify(dispatch)).toContain('Credential synchronization is incomplete');
  failSecond = false;
  writeFileSync(f.file, 'INPUT=different-new-candidate\n');
  expect((await credentialInventory(f.ctx, f.project, 'staging')).roles.find(r => r.id === 'role:application-api')?.nextAction).toContain(plan.planRunId);
  // A failed transport does not prove a rejected write. Explicitly review the
  // uncertainty before replay; confirmed destinations are read, never resent.
  expect(await f.apply(plan.planRunId, [...confirmed, ...confirmed.map(id => `${id}:retry-uncertain`)])).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.mutations).toHaveLength(2);
  expect(f.wire.variables.get(`staging-web/${stagingId}`)!.API_KEY).toBe('replacement-value');
});

it.each([false, true])('one source supplies exact GitHub aliases and scopes without recreating environments (repository-only: %s)', async repositoryOnly => {
  const f = await fixture({}, true);
  if (repositoryOnly) {
    const next = new SpecStore().replace(f.project, { ...f.spec.spec, environments: {}, github: { ...f.spec.spec.github, canonicalEnvironment: undefined },
      secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot, environments: [] }])) });
    Object.assign(f.spec, next);
    f.ctx.repos.environments.create({ projectId: f.project.id, name: 'repository' });
  }
  const planCredential = () => new PlanService().plan(f.project, repositoryOnly ? 'repository' : 'staging', { scope: 'credentials', credential: 'application-api', intent: 'rotate' });
  const connection = f.ctx.repos.connections.create({ provider: 'github', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-management-token' }) });
  f.ctx.repos.connections.updateStatus(connection.id, 'verified');
  const railwayFetch = globalThis.fetch;
  const writes: string[] = [];
  const environment = { id: 17, name: 'Production/eu' };
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.github.com') return railwayFetch(input, init);
    if (init?.method === 'PUT') { writes.push(url.pathname); expect(String(init.body)).not.toContain('existing-value'); return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith('/public-key')) return Response.json({ key_id: 'key-id', key: Buffer.alloc(32, 1).toString('base64') });
    if (url.pathname.endsWith('/environments')) return Response.json({ total_count: 1, environments: [environment] });
    if (url.pathname.endsWith('/environments/Production%2Feu')) return Response.json(environment);
    const secrets = writes.filter(write => write.startsWith(url.pathname + '/')).map(write => ({ name: write.split('/').at(-1), created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }));
    return Response.json({ total_count: secrets.length, secrets });
  }));
  const plan = await planCredential();
  if ('error' in plan) throw new Error(plan.error);
  expect(plan.actions).toHaveLength(repositoryOnly ? 2 : 4);
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(writes.sort()).toEqual(['/repos/acme/application/actions/secrets/API_KEY', '/repos/acme/application/environments/Production%2Feu/secrets/ALIAS_KEY']);
  writeFileSync(f.file, 'INPUT=unaccepted-next-edit\n');
  expect(acceptedCredentialCiInputs(f.project, 'acme/application', 'Production/eu')).toEqual([{ name: 'ALIAS_KEY', value: 'existing-value' }]);
  expect(acceptedCredentialCiInputs(f.project, 'acme/other', 'Production/eu')).toEqual([{ name: 'ALIAS_KEY' }]);
  writeFileSync(f.file, 'INPUT=existing-value\n');
  const repeat = await planCredential();
  if ('error' in repeat) throw new Error(repeat.error);
  expect(repeat.actions.every(a => a.type === 'noop')).toBe(true);
  // A provider-confirmed deletion requires restoring just that destination.
  // Noop aliases must retain their accepted source in ordinary CI afterward.
  writes.splice(writes.indexOf('/repos/acme/application/actions/secrets/API_KEY'), 1);
  const repair = await planCredential();
  if ('error' in repair) throw new Error(repair.error);
  expect(repair.actions.filter(a => a.type !== 'noop')).toHaveLength(1);
  expect(await f.apply(repair.planRunId, repair.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(acceptedCredentialCiInputs(f.project, 'acme/application', 'Production/eu')).toEqual([{ name: 'ALIAS_KEY', value: 'existing-value' }]);
  const inventory = await credentialInventory(f.ctx, f.project, repositoryOnly ? 'repository' : 'staging');
  expect(inventory.roles.find(r => r.id === 'role:application-api')?.consumers.filter(c => c.kind === 'github-actions')).toHaveLength(2);
  writeFileSync(f.file, 'INPUT=unaccepted-source-replacement\n');
  const candidate = await credentialInventory(f.ctx, f.project, repositoryOnly ? 'repository' : 'staging');
  expect(candidate.roles.find(r => r.id === 'role:application-api')?.localCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ comparisonToAccepted: 'different' })]));
});

it('CLI exposes the same reviewed credential scope without reading bulk dotenv input', async () => {
  const f = await fixture();
  const registry = createCommandRegistry(f.ctx);
  let output = '';
  const code = await runCli(['plan', '--project', f.project.name, '--env', 'staging', '--scope', 'credentials', '--credential', 'application-api', '--intent', 'adopt', '--json'], { registry, io: { writeOut: value => { output += value; }, writeErr: () => {}, readStdin: async () => '', confirm: async () => false, stdinIsTTY: false } });
  expect(code).toBe(0);
  expect(output).toContain('credential:application-api');
  expect(output).not.toContain('existing-value');
  expect(f.wire.mutations).toEqual([]);
  const server = new McpServer({ name: 'credential-test', version: '1' });
  registerCommandRegistry(server, registry);
  const client = new Client({ name: 'credential-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const mcp = await client.callTool({ name: 'hv_plan', arguments: { project: f.project.name, env: 'staging', scope: 'credentials', credential: 'application-api', intent: 'adopt' } });
    expect(JSON.stringify(mcp)).toContain('credential:application-api');
    expect(JSON.stringify(mcp)).not.toContain('existing-value');
    expect((mcp.structuredContent as any).data.actions).toEqual(JSON.parse(output).data.actions);
  } finally { await client.close(); await server.close(); }

});

it('generates one session-signing replacement without copied input and keeps the generation on retry', async () => {
  const f = await fixture();
  const next = new SpecStore().replace(f.project, { ...f.spec.spec, secrets: Object.fromEntries(['API_KEY', 'ALIAS_KEY'].map(key => [key, { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 2, environments: ['staging'], credential: { role: 'application-api', label: 'Sessions', purpose: 'Sign application sessions', kind: 'session-signing' } }])) });
  Object.assign(f.spec, next);
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  expect(plan.warnings.join(' ')).toContain('sign users out');
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  const values = f.wire.variables.get(`staging-web/${stagingId}`)!;
  expect(values.API_KEY).toBe(values.ALIAS_KEY);
  expect(values.API_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const again = await f.plan('rotate');
  if ('error' in again) throw new Error(again.error);
  expect(again.actions.every(a => a.type === 'noop')).toBe(true);
  expect(JSON.stringify(again)).not.toContain(values.API_KEY);
});

it.each(['database-password', 'stripe-webhook'])('does not pretend an environment edit rotates %s', async kind => {
  const f = await fixture();
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec, secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot, credential: { ...slot.credential, kind } }])) }));
  expect(await f.plan('rotate')).toMatchObject({ error: expect.stringContaining('native') });
  expect(f.wire.mutations).toEqual([]);
});

it.each(['supplied', 'provider-generated'] as const)('rejects a SQL-only %s lifecycle before database or consumer mutation', async inputMode => {
  const f = await fixture();
  f.wire.variables.get(`staging-web/${stagingId}`)!.API_KEY = 'postgresql://app:native-old@db.example:5432/application?sslmode=require&application_name=web';
  const component = f.ctx.repos.components.create({ environmentId: f.environment.id, type: 'postgres', externalId: 'database-native-id',
    bindings: { password: 'native-old', connectionString: 'postgresql://app:native-old@db.example:5432/application?sslmode=require', keep: 'untouched' } });
  let nativePassword = 'native-old';
  let rotations = 0;
  const target = { provider: 'railway', componentId: component.id, environmentId: f.environment.id, externalId: component.externalId!, username: 'app', database: 'application', providerScope: { projectId }, inputMode,
    connection: { host: 'db.example', port: 5432, username: 'app', database: 'application' } };
  // This is an orchestration fault fixture. Provider transport/SQL contracts are
  // independently exercised by database-credential API-contract tests.
  vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: { name: 'railway', credentialLifecycle: {
    inspect: async () => target, readCurrent: async () => inputMode === 'provider-generated' ? nativePassword : null,
    probe: async (_env: unknown, _component: unknown, _target: unknown, password: string) => ({ state: password === nativePassword ? 'authenticated' : 'rejected', tested: 'Fresh database authentication' }),
    rotate: async (_env: unknown, _component: unknown, _target: unknown, password?: string) => {
      rotations++; nativePassword = inputMode === 'supplied' ? password! : 'provider-generated-replacement';
      return inputMode === 'supplied' ? { state: 'acknowledged' } : { state: 'unknown' };
    },
  } } as any });
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec,
    environments: { staging: { ...f.spec.spec.environments.staging, database: { engine: 'postgres', provider: 'railway' } } },
    secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot, credential: { ...slot.credential, source: inputMode === 'supplied' ? slot.credential!.source : undefined,
      kind: 'database-password', database: { environment: 'staging', component: component.id, username: 'app', database: 'application' },
      runtimeConsumers: [{ environment: 'staging', service: 'web', variable: 'API_KEY', format: 'database-url' }, { environment: 'staging', service: 'web', variable: 'ALIAS_KEY' }] } }])) }));
  writeFileSync(f.file, 'INPUT=supplied-replacement\n');
  const plan = await f.plan('rotate');
  expect(plan).toMatchObject({ error: expect.stringMatching(/native|required|unsupported/i) });
  expect(rotations).toBe(0);
  expect(f.wire.variables.get(`staging-web/${stagingId}`)!.API_KEY).toContain('native-old');
  expect(f.ctx.repos.components.findById(component.id)?.bindings.password).toBe('native-old');

});

it('synchronizes only explicitly declared runtime services', async () => {
  const f = await fixture();
  f.wire.addService('staging-worker', 'worker', stagingId);
  f.wire.variables.set(`staging-worker/${stagingId}`, { API_KEY: 'unrelated-worker-value', KEEP_ME: '${{shared.REFERENCE}}' });
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 'staging-web' }, worker: { serviceId: 'staging-worker' } } });
  f.ctx.repos.services.create({ projectId: f.project.id, name: 'worker', buildConfig: {}, envVarSpec: {} });
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec,
    environments: { staging: { ...f.spec.spec.environments.staging, services: { web: {}, worker: {} } } },
    secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot,
      credential: { ...slot.credential, runtimeConsumers: ['API_KEY', 'ALIAS_KEY'].map(variable => ({ environment: 'staging', service: 'web', variable })) } }])) }));
  writeFileSync(f.file, 'INPUT=replacement-value\n');
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  expect(plan.actions.map(action => (action.metadata?.target as any)?.services)).toEqual([['web'], ['web']]);
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.variables.get(`staging-worker/${stagingId}`)).toEqual({ API_KEY: 'unrelated-worker-value', KEEP_ME: '${{shared.REFERENCE}}' });
  const inventory = await credentialInventory(f.ctx, f.project, 'staging');
  const role = inventory.roles.find(role => role.id === 'role:application-api')!;
  expect(role.consumers.filter(consumer => consumer.kind === 'hosting').map(consumer => consumer.service)).toEqual(['web', 'web']);
  expect(inventory.roles.find(role => role.id === 'untracked:worker:API_KEY')).toMatchObject({ ownership: 'untracked-input' });
});

it('rotates a Stripe signing secret through the reviewed lifecycle without changing its exact endpoint', async () => {
  const f = await fixture();
  const stripeConnection = f.ctx.repos.connections.create({ provider: 'stripe', scope: 'stripe-sandbox', credentialsEncrypted: getSecretStore().encryptObject({ secretKey: 'sk_test_management' }) });
  f.ctx.repos.connections.updateStatus(stripeConnection.id, 'verified');
  const webhook = { service: 'web', envVar: 'API_KEY', url: 'https://app.example.test/billing', events: ['checkout.session.completed'] };
  const endpoint = { id: 'we_bound', object: 'webhook_endpoint', status: 'enabled', url: webhook.url, enabled_events: webhook.events, created: 1, livemode: false };
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { payments: { stripe: { environment: 'stripe-sandbox', catalog: { products: {} }, webhooks: { billing: { ...webhook, endpointId: endpoint.id, valueHash: hashEnvValue('existing-value') } } } } });
  const originalFetch = globalThis.fetch;
  const stripeWrites: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.stripe.com') return originalFetch(input, init);
    if (init?.method && init.method !== 'GET') stripeWrites.push(init.method);
    if (url.pathname === '/v1/account') return Response.json({ id: 'acct_sandbox', object: 'account' });
    if (url.pathname === '/v1/webhook_endpoints/we_bound') return Response.json(endpoint);
    if (url.pathname === '/v1/webhook_endpoints') return Response.json({ object: 'list', data: [endpoint], has_more: false });
    throw new Error('Unexpected Stripe request');
  }));
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec,
    environments: { staging: { ...f.spec.spec.environments.staging, payments: { stripe: { environment: 'stripe-sandbox', webhooks: { billing: webhook } } } } },
    secrets: { API_KEY: { ...f.spec.spec.secrets.API_KEY, credential: { ...f.spec.spec.secrets.API_KEY.credential!, kind: 'stripe-webhook',
      identity: { accountId: 'acct_sandbox', mode: 'test', endpointId: endpoint.id }, stripeWebhook: { environment: 'staging', webhook: 'billing' } } } } }));
  writeFileSync(f.file, 'INPUT=whsec_reviewedReplacement\n');
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  expect(plan.warnings.join(' ')).toContain('https://dashboard.stripe.com/webhooks');
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.variables.get(`staging-web/${stagingId}`)).toEqual({ API_KEY: 'whsec_reviewedReplacement', ALIAS_KEY: 'existing-value', KEEP_ME: '${{shared.VALUE}}' });
  const current = f.ctx.repos.environments.findById(f.environment.id)!;
  expect(parseStripeBindings(current).webhooks.billing).toMatchObject({ endpointId: endpoint.id, url: webhook.url, valueHash: hashEnvValue('whsec_reviewedReplacement') });
  const { observed } = await new PlanService().observeEnvironment(f.project, current, f.spec.spec.environments.staging, { hostingOnly: true });
  const ordinary = await planStripeEnvironmentSync({ environmentName: 'staging', environmentSpec: f.spec.spec.environments.staging, environment: current, observed });
  expect(ordinary.actions.every(action => action.type === 'noop')).toBe(true);
  expect(stripeWrites).toEqual([]);
  expect(JSON.stringify(await credentialInventory(f.ctx, f.project, 'staging'))).not.toContain('whsec_reviewedReplacement');
});

it('one reviewed plan locks and synchronizes all declared runtime environments', async () => {
  const f = await fixture({ variableMutationEnvironments: [stagingId, productionId] });
  const production = f.ctx.repos.environments.create({ projectId: f.project.id, name: 'production', platformBindings: { provider: 'railway', projectId, environmentId: productionId, services: { web: { serviceId: 'production-web' } } } });
  f.wire.variables.set(`production-web/${productionId}`, { API_KEY: 'old-production', ALIAS_KEY: 'old-production', KEEP_ME: 'production-only' });
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec, environments: { ...f.spec.spec.environments, production: f.spec.spec.environments.staging }, secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot, environments: ['staging', 'production'] }])) }));
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  expect(plan.actions).toHaveLength(4);
  expect((f.ctx.repos.runs.findById(plan.planRunId)!.plan as Record<string, unknown>).lockEnvironmentIds).toEqual(expect.arrayContaining([production.id, f.environment.id]));
  const result = await f.apply(plan.planRunId, plan.actions.map(a => a.id));
  expect(result, JSON.stringify(result)).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.wire.variables.get(`production-web/${productionId}`)).toEqual({ API_KEY: 'existing-value', ALIAS_KEY: 'existing-value', KEEP_ME: 'production-only' });
  const inventory = await credentialInventory(f.ctx, f.project, 'production');
  expect(inventory.roles.find(r => r.id === 'role:application-api')!.consumers.every(c => c.configuration.comparison === 'match')).toBe(true);
});

it('preserves the existing immutable generated-secret contract', async () => {
  const f = await fixture();
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec, secrets: { API_KEY: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', replacementPolicy: 'immutable', conflictsWith: [], environments: ['staging'], credential: { role: 'application-api', label: 'Immutable', purpose: 'Protect encrypted state', kind: 'opaque' } } } }));
  expect(await f.plan('rotate')).toMatchObject({ error: expect.stringMatching(/immutable/i) });
  expect(f.wire.mutations).toEqual([]);
});

it('synchronizes the separate container-pull copy through the reviewed lifecycle', async () => {
  const f = await fixture();
  const instance = f.wire.services.get('staging-web')!.instances.get(stagingId)!;
  instance.source = { image: 'ghcr.io/acme/application@sha256:abcdef' };
  Object.assign(f.spec, new SpecStore().replace(f.project, { ...f.spec.spec, secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, { ...slot, credential: { ...slot.credential, containerPull: [{ environment: 'staging', service: 'web', username: 'package-reader' }] } }])) }));
  writeFileSync(f.file, 'INPUT=package-replacement\n');
  const plan = await f.plan('rotate');
  if ('error' in plan) throw new Error(plan.error);
  expect(plan.actions).toHaveLength(3);
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ kind: 'executed', result: { success: true } });
  const writes = f.wire.mutations.filter(m => m.field === 'serviceInstanceUpdate');
  expect(writes).toMatchObject([{ args: { serviceId: 'staging-web', environmentId: stagingId, input: { registryCredentials: { username: 'package-reader', password: 'package-replacement' } } } }]);
  expect(instance.source.image).toBe('ghcr.io/acme/application@sha256:abcdef');
  const inventory = await credentialInventory(f.ctx, f.project, 'staging');
  expect(inventory.roles.find(r => r.id === 'role:application-api')!.consumers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'container-pull', serviceId: 'staging-web', configuration: expect.objectContaining({ comparison: 'unknown' }) })]));
});
