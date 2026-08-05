import { describe, expect, it } from 'vitest';
import type { LocalSnapshot } from '../../plan/plan.types.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import {
  DATABASE_RESILIENCE_OPERATIONS,
  planDatabaseResilience,
} from '../database-resilience-plan.service.js';

const capabilities = {
  availabilityModes: ['zonal', 'regional'] as Array<'zonal' | 'regional'>,
  backups: { maxRetainedBackups: 365, maxPitrRetentionDays: 7 },
  readReplicas: true,
  restoreDrills: true,
};

function fixture(params: {
  provider?: string;
  resilience?: Record<string, unknown>;
  componentResilience?: Record<string, unknown>;
  observedResilience?: Record<string, unknown>;
  completeness?: 'complete' | 'unknown';
} = {}) {
  const provider = params.provider ?? 'cloudsql';
  const environmentSpec = environmentSpecSchema.parse({
    hosting: { provider: 'cloudrun' },
    services: { web: {} },
    database: {
      provider,
      resilience: params.resilience ?? {
        availability: 'regional',
        backups: { retainedBackups: 8, pitrRetentionDays: 7 },
        replicas: { analytics: { region: 'us-west1' } },
      },
    },
  });
  const now = new Date();
  const local: LocalSnapshot = {
    projectExists: true,
    environmentExists: true,
    services: [],
    components: [{
      id: 'component-1',
      environmentId: 'env-1',
      type: 'postgres',
      externalId: 'primary-1',
      bindings: {
        provider,
        instanceId: 'primary-1',
        ...(params.componentResilience ? { resilience: params.componentResilience } : {}),
      },
      createdAt: now,
      updatedAt: now,
    }],
    bindings: { services: { web: { serviceId: 'web-1' } } },
  };
  const observed: ObservedState = {
    provider: 'cloudrun',
    observedAt: now.toISOString(),
    projectExists: true,
    services: [],
    databases: [{
      provider,
      engine: 'postgres',
      externalId: 'primary-1',
      status: 'running',
      resilience: (params.observedResilience ?? {
        availability: 'zonal',
        backupPolicy: {
          enabled: true,
          pitrEnabled: true,
          retainedBackups: 7,
          pitrRetentionDays: 7,
        },
        replicas: [],
      }) as NonNullable<ObservedState['databases'][number]['resilience']>,
    }],
    completeness: { databases: params.completeness ?? 'complete' },
    partial: params.completeness === 'unknown',
    warnings: [],
  };
  return { environmentSpec, local, observed };
}

describe('planDatabaseResilience', () => {
  it('plans explicit HA, backup, and replica mutations', () => {
    const plan = planDatabaseResilience({ ...fixture(), capabilities });
    expect(plan.actions.find((action) => action.id.endsWith(':availability'))).toMatchObject({
      type: 'update',
      billable: true,
      metadata: { operation: DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure, primaryExternalId: 'primary-1' },
    });
    expect(plan.actions.find((action) => action.id.endsWith(':backup-policy'))).toMatchObject({
      type: 'update',
      billable: true,
    });
    expect(plan.actions.find((action) => action.id.endsWith(':replica:analytics'))).toMatchObject({
      type: 'create',
      billable: true,
      metadata: { replicaName: 'analytics', region: 'us-west1' },
    });
    expect(plan.serviceDependencies).toEqual(['database:cloudsql:replica:analytics']);
  });

  it('blocks every resilience mutation when observation is unknown', () => {
    const plan = planDatabaseResilience({ ...fixture({ completeness: 'unknown' }), capabilities });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      type: 'update',
      verified: false,
      metadata: { blockedReason: 'database_resilience_observation_unknown' },
    });
  });

  it('orders required backup enablement before regional HA', () => {
    const plan = planDatabaseResilience({
      ...fixture({
        observedResilience: {
          availability: 'zonal',
          backupPolicy: { enabled: false, pitrEnabled: false, retainedBackups: 7, pitrRetentionDays: 7 },
          replicas: [],
        },
      }),
      capabilities,
    });
    expect(plan.actions.find((action) => action.id === 'database:cloudsql:availability')?.dependsOn)
      .toEqual(['database:cloudsql:backup-policy']);
  });

  it('plans service unwiring before an exact confirm-gated replica deletion', () => {
    const replica = { externalId: 'replica-1', region: 'us-west1', connectionName: 'p:us-west1:replica-1' };
    const plan = planDatabaseResilience({
      ...fixture({
        resilience: { replicas: {} },
        componentResilience: { replicas: { analytics: replica } },
        observedResilience: {
          availability: 'zonal',
          backupPolicy: { enabled: true, pitrEnabled: true, retainedBackups: 8, pitrRetentionDays: 7 },
          replicas: [{ name: 'analytics', externalId: 'replica-1', status: 'running', region: 'us-west1' }],
        },
      }),
      capabilities,
    });
    const unwire = plan.actions.find((action) => action.id.includes(':unwire:web'))!;
    const destroy = plan.actions.find((action) => action.type === 'destroy')!;
    expect(unwire).toMatchObject({
      resource: { kind: 'service', name: 'web', provider: 'cloudrun' },
      metadata: { keys: ['DATABASE_READ_URL_ANALYTICS', 'DATABASE_READ_URL'] },
    });
    expect(destroy).toMatchObject({
      requiresConfirm: true,
      dataBearing: true,
      dependsOn: [unwire.id],
      metadata: { replicaExternalId: 'replica-1' },
    });
  });

  it.each(['railway', 'supabase', 'rds'])('blocks declared features for unsupported %s databases', (provider) => {
    const plan = planDatabaseResilience({ ...fixture({ provider }), capabilities: undefined });
    expect(plan.actions.every((action) => action.type === 'update')).toBe(true);
    expect(plan.actions.every((action) => action.metadata?.blockedReason === 'database_resilience_unsupported')).toBe(true);
  });

  it('blocks a restore-drill declaration when the provider has no compiler capability', () => {
    const plan = planDatabaseResilience({
      ...fixture({
        resilience: {
          backups: { retainedBackups: 8, pitrRetentionDays: 7 },
          restoreDrill: { schedule: { cron: '0 4 * * 1' } },
        },
        observedResilience: {
          availability: 'zonal',
          backupPolicy: { enabled: true, pitrEnabled: true, retainedBackups: 8, pitrRetentionDays: 7 },
          replicas: [],
        },
      }),
      capabilities: { ...capabilities, restoreDrills: false },
    });

    expect(plan.actions).toContainEqual(expect.objectContaining({
      id: 'database:cloudsql:resilience:restore-drills',
      metadata: {
        operation: DATABASE_RESILIENCE_OPERATIONS.restoreDrillSchedule,
        blockedReason: 'database_resilience_unsupported',
        engine: 'postgres',
        primaryExternalId: 'primary-1',
        feature: 'restore-drills',
      },
    }));
  });
});
