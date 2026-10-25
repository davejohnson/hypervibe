import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import { diffEnvironment } from '../../../../domain/plan/diff.engine.js';
import { fingerprintObservedState } from '../../../../domain/plan/converge.executor.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from './railway-http.fixture.js';

afterEach(() => vi.unstubAllGlobals());

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const http = await railwayHttpFixture(options);
  const service = http.addService('staging-postgres', 'postgres-db', stagingId);
  Object.assign(service.instances.get(stagingId)!, {
    source: { image: 'postgres:16' }, latestDeployment: { id: 'database-deployment', status: 'SUCCESS' },
  });
  http.variables.set(`staging-postgres/${stagingId}`, { PGDATA: '/var/lib/postgresql/data/pgdata' });
  const component: Component = {
    id: 'local-db', environmentId: http.environment.id, type: 'postgres', externalId: 'staging-postgres',
    bindings: { provider: 'railway', resourceKind: 'service', providerScope: { projectId, environmentId: stagingId } },
    createdAt: new Date(), updatedAt: new Date(),
  };
  const observe = async () => {
    const observed = await http.adapter.observe(http.environment);
    const diff = diffEnvironment({
      spec: environmentSpecSchema.parse({ hosting: { provider: 'railway' }, database: { provider: 'railway' },
        services: { web: { startCommand: 'npm start' } } }),
      envName: 'staging', observed,
      local: { projectExists: true, environmentExists: true, services: [], components: [component],
        bindings: { provider: 'railway', projectId, environmentId: stagingId } },
    });
    return { observed, database: observed.databases.find(database => database.externalId === component.externalId), diff };
  };
  return { ...http, component, observe, service };
}

// Assumption under test: a successful PostgreSQL deployment proves its data is
// persistent. Railway explicitly requires a volume at the application's data
// path: https://docs.railway.com/volumes. PostgreSQL's PGDATA selects that path:
// https://www.postgresql.org/docs/16/runtime-config-file-locations.html.
// Official 16/17 image defaults and PostgreSQL 18's versioned directory:
// https://github.com/docker-library/docs/blob/master/postgres/README.md#pgdata.
// Railway's current template explicitly overrides that default (recorded in
// test/provider-contracts/railway/postgres-template.recorded.json).
// GraphQL requests/responses execute against the pinned official Railway SDL;
// volume attachments, variables and deployment state are synthetic independent
// state. This is not a recorded incident or a live restart/restore test.
describe('Railway database persistence through serialized GraphQL and shared diff', () => {
  it('blocks a running database with no data volume, including when production has one', async () => {
    const f = await fixture();
    f.addVolume('production-postgres-db', productionId, '/var/lib/postgresql/data');
    const { database, diff } = await f.observe();
    expect(database?.status).toBe('running');
    expect(diff.actions.find(action => action.id === 'database:railway')).toMatchObject({
      type: 'update', verified: true, metadata: { blockedReason: 'database_persistence_missing' },
    });
    expect(diff.actions.find(action => action.resource.kind === 'service')?.dependsOn).toContain('database:railway');
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it('blocks a running database whose PGDATA is outside its attached volume', async () => {
    const f = await fixture();
    f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    f.variables.set(`staging-postgres/${stagingId}`, { PGDATA: '/tmp/ephemeral-postgres' });
    const { diff } = await f.observe();
    expect(diff.actions.find(action => action.id === 'database:railway')).toMatchObject({
      type: 'update', metadata: { blockedReason: 'database_persistence_missing' },
    });
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it('invalidates a reviewed observation when the data volume disappears', async () => {
    const f = await fixture();
    f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const before = await f.observe();
    f.volumes.clear();
    const after = await f.observe();
    expect(fingerprintObservedState(after.observed)).not.toBe(fingerprintObservedState(before.observed));
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it.each([
    { image: 'postgres:16', mount: '/var/lib/postgresql/data', data: undefined },
    { image: 'docker.io/library/postgres:17.6-bookworm', mount: '/var/lib/postgresql/data', data: undefined },
    { image: 'postgres:18', mount: '/var/lib/postgresql', data: '/var/lib/postgresql/18/docker' },
    { image: 'ghcr.io/railwayapp-templates/postgres-ssl:18', mount: '/var/lib/postgresql/data', data: '/var/lib/postgresql/data/pgdata' },
  ])('verifies configured storage for $image without requiring the legacy mount', async ({ image, mount, data }) => {
    const f = await fixture();
    f.service.instances.get(stagingId)!.source = { image };
    f.variables.set(`staging-postgres/${stagingId}`, data ? { PGDATA: data } : {});
    f.addVolume('staging-postgres', stagingId, mount);
    const { database, diff } = await f.observe();
    expect(database?.persistence).toMatchObject({ state: 'configured', configurationFingerprint: expect.any(String) });
    expect(diff.actions.find(action => action.id === 'database:railway')).toMatchObject({ type: 'noop', verified: true });
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it.each([
    { data: '/var/lib/postgresql/database/pgdata', state: 'missing' },
    { data: '/var/lib/postgresql/data/../elsewhere', state: 'unknown' },
    { data: 'relative/data', state: 'unknown' },
    { data: '${{UNRESOLVED_DIRECTORY}}', state: 'unknown' },
    { data: '', state: 'unknown' },
  ])('rejects uncovered or unresolved directory $data', async ({ data, state }) => {
    const f = await fixture();
    f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    f.variables.set(`staging-postgres/${stagingId}`, { PGDATA: data });
    const { database, diff } = await f.observe();
    expect(database?.persistence?.state).toBe(state);
    expect(diff.actions.find(action => action.id === 'database:railway')?.metadata?.blockedReason)
      .toBe(`database_persistence_${state}`);
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it.each(['detached', 'deleted', 'pending', 'duplicate'] as const)('rejects %s volume evidence', async scenario => {
    const f = await fixture();
    f.addVolume(scenario === 'detached' ? null : 'staging-postgres', stagingId, '/var/lib/postgresql/data', {
      ...(scenario === 'deleted' ? { deletedAt: '2026-10-01T00:00:00Z' } : {}),
      ...(scenario === 'pending' ? { isPendingDeletion: true } : {}),
    });
    if (scenario === 'duplicate') f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql');
    const { database, diff } = await f.observe();
    const state = scenario === 'detached' || scenario === 'deleted' ? 'missing' : 'unknown';
    expect(database?.persistence?.state).toBe(state);
    expect(diff.actions.find(action => action.id === 'database:railway')).toMatchObject({
      type: 'update', metadata: { blockedReason: `database_persistence_${state}` },
    });
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it('fully paginates before accepting the exact data volume in staging', async () => {
    const f = await fixture({ pageSize: 1 });
    f.addVolume(null, stagingId, '/unrelated');
    f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const { database } = await f.observe();
    expect(database?.persistence?.state).toBe('configured');
    expect(f.requests.filter(request => request.query.includes('query EnvironmentVolumeInstances'))).toHaveLength(2);
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it.each(['GetVariables', 'EnvironmentVolumeInstances', 'DatabasePersistenceTarget'])(
    'keeps denied %s reads unknown and value-free', async deniedQuery => {
      const secret = 'synthetic-provider-echo-private';
      const f = await fixture({ responseOverride: request => request.query.includes(`query ${deniedQuery}`)
        ? Response.json({ errors: [{ message: secret }] }, { status: 403 }) : undefined });
      f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
      const { database, diff } = await f.observe();
      expect(database?.persistence?.state).toBe('unknown');
      expect(diff.actions.find(action => action.id === 'database:railway')).toMatchObject({
        type: 'update', verified: false, metadata: { blockedReason: 'database_persistence_unknown' },
      });
      expect(JSON.stringify({ database, diff })).not.toContain(secret);
      expect(f.mutations).toEqual([]);
    });

  it('keeps unsupported image defaults and custom startup overrides unknown', async () => {
    const f = await fixture();
    f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    f.service.instances.get(stagingId)!.source = { image: 'postgres:18' };
    f.variables.set(`staging-postgres/${stagingId}`, {});
    expect((await f.observe()).database?.persistence?.state).toBe('unknown');
    f.variables.set(`staging-postgres/${stagingId}`, { PGDATA: '/var/lib/postgresql/data/pgdata' });
    Object.assign(f.service.instances.get(stagingId)!, { startCommand: 'postgres -D /tmp/data' });
    expect((await f.observe()).database?.persistence?.state).toBe('unknown');
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  it('invalidates a reviewed observation when a same-path replacement volume appears', async () => {
    const f = await fixture();
    f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const before = await f.observe();
    f.volumes.clear();
    f.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
    const after = await f.observe();
    expect(before.database?.persistence?.state).toBe('configured');
    expect(after.database?.persistence?.state).toBe('configured');
    expect(fingerprintObservedState(after.observed)).not.toBe(fingerprintObservedState(before.observed));
    expect(f.contractErrors).toEqual([]);
    expect(f.mutations).toEqual([]);
  });
});
