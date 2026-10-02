import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import { diffEnvironment } from '../../../../domain/plan/diff.engine.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from './railway-http.fixture.js';

afterEach(() => vi.unstubAllGlobals());

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}, image = 'ghcr.io/railwayapp-templates/postgres-ssl:17') {
  const http = await railwayHttpFixture(options);
  const instance = http.addService('staging-postgres', 'postgres', stagingId).instances.get(stagingId)!;
  instance.source = { image };
  Object.assign(instance, { latestDeployment: { id: 'database-deployment', status: 'SUCCESS' } });
  const component: Component = {
    id: 'local-db', environmentId: http.environment.id, type: 'postgres', externalId: 'staging-postgres',
    bindings: { provider: 'railway', resourceKind: 'service', providerScope: { projectId, environmentId: stagingId } },
    createdAt: new Date(), updatedAt: new Date(),
  };
  const databaseAdapter = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter,
    envRepo: { findById: () => http.environment } as never });
  return { ...http, databaseAdapter, component, instance };
}

/** Actual graphql-request serialization against the pinned official Railway SDL.
 * Project.environments/services and ServiceInstance.serviceId/environmentId are
 * independent provider state, not request echoes. Images and state are synthetic;
 * these tests establish the observation boundary, not live Railway compatibility.
 */
describe('Railway bound database observation API contract', () => {
  it.each(['ghcr.io/railwayapp-templates/postgres-ssl:17', 'registry.example.test/team/database:17'])(
    'preserves verified environment scope for a repaired binding using %s', async (image) => {
      const f = await fixture({}, image);
      const hosting = await f.adapter.observe(f.environment);
      expect(hosting.databases).toEqual([]);
      expect(hosting.services).toContainEqual(expect.objectContaining({ externalId: f.component.externalId }));

      const database = await f.databaseAdapter.observeDatabase(f.environment, f.component);
      const result = diffEnvironment({
        spec: environmentSpecSchema.parse({ hosting: { provider: 'railway' }, database: { provider: 'railway' } }),
        envName: 'staging', observed: { ...hosting, databases: [database!] },
        local: { projectExists: true, environmentExists: true, services: [], components: [f.component],
          bindings: { provider: 'railway', projectId, environmentId: stagingId } },
      });
      expect(result.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'noop', verified: true });
      expect(database?.providerScope).toEqual({ projectId, environmentId: stagingId });
      expect(f.requests.some(request => request.query.includes('query GetServiceEnvironmentInstance'))).toBe(true);
      expect(f.contractErrors).toEqual([]);
      expect(f.mutations).toEqual([]);
    });

  it('verifies environment membership for a legacy project-only binding', async () => {
    const f = await fixture();
    f.component.bindings = { provider: 'railway', resourceKind: 'service', projectId };
    expect(await f.databaseAdapter.observeDatabase(f.environment, f.component)).toMatchObject({
      externalId: f.component.externalId, providerScope: { projectId, environmentId: stagingId },
    });
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it.each(['different durable environment', 'missing current environment', 'name-resolved replacement environment'])(
    'blocks %s instead of manufacturing environment membership', async (scenario) => {
      const f = await fixture();
      if (scenario === 'different durable environment') f.component.bindings.providerScope = { projectId, environmentId: productionId };
      if (scenario === 'missing current environment') delete f.environment.platformBindings.environmentId;
      if (scenario === 'name-resolved replacement environment') {
        f.environment.platformBindings.environmentId = 'retired-environment';
        f.component.bindings.providerScope = { projectId, environmentId: 'retired-environment' };
      }
      await expect(f.databaseAdapter.observeDatabase(f.environment, f.component)).rejects.toThrow();
      expect(f.contractErrors).toEqual([]);
      expect(f.mutations).toEqual([]);
    });

  it.each(['serviceId', 'environmentId', 'id', 'deletedAt'] as const)(
    'blocks incomplete exact-instance %s evidence', async (field) => {
      // Deliberately malformed negative transport response; the pinned SDL cannot
      // emit omitted non-null identity fields in a successful response.
      const f = await fixture({ responseOverride: ({ query }) => {
        if (!query.includes('query GetServiceEnvironmentInstance')) return undefined;
        const instance: Record<string, unknown> = { id: 'exact-instance', serviceId: 'staging-postgres',
          environmentId: stagingId, deletedAt: null, source: { image: 'custom-database:17' } };
        delete instance[field];
        return Response.json({ data: { serviceInstance: instance } });
      } });
      await expect(f.databaseAdapter.observeDatabase(f.environment, f.component)).rejects.toThrow();
      expect(f.mutations).toEqual([]);
    });

  it.each(['wrong service', 'wrong environment', 'deleted instance', 'denied', 'missing instance'])(
    'blocks %s in exact-instance verification', async (scenario) => {
      const f = await fixture({ responseOverride: ({ query }) => {
        if (!query.includes('query GetServiceEnvironmentInstance')) return undefined;
        if (scenario === 'denied') return Response.json({ errors: [{ message: 'synthetic denied' }] }, { status: 403 });
        // Change provider state after aggregate observation, before the exact read.
        if (scenario === 'missing instance') f.services.get('staging-postgres')!.instances.delete(stagingId);
        if (scenario === 'wrong environment') f.instance.environmentId = productionId;
        return undefined;
      } });
      if (scenario === 'wrong service') f.instance.serviceId = 'another-service';
      if (scenario === 'deleted instance') f.instance.deletedAt = '2026-10-01T00:00:00Z';
      await expect(f.databaseAdapter.observeDatabase(f.environment, f.component)).rejects.toThrow();
      expect(f.contractErrors).toEqual([]);
      expect(f.mutations).toEqual([]);
    });

  it('blocks mismatched provider project evidence', async () => {
    const f = await fixture({ responseOverride: ({ query }) => query.includes('query GetProjectDetails')
      ? Response.json({ data: { project: { id: 'another-project', name: 'other' } } }) : undefined });
    await expect(f.databaseAdapter.observeDatabase(f.environment, f.component)).rejects.toThrow('mismatched project');
    expect(f.mutations).toEqual([]);
  });
});
