import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../providers.js';
import { createCommandContext } from '../context.js';
import { CommandRegistry } from '../commands.js';
import { registerCoreTools } from '../../tools/core.tools.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { CloudScopePreparationRepository } from '../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { awsOperatorArtifactBoundary, AWS_OPERATOR_ARTIFACT_KINDS } from '../../adapters/providers/aws/__tests__/aws-operator-artifact.fixture.js';
import { gcpOperatorArtifactBoundary } from '../../adapters/providers/gcp/__tests__/gcp-operator-artifact.fixture.js';
import { entraNativeFixture } from '../../adapters/providers/entra/__tests__/entra-operator-application.fixture.js';
import { createEntraOperatorApplicationDriver } from '../../adapters/providers/entra/entra-operator-application.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { applyCloudInstallationV1, planCloudInstallationV1, reconcileCloudInstallationV1 } from '../../domain/services/cloud-installation-runtime.js';
import type { CloudInstallationRecord, OperatorArtifactIntent, OperatorApplicationIntent } from '../../domain/ports/cloud-installation.port.js';
import { hashEnvValue, type ObservedState } from '../../domain/ports/observe.port.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { executePlanApply } from '../apply-plan.js';
import { runCli } from '../../interfaces/cli/run.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpCommandRegistrar } from '../../interfaces/mcp/adapter.js';
import { deriveHypervibeSecretValues } from '../../domain/services/hypervibe-secret-value.js';
import { recordDelegatedSecretBindings } from '../../domain/services/delegated-secret.service.js';

// Counterexample from the live operator: a completed AWS template publication
// loses current readiness when its administrator session expires. Updating an
// existing GCP image does not require AWS installation authority. Exercise the
// real command/spec/plan and journals; AWS SDK/GAR transports are reconstructed
// native contracts and hosting observation is a synthetic provider-port fixture.
describe('existing immutable image update prerequisites', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'hv-image-update-'));
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  async function fixture() {
    const ctx = createCommandContext(), registry = new CommandRegistry(); registerCoreTools(registry, ctx);
    const project = ctx.repos.projects.create({ name: 'operator-image-update', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator.git' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'cloudrun', projectId: 'operator-project', environmentId: 'us-central1',
      services: { web: { serviceId: 'web-native' }, worker: { serviceId: 'worker-native' } },
    } });
    const connection = ctx.repos.connections.create({ provider: 'cloudrun', credentialsEncrypted: getSecretStore().encryptObject({ projectId: 'operator-project', credentials: '{}' }) });
    ctx.repos.connections.updateStatus(connection.id, 'verified');
    const aws = awsOperatorArtifactBoundary(), gcp = gcpOperatorArtifactBoundary({}, { appId: project.id, environment: environment.name });
    Object.assign(aws.intent, { appId: project.id, customerId: project.id });
    // Different installations own the unrelated template and selected image.
    gcp.intent.installationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const awsCreate = vi.spyOn(providerRegistry.getArtifactPublication('s3')!, 'create').mockResolvedValue(aws.input);
    const gcpCreate = vi.spyOn(providerRegistry.getArtifactPublication('cloudrun')!, 'create').mockResolvedValue(gcp.context);
    async function publish(name: string, native: typeof aws.input | typeof gcp.context, intent: OperatorArtifactIntent) {
      const capability = providerRegistry.getArtifactPublication(intent.artifactProvider)!;
      const store = new CloudScopePreparationRepository<CloudInstallationRecord<OperatorArtifactIntent>>({ projectId: project.id, environmentId: environment.id, environmentName: environment.name }, capability.parseRecord, { recordType: `operator-artifacts:${name}` });
      const input = { ...native, store };
      let record = await planCloudInstallationV1({ ...input, intent });
      record = await applyCloudInstallationV1({ ...input, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
      expect(record.status).toBe('scope-ready'); return { input, record };
    }
    const templates = await publish('templates', aws.input, aws.intent), image = await publish('candidate', gcp.context, gcp.intent);
    const imageUri = providerRegistry.getArtifactPublication('cloudrun')!.receipts(image.record)[0].image;
    const templateUrl = aws.capability.receipts(templates.record)[0].url;
    aws.setReadsDenied(true);
    const stale = await reconcileCloudInstallationV1({ ...templates.input, installationId: templates.record.installationId, planDigest: templates.record.plan.digest });
    expect(stale).toMatchObject({ status: 'blocked', reason: 'identity_mismatch' });
    expect(stale.attempts.every(attempt => attempt.status === 'succeeded')).toBe(true);
    expect(stale.completed['aws:operator-artifacts:target']).toBeUndefined();
    const spec = { version: 1, project: project.name, environments: { staging: {
      hosting: { provider: 'cloudrun' }, services: { web: { startCommand: 'node web.js', public: false }, worker: { startCommand: 'node worker.js', public: false, workloadKind: 'worker' } },
      envVars: { IMAGE_URI: imageUri, AWS_TEMPLATE_URL: templateUrl }, envFile: { mode: 'off' }, email: { enabled: false },
      operatorArtifacts: { templates: { provider: 's3', artifacts: AWS_OPERATOR_ARTIFACT_KINDS,
        nativeScope: { scopeKind: 's3-cloudformation-publication-v1', accountId: '123456789012', region: 'us-west-2' } } },
    } } };
    const store = new SpecStore(); store.replace(project, spec);
    const observed: ObservedState = { provider: 'cloudrun', observedAt: new Date().toISOString(), projectExists: true, projectId: 'operator-project', environmentId: 'us-central1',
      partial: false, warnings: [], databases: [], completeness: { project: 'complete', environment: 'complete', services: 'complete', databases: 'complete' },
      services: ['web', 'worker'].map(name => ({ name, externalId: `${name}-native`, workloadKind: name === 'worker' ? 'worker' : 'web',
        config: { startCommand: `node ${name}.js`, public: false }, sourceState: 'disconnected', envVarKeys: ['AWS_TEMPLATE_URL'], envVarHashes: { AWS_TEMPLATE_URL: hashEnvValue(templateUrl) }, customDomains: [], status: 'running' })) };
    const observe = vi.fn(async () => observed), identity = vi.fn(async () => ({ state: 'ready' as const })), deploy = vi.fn();
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { name: 'cloudrun', capabilities: { supportsObserve: true }, observe, deploy,
      runtimeIdentities: { inspect: identity, apply: vi.fn() } } as never });
    awsCreate.mockClear(); gcpCreate.mockClear(); aws.requests.length = 0; gcp.requests.length = 0;
    const journalBefore = JSON.stringify(ctx.repos.runs.findById(templates.record.installationId)!.plan);
    const plan = (extra = {}) => registry.get('hv_plan')!.execute({ project: project.name, env: 'staging', services: ['web', 'worker'], includeEnvFile: false, ...extra });
    const change = (edit: (value: NonNullable<ReturnType<SpecStore['get']>>['spec']) => void) => {
      const next = structuredClone(store.get(project)!.spec); edit(next); store.replace(project, next);
    };
    return { ctx, registry, project, environment, store, observed, observe, identity, deploy, aws, gcp, awsCreate, gcpCreate, templates, image, imageUri, journalBefore, plan, change };
  }
  it.each(['command', 'cli', 'mcp'])('reviews a GCP image update through %s without reading or repairing completed AWS publication state', async transport => {
    const f = await fixture(), args = { project: f.project.name, env: 'staging', services: ['web', 'worker'], includeEnvFile: false };
    let result: Awaited<ReturnType<typeof f.plan>>;
    if (transport === 'cli') {
      let output = '';
      await runCli(['plan', '--input', '-', '--json'], { registry: f.registry, initialize: false, io: {
        readStdin: async () => JSON.stringify(args), writeOut: value => { output += value; }, writeErr: () => {}, confirm: async () => false, stdinIsTTY: false,
      } }); result = JSON.parse(output);
    } else if (transport === 'mcp') {
      const server = new McpServer({ name: 'image-update', version: '1' }); registerCoreTools(createMcpCommandRegistrar(server), f.ctx);
      const client = new Client({ name: 'image-update', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(a), server.connect(b)]);
      try { result = (await client.callTool({ name: 'hv_plan', arguments: args })).structuredContent as unknown as typeof result; }
      finally { await client.close(); await server.close(); }
    } else result = await f.plan();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ scope: 'full', blocked: [] });
    expect((result.data as { actions: Array<{ id: string; type: string }> }).actions.map(action => action.id)).toEqual(['service:web', 'service:worker']);
    expect(f.awsCreate).not.toHaveBeenCalled(); expect(f.aws.requests).toEqual([]);
    expect(JSON.stringify(f.ctx.repos.runs.findById(f.templates.record.installationId)!.plan)).toBe(f.journalBefore);
    expect(f.gcpCreate).toHaveBeenCalled(); expect(f.observe).toHaveBeenCalled();
  });
  it.each(['unpublished-image', 'mutable-image', 'derived-image-alias', 'native-image-denied', 'unknown-workload', 'unknown-runtime-identity', 'waiting-runtime-identity', 'changed-runtime', 'changed-template-url', 'changed-reference'] as const)('blocks %s without using AWS authority', async variant => {
    const f = await fixture();
    if (variant === 'unpublished-image') f.change(spec => { spec.environments.staging.envVars.IMAGE_URI = f.imageUri.replace(/d{64}$/, '9'.repeat(64)); });
    if (variant === 'mutable-image') f.change(spec => { spec.environments.staging.envVars.IMAGE_URI = f.imageUri.split('@')[0] + ':latest'; });
    if (variant === 'derived-image-alias') f.change(spec => {
      spec.environments.staging = projectSpecSchema.parse({ ...spec, environments: { staging: { ...spec.environments.staging,
        database: { provider: 'cloudsql', engine: 'postgres' } } } }).environments.staging;
      spec.environments.staging.services.web.databaseEnvAliases = { IMAGE_URI_WEB: 'DATABASE_URL' };
    });
    if (variant === 'native-image-denied') f.gcp.options.denied = true;
    if (variant === 'unknown-workload') { f.observed.partial = true; f.observed.completeness!.services = 'unknown'; f.observed.services = []; }
    if (variant === 'unknown-runtime-identity' || variant === 'waiting-runtime-identity') f.identity.mockResolvedValue({ state: variant === 'unknown-runtime-identity' ? 'unknown' : 'waiting', reason: 'Synthetic required workload authority is unavailable' } as never);
    if (variant === 'changed-runtime') f.change(spec => { spec.environments.staging.services.web.startCommand = 'node different.js'; });
    if (variant === 'changed-template-url') f.change(spec => { spec.environments.staging.envVars.AWS_TEMPLATE_URL = 'https://other.example.test/template'; });
    if (variant === 'changed-reference') f.change(spec => {
      spec.secrets.API_TOKEN = { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'], required: true, driftPolicy: 'preserve' };
      spec.environments.staging.secretDestinations = { API_TOKEN: { destination: { provider: 'gcp-secret-manager', projectId: 'operator-project', projectNumber: '123456789012', secretId: 'api-token' }, version: '4' } };
    });
    const result = await f.plan();
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(f.awsCreate).not.toHaveBeenCalled(); expect(f.aws.requests).toEqual([]);
    expect(JSON.stringify(f.ctx.repos.runs.findById(f.templates.record.installationId)!.plan)).toBe(f.journalBefore);
  });
  it.each([{ envVars: { IMAGE_URI: 'registry.example/app:latest' } }, { envFile: '/does-not-exist' }])('rejects ambiguous runtime input %j before setup reads', async input => {
    const f = await fixture(), result = await f.plan(input);
    expect(result.ok).toBe(false); expect(f.awsCreate).not.toHaveBeenCalled(); expect(f.gcpCreate).not.toHaveBeenCalled();
  });
  it('revalidates the selected native image at apply before any workload effect', async () => {
    const f = await fixture(), result = await f.plan(); expect(result.ok).toBe(true);
    const planId = (result.data as { planId: string }).planId;
    f.gcp.options.denied = true; f.observe.mockClear();
    const current = f.store.get(f.project)!;
    const applied = await executePlanApply(f.ctx, { project: f.project, spec: current.spec, specRevision: current.revision, planId, confirmActions: ['service:web', 'service:worker'] });
    expect(applied).toMatchObject({ kind: 'blocked' }); expect(f.observe).not.toHaveBeenCalled();
    expect(f.awsCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(f.ctx.repos.runs.findById(f.templates.record.installationId)!.plan)).toBe(f.journalBefore);
  });
  it('blocks a changed selected workload at apply without deploying or rewriting setup history', async () => {
    const f = await fixture(), result = await f.plan(); expect(result.ok).toBe(true);
    f.observed.services[0].externalId = 'replacement-web';
    const current = f.store.get(f.project)!;
    const applied = await executePlanApply(f.ctx, { project: f.project, spec: current.spec, specRevision: current.revision,
      planId: (result.data as { planId: string }).planId, confirmActions: ['service:web', 'service:worker'] });
    expect(applied).toMatchObject({ kind: 'executed', result: { success: false } }); expect(f.deploy).not.toHaveBeenCalled();
    expect(f.awsCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(f.ctx.repos.runs.findById(f.templates.record.installationId)!.plan)).toBe(f.journalBefore);
  });
  it.each([false, true])('preserves accepted generated runtime values while unknown live hash=%s fails closed', async unknown => {
    const f = await fixture();
    f.change(spec => Object.assign(spec, projectSpecSchema.parse({ ...spec, secrets: { SESSION_SECRET: {
      ownership: 'hypervibe', generator: 'random-base64url-32-v1', generation: 1, environments: ['staging'],
    } } })));
    const current = f.store.get(f.project)!, values = deriveHypervibeSecretValues(current.spec, f.environment.name);
    recordDelegatedSecretBindings({ environment: f.environment, spec: current.spec, environmentName: f.environment.name,
      suppliedValues: values, applyRunId: 'historical-accepted-apply', receipts: [{ actionId: 'secret:SESSION_SECRET', status: 'succeeded', message: 'Synthetic accepted legacy runtime value' }] });
    for (const service of f.observed.services) {
      service.envVarKeys.push('SESSION_SECRET');
      if (!unknown) service.envVarHashes.SESSION_SECRET = hashEnvValue(values.SESSION_SECRET);
    }
    const before = f.ctx.repos.environments.findById(f.environment.id)!.platformBindings;
    const result = await f.plan(); expect(result.ok, JSON.stringify(result)).toBe(!unknown);
    expect(f.ctx.repos.environments.findById(f.environment.id)!.platformBindings).toEqual(before);
    if (result.ok) {
      const saved = f.ctx.repos.runs.findById((result.data as { planId: string }).planId)!.plan;
      expect(saved).toMatchObject({ overrides: { services: ['web', 'worker'], operatorImageUpdate: true } });
      expect((saved as { overrides: unknown }).overrides).not.toHaveProperty('delegatedSecretVarsEncrypted');
      expect(JSON.stringify(result)).not.toContain(values.SESSION_SECRET);
      expect(JSON.stringify(saved)).not.toContain(values.SESSION_SECRET);
    }
  });
  it('preserves the existing create path when a selected workload is not bound', async () => {
    const f = await fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { services: { web: { serviceId: 'web-native' } } });
    const result = await f.plan();
    expect(result.data).toMatchObject({ scope: 'operator-artifacts' });
    expect(f.awsCreate).toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
  });
  it.each([
    ['ecs', '123456789012.dkr.ecr.us-west-2.amazonaws.com/app'],
    ['azure-container-apps', 'example.azurecr.io/app'],
    ['cloudrun', 'registry.example/app'], ['cloudrun', 'branch-build'],
  ])('preserves the ordinary %s partial-deploy path for %s', async (provider, target) => {
    const f = await fixture();
    f.ctx.repos.environments.updatePlatformBindings(f.environment.id, { provider });
    f.change(spec => {
      spec.environments.staging.hosting.provider = provider;
      if (target === 'branch-build') delete spec.environments.staging.envVars.IMAGE_URI;
      else spec.environments.staging.envVars.IMAGE_URI = `${target}@sha256:${'b'.repeat(64)}`;
    });
    // The historical AWS unknown read still belongs to ordinary full planning;
    // no invented operator-image receipt requirement preempts that contract.
    const result = await f.plan();
    expect(result.data).toMatchObject({ scope: 'operator-artifacts' });
    expect(f.awsCreate).toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
  });
  it.each([false, true])('preserves registration history and blocks unfinished native registration=%s', async unfinished => {
    const f = await fixture(), options: Parameters<typeof entraNativeFixture>[0] = unfinished ? { lost: 'federation' } : {};
    const native = entraNativeFixture(options), driver = createEntraOperatorApplicationDriver({ fetch: native.request });
    const capability = providerRegistry.getOperatorApplication('microsoft-entra')!;
    const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', appId: f.project.id, customerId: f.project.id,
      environment: f.environment.name, source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) },
      provider: 'microsoft-entra', applicationProvider: 'microsoft-entra', execution: { kind: 'operator-application', authentication: 'local-operator' },
      mode: 'connect', stage: 'scope-preparation', keys: [], nativeScope: { tenantId: native.tenantId, name: 'azure', origin: 'https://operator.example.test',
        googleSubject: '123456789012345678901', googleServiceAccount: 'runtime@owned-project.iam.gserviceaccount.com' } };
    const store = new CloudScopePreparationRepository<CloudInstallationRecord<OperatorApplicationIntent>>({ projectId: f.project.id, environmentId: f.environment.id, environmentName: f.environment.name }, capability.parseRecord, { recordType: 'operator-applications:azure' });
    const context = { driver, store, authorize: async () => true, authentication: { kind: 'operator-application' as const, administrator: { getAccessToken: async () => 'synthetic-transient-graph-token' } } };
    let record = await planCloudInstallationV1({ ...context, intent });
    record = await applyCloudInstallationV1({ ...context, installationId: record.installationId, planDigest: record.plan.digest, confirmActions: record.plan.actions.map(action => action.id) });
    options.denied = true;
    record = await reconcileCloudInstallationV1({ ...context, installationId: record.installationId, planDigest: record.plan.digest });
    expect(record.status).not.toBe('scope-ready');
    const before = JSON.stringify(f.ctx.repos.runs.findById(record.installationId)!.plan);
    const create = vi.spyOn(capability, 'create').mockRejectedValue(new Error('Registration authority is unavailable'));
    const result = await f.plan();
    expect(result.ok, JSON.stringify(result)).toBe(!unfinished);
    expect(create).not.toHaveBeenCalled();
    expect(JSON.stringify(f.ctx.repos.runs.findById(record.installationId)!.plan)).toBe(before);
  });
});
