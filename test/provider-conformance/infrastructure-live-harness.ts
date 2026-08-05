import { projectSpecSchema } from '../../src/domain/spec/spec.schema.js';

export type JsonObject = Record<string, any>;

export type RestoreDrillDisposition =
  | 'created'
  | 'deleted'
  | 'retained'
  | 'cleanup-failed';

export interface RestoreDrillResourceEvent {
  target: string;
  disposition: RestoreDrillDisposition;
}

export interface SafeOutstandingAction {
  actionId: string;
  type: string;
  kind: string;
  provider?: string;
  name: string;
  blockedReason?: string;
}

export interface SafeLoadBalancerBinding {
  provider?: string;
  hostname?: string;
  accountId?: string;
  zoneId?: string;
  monitorId?: string;
  poolId?: string;
  loadBalancerId?: string;
}

export function buildRecoveryLiveSpec(params: {
  projectName: string;
  repository: string;
  github: boolean;
  replica: boolean;
  restoreDrill: boolean;
  database: boolean;
}): JsonObject {
  return projectSpecSchema.parse({
    version: 1,
    project: params.projectName,
    gitRemoteUrl: `https://github.com/${params.repository}.git`,
    ...(params.github
      ? { github: { canonicalEnvironment: 'production' } }
      : {}),
    environments: {
      production: {
        hosting: { provider: 'cloudrun' },
        services: {},
        ...(params.database
          ? {
            database: {
              provider: 'cloudsql',
              resilience: {
                backups: { retainedBackups: 8, pitrRetentionDays: 7 },
                ...(params.replica ? { replicas: { live: {} } } : {}),
                ...(params.restoreDrill
                  ? {
                    restoreDrill: {
                      schedule: { cron: '0 0 29 2 *', timezone: 'UTC' },
                      credentialsSecret: 'HYPERVIBE_CLOUDSQL_DRILL_CREDENTIALS',
                      verificationQuery: 'SELECT 1',
                      restoreLagMinutes: 10,
                      retainFailedInstanceDays: 1,
                    },
                  }
                  : {}),
              },
            },
          }
          : {}),
        email: { enabled: false },
        envVars: {},
        deploy: { strategy: 'manual' },
      },
    },
  });
}

export function buildLoadBalancerLiveSpec(params: {
  projectName: string;
  hostname: string;
  services: boolean;
  loadBalancer: boolean;
  healthCheckPath?: string;
}): JsonObject {
  return projectSpecSchema.parse({
    version: 1,
    project: params.projectName,
    environments: {
      conformance: {
        hosting: { provider: 'railway' },
        services: params.services
          ? {
            'origin-a': {
              workloadKind: 'web',
              startCommand: 'node server.mjs',
              healthCheckPath: '/health',
              public: true,
            },
            'origin-b': {
              workloadKind: 'web',
              startCommand: 'node server.mjs',
              healthCheckPath: '/health',
              public: true,
            },
          }
          : {},
        ...(params.loadBalancer
          ? {
            domain: params.hostname,
            loadBalancer: {
              provider: 'cloudflare',
              services: ['origin-a', 'origin-b'],
              healthCheckPath: params.healthCheckPath ?? '/health',
            },
          }
          : {}),
        email: { enabled: false },
        envVars: params.services
          ? { HYPERVIBE_CONFORMANCE_REVISION: 'live' }
          : {},
        deploy: { strategy: 'manual' },
      },
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function restoreDrillResourceEvents(
  logs: unknown
): RestoreDrillResourceEvent[] {
  const text = typeof logs === 'string' ? logs : JSON.stringify(logs ?? '');
  const events: RestoreDrillResourceEvent[] = [];
  const pattern = /HYPERVIBE_DRILL_RESOURCE target=(hv-drill-[a-z0-9-]{1,54}) disposition=(created|deleted|retained|cleanup-failed)/g;
  for (const match of text.matchAll(pattern)) {
    events.push({
      target: match[1]!,
      disposition: match[2]! as RestoreDrillDisposition,
    });
  }
  return events;
}

export function successfulRestoreDrillEvidence(
  logs: unknown
): { ok: true; target: string } | { ok: false; reason: string } {
  const events = restoreDrillResourceEvents(logs);
  const createdTargets = Array.from(new Set(
    events
      .filter((event) => event.disposition === 'created')
      .map((event) => event.target)
  ));
  if (createdTargets.length !== 1) {
    return {
      ok: false,
      reason: `Expected one created restore-drill target marker; observed ${createdTargets.length}.`,
    };
  }
  const target = createdTargets[0]!;
  const targetEvents = events.filter((event) => event.target === target);
  if (targetEvents.some((event) => (
    event.disposition === 'retained'
    || event.disposition === 'cleanup-failed'
  ))) {
    return {
      ok: false,
      reason: `Restore-drill target ${target} was retained or its cleanup failed.`,
    };
  }
  if (!targetEvents.some((event) => event.disposition === 'deleted')) {
    return {
      ok: false,
      reason: `Restore-drill target ${target} has no provider-terminal deletion marker.`,
    };
  }
  return { ok: true, target };
}

export function safeOutstandingActions(
  planEnvelope: JsonObject
): SafeOutstandingAction[] {
  return (planEnvelope.data?.actions as JsonObject[] ?? [])
    .filter((action) => action.type !== 'noop')
    .map((action) => ({
      actionId: String(action.id ?? 'unknown'),
      type: String(action.type ?? 'unknown'),
      kind: String(action.resource?.kind ?? 'unknown'),
      ...(typeof action.resource?.provider === 'string'
        ? { provider: action.resource.provider }
        : {}),
      name: String(action.resource?.name ?? 'unknown'),
      ...(typeof action.metadata?.blockedReason === 'string'
        ? { blockedReason: action.metadata.blockedReason }
        : {}),
    }));
}

export function safeLoadBalancerBinding(
  bindingsDocument: unknown,
  environmentName: string
): SafeLoadBalancerBinding | null {
  const document = asRecord(bindingsDocument);
  const environments = asRecord(document?.environments);
  const environment = asRecord(environments?.[environmentName]);
  const platformBindings = asRecord(environment?.platformBindings);
  const loadBalancer = asRecord(platformBindings?.loadBalancer);
  if (!loadBalancer) return null;
  const monitor = asRecord(loadBalancer.monitor);
  const pool = asRecord(loadBalancer.pool);
  const publicLoadBalancer = asRecord(loadBalancer.loadBalancer);
  return {
    ...(stringField(loadBalancer, 'provider')
      ? { provider: stringField(loadBalancer, 'provider') }
      : {}),
    ...(stringField(loadBalancer, 'hostname')
      ? { hostname: stringField(loadBalancer, 'hostname') }
      : {}),
    ...(stringField(loadBalancer, 'accountId')
      ? { accountId: stringField(loadBalancer, 'accountId') }
      : {}),
    ...(stringField(loadBalancer, 'zoneId')
      ? { zoneId: stringField(loadBalancer, 'zoneId') }
      : {}),
    ...(stringField(monitor, 'id')
      ? { monitorId: stringField(monitor, 'id') }
      : {}),
    ...(stringField(pool, 'id')
      ? { poolId: stringField(pool, 'id') }
      : {}),
    ...(stringField(publicLoadBalancer, 'id')
      ? { loadBalancerId: stringField(publicLoadBalancer, 'id') }
      : {}),
  };
}
