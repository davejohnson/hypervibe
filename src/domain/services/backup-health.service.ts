import { z } from 'zod';
import type { RecoverySourceIdentity } from '../ports/recovery-source.port.js';
import { observeBackupPolicy, resolveBackupTarget, type BackupPolicyContext, type BackupResource } from './backup-policy.service.js';
import { recoveryIdentityStringSchema, recoverySourceIdentityMatches, recoverySourceIdentitySchema } from './recovery-source.js';
import { managedRecoverySource, observeManagedBackupProgram } from './managed-backup-policy.service.js';
import { openRecoveryStorage } from './managed-backup-target.service.js';
import { observeManagedRecoverySet } from './recovery-set-health.service.js';

export type BackupHealthState = 'verified' | 'missing' | 'stale' | 'unknown' | 'unsupported';
export interface BackupResourceHealth {
  resource: BackupResource;
  state: BackupHealthState;
  reason?: string;
  source?: RecoverySourceIdentity;
  completedAt?: string;
  dataTime?: string;
  freshUntil?: string;
  recoveryPointId?: string;
  restore?: { state: BackupHealthState; verifiedAt?: string; freshUntil?: string; reason?: string };
}
export interface BackupHealthObservation { observedAt: string; resources: BackupResourceHealth[] }

const timestamp = z.string().datetime({ offset: true });
/** Provider terminal evidence or a read-back verified retained archive; never a schedule receipt. */
export const completedBackupEvidenceSchema = z.object({
  state: z.literal('complete'),
  source: recoverySourceIdentitySchema,
  recoveryPointId: recoveryIdentityStringSchema,
  dataTime: timestamp,
  completedAt: timestamp,
  expiresAt: timestamp.nullable().optional(),
  restore: z.union([
    z.object({ state: z.literal('verified'), verifiedAt: timestamp,
      source: recoverySourceIdentitySchema, recoveryPointId: recoveryIdentityStringSchema,
      isolationVerified: z.literal(true), cleanupVerified: z.literal(true) }).strict(),
    z.object({ state: z.enum(['missing', 'unknown', 'unsupported']), reason: z.string().min(1).max(500) }).strict(),
  ]).optional(),
}).strict();
export type CompletedBackupEvidence = z.infer<typeof completedBackupEvidenceSchema>;
export type BackupRecoveryObservation = CompletedBackupEvidence | { state: 'missing' | 'unknown' | 'unsupported'; reason: string };

const DAY = 86_400_000;
/** Daily means the age of recoverable DATA is at most 24h, not a new timestamp on an old copy. */
export function evaluateRecoveryHealth(resource: BackupResource, expected: RecoverySourceIdentity, input: unknown,
  now = new Date()): BackupResourceHealth {
  const unknown = { resource, state: 'unknown' as const, reason: 'Completed backup evidence is incomplete, stale in identity, or inconsistent.' };
  const unavailable = z.object({ state: z.enum(['missing', 'unknown', 'unsupported']), reason: z.string().min(1).max(500) }).strict().safeParse(input);
  if (unavailable.success) return { resource, ...unavailable.data };
  // Keep point and restore validation separate: bad drill evidence must not erase a known available point.
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const parsed = completedBackupEvidenceSchema.omit({ restore: true }).safeParse(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'restore')));
  if (!parsed.success || !recoverySourceIdentityMatches(parsed.data.source, expected)) return unknown;
  const point = parsed.data;
  const observedAt = now.getTime(), dataTime = Date.parse(point.dataTime), completedAt = Date.parse(point.completedAt);
  if (!Number.isFinite(observedAt) || dataTime > completedAt || completedAt > observedAt) return unknown;
  const freshUntil = Math.min(dataTime + DAY, point.expiresAt ? Date.parse(point.expiresAt) : Infinity);
  const result: BackupResourceHealth = { resource, source: point.source, recoveryPointId: point.recoveryPointId,
    completedAt: point.completedAt, dataTime: point.dataTime, freshUntil: new Date(freshUntil).toISOString(),
    state: freshUntil > observedAt ? 'verified' : 'stale',
    restore: { state: 'missing', reason: 'No verified isolated restore is available.' } };
  if (raw.restore !== undefined) {
    const restore = completedBackupEvidenceSchema.shape.restore.safeParse(raw.restore);
    if (!restore.success || !restore.data) result.restore = { state: 'unknown', reason: 'Restore evidence is malformed or does not prove isolation and cleanup.' };
    else if (restore.data.state !== 'verified') result.restore = restore.data;
    else {
      const drill = restore.data, verifiedAt = Date.parse(drill.verifiedAt);
      if (!recoverySourceIdentityMatches(drill.source, expected) || verifiedAt > observedAt) {
        result.restore = { state: 'unknown', reason: 'Restore evidence belongs to another source or a future time.' };
      } else result.restore = { state: verifiedAt + 7 * DAY > observedAt ? 'verified' : 'stale',
        verifiedAt: drill.verifiedAt, freshUntil: new Date(verifiedAt + 7 * DAY).toISOString() };
    }
  }
  return result;
}

/** Fresh, read-only provider/archive observation. A stored policy or local timestamp cannot certify health. */
export async function observeBackupHealth(context: BackupPolicyContext): Promise<BackupHealthObservation> {
  const now = new Date();
  const coverage = await observeBackupPolicy(context);
  if (coverage.policy.mode === 'disabled') return { observedAt: now.toISOString(), resources: [] };
  const resources: BackupResourceHealth[] = [];
  let managed: Awaited<ReturnType<typeof observeManagedBackupProgram>> | undefined;
  let retained: Awaited<ReturnType<typeof observeManagedRecoverySet>> | undefined;
  if (context.spec.backups?.mode === 'daily' && context.spec.backups.runnerImage && context.environment) {
    managed = await observeManagedBackupProgram(context);
    if (managed.state === 'ready') {
      let archive: Awaited<ReturnType<typeof openRecoveryStorage>> | undefined;
      try {
        const destination = managed.target.destination.identity;
        const adapter = await context.adapterFactory.getStorageAdapter(destination.provider, context.project);
        if (!adapter.success || !adapter.adapter) throw new Error('Unavailable archive');
        archive = await openRecoveryStorage(adapter.adapter, context.environment, destination);
        retained = await observeManagedRecoverySet({ target: managed.target, archive, now });
      } catch { /* An unknown archive never certifies recovery readiness. */ }
      finally { archive?.destroy(); }
    }
  }
  for (const item of coverage.resources) {
    const fallback: BackupResourceHealth = { resource: item.resource, state: 'unknown', reason: 'The current backup source identity is unverified.' };
    const managedSource = managed?.state === 'ready' ? managedRecoverySource(managed.target, item.resource) : undefined;
    if (managedSource) {
      const manifest = retained?.status !== 'unknown' ? retained?.manifest : undefined;
      const proof = item.resource.kind === 'database' ? manifest?.database : manifest?.objects.find(object => object.name === item.resource.name);
      if (!manifest || !proof) { resources.push({ ...fallback, state: retained?.status === 'unhealthy' ? 'missing' : 'unknown', reason: 'A completed retained recovery set and execution cleanup could not be verified.' }); continue; }
      resources.push(evaluateRecoveryHealth(item.resource, managedSource, { state: 'complete', source: managedSource,
        recoveryPointId: manifest.setId, dataTime: manifest.dataTime, completedAt: manifest.completedAt,
        restore: { state: 'verified', source: managedSource, recoveryPointId: manifest.setId, verifiedAt: proof.restoreVerifiedAt,
          isolationVerified: true, cleanupVerified: true } }, now));
      continue;
    }
    if (item.observation?.state !== 'known') { resources.push(fallback); continue; }
    const target = await resolveBackupTarget(context, item.resource);
    if (target.state !== 'ready' || !target.observeRecovery) {
      resources.push({ ...fallback, state: 'unsupported', reason: 'This adapter has no completed-point and isolated-restore observer for the bound source.' }); continue;
    }
    try { resources.push(evaluateRecoveryHealth(item.resource, item.observation.source, await target.observeRecovery(), now)); }
    catch { resources.push(fallback); }
  }
  return { observedAt: now.toISOString(), resources };
}
