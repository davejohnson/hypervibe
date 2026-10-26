import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { planDatabasePasswordRotation } from '../../domain/services/database-password-rotation.service.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import type { PlanRunDocument } from '../../domain/plan/converge.executor.js';
import '../providers.js';

// Real persistence and authenticated encryption enforce the user contract that
// a saved plan authorizes only its exact reviewed actions. Provider behavior is
// synthetic here; SQL and provider transport compatibility have separate tests.
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-rotation-authority-'));
  SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'state.db'));
});
afterEach(() => {
  vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true });
});

async function fixture(generated = false, runtime = true) {
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'authority-fixture', defaultPlatform: 'railway' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId: 'provider-project', environmentId: 'provider-environment', services: { web: { serviceId: 'provider-web' } },
  } });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'provider-database', bindings: {
    provider: 'railway', providerScope: { projectId: 'provider-project', environmentId: 'provider-environment' },
    username: 'app', database: 'railway', password: 'old', connectionString: 'postgresql://app:old@database.internal/railway',
  } });
  const source = path.join(directory, 'replacement'); writeFileSync(source, 'raw-secret', { mode: 0o600 });
  let stored = new SpecStore().replace(project, { version: 1, project: project.name,
    secrets: { DATABASE_ROTATION_INPUT: { ownership: 'delegated', principal: 'user:owner', environments: [], credential: {
      role: 'database-login', label: 'Database login', purpose: 'Rotate authentication', kind: 'database-password',
      ...(generated ? { rotationGeneration: 1 } : { source: `file:${source}` }),
      database: { environment: 'production', component: component.id, username: 'app', database: 'railway', applicationDriver: 'node-postgres' },
    } } },
    environments: { production: { hosting: { provider: 'railway' }, database: { provider: 'railway', engine: 'postgres' },
      envFile: { mode: 'off' }, services: { web: { databaseEnvAliases: { POSTGRES_DB_URL: 'DATABASE_URL' } } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } } },
  });
  const target = { provider: 'railway', componentId: component.id, environmentId: environment.id, externalId: component.externalId,
    providerScope: component.bindings.providerScope, username: 'app', database: 'railway', inputMode: 'supplied',
    connection: { host: 'database.internal', port: 5432, username: 'app', database: 'railway' } };
  const lifecycle = {
    inspect: vi.fn(async () => target), readCurrent: vi.fn(async () => null), probe: vi.fn(async () => ({ state: 'rejected', tested: 'synthetic' })),
    rotate: vi.fn(async () => ({ state: 'unknown' })), configuration: {
      inspect: vi.fn(async () => ({ issuerNames: ['POSTGRES_PASSWORD'], consumers: [{ service: 'web', externalId: 'provider-web', envVarHashes: { DATABASE_URL: 'a'.repeat(64), POSTGRES_DB_URL: 'a'.repeat(64) } }] })),
      observe: vi.fn(async () => ({ issuer: 'different', references: 'match' })), synchronize: vi.fn(async () => ({ state: 'unknown' })),
      verifyAuthentication: vi.fn(async () => ({ state: 'unknown', tested: 'synthetic' })),
    },
  };
  if (runtime) (lifecycle as any).runtimeConfiguration = lifecycle.configuration;
  vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: { name: 'railway', credentialLifecycle: lifecycle } as any });
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: { provider: 'railway', projectExists: true,
    projectId: 'provider-project', environmentId: 'provider-environment', environmentName: 'production', databases: [],
    services: [{ name: 'web', externalId: 'provider-web', status: 'running', envVarKeys: [], envVarHashes: {},
      deployment: { state: 'present', id: 'old-deployment', status: 'SUCCESS', activeDeploymentIds: ['old-deployment'] } }],
  } } as any);
  const plan = async (generation?: number) => {
    if (generation) stored = new SpecStore().replace(project, { ...stored.spec, secrets: {
      ...stored.spec.secrets, DATABASE_ROTATION_INPUT: { ...stored.spec.secrets.DATABASE_ROTATION_INPUT,
        credential: { ...stored.spec.secrets.DATABASE_ROTATION_INPUT.credential!, rotationGeneration: generation },
      },
    } });
    const result = await planDatabasePasswordRotation({ project, spec: stored.spec, revision: stored.revision,
      environmentName: 'production', intent: 'rotate', descriptor: stored.spec.secrets.DATABASE_ROTATION_INPUT.credential! });
    if ('error' in result) throw new Error(result.error);
    return result;
  };
  const apply = (id: string, confirmations: string[]) => executePlanApply(ctx, { project, spec: stored.spec, specRevision: stored.revision, planId: id, confirmActions: confirmations });
  const document = (id: string) => structuredClone(ctx.repos.runs.findById(id)!.plan) as unknown as PlanRunDocument;
  return { ctx, lifecycle, plan, apply, document, environment, component };
}

it.each(['drop-final-verification', 'issuer-metadata', 'target-metadata', 'environment-locks'] as const)(
  'rejects %s tampering against the retained encrypted review before provider mutation', async change => {
    const f = await fixture(), plan = await f.plan();
    const document = f.document(plan.planRunId);
    if (change === 'drop-final-verification') document.actions = document.actions.slice(0, 2);
    if (change === 'environment-locks') document.lockEnvironmentIds = ['unreviewed-environment'];
    if (change === 'issuer-metadata') for (const action of document.actions) action.metadata!.issuerNames = ['UNREVIEWED_ISSUER'];
    if (change === 'target-metadata') for (const action of document.actions) {
      const target = action.metadata!.target as { username: string }; target.username = 'unreviewed-user';
    }
    f.ctx.repos.runs.updatePlan(plan.planRunId, document as unknown as Record<string, unknown>);
    await expect(f.apply(plan.planRunId, document.actions.map(action => action.id))).rejects.toThrow(/authority.*encrypted review/);
    expect(f.lifecycle.rotate).not.toHaveBeenCalled();
    expect(f.lifecycle.configuration.synchronize).not.toHaveBeenCalled();
  }
);

it('does not expose decrypted malformed intent in a pre-executor error', async () => {
  const f = await fixture(), plan = await f.plan();
  const document = f.document(plan.planRunId);
  document.overrides!.delegatedSecretVarsEncrypted = getSecretStore().encrypt('raw-secret');
  f.ctx.repos.runs.updatePlan(plan.planRunId, document as unknown as Record<string, unknown>);
  const exposed = await f.apply(plan.planRunId, plan.actions.map(action => action.id))
    .then(result => JSON.stringify(result), error => String(error?.message ?? error));
  expect(exposed.includes('raw-secret')).toBe(false);
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
  expect(f.lifecycle.configuration.synchronize).not.toHaveBeenCalled();
});

it('reuses a replacement for repeated review of one generation and separates the next generation', async () => {
  const f = await fixture(true);
  const first = await f.plan(), repeated = await f.plan(), next = await f.plan(2);
  const read = (id: string) => getSecretStore().decryptObject<{ value: string }>(f.document(id).overrides!.delegatedSecretVarsEncrypted!).value;
  const original = read(first.planRunId);
  expect(read(repeated.planRunId) === original).toBe(true);
  expect(read(next.planRunId) === original).toBe(false);
  expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(JSON.stringify([first, repeated, next]).includes(original)).toBe(false);
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
});

it('does not replay native or verification actions after the plan already has a successful apply', async () => {
  const f = await fixture(), plan = await f.plan();
  const run = f.ctx.repos.runs.findById(plan.planRunId)!;
  const reservation = f.ctx.repos.runs.reserveApply({ projectId: run.projectId, environmentId: run.environmentId,
    planRunId: run.id, environmentName: plan.environmentName, specRevision: plan.specRevision });
  if (!reservation.reserved) throw new Error('Expected an unused plan reservation.');
  f.ctx.repos.runs.updateStatus(reservation.run.id, 'succeeded');
  f.lifecycle.inspect.mockClear();
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id)))
    .toMatchObject({ kind: 'executed', result: { success: false, conflict: { kind: 'already_applied' } } });
  expect(f.lifecycle.inspect).not.toHaveBeenCalled();
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
  expect(f.lifecycle.configuration.synchronize).not.toHaveBeenCalled();
  expect(f.lifecycle.configuration.verifyAuthentication).not.toHaveBeenCalled();
});

it('rejects only the explicit deployed-driver opt-in when the native lifecycle lacks that capability', async () => {
  const f = await fixture(false, false);
  await expect(f.plan()).rejects.toThrow('Deployed application authentication is unsupported');
  expect(f.lifecycle.inspect).not.toHaveBeenCalled();
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
});

it('keeps the third action pending until exact rollout, retirement and deployed authentication agree', async () => {
  const f = await fixture(), plan = await f.plan();
  expect(plan.actions.map(action => action.metadata?.operation)).toEqual(['databasePasswordRotate', 'databasePasswordSynchronize', 'databasePasswordVerify']);
  expect(plan.actions[2]).toMatchObject({ requiresConfirm: false, dataBearing: false, dependsOn: [plan.actions[1].id] });
  f.lifecycle.probe.mockResolvedValue({ state: 'authenticated', tested: 'synthetic fresh password challenge' });
  f.lifecycle.configuration.observe.mockResolvedValue({ issuer: 'match', references: 'match' });
  const ids = plan.actions.slice(0, 2).map(action => action.id);
  const first = await f.apply(plan.planRunId, ids);
  expect(first).toMatchObject({ result: { success: false } });
  expect(f.lifecycle.configuration.verifyAuthentication).not.toHaveBeenCalled();
  const accepted = (f.ctx.repos.environments.findById(f.environment.id)!.platformBindings.credentialUpdates as any)['database-login'];
  expect(accepted.completed).toEqual(ids);
  await expect(f.plan()).rejects.toThrow('reapply native database rotation');
  const observation = { observed: { provider: 'railway', projectExists: true, projectId: 'provider-project',
    environmentId: 'provider-environment', environmentName: 'production', databases: [], services: [{ name: 'web',
      externalId: 'provider-web', status: 'running', envVarKeys: [], envVarHashes: {}, deployment: { state: 'present',
        id: 'new-deployment', status: 'SUCCESS', activeDeploymentIds: ['new-deployment', 'old-deployment'],
        configurationState: 'resolved', envVarHashes: { DATABASE_URL: 'a'.repeat(64), POSTGRES_DB_URL: 'a'.repeat(64) } } }] } } as any;
  vi.mocked(PlanService.prototype.observeEnvironment).mockResolvedValue(observation);
  expect(await f.apply(plan.planRunId, ids)).toMatchObject({ result: { success: false } });
  expect(f.lifecycle.configuration.verifyAuthentication).not.toHaveBeenCalled();
  observation.observed.services[0].deployment.activeDeploymentIds = ['new-deployment'];
  expect(await f.apply(plan.planRunId, ids)).toMatchObject({ result: { success: false } });
  expect(f.lifecycle.configuration.verifyAuthentication).toHaveBeenCalledTimes(1);
  f.lifecycle.configuration.verifyAuthentication.mockResolvedValue({ state: 'authenticated', tested: 'synthetic configured-driver proof' });
  expect(await f.apply(plan.planRunId, ids)).toMatchObject({ result: { success: true } });
  const frozen = getSecretStore().decryptObject<any>(f.document(plan.planRunId).overrides!.delegatedSecretVarsEncrypted!);
  expect(frozen.applicationValidation).toMatchObject({ tested: 'synthetic configured-driver proof' });
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
  expect(f.lifecycle.configuration.synchronize).not.toHaveBeenCalled();
  expect(await f.apply(plan.planRunId, ids)).toMatchObject({ result: { success: false, conflict: { kind: 'already_applied' } } });
  expect(f.lifecycle.configuration.verifyAuthentication).toHaveBeenCalledTimes(2);
});

it('rejects changed private runtime references before attempting native SQL', async () => {
  const f = await fixture();
  const review = await f.lifecycle.configuration.inspect();
  f.lifecycle.configuration.inspect.mockResolvedValue({ ...review, privateState: { references: { DATABASE_URL: '${{Postgres.DATABASE_URL}}' } } } as any);
  const plan = await f.plan();
  f.lifecycle.configuration.inspect.mockResolvedValue({ ...review, privateState: { references: { DATABASE_URL: '${{ANOTHER_URL}}' } } } as any);
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: false } });
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
  expect(f.lifecycle.configuration.synchronize).not.toHaveBeenCalled();
});
