import { describe, expect, it } from 'vitest';
import type { Environment } from '../../entities/environment.entity.js';
import type { ObservedState } from '../../ports/observe.port.js';
import type { EnvironmentSpec } from '../../spec/spec.schema.js';
import { resolvePlanActionAuthority } from '../../plan/action-authority.js';
import { planMaintenance } from '../maintenance-plan.service.js';

const fingerprint = 'a'.repeat(64);
const target = { origin: 'https://replacement.run.app', targetFingerprint: fingerprint };
function fixture(page: 'active' | 'off' = 'off') {
  const spec = { hosting: { provider: 'railway' }, services: { web: { workloadKind: 'web' } },
    domain: 'app.example.com', domainTarget: { environment: 'next', service: 'web' },
    maintenance: { enabled: true, mode: 'application', page },
  } as unknown as EnvironmentSpec;
  const environment = { platformBindings: { maintenance: { state: 'active', mode: 'application',
    edge: { hostname: spec.domain, accountId: 'account', zoneId: 'zone', routeId: 'route', scriptName: 'script', contentHash: 'hash' },
    workloads: { web: { serviceId: 'web-id', workloadKind: 'web', wasRunning: true } },
  } } } as unknown as Environment;
  const observed = { maintenance: { state: 'partial', stage: 'routing', mode: 'application', page: 'active',
    edge: { state: 'active', hostname: spec.domain, markerVerified: true },
    workloads: { web: { serviceId: 'web-id', workloadKind: 'web', state: 'suspended' } },
    database: { state: 'unmanaged' }, routing: { state: 'ready', target },
  } } as unknown as ObservedState;
  return { environmentName: 'production', environmentSpec: spec, environment, observed };
}

describe('maintenance traffic routing', () => {
  it('requires reviewed target routing after the original workloads are paused', () => {
    const input = fixture();
    const result = planMaintenance(input);
    const route = result.actions.find(action => action.metadata?.operation === 'maintenanceEdgeRoute');
    expect(route).toMatchObject({ type: 'update', requiresConfirm: true,
      dependsOn: ['maintenance:production:workload:web'],
      metadata: { hostname: 'app.example.com', targetEnvironment: 'next', targetService: 'web', ...target } });
    expect(resolvePlanActionAuthority(route!)).toMatchObject({ capability: 'maintenance.edge.mutate' });
    expect(resolvePlanActionAuthority({ ...route!, requiresConfirm: false })).toBeNull();
    expect(resolvePlanActionAuthority({ ...route!, metadata: { ...route!.metadata, targetFingerprint: undefined } })).toBeNull();
    expect(result.actions.some(action => action.metadata?.operation === 'maintenanceWorkloadResume')).toBe(false);
  });

  it('keeps the maintenance page when the replacement cannot be verified', () => {
    const input = fixture();
    input.observed.maintenance!.routing = { state: 'unknown', reason: 'target_health_unverified' };
    const route = planMaintenance(input).actions.find(action => action.metadata?.operation === 'maintenanceEdgeRoute');
    expect(route).toMatchObject({ verified: false, metadata: { blockedReason: 'target_health_unverified' } });
  });

  it('restores the page on the same route without resuming the source', () => {
    const input = fixture('active');
    input.observed.maintenance!.page = 'off';
    Object.assign(input.observed.maintenance!.edge, target);
    const result = planMaintenance(input);
    expect(result.actions[0]).toMatchObject({ type: 'update', metadata: { operation: 'maintenanceEdgeEnable' } });
    expect(result.actions.some(action => action.metadata?.operation === 'maintenanceWorkloadResume')).toBe(false);
  });

  it('does not mutate an already verified route to the same target', () => {
    const input = fixture();
    Object.assign(input.observed.maintenance!, { page: 'off', state: 'active', stage: 'verified' });
    Object.assign(input.observed.maintenance!.edge, target);
    expect(planMaintenance(input).actions.every(action => action.type === 'noop')).toBe(true);
  });
});
