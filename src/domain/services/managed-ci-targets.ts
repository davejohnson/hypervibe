import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../entities/project.entity.js';
import type {
  BranchDeployEnvironmentKind,
  BranchDeployTarget,
} from '../ports/ci-deploy.port.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function classifyManagedCiEnvironment(name: string): BranchDeployEnvironmentKind | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized === 'local') return null;
  if (normalized === 'production' || normalized === 'prod' || normalized.includes('prod')) return 'production';
  if (normalized === 'staging' || normalized === 'stage' || normalized.includes('stag')) return 'staging';
  if (normalized === 'development' || normalized === 'dev' || normalized.includes('develop')) return 'development';
  if (normalized === 'test' || normalized.includes('test')) return 'test';
  return 'custom';
}

export function managedCiEnvironmentBindings(
  projectId: string,
  environmentName: string,
  desiredServiceNames?: Set<string>
): {
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerServiceIds: string[];
  providerImageUris: string[];
  providerJobNames: string[];
  boundServiceNames: string[];
} {
  const environment = new EnvironmentRepository().findByProjectAndName(projectId, environmentName);
  const bindings = asRecord(environment?.platformBindings);
  const services = asRecord(bindings?.services);
  const boundServiceNames = Object.keys(services ?? {});
  const providerServiceIds: string[] = [];
  const providerImageUris: string[] = [];
  const providerJobNames: string[] = [];
  for (const [serviceName, service] of Object.entries(services ?? {})) {
    if (desiredServiceNames && !desiredServiceNames.has(serviceName)) continue;
    const record = asRecord(service);
    const serviceId = typeof record?.serviceId === 'string' && record.serviceId.trim().length > 0
      ? record.serviceId.trim()
      : undefined;
    const jobName = typeof record?.jobName === 'string' && record.jobName.trim().length > 0
      ? record.jobName.trim()
      : undefined;
    const imageUri = typeof record?.imageUri === 'string' && record.imageUri.trim().length > 0
      ? record.imageUri.trim()
      : undefined;
    if (imageUri) providerImageUris.push(imageUri);
    const isScheduledJob = record?.resourceType === 'scheduledJob' || Boolean(jobName);
    if (isScheduledJob) {
      const target = jobName ?? serviceId;
      if (target) providerJobNames.push(target);
    } else if (serviceId) {
      providerServiceIds.push(serviceId);
    }
  }
  return {
    providerProjectId: typeof bindings?.projectId === 'string' ? bindings.projectId : undefined,
    providerEnvironmentId: typeof bindings?.environmentId === 'string' ? bindings.environmentId : undefined,
    providerServiceIds,
    providerImageUris,
    providerJobNames,
    boundServiceNames,
  };
}

export function resolveReviewedBranchDeployTargets(project: Project, spec: ProjectSpec): {
  targets: BranchDeployTarget[];
  desiredBranches: Record<string, string | undefined>;
  migration: { includeStep: boolean; command?: string; note?: string };
  skippedEnvironments: string[];
} {
  const targetsByEnvironment = new Map<string, BranchDeployTarget>();
  const skippedEnvironments: string[] = [];
  const desiredBranches: Record<string, string | undefined> = {};
  let migration: { includeStep: boolean; command?: string; note?: string } = { includeStep: false };
  const runtime = spec.runtime;

  for (const [environmentName, environment] of Object.entries(spec.environments)) {
    const kind = classifyManagedCiEnvironment(environmentName);
    if (!kind || environment.deploy?.strategy !== 'branch' || environment.deploy.trigger === 'native') {
      skippedEnvironments.push(environmentName);
      continue;
    }
    const branch = environment.deploy.branch ?? 'main';
    const autoDeployOnPush = environment.deploy.autoDeploy ?? kind !== 'production';
    desiredBranches[environmentName] = branch;
    const serviceNames = Object.keys(environment.services);
    const bindings = managedCiEnvironmentBindings(project.id, environmentName, new Set(serviceNames));
    const runtimeServiceNames = Object.entries(environment.services)
      .filter(([, service]) => service.workloadKind !== 'cron')
      .map(([name]) => name);
    const jobServiceNames = Object.entries(environment.services)
      .filter(([, service]) => service.workloadKind === 'cron')
      .map(([name]) => name);
    const runtimeServices = Object.values(environment.services)
      .filter((service) => service.workloadKind !== 'cron');
    const explicitContainerCommands = runtimeServices
      .map((service) => service.startCommand?.trim())
      .filter((command): command is string => Boolean(command));
    const containerCommands = [...new Set(explicitContainerCommands)];
    const containerStartCommand = runtimeServices.length > 0
      && explicitContainerCommands.length === runtimeServices.length
      && containerCommands.length === 1
      ? containerCommands[0]
      : undefined;
    targetsByEnvironment.set(environmentName, {
      environmentName,
      kind,
      branch,
      autoDeployOnPush,
      ...(kind === 'production' && !autoDeployOnPush
        ? { promoteFromEnvironment: environment.deploy.promoteFrom ?? 'staging' }
        : {}),
      serviceNames: serviceNames.length > 0 ? serviceNames : bindings.boundServiceNames,
      providerProjectId: bindings.providerProjectId,
      providerEnvironmentId: bindings.providerEnvironmentId,
      ...(environment.hosting.region ? { providerRegion: environment.hosting.region } : {}),
      providerServiceIds: bindings.providerServiceIds,
      providerImageUris: bindings.providerImageUris,
      providerJobNames: bindings.providerJobNames,
      needsServiceNames: runtimeServiceNames.length > 0
        || (serviceNames.length === 0 && bindings.providerServiceIds.length > 0),
      needsJobNames: jobServiceNames.length > 0
        || (serviceNames.length === 0 && bindings.providerJobNames.length > 0),
      containerStartCommand,
      runtime,
    });

    if (
      !migration.includeStep
      && environment.migrations?.mode === 'tool'
      && environment.migrations.runInDeploy !== false
      && environment.migrations.command
    ) {
      migration = { includeStep: true, command: environment.migrations.command };
    } else if (!migration.note && environment.migrations?.mode === 'releaseCommand') {
      migration = {
        includeStep: false,
        note: 'Project uses release-command migrations; managed branch workflows will not run migrations.',
      };
    }
  }

  const order: BranchDeployEnvironmentKind[] = ['development', 'test', 'staging', 'production', 'custom'];
  const targets = Array.from(targetsByEnvironment.values()).sort((left, right) => (
    order.indexOf(left.kind) - order.indexOf(right.kind)
    || left.environmentName.localeCompare(right.environmentName)
  ));
  return { targets, desiredBranches, migration, skippedEnvironments };
}
