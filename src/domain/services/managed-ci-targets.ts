import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { Project } from '../entities/project.entity.js';
import type { Environment } from '../entities/environment.entity.js';
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
import { resolveBackupPolicies } from './backup-policy.service.js';
import { managedBackupCredentialKeys, managedBackupProvidersForSpec } from './managed-backup-target.service.js';
import { resolveBackupStrategy } from './backup-strategy.service.js';
import { providerRegistry } from '../registry/provider.registry.js';
import { selectedDeploymentAccess } from '../../adapters/cloud/deployment-access.client.js';
import { preparedHostingMarkerSchema } from '../ports/hosting-prepared.port.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { getProjectScopeHints } from './project-scope.js';
import { reviewedCloudDeploymentCiAccess } from './cloud-deployment-ci.js';
import { cloudDeploymentEffectiveSourceV1 } from './cloud-deployment-authentication.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
  return canonicalJsonSha256({
    version: 1,
    provider: params.provider,
    environment: params.environmentName,
    scope: params.scope,
    resources: normalizedReleaseResources(params.resources),
  });
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
  desiredWorkloadKinds?: Record<string, 'web' | 'worker' | 'cron'>,
  desiredProvider?: string,
  bindingOverride?: Environment
): {
  providerProjectId?: string;
  providerEnvironmentId?: string;
  providerScope?: Record<string, string>;
  providerServiceIds: string[];
  providerImageUris: string[];
  providerJobNames: string[];
  boundServiceNames: string[];
  serviceIdsByName: Record<string, string>;
  resourceUidsByName: Record<string, string>;
  releaseJobNamesByName: Record<string, string>;
  releaseResources: BranchDeployReleaseResource[];
} {
  if (bindingOverride && (bindingOverride.projectId !== projectId || bindingOverride.name !== environmentName))
    throw new Error('Reviewed workflow bindings do not match the selected environment.');
  const environment = bindingOverride ?? new EnvironmentRepository().findByProjectAndName(projectId, environmentName);
  const bindings = parseHostingBindings(environment);
  const bindingsMatchProvider = !desiredProvider || bindings.provider === desiredProvider;
  const services = bindingsMatchProvider ? bindings.services ?? {} : {};
  const boundServiceNames = Object.keys(services);
  const providerServiceIds: string[] = [];
  const providerImageUris: string[] = [];
  const providerJobNames: string[] = [];
  const serviceIdsByName: Record<string, string> = {};
  const resourceUidsByName: Record<string, string> = {};
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
    if (typeof record?.resourceUid === 'string' && record.resourceUid.trim()) resourceUidsByName[serviceName] = record.resourceUid;
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
    const providerResourceId = isScheduledJob ? jobName ?? serviceId : serviceId;
    const boundKindIsKnown = boundKind === 'web' || boundKind === 'worker' || boundKind === 'cron';
    const bindingMatchesDesiredKind = !configuredKind || (
      (!boundKindIsKnown || boundKind === configuredKind)
      && (isScheduledJob
        ? configuredKind === 'cron'
        : configuredKind !== 'cron' || boundKind === 'cron')
    );
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
    providerProjectId: bindingsMatchProvider && typeof bindings?.projectId === 'string'
      ? bindings.projectId
      : undefined,
    providerEnvironmentId: bindingsMatchProvider && typeof bindings?.environmentId === 'string'
      ? bindings.environmentId
      : undefined,
    ...(bindingsMatchProvider && bindings.providerScope ? { providerScope: bindings.providerScope } : {}),
    providerServiceIds,
    providerImageUris,
    providerJobNames,
    boundServiceNames,
    serviceIdsByName,
    resourceUidsByName,
    releaseJobNamesByName,
    releaseResources: normalizedReleaseResources(releaseResources),
  };
}

export function resolveReviewedBranchDeployTargets(project: Project, spec: ProjectSpec, bindingOverride?: Environment): {
  targets: BranchDeployTarget[];
  desiredBranches: Record<string, string | undefined>;
  migration: { includeStep: boolean; command?: string; note?: string };
  skippedEnvironments: string[];
} {
  if (bindingOverride && (bindingOverride.projectId !== project.id || !spec.environments[bindingOverride.name]))
    throw new Error('Reviewed workflow bindings do not match the selected project.');
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
    const bindings = managedCiEnvironmentBindings(
      project.id,
      environmentName,
      desiredWorkloadKinds,
      environment.hosting.provider,
      bindingOverride?.name === environmentName ? bindingOverride : undefined
    );
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
        ...(bindings.resourceUidsByName[resource.logicalName]
          ? { providerResourceUid: bindings.resourceUidsByName[resource.logicalName] }
          : {}),
        startCommand: desiredService.startCommand?.trim() || null,
        ...(desiredService.instanceBounds ? { instanceBounds: desiredService.instanceBounds } : {}),
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
      ...(environment.api ? { api: environment.api } : {}),
      kind,
      branch,
      autoDeployOnPush,
      ...(environment.deploy.promotionTests ? { promotionTests: environment.deploy.promotionTests } : {}),
      ...(promoteFromEnvironment
        ? {
            promoteFromEnvironment,
            promoteFromBranch: promoteFromEnvironmentSpec!.deploy?.branch ?? 'main',
            promoteFromProvider: spec.environments[promoteFromEnvironment]!.hosting.provider,
            promoteFromServiceNames: Object.keys(promoteFromEnvironmentSpec!.services),
          }
        : {}),
      deploymentContractFingerprint: environmentDeploymentContractHashForApply(spec, environmentName),
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
    const deployment = selectedDeploymentAccess({ providerName: environment.hosting.provider, environment: environmentName,
      scopeHints: getProjectScopeHints(project), store: { connections: new ConnectionRepository(), get secretStore() { return getSecretStore(); } } });
    if (deployment) {
      target.deploymentAccess = { origin: deployment.binding.baseUrl, projectId: deployment.binding.projectId,
        connectionId: deployment.binding.connectionId, environment: environmentName,
        sourceBranch: cloudDeploymentEffectiveSourceV1(deployment.receipt, deployment.sourceAuthorization).branch,
        connection: deployment.receipt, ...(deployment.sourceAuthorization ? { sourceAuthorization: deployment.sourceAuthorization } : {}) };
      // Separate browser approval still controls release. Rendering carries no
      // device/native token or mutable policy digest into the managed program.
      target.deploymentAccess = reviewedCloudDeploymentCiAccess(target);
    }
    const boundEnvironment = bindingOverride?.name === environmentName ? bindingOverride
      : new EnvironmentRepository().findByProjectAndName(project.id, environmentName);
    const nativeAuthentication = providerRegistry.getMetadata(environment.hosting.provider)?.orchestration?.ci?.boundAuthentication;
    const nativeBinding = nativeAuthentication && boundEnvironment?.platformBindings[nativeAuthentication.bindingKey];
    if (nativeBinding !== undefined && nativeAuthentication) {
      if (target.deploymentAccess) throw new Error('Select one separately reviewed CI authentication authority for this environment.');
      target.nativeAuthentication = nativeAuthentication.parse(nativeBinding, { environment: environmentName, branch,
        providerProjectId: target.providerProjectId, repository: spec.gitRemoteUrl ?? project.gitRemoteUrl });
    }
    if (deployment?.receipt.preparedResources) {
      const preparation = preparedHostingMarkerSchema.parse(boundEnvironment?.platformBindings.preparedHosting);
      if (preparation.installationId !== deployment.receipt.installationId || preparation.planDigest !== deployment.receipt.planDigest) {
        throw new Error('CI preparation does not match the installed cloud connection.');
      }
      target.preparedRuntime = { envVars: { ...environment.envVars }, preparation };
    }
    const components = boundEnvironment ? new ComponentRepository().findByEnvironmentId(boundEnvironment.id) : [];
    const backupPolicy = resolveBackupPolicies(spec, boundEnvironment ? [boundEnvironment] : [], components)[environmentName];
    if (backupPolicy.resources.length > 0) {
      const strategy = resolveBackupStrategy(environment);
      const credentials = [...new Set(managedBackupProvidersForSpec(environment)
        .flatMap(provider => Object.keys(managedBackupCredentialKeys(provider) ?? {})))].sort();
      target.backupPolicy = { mode: backupPolicy.mode,
        ...(strategy.runnerImage ? { runnerImage: strategy.runnerImage } : {}), credentialNames: credentials,
        ...(backupPolicy.resources.some(resource => resource.retained)
          ? { blockedReason: 'Retained persistent resources require explicit recovery coverage before rollout.' } : {}),
      };
    }
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
