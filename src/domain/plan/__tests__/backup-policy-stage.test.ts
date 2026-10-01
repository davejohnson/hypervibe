import { describe, expect, it } from 'vitest';
import { planRunDocumentSchema } from '../converge.executor.js';
import { resolvePlanActionAuthority } from '../action-authority.js';
import { planBackupPolicy } from '../../services/backup-policy-plan.service.js';
import '../../../adapters/providers/railway/railway.adapter.js';

const source = { provider: 'railway', primaryExternalId: 'database-service',
  providerScope: { projectId: 'project', environmentId: 'production' },
  resourceIdentity: { volumeId: 'volume', volumeInstanceId: 'instance' } };
const item = { resource: { kind: 'database' as const, name: 'postgres', provider: 'railway', retained: false, bindingState: 'bound' as const, componentId: 'component' },
  target: { kind: 'database' as const, componentId: 'component' }, state: 'needs-configuration' as const,
  observation: { state: 'known' as const, source, daily: false, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64), mechanism: 'snapshot' as const } };
const coverage = { policy: { mode: 'daily' as const, source: 'default' as const, resources: [item.resource] }, resources: [item] };

describe('daily backup stage safety contract', () => {
  it('requires exact source review and confirmation for enabling recurring billable protection', () => {
    const plan = planBackupPolicy(coverage);
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0];
    expect(action).toMatchObject({ type: 'update', requiresConfirm: true, billable: true, dataBearing: true,
      metadata: { source, policyFingerprint: 'a'.repeat(64) } });
    expect(resolvePlanActionAuthority(action)?.capability).toBe('backup-policy.configure');
    expect(resolvePlanActionAuthority({ ...action, metadata: { ...action.metadata, source: { ...source, provider: 'rds' } } })).toBeNull();
    expect(resolvePlanActionAuthority({ ...action, requiresConfirm: false })).toBeNull();
    expect(resolvePlanActionAuthority({ ...action, metadata: { ...action.metadata,
      item: { ...(action.metadata!.item as Record<string, unknown>), target: { kind: 'database', componentId: 'different-component' } } } })).toBeNull();
  });

  it('persists an isolated schedule stage and rejects deploy inputs or mixed actions', () => {
    const actions = planBackupPolicy(coverage).actions;
    const document = { kind: 'hv_plan', scope: 'backup-policy', environmentName: 'production', specRevision: 1,
      observedFingerprint: null, actions };
    expect(planRunDocumentSchema.safeParse(document).success).toBe(true);
    expect(planRunDocumentSchema.safeParse({ ...document, overrides: { services: ['web'] } }).success).toBe(false);
    expect(planRunDocumentSchema.safeParse({ ...document, actions: [...actions, { id: 'service:web', type: 'update', resource: {kind: 'service', name: 'web', provider: 'railway'}, verified: true, reason: 'deploy' }] }).success).toBe(false);
  });

  it('keeps an unsupported bucket visible even when database scheduling is actionable', () => {
    const gap = { resource: {kind: 'storage' as const, name: 'files', provider: 'railway', retained: false, bindingState: 'bound' as const}, state: 'unsupported' as const, reason: 'Retained copies are not implemented.' };
    const plan = planBackupPolicy({ ...coverage, resources: [item, gap] });
    expect(plan.actions).toHaveLength(1);
    expect(plan.complete).toBe(false);
    expect(plan.warnings.join(' ')).toContain('files');
    const unknown = planBackupPolicy({ ...coverage, resources: [{ ...item, state: 'unknown', observation: { state: 'unknown', reason: 'Denied' } }] });
    expect(unknown.actions).toEqual([]);
    expect(unknown.complete).toBe(false);
  });

  it('does not repeat an uncertain policy write or compete with an explicit resilience policy', () => {
    const action = planBackupPolicy(coverage).actions[0];
    const pending = planBackupPolicy(coverage, { attempts: { [action.id]: { source, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64) } } });
    expect(pending.actions).toEqual([]);
    expect(pending.complete).toBe(false);
    expect(pending.warnings.join(' ')).toContain('will not retry');
    expect(planBackupPolicy(coverage, { explicitDatabaseBackups: true }).actions).toEqual([]);
    const malformed = planBackupPolicy(coverage, { attempts: 'lost-marker' });
    expect(malformed.actions).toEqual([]);
    expect(malformed.complete).toBe(false);
    const orphan = planBackupPolicy({ ...coverage, resources: [] }, { attempts: { [action.id]: { source, policyFingerprint: 'a'.repeat(64), preservationFingerprint: 'b'.repeat(64) } } });
    expect(orphan.complete).toBe(false);
    expect(orphan.warnings.join(' ')).toContain('no current resource binding');
    expect(planBackupPolicy({ ...coverage, resources: [{ ...item, resource: { ...item.resource, retained: true } }] },
      { explicitDatabaseBackups: true }).actions).toHaveLength(1);
  });
});
