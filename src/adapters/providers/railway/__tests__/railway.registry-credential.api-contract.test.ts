import { readFileSync } from 'node:fs';
import { buildSchema, graphql } from 'graphql';
import { afterEach, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

// Synthetic state through the pinned official Railway GraphQL schema.
// RegistryCredentialsInput is typed; mutation edits only that field.
afterEach(() => vi.unstubAllGlobals());
it('updates only pull credentials on the exact bound service and preserves image', async () => {
  const schema = buildSchema(readFileSync('test/provider-contracts/railway/schema.graphql', 'utf8'));
  const writes: unknown[] = [];
  const instance = { id: 'instance', serviceId: 'service', environmentId: 'env', deletedAt: null, source: { image: 'ghcr.io/acme/app@sha256:abcdef', repo: null } };
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json(await graphql({ schema, source: body.query, variableValues: body.variables, rootValue: {
      project: () => ({ id: 'project' }), environment: () => ({ id: 'env', projectId: 'project', deletedAt: null }),
      service: () => ({ id: 'service', projectId: 'project', deletedAt: null }), serviceInstance: () => instance,
      serviceInstanceUpdate: (args: unknown) => { writes.push(args); return true; },
    } }));
  }));
  const adapter = new RailwayAdapter(); await adapter.connect({ apiToken: 'synthetic-management-token' });
  const environment = { createdAt: new Date(), updatedAt: new Date(), id: 'local', projectId: 'local-project', name: 'production', platformBindings: { provider: 'railway', projectId: 'project', environmentId: 'env', services: { web: { serviceId: 'service' } } } } as Environment;
  const port = adapter.registryCredentialLifecycle;
  expect(port).toBeDefined();
  const target = await port.inspect(environment, 'web');
  expect(target).toMatchObject({ provider: 'railway', serviceId: 'service', instanceId: 'instance', image: instance.source.image });
  expect(await port.update(environment, 'web', target, { username: 'reader', token: 'synthetic-package-token' })).toMatchObject({ success: true });
  expect(writes).toEqual([{ serviceId: 'service', environmentId: 'env', input: { registryCredentials: { username: 'reader', password: 'synthetic-package-token' } } }]);
  expect(instance.source.image).toBe('ghcr.io/acme/app@sha256:abcdef');
  instance.id = 'recreated-instance';
  expect(await port.update(environment, 'web', target, { username: 'reader', token: 'synthetic-package-token' })).toMatchObject({ success: false });
  expect(writes).toHaveLength(1);
});
