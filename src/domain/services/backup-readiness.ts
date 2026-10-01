import type { BackupHealthObservation } from './backup-health.service.js';
import type { BackupPolicyObservation, BackupResource } from './backup-policy.service.js';
import { recoverySourceIdentityMatches, recoverySourceIdentitySchema } from './recovery-source.js';

const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;
const timestamp = (value: string | undefined) => value === undefined ? NaN : Date.parse(value);
export const backupResourceKey = (resource: BackupResource) => JSON.stringify([
  resource.kind, resource.provider, resource.name, resource.componentId ?? null, resource.retained,
]);

export interface BackupReadiness {
  ready: boolean;
  policyReady: boolean;
  recoveryPointReady: boolean;
  restoreReady: boolean;
  resources: Array<{ resource: BackupResource; ready: boolean; gaps: string[] }>;
  gaps: string[];
}

/** Summarize completed observations without labelling an attempted check as unchecked. */
export function backupEvidenceSummary(readiness: BackupReadiness) {
  const state = (verified: boolean): 'not-applicable' | 'verified' | 'unverified' =>
    readiness.resources.length === 0 && readiness.ready ? 'not-applicable' : verified ? 'verified' : 'unverified';
  return { backupObserved: state(readiness.recoveryPointReady), restoreTested: state(readiness.restoreReady) };
}

/** Live protection evidence gates releases; desired schedules and cached markers do not. */
export function assessBackupReadiness(coverage: BackupPolicyObservation, health: BackupHealthObservation,
  now = Date.now()): BackupReadiness {
  if (coverage.policy.mode === 'disabled' && coverage.policy.source === 'explicit' && coverage.policy.reason?.trim()) {
    return { ready: true, policyReady: true, recoveryPointReady: true, restoreReady: true, resources: [], gaps: [] };
  }
  let policyReady = true;
  let recoveryPointReady = true;
  let restoreReady = true;
  const observedAt = timestamp(health.observedAt);
  const freshObservation = Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= MAX_OBSERVATION_AGE_MS;
  const keys = coverage.policy.resources.map(backupResourceKey);
  const resources = coverage.policy.resources.map(resource => {
    const key = backupResourceKey(resource);
    const gaps: string[] = [];
    const policies = coverage.resources.filter(item => backupResourceKey(item.resource) === key);
    const observations = health.resources.filter(item => backupResourceKey(item.resource) === key);
    const policy = policies.length === 1 ? policies[0] : undefined;
    const observation = observations.length === 1 ? observations[0] : undefined;
    const source = policy?.observation?.state === 'known' ? policy.observation.source : undefined;
    const sourceIdentity = recoverySourceIdentitySchema.safeParse(source);
    const healthIdentity = recoverySourceIdentitySchema.safeParse(observation?.source);
    const exactSource = sourceIdentity.success && healthIdentity.success
      && recoverySourceIdentityMatches(sourceIdentity.data, healthIdentity.data);
    if (keys.filter(candidate => candidate === key).length !== 1 || resource.bindingState !== 'bound'
      || policy?.state !== 'scheduled' || !sourceIdentity.success || policy.observation?.state !== 'known' || !policy.observation.daily) {
      policyReady = false;
      gaps.push('Daily protection is not verified for the exact bound resource.');
    }
    const completedAt = timestamp(observation?.completedAt);
    const dataTime = timestamp(observation?.dataTime);
    if (!freshObservation || !exactSource || observation?.state !== 'verified' || !observation.recoveryPointId?.trim()
      || !Number.isFinite(completedAt) || completedAt > now || !Number.isFinite(dataTime) || dataTime > completedAt
      || !(timestamp(observation.freshUntil) > now)) {
      recoveryPointReady = false;
      gaps.push('A fresh completed recovery point is not verified for the current source.');
    }
    const restoredAt = timestamp(observation?.restore?.verifiedAt);
    if (!freshObservation || !exactSource || observation?.restore?.state !== 'verified'
      || !Number.isFinite(restoredAt) || restoredAt > now || !(timestamp(observation.restore.freshUntil) > now)) {
      restoreReady = false;
      gaps.push('A fresh isolated restore is not verified for the current source.');
    }
    return { resource, ready: gaps.length === 0, gaps };
  });
  const inventoryMismatch = coverage.resources.some(item => !keys.includes(backupResourceKey(item.resource)))
    || health.resources.some(item => !keys.includes(backupResourceKey(item.resource)));
  const gaps = resources.flatMap(item => item.gaps.map(gap => `${item.resource.kind} ${item.resource.name}: ${gap}`));
  if (inventoryMismatch) {
    policyReady = recoveryPointReady = restoreReady = false;
    gaps.push('Backup evidence does not match the complete persistent-resource inventory.');
  }
  return { ready: policyReady && recoveryPointReady && restoreReady, policyReady, recoveryPointReady, restoreReady, resources, gaps };
}
