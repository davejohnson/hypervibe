import type { EnvironmentSpec, ServiceSpec } from '../spec/spec.schema.js';
import type { ObservedState, ObservedService } from '../ports/observe.port.js';
import { hashEnvValue } from '../ports/observe.port.js';
import type { PlanAction, PlanFieldDiff, DiffResult, LocalSnapshot } from './plan.types.js';

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
 * - Live resources absent from the spec are reported as unmanaged, never destroyed —
 *   except databases tracked by a local component, which get a confirm-gated destroy.
 * - Email/SendGrid is not part of the diff (not observable here); hv_plan
 *   appends provider-precondition items separately.
 */
export function diffEnvironment(input: {
  spec: EnvironmentSpec;
  envName: string;
  observed: ObservedState | null;
  local: LocalSnapshot;
}): DiffResult {
  const { spec, envName, observed, local } = input;
  const verified = observed !== null;
  const actions: PlanAction[] = [];
  const unmanaged: DiffResult['unmanaged'] = [];
  const warnings: string[] = [...(observed?.warnings ?? [])];
  const provider = spec.hosting.provider;

  if (observed?.partial) {
    warnings.push('Observation was partial; some diffs may be incomplete.');
  }

  // Railway delivers code only through repo-linked deploys (serviceConnect).
  // Without strategy "branch", apply creates source-less services that never run code.
  if (provider === 'railway' && Object.keys(spec.services).length > 0 && spec.deploy?.strategy !== 'branch') {
    warnings.push(
      `deploy.strategy is "${spec.deploy?.strategy ?? 'unset'}": Railway only deploys code via repo-linked deploys, `
      + 'so apply will create services without a source and NO CODE WILL BE DEPLOYED. '
      + 'Set deploy: { strategy: "branch" } in the spec (hv_spec_set) unless infrastructure-only is intended.'
    );
  }

  // ---- project / environment ------------------------------------------------
  const boundProvider = local.bindings?.provider;
  const providerChanged = Boolean(boundProvider && boundProvider !== provider);

  const projectExists = observed ? observed.projectExists : Boolean(local.bindings?.projectId);
  const projectActionId = `project:${provider}`;
  if (!projectExists || providerChanged) {
    actions.push({
      id: projectActionId,
      type: 'create',
      resource: { kind: 'project', name: envName, provider },
      verified,
      reason: providerChanged
        ? `Hosting provider changes from ${boundProvider} to ${provider}`
        : `No ${provider} project exists for this environment`,
    });
  }
  const projectDep = actions.some((a) => a.id === projectActionId) ? [projectActionId] : undefined;

  // ---- services -------------------------------------------------------------
  const observedServices = new Map<string, ObservedService>(
    (observed?.services ?? []).map((s) => [s.name, s])
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
      });
      continue;
    }

    if (observed) {
      const live = observedServices.get(name);
      if (!live) {
        actions.push({
          id,
          type: 'create',
          resource,
          verified: true,
          reason: `Service "${name}" is not deployed on ${provider}`,
          dependsOn: projectDep,
        });
        continue;
      }

      if (live.workloadKind !== serviceSpec.workloadKind) {
        actions.push({
          id,
          type: 'replace',
          resource,
          verified: true,
          reason: `Workload kind changes from ${live.workloadKind} to ${serviceSpec.workloadKind}`,
          diff: [{ field: 'workloadKind', from: live.workloadKind, to: serviceSpec.workloadKind }],
          dependsOn: projectDep,
        });
        continue;
      }

      const diff = diffServiceConfig(serviceSpec, live, spec.envVars);
      const noCode = live.status === 'empty';
      if (noCode || diff.length > 0) {
        const reasons: string[] = [];
        if (noCode) {
          reasons.push(`Service "${name}" exists on ${provider} but has no code deployed (no source connected)`);
        }
        if (diff.length > 0) {
          reasons.push(`Configuration drift on ${diff.map((d) => d.field).join(', ')}`);
        }
        actions.push({
          id,
          type: 'update',
          resource,
          verified: true,
          reason: reasons.join('; '),
          ...(diff.length > 0 ? { diff } : {}),
        });
      } else {
        actions.push({ id, type: 'noop', resource, verified: true, reason: 'In sync' });
      }
      continue;
    }

    // Local fallback (unverified)
    const known = localServices.has(name);
    const bound = Boolean(localServiceBindings[name]?.serviceId);
    if (known && bound) {
      actions.push({
        id,
        type: 'noop',
        resource,
        verified: false,
        reason: 'Bound in local state; provider does not support observation',
      });
    } else {
      actions.push({
        id,
        type: 'create',
        resource,
        verified: false,
        reason: known
          ? `Service "${name}" has no provider binding in local state`
          : `Service "${name}" is not tracked locally`,
        dependsOn: projectDep,
      });
    }
  }

  // Live services not in the spec: report, never destroy.
  for (const live of observed?.services ?? []) {
    if (!spec.services[live.name]) {
      unmanaged.push({ kind: 'service', name: live.name, detail: `Running on ${provider} but absent from spec` });
    }
  }

  // ---- database -------------------------------------------------------------
  const localDb = local.components.find((c) => c.type === 'postgres');
  const localDbProvider = localDb
    ? String((localDb.bindings as Record<string, unknown>)?.provider ?? '') || undefined
    : undefined;
  const observedDb = observed?.databases.find((d) => d.engine === 'postgres');
  const currentDbProvider = observedDb?.provider ?? localDbProvider;
  const dbVerified = observed ? Boolean(observedDb) || !localDb : false;

  if (spec.database) {
    const wanted = spec.database.provider;
    const createId = `database:${wanted}`;
    if (!currentDbProvider) {
      actions.push({
        id: createId,
        type: 'create',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified,
        reason: `No ${spec.database.engine} database exists`,
        dependsOn: wanted === provider ? projectDep : undefined,
      });
    } else if (currentDbProvider !== wanted) {
      actions.push({
        id: createId,
        type: 'create',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: dbVerified,
        reason: `Database provider changes from ${currentDbProvider} to ${wanted}`,
        dependsOn: wanted === provider ? projectDep : undefined,
      });
      actions.push({
        id: `database:${currentDbProvider}:destroy`,
        type: 'destroy',
        resource: { kind: 'database', name: spec.database.engine, provider: currentDbProvider },
        verified: dbVerified,
        reason: `Old ${currentDbProvider} database is replaced by ${wanted}. Data is NOT migrated automatically — migrate first, then confirm.`,
        dataBearing: true,
        requiresConfirm: true,
        dependsOn: [createId],
      });
    } else {
      actions.push({
        id: createId,
        type: 'noop',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: dbVerified,
        reason: 'Database in sync',
      });
    }
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
    });
  } else if (observedDb && !localDb) {
    unmanaged.push({
      kind: 'database',
      name: observedDb.engine,
      detail: `${observedDb.provider} database exists but is not managed by the spec`,
    });
  }

  // ---- domain ---------------------------------------------------------------
  if (spec.domain) {
    const id = `domain:${spec.domain}`;
    const attached = observed
      ? observed.services.some((s) => s.customDomains.includes(spec.domain!))
      : Object.values(localServiceBindings).some((b) => b.customDomains?.includes(spec.domain!));
    actions.push({
      id,
      type: attached ? 'noop' : 'update',
      resource: { kind: 'domain', name: spec.domain, provider },
      verified,
      reason: attached ? 'Domain attached' : `Domain ${spec.domain} is not attached to any service`,
      dependsOn: attached ? undefined : projectDep,
    });
  }

  return { actions, unmanaged, warnings };
}

function diffServiceConfig(
  spec: ServiceSpec,
  live: ObservedService,
  envVars: Record<string, string>
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
