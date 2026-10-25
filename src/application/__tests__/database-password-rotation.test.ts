import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { SpecStore } from '../../domain/spec/spec.store.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { hashEnvValue } from '../../domain/ports/observe.port.js';
import { createCommandContext } from '../context.js';
import { executePlanApply } from '../apply-plan.js';
import { pendingCredentialUpdate } from '../../domain/services/credential-lifecycle.service.js';
import '../providers.js';
import * as hostingEnv from '../../domain/services/hosting-env.service.js';
import { credentialInventory } from '../credential-inventory.js';

// Synthetic capability conformance, not native-provider or SQL compatibility.
// Independent requirement: a lost SQL acknowledgement cannot cause a second
// replacement; issuer readback and fresh SQL proof must precede deployment.
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'hv-db-rotation-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(dir, 'state.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });

async function fixture(provider = 'railway') {
  const hosting = ({ cloudsql: 'cloudrun', rds: 'ecs', 'azure-postgres': 'azure-container-apps', fly: 'fly', digitalocean: 'digitalocean' } as Record<string, string>)[provider] ?? 'railway';
  const ctx = createCommandContext();
  const project = ctx.repos.projects.create({ name: 'rotation-contract', defaultPlatform: 'railway' });
  const environment = ctx.repos.environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: hosting, projectId: 'project-1', environmentId: 'production-1', services: { web: { serviceId: 'web-1' }, worker: { serviceId: 'worker-1' } },
  } });
  const component = ctx.repos.components.create({ environmentId: environment.id, type: 'postgres', externalId: 'database-1', bindings: {
    provider, providerScope: { projectId: 'project-1', environmentId: 'production-1' }, username: 'app', database: 'railway', password: 'old', connectionString: 'postgresql://app:old@database.internal/railway?application_name=web',
  } });
  const source = path.join(dir, 'replacement');
  writeFileSync(source, 'same-intended-replacement', { mode: 0o600 });
  const descriptor = { role: 'database-login', label: 'Database login', purpose: 'Rotate application database authentication', kind: 'database-password', source: `file:${source}`,
    database: { environment: environment.name, component: component.id, username: 'app', database: 'railway' } };
  const spec = new SpecStore().replace(project, { version: 1, project: project.name,
    secrets: { DATABASE_ROTATION_INPUT: { ownership: 'delegated', principal: 'user:owner', environments: [], credential: descriptor } },
    environments: { production: { hosting: { provider: hosting }, database: { provider, engine: 'postgres' },
      envFile: { mode: 'off' }, services: { web: { databaseEnvAliases: { POSTGRES_DB_URL: 'DATABASE_URL' } }, worker: { databaseEnvAliases: { POSTGRES_DB_URL: 'DATABASE_URL' } } }, deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' } } },
  });
  const target = { provider, componentId: component.id, environmentId: environment.id, externalId: component.externalId,
    username: 'app', database: 'railway', providerScope: component.bindings.providerScope, inputMode: 'supplied', connection: { host: 'database.internal', port: 5432, username: 'app', database: 'railway' } };
  let actual = 'old'; let issuer = 'old'; let sqlUnknown = false; let configUnknown = false; let probeUnknown = false; let skipProof = false; let skipConfigurationProof = false;
  const expectedHashes = { DATABASE_URL: hashEnvValue('new-connection-url'), POSTGRES_DB_URL: hashEnvValue('new-connection-url') };
  const consumers = ['web', 'worker'].map(service => ({ service, externalId: `${service}-1`, envVarHashes: expectedHashes }));
  const configuration = {
    inspect: vi.fn(async () => ({ issuerNames: ['DATABASE_URL', 'PGPASSWORD', 'POSTGRES_PASSWORD'], consumers })),
    observe: vi.fn(async (_e, _c, _t, replacement) => { if (skipConfigurationProof) { skipConfigurationProof = false; return { issuer: 'unknown', references: 'unknown' }; } return { issuer: issuer === replacement ? 'match' : 'different', references: 'match' }; }),
    synchronize: vi.fn(async (_e, _c, _t, replacement) => { issuer = replacement; skipConfigurationProof = configUnknown; return { state: configUnknown ? 'unknown' : 'acknowledged' }; }),
  };
  const lifecycle = { inspect: vi.fn(async () => target), readCurrent: vi.fn(async () => null as string | null),
    probe: vi.fn(async (_e, _c, _t, replacement) => { const state = probeUnknown || skipProof ? 'unknown' : actual === replacement ? 'authenticated' : 'rejected'; skipProof = false; return { state, tested: 'synthetic fresh SQL identity proof' }; }),
    rotate: vi.fn(async (_e, _c, _t, replacement) => { actual = replacement; skipProof = sqlUnknown; return { state: sqlUnknown ? 'unknown' : 'acknowledged' }; }), configuration,
  };
  vi.spyOn(adapterFactory, 'getDatabaseAdapter').mockResolvedValue({ success: true, adapter: { name: provider, credentialLifecycle: lifecycle } as any });
  const observed = { projectExists: true, provider: hosting, projectId: 'project-1', environmentId: 'production-1', environmentName: environment.name, services: ['web', 'worker'].map(name => ({ name, externalId: `${name}-1`, status: 'running', envVarKeys: Object.keys(expectedHashes), envVarHashes: expectedHashes,
    deployment: { state: 'present', id: `${name}-old`, status: 'SUCCESS', activeDeploymentIds: [`${name}-old`] } })), databases: [], } as any;
  vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed } as any);
  const plan = () => new PlanService().plan(project, environment.name, { scope: 'credentials', credential: descriptor.role, intent: 'rotate' });
  const apply = (planId: string, ids: string[]) => executePlanApply(ctx, { project, spec: spec.spec, specRevision: spec.revision, planId, confirmActions: ids });
  return { ctx, project, environment, component, source, spec, descriptor, plan, apply, lifecycle, configuration, observed,
    target, setActual: (value: string) => { actual = value; }, setIssuer: (value: string) => { issuer = value; },
    sqlUnknown: () => { sqlUnknown = true; }, configUnknown: () => { configUnknown = true; }, probeUnknown: (value: boolean) => { probeUnknown = value; } };
}

async function composedFixture(provider = 'railway') {
  const f = await fixture(provider);
  (f.lifecycle as any).configuration = undefined;
  (f.lifecycle as any).inspectIssuer = vi.fn(async (_e, _c, _t, value) => f.configuration.observe(_e, _c, _t, value).then(result => result.issuer));
  (f.lifecycle as any).finalize = vi.fn(async (_e, _c, _t, value) => { f.setIssuer(value); return { state: 'acknowledged' }; });
  const values = new Map(['web', 'worker'].map(name => [name, { DATABASE_URL: String(f.component.bindings.connectionString), POSTGRES_DB_URL: String(f.component.bindings.connectionString), KEEP: '${{shared.VALUE}}' }]));
  for (const name of values.keys()) f.ctx.repos.services.create({ projectId: f.project.id, name, buildConfig: {}, envVarSpec: {} });
  vi.spyOn(hostingEnv, 'readHostingEnvVars').mockImplementation(async ({ service }) => ({ success: true, provider: String(f.environment.platformBindings.provider), variables: { ...values.get(service.name)! } }));
  const synchronize = vi.spyOn(hostingEnv, 'syncHostingEnvVars').mockImplementation(async ({ service, vars }) => { Object.assign(values.get(service.name)!, vars); return { success: true, message: 'Synthetic selected-key acknowledgment' }; });
  return { ...f, values, synchronize };
}

it.each(['railway', 'supabase', 'neon', 'cloudsql', 'rds', 'azure-postgres', 'fly', 'digitalocean'])('composes %s native authentication with complete exact hosting consumers', async provider => {
  const f = await composedFixture(provider);
  const plan = await f.plan();
  expect(plan).not.toHaveProperty('error'); if ('error' in plan) return;
  expect(plan.actions).toHaveLength(2);
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: true } });
  expect(f.lifecycle.rotate).toHaveBeenCalledTimes(1);
  for (const value of f.values.values()) {
    expect(value.DATABASE_URL).toBe('postgresql://app:same-intended-replacement@database.internal/railway?application_name=web');
    expect(value.POSTGRES_DB_URL).toBe(value.DATABASE_URL);
    expect(value.KEEP).toBe('${{shared.VALUE}}');
  }
});

it.each(['adopt', 'rotate'] as const)('supports provider-generated %s with the exact encrypted value and no repeat reset', async intent => {
  const f = await composedFixture('fly');
  f.target.inputMode = 'provider-generated'; let actual = 'old';
  f.lifecycle.readCurrent.mockImplementation(async () => actual);
  f.lifecycle.rotate.mockImplementation(async () => { actual = 'native-generated'; f.setActual(actual); return { state: 'unknown' }; });
  const descriptor = { ...f.descriptor }; delete (descriptor as { source?: string }).source;
  const next = new SpecStore().replace(f.project, { ...f.spec.spec, secrets: { DATABASE_ROTATION_INPUT: { ...f.spec.spec.secrets.DATABASE_ROTATION_INPUT, credential: descriptor } } });
  Object.assign(f.spec, next);
  const plan = await new PlanService().plan(f.project, 'production', { scope: 'credentials', credential: descriptor.role, intent });
  expect(plan).not.toHaveProperty('error'); if ('error' in plan) return;
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: true } });
  expect(f.lifecycle.rotate).toHaveBeenCalledTimes(intent === 'adopt' ? 0 : 1);
  expect(f.synchronize).toHaveBeenCalledTimes(intent === 'adopt' ? 0 : 2);
  expect(f.ctx.repos.components.findById(f.component.id)?.bindings.password).toBe(intent === 'adopt' ? 'old' : 'native-generated');
  expect(readFileSync(path.join(dir, 'state.db')).includes(Buffer.from('native-generated'))).toBe(false);
});

it('finishes remaining consumers after a committed write loses its acknowledgment', async () => {
  const f = await composedFixture();
  const write = f.synchronize.getMockImplementation()!; let fail = true;
  f.synchronize.mockImplementation(async args => {
    const result = await write(args);
    if (fail) { fail = false; throw new Error('response lost'); }
    return result;
  });
  const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: false } });
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: true } });
  expect(f.lifecycle.rotate).toHaveBeenCalledTimes(1);
  expect(f.synchronize.mock.calls.map(([args]) => args.service.name)).toEqual(['web', 'worker']);
});

it('projects native authentication, exact consumers and accepted source evidence without values or fingerprints', async () => {
  const f = await composedFixture();
  const observeDatabase = vi.fn(async () => ({ provider: 'railway', externalId: f.component.externalId, engine: 'postgres', status: 'running' }));
  vi.mocked(adapterFactory.getDatabaseAdapter).mockResolvedValue({ success: true, adapter: { name: 'railway', credentialLifecycle: f.lifecycle, observeDatabase } as any });
  const before = await credentialInventory(f.ctx, f.project, 'production');
  expect(before.roles.find(role => role.id === 'role:database-login')?.consumers).toHaveLength(5);
  expect(f.lifecycle.rotate).not.toHaveBeenCalled(); expect(f.synchronize).not.toHaveBeenCalled();
  const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
  await f.apply(plan.planRunId, plan.actions.map(action => action.id));
  f.observed.completeness = { project: 'complete', environment: 'complete', services: 'complete', serviceIdentities: 'complete' };
  for (const service of f.observed.services) service.envVarHashes = Object.fromEntries(Object.entries(f.values.get(service.name)!).map(([key, value]) => [key, hashEnvValue(value)]));
  const inventory = await credentialInventory(f.ctx, f.project, 'production');
  const role = inventory.roles.find(role => role.id === 'role:database-login')!;
  expect(role.lifecycle?.state).toBe('accepted'); expect(role.validation.result).toBe('passed');
  expect(role.validation.lastSuccessfulAt).toBeTruthy(); expect(role.rotation.acceptedUpdateAt).toBeTruthy(); expect(role.rotation.lastRotatedAt).toBeNull();
  expect(role.consumers.find(consumer => consumer.kind === 'database')).toMatchObject({ configuration: { presence: 'present', comparison: 'unknown' }, nativeIdentity: { componentId: f.component.id, username: 'app', database: 'railway' } });
  expect(role.consumers.filter(consumer => consumer.kind === 'hosting')).toHaveLength(4);
  expect(role.consumers.filter(consumer => consumer.kind === 'hosting').every(consumer => consumer.configuration.comparison === 'match')).toBe(true);
  expect(JSON.stringify(inventory)).not.toContain('same-intended-replacement');
  expect(JSON.stringify(inventory)).not.toContain(hashEnvValue('same-intended-replacement'));
});

it('does not strand recovery when the native adapter proves it refused the mutation', async () => {
  const f = await composedFixture();
  f.lifecycle.rotate.mockResolvedValue({ state: 'blocked' });
  const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: false } });
  expect(f.synchronize).not.toHaveBeenCalled();
  expect(pendingCredentialUpdate(f.project.id)).toBeUndefined();
  expect(await f.plan()).not.toHaveProperty('error');
});

it.each(['fly', 'digitalocean'])('synchronizes %s write-only consumers from exact declared database projections without claiming current-value proof', async provider => {
  const f = await composedFixture(provider);
  vi.mocked(hostingEnv.readHostingEnvVars).mockResolvedValue({ success: true, provider, variables: {}, unresolvedKeys: ['DATABASE_URL', 'POSTGRES_DB_URL'] });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {
    name: provider, capabilities: { credentialValueEvidence: 'acknowledgement', credentialUpdateActivation: 'deferred' }, observe: async () => f.observed,
  } as any });
  const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: true } });
  expect(f.synchronize).toHaveBeenCalledTimes(2);
  for (const [input] of f.synchronize.mock.calls) expect(input.vars).toEqual({ DATABASE_URL: 'postgresql://app:same-intended-replacement@database.internal/railway?application_name=web', POSTGRES_DB_URL: 'postgresql://app:same-intended-replacement@database.internal/railway?application_name=web' });
  const inventory = await credentialInventory(f.ctx, f.project, 'production');
  const role = inventory.roles.find(role => role.id === 'role:database-login')!;
  expect(role.consumers.filter(consumer => consumer.kind === 'hosting').every(consumer => consumer.configuration.comparison === 'unknown')).toBe(true);
});

it('does not turn a failed read into authority to overwrite a write-only consumer', async () => {
  const f = await composedFixture('fly');
  vi.mocked(hostingEnv.readHostingEnvVars).mockResolvedValue({ success: false, provider: 'fly', error: 'Unknown provider read' });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { name: 'fly', capabilities: { credentialValueEvidence: 'acknowledgement' }, observe: async () => f.observed } as any });
  expect(await f.plan()).toHaveProperty('error');
  expect(f.lifecycle.rotate).not.toHaveBeenCalled(); expect(f.synchronize).not.toHaveBeenCalled();
});

it.each(['fly', 'digitalocean'])('retains %s exact accepted configuration evidence for the database consumer rollout', async provider => {
  const f = await composedFixture(provider);
  const write = f.synchronize.getMockImplementation()!;
  f.synchronize.mockImplementation(async args => ({ ...await write(args), data: {
    configurationUpdated: true, credentialValueEvidence: 'acknowledgement',
    credentialUpdateActivation: provider === 'fly' ? 'deferred' : 'provider-rollout',
    ...(provider === 'fly' ? { configurationVersion: args.service.name === 'web' ? 42 : 43 }
      : { deploymentId: `${args.service.name}-native-new`, deploymentIds: [`${args.service.name}-native-new`] }),
    runtimeRolloutRequired: true,
  } }));
  const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
  expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: true } });
  const saved = f.ctx.repos.environments.findById(f.environment.id)!;
  expect(saved.platformBindings.runtimeRollouts).toEqual(expect.arrayContaining(['web', 'worker'].map(service => expect.objectContaining({
    service, operationId: plan.planRunId, configurationAccepted: 'readback', configurationAcceptedKeys: ['DATABASE_URL', 'POSTGRES_DB_URL'],
    ...(provider === 'fly' ? { configurationVersion: service === 'web' ? 42 : 43 } : { expectedDeploymentId: `${service}-native-new`, expectedDeploymentIds: [`${service}-native-new`] }),
  }))));
});

it('requires explicit uncertain-write retry for opaque consumers without resetting the native password again', async () => {
  const f = await composedFixture('fly');
  vi.mocked(hostingEnv.readHostingEnvVars).mockResolvedValue({ success: true, provider: 'fly', variables: {}, unresolvedKeys: ['DATABASE_URL', 'POSTGRES_DB_URL'] });
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {
    name: 'fly', capabilities: { credentialValueEvidence: 'acknowledgement', credentialUpdateActivation: 'deferred' }, observe: async () => f.observed,
  } as any });
  const write = f.synchronize.getMockImplementation()!; let first = true;
  f.synchronize.mockImplementation(async args => {
    const result = await write(args);
    if (first) { first = false; return { ...result, success: false, message: 'Synthetic lost acknowledgment' }; }
    return { ...result, data: { configurationVersion: 43, credentialUpdateActivation: 'deferred' } };
  });
  const plan = await f.plan(); if ('error' in plan) throw new Error(plan.error);
  const ids = plan.actions.map(action => action.id);
  expect(await f.apply(plan.planRunId, ids)).toMatchObject({ result: { success: false } });
  const repeated = await f.apply(plan.planRunId, ids);
  expect(repeated).toMatchObject({ result: { success: false } });
  expect(JSON.stringify(repeated)).toContain(`${ids[1]}:retry-uncertain`);
  expect(f.synchronize).toHaveBeenCalledTimes(1);
  expect(await f.apply(plan.planRunId, [...ids, `${ids[1]}:retry-uncertain`])).toMatchObject({ result: { success: true } });
  expect(f.lifecycle.rotate).toHaveBeenCalledTimes(1);
  expect(f.synchronize.mock.calls.map(([input]) => input.service.name)).toEqual(['web', 'web', 'worker']);
  expect(f.synchronize.mock.calls[0][0].vars).toEqual(f.synchronize.mock.calls[1][0].vars);
});

it('routes a declared password to a separate confirmed SQL and issuer lifecycle, retaining rollout obligations', async () => {
  const f = await fixture(); const plan = await f.plan();
  expect(plan).not.toHaveProperty('error'); if ('error' in plan) return;
  expect(plan.actions).toHaveLength(2);
  expect(plan.actions[1].dependsOn).toEqual([plan.actions[0].id]);
  await f.apply(plan.planRunId, []); expect(f.lifecycle.rotate).not.toHaveBeenCalled();
  const result = await f.apply(plan.planRunId, plan.actions.map(a => a.id));
  expect(result).toMatchObject({ kind: 'executed', result: { success: true } });
  expect(f.lifecycle.rotate).toHaveBeenCalledTimes(1); expect(f.configuration.synchronize).toHaveBeenCalledTimes(1);
  const saved = f.ctx.repos.environments.findById(f.environment.id)!;
  expect(saved.platformBindings.runtimeRollouts).toEqual(expect.arrayContaining(['web', 'worker'].map(service => expect.objectContaining({ service }))));
  expect(f.ctx.repos.components.findById(f.component.id)?.bindings.connectionString).toBe('postgresql://app:same-intended-replacement@database.internal/railway?application_name=web');
  expect(JSON.stringify(result)).toContain('unchecked');
  expect(JSON.stringify(result)).not.toContain('same-intended-replacement');
  expect(readFileSync(path.join(dir, 'state.db')).includes(Buffer.from('same-intended-replacement'))).toBe(false);
});

it('recovers lost SQL and issuer acknowledgements using the same encrypted replacement without repeating mutations', async () => {
  const f = await fixture(); f.sqlUnknown(); f.configUnknown(); const plan = await f.plan();
  expect(plan).not.toHaveProperty('error'); if ('error' in plan) return;
  f.probeUnknown(true);
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ result: { success: false } });
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
  f.probeUnknown(false);
  await f.apply(plan.planRunId, plan.actions.map(a => a.id));
  expect(f.lifecycle.rotate).toHaveBeenCalledTimes(1);
  writeFileSync(f.source, 'different-input-after-review');
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ result: { success: false } });
  expect(await f.apply(plan.planRunId, plan.actions.map(a => a.id))).toMatchObject({ result: { success: true } });
  expect(f.lifecycle.rotate).toHaveBeenCalledTimes(1);
  expect(f.configuration.synchronize).toHaveBeenCalledTimes(1);
  expect(f.lifecycle.rotate.mock.calls[0][3]).toBe('same-intended-replacement');
});

it('blocks ordinary plans while a database rotation is uncertain and refuses incomplete provider capabilities', async () => {
  const f = await fixture(); (f.lifecycle as any).configuration = undefined;
  expect(await f.plan()).toMatchObject({ error: expect.stringMatching(/unsupported.*native|native.*unsupported/i) });
  (f.lifecycle as any).configuration = f.configuration; const plan = await f.plan();
  expect(plan).not.toHaveProperty('error'); if ('error' in plan) return;
  f.configuration.synchronize.mockImplementation(async () => ({ state: 'unknown' }));
  await f.apply(plan.planRunId, plan.actions.map(a => a.id));
  expect(pendingCredentialUpdate(f.project.id)).toBe(plan.planRunId);
  expect(await new PlanService().plan(f.project, 'production')).toMatchObject({ error: expect.stringContaining(plan.planRunId) });
  expect(await f.plan()).toMatchObject({ error: expect.stringContaining(plan.planRunId) });
});


it.each(['provider', 'projectId', 'environmentId'])('rejects unrelated hosting %s evidence before native SQL mutation', async field => {
  const f = await fixture(); f.observed[field] = 'unrelated-scope';
  expect(await f.plan()).toMatchObject({ error: expect.stringMatching(/scope|identity/i) });
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
});

it('rejects a missing declared database alias and duplicate physical consumer identity', async () => {
  const f = await fixture();
  f.configuration.inspect.mockResolvedValueOnce({ issuerNames: ['POSTGRES_PASSWORD'], consumers: [
    { service: 'web', externalId: 'web-1', envVarHashes: { DATABASE_URL: hashEnvValue('new') } },
    { service: 'worker', externalId: 'worker-1', envVarHashes: { DATABASE_URL: hashEnvValue('new') } },
  ] } as any);
  expect(await f.plan()).toMatchObject({ error: expect.stringMatching(/alias/i) });
});


it('does not treat a malformed installed marker as completed recovery', async () => {
  const f = await fixture();
  f.ctx.repos.components.updateBindings(f.component.id, { credentialRotation: { phase: 'installed' } });
  expect(pendingCredentialUpdate(f.project.id)).toBe('invalid-database-rotation-state');
});


it('rejects explicit custom runtime destinations outside the reviewed issuer-reference capability', async () => {
  const f = await fixture();
  expect(() => new SpecStore().replace(f.project, { ...f.spec.spec, secrets: Object.fromEntries(Object.entries(f.spec.spec.secrets).map(([key, slot]) => [key, {
    ...slot, credential: { ...slot.credential, runtimeConsumers: [{ environment: 'production', service: 'web', variable: 'CUSTOM_PASSWORD' }] },
  }])) })).toThrow(/consumer/i);
  expect(f.lifecycle.rotate).not.toHaveBeenCalled();
});


it.each([['database-attempted', 'null'], ['database-attempted', 'misleading-acknowledgement'], ['configuration-attempted', 'null'], ['configuration-attempted', 'misleading-acknowledgement']] as const)('does not cross %s mutation boundary with %s recovery persistence', async (phase, resultMode) => {
    const f = await fixture(); const plan = await f.plan();
    if ('error' in plan) throw new Error(plan.error);
    const update = ComponentRepository.prototype.updateBindings;
    const persistence = vi.spyOn(ComponentRepository.prototype, 'updateBindings').mockImplementation(function (this: ComponentRepository, id, patch) {
      if ((patch.credentialRotation as { phase?: string } | undefined)?.phase === phase) {
        const previous = this.findById(id)!;
        return resultMode === 'null' ? null : { ...previous, bindings: { ...previous.bindings, ...patch } };
      }
      return update.call(this, id, patch);
    });
    try {
      expect(await f.apply(plan.planRunId, plan.actions.map(action => action.id))).toMatchObject({ result: { success: false } });
      if (phase === 'database-attempted') expect(f.lifecycle.rotate).not.toHaveBeenCalled();
      else expect(f.lifecycle.rotate).toHaveBeenCalledTimes(1);
      expect(f.configuration.synchronize).not.toHaveBeenCalled();
    } finally { persistence.mockRestore(); }
});
