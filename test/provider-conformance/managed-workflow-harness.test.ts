import { describe, expect, it } from 'vitest';
import {
  actionIdsRequiringConfirmation,
  nonNoopActions,
  pendingInfrastructureReview,
  selectTriggeredWorkflowRun,
  terminalReceiptFailures,
} from './managed-workflow-harness.js';

describe('managed provider workflow live harness helpers', () => {
  it('confirms every billable, destructive, or explicitly gated action by exact id', () => {
    expect(actionIdsRequiringConfirmation({
      data: {
        actions: [
          { id: 'service:web', type: 'create', billable: true },
          { id: 'service:old', type: 'destroy', requiresConfirm: true },
          { id: 'database:seed', type: 'run', dataBearing: true },
          { id: 'ci:workflow', type: 'update' },
        ],
      },
    })).toEqual(['service:web', 'service:old', 'database:seed']);
  });

  it('separates noop plans and terminal apply failures', () => {
    expect(nonNoopActions({
      data: {
        actions: [
          { id: 'project', type: 'noop' },
          { id: 'service', type: 'update' },
        ],
      },
    })).toEqual([{ id: 'service', type: 'update' }]);
    expect(terminalReceiptFailures({
      data: {
        receipts: [
          { actionId: 'project', status: 'succeeded' },
          { actionId: 'ci', status: 'pending' },
          { actionId: 'service', status: 'blocked' },
        ],
      },
    })).toEqual([{ actionId: 'service', status: 'blocked' }]);
  });

  it('returns only a Hypervibe pending infrastructure pull request', () => {
    expect(pendingInfrastructureReview({
      data: {
        receipts: [
          {
            actionId: 'ci:github-actions:production:deploy-branch',
            status: 'pending',
            data: {
              pullRequestUrl: 'https://github.com/acme/live-fixture/pull/12',
            },
          },
        ],
      },
    })).toEqual({
      actionId: 'ci:github-actions:production:deploy-branch',
      pullRequestUrl: 'https://github.com/acme/live-fixture/pull/12',
    });
    expect(pendingInfrastructureReview({
      data: {
        receipts: [{
          actionId: 'ci',
          status: 'failed',
          data: { pullRequestUrl: 'https://github.com/acme/repo/pull/1' },
        }],
      },
    })).toBeNull();
  });

  it('selects the newest new workflow_dispatch run from this trigger window', () => {
    const triggeredAfterMs = Date.parse('2026-07-29T18:00:00.000Z');
    expect(selectTriggeredWorkflowRun([
      {
        id: 1,
        event: 'push',
        createdAt: '2026-07-29T18:00:05.000Z',
      },
      {
        id: 2,
        event: 'workflow_dispatch',
        createdAt: '2026-07-29T17:00:00.000Z',
      },
      {
        id: 3,
        event: 'workflow_dispatch',
        createdAt: '2026-07-29T18:00:06.000Z',
      },
      {
        id: 4,
        event: 'workflow_dispatch',
        createdAt: '2026-07-29T18:00:08.000Z',
      },
    ], {
      existingRunIds: new Set([3]),
      triggeredAfterMs,
    })).toMatchObject({ id: 4 });
  });
});
