import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../../../application/context.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { OperatorCredentialCustody } from '../operator-credential-custody.js';
import { withOperatorOutputDelivery } from '../operator-output-delivery.js';
import { assertReadySecretContainers } from '../secret-container-setup.js';
import { SpecStore } from '../../spec/spec.store.js';
import type { CloudInstallationDriver, OperatorApplicationIntent } from '../../ports/cloud-installation.port.js';
import { createGcpOperatorOutputClient } from '../../../adapters/providers/gcp/gcp-operator-output.js';
import { CloudScopePreparationRepository } from '../../../adapters/db/repositories/cloud-scope-preparation.repository.js';
import { applyCloudInstallationV1, parseCloudInstallationRecordV1, planCloudInstallationV1, reviewCloudInstallationRetryV1 } from '../cloud-installation-runtime.js';
vi.mock('../secret-container-setup.js', () => ({ assertReadySecretContainers: vi.fn() }));

describe('operator output delivery custody', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-operator-output-')); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  async function fixture(outcome: 'delivered' | 'unknown' | 'forbidden-once') {
    const ctx = createCommandContext(), project = ctx.repos.projects.create({ name: 'operator', defaultPlatform: 'cloudrun', gitRemoteUrl: 'https://github.com/acme/operator' });
    const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { provider: 'cloudrun' } });
    const destination = { provider: 'gcp-secret-manager' as const, projectId: 'operator-test', projectNumber: '123456789012', secretId: 'operator-output' };
    const binding = { destination, owner: { repository: 'github.com/acme/operator', environment: 'test', key: 'APP_PRIVATE_KEY' }, attemptId: randomUUID(),
      state: 'ready' as const, resource: 'projects/123456789012/secrets/operator-output', createTime: '2026-10-27T00:00:00Z' };
    const intent: OperatorApplicationIntent = { schemaVersion: 1, installationId: randomUUID(), customerId: project.id, appId: project.id, environment: 'test',
      source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) }, provider: 'github-app', applicationProvider: 'github-app',
      mode: 'connect', stage: 'scope-preparation', keys: [], execution: { kind: 'operator-application', authentication: 'local-operator' }, nativeScope: { name: 'github' },
      outputs: { hostingProvider: 'cloudrun', destinations: [{ role: 'private-key', key: 'APP_PRIVATE_KEY', binding }] } };
    vi.spyOn(SpecStore.prototype, 'getForInspection').mockReturnValue({ spec: { environments: { test: { hosting: { provider: 'cloudrun' } } } } } as any);
    vi.mocked(assertReadySecretContainers).mockResolvedValue({ APP_PRIVATE_KEY: binding });
    const reference = { destination, version: '1' }, deliver = vi.fn(); let written = false;
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudresourcemanager.googleapis.com') return Response.json({ name: 'projects/123456789012', projectId: 'operator-test', state: 'ACTIVE' });
      if (url.pathname.endsWith(':addVersion')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ payload: { data: Buffer.from('synthetic-private-output-value').toString('base64') } });
        deliver();
        if (outcome === 'forbidden-once' && deliver.mock.calls.length === 1) return new Response('synthetic-private-output-value', { status: 403 });
        written = true;
        if (outcome === 'unknown') throw new Error('synthetic lost acknowledgement');
        return Response.json({ name: `${binding.resource}/versions/1`, state: 'ENABLED' });
      }
      if (url.pathname.endsWith('/versions/1')) return Response.json({ name: `${binding.resource}/versions/1`, state: 'ENABLED' });
      if (url.pathname.endsWith('/versions')) return Response.json(written ? { versions: [{ name: `${binding.resource}/versions/1` }] } : {});
      return Response.json({ name: binding.resource });
    };
    vi.spyOn(providerRegistry, 'getOperatorOutputDelivery').mockReturnValue({ schemaVersion: 1, providers: ['gcp-secret-manager'],
      review: () => ({ permissions: ['secretmanager.versions.add'], cost: 'Synthetic reviewed cost', pricingUrl: 'https://cloud.google.com/secret-manager/pricing' }), create: async () => ({
      ...createGcpOperatorOutputClient(binding, { token: async () => 'synthetic-transient-token', request }),
    }) });
    const local = { projectId: project.id, environmentId: environment.id, installationId: intent.installationId, intentDigest: canonicalJsonSha256(intent) };
    const store = new OperatorCredentialCustody({ ...local, provider: 'github-app' });
    store.storeCredentials(null, { 'private-key': 'synthetic-private-output-value' }, { appId: '123' });
    const native = { provider: 'github-app', operatorApplication: { providerName: 'github-app' },
      scopePreparation: { resolvedScope: (record: any) => record.intent.nativeScope, reviewResources: () => [] },
      parseScope: (value: unknown) => value, connections: () => [],
      plan: async () => ({ actions: [], review: { permissions: [], costs: [], warnings: [] } }),
      parseAction: () => { throw new Error('not native'); }, parseEvidence: () => { throw new Error('not native'); },
    } as unknown as CloudInstallationDriver<OperatorApplicationIntent>;
    const driver = withOperatorOutputDelivery(native, local), context = { intent, authentication: { kind: 'operator-application' as const }, signal: AbortSignal.timeout(10_000), completed: {}, beforeMutation: async () => {} };
    const plan = await driver.plan(context), action = plan.actions[0], now = new Date().toISOString();
    const attempt = { id: randomUUID(), actionId: action.id, status: 'attempted' as const, startedAt: now, updatedAt: now };
    const journal = new CloudScopePreparationRepository({ projectId: project.id, environmentId: environment.id, environmentName: 'test' },
      value => parseCloudInstallationRecordV1(value, driver), { recordType: 'operator-applications:github' });
    return { driver, context, action, attempt, store, journal, deliver, reference };
  }
  it('admits separate exact-confirmation output actions through the real persisted lifecycle parser', async () => {
    const f = await fixture('delivered');
    const plan = await planCloudInstallationV1({ ...f.context, driver: f.driver, store: f.journal, authorize: async () => true });
    expect(plan.plan.actions).toEqual([f.action]); expect(plan.plan.actions[0]).toMatchObject({ requiresConfirm: true, dataBearing: true, billable: true });
    const applied = await applyCloudInstallationV1({ driver: f.driver, store: f.journal, authentication: f.context.authentication, authorize: async () => true,
      installationId: plan.installationId, planDigest: plan.plan.digest, confirmActions: [f.action.id] });
    expect(applied.status).toBe('scope-ready'); expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(applied)).not.toContain('synthetic-private-output-value');
  });
  it('delivers once, persists only immutable receipts publicly and erases private custody after acknowledgement', async () => {
    const f = await fixture('delivered'), result = await f.driver.mutate({ ...f.context, action: f.action, attempt: f.attempt });
    expect(result.state).toBe('acknowledged'); expect(JSON.stringify(result)).not.toContain('synthetic-private-output-value');
    expect(f.store.read()!.state).toMatchObject({ phase: 'delivered', deliveries: { APP_PRIVATE_KEY: { reference: f.reference } } });
    expect(f.store.read()!.state).not.toHaveProperty('credentials');
    expect((await f.driver.recover({ ...f.context, action: f.action, attempt: f.attempt })).state).toBe('satisfied');
    await f.driver.mutate({ ...f.context, action: f.action, attempt: f.attempt }); expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it('retains an uncertain write across restart and cannot use a new attempt to replay it', async () => {
    const f = await fixture('unknown');
    expect((await f.driver.mutate({ ...f.context, action: f.action, attempt: f.attempt })).state).toBe('uncertain');
    SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    expect((await f.driver.recover({ ...f.context, action: f.action, attempt: f.attempt })).state).toBe('unknown');
    await f.driver.mutate({ ...f.context, action: f.action, attempt: { ...f.attempt, id: randomUUID() } });
    expect(f.deliver).toHaveBeenCalledTimes(1); expect(f.store.read()!.state).toMatchObject({ phase: 'credentials-stored', deliveries: { APP_PRIVATE_KEY: { status: 'uncertain' } } });
  });
  it('finishes private erasure after a lost local acknowledgement without another native write', async () => {
    const f = await fixture('delivered');
    vi.spyOn(OperatorCredentialCustody.prototype, 'eraseDeliveredCredentials').mockReturnValueOnce(null);
    await f.driver.mutate({ ...f.context, action: f.action, attempt: f.attempt });
    expect(f.store.read()!.state.phase).toBe('credentials-stored');
    expect((await f.driver.recover({ ...f.context, action: f.action, attempt: f.attempt })).state).toBe('satisfied');
    expect(f.store.read()!.state.phase).toBe('delivered'); expect(f.deliver).toHaveBeenCalledTimes(1);
  });
  it('retries a definite native rejection only through the exact retained retry review', async () => {
    const f = await fixture('forbidden-once'), target = { driver: f.driver, store: f.journal, authentication: f.context.authentication, authorize: async () => true };
    const plan = await planCloudInstallationV1({ ...target, intent: f.context.intent });
    const request = { ...target, installationId: plan.installationId, planDigest: plan.plan.digest, confirmActions: [f.action.id] };
    const rejected = await applyCloudInstallationV1(request); expect(rejected.attempts[0].status).toBe('rejected');
    await applyCloudInstallationV1(request); expect(f.deliver).toHaveBeenCalledTimes(1);
    const review = await reviewCloudInstallationRetryV1(request);
    const completed = await applyCloudInstallationV1({ ...request, retryActions: review.retryActions });
    expect(completed.status).toBe('scope-ready'); expect(completed.attempts.map(item => item.status)).toEqual(['rejected', 'succeeded']);
    expect(f.deliver).toHaveBeenCalledTimes(2); expect(JSON.stringify(completed)).not.toContain('synthetic-private-output-value');
  });
});
