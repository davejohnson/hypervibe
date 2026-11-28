import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';
import { strictHealthCheck } from '../domain/services/release-health.js';
import { releaseCommandFor } from './infrastructure-engine.js';

/**
 * The release command step of a generated workflow. A declared command that cannot be
 * run (its job is not built yet) blocks generation: a workflow that silently skipped
 * migrations would release code against an unmigrated database.
 */
export function ciReleaseCommand(environmentSpec: EnvironmentSpec, releaseJob: string | undefined, services: Array<{ name: string; kind: 'services' | 'jobs' | 'workerPools' }>): { job: string; service: string } | { blocked: string } | undefined {
  if (!releaseCommandFor(environmentSpec)) return undefined;
  // Same choice as the engine: the release command runs on the web service's image, or the first non-job service.
  const migrationService = services.find((service) => environmentSpec.services[service.name]?.workloadKind === 'web') ?? services.find((service) => service.kind !== 'jobs');
  if (!releaseJob || !migrationService) {
    return { blocked: 'The release-command job does not exist yet, so the release workflow was not written: it would skip the release command. Run hv_plan scope="infrastructure" and hv_apply first.' };
  }
  return { job: releaseJob, service: migrationService.name };
}

/** What the release workflow updates: every bound service, scheduled job and worker pool. */
export function ciReleaseTargets(environmentSpec: EnvironmentSpec, bindings: Record<string, { serviceId?: string; jobName?: string; workerPoolName?: string }> | undefined,
  target: { region: string; gcpProjectId: string; environmentName: string }) {
  return Object.entries(environmentSpec.services).flatMap(([name, service]) => {
    const bound = bindings?.[name];
    const resource = bound?.serviceId ?? bound?.jobName ?? bound?.workerPoolName;
    const kind = bound?.serviceId ? 'services' as const : bound?.jobName ? 'jobs' as const : 'workerPools' as const;
    return resource ? [{
      name, resource, kind, ...(kind === 'services' && service.workloadKind !== 'worker' ? { healthPath: service.healthCheckPath ?? '/', ...(strictHealthCheck(service) ? { strictHealth: true } : {}) } : {}),
      ...(kind !== 'jobs' && service.startCommand ? { startCommand: service.startCommand } : {}),
      image: `${target.region}-docker.pkg.dev/${target.gcpProjectId}/hypervibe/${target.environmentName}-${name}`.toLowerCase(),
    }] : [];
  });
}
