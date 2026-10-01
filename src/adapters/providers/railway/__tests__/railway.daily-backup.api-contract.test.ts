import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRailwayDatabaseAdapter } from '../railway-database.factory.js';
import { railwayHttpFixture, projectId, productionId, stagingId } from './railway-http.fixture.js';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { DailyBackupObservation, DailyBackupReview } from '../../../../domain/ports/daily-backup.port.js';

afterEach(() => vi.unstubAllGlobals());

const weekly = { id: 'existing-weekly', kind: 'WEEKLY', name: 'Weekly', cron: '0 3 * * 0',
  retentionSeconds: 27 * 86400, createdAt: '2026-09-01T00:00:00Z' };
const monthly = { id: 'existing-monthly', kind: 'MONTHLY', name: 'Monthly', cron: '0 3 1 * *',
  retentionSeconds: 89 * 86400, createdAt: '2026-09-01T00:00:00Z' };
function review(observed: DailyBackupObservation): DailyBackupReview & { preservationFingerprint: string } {
  expect(observed.state).toBe('known');
  if (observed.state !== 'known') throw new Error('Expected known schedule');
  return { source: observed.source, policyFingerprint: observed.policyFingerprint,
    preservationFingerprint: observed.preservationFingerprint };
}

async function fixture(options: Parameters<typeof railwayHttpFixture>[0] = {}) {
  const http = await railwayHttpFixture(options);
  http.addService('staging-postgres', 'postgres', stagingId);
  const production = http.addVolume('production-postgres-db', productionId, '/var/lib/postgresql/data');
  http.addVolume(null, stagingId, '/unrelated');
  const volume = http.addVolume('staging-postgres', stagingId, '/var/lib/postgresql/data');
  const component: Component = { id: 'local-db', environmentId: http.environment.id, type: 'postgres',
    externalId: 'staging-postgres', bindings: { provider: 'railway', resourceKind: 'service',
      providerScope: { projectId, environmentId: stagingId } }, createdAt: new Date(), updatedAt: new Date() };
  const database = createRailwayDatabaseAdapter({ hostingAdapter: http.adapter,
    envRepo: { findById: () => http.environment } as never });
  const target = { environment: http.environment, component };
  return { ...http, database, target, component, production, volume };
}

/** Real graphql-request serialization against the pinned official SDL. Native
 * replace-set semantics: CLI f60f3a7 database/pitr.rs:1678-1797; fixed retention:
 * https://docs.railway.com/volumes/backups. Synthetic state, not live scheduling.
 */
describe('Railway daily backup policy through serialized GraphQL', () => {
  it('adds daily for the exact staging volume instance, retaining weekly/monthly and production', async () => {
    const f = await fixture({ pageSize: 1 });
    f.backupSchedules.set(String(f.volume.instance.id), [monthly, weekly]);
    f.backupSchedules.set(String(f.production.instance.id), [weekly]);
    const before = structuredClone(f.production.instance);
    const observed = await f.database.dailyBackups!.observe(f.target);
    expect(observed).toHaveProperty('preservationFingerprint', expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(observed).toMatchObject({ state: 'known', daily: false, mechanism: 'snapshot', source: {
      provider: 'railway', primaryExternalId: 'staging-postgres',
      providerScope: { projectId, environmentId: stagingId },
      resourceIdentity: { volumeId: f.volume.id, volumeInstanceId: f.volume.instance.id },
    } });
    expect(await f.database.dailyBackups!.configureDaily(f.target, review(observed)))
      .toMatchObject({ success: true, data: { applied: 1, skipped: 0 } });
    expect(f.mutations).toEqual([{ field: 'volumeInstanceBackupScheduleUpdate', args: {
      volumeInstanceId: f.volume.instance.id, kinds: ['DAILY', 'MONTHLY', 'WEEKLY'],
    } }]);
    const after = await f.database.dailyBackups!.observe(f.target);
    expect(after).toMatchObject({ state: 'known', daily: true, retention: { unit: 'days', value: 6 } });
    expect(after).toHaveProperty('preservationFingerprint', review(observed).preservationFingerprint);
    expect(await f.database.dailyBackups!.configureDaily(f.target, review(after)))
      .toMatchObject({ success: true, data: { applied: 0, skipped: 1 } });
    expect(f.backupSchedules.get(String(f.volume.instance.id))).toEqual(expect.arrayContaining([weekly, monthly]));
    expect(f.backupSchedules.get(String(f.production.instance.id))).toEqual([weekly]);
    expect(f.production.instance).toEqual(before);
    expect(f.mutations).toHaveLength(1);
    expect(f.backups.size).toBe(0);
    expect(f.backupWorkflows.size).toBe(0);
    expect(f.contractErrors).toEqual([]);
  });

  it('uses the same native policy for a filesystem mount while requiring its exact bound id and path', async () => {
    const f = await fixture();
    f.addService('staging-web', 'web', stagingId);
    const volume = f.addVolume('staging-web', stagingId, '/data');
    const target = { target: { projectId, environmentId: stagingId, serviceId: 'staging-web', mountPath: '/data' },
      externalId: volume.id };
    const port = f.adapter.serviceVolumes.dailyBackups!;
    const observed = await port.observe(target);
    expect(await port.configureDaily(target, review(observed))).toMatchObject({ success: true });
    expect(f.mutations).toEqual([{ field: 'volumeInstanceBackupScheduleUpdate', args: {
      volumeInstanceId: volume.instance.id, kinds: ['DAILY'],
    } }]);
    expect(await port.observe({ ...target, externalId: 'wrong-volume' })).toMatchObject({ state: 'unknown' });
    expect(await port.observe({ ...target, target: { ...target.target, mountPath: '/wrong' } }))
      .toMatchObject({ state: 'unknown' });
    expect(f.contractErrors).toEqual([]);
  });

  it.each(['schedule', 'instance', 'provider'] as const)('rejects reviewed %s drift before any mutation', async (change) => {
    const f = await fixture();
    const reviewed = review(await f.database.dailyBackups!.observe(f.target));
    if (change === 'schedule') f.backupSchedules.set(String(f.volume.instance.id), [weekly]);
    if (change === 'instance') f.volume.instance.id = 'replacement-instance';
    if (change === 'provider') reviewed.source.provider = 'cloudsql';
    expect(await f.database.dailyBackups!.configureDaily(f.target, reviewed)).toMatchObject({ success: false });
    expect(f.mutations).toEqual([]);
  });

  it.each(['scope', 'pending', 'duplicate', 'missing', 'retained'] as const)('blocks %s ownership for a bound database', async (change) => {
    const f = await fixture();
    if (change === 'scope') f.component.bindings.providerScope = { projectId, environmentId: productionId };
    if (change === 'pending') f.volume.instance.isPendingDeletion = true;
    if (change === 'duplicate') f.addVolume('staging-postgres', stagingId, '/another');
    if (change === 'missing') f.volumes.delete(f.volume.id);
    if (change === 'retained') f.component.bindings.retainedCleanup = true;
    expect(await f.database.dailyBackups!.observe(f.target)).toMatchObject({ state: 'unknown' });
    expect(f.mutations).toEqual([]);
  });

  it('preserves an unknown schedule read and omits provider response details', async () => {
    const privateDetail = 'postgres://secret:password@private/database';
    const f = await fixture({ responseOverride: ({ query }) => query.includes('DailyBackupScheduleList')
      ? Response.json({ errors: [{ message: privateDetail }] }, { status: 403 }) : undefined });
    const result = await f.database.dailyBackups!.observe(f.target);
    expect(result).toMatchObject({ state: 'unknown' });
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(f.mutations).toEqual([]);
  });

  it('fails closed when a later source inventory page is unavailable', async () => {
    const f = await fixture({ pageSize: 1, responseOverride: ({ query, variables }) =>
      query.includes('EnvironmentVolumeInstances') && variables.after
        ? Response.json({ errors: [{ message: 'denied' }] }, { status: 403 }) : undefined });
    expect(await f.database.dailyBackups!.observe(f.target)).toMatchObject({ state: 'unknown' });
    expect(f.mutations).toEqual([]);
  });

  it('does not retry an ambiguous schedule write and can subsequently observe its effect', async () => {
    const f = await fixture({ dropScheduleUpdateResponse: true });
    const reviewed = review(await f.database.dailyBackups!.observe(f.target));
    expect(await f.database.dailyBackups!.configureDaily(f.target, reviewed)).toMatchObject({ success: false,
      data: { mutationAttempted: true, outcomeUnknown: true, applied: null } });
    expect(f.mutations).toHaveLength(1);
    expect(await f.database.dailyBackups!.observe(f.target)).toMatchObject({ state: 'known', daily: true });
    expect(await f.database.dailyBackups!.configureDaily(f.target, reviewed)).toMatchObject({ success: false });
    expect(f.mutations).toHaveLength(1);
  });

  it('does not equate a successful mutation acknowledgement with an applied policy', async () => {
    const f = await fixture({ ignoreScheduleUpdate: true });
    const reviewed = review(await f.database.dailyBackups!.observe(f.target));
    expect(await f.database.dailyBackups!.configureDaily(f.target, reviewed)).toMatchObject({ success: false,
      data: { mutationAttempted: true, outcomeUnknown: true, applied: null } });
    expect(f.mutations).toHaveLength(1);
  });

  it('does not verify daily policy on a replacement source observed after the update', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let changed = false;
    f = await fixture({ responseOverride: ({ query }) => {
      if (!changed && f?.mutations.length && query.includes('DatabaseCheckpointTarget')) {
        const prior = String(f.volume.instance.id);
        f.volume.instance.id = 'replacement-instance';
        f.backupSchedules.set('replacement-instance', f.backupSchedules.get(prior)!);
        changed = true;
      }
      return undefined;
    } });
    const reviewed = review(await f.database.dailyBackups!.observe(f.target));
    expect(await f.database.dailyBackups!.configureDaily(f.target, reviewed)).toMatchObject({ success: false,
      data: { mutationAttempted: true, outcomeUnknown: true, applied: null } });
    expect(f.mutations).toHaveLength(1);
  });

  it('does not verify an update that lost the previously observed weekly schedule', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({ responseOverride: ({ query }) => {
      if (f?.mutations.length && query.includes('DailyBackupScheduleList')) {
        const id = String(f.volume.instance.id);
        f.backupSchedules.set(id, f.backupSchedules.get(id)!.filter(schedule => schedule.kind === 'DAILY'));
      }
      return undefined;
    } });
    f.backupSchedules.set(String(f.volume.instance.id), [weekly]);
    const reviewed = review(await f.database.dailyBackups!.observe(f.target));
    expect(await f.database.dailyBackups!.configureDaily(f.target, reviewed)).toMatchObject({ success: false,
      data: { mutationAttempted: true, outcomeUnknown: true, applied: null } });
    expect(f.mutations).toHaveLength(1);
    const after = await f.database.dailyBackups!.observe(f.target);
    expect(after).toMatchObject({ state: 'known', daily: true });
    expect(review(after).preservationFingerprint).not.toBe(reviewed.preservationFingerprint);
  });

  it('preserves nullable native retention without inventing an observed duration', async () => {
    const f = await fixture();
    f.backupSchedules.set(String(f.volume.instance.id), [{ ...weekly, kind: 'DAILY', retentionSeconds: null }]);
    const observed = await f.database.dailyBackups!.observe(f.target);
    expect(observed).toMatchObject({ state: 'known', daily: true });
    expect(observed).not.toHaveProperty('retention');
    expect(f.contractErrors).toEqual([]);
  });

  it('rejects duplicate schedules and unsafe native source identities without exposing them', async () => {
    const f = await fixture();
    f.backupSchedules.set(String(f.volume.instance.id), [weekly, weekly]);
    expect(await f.database.dailyBackups!.observe(f.target)).toMatchObject({ state: 'unknown' });
    f.component.externalId = 'postgres://secret:password@private/database';
    const requestCount = f.requests.length;
    const observed = await f.database.dailyBackups!.observe(f.target);
    expect(observed).toMatchObject({ state: 'unknown' });
    expect(JSON.stringify(observed)).not.toContain('secret:password');
    expect(f.requests).toHaveLength(requestCount);
    expect(f.mutations).toEqual([]);
  });
});
