import { describe, expect, it } from 'vitest';
import {
  buildLoadBalancerLiveSpec,
  buildRecoveryLiveSpec,
  restoreDrillResourceEvents,
  safeLoadBalancerBinding,
  safeOutstandingActions,
  successfulRestoreDrillEvidence,
} from './infrastructure-live-harness.js';

describe('infrastructure live-conformance evidence', () => {
  it('builds the staged recovery and two-origin load-balancer desired states', () => {
    const bootstrap = buildRecoveryLiveSpec({
      projectName: 'recovery-live',
      repository: 'owner/recovery-live',
      github: false,
      replica: true,
      restoreDrill: false,
      database: true,
    });
    expect(bootstrap.github).toBeUndefined();
    expect(bootstrap.environments.production.database).toMatchObject({
      provider: 'cloudsql',
      resilience: {
        backups: { retainedBackups: 8, pitrRetentionDays: 7 },
        replicas: { live: {} },
      },
    });

    const withDrill = buildRecoveryLiveSpec({
      projectName: 'recovery-live',
      repository: 'owner/recovery-live',
      github: true,
      replica: true,
      restoreDrill: true,
      database: true,
    });
    expect(withDrill.github.canonicalEnvironment).toBe('production');
    expect(withDrill.environments.production.database.resilience.restoreDrill).toMatchObject({
      credentialsSecret: 'HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS',
      retainFailedInstanceDays: 1,
    });

    const loadBalancer = buildLoadBalancerLiveSpec({
      projectName: 'load-balancer-live',
      hostname: 'hv-conformance-one.example.com',
      services: true,
      loadBalancer: true,
    });
    expect(loadBalancer.environments.conformance.loadBalancer).toEqual({
      provider: 'cloudflare',
      services: ['origin-a', 'origin-b'],
      healthCheckPath: '/health',
    });
    expect(Object.keys(loadBalancer.environments.conformance.services)).toEqual([
      'origin-a',
      'origin-b',
    ]);
  });

  it('requires one generated restore target and provider-terminal deletion', () => {
    const logs = [
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-abc123 disposition=created',
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-abc123 disposition=deleted',
    ];

    expect(restoreDrillResourceEvents(logs)).toEqual([
      { target: 'hv-drill-abc123', disposition: 'created' },
      { target: 'hv-drill-abc123', disposition: 'deleted' },
    ]);
    expect(successfulRestoreDrillEvidence(logs)).toEqual({
      ok: true,
      target: 'hv-drill-abc123',
    });
  });

  it('reports retained, cleanup-failed, missing, and ambiguous targets', () => {
    expect(successfulRestoreDrillEvidence([
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-one disposition=created',
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-one disposition=retained',
    ])).toMatchObject({ ok: false, reason: expect.stringContaining('retained') });

    expect(successfulRestoreDrillEvidence([
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-one disposition=created',
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-one disposition=cleanup-failed',
    ])).toMatchObject({ ok: false, reason: expect.stringContaining('cleanup failed') });

    expect(successfulRestoreDrillEvidence([
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-one disposition=created',
    ])).toMatchObject({ ok: false, reason: expect.stringContaining('no provider-terminal deletion') });

    expect(successfulRestoreDrillEvidence([
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-one disposition=created',
      'HYPERVIBE_DRILL_RESOURCE target=hv-drill-two disposition=created',
    ])).toMatchObject({ ok: false, reason: expect.stringContaining('observed 2') });
  });

  it('reduces plans and repo bindings to non-secret cleanup diagnostics', () => {
    const plan = {
      data: {
        actions: [
          { id: 'project', type: 'noop', resource: { kind: 'project', name: 'app' } },
          {
            id: 'load-balancer:app.example.com:destroy',
            type: 'destroy',
            resource: {
              kind: 'load-balancer',
              name: 'app.example.com',
              provider: 'cloudflare',
            },
            metadata: {
              blockedReason: 'provider_timeout',
              connectionUrl: 'must-not-escape',
            },
          },
        ],
      },
    };
    expect(safeOutstandingActions(plan)).toEqual([{
      actionId: 'load-balancer:app.example.com:destroy',
      type: 'destroy',
      kind: 'load-balancer',
      provider: 'cloudflare',
      name: 'app.example.com',
      blockedReason: 'provider_timeout',
    }]);
    expect(JSON.stringify(safeOutstandingActions(plan))).not.toContain('must-not-escape');

    const binding = safeLoadBalancerBinding({
      environments: {
        conformance: {
          platformBindings: {
            loadBalancer: {
              provider: 'cloudflare',
              hostname: 'app.example.com',
              accountId: 'account-1',
              zoneId: 'zone-1',
              apiToken: 'must-not-escape',
              monitor: { id: 'monitor-1' },
              pool: { id: 'pool-1' },
              loadBalancer: { id: 'load-balancer-1' },
            },
          },
        },
      },
    }, 'conformance');
    expect(binding).toEqual({
      provider: 'cloudflare',
      hostname: 'app.example.com',
      accountId: 'account-1',
      zoneId: 'zone-1',
      monitorId: 'monitor-1',
      poolId: 'pool-1',
      loadBalancerId: 'load-balancer-1',
    });
    expect(JSON.stringify(binding)).not.toContain('must-not-escape');
  });
});
