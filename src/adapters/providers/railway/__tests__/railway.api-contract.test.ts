import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphQLClient } from 'graphql-request';
import { execute, parse, validate } from 'graphql';
import { projectId, productionId, stagingId, schema, railwayHttpFixture } from './railway-http.fixture.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

afterEach(() => vi.unstubAllGlobals());

describe('pinned provider API contract', () => {
  it('keeps the existing managed-check entrypoints wired to offline API tests', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(scripts['test:providers:upstream-contracts']).toBe('npm run test:providers:api-contracts');
    expect(scripts['test:providers:api-contracts']).toContain('railway.api-contract.test.ts');
    expect(scripts['test:providers:api-contracts']).toContain('rest.api-contract.test.ts');
    expect(execFileSync(process.execPath, ['scripts/check-railway-upstream-contract.mjs'], {
      encoding: 'utf8',
    })).toContain('no network access');
  });

  it('validates the adapter query documents against the official pinned schema', () => {
    expect(execFileSync(process.execPath, ['scripts/check-provider-contracts.mjs'], {
      encoding: 'utf8',
    })).toContain('no network access');
  });

  it('rejects a missing required variable before executing a mutation', async () => {
    const rootValue = { environmentCreate: vi.fn() };
    const document = parse('mutation Create($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id } }');
    expect(validate(schema, document)).toEqual([]);
    const response = await execute({ schema, document, variableValues: { input: { name: 'staging' } }, rootValue });
    expect(response.errors?.[0]?.message).toContain('projectId');
    expect(rootValue.environmentCreate).not.toHaveBeenCalled();
  });

  it('cannot turn null on a non-null field into a successful client response', async () => {
    vi.stubGlobal('fetch', async () => Response.json(await execute({
      schema,
      document: parse('query { serviceInstance(serviceId: "service", environmentId: "staging") { id } }'),
      rootValue: { serviceInstance: null },
    })));
    const client = new GraphQLClient('https://contract.invalid/graphql/v2');
    await expect(client.request('query { serviceInstance(serviceId: "service", environmentId: "staging") { id } }'))
      .rejects.toThrow('Cannot return null');
  });

  it('creates and re-observes staging beside production; a repeated environment ensure is mutation-free', async () => {
    const fixture = await railwayHttpFixture({ stagingExists: false });
    const created = await fixture.adapter.ensureEnvironment(fixture.environment);
    expect(created, JSON.stringify(fixture.contractErrors)).toMatchObject({ success: true, data: { environmentId: stagingId } });
    fixture.environment.platformBindings = { projectId, environmentId: stagingId };
    const before = fixture.mutations.length;
    expect(await fixture.adapter.ensureEnvironment(fixture.environment)).toMatchObject({ success: true });
    expect(fixture.mutations).toHaveLength(before);
    expect(fixture.environments.has(productionId)).toBe(true);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('creates a project using the pinned workspace input and verifies its returned identity', async () => {
    const fixture = await railwayHttpFixture({ projectExists: false });
    fixture.environment.platformBindings = {};
    expect(await fixture.adapter.ensureProject('contract-project', fixture.environment)).toMatchObject({
      success: true, data: { projectId },
    });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['projectCreate']);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('populates a newly created staging environment while preserving the existing production stack', async () => {
    const fixture = await railwayHttpFixture({ stagingExists: false });
    expect(await fixture.adapter.ensureEnvironment(fixture.environment)).toMatchObject({ success: true });
    fixture.environment.platformBindings = { projectId, environmentId: stagingId };
    for (const type of ['postgres', 'redis'] as const) {
      expect((await fixture.adapter.ensureComponent(type, fixture.environment)).receipt.success).toBe(true);
    }
    const service: Service = {
      id: 'local-web', projectId: 'local-project', name: 'web', buildConfig: { public: true }, envVarSpec: {},
      createdAt: new Date(), updatedAt: new Date(),
    };
    expect((await fixture.adapter.deploy(service, fixture.environment, {})).receipt.success).toBe(true);
    expect([...fixture.services.values()].filter((entry) => entry.instances.has(stagingId))).toHaveLength(3);
    expect([...fixture.services.values()].filter((entry) => entry.instances.has(productionId))).toHaveLength(3);
    expect(fixture.mutations.filter(({ field }) => field === 'environmentCreate')).toHaveLength(1);
    expect(fixture.mutations.filter(({ field }) => field === 'serviceCreate')).toHaveLength(3);
    expect(fixture.contractErrors).toEqual([]);
  });

  it.each(['postgres', 'redis', 'web'] as const)('creates staging %s through serialized requests, then retries safely', async (kind) => {
    const fixture = await railwayHttpFixture();
    const service: Service = {
      id: 'local-web', projectId: 'local-project', name: 'web', buildConfig: { public: true }, envVarSpec: {},
      createdAt: new Date(), updatedAt: new Date(),
    };
    const create = () => kind === 'web'
      ? fixture.adapter.deploy(service, fixture.environment, {})
      : fixture.adapter.ensureComponent(kind, fixture.environment);
    const first = await create();
    expect(first.receipt, JSON.stringify(fixture.contractErrors)).toMatchObject({ success: true });
    const created = fixture.mutations.filter(({ field }) => field === 'serviceCreate');
    expect(created).toHaveLength(1);
    expect(created[0].args.input.environmentId).toBe(stagingId);
    const before = fixture.mutations.length;
    // A repeated create without binding must request adoption, never duplicate.
    expect((await create()).receipt).toMatchObject({ success: false });
    expect(fixture.mutations).toHaveLength(before);
    for (const entry of [...fixture.services.values()].filter((entry) => entry.id.startsWith('production-'))) {
      expect([...entry.instances.keys()]).toEqual([productionId]);
    }
    const stagingService = [...fixture.services.values()].find((entry) => entry.id.startsWith('staging-'))!;
    if (kind === 'web') {
      fixture.environment.platformBindings = { projectId, environmentId: stagingId, services: { web: { serviceId: stagingService.id } } };
      expect(await fixture.adapter.setEnvVars(fixture.environment, service, { APP_MODE: 'staging' })).toMatchObject({ success: true });
      expect(fixture.variables.get(`${stagingService.id}/${stagingId}`)).toEqual({ APP_MODE: 'staging' });
    }
    const scope = { scope: 'environment' as const, projectId, environmentId: stagingId };
    expect(await fixture.adapter.deleteService(stagingService.id, scope, { allowMutation: true })).toMatchObject({ success: true });
    const afterDelete = fixture.mutations.length;
    expect(await fixture.adapter.deleteService(stagingService.id, scope, { allowMutation: true })).toMatchObject({ success: true, alreadyAbsent: true });
    expect(fixture.mutations).toHaveLength(afterDelete);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('preserves the observed missing-instance error through the real GraphQL client', async () => {
    const fixture = await railwayHttpFixture();
    expect(await fixture.adapter.inspectServiceInstance('production-postgres-db', stagingId)).toMatchObject({
      state: 'unknown', error: expect.stringContaining('ServiceInstance not found (code: INTERNAL_SERVER_ERROR, path: serviceInstance)'),
    });
    expect(fixture.mutations).toEqual([]);
  });

  it('consumes later inventory pages before deciding a target is absent', async () => {
    const fixture = await railwayHttpFixture({ pageSize: 1 });
    const service = fixture.services.get('production-postgres-db')!;
    service.instances.set(stagingId, { ...service.instances.get(productionId)!, id: 'instance-staging', environmentId: stagingId });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.error).toContain('hv_import');
    expect(fixture.requests.filter(({ query }) => query.includes('GetServiceInstanceInventory'))
      .map(({ variables }) => variables.after)).toEqual([null, '1']);
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it.each([403, 429, 503])('does not create resources after HTTP %s inventory failures', async (status) => {
    const fixture = await railwayHttpFixture({
      responseOverride: ({ query }) => query.includes('GetServiceInstanceInventory')
        ? Response.json({ errors: [{ message: 'Synthetic provider failure' }] }, { status })
        : undefined,
    });
    await expect(fixture.adapter.ensureComponent('postgres', fixture.environment)).rejects.toThrow();
    expect(fixture.mutations).toEqual([]);
  });

  it.each([
    { data: { service: null } },
    { data: { service: { id: 'production-postgres-db', projectId, serviceInstances: { edges: [] } } } },
  ])('blocks incomplete HTTP 200 inventories instead of treating them as empty', async (response) => {
    const fixture = await railwayHttpFixture({
      responseOverride: ({ query }) => query.includes('GetServiceInstanceInventory')
        ? Response.json(response)
        : undefined,
    });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment).catch((error: Error) => error);
    expect(result instanceof Error || !result.receipt.success).toBe(true);
    expect(fixture.mutations).toEqual([]);
  });

  it('retains recovery identity without retrying a write whose response was lost', async () => {
    const fixture = await railwayHttpFixture({ dropCreateResponse: true });
    const result = await fixture.adapter.ensureComponent('postgres', fixture.environment);
    expect(result.receipt.success).toBe(false);
    expect(result.component.externalId).toBeTruthy();
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['serviceCreate']);
    expect(fixture.contractErrors).toEqual([]);
  });
});
