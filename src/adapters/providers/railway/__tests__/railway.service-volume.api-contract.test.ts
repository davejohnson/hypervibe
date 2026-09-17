import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectId, productionId, stagingId, railwayHttpFixture } from './railway-http.fixture.js';

const target = { projectId, environmentId: stagingId, serviceId: 'staging-web', mountPath: '/data' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** Synthetic HTTP state executed against the pinned official Railway schema.
 * One-volume-per-service/no-replica semantics: https://docs.railway.com/volumes/reference
 * No live filesystem, server readiness, or resource deletion is exercised here.
 */
describe('Railway retain-only web volumes through serialized GraphQL', () => {
  it('requires a returned creation identity instead of adopting a match after a lost response', async () => {
    const fixture = await railwayHttpFixture({ dropVolumeCreateResponse: true });
    fixture.addService(target.serviceId, 'web', stagingId);
    // Exercise the reused real transport helper as well as the public capability.
    // Before this feature, its target-only recovery falsely proved ownership.
    const adapter = fixture.adapter as unknown as {
      attachServiceVolume(volumeTarget: typeof target, options: { requireAcknowledgedId: boolean }):
        Promise<{ success: boolean; mutationAttempted: boolean; volumeId?: string }>;
    };
    expect(await adapter.attachServiceVolume(target, { requireAcknowledgedId: true }))
      .toMatchObject({ success: false, mutationAttempted: true });
    expect(fixture.volumes.size).toBe(1);
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['volumeCreate']);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('creates only a staging volume and re-observes it without modifying production or deploying', async () => {
    const fixture = await railwayHttpFixture({ pageSize: 1 });
    fixture.addService(target.serviceId, 'web', stagingId);
    const production = fixture.addVolume('production-web', productionId, '/data');
    const before = structuredClone(production.instance);
    fixture.addVolume(null, stagingId, '/unrelated');
    expect(await fixture.adapter.serviceVolumes.observe(target)).toEqual({ state: 'absent' });
    const result = await fixture.adapter.serviceVolumes.create(target);
    expect(result).toMatchObject({ success: true, mutationAttempted: true, externalId: expect.any(String) });
    expect(await fixture.adapter.serviceVolumes.observe(target, result.externalId)).toEqual({
      state: 'present', externalId: result.externalId, pendingDeletion: false,
    });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['volumeCreate']);
    expect(fixture.mutations[0].args.input).toEqual(target);
    expect(fixture.requests).toContainEqual(expect.objectContaining({ variables: {
      projectId, environmentId: stagingId, after: '1',
    } }));
    expect(production.instance).toEqual(before);
    expect(fixture.contractErrors).toEqual([]);
  });

  it.each(['/data', '/old'])('refuses to adopt or duplicate an existing same-service mount at %s', async (mountPath) => {
    const fixture = await railwayHttpFixture({ pageSize: 1 });
    fixture.addService(target.serviceId, 'web', stagingId);
    fixture.addVolume(null, stagingId, '/unrelated');
    fixture.addVolume(target.serviceId, stagingId, mountPath);
    const observed = await fixture.adapter.serviceVolumes.observe(target);
    expect(observed.state).toBe(mountPath === '/data' ? 'present' : 'unknown');
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({
      success: false, mutationAttempted: false,
    });
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it.each([null, 2])('blocks unknown or unsupported replica count %s', async (replicas) => {
    const fixture = await railwayHttpFixture();
    fixture.addService(target.serviceId, 'web', stagingId).instances.get(stagingId)!.numReplicas = replicas;
    expect(await fixture.adapter.serviceVolumes.observe(target)).toMatchObject({ state: 'unknown' });
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({
      success: false, mutationAttempted: false,
    });
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('rejects multi-region total two even when the scalar replica count says one', async () => {
    const fixture = await railwayHttpFixture();
    fixture.addService(target.serviceId, 'web', stagingId);
    fixture.environments.get(stagingId)!.config.services![target.serviceId].deploy = {
      multiRegionConfig: { 'us-west2': { numReplicas: 1 }, 'us-east4': { numReplicas: 1 } },
    };
    // Independent JSON model: pinned official CLI controllers/config/environment.rs
    // DeployConfig.multi_region_config and RegionConfig.num_replicas. The
    // GraphQL EnvironmentConfig scalar cannot validate these nested semantics.
    expect(await fixture.adapter.serviceVolumes.observe(target)).toMatchObject({ state: 'unknown' });
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it.each([
    undefined,
    null,
    { multiRegionConfig: null },
    { multiRegionConfig: { 'us-west2': null } },
    { multiRegionConfig: { 'us-west2': {} } },
    { multiRegionConfig: { 'us-west2': { numReplicas: '1' } } },
  ])('preserves unknown multi-region semantics for opaque/incomplete deploy config: %j', async (deploy) => {
    const fixture = await railwayHttpFixture();
    fixture.addService(target.serviceId, 'web', stagingId);
    fixture.environments.get(stagingId)!.config.services![target.serviceId].deploy = deploy;
    expect(await fixture.adapter.serviceVolumes.observe(target)).toMatchObject({ state: 'unknown' });
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
    expect(fixture.mutations).toEqual([]);
  });

  it('accepts a complete single-region count and fails closed when its service config disappears', async () => {
    const fixture = await railwayHttpFixture();
    fixture.addService(target.serviceId, 'web', stagingId);
    fixture.environments.get(stagingId)!.config.services![target.serviceId].deploy = {
      multiRegionConfig: { 'us-west2': { numReplicas: 1 } },
    };
    expect(await fixture.adapter.serviceVolumes.observe(target)).toEqual({ state: 'absent' });
    delete fixture.environments.get(stagingId)!.config.services![target.serviceId];
    expect(await fixture.adapter.serviceVolumes.observe(target)).toMatchObject({ state: 'unknown' });
    expect(fixture.mutations).toEqual([]);
  });

  it('does not interpret a missing service instance or mismatching project as an absent volume', async () => {
    const fixture = await railwayHttpFixture();
    const wrongTargets = [
      { ...target, serviceId: 'production-web' },
      { ...target, projectId: 'different-project', serviceId: 'production-web', environmentId: productionId },
    ];
    for (const wrong of wrongTargets) {
      expect(await fixture.adapter.serviceVolumes.observe(wrong)).toMatchObject({ state: 'unknown' });
      expect(await fixture.adapter.serviceVolumes.create(wrong)).toMatchObject({ success: false, mutationAttempted: false });
    }
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('preserves unknown volume inventory, including failures on a later page', async () => {
    const fixture = await railwayHttpFixture({ pageSize: 1,
      responseOverride: ({ query, variables }) => query.includes('EnvironmentVolumeInstances') && variables.after
        ? Response.json({ errors: [{ message: 'synthetic forbidden page' }] }, { status: 403 }) : undefined,
    });
    fixture.addService(target.serviceId, 'web', stagingId);
    fixture.addVolume(null, stagingId, '/unrelated');
    fixture.addVolume(target.serviceId, stagingId, '/data');
    expect(await fixture.adapter.serviceVolumes.observe(target)).toMatchObject({ state: 'unknown' });
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
    expect(fixture.mutations).toEqual([]);
  });

  it('blocks ambiguous same-service attachments and wrong bound identities', async () => {
    const fixture = await railwayHttpFixture();
    fixture.addService(target.serviceId, 'web', stagingId);
    const first = fixture.addVolume(target.serviceId, stagingId, '/data');
    expect(await fixture.adapter.serviceVolumes.observe(target, 'different-volume')).toMatchObject({ state: 'unknown' });
    fixture.addVolume(target.serviceId, stagingId, '/other');
    expect(await fixture.adapter.serviceVolumes.observe(target, first.id)).toMatchObject({ state: 'unknown' });
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('reports pending deletion without creating a replacement or exposing deletion authority', async () => {
    const fixture = await railwayHttpFixture();
    fixture.addService(target.serviceId, 'web', stagingId);
    const { id } = fixture.addVolume(target.serviceId, stagingId, '/data', { isPendingDeletion: true });
    expect(await fixture.adapter.serviceVolumes.observe(target, id)).toEqual({
      state: 'present', externalId: id, pendingDeletion: true,
    });
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
    expect(Object.keys(fixture.adapter.serviceVolumes).sort()).toEqual(['create', 'observe']);
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('rejects a malformed deletion timestamp instead of declaring absence (negative scalar fixture)', async () => {
    const fixture = await railwayHttpFixture();
    fixture.addService(target.serviceId, 'web', stagingId);
    // GraphQL DateTime is an opaque scalar here; malformed timestamp semantics
    // require explicit adapter validation rather than schema certification.
    fixture.addVolume(target.serviceId, stagingId, '/data', { deletedAt: 'not-a-date' });
    expect(await fixture.adapter.serviceVolumes.observe(target)).toMatchObject({ state: 'unknown' });
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
    expect(fixture.mutations).toEqual([]);
  });

  it('preserves the acknowledged id when the exact target resolves to a different volume', async () => {
    const fixture = await railwayHttpFixture({ volumeCreateResponseId: 'acknowledged-volume' });
    fixture.addService(target.serviceId, 'web', stagingId);
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({
      success: false, mutationAttempted: true, externalId: 'acknowledged-volume',
    });
    expect(fixture.volumes.has('acknowledged-volume')).toBe(false);
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['volumeCreate']);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('waits for acknowledged delayed attachment without a second create', async () => {
    vi.useFakeTimers();
    const fixture = await railwayHttpFixture({ volumeDelayMs: 2000 });
    fixture.addService(target.serviceId, 'web', stagingId);
    const resultPromise = fixture.adapter.serviceVolumes.create(target);
    await vi.runAllTimersAsync();
    expect(await resultPromise).toMatchObject({ success: true, externalId: expect.any(String), mutationAttempted: true });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['volumeCreate']);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('retains only the acknowledged id after visibility timeout', async () => {
    vi.useFakeTimers();
    const fixture = await railwayHttpFixture({ volumeDelayMs: 60_000 });
    fixture.addService(target.serviceId, 'web', stagingId);
    const resultPromise = fixture.adapter.serviceVolumes.create(target);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toMatchObject({ success: false, externalId: expect.any(String), mutationAttempted: true });
    expect(fixture.volumes.has(result.externalId!)).toBe(true);
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['volumeCreate']);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('retains an uncertain create without attributing the later target to that operation', async () => {
    const fixture = await railwayHttpFixture({ dropVolumeCreateResponse: true });
    fixture.addService(target.serviceId, 'web', stagingId);
    const result = await fixture.adapter.serviceVolumes.create(target);
    expect(result).toMatchObject({ success: false, mutationAttempted: true });
    expect(result.externalId).toBeUndefined();
    expect(await fixture.adapter.serviceVolumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
    expect(fixture.mutations.map(({ field }) => field)).toEqual(['volumeCreate']);
    expect(fixture.contractErrors).toEqual([]);
  });

  it('does not return an unowned id if another volume appears during create preflight', async () => {
    let inventoryReads = 0;
    const fixture = await railwayHttpFixture({ responseOverride: ({ query }) => {
      if (query.includes('EnvironmentVolumeInstances') && ++inventoryReads === 2) {
        fixture.addVolume(target.serviceId, stagingId, '/data');
      }
      return undefined;
    } });
    fixture.addService(target.serviceId, 'web', stagingId);
    const result = await fixture.adapter.serviceVolumes.create(target);
    expect(result).toMatchObject({ success: false, mutationAttempted: false });
    expect(result.externalId).toBeUndefined();
    expect(fixture.mutations).toEqual([]);
    expect(fixture.contractErrors).toEqual([]);
  });
});
