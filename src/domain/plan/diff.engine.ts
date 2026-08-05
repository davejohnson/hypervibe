import type { EnvironmentSpec, ProjectRuntimeSpec, ServiceSpec } from '../spec/spec.schema.js';
import { createHash } from 'crypto';
import { migrationReleaseCommandWarning, withMigrationReleaseCommand } from '../spec/spec-bootstrap.js';
import type { ObservedState, ObservedService } from '../ports/observe.port.js';
import { hashEnvValue } from '../ports/observe.port.js';
import type { PlanAction, PlanFieldDiff, DiffResult, LocalSnapshot } from './plan.types.js';
import { providerRequiresCustomDomainAttach } from '../services/domain-attach-policy.js';
import { buildDatabaseAliasEnvVars } from '../services/database-env.js';

/**
 * Pure diff: desired spec vs observed live state (or local state when the
 * provider is not observable). No repository or adapter imports — everything
 * arrives as input, which makes this the most heavily tested module in the
 * convergence engine.
 *
 * Rules:
 * - `observed === null` → fall back to local entities; all actions verified: false.
 * - Provider change on the database → create new + destroy old, destroy is
 *   confirm-gated (dataBearing) and depends on the create.
 * - Hosting provider change → replace services (create on new provider before
 *   destroying old, handled by the converge executor).
 * - Live resources absent from the spec are destroyed only when local bindings
 *   prove Hypervibe manages them. Otherwise they are reported as unmanaged.
 * - Email/SendGrid is not part of the diff (not observable here); hv_plan
 *   appends provider-precondition items separately.
 */
export function diffEnvironment(input: {
  spec: EnvironmentSpec;
  envName: string;
  observed: ObservedState | null;
  local: LocalSnapshot;
  providerBehavior?: {
    requiresBranchDeployForCode?: boolean;
    serviceCreatesBillable?: boolean;
    workloadKindObservation?: 'exact' | 'cron-only';
    presenceOnlyManagedEnvVar?: (params: { key: string; value: string }) => boolean;
  };
  /** Repo/branch services should be linked to when spec.deploy.strategy is "branch". */
  expectedSource?: { repo: string; branch: string };
  /** Managed database env vars derived from the currently desired database component. */
  managedDatabaseEnvVars?: Record<string, string>;
  managedCacheEnvVars?: Record<string, string>;
  managedQueueEnvVars?: Record<string, string>;
  /** Explicit project build runtime; omission preserves legacy local state. */
  projectRuntime?: ProjectRuntimeSpec;
}): DiffResult {
  const { envName, observed, local, expectedSource, managedDatabaseEnvVars, managedCacheEnvVars, managedQueueEnvVars } = input;
  const providerBehavior = input.providerBehavior ?? {};
  const spec = withMigrationReleaseCommand(input.spec);
  const verified = observed !== null;
  const projectObservationKnown = observed === null || observed.completeness?.project !== 'unknown';
  const serviceObservationKnown = observed === null || observed.completeness?.services !== 'unknown';
  const databaseObservationKnown = observed === null || observed.completeness?.databases !== 'unknown';
  const actions: PlanAction[] = [];
  const unmanaged: DiffResult['unmanaged'] = [];
  const warnings: string[] = [...(observed?.warnings ?? [])];
  const migrationWarning = migrationReleaseCommandWarning(input.spec);
  if (migrationWarning) {
    warnings.push(migrationWarning);
  }
  const provider = spec.hosting.provider;
  if (observed?.partial) {
    warnings.push('Observation was partial; some diffs may be incomplete.');
  }

  // Without a branch deploy strategy, apply creates source-less services that
  // only receive code later if the user runs an out-of-band deploy.
  if (providerBehavior.requiresBranchDeployForCode && Object.keys(spec.services).length > 0 && spec.deploy?.strategy !== 'branch') {
    warnings.push(
      `deploy.strategy is "${spec.deploy?.strategy ?? 'unset'}": ${provider} apply will create services without a source, `
      + 'so NO CODE WILL BE DEPLOYED. '
      + 'Set deploy: { strategy: "branch", trigger: "ci" } so hv_plan/hv_apply can manage the GitHub Actions deploy workflow unless infrastructure-only is intended.'
    );
  }

  // ---- project / environment ------------------------------------------------
  const boundProvider = local.bindings?.provider;
  const providerChanged = Boolean(boundProvider && boundProvider !== provider);

  const projectExists = observed && projectObservationKnown
    ? observed.projectExists
    : Boolean(local.bindings?.projectId);
  const projectActionId = `project:${provider}`;
  if (!projectExists || providerChanged) {
    actions.push({
      id: projectActionId,
      type: !projectObservationKnown && !providerChanged ? 'update' : 'create',
      resource: { kind: 'project', name: envName, provider },
      verified: verified && projectObservationKnown,
      reason: !projectObservationKnown && !providerChanged
        ? `Cannot verify whether the ${provider} project exists`
        : providerChanged
        ? `Hosting provider changes from ${boundProvider} to ${provider}`
        : `No ${provider} project exists for this environment`,
      ...(!projectObservationKnown && !providerChanged
        ? { metadata: { blockedReason: 'project_observation_unknown' } }
        : {}),
    });
  }
  const projectDep = actions.some((a) => a.id === projectActionId) ? [projectActionId] : undefined;

  // ---- services -------------------------------------------------------------
  const observedServiceGroups = new Map<string, ObservedService[]>();
  for (const service of observed?.services ?? []) {
    observedServiceGroups.set(service.name, [
      ...(observedServiceGroups.get(service.name) ?? []),
      service,
    ]);
  }
  const observedServices = new Map<string, ObservedService>(
    [...observedServiceGroups.entries()]
      .filter(([, candidates]) => candidates.length === 1)
      .map(([name, candidates]) => [name, candidates[0]!])
  );
  const localServices = new Map(local.services.map((s) => [s.name, s]));
  const localServiceBindings = local.bindings?.services ?? {};

  for (const [name, serviceSpec] of Object.entries(spec.services)) {
    const id = `service:${name}`;
    const resource = { kind: 'service' as const, name, provider };

    if (providerChanged) {
      actions.push({
        id,
        type: 'replace',
        resource,
        verified,
        reason: `Service moves from ${boundProvider} to ${provider} (create new, verify health, then remove old)`,
        dependsOn: projectDep,
        ...(providerBehavior.serviceCreatesBillable
          ? { billable: true, requiresConfirm: true }
          : {}),
      });
      continue;
    }

    const duplicateCandidates = observedServiceGroups.get(name) ?? [];
    if (duplicateCandidates.length > 1) {
      actions.push({
        id,
        type: 'update',
        resource,
        verified: true,
        reason: `Multiple live services map to logical service "${name}"; explicit adoption or cleanup is required`,
        metadata: {
          blockedReason: 'ambiguous_service_identity',
          externalIds: duplicateCandidates.map((candidate) => candidate.externalId).sort(),
        },
      });
      warnings.push(
        `Ambiguous service identity for "${name}": ${duplicateCandidates.map((candidate) => candidate.externalId).join(', ')}. Hypervibe will not mutate any candidate.`
      );
      continue;
    }

    if (observed && serviceObservationKnown) {
      const live = observedServices.get(name);
      if (!live) {
        actions.push({
          id,
          type: 'create',
          resource,
          verified: true,
          reason: `Service "${name}" is not deployed on ${provider}`,
          dependsOn: projectDep,
          ...(providerBehavior.serviceCreatesBillable
            ? { billable: true, requiresConfirm: true }
            : {}),
        });
        continue;
      }

      // Only cron-ness is structural for providers that model scheduled jobs
      // as a different resource; web<->worker converges via service config.
      if ((live.workloadKind === 'cron') !== (serviceSpec.workloadKind === 'cron')) {
        actions.push({
          id,
          type: 'replace',
          resource,
          verified: true,
          reason: `Workload kind changes from ${live.workloadKind} to ${serviceSpec.workloadKind}`,
          diff: [{ field: 'workloadKind', from: live.workloadKind, to: serviceSpec.workloadKind }],
          dependsOn: projectDep,
          ...(providerBehavior.serviceCreatesBillable
            ? { billable: true, requiresConfirm: true }
            : {}),
        });
        continue;
      }

      const presenceOnlyManagedEnvVars = providerBehavior.presenceOnlyManagedEnvVar
        ? new Set(Object.entries({
          ...(managedDatabaseEnvVars ?? {}),
          ...buildDatabaseAliasEnvVars(managedDatabaseEnvVars ?? {}, serviceSpec.databaseEnvAliases),
          ...(managedCacheEnvVars ?? {}),
          ...(managedQueueEnvVars ?? {}),
        })
          .filter(([key, value]) => providerBehavior.presenceOnlyManagedEnvVar?.({ key, value }))
          .map(([key]) => key))
        : undefined;
      const desiredServiceEnvVars = {
        ...(managedDatabaseEnvVars ?? {}),
        ...buildDatabaseAliasEnvVars(managedDatabaseEnvVars ?? {}, serviceSpec.databaseEnvAliases),
        ...(managedCacheEnvVars ?? {}),
        ...(managedQueueEnvVars ?? {}),
        ...spec.envVars,
      };
      const diff = diffServiceConfig(serviceSpec, live, desiredServiceEnvVars, {
        presenceOnlyEnvVars: presenceOnlyManagedEnvVars,
      });
      const localRuntime = localServices.get(name)?.buildConfig.runtime;
      const runtimeDrift = Boolean(input.projectRuntime)
        && JSON.stringify(localRuntime) !== JSON.stringify(input.projectRuntime);
      if (runtimeDrift) {
        diff.push({
          field: 'runtime',
          from: localRuntime ? `${localRuntime.kind}:${localRuntime.version}` : 'undeclared',
          to: `${input.projectRuntime!.kind}:${input.projectRuntime!.version}`,
        });
      }
      const workloadKindObservable = providerBehavior.workloadKindObservation !== 'cron-only';
      if (live.workloadKind !== serviceSpec.workloadKind && workloadKindObservable) {
        diff.push({ field: 'workloadKind', from: live.workloadKind, to: serviceSpec.workloadKind });
      }
      const noCode = live.status === 'empty';
      const sourceIssue = spec.deploy?.strategy === 'branch' && expectedSource
        ? diffDeploySource(expectedSource, live)
        : undefined;
      if (noCode || sourceIssue || diff.length > 0) {
        const reasons: string[] = [];
        if (noCode) {
          reasons.push(spec.deploy?.strategy === 'branch'
            ? `Service "${name}" has no image deployed yet — expected until the first CI deploy succeeds (push to the deploy branch or hv_ci_trigger)`
            : `Service "${name}" exists on ${provider} but has no code deployed (no source connected)`);
        }
        if (sourceIssue) {
          reasons.push(sourceIssue);
        }
        if (diff.length > 0) {
          reasons.push(`Configuration drift on ${diff.map((d) => d.field).join(', ')}`);
        }
        actions.push({
          id,
          type: 'update',
          resource,
          verified: !runtimeDrift,
          reason: reasons.join('; '),
          ...(diff.length > 0 ? { diff } : {}),
        });
      } else {
        actions.push({ id, type: 'noop', resource, verified: true, reason: 'In sync' });
      }
      continue;
    }

    // Local fallback (unverified). Unknown observation can preserve a proven
    // binding, but it cannot prove absence and therefore cannot authorize a
    // create.
    const known = localServices.has(name);
    const bound = Boolean(localServiceBindings[name]?.serviceId);
    const localRuntime = localServices.get(name)?.buildConfig.runtime;
    const runtimeDrift = Boolean(input.projectRuntime)
      && JSON.stringify(localRuntime) !== JSON.stringify(input.projectRuntime);
    if (known && bound) {
      actions.push({
        id,
        type: runtimeDrift ? 'update' : 'noop',
        resource,
        verified: false,
        reason: runtimeDrift
          ? `Project runtime changes from ${localRuntime ? `${localRuntime.kind}:${localRuntime.version}` : 'undeclared'} to ${input.projectRuntime!.kind}:${input.projectRuntime!.version}`
          : 'Bound in local state; provider does not support observation',
        ...(runtimeDrift
          ? {
            diff: [{
              field: 'runtime',
              from: localRuntime ? `${localRuntime.kind}:${localRuntime.version}` : 'undeclared',
              to: `${input.projectRuntime!.kind}:${input.projectRuntime!.version}`,
            }],
          }
          : {}),
      });
    } else {
      actions.push({
        id,
        type: observed && !serviceObservationKnown ? 'update' : 'create',
        resource,
        verified: false,
        reason: observed && !serviceObservationKnown
          ? `Cannot verify whether service "${name}" exists on ${provider}`
          : known
          ? `Service "${name}" has no provider binding in local state`
          : `Service "${name}" is not tracked locally`,
        dependsOn: projectDep,
        ...(observed && !serviceObservationKnown
          ? { metadata: { blockedReason: 'service_observation_unknown' } }
          : {}),
        ...(!observed || serviceObservationKnown
          ? providerBehavior.serviceCreatesBillable
            ? { billable: true, requiresConfirm: true }
            : {}
          : {}),
      });
    }
  }

  // Variable omission is preserve-only. Deletion is modeled separately from
  // service configuration so it is visible, confirm-gated, and can never be
  // inferred from a partial desired map.
  if (!providerChanged && (spec.removeEnvVars?.length ?? 0) > 0) {
    const retiredKeys = [...new Set(spec.removeEnvVars ?? [])].sort();
    for (const name of Object.keys(spec.services)) {
      const mainAction = actions.find((action) => action.id === `service:${name}`);
      const live = observedServices.get(name);
      const keys = observed
        ? retiredKeys.filter((key) => live?.envVarKeys.includes(key))
        : Boolean(localServiceBindings[name]?.serviceId)
          ? retiredKeys
          : [];
      if (keys.length === 0) continue;

      actions.push({
        id: `service:${name}:env-remove`,
        type: 'update',
        resource: { kind: 'service', name, provider },
        verified,
        reason: `Remove explicitly retired environment variables from "${name}". Confirm only after a previously deployed revision no longer depends on: ${keys.join(', ')}`,
        diff: keys.map((key) => ({ field: `env:${key}`, from: 'present', to: 'absent' })),
        requiresConfirm: true,
        ...(mainAction && mainAction.type !== 'noop' ? { dependsOn: [mainAction.id] } : {}),
        metadata: {
          operation: 'hostingEnvRemove',
          keys,
        },
      });
    }
  }

  const serviceDestroyAction = (
    name: string,
    verifiedDestroy: boolean,
    reason: string,
    metadata?: Record<string, unknown>,
    requiresConfirm = true
  ): PlanAction => ({
    id: `service:${name}:destroy`,
    type: 'destroy',
    resource: { kind: 'service', name, provider },
    verified: verifiedDestroy,
    reason,
    ...(requiresConfirm ? { requiresConfirm: true } : {}),
    ...(metadata ? { metadata } : {}),
  });

  // Services absent from the spec: destroy previously managed bindings, but
  // only report truly unknown live resources as unmanaged.
  const plannedServiceDestroys = new Set<string>();
  for (const live of serviceObservationKnown ? observed?.services ?? [] : []) {
    if (spec.services[live.name]) continue;
    const bound = Boolean(localServiceBindings[live.name]?.serviceId);
    if (live.name.startsWith('hv-task-')) {
      actions.push(serviceDestroyAction(
        live.name,
        true,
        'Leftover Hypervibe one-off task service',
        { operation: 'taskServiceCleanup', externalId: live.externalId },
        false
      ));
      plannedServiceDestroys.add(live.name);
    } else if (bound) {
      actions.push(serviceDestroyAction(
        live.name,
        true,
        `Service "${live.name}" was removed from the spec and is managed by Hypervibe`
      ));
      plannedServiceDestroys.add(live.name);
    } else {
      unmanaged.push({ kind: 'service', name: live.name, detail: `Running on ${provider} but absent from spec` });
    }
  }

  if (!observed) {
    for (const [name, binding] of Object.entries(localServiceBindings)) {
      if (spec.services[name] || plannedServiceDestroys.has(name) || !binding?.serviceId) continue;
      actions.push(serviceDestroyAction(
        name,
        false,
        `Service "${name}" was removed from the spec and has a local ${provider} binding`
      ));
      plannedServiceDestroys.add(name);
    }
  }

  // ---- abandoned hosting provider teardown ----------------------------------
  // A provider switch stashes the old provider's bindings as previousHosting;
  // offer confirm-gated deletion of each service still running there.
  const previousHosting = local.bindings?.previousHosting;
  if (previousHosting?.provider && previousHosting.provider !== provider) {
    const previousServices = Object.entries(previousHosting.services ?? {});
    if (previousServices.length > 0) {
      warnings.push(
        `${previousServices.length} service(s) are still running on ${previousHosting.provider} from before the switch to ${provider} — they keep billing until destroyed. Confirm the previous-provider destroy actions when the ${provider} deployment is verified.`
      );
      for (const [name, binding] of previousServices) {
        const serviceId = binding?.serviceId ?? binding?.jobName;
        actions.push({
          id: `service:${name}:previous-destroy`,
          type: 'destroy',
          resource: { kind: 'service', name, provider: previousHosting.provider },
          verified: false,
          reason: `Service "${name}" is still running on ${previousHosting.provider} (abandoned by the switch to ${provider}). Confirm to delete it there.`,
          requiresConfirm: true,
          metadata: {
            operation: 'previousHostingDestroy',
            previousProvider: previousHosting.provider,
            ...(serviceId ? { serviceId } : {}),
          },
        });
      }
    }
  }

  // ---- database -------------------------------------------------------------
  const desiredDatabaseEngine = spec.database?.engine;
  const localDb = local.components.find((component) => (
    desiredDatabaseEngine
      ? component.type === desiredDatabaseEngine
      : component.type === 'postgres'
  ));
  const localDbBindings = localDb?.bindings as Record<string, unknown> | undefined;
  const localDbProvider = localDb
    ? String(localDbBindings?.provider ?? '') || undefined
    : undefined;
  const previousDbProvider = localDb
    ? String(localDbBindings?.previousProvider ?? '') || undefined
    : undefined;
  const observedDatabases = databaseObservationKnown
    ? (observed?.databases ?? []).filter((database) => (
      desiredDatabaseEngine
        ? database.engine === desiredDatabaseEngine
        : database.engine === 'postgres'
    ))
    : [];
  const observedDb = observedDatabases.length === 1 ? observedDatabases[0] : undefined;
  const databaseAmbiguous = observedDatabases.length > 1;
  const currentDbProvider = observed && databaseObservationKnown ? observedDb?.provider : localDbProvider;
  const dbVerified = Boolean(observed && databaseObservationKnown);
  let activeDatabaseActionId: string | undefined;

  if (spec.database) {
    const wanted = spec.database.provider;
    const databaseEngineLabel = 'PostgreSQL';
    const createId = `database:${wanted}`;
    activeDatabaseActionId = createId;
    if (databaseAmbiguous) {
      const candidateIds = observedDatabases.map((database) => database.externalId).sort();
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: true,
        reason: `Multiple ${databaseEngineLabel} datastores were observed; Hypervibe cannot safely select one`,
        metadata: {
          blockedReason: 'ambiguous_database_identity',
          externalIds: candidateIds,
        },
      });
      warnings.push(`Multiple ${databaseEngineLabel} datastores were observed (${candidateIds.join(', ')}). Database mutations are blocked until one identity is explicitly adopted.`);
      for (const database of observedDatabases) {
        if (database.externalId === localDb?.externalId) continue;
        unmanaged.push({
          kind: 'database',
          name: database.name ?? database.engine,
          detail: `${database.provider} datastore ${database.externalId} is an additional ${databaseEngineLabel} candidate`,
        });
      }
    } else if (observed && !databaseObservationKnown) {
      if (localDbProvider === wanted) {
        actions.push({
          id: createId,
          type: 'noop',
          resource: { kind: 'database', name: spec.database.engine, provider: wanted },
          verified: false,
          reason: 'Preserving the locally bound database because live database observation is unknown',
        });
      } else {
        actions.push({
          id: createId,
          type: 'update',
          resource: { kind: 'database', name: spec.database.engine, provider: wanted },
          verified: false,
          reason: `Cannot verify whether the desired ${wanted} database exists`,
          metadata: { blockedReason: 'database_observation_unknown' },
        });
      }
    } else if (!currentDbProvider) {
      actions.push({
        id: createId,
        type: 'create',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified,
        reason: `No ${spec.database.engine} database exists`,
        billable: true,
        dependsOn: wanted === provider ? projectDep : undefined,
      });
    } else if (currentDbProvider !== wanted) {
      warnings.push(
        `Database provider change from ${currentDbProvider} to ${wanted} is staged: this plan creates the new database only. Hypervibe does not migrate data automatically and will not delete the old database in this plan.`
      );
      actions.push({
        id: createId,
        type: 'create',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: dbVerified,
        reason: `Database provider changes from ${currentDbProvider} to ${wanted}. Create the new database first; services and old database deletion are planned after the new database is recorded locally.`,
        billable: true,
        dependsOn: wanted === provider ? projectDep : undefined,
      });
    } else if (observedDb && !localDb) {
      actions.push({
        id: createId,
        type: 'update',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: true,
        reason: `A live ${wanted} ${spec.database.engine} datastore exists but is not adopted into Hypervibe state`,
        metadata: {
          blockedReason: 'database_adoption_required',
          externalId: observedDb.externalId,
          observedName: observedDb.name,
        },
      });
      unmanaged.push({
        kind: 'database',
        name: observedDb.name ?? observedDb.engine,
        detail: `${observedDb.provider} datastore ${observedDb.externalId} requires explicit hv_import adoption`,
      });
    } else {
      actions.push({
        id: createId,
        type: 'noop',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: dbVerified,
        reason: 'Database in sync',
      });
      if (previousDbProvider && previousDbProvider !== wanted) {
        warnings.push(
          `Database cutover from ${previousDbProvider} to ${wanted} is pending: restore data into ${wanted}, apply the service env updates, verify health, then confirm the old ${previousDbProvider} destroy.`
        );
        actions.push({
          id: `database:${previousDbProvider}:destroy`,
          type: 'destroy',
          resource: { kind: 'database', name: spec.database.engine, provider: previousDbProvider },
          verified: dbVerified,
          reason: `Previous ${previousDbProvider} database is no longer active. Data is NOT migrated automatically — confirm only after cutover is verified.`,
          dataBearing: true,
          requiresConfirm: true,
        });
      }
    }

    if (spec.database.seedCommand) {
      const commandHash = seedCommandHash(spec.database.seedCommand);
      const seedRecord = localDbBindings?.seed && typeof localDbBindings.seed === 'object' && !Array.isArray(localDbBindings.seed)
        ? localDbBindings.seed as Record<string, unknown>
        : {};
      const seeded = currentDbProvider === wanted
        && seedRecord.commandHash === commandHash
        && typeof seedRecord.seededAt === 'string';
      const serviceDeps = actions
        .filter((action) => action.resource.kind === 'service' && !action.id.includes(':destroy'))
        .map((action) => action.id);
      actions.push({
        id: `database:${wanted}:seed`,
        type: seeded ? 'noop' : 'update',
        resource: { kind: 'database', name: 'seed', provider: wanted },
        verified: dbVerified,
        reason: seeded
          ? 'Database seed command has already completed for this database'
          : currentDbProvider && currentDbProvider !== wanted
            ? `Seed command will run after the new ${wanted} database is created`
            : 'Database seed command has not completed for this database',
        dependsOn: [createId, ...serviceDeps],
        metadata: {
          operation: 'databaseSeed',
          engine: spec.database.engine,
          command: spec.database.seedCommand,
          commandHash,
          mode: 'once',
        },
      });
    }
  } else if (observed && !databaseObservationKnown && localDb) {
    actions.push({
      id: `database:${localDbProvider ?? 'postgres'}:observation-blocked`,
      type: 'update',
      resource: { kind: 'database', name: localDb.type, provider: localDbProvider ?? 'unknown' },
      verified: false,
      reason: 'Database was removed from the spec, but live observation is unknown; refusing to destroy it',
      metadata: { blockedReason: 'database_observation_unknown' },
    });
  } else if (localDb && currentDbProvider) {
    // Spec no longer declares a database but we manage one: confirm-gated destroy.
    actions.push({
      id: `database:${currentDbProvider}:destroy`,
      type: 'destroy',
      resource: { kind: 'database', name: localDb.type, provider: currentDbProvider },
      verified: dbVerified,
      reason: 'Database removed from spec. Data will be lost — confirm to destroy.',
      dataBearing: true,
      requiresConfirm: true,
      dependsOn: actions
        .filter((action) => action.resource.kind === 'service' && action.type === 'destroy')
        .map((action) => action.id),
    });
  } else if (observedDb && !localDb) {
    unmanaged.push({
      kind: 'database',
      name: observedDb.engine,
      detail: `${observedDb.provider} database exists but is not managed by the spec`,
    });
  }

  const activeDatabaseAction = activeDatabaseActionId
    ? actions.find((action) => action.id === activeDatabaseActionId)
    : undefined;
  if (activeDatabaseAction && activeDatabaseAction.type !== 'noop' && !currentDbProvider) {
    for (const serviceAction of actions.filter((action) =>
      action.resource.kind === 'service'
      && action.type !== 'destroy'
      && !action.id.includes(':env-remove')
    )) {
      if (serviceAction.type === 'noop') {
        serviceAction.type = 'update';
        serviceAction.reason = `${serviceAction.reason}; wire the newly created ${activeDatabaseAction.resource.provider} database`;
      }
      serviceAction.dependsOn = Array.from(new Set([
        ...(serviceAction.dependsOn ?? []),
        activeDatabaseAction.id,
      ]));
    }
  }

  if (spec.database) {
    const canonicalKey = 'DATABASE_URL';
    for (const serviceAction of actions.filter((action) =>
      action.resource.kind === 'service'
      && (action.type === 'create' || action.type === 'replace')
    )) {
      const serviceSpec = spec.services[serviceAction.resource.name];
      if (!serviceSpec || Object.keys(serviceSpec.databaseEnvAliases ?? {}).length > 0) continue;
      warnings.push(
        `New service "${serviceAction.resource.name}" will receive the managed database contract through ${canonicalKey}. `
        + `Hypervibe can verify variable attachment but cannot prove application code consumes it; declare service.databaseEnvAliases for legacy runtime names.`
      );
    }
  }

  // ---- domain ---------------------------------------------------------------
  if (spec.domain && !spec.loadBalancer) {
    const id = `domain:${spec.domain}`;
    const attachedService = observed
      ? observed.services.find((s) => s.customDomains.includes(spec.domain!))
      : undefined;
    const attached = observed
      ? Boolean(attachedService)
      : Object.values(localServiceBindings).some((b) => b.customDomains?.includes(spec.domain!));
    const domainStatus = attachedService?.customDomainStatus?.[spec.domain];
    const dnsConfigured = domainStatus?.dnsConfigured;
    const requiresProviderVerification = providerRequiresCustomDomainAttach(provider);
    const configured = attached
      && (dnsConfigured === true || (!requiresProviderVerification && dnsConfigured !== false));
    actions.push({
      id,
      type: configured ? 'noop' : 'update',
      resource: { kind: 'domain', name: spec.domain, provider },
      verified,
      reason: attached
        ? dnsConfigured === false
          ? `Domain ${spec.domain} is attached on ${provider}, but required DNS records are not configured`
          : dnsConfigured === undefined && requiresProviderVerification
            ? `Domain ${spec.domain} is attached on ${provider}, but provider verification status was not observed`
            : 'Domain attached'
        : `Domain ${spec.domain} is not attached to any service`,
      dependsOn: configured ? undefined : projectDep,
      ...(domainStatus?.dnsRecords ? { metadata: { dnsRecords: domainStatus.dnsRecords } } : {}),
    });
  }

  return { actions, unmanaged, warnings };
}

function seedCommandHash(command: string): string {
  return createHash('sha256').update(command.trim(), 'utf8').digest('hex');
}

/** Strip URL prefixes/.git and lowercase so "owner/repo" forms compare equal. */
function normalizeRepo(repo?: string): string | undefined {
  if (!repo) return undefined;
  return repo
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase() || undefined;
}

/** Returns a human-readable drift reason when the live deploy source diverges from the spec. */
function diffDeploySource(
  expected: { repo: string; branch: string },
  live: ObservedService
): string | undefined {
  const liveRepo = normalizeRepo(live.source?.repo);
  const wantedRepo = normalizeRepo(expected.repo);
  if (!liveRepo) {
    return `Deploy source is not connected (expected ${expected.repo}@${expected.branch}); pushes will not deploy`;
  }
  if (wantedRepo && liveRepo !== wantedRepo) {
    return `Deploy source repo is ${live.source?.repo}, expected ${expected.repo}`;
  }
  if (!live.source?.branch) {
    return `Deploy source branch is not recorded (expected ${expected.branch}); reconnect the deploy source`;
  }
  if (live.source?.branch && live.source.branch !== expected.branch) {
    return `Deploy source branch is ${live.source.branch}, expected ${expected.branch}`;
  }
  return undefined;
}

function diffServiceConfig(
  spec: ServiceSpec,
  live: ObservedService,
  envVars: Record<string, string>,
  options: { presenceOnlyEnvVars?: Set<string> } = {}
): PlanFieldDiff[] {
  const diff: PlanFieldDiff[] = [];

  // Only fields the spec sets are managed; unset spec fields are ignored.
  const fields: Array<[keyof ServiceSpec & keyof ObservedService['config'], string]> = [
    ['startCommand', 'startCommand'],
    ['releaseCommand', 'releaseCommand'],
    ['healthCheckPath', 'healthCheckPath'],
    ['cronSchedule', 'cronSchedule'],
    ['public', 'public'],
  ];
  for (const [key, field] of fields) {
    const wanted = spec[key];
    if (wanted === undefined) continue;
    const actual = live.config[key];
    if (actual !== wanted) {
      diff.push({ field, from: actual === undefined ? undefined : String(actual), to: String(wanted) });
    }
  }

  for (const [key, value] of Object.entries(envVars)) {
    const liveHash = live.envVarHashes[key];
    if (liveHash === undefined) {
      diff.push({ field: `env:${key}` });
    } else if (options.presenceOnlyEnvVars?.has(key)) {
      continue;
    } else if (liveHash !== hashEnvValue(value)) {
      diff.push({ field: `env:${key}` });
    }
  }

  return diff;
}

/** Re-exported for hv_apply's confirm flow and tests. */
export function confirmGatedActionIds(actions: PlanAction[]): string[] {
  return actions.filter((a) => a.requiresConfirm).map((a) => a.id);
}
