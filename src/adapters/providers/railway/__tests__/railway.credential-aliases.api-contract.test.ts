import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from './railway-http.fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const canonical = 'synthetic-current-password';
const stale = 'synthetic-old-password';
const ref = '${{POSTGRES_PASSWORD}}';
const uri = (password: string) => `postgresql://postgres:${password}@synthetic-old-password.internal:5432/synthetic-old-password?application_name=synthetic-old-password`;

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const http = await railwayHttpFixture({ renderVariableReferences: true, ...options });
  http.addService('staging-db', 'postgres-db-staging', stagingId).instances.get(stagingId)!.source = { image: 'postgres:16' };
  const component: Component = { id: 'local-db', environmentId: http.environment.id, type: 'postgres', externalId: 'staging-db',
    bindings: { provider: 'railway', resourceKind: 'service', providerScope: { projectId, environmentId: stagingId } },
    createdAt: new Date(), updatedAt: new Date() };
  const variables = { POSTGRES_PASSWORD: canonical, PGPASSWORD: stale, DATABASE_URL: uri(stale),
    DATABASE_PRIVATE_URL: uri(stale), PGUSER: 'postgres', PGDATABASE: 'postgres', KEEP: 'unrelated' };
  http.variables.set(`staging-db/${stagingId}`, variables);
  http.variables.set(`production-postgres-db/${productionId}`, { ...variables });
  const database = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter,
    envRepo: { findById: () => http.environment } as never });
  return { ...http, component, database, input: { component, environment: http.environment } };
}

// Real graphql-request transport and pinned Railway SDL. Opaque variable maps
// use synthetic state reconstructed from the official manage-variables docs:
// unrendered references, deployment rendering, additive upsert and skipDeploys.
// This proves configuration reconciliation, not live SQL or running containers.
describe('Railway database credential alias API contract', () => {
  it('repairs only stale aliases, preserving the issuer and each URL target byte-for-byte', async () => {
    const f = await fixture();
    expect(f.database.credentialAliases).toBeDefined();
    const capability = f.database.credentialAliases!;
    const expected = await capability.inspect(f.input);
    expect(expected.changeNames).toEqual(['DATABASE_PRIVATE_URL', 'DATABASE_URL', 'PGPASSWORD']);
    expect(f.mutations).toEqual([]);
    const beforeWrite = vi.fn(async () => { expect(f.mutations).toHaveLength(0); });
    const result = await capability.repair({ ...f.input, expected, allowWrite: true, beforeWrite });
    expect(result).toMatchObject({ success: true, data: { requestedCount: 3, appliedCount: 3, skippedCount: 0,
      referencesVerified: true, authentication: 'unchecked', deploymentDeferred: true } });
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(f.mutations).toEqual([{ field: 'variableCollectionUpsert', args: { input: {
      projectId, environmentId: stagingId, serviceId: 'staging-db', replace: false, skipDeploys: true,
      variables: { PGPASSWORD: ref, DATABASE_URL: uri(ref), DATABASE_PRIVATE_URL: uri(ref) },
    } } }]);
    expect(f.variables.get(`staging-db/${stagingId}`)).toMatchObject({ POSTGRES_PASSWORD: canonical, KEEP: 'unrelated' });
    expect(f.variables.get(`production-postgres-db/${productionId}`)?.PGPASSWORD).toBe(stale);
    expect(JSON.stringify(result)).not.toContain(canonical);
    expect(JSON.stringify(result)).not.toContain(stale);
    expect(f.contractErrors).toEqual([]);
  });

  it('performs zero writes for already-correct references', async () => {
    const f = await fixture();
    Object.assign(f.variables.get(`staging-db/${stagingId}`)!, { PGPASSWORD: ref, DATABASE_URL: uri(ref), DATABASE_PRIVATE_URL: uri(ref) });
    const expected = await f.database.credentialAliases!.inspect(f.input);
    expect(expected.changeNames).toEqual([]);
    const beforeWrite = vi.fn();
    const result = await f.database.credentialAliases!.repair({ ...f.input, expected, allowWrite: true, beforeWrite });
    expect(result).toMatchObject({ success: true, data: { appliedCount: 0, skippedCount: 3, referencesVerified: true } });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(f.mutations).toEqual([]);
  });

  it.each(['canonical password', 'URL target', 'local environment', 'instance identity'])(
    'blocks changed %s before any write', async scenario => {
      const f = await fixture();
      const expected = await f.database.credentialAliases!.inspect(f.input);
      if (scenario === 'canonical password') f.variables.get(`staging-db/${stagingId}`)!.POSTGRES_PASSWORD = 'different';
      if (scenario === 'URL target') f.variables.get(`staging-db/${stagingId}`)!.DATABASE_URL = uri(stale).replace('.internal', '.other');
      if (scenario === 'local environment') f.environment.platformBindings.environmentId = productionId;
      if (scenario === 'instance identity') f.services.get('staging-db')!.instances.get(stagingId)!.id = 'replacement-instance';
      const result = await f.database.credentialAliases!.repair({ ...f.input, expected, allowWrite: true, beforeWrite: vi.fn() });
      expect(result.success).toBe(false);
      expect(f.mutations).toEqual([]);
    });

  it('refuses to repeat an uncertain write while references remain old', async () => {
    const f = await fixture();
    const expected = await f.database.credentialAliases!.inspect(f.input);
    const result = await f.database.credentialAliases!.repair({ ...f.input, expected, allowWrite: false, beforeWrite: vi.fn() });
    expect(result.success).toBe(false);
    expect(f.mutations).toEqual([]);
  });

  it('reconciles a committed write after its response was lost, without repeating it', async () => {
    let lose = true;
    const f = await fixture({ responseOverride: request => {
      if (request.query.includes('mutation RepairDatabaseCredentialAliases') && lose) {
        lose = false;
        Object.assign(f.variables.get(`staging-db/${stagingId}`)!, request.variables.values);
        throw new TypeError('synthetic response lost');
      }
      return undefined;
    } });
    const expected = await f.database.credentialAliases!.inspect(f.input);
    const first = await f.database.credentialAliases!.repair({ ...f.input, expected, allowWrite: true, beforeWrite: vi.fn() });
    expect(first.success).toBe(false);
    const second = await f.database.credentialAliases!.repair({ ...f.input, expected, allowWrite: false, beforeWrite: vi.fn() });
    expect(second).toMatchObject({ success: true, data: { appliedCount: 0, skippedCount: 3, referencesVerified: true } });
    expect(f.requests.filter(r => r.query.includes('mutation RepairDatabaseCredentialAliases'))).toHaveLength(1);
  });

  it('does not treat false acknowledgement as completion', async () => {
    const f = await fixture({ responseOverride: request => request.query.includes('mutation RepairDatabaseCredentialAliases')
      ? Response.json({ data: { variableCollectionUpsert: false } }) : undefined });
    const expected = await f.database.credentialAliases!.inspect(f.input);
    const result = await f.database.credentialAliases!.repair({ ...f.input, expected, allowWrite: true, beforeWrite: vi.fn() });
    expect(result.success).toBe(false);
  });

  it('does not claim convergence when an unreviewed public URL appears during recovery', async () => {
    const f = await fixture();
    const expected = await f.database.credentialAliases!.inspect(f.input);
    Object.assign(f.variables.get(`staging-db/${stagingId}`)!, { PGPASSWORD: ref, DATABASE_URL: uri(ref),
      DATABASE_PRIVATE_URL: uri(ref), DATABASE_PUBLIC_URL: uri(stale) });
    const result = await f.database.credentialAliases!.repair({ ...f.input, expected, allowWrite: false, beforeWrite: vi.fn() });
    expect(result.success).toBe(false);
    expect(f.mutations).toEqual([]);
  });

  it('blocks incomplete variable evidence rather than treating it as an empty configuration', async () => {
    const f = await fixture({ responseOverride: request => request.query.includes('query DatabaseCredentialAliasVariables')
      ? Response.json({ data: { definitions: null, rendered: {} } }) : undefined });
    await expect(f.database.credentialAliases!.inspect(f.input)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });
});
