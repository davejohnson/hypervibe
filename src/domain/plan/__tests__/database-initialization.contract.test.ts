import { describe, expect, it } from 'vitest';
import type { Component } from '../../entities/component.entity.js';
import { databaseFreshInitializationProgressSchema } from '../../ports/database-fresh-initialization.port.js';
import { completedDatabaseInitializationDeploymentId, databaseInitializationAttemptSchema, getCompletedDatabaseInitializationReceipt,
  hasPendingDatabaseInitialization } from '../database-initialization.contract.js';
import { databaseSeedGeneration } from '../../services/database-seed-generation.js';

// Domain policy regression prompted by a redacted Railway observation: the
// acknowledged deployment was removed while a separately identified successor
// ran after the exact storage attachment operation. Provider tests establish
// that lineage; these synthetic receipts exercise preservation and consumers.
const target = { provider: 'railway', externalId: 'database-service', providerScope: { projectId: 'project-native', environmentId: 'production-native' } };
const activationReconciliation = { version: 1, kind: 'storage-attachment', deploymentId: 'verified-successor', operationId: 'attachment-operation' };
const progress = { phase: 'complete', storageId: 'owned-storage', storageInstanceId: 'owned-instance', deploymentId: 'original-acknowledgment' };
const completed = { intentId: 'initialize-once', target, storageId: progress.storageId, storageInstanceId: progress.storageInstanceId,
  deploymentId: progress.deploymentId, configurationFingerprint: 'a'.repeat(64), verifiedAt: '2026-01-01T00:01:00.000Z' };
function fixture(reconciled = false) {
  const evidence = reconciled ? { activationReconciliation: structuredClone(activationReconciliation) } : {};
  const attempt = { metadata: { operation: 'databaseFreshInitialize', componentId: 'component-local', intentId: completed.intentId, target,
    configurationFingerprint: completed.configurationFingerprint, bindingsFingerprint: 'b'.repeat(64), environmentFingerprint: 'c'.repeat(64) },
  inspectionEncrypted: 'encrypted-private-review', startedAt: '2026-01-01T00:00:00.000Z',
  progress: { ...progress, ...evidence }, storageBindings: { volumeId: progress.storageId, volumeInstanceId: progress.storageInstanceId },
  completed: { ...completed, ...structuredClone(evidence) } };
  const component: Component = { id: 'component-local', environmentId: 'environment-local', type: 'postgres', externalId: target.externalId,
    createdAt: new Date(0), updatedAt: new Date(0), bindings: { provider: target.provider, providerScope: target.providerScope,
      ...attempt.storageBindings, freshInitialization: attempt } };
  const environment = { id: component.environmentId, platformBindings: { provider: target.provider, ...target.providerScope } };
  return { attempt, component, environment };
}

describe('fresh initialization activation reconciliation receipts', () => {
  it('preserves a legacy completed receipt and its seed generation without adding fields', () => {
    const f = fixture();
    expect(databaseInitializationAttemptSchema.parse(f.attempt)).toEqual(f.attempt);
    expect(getCompletedDatabaseInitializationReceipt(f)).toEqual(completed);
    expect(completedDatabaseInitializationDeploymentId(getCompletedDatabaseInitializationReceipt(f)!)).toBe(progress.deploymentId);
    expect(hasPendingDatabaseInitialization(f.component.bindings)).toBe(false);
    expect(databaseSeedGeneration(f.component, f.environment.platformBindings))
      .toBe('183fbf598227215f3f35369798b552ef220553f16c316bbb8ccd931b60644279');
    expect(Object.hasOwn(getCompletedDatabaseInitializationReceipt(f)!, 'activationReconciliation')).toBe(false);
  });

  it('retains both the original acknowledgment and separately verified activation in a complete receipt', () => {
    const f = fixture(true);
    expect(databaseInitializationAttemptSchema.safeParse(f.attempt).success).toBe(true);
    expect(getCompletedDatabaseInitializationReceipt(f)).toEqual({ ...completed, activationReconciliation });
    expect(completedDatabaseInitializationDeploymentId(getCompletedDatabaseInitializationReceipt(f)!)).toBe(activationReconciliation.deploymentId);
    expect(hasPendingDatabaseInitialization(f.component.bindings)).toBe(false);
    const legacy = fixture();
    expect(databaseSeedGeneration(f.component, f.environment.platformBindings)).toMatch(/^[a-f0-9]{64}$/);
    expect(databaseSeedGeneration(f.component, f.environment.platformBindings))
      .not.toBe(databaseSeedGeneration(legacy.component, legacy.environment.platformBindings));
  });

  it.each(['prepared', 'storage-identified', 'activation-identified'] as const)(
    'rejects activation reconciliation before complete, including %s', phase => {
      const earlier = phase === 'prepared' ? { phase } : phase === 'storage-identified'
        ? { phase, storageId: progress.storageId } : { ...progress, phase };
      expect(databaseFreshInitializationProgressSchema.safeParse({ ...earlier, activationReconciliation }).success).toBe(false);
    });

  it.each([
    { ...activationReconciliation, version: 2 },
    { ...activationReconciliation, kind: 'latest-deployment' },
    { ...activationReconciliation, deploymentId: progress.deploymentId },
    { ...activationReconciliation, operationId: '' },
    { ...activationReconciliation, unexplained: true },
  ])('rejects unsupported, incomplete, self-referential or extra activation evidence %#', invalid => {
    expect(databaseFreshInitializationProgressSchema.safeParse({ ...progress, activationReconciliation: invalid }).success).toBe(false);
  });

  it.each(['missing-progress', 'missing-receipt', 'different-deployment', 'different-operation', 'changed-acknowledgment'] as const)(
    'blocks contradictory completed evidence: %s', mismatch => {
      const f = fixture(true);
      if (mismatch === 'missing-progress') delete f.attempt.progress.activationReconciliation;
      if (mismatch === 'missing-receipt') delete f.attempt.completed.activationReconciliation;
      if (mismatch === 'different-deployment') f.attempt.completed.activationReconciliation!.deploymentId = 'unrelated-successor';
      if (mismatch === 'different-operation') f.attempt.completed.activationReconciliation!.operationId = 'unrelated-operation';
      if (mismatch === 'changed-acknowledgment') f.attempt.completed.deploymentId = 'rewritten-acknowledgment';
      expect(databaseInitializationAttemptSchema.safeParse(f.attempt).success).toBe(false);
      expect(getCompletedDatabaseInitializationReceipt(f)).toBeUndefined();
      expect(hasPendingDatabaseInitialization(f.component.bindings)).toBe(true);
      expect(databaseSeedGeneration(f.component, f.environment.platformBindings)).toBeNull();
    });

  it('does not accept reconciliation as authority for a different database scope or storage binding', () => {
    const f = fixture(true);
    f.component.bindings.volumeInstanceId = 'replacement-instance';
    expect(getCompletedDatabaseInitializationReceipt(f)).toBeUndefined();
    expect(databaseSeedGeneration(f.component, f.environment.platformBindings)).toBeNull();
    f.component.bindings.volumeInstanceId = progress.storageInstanceId;
    f.component.bindings.providerScope = { ...target.providerScope, environmentId: 'staging-native' };
    expect(getCompletedDatabaseInitializationReceipt(f)).toBeUndefined();
  });
});
