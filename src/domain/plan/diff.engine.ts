import type { EnvironmentSpec, ServiceSpec } from '../spec/spec.schema.js';
import { migrationReleaseCommandWarning, withMigrationReleaseCommand } from '../spec/spec-bootstrap.js';
import type { ObservedState, ObservedService } from '../ports/observe.port.js';
import { hashEnvValue } from '../ports/observe.port.js';
import type { PlanAction, PlanFieldDiff, DiffResult, LocalSnapshot } from './plan.types.js';
import { providerRequiresCustomDomainAttach } from '../services/domain-attach-policy.js';

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
  /** Repo/branch services should be linked to when spec.deploy.strategy is "branch". */
  expectedSource?: { repo: string; branch: string };
  /** Managed database env vars derived from the currently desired database component. */
  managedDatabaseEnvVars?: Record<string, string>;
  managedQueueEnvVars?: Record<string, string>;
}): DiffResult {
  const { envName, observed, local, expectedSource, managedDatabaseEnvVars, managedQueueEnvVars } = input;
  const spec = withMigrationReleaseCommand(input.spec);
  const verified = observed !== null;
  const actions: PlanAction[] = [];
  const unmanaged: DiffResult['unmanaged'] = [];
  const warnings: string[] = [...(observed?.warnings ?? [])];
  const migrationWarning = migrationReleaseCommandWarning(input.spec);
  if (migrationWarning) {
    warnings.push(migrationWarning);
  }
  const provider = spec.hosting.provider;
  const desiredEnvVars = {
    ...(managedDatabaseEnvVars ?? {}),
    ...(managedQueueEnvVars ?? {}),
    ...spec.envVars,
  };

  if (observed?.partial) {
    warnings.push('Observation was partial; some diffs may be incomplete.');
  }

  // Without a branch deploy strategy, apply creates source-less services that
  // only receive code later if the user runs an out-of-band deploy.
  if (provider === 'railway' && Object.keys(spec.services).length > 0 && spec.deploy?.strategy !== 'branch') {
    warnings.push(
      `deploy.strategy is "${spec.deploy?.strategy ?? 'unset'}": Railway apply will create services without a source, `
      + 'so NO CODE WILL BE DEPLOYED. '
      + 'Set deploy: { strategy: "branch", trigger: "ci" } so hv_plan/hv_apply can manage the GitHub Actions deploy workflow unless infrastructure-only is intended.'
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

      // Only cron-ness is structural (Cloud Run Job vs Service are different
      // resources); web<->worker converges via redeploy (ingress/scaling).
      if ((live.workloadKind === 'cron') !== (serviceSpec.workloadKind === 'cron')) {
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

      const diff = diffServiceConfig(serviceSpec, live, desiredEnvVars);
      // Railway observe cannot distinguish web from worker, so a kind field
      // diff there would never converge; skip it (documented observe gap).
      if (live.workloadKind !== serviceSpec.workloadKind && provider !== 'railway') {
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

  const serviceDestroyAction = (name: string, verifiedDestroy: boolean, reason: string): PlanAction => ({
    id: `service:${name}:destroy`,
    type: 'destroy',
    resource: { kind: 'service', name, provider },
    verified: verifiedDestroy,
    reason,
  });

  // Services absent from the spec: destroy previously managed bindings, but
  // only report truly unknown live resources as unmanaged.
  const plannedServiceDestroys = new Set<string>();
  for (const live of observed?.services ?? []) {
    if (spec.services[live.name]) continue;
    const bound = Boolean(localServiceBindings[live.name]?.serviceId);
    if (bound) {
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
  const localDb = local.components.find((c) => c.type === 'postgres');
  const localDbProvider = localDb
    ? String((localDb.bindings as Record<string, unknown>)?.provider ?? '') || undefined
    : undefined;
  const previousDbProvider = localDb
    ? String((localDb.bindings as Record<string, unknown>)?.previousProvider ?? '') || undefined
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
      warnings.push(
        `Database provider change from ${currentDbProvider} to ${wanted} is staged: this plan creates the new database only. Hypervibe does not migrate data automatically and will not delete the old database in this plan.`
      );
      actions.push({
        id: createId,
        type: 'create',
        resource: { kind: 'database', name: spec.database.engine, provider: wanted },
        verified: dbVerified,
        reason: `Database provider changes from ${currentDbProvider} to ${wanted}. Create the new database first; services and old database deletion are planned after the new database is recorded locally.`,
        dependsOn: wanted === provider ? projectDep : undefined,
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
