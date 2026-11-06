import { describe, expect, it } from 'vitest';
import { approvalToken } from '../launch.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';

const action = (type: PlanAction['type'], reason = 'OpenTofu will create it.'): PlanAction =>
  ({ id: 'database:postgres', type, resource: { kind: 'database', name: 'postgres', provider: 'gcp' }, verified: true, reason });

describe('launch approvals', () => {
  it('never lets approval of a create authorize replacing, deleting or adopting the same resource', () => {
    expect(approvalToken(action('create'))).toBe('database:postgres');
    expect(approvalToken(action('replace'))).toBe('replace:database:postgres');
    expect(approvalToken(action('destroy'))).toBe('destroy:database:postgres');
    expect(approvalToken({ ...action('update'), metadata: { engineAdopt: true } })).toBe('adopt:database:postgres');
  });
});
