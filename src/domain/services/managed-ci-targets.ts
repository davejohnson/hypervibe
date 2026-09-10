import { createHash } from 'crypto';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import type { Project } from '../entities/project.entity.js';
import type {
  BranchDeployEnvironmentKind,
  BranchDeployReleaseResource,
  BranchDeployReleaseTarget,
  BranchDeployRuntimeResource,
  BranchDeployTarget,
} from '../ports/ci-deploy.port.js';
import { parseHostingBindings } from '../ports/hosting.port.js';
import { withMigrationReleaseCommand } from '../spec/spec-bootstrap.js';
import { effectiveBranchCiAutoDeploy, type ProjectSpec } from '../spec/spec.schema.js';
import { environmentDeploymentContractHashForApply } from './deployment-contract.service.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

function normalizedReleaseResources(
  resources: BranchDeployReleaseResource[]
): BranchDeployReleaseResource[] {
  return [...resources].sort((left, right) => (
    left.logicalName.localeCompare(right.logicalName)
    || left.providerResourceType.localeCompare(right.providerResourceType)
    || left.providerResourceId.localeCompare(right.providerResourceId)
  ));
}

export function managedCiProviderScope(target: Pick<
  BranchDeployTarget,
  'providerProjectId' | 'providerEnvironmentId' | 'providerRegion' | 'providerScope'
>): BranchDeployReleaseTarget['scope'] {
  const providerScope = target.providerScope
    ? Object.fromEntries(
        Object.entries(target.providerScope)
          .map(([key, value]) => [key.trim(), value.trim()] as const)
          .filter(([key, value]) => key.length > 0 && value.length > 0)
          .sort(([left], [right]) => left.localeCompare(right))
      )
    : undefined;
  return {
    ...(target.providerProjectId?.trim()
      ? { providerProjectId: target.providerProjectId.trim() }
      : {}),
    ...(target.providerEnvironmentId?.trim()
      ? { providerEnvironmentId: target.providerEnvironmentId.trim() }
      : {}),
    ...(target.providerRegion?.trim()
      ? { providerRegion: target.providerRegion.trim() }
      : {}),
    ...(providerScope && Object.keys(providerScope).length > 0
      ? { providerScope }
      : {}),
  };
}

export function managedCiBindingsFingerprint(params: {
  provider: string;
  environmentName: string;
  scope: BranchDeployReleaseTarget['scope'];
  resources: BranchDeployReleaseResource[];
}): string {
  return createHash('sha256').update(JSON.stringify(canonicalize({
    version: 1,
    provider: params.provider,
    environment: params.environmentName,
    scope: params.scope,
    resources: normalizedReleaseResources(params.resources),
  })), 'utf8').digest('hex');
}

export function managedCiReleaseTarget(params: {
  provider: string;
  environmentName: string;
  scope: BranchDeployReleaseTarget['scope'];
  resources: BranchDeployReleaseResource[];
}): BranchDeployReleaseTarget {
  const resources = normalizedReleaseResources(params.resources);
  return {
    scope: params.scope,
    resources,
    bindingsFingerprint: managedCiBindingsFingerprint({ ...params, resources }),
  };
}

export function missingManagedCiReleaseBindings(
  target: Pick<BranchDeployTarget, 'serviceNames' | 'releaseTarget'>
): string[] {
  const desired = [...new Set(target.serviceNames.map((name) => name.trim()).filter(Boolean))].sort();
  const resources = target.releaseTarget?.resources ?? [];
  const actual = resources.map((resource) => resource.logicalName).sort();
  const duplicateLogical = new Set(actual).size !== actual.length;
  const duplicateProvider = new Set(
    resources.map((resource) => `${resource.providerResourceType}:${resource.providerResourceId}`)
  ).size !== resources.length;
  if (
    desired.length === 0
    || duplicateLogical
    || duplicateProvider
    || JSON.stringify(actual) !== JSON.stringify(desired)
  ) {
    return desired.filter((name) => !actual.includes(name)).concat(
      duplicateLogical || duplicateProvider || actual.some((name) => !desired.includes(name))
        ? ['invalid-or-duplicate-binding']
        : []
    );
  }
  return [];
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
  desiredWorkloadKinds?: Record<string, 'web' | 'worker' | 'cron'>
): {
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerScope?: Record<string, string>;
  providerServiceIds: string[];
  providerImageUris: string[];
  providerJobNames: string[];
  boundServiceNames: string[];
  serviceIdsByName: Record<string, string>;
  releaseJobNamesByName: Record<string, string>;
  releaseResources: BranchDeployReleaseResource[];
} {
  const environment = new EnvironmentRepository().findByProjectAndName(projectId, environmentName);
  const bindings = parseHostingBindings(environment);
  const services = bindings.services ?? {};
  const boundServiceNames = Object.keys(services);
  const providerServiceIds: string[] = [];
  const providerImageUris: string[] = [];
  const providerJobNames: string[] = [];
  const serviceIdsByName: Record<string, string> = {};
  const releaseJobNamesByName: Record<string, string> = {};
  const releaseResources: BranchDeployReleaseResource[] = [];
  for (const [serviceName, service] of Object.entries(services)) {
    if (desiredWorkloadKinds && !Object.hasOwn(desiredWorkloadKinds, serviceName)) continue;
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
    const releaseJobName = typeof record?.releaseJobName === 'string' && record.releaseJobName.trim().length > 0
      ? record.releaseJobName.trim()
      : undefined;
    if (imageUri) providerImageUris.push(imageUri);
    if (serviceId) serviceIdsByName[serviceName] = serviceId;
    if (releaseJobName) releaseJobNamesByName[serviceName] = releaseJobName;
    const isScheduledJob = record?.resourceType === 'scheduledJob' || Boolean(jobName);
    if (isScheduledJob) {
      const target = jobName ?? serviceId;
      if (target) providerJobNames.push(target);
    } else if (serviceId) {
      providerServiceIds.push(serviceId);
    }
    const configuredKind = desiredWorkloadKinds?.[serviceName];
    const boundKind = record?.workloadKind;
    const workloadKind = configuredKind
      ?? (boundKind === 'web' || boundKind === 'worker' || boundKind === 'cron'
        ? boundKind
        : isScheduledJob ? 'cron' : 'web');
    // Workload scheduling does not determine the provider resource type (for example Railway cron services).
    const providerResourceId = isScheduledJob ? jobName ?? serviceId : serviceId;
    const boundKindIsKnown = boundKind === 'web' || boundKind === 'worker' || boundKind === 'cron';
    const bindingMatchesDesiredKind = (!configuredKind || !boundKindIsKnown || boundKind === configuredKind)
      && (!isScheduledJob || workloadKind === 'cron');
    if (providerResourceId && bindingMatchesDesiredKind) {
      releaseResources.push({
        logicalName: serviceName,
        workloadKind,
        providerResourceType: isScheduledJob ? 'job' : 'service',
        providerResourceId,
      });
    }
  }
  return {
    providerProjectId: typeof bindings?.projectId === 'string' ? bindings.projectId : undefined,
    providerEnvironmentId: typeof bindings?.environmentId === 'string' ? bindings.environmentId : undefined,
    ...(bindings.providerScope ? { providerScope: bindings.providerScope } : {}),
    providerServiceIds,
    providerImageUris,
    providerJobNames,
    boundServiceNames,
    serviceIdsByName,
    releaseJobNamesByName,
    releaseResources: normalizedReleaseResources(releaseResources),
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
    const autoDeployOnPush = effectiveBranchCiAutoDeploy(
      environmentName,
      environment.deploy.autoDeploy
    );
    const defaultPromotionSource = spec.environments.staging;
    const promoteFromEnvironment = environment.deploy.promoteFrom ?? (
      kind === 'production'
      && !autoDeployOnPush
      && defaultPromotionSource?.deploy?.strategy === 'branch'
      && defaultPromotionSource.deploy.trigger !== 'native'
        ? 'staging'
        : undefined
    );
    const promoteFromEnvironmentSpec = promoteFromEnvironment
      ? withMigrationReleaseCommand(spec.environments[promoteFromEnvironment]!)
      : undefined;
    desiredBranches[environmentName] = branch;
    const effectiveEnvironment = withMigrationReleaseCommand(environment);
    const serviceNames = Object.keys(effectiveEnvironment.services);
    const desiredWorkloadKinds = Object.fromEntries(
      Object.entries(effectiveEnvironment.services)
        .map(([serviceName, service]) => [serviceName, service.workloadKind] as const)
    );
    const bindings = managedCiEnvironmentBindings(project.id, environmentName, desiredWorkloadKinds);
    const runtimeServiceNames = Object.entries(effectiveEnvironment.services)
      .filter(([, service]) => service.workloadKind !== 'cron')
      .map(([name]) => name);
    const jobServiceNames = Object.entries(effectiveEnvironment.services)
      .filter(([, service]) => service.workloadKind === 'cron')
      .map(([name]) => name);
    const runtimeServices = Object.values(effectiveEnvironment.services)
      .filter((service) => service.workloadKind !== 'cron');
    const webServices = runtimeServices.filter((service) => service.workloadKind === 'web');
    // The shared image defaults to the web command; workers retain their service overrides.
    const containerServices = webServices.length > 0 ? webServices : runtimeServices;
    const explicitContainerCommands = containerServices
      .map((service) => service.startCommand?.trim())
      .filter((command): command is string => Boolean(command));
    const containerCommands = [...new Set(explicitContainerCommands)];
    const containerStartCommand = containerServices.length > 0
      && runtimeServices.every((service) => Boolean(service.startCommand?.trim()))
      && explicitContainerCommands.length === containerServices.length
      && containerCommands.length === 1
      ? containerCommands[0]
      : undefined;
    const runtimeResources: BranchDeployRuntimeResource[] = bindings.releaseResources.map((resource) => {
      const desiredService = effectiveEnvironment.services[resource.logicalName]!;
      return {
        ...resource,
        startCommand: desiredService.startCommand?.trim() || null,
        healthCheckPath: resource.workloadKind !== 'cron'
          ? desiredService.healthCheckPath?.trim() || null
          : null,
      };
    });
    const releaseCommands = Object.entries(effectiveEnvironment.services)
      .filter(([, service]) => service.workloadKind !== 'cron' && Boolean(service.releaseCommand?.trim()))
      .map(([serviceName, service]) => ({
        serviceName,
        ...(bindings.serviceIdsByName[serviceName]
          ? { providerServiceId: bindings.serviceIdsByName[serviceName] }
          : {}),
        ...(bindings.releaseJobNamesByName[serviceName]
          ? { jobName: bindings.releaseJobNamesByName[serviceName] }
          : {}),
        command: service.releaseCommand!.trim(),
      }));
    const target: BranchDeployTarget = {
      environmentName,
      kind,
      branch,
      autoDeployOnPush,
      ...(promoteFromEnvironment
        ? {
            promoteFromEnvironment,
            promoteFromProvider: spec.environments[promoteFromEnvironment]!.hosting.provider,
            promoteFromServiceNames: Object.keys(promoteFromEnvironmentSpec!.services),
            promoteFromProgramFingerprint: environmentDeploymentContractHashForApply(
              spec,
              promoteFromEnvironment
            ),
          }
        : {}),
      programFingerprint: environmentDeploymentContractHashForApply(spec, environmentName),
      serviceNames: serviceNames.length > 0 ? serviceNames : bindings.boundServiceNames,
      providerProjectId: bindings.providerProjectId,
      providerEnvironmentId: bindings.providerEnvironmentId,
      ...(bindings.providerScope ? { providerScope: bindings.providerScope } : {}),
      ...(environment.hosting.region ? { providerRegion: environment.hosting.region } : {}),
      providerServiceIds: bindings.providerServiceIds,
      providerImageUris: bindings.providerImageUris,
      providerJobNames: bindings.providerJobNames,
      ...(runtimeResources.length > 0 ? { runtimeResources } : {}),
      ...(releaseCommands.length > 0 ? { releaseCommands } : {}),
      needsServiceNames: runtimeServiceNames.length > 0
        || (serviceNames.length === 0 && bindings.providerServiceIds.length > 0),
      needsJobNames: jobServiceNames.length > 0
        || (serviceNames.length === 0 && bindings.providerJobNames.length > 0),
      containerStartCommand,
      runtime,
    };
    target.releaseTarget = managedCiReleaseTarget({
      provider: environment.hosting.provider,
      environmentName,
      scope: managedCiProviderScope(target),
      resources: bindings.releaseResources,
    });
    targetsByEnvironment.set(environmentName, target);

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
        note: 'Project uses provider-owned release-command migrations; the hosting deploy runs them before rollout.',
      };
    }
  }

  for (const target of targetsByEnvironment.values()) {
    if (!target.promoteFromEnvironment) continue;
    const sourceTarget = targetsByEnvironment.get(target.promoteFromEnvironment);
    if (sourceTarget?.releaseTarget) {
      target.promoteFromReleaseTarget = sourceTarget.releaseTarget;
    }
  }

  const order: BranchDeployEnvironmentKind[] = ['development', 'test', 'staging', 'production', 'custom'];
  const targets = Array.from(targetsByEnvironment.values()).sort((left, right) => (
    order.indexOf(left.kind) - order.indexOf(right.kind)
    || left.environmentName.localeCompare(right.environmentName)
  ));
  return { targets, desiredBranches, migration, skippedEnvironments };
}
