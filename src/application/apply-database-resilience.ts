import type { ActionResult } from '../domain/plan/converge.executor.js';
import type { PlanAction } from '../domain/plan/plan.types.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import {
  supportsDatabaseResilience,
  type DatabaseAvailability,
  type DatabaseReplicaBinding,
} from '../domain/ports/database-resilience.port.js';
import { adapterFactory } from '../domain/services/adapter.factory.js';
import { DATABASE_RESILIENCE_OPERATIONS } from '../domain/services/database-resilience-plan.service.js';
import type { CommandContext } from './context.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function integerField(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function blocked(message: string, error: string): ActionResult {
  return { success: false, status: 'blocked', message, error };
}

export async function applyDatabaseResilienceAction(params: {
  ctx: CommandContext;
  project: Project;
  environmentName: string;
  environmentSpec: EnvironmentSpec;
  action: PlanAction;
}): Promise<ActionResult> {
  const { ctx, project, environmentName, environmentSpec, action } = params;
  const databaseSpec = environmentSpec.database;
  const metadata = asRecord(action.metadata);
  const operation = stringField(metadata, 'operation');
  const primaryExternalId = stringField(metadata, 'primaryExternalId');
  const environment = ctx.repos.environments.findByProjectAndName(project.id, environmentName);
  if (!databaseSpec || !environment) {
    return blocked(
      `Cannot apply database resilience action ${action.id}`,
      !databaseSpec ? 'The current spec has no database.' : `Environment "${environmentName}" is not tracked locally.`
    );
  }
  const component = ctx.repos.components.findByEnvironmentAndType(environment.id, databaseSpec.engine);
  const bindings = asRecord(component?.bindings);
  const currentProvider = stringField(bindings, 'provider');
  const currentExternalId = component?.externalId ?? stringField(bindings, 'instanceId');
  if (
    !component
    || action.resource.provider !== databaseSpec.provider
    || currentProvider !== action.resource.provider
    || !primaryExternalId
    || currentExternalId !== primaryExternalId
  ) {
    return blocked(
      `Database resilience action ${action.id} has stale mutation authority`,
      `Reviewed primary is ${action.resource.provider}/${primaryExternalId ?? 'unknown'}; current primary is ${currentProvider ?? 'unknown'}/${currentExternalId ?? 'unknown'}. Re-run hv_plan.`
    );
  }

  const adapterResult = await adapterFactory.getDatabaseAdapter(action.resource.provider, project);
  if (!adapterResult.success || !adapterResult.adapter) {
    return { success: false, message: 'Database adapter unavailable', error: adapterResult.error };
  }
  if (!supportsDatabaseResilience(adapterResult.adapter)) {
    return blocked(
      `${action.resource.provider} does not implement database resilience mutations`,
      'The provider capability changed after planning. Re-run hv_plan.'
    );
  }
  const adapter = adapterResult.adapter;

  if (operation === DATABASE_RESILIENCE_OPERATIONS.availabilityConfigure) {
    const availability = stringField(metadata, 'availability') as DatabaseAvailability | undefined;
    if (
      !availability
      || !['zonal', 'regional'].includes(availability)
      || databaseSpec.resilience?.availability !== availability
    ) {
      return blocked('Database availability action is invalid', 'The reviewed availability mode does not match the current spec. Re-run hv_plan.');
    }
    const receipt = await adapter.configureAvailability(environment, component, availability);
    return receipt.success
      ? { success: true, message: receipt.message, data: receipt.data }
      : { success: false, message: receipt.message, error: receipt.error, data: receipt.data };
  }

  if (operation === DATABASE_RESILIENCE_OPERATIONS.backupPolicyConfigure) {
    const retainedBackups = integerField(metadata, 'retainedBackups');
    const pitrRetentionDays = integerField(metadata, 'pitrRetentionDays');
    if (
      !retainedBackups
      || !pitrRetentionDays
      || databaseSpec.resilience?.backups?.retainedBackups !== retainedBackups
      || databaseSpec.resilience.backups.pitrRetentionDays !== pitrRetentionDays
    ) {
      return blocked('Database backup policy action is invalid', 'The reviewed retention values do not match the current spec. Re-run hv_plan.');
    }
    const receipt = await adapter.configureBackupPolicy(environment, component, {
      retainedBackups,
      pitrRetentionDays,
    });
    return receipt.success
      ? { success: true, message: receipt.message, data: receipt.data }
      : { success: false, message: receipt.message, error: receipt.error, data: receipt.data };
  }

  const replicaName = stringField(metadata, 'replicaName');
  if (!replicaName || replicaName !== action.resource.name) {
    return blocked('Database replica action is invalid', 'The reviewed logical replica identity is missing or inconsistent.');
  }
  const resilience = asRecord(bindings?.resilience) ?? {};
  const replicas = asRecord(resilience.replicas) ?? {};
  const existing = asRecord(replicas[replicaName]) as (Record<string, unknown> & DatabaseReplicaBinding) | null;

  if (operation === DATABASE_RESILIENCE_OPERATIONS.replicaProvision) {
    const desiredReplica = databaseSpec.resilience?.replicas?.[replicaName];
    if (
      !desiredReplica
      || stringField(metadata, 'region') !== desiredReplica.region
      || stringField(metadata, 'tier') !== desiredReplica.tier
    ) {
      return blocked(
        `Read replica "${replicaName}" no longer matches the current spec`,
        'The reviewed replica region or tier is stale. Re-run hv_plan.'
      );
    }
    const reviewedExternalId = stringField(metadata, 'replicaExternalId');
    if (existing && reviewedExternalId !== stringField(existing, 'externalId')) {
      return blocked(
        `Read replica "${replicaName}" changed after planning`,
        'The durable replica identity no longer matches the reviewed action. Re-run hv_plan.'
      );
    }
    const result = await adapter.provisionReadReplica(environment, component, replicaName, {
      ...(stringField(metadata, 'region') ? { region: stringField(metadata, 'region') } : {}),
      ...(stringField(metadata, 'tier') ? { tier: stringField(metadata, 'tier') } : {}),
    });
    if (!result.receipt.success || !result.replica) {
      return {
        success: false,
        message: result.receipt.message,
        error: result.receipt.error ?? (!result.replica ? 'Provider reported success without a durable replica identity.' : undefined),
        data: result.receipt.data,
      };
    }
    const nextReplicas = {
      ...replicas,
      [replicaName]: { ...result.replica, createdAt: result.replica.createdAt ?? new Date().toISOString() },
    };
    ctx.repos.components.update(component.id, {
      bindings: { ...bindings, resilience: { ...resilience, replicas: nextReplicas } },
      externalId: component.externalId ?? undefined,
    });
    persistTopology(ctx, environment.id, action.resource.provider, primaryExternalId, nextReplicas);
    return {
      success: true,
      message: result.receipt.message,
      data: { replicaName, externalId: result.replica.externalId, region: result.replica.region, tier: result.replica.tier },
    };
  }

  if (operation === DATABASE_RESILIENCE_OPERATIONS.replicaDestroy) {
    if (databaseSpec.resilience?.replicas?.[replicaName]) {
      return blocked(
        `Read replica "${replicaName}" is still declared`,
        'The current spec no longer authorizes this deletion. Re-run hv_plan.'
      );
    }
    const reviewedExternalId = stringField(metadata, 'replicaExternalId');
    if (!existing || !reviewedExternalId || reviewedExternalId !== stringField(existing, 'externalId')) {
      return blocked(
        `Read replica "${replicaName}" changed after planning`,
        'The exact durable provider identity is missing or no longer matches. Re-run hv_plan.'
      );
    }
    const receipt = await adapter.destroyReadReplica(
      environment,
      component,
      replicaName,
      existing as unknown as DatabaseReplicaBinding
    );
    if (!receipt.success) {
      return { success: false, message: receipt.message, error: receipt.error, data: receipt.data };
    }
    const nextReplicas = Object.fromEntries(
      Object.entries(replicas).filter(([name]) => name !== replicaName)
    );
    ctx.repos.components.update(component.id, {
      bindings: { ...bindings, resilience: { ...resilience, replicas: nextReplicas } },
      externalId: component.externalId ?? undefined,
    });
    persistTopology(ctx, environment.id, action.resource.provider, primaryExternalId, nextReplicas);
    return { success: true, message: receipt.message, data: { replicaName, externalId: reviewedExternalId } };
  }

  return blocked(`Unsupported database resilience action ${action.id}`, `Unknown operation ${operation ?? 'unset'}.`);
}

function persistTopology(
  ctx: CommandContext,
  environmentId: string,
  provider: string,
  primaryExternalId: string,
  replicas: Record<string, unknown>
): void {
  const safeReplicas = Object.fromEntries(Object.entries(replicas).flatMap(([name, raw]) => {
    const replica = asRecord(raw);
    const externalId = stringField(replica, 'externalId');
    if (!externalId) return [];
    return [[name, {
      provider,
      externalId,
      ...(stringField(replica, 'region') ? { region: stringField(replica, 'region') } : {}),
      ...(stringField(replica, 'tier') ? { tier: stringField(replica, 'tier') } : {}),
    }]];
  }));
  ctx.repos.environments.updatePlatformBindings(environmentId, {
    databaseTopology: {
      primary: { provider, externalId: primaryExternalId },
      replicas: safeReplicas,
    },
  });
}
