import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter, getDb } from '../../adapters/db/sqlite.adapter.js';
import { ProjectSpecRepository } from '../../adapters/db/repositories/spec.repository.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerHvSecretsTools } from '../../tools/hv-secrets.tools.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { runCli } from '../../interfaces/cli/run.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { hashEnvValue } from '../../domain/ports/observe.port.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { railwayHttpFixture, projectId, productionId } from '../../adapters/providers/railway/__tests__/railway-http.fixture.js';

// User regression: a replacement exists locally while the old deployment still
// serves traffic. These are synthetic lifecycle observations, not live evidence.
let root: string;
let cwd: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hv-inventory-'));
  cwd = process.cwd(); process.chdir(root);
  mkdirSync(path.join(root, '.git')); mkdirSync(path.join(root, '.hypervibe'));
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
  SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(root, 'test.db')).migrate();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance();
  process.chdir(cwd); rmSync(root, { recursive: true, force: true });
});
function fixture(secrets: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'inventory-app', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/owner/inventory-app' });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name,
    gitRemoteUrl: project.gitRemoteUrl,
    environments: { production: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } } } }, secrets, ...extra });
  new ProjectSpecRepository().insert(project.id, 1, spec);
  writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify(spec));
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production',
    platformBindings: { provider: 'railway', projectId: 'p1', environmentId: 'e1', services: { web: { serviceId: 's1' } } } });
  const observed = { provider: 'railway', observedAt: '2026-10-20T00:00:00Z', projectExists: true,
    projectId: 'p1', environmentId: 'e1', partial: false, warnings: [], databases: [],
    completeness: { project: 'complete' as const, environment: 'complete' as const, services: 'complete' as const },
    services: [{ name: 'web', externalId: 's1', workloadKind: 'web' as const, customDomains: [], config: {},
      envVarKeys: ['ANTHROPIC_API_KEY'], envVarHashes: { ANTHROPIC_API_KEY: hashEnvValue('old-private-value') },
      status: 'running' as const, deployment: { id: 'deployment-old' } }] };
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed, warnings: [] });
  const registry = new CommandRegistry(); registerHvSecretsTools(registry, ctx);
  const input = { project: project.name, env: 'production', view: 'inventory' };
  return { ctx, project, spec, environment, observed, registry, input,
    read: () => registry.execute('hv_secrets', input) as Promise<any> };
}
function accepted(f: ReturnType<typeof fixture>, options: { failed?: boolean; pending?: boolean } = {}) {
  const reservation = f.ctx.repos.runs.reserveApply({ projectId: f.project.id, environmentId: f.environment.id,
    planRunId: 'synthetic-plan', environmentName: 'production', specRevision: 1 });
  if (!reservation.reserved) throw new Error('fixture reservation failed');
  const run = reservation.run;
  f.ctx.repos.runs.addReceipt(run.id, { step: 'secret:ANTHROPIC_API_KEY', status: options.failed ? 'failure' : 'success', timestamp: '2026-10-19T00:00:00Z' });
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, {
    delegatedEnvBindings: [{ name: 'ANTHROPIC_API_KEY', principal: 'application-owner', valueHash: hashEnvValue('old-private-value'),
      source: 'delegated-plan-input', syncedAt: '2026-10-19T00:00:00Z', applyRunId: run.id, actionId: 'secret:ANTHROPIC_API_KEY' }],
    ...(options.pending ? { runtimeRollouts: [{ service: 'web', provider: 'railway', serviceExternalId: 's1',
      baselineDeployment: { state: 'present', id: 'deployment-old' }, requiredAt: '2026-10-19T00:00:00Z', applyRunId: run.id, actionIds: ['secret:ANTHROPIC_API_KEY'] }] } : {}),
  });
}
const delegated = { ownership: 'delegated', principal: 'application-owner', environments: ['production'] };
const operationId = '22222222-2222-4222-8222-222222222222';
function acceptedRole(options: { pendingWrite?: boolean; pendingRollout?: boolean; coverage?: 'instances' | 'traffic'; verification?: boolean; secondConsumer?: boolean } = {}) {
  const descriptor = { role: 'document-extraction', kind: 'anthropic', label: 'Document extraction', purpose: 'Extract an invoice', source: 'env:ANTHROPIC_INPUT',
    ...(options.verification ? { verification: [{ kind: 'http-receipt', environment: 'production', service: 'web', path: '/operation-receipt', requiredCounts: { invoiceExtracted: 1 } }] } : {}) };
  const f = fixture({ ANTHROPIC_API_KEY: { ...delegated, credential: descriptor } }, options.secondConsumer ? {
    environments: { production: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' }, worker: { workloadKind: 'worker' } } } },
  } : {});
  accepted(f);
  f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { credentialUpdates: { [descriptor.role]: {
    state: options.pendingWrite ? 'pending' : 'accepted', planId: operationId, descriptor: f.spec.secrets.ANTHROPIC_API_KEY!.credential,
    acceptedAt: '2026-10-19T00:00:00Z', acceptedInputHash: hashEnvValue('old-private-value'), completed: [], attempted: [],
  } }, runtimeRollouts: [{ service: 'web', provider: 'railway', serviceExternalId: 's1', providerProjectId: 'p1', providerEnvironmentId: 'e1', operationId,
    configurationExpectationEncrypted: getSecretStore().encryptObject({ ANTHROPIC_API_KEY: hashEnvValue('old-private-value') }),
    baselineDeployment: { state: 'present', id: options.pendingRollout ? 'deployment-old' : 'deployment-before', activeDeploymentIds: ['deployment-before'] },
    requiredAt: '2026-10-19T00:00:00Z', applyRunId: 'synthetic-apply', actionIds: ['secret:ANTHROPIC_API_KEY'] }],
    ...(options.secondConsumer ? { services: { web: { serviceId: 's1' }, worker: { serviceId: 's2' } } } : {}),
  });
  Object.assign(f.observed.services[0].deployment, { activeDeploymentIds: ['deployment-old'], activeDeploymentCoverage: options.coverage ?? 'instances',
    configurationState: 'resolved', envVarHashes: { ANTHROPIC_API_KEY: hashEnvValue('old-private-value') } });
  if (options.secondConsumer) f.observed.services.push({ ...f.observed.services[0], name: 'worker', externalId: 's2', deployment: { id: 'worker-old' } });
  return f;
}

describe('read-only credential inventory', () => {
  it('reuses recorded connection sources and approved owner-request imports without inventing rotation dates', async () => {
    const f = fixture();
    writeFileSync(path.join(root, '.env.production'), 'ANTHROPIC_API_KEY=local-value\n');
    const connection = f.ctx.repos.connections.create({ provider: 'railway', credentialsEncrypted: f.ctx.secretStore.encryptObject({ apiToken: 'private-provider-token' }) });
    f.ctx.repos.audit.create({ action: 'connection.created', resourceType: 'connection', resourceId: connection.id,
      details: { provider: 'railway', credentialsSource: 'dotenv', credentialsRef: 'dotenv:/private/source.env#TOKEN' } });
    f.ctx.repos.connections.create({ provider: 'hypervibe-secret-import', credentialsEncrypted: f.ctx.secretStore.encryptObject({ version: 1,
      status: 'imported', requestId: '11111111-1111-4111-8111-111111111111', repository: 'owner/inventory-app', environment: 'production', root, keys: ['ANTHROPIC_API_KEY'],
      receivedAt: '2026-10-20T00:00:00Z', importedAt: '2026-10-20T00:00:01Z', fileDigest: 'c'.repeat(64), sourceRevision: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), expiresAt: '2026-10-21T00:00:00Z' }) });
    const before = getDb().prepare('SELECT total_changes() AS n').get();
    const result = await f.read();
    const provider = result.data.roles.find((role: any) => role.source.id === connection.id);
    expect(provider.source).toMatchObject({ originalInput: 'dotenv', ref: 'dotenv:/private/source.env#TOKEN', lastReadAt: expect.any(String) });
    const runtime = result.data.roles.find((role: any) => role.id === 'untracked:ANTHROPIC_API_KEY');
    expect(runtime.source.acquisitions).toEqual([expect.objectContaining({ requestId: '11111111-1111-4111-8111-111111111111', receivedAt: '2026-10-20T00:00:00Z', importedAt: '2026-10-20T00:00:01Z' })]);
    expect(runtime.rotation.lastRotatedAt).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/private-provider-token|private-file-fingerprint|local-value/);
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('distinguishes declared connection aliases from each recorded resolved source without inventing history', async () => {
    const f = fixture();
    const connection = f.ctx.repos.connections.create({ provider: 'github', credentialsEncrypted: f.ctx.secretStore.encryptObject({ apiToken: 'private-api-value', packageReadToken: 'private-package-value' }) });
    f.ctx.repos.audit.create({ action: 'connection.created', resourceType: 'connection', resourceId: connection.id,
      details: { credentialsSource: 'dotenv', credentialsRef: 'dotenv:/private/source.env',
        credentialsMap: { apiToken: 'HYPERVIBE_GITHUB_TOKEN', packageReadToken: 'HYPERVIBE_GITHUB_PACKAGES_TOKEN' },
        credentialsResolution: { apiToken: { resolvedRef: 'dotenv:/private/source.env#NODE_AUTH_TOKEN', sourceKey: 'NODE_AUTH_TOKEN' } } } });
    const before = getDb().prepare('SELECT total_changes() AS n').get();
    const result = await f.read();
    const api = result.data.roles.find((role: any) => role.id === `connection:${connection.id}:apiToken`);
    const packages = result.data.roles.find((role: any) => role.id === `connection:${connection.id}:packageReadToken`);
    expect(api.source).toMatchObject({ ref: 'dotenv:/private/source.env', inputKey: 'HYPERVIBE_GITHUB_TOKEN', resolvedRef: 'dotenv:/private/source.env#NODE_AUTH_TOKEN', resolvedInputKey: 'NODE_AUTH_TOKEN' });
    expect(packages.source).not.toHaveProperty('resolvedRef');
    expect(api.rotation.lastRotatedAt).toBeNull();
    expect(api.validation.at).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/private-api-value|private-package-value/);
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it.each(['traffic', 'instances'] as const)('reports retirement only to the extent of provider %s coverage', async coverage => {
    const f = fixture({ ANTHROPIC_API_KEY: delegated });
    accepted(f);
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { runtimeRollouts: [{ service: 'web', provider: 'railway', serviceExternalId: 's1',
      providerProjectId: 'p1', providerEnvironmentId: 'e1', operationId: 'synthetic-plan',
      configurationExpectationEncrypted: getSecretStore().encryptObject({ ANTHROPIC_API_KEY: hashEnvValue('old-private-value') }),
      baselineDeployment: { state: 'present', id: 'deployment-before', activeDeploymentIds: ['deployment-before'] },
      requiredAt: '2026-10-19T00:00:00Z', applyRunId: 'synthetic-apply', actionIds: ['secret:ANTHROPIC_API_KEY'] }] });
    Object.assign(f.observed.services[0].deployment, { activeDeploymentIds: ['deployment-old'], activeDeploymentCoverage: coverage,
      configurationState: 'resolved', envVarHashes: { ANTHROPIC_API_KEY: hashEnvValue('old-private-value') } });
    const result = await f.read();
    const activation = result.data.roles[0].consumers[0].activation;
    expect(activation).toMatchObject({ state: 'replacement-deployed', allInstances: coverage === 'instances' ? 'confirmed' : 'unknown', coverage });
    expect(activation.lastConfirmedAt).toBe(f.observed.observedAt);
  });

  it('compares a source to its accepted input while comparing each rendered consumer privately', async () => {
    const file = path.join(root, 'credential');
    writeFileSync(file, 'raw-accepted-password');
    const descriptor = { role: 'database-login', kind: 'opaque', label: 'Database login', purpose: 'Application authentication', source: `file:${file}` };
    const f = fixture({ ANTHROPIC_API_KEY: { ...delegated, credential: descriptor } });
    accepted(f);
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { credentialUpdates: { 'database-login': {
      state: 'accepted', planId: 'synthetic-plan', descriptor, acceptedInputHash: hashEnvValue('raw-accepted-password'),
      hostingHashes: { ANTHROPIC_API_KEY: { web: hashEnvValue('old-private-value') } }, completed: [], attempted: [],
    } } });
    const result = await f.read();
    const role = result.data.roles.find((role: any) => role.id === 'role:database-login');
    expect(role.localCandidates.find((candidate: any) => candidate.path === file).comparisonToAccepted).toBe('match');
    expect(role.consumers[0].configuration.comparison).toBe('match');
    expect(JSON.stringify(result)).not.toMatch(/raw-accepted-password|old-private-value/);
  });

  it('does not treat recorded hashes as a provider readback of current write-only values', async () => {
    const f = fixture({ ANTHROPIC_API_KEY: delegated });
    accepted(f);
    Object.assign(f.observed.services[0], { envVarEvidence: 'recorded-update' });
    const result = await f.read();
    expect(result.data.roles.find((role: any) => role.id === 'secret:ANTHROPIC_API_KEY').consumers[0].configuration).toMatchObject({ presence: 'present', comparison: 'unknown' });
  });

  it('reports untracked dotenv replacements without adopting, chmod, or disclosing them', async () => {
    const f = fixture();
    const file = path.join(root, '.env.production');
    writeFileSync(file, 'ANTHROPIC_API_KEY=new-private-value\nSENDGRID_API_KEY=mail-private-value\n', { mode: 0o644 });
    const before = getDb().prepare('SELECT total_changes() AS n').get();
    const bytes = readFileSync(file); const mode = statSync(file).mode;
    const result = await f.read();
    expect(result.ok).toBe(true);
    expect(result.data.roles).toEqual(expect.arrayContaining([expect.objectContaining({
      ownership: 'untracked-input', aliases: ['ANTHROPIC_API_KEY'],
      consumers: expect.arrayContaining([expect.objectContaining({ service: 'web',
        configuration: expect.objectContaining({ comparison: 'different' }),
        activation: expect.objectContaining({ state: 'unknown' }) })]),
      rotation: expect.objectContaining({ lastRotatedAt: null, expiresAt: null }),
    })]));
    expect(JSON.stringify(result)).not.toMatch(/new-private-value|old-private-value|mail-private-value/);
    expect(JSON.stringify(result)).not.toContain(hashEnvValue('old-private-value'));
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(readFileSync(file)).toEqual(bytes); expect(statSync(file).mode).toBe(mode);
  });

  it('exposes identical envelopes through CLI JSON and the shared command', async () => {
    const f = fixture(); let output = '';
    const code = await runCli(['secrets', '--project', f.project.name, '--env', 'production', '--view', 'inventory', '--json'], {
      registry: f.registry, io: { writeOut: value => { output += value; }, writeErr: () => {},
        readStdin: async () => '', confirm: async () => false, stdinIsTTY: false },
    });
    expect(code).toBe(0); expect(JSON.parse(output)).toEqual(await f.read());
  });

  it('returns the same inventory through MCP structuredContent', async () => {
    const f = fixture();
    const server = new McpServer({ name: 'inventory', version: '1' });
    registerHvSecretsTools(createMcpCommandRegistrar(server), f.ctx);
    const client = new Client({ name: 'inventory-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try { expect((await client.callTool({ name: 'hv_secrets', arguments: f.input })).structuredContent).toEqual(await f.read()); }
    finally { await client.close(); await server.close(); }
  });

  it('keeps a local replacement separate from acceptance and pending rollout', async () => {
    const f = fixture({ ANTHROPIC_API_KEY: delegated }); accepted(f, { pending: true });
    writeFileSync(path.join(root, '.env.production'), 'ANTHROPIC_API_KEY=new-private-value\n');
    const result = await f.read(); const role = result.data.roles[0];
    expect(role.source.kind).toBe('unknown');
    expect(role.localCandidates[0]).toMatchObject({ comparisonToAccepted: 'different', selectedForDeploy: false });
    expect(role.rotation).toMatchObject({ acceptedUpdateAt: '2026-10-19T00:00:00Z', lastRotatedAt: null });
    expect(role.validation.result).toBe('unknown');
    expect(role.consumers[0]).toMatchObject({ configuration: { comparison: 'match' },
      activation: { state: 'pending', deploymentId: 'deployment-old' } });
    expect(role.nextAction).toContain('hv_ci_status');
    expect(role.nextAction).toContain('hv_ci_trigger');
    expect(role.nextAction).not.toContain('explicit replacement');
  });

  it('resumes the exact pending plan before considering another local replacement', async () => {
    const f = acceptedRole({ pendingWrite: true, pendingRollout: true });
    vi.stubEnv('ANTHROPIC_INPUT', 'new-local-candidate');
    const role = (await f.read()).data.roles.find((entry: any) => entry.id === 'role:document-extraction');
    expect(role.nextAction).toContain(`hv_apply planId="${operationId}"`);
    expect(role.nextAction).toContain('frozen replacement');
    expect(role.lifecycle.revocation).toBe('pending');
  });

  it('finishes the accepted rollout even when the source file has another replacement', async () => {
    const f = acceptedRole({ pendingRollout: true });
    vi.stubEnv('ANTHROPIC_INPUT', 'new-local-candidate');
    const role = (await f.read()).data.roles.find((entry: any) => entry.id === 'role:document-extraction');
    expect(role.nextAction).toContain('hv_ci_status');
    expect(role.nextAction).toContain('hv_status');
    expect(role.nextAction).not.toMatch(/intent="rotate"|explicit replacement/);
  });

  it.each([false, true])('guides a deployed accepted role to meaningful application verification; declared=%s', async verification => {
    const f = acceptedRole({ verification });
    const role = (await f.read()).data.roles.find((entry: any) => entry.id === 'role:document-extraction');
    expect(role.consumers[0].activation).toMatchObject({ state: 'replacement-deployed', allInstances: 'confirmed' });
    expect(role.applicationOperation.state).toBe('unknown');
    expect(role.nextAction).toContain('hv_health');
    expect(role.nextAction).toContain('credential="document-extraction"');
    if (!verification) expect(role.nextAction).toMatch(/hv_spec.*meaningful|meaningful.*hv_spec/);
    expect(role.nextAction).not.toContain('intent="rotate"');
  });

  it('keeps revocation pending when only current traffic is covered', async () => {
    const f = acceptedRole({ verification: true, coverage: 'traffic' });
    const role = (await f.read()).data.roles.find((entry: any) => entry.id === 'role:document-extraction');
    expect(role.consumers[0].activation.allInstances).toBe('unknown');
    expect(role.nextAction).toContain('hv_health');
    expect(role.nextAction).toMatch(/revocation.*pending/i);
    expect(role.nextAction).toContain('old-instance retirement');
  });

  it('inspects an unconfirmed second consumer before treating one deployed consumer as completion', async () => {
    const f = acceptedRole({ verification: true, secondConsumer: true });
    const role = (await f.read()).data.roles.find((entry: any) => entry.id === 'role:document-extraction');
    expect(role.consumers.map((consumer: any) => consumer.activation.state)).toEqual(['replacement-deployed', 'unknown']);
    expect(role.nextAction).toContain('hv_status');
    expect(role.nextAction).toMatch(/every.*consumer/);
    expect(role.nextAction).toMatch(/revocation.*pending/i);
    expect(role.nextAction).not.toContain('intent="rotate"');
  });

  it('does not promote provisional acceptance after a failed or uncertain write', async () => {
    const f = fixture({ ANTHROPIC_API_KEY: delegated }); accepted(f, { failed: true });
    const role = (await f.read()).data.roles[0];
    expect(role.rotation.acceptedUpdateAt).toBeNull();
    expect(role.consumers[0].configuration.comparison).toBe('unknown');
    expect(role.updates).toEqual([expect.objectContaining({ outcome: 'failure', writeOutcome: 'unknown' })]);
  });

  it('does not claim full activation when a later deployment succeeds and old instances may remain', async () => {
    const f = fixture({ ANTHROPIC_API_KEY: delegated }); accepted(f, { pending: true });
    f.observed.services[0].deployment.id = 'deployment-new';
    const role = (await f.read()).data.roles[0];
    expect(role.consumers[0].activation).toMatchObject({ state: 'replacement-deployed', deploymentId: 'deployment-new', allInstances: 'unknown' });
    expect(role.applicationOperation.state).toBe('unknown');
  });

  it.each(['project', 'environment', 'service', 'partial'])('does not attribute unrelated or partial %s observations', async mismatch => {
    const f = fixture({ ANTHROPIC_API_KEY: delegated }); accepted(f);
    if (mismatch === 'project') f.observed.projectId = 'wrong-account-project';
    if (mismatch === 'environment') f.observed.environmentId = 'wrong-sandbox';
    if (mismatch === 'service') f.observed.services[0].externalId = 'another-service';
    if (mismatch === 'partial') f.observed.partial = true;
    const role = (await f.read()).data.roles[0];
    expect(role.consumers[0].configuration.comparison).toBe('unknown');
    expect(role.identity.state).toBe('unknown');
  });

  it('keeps generated values out of files and reports generation without inferring a rotation date', async () => {
    const f = fixture({ SESSION_SECRET: { ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 2, environments: ['production'] } });
    expect((await f.read()).data.roles[0]).toMatchObject({ ownership: 'generated-secret', source: { kind: 'generator', generation: 2 },
      rotation: { lastRotatedAt: null, acceptedUpdateAt: null } });
  });

  it('groups only explicitly shared provider references and leaves equal local values independent', async () => {
    const f = fixture({}, { environments: { production: { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } },
      envVars: { FIRST_ALIAS: 'aws-secrets://app/production#PACKAGE_KEY', SECOND_ALIAS: 'aws-secrets://app/production#PACKAGE_KEY' } } } });
    writeFileSync(path.join(root, '.env'), 'FIRST_API_KEY=same-private-value\nSECOND_API_KEY=same-private-value\n');
    const roles = (await f.read()).data.roles;
    expect(roles.find((role: any) => role.ownership === 'provider-reference').aliases).toEqual(['FIRST_ALIAS', 'SECOND_ALIAS']);
    expect(roles.filter((role: any) => ['FIRST_API_KEY', 'SECOND_API_KEY'].includes(role.aliases[0]))).toHaveLength(2);
  });

  it('rejects mixed modes and missing environment before reads', async () => {
    const f = fixture();
    expect((await f.registry.execute('hv_secrets', { ...f.input, service: 'web' })).ok).toBe(false);
    expect((await f.registry.execute('hv_secrets', { project: f.project.name, view: 'inventory' })).ok).toBe(false);
    expect(PlanService.prototype.observeEnvironment).not.toHaveBeenCalled();
  });

  it('does not journal repository edits during inspection', async () => {
    const f = fixture(); writeFileSync(path.join(root, '.hypervibe/spec.json'), JSON.stringify({ ...f.spec, secrets: { NEW_KEY: delegated } }));
    const before = getDb().prepare('SELECT total_changes() AS n').get();
    expect((await f.read()).ok).toBe(false);
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(before);
  });

  it('does not interpret an unrelated provider absence as deletion', async () => {
    const f = fixture({ ANTHROPIC_API_KEY: delegated });
    f.observed.provider = 'other-provider'; f.observed.projectExists = false;
    expect((await f.read()).data.environmentState).toBe('unknown');
  });

  it('includes retained bound consumers still using a declared key', async () => {
    const f = fixture({ ANTHROPIC_API_KEY: delegated });
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 's1' }, legacy: { serviceId: 'old-worker' } } });
    f.observed.services.push({ ...f.observed.services[0], name: 'legacy', externalId: 'old-worker' });
    const consumers = (await f.read()).data.roles[0].consumers;
    expect(consumers).toContainEqual(expect.objectContaining({ service: 'legacy', serviceId: 'old-worker' }));
  });

  it('reports provider-only inputs as untracked without inferring a shared source across services', async () => {
    const f = fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 's1' }, legacy: { serviceId: 's2' } } });
    f.observed.services.push({ ...f.observed.services[0], name: 'legacy', externalId: 's2' });
    const roles = (await f.read()).data.roles;
    expect(roles).toHaveLength(2);
    expect(roles.every((role: any) => role.ownership === 'untracked-input' && role.consumers.length === 1)).toBe(true);
  });

  it('marks local control-plane candidates untracked when no connection has accepted them', async () => {
    const f = fixture(); writeFileSync(path.join(root, '.env'), 'NODE_AUTH_TOKEN=unaccepted-package-private\n');
    const roles = (await f.read()).data.roles;
    expect(roles).toContainEqual(expect.objectContaining({ aliases: ['NODE_AUTH_TOKEN'], ownership: 'untracked-input', consumers: [] }));
  });

  it('reports one package role across exact CI scopes while keeping API management separate', async () => {
    const f = fixture({}, { github: { enabled: true, repository: 'owner/inventory-app' } });
    const connection = f.ctx.repos.connections.create({ provider: 'github', scope: 'owner/inventory-app',
      credentialsEncrypted: f.ctx.secretStore.encryptObject({ apiToken: 'api-management-private', packageReadToken: 'package-read-private', login: 'owner' }) });
    f.ctx.repos.connections.updateStatus(connection.id, 'verified');
    writeFileSync(path.join(root, '.env'), 'NODE_AUTH_TOKEN=new-package-private\nHYPERVIBE_GITHUB_TOKEN=api-management-private\n');
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { ci: { deployBranch: { 'deploy.yml': {
      syncedEnvironmentSecrets: ['IMAGE_REGISTRY_TOKEN'], syncedEnvironmentSecretHashes: { IMAGE_REGISTRY_TOKEN: hashEnvValue('old-package-private') }, updatedAt: '2026-10-18T00:00:00Z',
    } } } });
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(init?.method).toBe('GET'); const url = new URL(String(input)); calls.push(url.pathname);
      if (url.pathname.endsWith('/environments')) return Response.json({ total_count: 1, environments: [{ id: 41, name: 'production' }] });
      if (url.pathname.endsWith('/production')) return Response.json({ id: 41, name: 'production' });
      return Response.json({ total_count: 1, secrets: [{ name: 'IMAGE_REGISTRY_TOKEN', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-18T00:00:00Z' }] });
    });
    const result = await f.read();
    const packages = result.data.roles.find((role: any) => role.source.credentialRole === 'packageReadToken');
    const api = result.data.roles.find((role: any) => role.source.credentialRole === 'apiToken');
    expect(packages.aliases).toEqual(['IMAGE_REGISTRY_TOKEN', 'NODE_AUTH_TOKEN']);
    expect(api.aliases).not.toContain('NODE_AUTH_TOKEN');
    expect(packages.localCandidates[0].comparisonToAccepted).toBe('different');
    expect(packages.consumers).toContainEqual(expect.objectContaining({ kind: 'github-actions', environment: 'production', repository: 'owner/inventory-app',
      configuration: expect.objectContaining({ presence: 'present', comparison: 'unknown', recordedValueComparison: 'different' }) }));
    expect(packages.consumers).toContainEqual(expect.objectContaining({ kind: 'container-pull', serviceId: 's1' }));
    expect(calls.some(route => route.includes('/actions/secrets'))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/api-management-private|package-read-private|new-package-private|old-package-private/);
  });

  it('does not invent CI consumers for a connection when no managed deployment is declared or recorded', async () => {
    const f = fixture();
    const connection = f.ctx.repos.connections.create({ provider: 'github', scope: 'owner/inventory-app',
      credentialsEncrypted: f.ctx.secretStore.encryptObject({ apiToken: 'api-private', packageReadToken: 'packages-private', login: 'owner' }) });
    f.ctx.repos.connections.updateStatus(connection.id, 'verified');
    const network = vi.spyOn(globalThis, 'fetch');
    const roles = (await f.read()).data.roles;
    expect(roles.flatMap((role: any) => role.consumers).filter((consumer: any) => consumer.kind === 'github-actions')).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps repository and environment aliases separate, including deleted destinations', async () => {
    const f = fixture({ NODE_AUTH_TOKEN: { ...delegated, environments: [], githubActions: { repository: true, environments: ['production', 'retired'] } } },
      { github: { enabled: true, repository: 'owner/inventory-app' } });
    const connection = f.ctx.repos.connections.create({ provider: 'github', scope: 'owner/inventory-app',
      credentialsEncrypted: f.ctx.secretStore.encryptObject({ apiToken: 'api-private' }) });
    f.ctx.repos.connections.updateStatus(connection.id, 'verified');
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { github: { delegatedActionsBindings: [
      { name: 'NODE_AUTH_TOKEN', target: 'repository', principal: 'application-owner', valueHash: hashEnvValue('accepted'), actionId: 'secret:github:repository:NODE_AUTH_TOKEN', syncedAt: '2026-10-18T00:00:00Z' },
    ] } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(init?.method).toBe('GET'); const url = new URL(String(input));
      if (url.pathname.endsWith('/environments')) return Response.json({ total_count: 1, environments: [{ id: 41, name: 'production' }] });
      if (url.pathname.endsWith('/production')) return Response.json({ id: 41, name: 'production' });
      return Response.json({ total_count: 1, secrets: [{ name: 'NODE_AUTH_TOKEN', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-18T00:00:00Z' }] });
    });
    const role = (await f.read()).data.roles[0];
    expect(role.consumers).toHaveLength(3);
    expect(role.consumers[0].configuration).toMatchObject({ presence: 'present', comparison: 'unknown', recordedSyncAt: '2026-10-18T00:00:00Z' });
    expect(role.consumers[1].configuration.recordedSyncAt).toBeUndefined();
    expect(role.consumers[2]).toMatchObject({ environment: 'retired', configuration: { scopeState: 'absent', presence: 'absent', comparison: 'unknown' } });
    expect(role.rotation.lastRotatedAt).toBeNull();
  });

  it('executes the real hosting observer without provider or local writes', async () => {
    const f = fixture();
    vi.mocked(PlanService.prototype.observeEnvironment).mockRestore();
    const provider = await railwayHttpFixture();
    provider.variables.set(`production-web/${productionId}`, { ANTHROPIC_API_KEY: 'old-private-value' });
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { projectId, environmentId: productionId,
      services: { web: { serviceId: 'production-web' } } });
    vi.spyOn(f.ctx.adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: provider.adapter });
    writeFileSync(path.join(root, '.env.production'), 'ANTHROPIC_API_KEY=new-private-value\n');
    const before = getDb().prepare('SELECT total_changes() AS n').get();
    const result = await f.read();
    expect(result.ok).toBe(true);
    expect(result.data.roles[0].consumers[0].configuration).toMatchObject({ presence: 'present', comparison: 'different' });
    expect(provider.requests.length).toBeGreaterThan(0); expect(provider.mutations).toEqual([]);
    expect(provider.contractErrors).toEqual([]);
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/old-private-value|new-private-value/);
  });
});
