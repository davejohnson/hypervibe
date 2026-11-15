import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../../../../domain/entities/component.entity.js';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { postgresTemplate, productionId, projectId, railwayHttpFixture, stagingId } from './railway-http.fixture.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_ATTEMPTS', '2');
  vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
});

async function fixture(mountPath = '/var/lib/postgresql/data', image?: string) {
  const http = await railwayHttpFixture();
  const official = Object.values(postgresTemplate.serializedConfig.services)[0] as { source: { image: string } };
  http.addService('retained-postgres', 'Postgres', stagingId).instances.get(stagingId)!.source = { image: image ?? official.source.image };
  const volume = http.addVolume('retained-postgres', stagingId, mountPath);
  const productionVolume = http.addVolume('production-postgres-db', productionId, mountPath);
  const component: Component = { id: 'retained-component', environmentId: http.environment.id,
    type: 'postgres', externalId: 'retained-postgres', createdAt: new Date(), updatedAt: new Date(),
    bindings: { provider: 'railway', resourceKind: 'service', retainedCleanup: true,
      providerScope: { projectId, environmentId: stagingId }, volumeId: volume.id,
      volumeTarget: { projectId, environmentId: stagingId, serviceId: 'retained-postgres', mountPath } } };
  // Retained resources must use their recorded scope even after hosting moved.
  const adapter = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter,
    envRepo: { findById: () => ({ ...http.environment, platformBindings: { projectId: 'new-project', environmentId: 'new-environment' } }) } });
  return { ...http, adapter, component, volume, productionVolume };
}

// Image evidence is the recorded official database template. Scoped identity,
// service deletion and volume deletion execute real graphql-request transport
// against the pinned Railway SDL with synthetic provider state.
describe('Railway retained database template lifecycle', () => {
  it('observes and deletes an official template database, preserving another environment and allowing a deletion retry', async () => {
    const f = await fixture();
    expect(await f.adapter.observeDatabase(f.environment, f.component)).toMatchObject({
      externalId: 'retained-postgres', providerScope: { projectId, environmentId: stagingId },
    });
    const result = await f.adapter.destroy(f.component);
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['serviceDelete', 'volumeDelete']);
    expect(f.services.get('production-postgres-db')!.instances.get(productionId)!.deletedAt).toBeNull();
    expect(f.productionVolume.instance.deletedAt).toBeNull();
    expect((await f.adapter.destroy(f.component)).success).toBe(true);
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['serviceDelete', 'volumeDelete']);
    expect(f.contractErrors).toEqual([]);
  });

  it('honors an existing recorded data mount after observing its exact scoped volume', async () => {
    const f = await fixture('/srv/postgres', 'postgres:17');
    const result = await f.adapter.destroy(f.component);
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    expect(f.mutations.map(mutation => mutation.field)).toEqual(['serviceDelete', 'volumeDelete']);
    expect(f.productionVolume.instance.deletedAt).toBeNull();
    expect(f.contractErrors).toEqual([]);
  });

  it.each(['relative/data', '/srv/../postgres', '/srv/./postgres', '/srv/${{PGDATA}}', '/srv/postgres\0bad'])(
    'rejects an unsafe recorded mount %s before mutation', async mountPath => {
      const f = await fixture('/srv/postgres', 'postgres:17');
      (f.component.bindings.volumeTarget as Record<string, unknown>).mountPath = mountPath;
      expect((await f.adapter.destroy(f.component)).success).toBe(false);
      expect(f.mutations).toEqual([]);
    });

  it.each(['environmentId', 'serviceId', 'projectId', 'mountPath'])(
    'rejects a recorded volume %s that contradicts its provider scope', async field => {
      const f = await fixture('/srv/postgres', 'postgres:17');
      (f.component.bindings.volumeTarget as Record<string, unknown>)[field] = field === 'mountPath' ? '/different-mount' : 'different';
      expect((await f.adapter.destroy(f.component)).success).toBe(false);
      expect(f.mutations).toEqual([]);
    });

  it.each(['registry.example.test/postgres:17', 'ghcr.io/railwayapp-templates/postgres-ssl-impostor:18'])(
    'does not authorize deletion from an unverified image %s', async image => {
      const f = await fixture('/var/lib/postgresql/data', image);
      expect((await f.adapter.destroy(f.component)).success).toBe(false);
      expect(f.mutations).toEqual([]);
    });
});
