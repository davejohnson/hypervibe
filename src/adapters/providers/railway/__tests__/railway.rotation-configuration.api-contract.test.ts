import { afterEach, expect, it, vi } from 'vitest';
import type { GraphQLClient } from 'graphql-request';
import type { Component } from '../../../../domain/entities/component.entity.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { createRailwayDatabaseRotationConfiguration } from '../railway-database-rotation.js';
import { railwayHttpFixture, projectId, stagingId } from './railway-http.fixture.js';

// Real serialized GraphQL clients against the pinned SDL. Variable/reference
// responses are reconstructed from https://docs.railway.com/variables and
// https://docs.railway.com/integrations/api/manage-variables, not a live recording.
// Existing-access runtime proof is synthetic here; the emitted pg program and
// native SQL mutation have separate wire and disposable PostgreSQL tests.
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const old = 'old-synthetic-password', replacement = 'next-synthetic-password';
const reference = '${{Postgres.DATABASE_URL}}';
const url = (password: string) => `postgresql://app:${password}@database.internal/railway`;
async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const f = await railwayHttpFixture({ renderVariableReferences: true, pageSize: 2, ...options });
  f.addService('database', 'Postgres', stagingId);
  f.variables.set(`database/${stagingId}`, { POSTGRES_PASSWORD: old, PGPASSWORD: '${{POSTGRES_PASSWORD}}',
    DATABASE_URL: url('${{POSTGRES_PASSWORD}}'), PGUSER: 'app', PGDATABASE: 'railway' });
  f.environment.platformBindings.services = {};
  for (const name of ['web', 'worker']) {
    f.addService(name, name, stagingId).instances.get(stagingId)!.latestDeployment = { id: `${name}-deployment`, status: 'SUCCESS' };
    (f.environment.platformBindings.services as Record<string, unknown>)[name] = { serviceId: name };
    f.variables.set(`${name}/${stagingId}`, { DATABASE_URL: reference, POSTGRES_DB_URL: reference, CUSTOM_DATABASE_URL: '${{POSTGRES_DB_URL}}' });
  }
  const component = { createdAt: new Date(), updatedAt: new Date(), id: 'local-db', environmentId: f.environment.id, type: 'postgres', externalId: 'database',
    bindings: { provider: 'railway', resourceKind: 'service', providerScope: { projectId, environmentId: stagingId }, pluginName: 'Postgres' } } as Component;
  const target = { provider: 'railway', componentId: component.id, environmentId: f.environment.id, externalId: 'database',
    providerScope: { projectId, environmentId: stagingId }, username: 'app', database: 'railway', inputMode: 'supplied' as const,
    connection: { host: 'database.internal', port: 5432, username: 'app', database: 'railway' } };
  const read = vi.fn(async () => ({ state: 'verified' as const, authentication: 'rejected' as const }));
  const port = createRailwayDatabaseRotationConfiguration(() => Reflect.get(f.adapter, 'client') as GraphQLClient, { read });
  const required = { web: ['DATABASE_URL', 'POSTGRES_DB_URL'], worker: ['DATABASE_URL', 'POSTGRES_DB_URL'] };
  const review = await port.inspect(f.environment, component, target, replacement, required);
  return { ...f, port, component, target, read, required, review };
}

it('reviews all indirect aliases through paginated exact scope and synchronizes only the issuer', async () => {
  const f = await fixture();
  expect(f.review.consumers).toHaveLength(2);
  for (const consumer of f.review.consumers) expect(consumer.envVarHashes).toEqual(Object.fromEntries(
    ['CUSTOM_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_DB_URL'].map(key => [key, hashEnvValue(url(replacement))])));
  expect(f.mutations).toEqual([]);
  expect(await f.port.synchronize(f.environment, f.component, f.target, replacement, f.review)).toEqual({ state: 'acknowledged' });
  expect(await f.port.observe(f.environment, f.component, f.target, replacement, f.review)).toEqual({ issuer: 'match', references: 'match' });
  expect(f.variables.get(`worker/${stagingId}`)!.DATABASE_URL).toBe(reference);
  expect(f.mutations.map(item => item.field)).toEqual(['variableCollectionUpsert']);
  expect(f.mutations[0].args.input).toMatchObject({ serviceId: 'database', variables: { POSTGRES_PASSWORD: replacement }, replace: false, skipDeploys: true });
  expect(f.contractErrors).toEqual([]);
});

it('recovers a lost issuer acknowledgment by readback without a second mutation', async () => {
  const f = await fixture({ dropVariableResponse: true });
  expect(await f.port.synchronize(f.environment, f.component, f.target, replacement, f.review)).toEqual({ state: 'unknown' });
  expect(await f.port.observe(f.environment, f.component, f.target, replacement, f.review)).toEqual({ issuer: 'match', references: 'match' });
  expect(await f.port.synchronize(f.environment, f.component, f.target, replacement, f.review)).toEqual({ state: 'acknowledged' });
  expect(f.mutations).toHaveLength(1); expect(f.contractErrors).toEqual([]);
});

it.each(['changed-reference', 'copied-url', 'unlisted-consumer', 'new-instance', 'missing-alias', 'extra-driver-settings'])(
  'rejects changed private evidence before an issuer write: %s', async change => {
    const f = await fixture();
    if (change === 'changed-reference') f.variables.get(`worker/${stagingId}`)!.POSTGRES_DB_URL = '${{DATABASE_URL}}';
    if (change === 'copied-url') f.variables.get(`worker/${stagingId}`)!.CUSTOM_DATABASE_URL = url(old);
    if (change === 'unlisted-consumer') { f.addService('other', 'other', stagingId); f.variables.set(`other/${stagingId}`, { DB: reference }); }
    if (change === 'new-instance') f.services.get('worker')!.instances.get(stagingId)!.id = 'new-instance';
    if (change === 'missing-alias') delete f.variables.get(`worker/${stagingId}`)!.POSTGRES_DB_URL;
    if (change === 'extra-driver-settings') f.variables.get(`worker/${stagingId}`)!.PGOPTIONS = '-c search_path=public';
    expect(await f.port.synchronize(f.environment, f.component, f.target, replacement, f.review)).toEqual({ state: 'blocked' });
    expect(f.mutations).toEqual([]); expect(f.contractErrors).toEqual([]);
  });
