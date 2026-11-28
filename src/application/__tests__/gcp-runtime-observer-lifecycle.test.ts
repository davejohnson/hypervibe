import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SecretStore } from '../../adapters/secrets/secret-store.js';
import { OpenTofuEngine } from '../../adapters/engine/opentofu/engine.js';
import * as install from '../../adapters/engine/opentofu/install.js';
import { CloudRunAdapter } from '../../adapters/providers/gcp/cloudrun.adapter.js';
import * as preparation from '../../domain/services/cloud-prepare.execute.js';
import * as shared from '../../domain/services/gcp-project-setup.service.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { ConvergeExecutor, planRunDocumentSchema } from '../../domain/plan/converge.executor.js';
import { createCommandContext } from '../context.js';
import { applyInfrastructureEngine, planInfrastructureEngine } from '../infrastructure-engine.js';
import { CLOUD_PREPARE_PROFILES, QUEUE_PREPARE_ADDON } from '../../domain/services/cloud-prepare.js';
import type { EngineConfiguration } from '../../domain/ports/infrastructure-engine.port.js';

let dir: string;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  rmSync(dir, { recursive: true, force: true });
});

it('reviews the applied Pub/Sub resource in the normal saved infrastructure plan, applies only its exact monitoring approval, then converges', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hv-gcp-obs-lifecycle-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', dir); SecretStore.resetInstance(); SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(dir, 'state.db')).migrate();
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'example-app', defaultPlatform: 'cloudrun' });
  project.gitRemoteUrl = 'https://github.com/example/app';
  const profile = CLOUD_PREPARE_PROFILES.cloudrun;
  ctx.repos.projects.updatePolicies(project.id, () => ({ cloudPreparation: { cloudrun: {
    provider: 'cloudrun', version: profile.version, preparedAt: new Date().toISOString(),
    requiredApis: [...profile.requiredApis, ...QUEUE_PREPARE_ADDON.requiredApis], requiredRoles: [...profile.requiredRoles, ...QUEUE_PREPARE_ADDON.requiredRoles],
  } } }));
  const gcpProjectId = 'sample-google-project';
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: {
    provider: 'cloudrun', projectId: gcpProjectId, environmentId: 'us-central1', services: {}, engine: { kind: 'opentofu', queues: ['mail'] },
  } });
  const conn = ctx.repos.connections.create({ provider: 'cloudrun', scope: 'example/app', credentialsEncrypted: ctx.secretStore.encryptObject({
    projectId: gcpProjectId, runtimeServiceAccountEmail: 'runtime@sample-google-project.iam.gserviceaccount.com',
    credentials: JSON.stringify({ type: 'service_account', private_key: 'test', client_email: 'deploy@sample-google-project.iam.gserviceaccount.com' }),
  }) });
  ctx.repos.connections.updateStatus(conn.id, 'verified');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { test: {
    hosting: { provider: 'cloudrun', region: 'us-central1' }, services: {}, queues: { mail: {} }, runtimeObservation: { branch: 'main' },
  } } });
  const input = { project, environmentName: 'test', spec, specRevision: 1 };
  vi.spyOn(CloudRunAdapter.prototype, 'engineAccessToken').mockResolvedValue('synthetic-read');
  vi.spyOn(preparation, 'getDefaultAdminAccessToken').mockResolvedValue('synthetic-owner');
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') throw new Error('Unexpected provider write');
    return input.includes('/secrets?') ? Response.json({ secrets: [] }) : new Response(null, { status: 404 });
  }));
  vi.spyOn(install, 'ensureEngineBinary').mockResolvedValue({ ok: true, binary: '/not-executed' });
  vi.spyOn(install, 'enginePluginCacheDir').mockReturnValue(dir);
  const segment = { id: 'env', engine: 'opentofu' as const, planDigest: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), engineVersion: '1.13.9', providerVersions: { google: '8.9.0' } };
  let settled = false;
  vi.spyOn(OpenTofuEngine.prototype, 'plan').mockImplementation(async ({ configuration }) => ({ ok: true, segmentId: segment.id, segment,
    planFile: '/not-executed', blockers: [], unmanagedDeletes: [],
    actions: Object.entries(configuration.resources).filter(([, r], index, entries) => entries.findIndex(([, item]) => item.actionId === r.actionId) === index).map(([address, r]) => ({ id: r.actionId, type: settled ? 'noop' : 'create',
      resource: { kind: r.kind, name: r.name, provider: 'gcp' }, reason: 'Observed environment resource', verified: true,
      metadata: { engineSegment: { ...segment, addresses: [address] } } })),
  }));
  const setupPlanId = 'setup-00000000-0000-4000-8000-000000000001';
  let previous: EngineConfiguration | undefined;
  vi.spyOn(shared, 'getGcpProjectSetupContribution').mockImplementation((_p, _g, key) => key.startsWith('observer_') ? previous : undefined);
  const setup = vi.spyOn(shared, 'runGcpProjectSetup').mockImplementation(async (p) => {
    expect(p.runtimeObservationAccess?.join(' ')).toContain('queue mail');
    if (p.confirm) {
      expect(p.gcpSetupPlanId).toBe(setupPlanId);
      previous = p.contribution.configuration;
    }
    return { success: true, mode: p.confirm ? 'confirm' : 'preview', planId: setupPlanId, actions: [] };
  });
  const first = await planInfrastructureEngine(ctx, input);
  if ('blocked' in first) throw Error(first.blocked.join(' '));
  expect(first.warnings.join(' ')).toContain('After the infrastructure settles');
  expect(setup).not.toHaveBeenCalled();
  settled = true;
  const plan = await planInfrastructureEngine(ctx, input);
  if ('blocked' in plan) throw Error(plan.blocked.join(' '));
  const actionId = 'gcp-monitoring:' + setupPlanId;
  expect(plan.confirmActions).toEqual([actionId]);
  expect(plan.actions.find(action => action.id === actionId)?.reason).toContain('queue mail');
  const loaded = new ConvergeExecutor().loadPlan(plan.planRunId);
  if ('error' in loaded) throw Error(loaded.error);
  expect(planRunDocumentSchema.safeParse({ ...loaded.document, actions: loaded.document.actions.map(a => a.id === actionId ? { ...a, requiresConfirm: false } : a) }).success).toBe(false);
  expect((await applyInfrastructureEngine(ctx, { ...input, planId: plan.planRunId, confirmActions: [] }))).toMatchObject({ kind: 'executed' });
  expect(previous).toBeUndefined();
  const approved = await applyInfrastructureEngine(ctx, { ...input, planId: plan.planRunId, confirmActions: [actionId] });
  expect(approved, JSON.stringify(approved)).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(ctx.repos.environments.findById(environment.id)?.platformBindings.runtimeObserver).toBeNull();
  expect(JSON.stringify(previous)).toContain('subscription/oldest_unacked_message_age_by_region');
  const after = await planInfrastructureEngine(ctx, input);
  if ('blocked' in after) throw Error(after.blocked.join(' '));
  expect(after.actions.every(a => a.type === 'noop')).toBe(true);
});
