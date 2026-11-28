import type { Environment } from '../entities/environment.entity.js';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { handoffReviewSchema } from '../plan/domain-handoff.js';
import { parseEnvironmentMaintenanceBinding } from './environment-maintenance.service.js';
import { parseHostingBindings } from '../ports/hosting.port.js';

export function domainHandoffBlocker(spec: ProjectSpec, name: string, environment: Environment | null, teardown = false): string | undefined {
  const desired = spec.environments[name];
  const bindings = environment?.platformBindings;
  if (bindings?.edgeDomain) {
    const owned = handoffReviewSchema.safeParse(bindings.edgeDomain);
    if (!owned.success || owned.data.targetId !== environment?.id || owned.data.projectId !== environment.projectId
      || desired?.edgeDomain?.hostname !== owned.data.hostname || desired.edgeDomain.service !== owned.data.targetService
      || desired.edgeDomain.fromEnvironment !== owned.data.sourceEnvironment || teardown) {
      return 'This environment owns a live Cloudflare hostname. Keep its exact target and DNS ownership while it serves traffic. Moving or removing that permanent edge is a separate operation.';
    }
  } else if (desired?.edgeDomain || bindings?.domainHandoffIncoming) {
    return 'Finish the reviewed hostname transfer with hv_plan scope="domain-handoff" on this target before reconciling its other infrastructure.';
  }
  if (bindings?.edgeDomainReleased) {
    if (desired?.domain === (bindings.edgeDomainReleased as { hostname?: string }).hostname || desired?.domainTarget || desired?.maintenance?.enabled) {
      return 'The target now owns this hostname. Remove the old source domain, DNS, domainTarget and application maintenance intent before planning source retirement.';
    }
  } else if (bindings?.domainHandoff || bindings?.domainHandoffRoute || Object.values(spec.environments).some(candidate => candidate.edgeDomain?.fromEnvironment === name)) {
    return 'A hostname transfer is in progress. Keep the source paused and run hv_plan scope="domain-handoff" on the target before changing or retiring either environment.';
  }
}

/** hv_destroy deletes local records for the whole project, one environment, or one logical service across environments. */
export function domainHandoffDeletionOwners(environments: Environment[], spec: ProjectSpec | undefined, selected: { environment?: string; service?: string }): string[] {
  const owners = new Set<string>();
  const add = (name: string, service?: string) => {
    if ((!selected.environment || selected.environment === name) && (!selected.service || !service || selected.service === service)) owners.add(name);
  };
  for (const environment of environments) {
    const bindings = environment.platformBindings;
    if (bindings.edgeDomainReleased) continue;
    for (const [saved, target] of [[bindings.edgeDomain, true], [bindings.domainHandoffIncoming, true],
      [bindings.domainHandoffRoute, false], [bindings.domainHandoff, false]] as const) {
      if (saved === undefined) continue;
      const review = handoffReviewSchema.safeParse(saved);
      add(environment.name, review.success ? (target ? review.data.targetService : review.data.sourceService) : undefined);
    }
    const maintenance = parseEnvironmentMaintenanceBinding(environment);
    if (maintenance?.edge?.origin || maintenance?.pendingEdge?.origin) {
      add(environment.name, parseHostingBindings(environment).domainDns?.serviceName);
      const target = spec?.environments[environment.name]?.domainTarget;
      if (target && environments.some(other => other.name === target.environment)) add(target.environment, target.service);
    }
  }
  return [...owners].sort();
}
