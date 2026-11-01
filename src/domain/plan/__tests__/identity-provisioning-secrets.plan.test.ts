import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from '../../../adapters/providers/railway/__tests__/railway-http.fixture.js';
import { createToolContext } from '../../../application/context.js';
import { executePlanApply } from '../../../application/apply-plan.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { SpecStore } from '../../spec/spec.store.js';
import { PlanService } from '../plan.service.js';

const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SG_SITE_URL', 'SG_SCRIPT_NAME', 'SG_SCRIPT_KEY', 'PLANNER_SECRET'];

beforeEach(() => {
  vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(':memory:').migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  SqliteAdapter.resetInstance();
});

async function setup(database = false) {
  const fixture = await railwayHttpFixture();
  const projects = new ProjectRepository();
  const project = projects.create({ name: 'contract-project', defaultPlatform: 'railway' });
  const environments = new EnvironmentRepository();
  const production = environments.create({ projectId: project.id, name: 'production', platformBindings: {
    provider: 'railway', projectId, environmentId: productionId, services: { web: { serviceId: 'production-web' } },
  } });
  const staging = environments.create({ projectId: project.id, name: 'staging', platformBindings: {
    provider: 'railway', projectId, environmentId: stagingId,
  } });
  new SpecStore().replace(project, {
    version: 1, project: project.name,
    secrets: Object.fromEntries(keys.map(key => [key, { ownership: 'delegated', principal: 'github:owner', environments: ['staging'] }])),
    environments: {
      production: { hosting: { provider: 'railway' }, services: { web: {} } },
      staging: {
        hosting: { provider: 'railway' },
        deploy: { strategy: 'manual' },
        services: { web: { volume: { mountPath: '/data' } } },
        ...(database ? { database: { provider: 'railway', engine: 'postgres' } } : {}),
        envVars: { MARQR_MEDIA_DIR: '/data/marqr_media' },
      },
    },
  });
  const connections = new ConnectionRepository();
  const connection = connections.create({ provider: 'railway', credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-contract-token' }) });
  connections.updateStatus(connection.id, 'verified');
  vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: fixture.adapter });
  vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({ success: true, adapter: fixture.adapter as never });
  const planner = new PlanService();
  const plan = async () => {
    const result = await planner.plan(project, 'staging', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    return result;
  };
  const apply = async (result: Awaited<ReturnType<typeof plan>>) => {
    const current = new SpecStore().get(project)!;
    return executePlanApply(createToolContext(), { project, spec: current.spec, specRevision: current.revision,
      planId: result.planRunId, confirmActions: result.actions.filter(action => action.type !== 'noop').map(action => action.id) });
  };
  return { fixture, environments, production, staging, plan, apply };
}

// Independent expectation: an empty Railway service has no required source or
// variables (pinned official ServiceCreateInput); Hypervibe's retained-volume
// contract prepares that identity before disk attachment and application release.
// Real planner/apply and client serialization execute synthetic provider state
// against the pinned official SDL. This is not live Railway readiness evidence.
describe('application credentials stay outside identity-only provisioning', () => {
  it('prepares an empty service and its volume, then requires all application inputs before release', async () => {
    const f = await setup();
    const production = structuredClone(f.fixture.services.get('production-web'));
    const productionBindings = f.environments.findById(f.production.id)!.platformBindings;
    const first = await f.plan();
    expect(first.scope).toBe('hosting-bindings');
    expect(first.actions.map(action => action.id)).toEqual(['service:web']);
    expect(f.fixture.mutations).toEqual([]);

    // Observe the actual apply refusal before fixing the planner, not just its
    // presentation. Required runtime inputs are relevant only to the later release.
    expect(await f.apply(first)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(first.inputRequired).toEqual([]);
    expect(new RunRepository().findById(first.planRunId)!.plan).not.toHaveProperty('overrides');
    const serviceId = (f.environments.findById(f.staging.id)!.platformBindings.services as Record<string, { serviceId: string }>).web.serviceId;
    expect(f.fixture.services.get(serviceId)!.instances.get(stagingId)!.source).toEqual({});
    expect(f.fixture.mutations.some(mutation => /deploy|serviceConnect/i.test(mutation.field))).toBe(false);
    for (const values of f.fixture.variables.values()) for (const key of keys) expect(values).not.toHaveProperty(key);

    const volume = await f.plan();
    expect(volume.scope).toBe('service-volumes');
    expect(volume.inputRequired).toEqual([]);
    expect(await f.apply(volume)).toMatchObject({ kind: 'executed', result: { success: true } });

    const release = await f.plan();
    expect(release.scope).toBe('full');
    expect(release.inputRequired.map(input => input.key).sort()).toEqual([...keys].sort());
    const before = f.fixture.mutations.length;
    expect(await f.apply(release)).toMatchObject({ kind: 'input_required' });
    expect(f.fixture.mutations).toHaveLength(before);
    expect(f.fixture.services.get('production-web')).toEqual(production);
    expect(f.environments.findById(f.production.id)!.platformBindings).toEqual(productionBindings);
    expect(f.fixture.contractErrors).toEqual([]);
  });

  it('prepares the declared database dependency without treating its own credentials as application inputs', async () => {
    const f = await setup(true);
    const production = structuredClone([...f.fixture.services.values()].filter(service => service.instances.has(productionId)));
    const first = await f.plan();
    expect(first.scope).toBe('hosting-bindings');
    expect(first.actions.map(action => action.id).sort()).toEqual(['database:railway', 'service:web']);
    expect(await f.apply(first)).toMatchObject({ kind: 'executed', result: { success: true } });
    expect(first.inputRequired).toEqual([]);
    expect(f.fixture.mutations.filter(mutation => mutation.field === 'templateDeployV2')).toHaveLength(1);
    expect(f.fixture.variables.get(`staging-Postgres/${stagingId}`)).toHaveProperty('POSTGRES_PASSWORD', 'synthetic-provider-generated-password');
    for (const values of f.fixture.variables.values()) for (const key of keys) expect(values).not.toHaveProperty(key);
    expect(f.fixture.mutations.some(mutation => /serviceInstance(?:Re)?deploy|serviceConnect/i.test(mutation.field))).toBe(false);
    expect([...f.fixture.services.values()].filter(service => service.instances.has(productionId))).toEqual(production);
    expect(f.fixture.contractErrors).toEqual([]);
  });
});
