import { createHash } from 'node:crypto';
import { gql, type GraphQLClient } from 'graphql-request';
import { z } from 'zod';
import type { IDailyBackupPolicy, DailyBackupObservation } from '../../../domain/ports/daily-backup.port.js';
import type { RecoverySourceIdentity } from '../../../domain/ports/recovery-source.port.js';
import { recoveryIdentityStringSchema, recoverySourceIdentityMatches, recoverySourceIdentitySchema } from '../../../domain/services/recovery-source.js';
import type { RailwayVolumeTarget } from './railway.adapter.js';

export interface RailwayDailyBackupTarget {
  target: RailwayVolumeTarget;
  /** Database bindings may predate volume identities; native scoped resolution
   * still freezes the exact volume and instance into the reviewed source. */
  externalId?: string;
}

const scheduleSchema = z.object({
  id: recoveryIdentityStringSchema,
  kind: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  cron: z.string().trim().min(1),
  retentionSeconds: z.number().int().positive().nullable(),
});
type Schedule = z.infer<typeof scheduleSchema>;

/** The native schedule is a replacement set, not an add-one command. See the
 * pinned CLI database/pitr.rs:1678-1797 and Railway's volume backup docs.
 * This helper manages policy only; it never creates or restores a snapshot.
 */
export function railwayDailyBackupPolicy(
  getClient: () => GraphQLClient | null,
  resolveSource: (target: RailwayDailyBackupTarget) => Promise<RecoverySourceIdentity>,
): IDailyBackupPolicy<RailwayDailyBackupTarget> {
  const read = async (target: RailwayDailyBackupTarget) => {
    const client = getClient();
    if (!client) throw new Error('Railway backup policy observation requires a connection.');
    const source = recoverySourceIdentitySchema.parse(await resolveSource(target));
    if (source.provider !== 'railway' || !source.providerScope.projectId || !source.providerScope.environmentId
      || !source.resourceIdentity.volumeId || !source.resourceIdentity.volumeInstanceId) {
      throw new Error('Railway backup policy requires an exact scoped volume instance.');
    }
    const response = await client.request<unknown>(gql`
      query DailyBackupScheduleList($volumeInstanceId: String!) {
        volumeInstanceBackupScheduleList(volumeInstanceId: $volumeInstanceId) {
          id kind cron retentionSeconds
        }
      }
    `, { volumeInstanceId: source.resourceIdentity.volumeInstanceId });
    const schedules = z.object({ volumeInstanceBackupScheduleList: z.array(scheduleSchema).max(3) })
      .parse(response).volumeInstanceBackupScheduleList.sort((a, b) => a.kind.localeCompare(b.kind));
    if (new Set(schedules.map(schedule => schedule.id)).size !== schedules.length
      || new Set(schedules.map(schedule => schedule.kind)).size !== schedules.length) {
      throw new Error('Railway returned duplicate backup schedules.');
    }
    const daily = schedules.find(schedule => schedule.kind === 'DAILY');
    const observation: Extract<DailyBackupObservation, { state: 'known' }> = {
      state: 'known', source, daily: Boolean(daily), mechanism: 'snapshot',
      policyFingerprint: createHash('sha256').update(JSON.stringify(schedules)).digest('hex'),
      // Assigned schedule IDs and native cron offsets may change when the set
      // is updated. Preserve the pre-existing frequencies and their retention;
      // DAILY is the only protection this operation is authorized to add.
      preservationFingerprint: createHash('sha256').update(JSON.stringify(schedules
        .filter(schedule => schedule.kind !== 'DAILY')
        .map(({ kind, retentionSeconds }) => ({ kind, retentionSeconds })))).digest('hex'),
      ...(daily?.retentionSeconds ? { retention: { unit: 'days', value: daily.retentionSeconds / 86400 } } : {}),
    };
    return { schedules, observation };
  };
  const preserves = (prior: Schedule[], current: Schedule[]) => prior.every(before => {
    const after = current.find(schedule => schedule.kind === before.kind);
    return after && (before.retentionSeconds === null
      || (after.retentionSeconds !== null && after.retentionSeconds >= before.retentionSeconds));
  });
  return {
    async observe(target) {
      try { return (await read(target)).observation; }
      catch { return { state: 'unknown', reason: 'Railway daily backup source or schedule could not be verified.' }; }
    },
    async configureDaily(target, reviewed) {
      let mutationAttempted = false;
      try {
        const reviewedSource = recoverySourceIdentitySchema.parse(reviewed.source);
        const before = await read(target);
        if (!recoverySourceIdentityMatches(before.observation.source, reviewedSource)
          || before.observation.policyFingerprint !== reviewed.policyFingerprint) {
          return { success: false, message: 'Railway backup source or schedule changed; re-plan before applying.',
            data: { mutationAttempted, applied: 0, skipped: 0 } };
        }
        if (before.observation.daily) {
          return { success: true, message: 'Daily backups are already configured; 0 policies changed, 1 skipped.',
            data: { mutationAttempted, applied: 0, skipped: 1, observation: before.observation } };
        }
        const kinds = [...new Set(['DAILY', ...before.schedules.map(schedule => schedule.kind)])].sort();
        mutationAttempted = true;
        const response = await getClient()!.request<unknown>(gql`
          mutation DailyBackupScheduleUpdate($volumeInstanceId: String!, $kinds: [VolumeInstanceBackupScheduleKind!]!) {
            volumeInstanceBackupScheduleUpdate(volumeInstanceId: $volumeInstanceId, kinds: $kinds)
          }
        `, { volumeInstanceId: before.observation.source.resourceIdentity.volumeInstanceId, kinds });
        z.object({ volumeInstanceBackupScheduleUpdate: z.literal(true) }).parse(response);
        const after = await read(target);
        if (!recoverySourceIdentityMatches(before.observation.source, after.observation.source)
          || before.observation.preservationFingerprint !== after.observation.preservationFingerprint
          || !after.observation.daily || !preserves(before.schedules, after.schedules)) {
          throw new Error('Railway daily schedule convergence is unverified.');
        }
        return { success: true, message: 'Configured daily backups; 1 policy changed, 0 skipped. Restore verification has not run.',
          data: { mutationAttempted, applied: 1, skipped: 0, observation: after.observation } };
      } catch {
        return { success: false,
          message: mutationAttempted
            ? 'Railway backup policy update was attempted, but its outcome is unknown; re-observe before retrying.'
            : 'Railway daily backup source or schedule could not be verified; no policy update was attempted.',
          data: { mutationAttempted, outcomeUnknown: mutationAttempted, applied: mutationAttempted ? null : 0, skipped: 0 } };
      }
    },
  };
}
