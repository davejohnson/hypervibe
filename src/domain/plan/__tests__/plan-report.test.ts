import { describe, expect, it } from 'vitest';
import { makePlanReport } from '../plan-report.js';

const context = { project: 'demo', planId: 'review-123', scope: 'full' };
const action = { type: 'update', id: 'service:web', resource: { name: 'web', kind: 'service', provider: 'cloudrun' },
  verified: true, requiresConfirm: true, billable: true, dependsOn: ['database:primary'],
  diff: [{ field: 'env:DB_PASSWORD', from: 'private-before', to: 'private-after' }],
  metadata: { engineSegment: { addresses: ['google_cloud_run_v2_service.web'], configuration: 'private-files' },
    blockedReason: 'private_network_pending', token: 'private-token' },
  reason: 'Read https://example.test/objects/1?signature=private-signature using Bearer private-auth',
};

describe('browser review projection', () => {
  it('exposes reviewed fields and flags and omits execution payloads and credential values', () => {
    const report = makePlanReport({ ...context, actions: [action], blocked: ['Waiting for network'], warnings: ['Check the region'] });
    expect(report.actions[0]).toMatchObject({
      type: 'update', name: 'web', fields: ['env:DB_PASSWORD'], verified: true, requiresConfirm: true, billable: true,
      addresses: ['google_cloud_run_v2_service.web'], dependsOn: ['database:primary'],
    });
    expect(report.blocked).toEqual(['Waiting for network', 'web: private_network_pending']);
    expect(report.warnings).toEqual(['Check the region']);
    const serialized = JSON.stringify(report);
    for (const sentinel of ['private-before', 'private-after', 'private-files', 'private-token', 'private-signature', 'private-auth']) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('distinguishes a saved empty plan from a plan containing unrecognized actions', () => {
    expect(makePlanReport({ ...context, actions: [] }).warnings).toEqual([]);
    const legacy = makePlanReport({ ...context, actions: [action, { steps: ['private-command'] }] });
    expect(legacy.actions).toHaveLength(1);
    expect(legacy.warnings).toContainEqual(expect.stringContaining('cannot display'));
    expect(JSON.stringify(legacy)).not.toContain('private-command');
  });

  it('keeps inline release commands out of historical report actions and migration warnings', () => {
    // A command may contain arbitrary shell arguments, including credentials with no recognizable format.
    const command = 'migrate --connection private-command-argument';
    const report = makePlanReport({ ...context,
      actions: [{ ...action, id: 'release-command:migrations',
        reason: `Run the release command (${command}) with the new code before any service switches.` },
      { ...action, reason: `Project runtime changes from undeclared to node:24 install="${command}" build=none` }],
      warnings: [
        `migrations.mode="releaseCommand" is set but no web service exists to carry the release command, so "${command}" will never run. Add a web service or set releaseCommand on a service explicitly.`,
        `migrations.mode="releaseCommand" is set to "${command}", but web service releaseCommand is already set on web. Hypervibe will not overwrite explicit service releaseCommand values, so the migration command will not run unless one of those commands includes it.`,
      ],
    });
    expect(JSON.stringify(report)).not.toContain('private-command-argument');
    expect(report.actions[0]?.reason).toMatch(/release command/i);
    expect(report.warnings.join(' ')).toMatch(/no web service/i);
    expect(report.warnings.join(' ')).toMatch(/explicit release command/i);
  });

  it('represents whole-plan setup approval independently of action confirmation IDs', () => {
    const report = makePlanReport({ ...context, scope: 'Google Cloud project setup', approval: 'whole-plan', actions: [action] });
    expect(report.approval).toBe('whole-plan');
    expect(report.actions[0]).toMatchObject({ billable: true, requiresConfirm: false });
  });
});
