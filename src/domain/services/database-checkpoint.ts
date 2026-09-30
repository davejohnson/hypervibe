import { z } from 'zod';
import type { DatabaseCheckpointBackup, DatabaseCheckpointBinding } from '../ports/database-checkpoint.port.js';
import { recoveryIdentityStringSchema, recoverySourceIdentityMatches, recoverySourceIdentitySchema } from './recovery-source.js';

const identityString = recoveryIdentityStringSchema;
/** Exact pre-contract Railway representation. Never infer its provider from desired state. */
const legacyRailwayIdentity = z.object({
  providerScope: z.object({ projectId: identityString, environmentId: identityString }).strict(),
  primaryExternalId: identityString, volumeId: identityString, volumeInstanceId: identityString,
}).strict();
export const databaseCheckpointIdentitySchema = z.union([recoverySourceIdentitySchema,
  legacyRailwayIdentity.transform(({ volumeId, volumeInstanceId, ...source }) => ({ ...source,
    provider: 'railway', resourceIdentity: { volumeId, volumeInstanceId } })),
]);
const timestamp = z.string().datetime({ offset: true });
export const databaseCheckpointBackupSchema = z.object({
  id: identityString, externalId: identityString.optional(), name: z.string().nullable().optional(),
  createdAt: timestamp, expiresAt: timestamp.nullable(),
  usedMB: z.number().finite().nonnegative().nullable().optional(),
  referencedMB: z.number().finite().nonnegative().nullable().optional(),
  volumeInstanceSizeMB: z.number().finite().nonnegative().nullable().optional(),
}).strict();
export const databaseCheckpointSourceSchema = z.object({
  ...recoverySourceIdentitySchema.shape,
  backups: z.array(databaseCheckpointBackupSchema).refine(backups => new Set(backups.map(backup => backup.id)).size === backups.length),
}).strict();
const bindingSchema = z.object({
  source: databaseCheckpointIdentitySchema, label: identityString,
  beforeBackupIds: z.array(identityString), beforeBackupExternalIds: z.array(identityString), requestStartedAt: timestamp,
  acknowledged: z.boolean().optional(), operationId: identityString.optional(), workflowId: identityString.optional(),
  state: z.enum(['attempting', 'running', 'complete', 'unknown', 'error']),
  backup: databaseCheckpointBackupSchema.optional(), verifiedAt: timestamp.optional(),
}).strict().superRefine((binding, ctx) => {
  if (binding.workflowId && (binding.acknowledged === false || binding.source.provider !== 'railway'
    || (binding.operationId && binding.workflowId !== binding.operationId))) {
    ctx.addIssue({ code: 'custom', message: 'Conflicting or non-Railway legacy checkpoint workflow identity.' });
  }
  if (binding.state === 'complete' && !(binding.backup && binding.verifiedAt && (binding.acknowledged === true || binding.workflowId))) {
    ctx.addIssue({ code: 'custom', message: 'Completed checkpoints require acknowledged, verified recovery-point evidence.' });
  }
}).transform(({ workflowId, ...binding }) => ({ ...binding,
  ...(workflowId ? { operationId: workflowId, acknowledged: true } : {}),
}));

export const checkpointIdentityMatches = recoverySourceIdentityMatches;

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
      || (binding.operationId && remote.operationId && binding.operationId !== remote.operationId)
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

export function checkpointBackupAvailable(binding: DatabaseCheckpointBinding, backups: DatabaseCheckpointBackup[], now = Date.now()): boolean {
  return binding.state === 'complete' && Boolean(binding.backup && backups.some(backup =>
    backup.id === binding.backup!.id && backup.externalId === binding.backup!.externalId
    && backup.name === binding.backup!.name && backup.createdAt === binding.backup!.createdAt
    && (backup.expiresAt === null || Date.parse(backup.expiresAt) > now)));
}
