import type { LocalSnapshot, PlanAction } from '../plan/plan.types.js';
import type { ObservedDatabase, ObservedState } from '../ports/observe.port.js';
import type { DatabaseReplicaBinding } from '../ports/database-resilience.port.js';
import type { EnvironmentSpec } from '../spec/spec.schema.js';
import { databaseReplicaEnvKey } from './database-env.js';
import { HOSTING_ENV_REMOVE_OPERATION } from './hosting-env.service.js';

export const DATABASE_RESILIENCE_OPERATIONS = {
  availabilityConfigure: 'databaseAvailabilityConfigure',
  backupPolicyConfigure: 'databaseBackupPolicyConfigure',
  replicaProvision: 'databaseReplicaProvision',
  replicaDestroy: 'databaseReplicaDestroy',
} as const;

const DATABASE_RESILIENCE_OPERATION_SET = new Set<string>(Object.values(DATABASE_RESILIENCE_OPERATIONS));

export interface DatabaseResilienceCapabilities {
  availabilityModes?: Array<'zonal' | 'regional'>;
  backups?: { maxRetainedBackups: number; maxPitrRetentionDays: number };
  readReplicas?: boolean;
}

export interface DatabaseResiliencePlanResult {
  actions: PlanAction[];
  warnings: string[];
  unmanaged: Array<{ kind: 'database'; name: string; detail?: string }>;
  serviceDependencies: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function databaseReplicaBindings(
  component: LocalSnapshot['components'][number] | undefined
): Record<string, DatabaseReplicaBinding> {
  const resilience = asRecord(component?.bindings.resilience);
  return (asRecord(resilience?.replicas) ?? {}) as unknown as Record<string, DatabaseReplicaBinding>;
}

function action(params: {
  id: string;
  type: PlanAction['type'];
  provider: string;
  name: string;
  operation: string;
  reason: string;
  verified: boolean;
  metadata?: Record<string, unknown>;
  diff?: PlanAction['diff'];
  dependsOn?: string[];
  billable?: boolean;
  dataBearing?: boolean;
  requiresConfirm?: boolean;
}): PlanAction {
  return {
    id: params.id,
    type: params.type,
    resource: { kind: 'database', name: params.name, provider: params.provider },
    verified: params.verified,
    reason: params.reason,
    ...(params.diff?.length ? { diff: params.diff } : {}),
    ...(params.dependsOn?.length ? { dependsOn: params.dependsOn } : {}),
    ...(params.billable ? { billable: true } : {}),
    ...(params.dataBearing ? { dataBearing: true } : {}),
    ...(params.requiresConfirm ? { requiresConfirm: true } : {}),
    metadata: { operation: params.operation, ...(params.metadata ?? {}) },
  };
}

function blocked(params: {
  id: string;
  provider: string;
  name: string;
  operation: string;
  reason: string;
  blockedReason: string;
  metadata?: Record<string, unknown>;
}): PlanAction {
  return action({
    ...params,
    type: 'update',
    verified: false,
    metadata: { blockedReason: params.blockedReason, ...(params.metadata ?? {}) },
  });
}

function desiredPrimary(
  observed: ObservedState | null,
  provider: string,
  externalId: string
): ObservedDatabase | undefined {
  return observed?.databases.find((database) =>
    database.provider === provider && database.externalId === externalId
  );
}

export function planDatabaseResilience(params: {
  environmentSpec: EnvironmentSpec;
  observed: ObservedState | null;
  local: LocalSnapshot;
  capabilities?: DatabaseResilienceCapabilities;
}): DatabaseResiliencePlanResult {
  const desiredDatabase = params.environmentSpec.database;
  const desired = desiredDatabase?.resilience;
  if (!desired || !desiredDatabase) {
    return { actions: [], warnings: [], unmanaged: [], serviceDependencies: [] };
  }

  const provider = desiredDatabase.provider;
  const component = params.local.components.find((candidate) => candidate.type === desiredDatabase.engine);
  const componentProvider = typeof component?.bindings.provider === 'string'
    ? component.bindings.provider
    : undefined;
  const primaryExternalId = component?.externalId
    ?? (typeof component?.bindings.instanceId === 'string' ? component.bindings.instanceId : undefined);
  const warnings: string[] = [];
  const unmanaged: DatabaseResiliencePlanResult['unmanaged'] = [];
  const actions: PlanAction[] = [];
  const serviceDependencies: string[] = [];

  if (!component || componentProvider !== provider || !primaryExternalId) {
    warnings.push('Database resilience will be planned after the desired primary database is durably bound.');
    return { actions, warnings, unmanaged, serviceDependencies };
  }

  const observationKnown = Boolean(
    params.observed && params.observed.completeness?.databases !== 'unknown'
  );
  const observedPrimary = observationKnown
    ? desiredPrimary(params.observed, provider, primaryExternalId)
    : undefined;
  const commonMetadata = { engine: desiredDatabase.engine, primaryExternalId };

  if (!observationKnown || !observedPrimary) {
    actions.push(blocked({
      id: `database:${provider}:resilience`,
      provider,
      name: desiredDatabase.engine,
      operation: DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure,
      reason: !observationKnown
        ? 'Database resilience cannot be reconciled because live database observation is unknown'
        : `The bound primary database ${primaryExternalId} was not observed`,
      blockedReason: !observationKnown ? 'database_resilience_observation_unknown' : 'database_primary_not_observed',
      metadata: commonMetadata,
    }));
    return { actions, warnings, unmanaged, serviceDependencies };
  }

  const capabilities = params.capabilities;
  const live = observedPrimary.resilience;
  const unsupported = (feature: string, operation: string): void => {
    actions.push(blocked({
      id: `database:${provider}:resilience:${feature}`,
      provider,
      name: desiredDatabase.engine,
      operation,
      reason: `${provider} does not support declarative database ${feature} through Hypervibe`,
      blockedReason: 'database_resilience_unsupported',
      metadata: { ...commonMetadata, feature },
    }));
  };

  if (desired.availability) {
    if (!capabilities?.availabilityModes?.includes(desired.availability)) {
      unsupported('availability', DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure);
    } else if (!live?.availability || live.availability === 'unknown') {
      actions.push(blocked({
        id: `database:${provider}:availability`,
        provider,
        name: desiredDatabase.engine,
        operation: DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure,
        reason: 'The provider did not return a known database availability mode',
        blockedReason: 'database_availability_observation_unknown',
        metadata: { ...commonMetadata, availability: desired.availability },
      }));
    } else {
      const changing = live.availability !== desired.availability;
      const reducing = live.availability === 'regional' && desired.availability === 'zonal';
      actions.push(action({
        id: `database:${provider}:availability`,
        type: changing ? 'update' : 'noop',
        provider,
        name: desiredDatabase.engine,
        operation: DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure,
        verified: true,
        reason: changing
          ? `Database availability changes from ${live.availability} to ${desired.availability}`
          : `Database availability is ${desired.availability}`,
        diff: changing ? [{ field: 'availability', from: live.availability, to: desired.availability }] : undefined,
        billable: changing && !reducing,
        dataBearing: changing && reducing,
        requiresConfirm: changing && reducing,
        metadata: { ...commonMetadata, availability: desired.availability },
      }));
    }
  }

  if (desired.backups) {
    const maxPitr = capabilities?.backups?.maxPitrRetentionDays;
    const maxBackups = capabilities?.backups?.maxRetainedBackups;
    if (!capabilities?.backups) {
      unsupported('backups', DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure);
    } else if (desired.backups.pitrRetentionDays > maxPitr! || desired.backups.retainedBackups > maxBackups!) {
      actions.push(blocked({
        id: `database:${provider}:backup-policy`,
        provider,
        name: desiredDatabase.engine,
        operation: DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure,
        reason: `${provider} supports at most ${maxBackups} retained backups and ${maxPitr} PITR days for this database class`,
        blockedReason: 'database_backup_policy_out_of_range',
        metadata: { ...commonMetadata, ...desired.backups },
      }));
    } else {
      const current = live?.backupPolicy;
      if (!current || current.retainedBackups === undefined || current.pitrRetentionDays === undefined) {
        actions.push(blocked({
          id: `database:${provider}:backup-policy`,
          provider,
          name: desiredDatabase.engine,
          operation: DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure,
          reason: 'The provider did not return a complete backup and PITR policy',
          blockedReason: 'database_backup_observation_unknown',
          metadata: { ...commonMetadata, ...desired.backups },
        }));
      } else {
        const changing = !current.enabled
          || !current.pitrEnabled
          || current.retainedBackups !== desired.backups.retainedBackups
          || current.pitrRetentionDays !== desired.backups.pitrRetentionDays;
        const reducing = current.retainedBackups > desired.backups.retainedBackups
          || current.pitrRetentionDays > desired.backups.pitrRetentionDays;
        const increasing = current.retainedBackups < desired.backups.retainedBackups
          || current.pitrRetentionDays < desired.backups.pitrRetentionDays
          || !current.enabled
          || !current.pitrEnabled;
        actions.push(action({
          id: `database:${provider}:backup-policy`,
          type: changing ? 'update' : 'noop',
          provider,
          name: desiredDatabase.engine,
          operation: DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure,
          verified: true,
          reason: changing ? 'Database backup/PITR policy differs from the spec' : 'Database backup/PITR policy is in sync',
          diff: changing ? [
            { field: 'retainedBackups', from: String(current.retainedBackups), to: String(desired.backups.retainedBackups) },
            { field: 'pitrRetentionDays', from: String(current.pitrRetentionDays), to: String(desired.backups.pitrRetentionDays) },
          ] : undefined,
          billable: increasing,
          dataBearing: reducing,
          requiresConfirm: reducing,
          metadata: { ...commonMetadata, ...desired.backups },
        }));
      }
    }
  }

  if (
    desired.availability === 'regional'
    && (!live?.backupPolicy?.enabled || !live.backupPolicy.pitrEnabled)
  ) {
    const availabilityIndex = actions.findIndex((candidate) =>
      candidate.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure
      && candidate.id === `database:${provider}:availability`
    );
    const backupAction = actions.find((candidate) =>
      candidate.metadata?.operation === DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure
      && candidate.id === `database:${provider}:backup-policy`
    );
    if (availabilityIndex >= 0 && backupAction && backupAction.type !== 'noop') {
      actions[availabilityIndex] = {
        ...actions[availabilityIndex],
        dependsOn: Array.from(new Set([
          ...(actions[availabilityIndex].dependsOn ?? []),
          backupAction.id,
        ])),
      };
    } else if (availabilityIndex >= 0 && !desired.backups) {
      actions[availabilityIndex] = blocked({
        id: `database:${provider}:availability`,
        provider,
        name: desiredDatabase.engine,
        operation: DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure,
        reason: 'Regional availability requires provider-managed backups and PITR to be enabled first',
        blockedReason: 'database_regional_availability_requires_backups',
        metadata: { ...commonMetadata, availability: 'regional' },
      });
    }
  }

  const desiredReplicas = desired.replicas ?? {};
  const boundReplicas = databaseReplicaBindings(component);
  if (
    (Object.keys(desiredReplicas).length > 0 || Object.keys(boundReplicas).length > 0)
    && !Array.isArray(live?.replicas)
  ) {
    actions.push(blocked({
      id: `database:${provider}:replicas`,
      provider,
      name: desiredDatabase.engine,
      operation: DATABASE_RESILIENCE_OPERATIONS.replicaProvision,
      reason: 'The provider did not return a complete read-replica observation',
      blockedReason: 'database_replica_observation_unknown',
      metadata: commonMetadata,
    }));
    return { actions, warnings, unmanaged, serviceDependencies };
  }
  const observedReplicas = live?.replicas ?? [];
  if ((Object.keys(desiredReplicas).length > 0 || Object.keys(boundReplicas).length > 0) && !capabilities?.readReplicas) {
    unsupported('read-replicas', DATABASE_RESILIENCE_OPERATIONS.replicaProvision);
    return { actions, warnings, unmanaged, serviceDependencies };
  }

  for (const replica of observedReplicas) {
    if (!Object.values(boundReplicas).some((binding) => binding.externalId === replica.externalId)) {
      unmanaged.push({
        kind: 'database',
        name: replica.name ?? replica.externalId,
        detail: `${provider} read replica ${replica.externalId} is not durably bound to this environment`,
      });
    }
  }

  for (const [name, config] of Object.entries(desiredReplicas)) {
    const id = `database:${provider}:replica:${name}`;
    const binding = boundReplicas[name];
    const logicalMatches = observedReplicas.filter((replica) => replica.name === name);
    if (!binding && logicalMatches.length > 1) {
      actions.push(blocked({
        id,
        provider,
        name,
        operation: DATABASE_RESILIENCE_OPERATIONS.replicaProvision,
        reason: `Multiple read replicas claim the logical name "${name}"; Hypervibe cannot safely select one`,
        blockedReason: 'ambiguous_database_replica_identity',
        metadata: { ...commonMetadata, replicaName: name, externalIds: logicalMatches.map((replica) => replica.externalId).sort(), ...config },
      }));
      continue;
    }
    const observedReplica = binding
      ? observedReplicas.find((replica) => replica.externalId === binding.externalId)
      : logicalMatches[0];
    if (!binding && observedReplica) {
      actions.push(blocked({
        id,
        provider,
        name,
        operation: DATABASE_RESILIENCE_OPERATIONS.replicaProvision,
        reason: `Read replica "${name}" exists but is not adopted into durable Hypervibe state`,
        blockedReason: 'database_replica_adoption_required',
        metadata: { ...commonMetadata, replicaName: name, observedExternalId: observedReplica.externalId, ...config },
      }));
      continue;
    }
    if (binding && ((config.region && binding.region !== config.region) || (config.tier && binding.tier !== config.tier))) {
      actions.push(blocked({
        id,
        provider,
        name,
        operation: DATABASE_RESILIENCE_OPERATIONS.replicaProvision,
        reason: `Read replica "${name}" has immutable region or tier drift; replacement is not in this first slice`,
        blockedReason: 'database_replica_replacement_required',
        metadata: { ...commonMetadata, replicaName: name, replicaExternalId: binding.externalId, ...config },
      }));
      continue;
    }
    const needsCreate = !binding || !observedReplica;
    actions.push(action({
      id,
      type: needsCreate ? 'create' : 'noop',
      provider,
      name,
      operation: DATABASE_RESILIENCE_OPERATIONS.replicaProvision,
      verified: true,
      reason: needsCreate ? `Read replica "${name}" is absent` : `Read replica "${name}" is in sync`,
      billable: needsCreate,
      metadata: {
        ...commonMetadata,
        replicaName: name,
        ...(binding ? { replicaExternalId: binding.externalId } : {}),
        ...config,
      },
    }));
    if (needsCreate) serviceDependencies.push(id);
  }

  for (const [name, binding] of Object.entries(boundReplicas)) {
    if (desiredReplicas[name]) continue;
    const envKeys = [databaseReplicaEnvKey(name)];
    if (Object.keys(boundReplicas).length === 1) envKeys.push('DATABASE_READ_URL');
    const dependencies: string[] = [];
    for (const serviceName of Object.keys(params.environmentSpec.services)) {
      const id = `database:${provider}:replica:${name}:unwire:${serviceName}`;
      actions.push({
        id,
        type: 'update',
        resource: { kind: 'service', name: serviceName, provider: params.environmentSpec.hosting.provider },
        verified: true,
        reason: `Remove read-replica variables for "${name}" before deleting it`,
        metadata: { operation: HOSTING_ENV_REMOVE_OPERATION, keys: envKeys, replicaName: name },
      });
      dependencies.push(id);
    }
    actions.push(action({
      id: `database:${provider}:replica:${name}:destroy`,
      type: 'destroy',
      provider,
      name,
      operation: DATABASE_RESILIENCE_OPERATIONS.replicaDestroy,
      verified: true,
      reason: `Read replica "${name}" was removed from the spec; confirm its deletion`,
      dependsOn: dependencies,
      dataBearing: true,
      requiresConfirm: true,
      metadata: { ...commonMetadata, replicaName: name, replicaExternalId: binding.externalId },
    }));
  }

  return { actions, warnings, unmanaged, serviceDependencies };
}

export function isDatabaseResilienceAction(action: PlanAction): boolean {
  return action.resource.kind === 'database'
    && typeof action.metadata?.operation === 'string'
    && DATABASE_RESILIENCE_OPERATION_SET.has(action.metadata.operation);
}
