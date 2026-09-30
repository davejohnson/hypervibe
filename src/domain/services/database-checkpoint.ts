import { z } from 'zod';
import type { DatabaseCheckpointBinding, DatabaseCheckpointIdentity } from '../ports/database-checkpoint.port.js';

const identityString = z.string().trim().min(1);
export const databaseCheckpointIdentitySchema = z.object({
  providerScope: z.object({ projectId: identityString, environmentId: identityString }).strict(),
  primaryExternalId: identityString,
  volumeId: identityString,
  volumeInstanceId: identityString,
});
const timestamp = z.string().datetime({ offset: true });
export const databaseCheckpointBackupSchema = z.object({
  id: identityString, externalId: identityString, name: z.string().nullable(),
  createdAt: timestamp, expiresAt: timestamp.nullable(),
  usedMB: z.number().finite().nonnegative().nullable(),
  referencedMB: z.number().finite().nonnegative().nullable(),
  volumeInstanceSizeMB: z.number().finite().nonnegative().nullable(),
}).strict();
export const databaseCheckpointSourceSchema = databaseCheckpointIdentitySchema.extend({
  backups: z.array(databaseCheckpointBackupSchema).refine((backups) => new Set(backups.map((backup) => backup.id)).size === backups.length),
}).strict();
const bindingSchema = z.object({
  source: databaseCheckpointIdentitySchema.strict(), label: identityString,
  beforeBackupIds: z.array(identityString), beforeBackupExternalIds: z.array(identityString), requestStartedAt: timestamp,
  workflowId: identityString.optional(),
  state: z.enum(['attempting', 'running', 'complete', 'unknown', 'error']),
  backup: databaseCheckpointBackupSchema.optional(), verifiedAt: timestamp.optional(),
}).strict().refine((binding) => binding.state !== 'complete' || Boolean(binding.workflowId && binding.backup && binding.verifiedAt));

export function checkpointIdentityMatches(a: DatabaseCheckpointIdentity, b: DatabaseCheckpointIdentity): boolean {
  return a.primaryExternalId === b.primaryExternalId && a.volumeId === b.volumeId
    && a.volumeInstanceId === b.volumeInstanceId
    && JSON.stringify(Object.entries(a.providerScope).sort()) === JSON.stringify(Object.entries(b.providerScope).sort());
}

/** Invalid recovery state is never interpreted as an unused intent. */
export function databaseCheckpointBindings(componentBindings: Record<string, unknown>, platformBindings: Record<string, unknown>): Record<string, DatabaseCheckpointBinding> {
  const resilience = z.object({ checkpoints: z.unknown().optional() }).passthrough().parse(componentBindings.resilience ?? {});
  const parse = (value: unknown) => z.record(z.string().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), bindingSchema).parse(value ?? {});
  const local = parse(resilience.checkpoints);
  const exported = parse(platformBindings.databaseCheckpoints);
  const merged = { ...exported, ...local };
  for (const [id, binding] of Object.entries(local)) {
    const remote = Object.hasOwn(exported, id) ? exported[id] : undefined;
    if (!remote) continue;
    const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (!checkpointIdentityMatches(binding.source, remote.source) || binding.label !== remote.label
      || binding.requestStartedAt !== remote.requestStartedAt || !sameSet(binding.beforeBackupIds, remote.beforeBackupIds)
      || !sameSet(binding.beforeBackupExternalIds, remote.beforeBackupExternalIds)
      || (binding.workflowId && remote.workflowId && binding.workflowId !== remote.workflowId)
      || (binding.backup && remote.backup && (binding.backup.id !== remote.backup.id || binding.backup.externalId !== remote.backup.externalId))) {
      throw new Error('Conflicting database checkpoint recovery identities.');
    }
    const rank = { attempting: 0, unknown: 1, running: 2, error: 3, complete: 4 };
    const strongest = rank[binding.state] >= rank[remote.state] ? binding : remote;
    const older = strongest === binding ? remote : binding;
    merged[id] = { ...older, ...strongest };
  }
  return merged;
}

export function checkpointBackupAvailable(binding: DatabaseCheckpointBinding, backups: Array<{id: string; externalId: string; name: string | null; expiresAt: string | null}>, now = Date.now()): boolean {
  return binding.state === 'complete' && Boolean(binding.backup && backups.some((backup) =>
    backup.id === binding.backup!.id && backup.externalId === binding.backup!.externalId && backup.name === binding.label
    && (backup.expiresAt === null || Date.parse(backup.expiresAt) > now)));
}
