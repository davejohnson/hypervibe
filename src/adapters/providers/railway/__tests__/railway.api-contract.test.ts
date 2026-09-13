import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphQLClient } from 'graphql-request';
import { execute, parse, validate } from 'graphql';
import { projectId, productionId, stagingId, schema, railwayHttpFixture } from './railway-http.fixture.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { planStorage } from '../../../../domain/services/storage-plan.service.js';

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

  it.each(['Web', 'web-', 'w'.repeat(80)])('uses the shared collision-safe policy in serialized service creation: %s', async (name) => {
    const fixture = await railwayHttpFixture();
    const service: Service = { id: 'local-web', projectId: 'local-project', name,
      buildConfig: { public: true }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const result = await fixture.adapter.deploy(service, fixture.environment, {});
    expect(result.receipt).toMatchObject({ success: true });
    const created = fixture.mutations.find(({ field }) => field === 'serviceCreate')!;
    expect(created.args.input.name).toMatch(/^[a-z][a-z0-9-]*-[a-f0-9]{8}$/);
    expect(created.args.input.name.length).toBeLessThanOrEqual(64);
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
    expect(created[0].args.input.name).toBe(kind === 'web' ? 'web' : `${kind}-db`);
    const before = fixture.mutations.length;
    // A repeated create without binding must request adoption, never duplicate.
    expect((await create()).receipt).toMatchObject({ success: false });
    expect(fixture.mutations).toHaveLength(before);
    for (const entry of [...fixture.services.values()].filter((entry) => entry.id.startsWith('production-'))) {
      expect([...entry.instances.keys()]).toEqual([productionId]);
    }
    const stagingService = [...fixture.services.values()].find((entry) => entry.id.startsWith('staging-'))!;
    if (kind === 'web') {
      // Legacy provider names remain valid: runtime updates use the bound id.
      stagingService.name = 'web-staging';
      fixture.environment.platformBindings = { projectId, environmentId: stagingId, services: { web: { serviceId: stagingService.id } } };
      expect(await fixture.adapter.setEnvVars(fixture.environment, service, { APP_MODE: 'staging' })).toMatchObject({ success: true });
      expect(fixture.variables.get(`${stagingService.id}/${stagingId}`)).toEqual({ APP_MODE: 'staging' });
      expect(stagingService.name).toBe('web-staging');
      expect(fixture.mutations.slice(before).map(({ field }) => field)).toEqual(['variableCollectionUpsert']);
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

  it('plans, creates, observes and deletes only the second environment bucket instance', async () => {
    const fixture = await railwayHttpFixture();
    const production = structuredClone(fixture.environments.get(productionId));
    const spec = environmentSpecSchema.parse({
      hosting: { provider: 'railway' }, services: {},
      storage: { documents: { provider: 'railway', type: 'bucket', region: 'sjc', injectInto: [] } },
    });
    const plan = async () => planStorage({
      environmentSpec: spec, environment: fixture.environment,
      observed: await fixture.adapter.observe(fixture.environment),
    });
    expect((await plan()).actions).toContainEqual(expect.objectContaining({
      id: 'storage:documents', type: 'create', billable: true,
    }));
    const result = await fixture.adapter.ensureStorage(fixture.environment, 'documents', { region: 'sjc' });
    expect(result, JSON.stringify(fixture.contractErrors)).toMatchObject({
      success: true, data: { externalId: 'bucket-documents' },
    });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['environmentPatchCommit']);
    const live = await fixture.adapter.observe(fixture.environment);
    expect(live.storage).toEqual([expect.objectContaining({
      name: 'documents', externalId: 'bucket-documents', region: 'sjc', objectCount: 0,
      instanceScope: { projectId, environmentId: stagingId },
    })]);
    // Present in this environment without a binding is adoption, not creation.
    const before = fixture.mutations.length;
    expect((await plan()).actions[0].metadata?.blockedReason).toBe('unmanaged_conflict');
    expect(await fixture.adapter.ensureStorage(fixture.environment, 'documents', { region: 'sjc' }))
      .toMatchObject({ success: false, data: { mutationAttempted: false } });
    expect(fixture.mutations).toHaveLength(before);
    fixture.environment.platformBindings.storage = {
      documents: { provider: 'railway', externalId: 'bucket-documents',
        instanceScope: { projectId, environmentId: stagingId }, region: 'sjc', services: [], envKeys: [] },
    };
    expect((await plan()).actions.every((action) => action.type === 'noop')).toBe(true);
    expect(await fixture.adapter.destroyStorage(fixture.environment, 'bucket-documents')).toMatchObject({ success: true });
    expect((await fixture.adapter.observe(fixture.environment)).storage).toEqual([]);
    const afterDelete = fixture.mutations.length;
    expect(await fixture.adapter.destroyStorage(fixture.environment, 'bucket-documents')).toMatchObject({ success: true });
    expect(fixture.mutations).toHaveLength(afterDelete);
    expect(fixture.environments.get(productionId)).toEqual(production);
    expect(fixture.buckets.get('bucket-documents')?.name).toBe('documents');
    expect(fixture.contractErrors).toEqual([]);
  });

  it('does not create an instance when the selected environment bucket read is unknown', async () => {
    const fixture = await railwayHttpFixture({ responseOverride: ({ query }) => query.includes('GetBucketState')
      ? Response.json({ errors: [{ message: 'denied' }] }, { status: 403 }) : undefined });
    expect(await fixture.adapter.ensureStorage(fixture.environment, 'documents', { region: 'sjc' }))
      .toMatchObject({ success: false, data: { mutationAttempted: false } });
    expect(fixture.mutations).toEqual([]);
  });

  it('preserves an instance that appears between planning and the scoped create patch', async () => {
    let reads = 0;
    const fixture = await railwayHttpFixture({ responseOverride: ({ query }) => {
      if (query.includes('GetBucketState') && ++reads === 2) {
        fixture.environments.get(stagingId)!.config.buckets = {
          'bucket-documents': { region: 'ams', isCreated: true, isDeleted: false },
        };
      }
      return undefined;
    } });
    expect(await fixture.adapter.ensureStorage(fixture.environment, 'documents', { region: 'sjc' }))
      .toMatchObject({ success: false, data: { mutationAttempted: false } });
    expect(fixture.mutations).toEqual([]);
    expect(fixture.environments.get(stagingId)!.config.buckets!['bucket-documents'].region).toBe('ams');
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
