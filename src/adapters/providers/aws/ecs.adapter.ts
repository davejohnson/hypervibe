import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type {
  ContainerDefinition,
  KeyValuePair,
  RegisterTaskDefinitionCommandInput,
  Service as AwsService,
  TaskDefinition,
} from '@aws-sdk/client-ecs';
import type { ComponentType } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import {
  serviceWorkloadKind,
  type Service,
  type WorkloadKind,
} from '../../../domain/entities/service.entity.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import {
  hashEnvValue,
  type ObservedService,
  type ObservedState,
} from '../../../domain/ports/observe.port.js';
import type {
  ComponentResult,
  DeploymentMutationOptions,
  DeployResult,
  IProviderAdapter,
  ProviderCapabilities,
  Receipt,
  VerifyResult,
} from '../../../domain/ports/provider.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import {
  EcsFargateClient,
  type AwsEcsPrerequisites,
} from './ecs.client.js';
import {
  EcsCredentialsSchema,
  type EcsCredentials,
} from './ecs.credentials.js';
import {
  AWS_ECS_CI_REQUIRED_SECRETS,
  buildAwsEcsGitHubActionsSteps,
} from './ecs-ci.workflow.js';

const BOOTSTRAP_IMAGE = 'public.ecr.aws/docker/library/alpine:3.20';
const START_COMMAND_KEY = 'HYPERVIBE_START_COMMAND';
const HEALTH_CHECK_PATH_KEY = 'HYPERVIBE_HEALTH_CHECK_PATH';
const DEPLOY_SHA_KEY = 'HYPERVIBE_DEPLOY_SHA';
const IMAGE_DIGEST_KEY = 'HYPERVIBE_IMAGE_DIGEST';
const INTERNAL_ENV_KEYS = new Set([
  START_COMMAND_KEY,
  HEALTH_CHECK_PATH_KEY,
  DEPLOY_SHA_KEY,
  IMAGE_DIGEST_KEY,
]);
const BINDING_PREFIX = 'ecs1.';

interface EcsServiceBinding {
  version: 1;
  serviceArn: string;
  taskFamily: string;
  containerName: string;
  workloadKind: 'web' | 'worker';
  executionRoleArn: string;
  taskRoleArn?: string;
  cpu: string;
  memory: string;
  containerPort: number;
  subnetIds: string[];
  securityGroupIds: string[];
  assignPublicIp: boolean;
  targetGroupArn?: string;
  url?: string;
}

interface ServiceMutation {
  binding: string;
  serviceArn: string;
  createdService: boolean;
  mutationAttempted: true;
  taskDefinitionArn?: string;
}

export class EcsFargateAdapter implements IProviderAdapter {
  readonly name = 'ecs';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [],
    supportsAutoWiring: false,
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false,
    managedTls: false,
    supportsObserve: true,
    supportsDeferredDeploy: true,
  };

  private credentials: EcsCredentials | null = null;
  private client: EcsFargateClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = EcsCredentialsSchema.parse(credentials);
    this.client = new EcsFargateClient(this.credentials);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client || !this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await Promise.all([
        this.client.verifyPrerequisites(),
        this.client.listClusters(),
      ]);
      return {
        success: true,
        email: `AWS ECS (${this.credentials.region})`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect();
    this.client = null;
    this.credentials = null;
  }

  async ensureProject(
    _projectName: string,
    environment: Environment
  ): Promise<Receipt> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const boundArn = parseHostingBindings(environment).projectId;
    if (boundArn) {
      try {
        const cluster = await this.client.getCluster(boundArn);
        if (!cluster || cluster.status === 'INACTIVE') {
          return {
            success: false,
            message: 'Failed to ensure AWS ECS cluster',
            error: `Bound ECS cluster ${boundArn} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`,
          };
        }
        const ready = await this.waitForCluster(boundArn);
        return {
          success: true,
          message: `Using bound AWS ECS cluster: ${ready.clusterName}`,
          data: {
            projectId: ready.clusterArn,
            projectName: ready.clusterName,
            created: false,
          },
        };
      } catch (error) {
        return {
          success: false,
          message: 'Failed to ensure AWS ECS cluster',
          error: this.formatError(error),
        };
      }
    }

    const clusterName = this.clusterName(environment);
    const anticipatedArn = this.clusterArn(clusterName);
    let mutationAttempted = false;
    try {
      const matches = (await this.client.listClusters()).filter(
        (cluster) => cluster.clusterName === clusterName
      );
      if (matches.length > 0) {
        return {
          success: false,
          message: 'Failed to ensure AWS ECS cluster',
          error: [
            `ECS cluster "${clusterName}" already exists: ${matches
              .map((cluster) => cluster.clusterArn)
              .join(', ')}.`,
            'Hypervibe will not silently adopt a name match. Explicit AWS import support is required before adoption; otherwise remove the conflict and run hv_plan again.',
          ].join(' '),
          data: {
            duplicateProjectIds: matches
              .flatMap((cluster) => cluster.clusterArn ? [cluster.clusterArn] : [])
              .sort(),
          },
        };
      }
      mutationAttempted = true;
      const created = await this.client.createCluster(
        clusterName,
        this.environmentTags(environment)
      );
      if (created.clusterArn !== anticipatedArn) {
        throw new Error(
          `AWS returned ECS cluster ${created.clusterArn} outside the reviewed durable identity ${anticipatedArn}.`
        );
      }
      const ready = await this.waitForCluster(anticipatedArn);
      return {
        success: true,
        message: `Created AWS ECS cluster: ${clusterName}`,
        data: {
          projectId: ready.clusterArn,
          projectName: ready.clusterName,
          created: true,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to create AWS ECS cluster',
        error: this.formatError(error),
        ...(mutationAttempted
          ? {
              data: {
                projectId: anticipatedArn,
                created: true,
                mutationAttempted: true,
              },
            }
          : {}),
      };
    }
  }

  async ensureComponent(
    type: ComponentType,
    environment: Environment
  ): Promise<ComponentResult> {
    return {
      component: {
        id: '',
        environmentId: environment.id,
        type,
        bindings: {},
        externalId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      receipt: {
        success: false,
        message:
          'AWS datastores use separate provider adapters and explicit plan actions.',
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<DeployResult> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const workloadKind = serviceWorkloadKind(service);
    if (workloadKind === 'cron') {
      return this.failedDeploy(
        service,
        'Amazon ECS scheduled tasks require an EventBridge lifecycle resource and are not supported by this hosting adapter.'
      );
    }
    if (!service.buildConfig.startCommand?.trim()) {
      return this.failedDeploy(
        service,
        'AWS ECS services require startCommand so runtime behavior remains declarative and observable.'
      );
    }
    const clusterArn = parseHostingBindings(environment).projectId;
    if (!clusterArn) {
      return this.failedDeploy(
        service,
        'No AWS ECS cluster binding exists for this environment.'
      );
    }

    let mutation: ServiceMutation | undefined;
    try {
      const [cluster, prerequisites] = await Promise.all([
        this.client.getCluster(clusterArn),
        this.client.verifyPrerequisites(),
      ]);
      if (!cluster || cluster.status !== 'ACTIVE') {
        return this.failedDeploy(
          service,
          `Bound ECS cluster ${clusterArn} is absent or not active. Re-run hv_plan; Hypervibe will not create a service under an unknown cluster.`
        );
      }
      this.assertPublicPrerequisites(service, workloadKind, prerequisites);

      const bindings = parseHostingBindings(environment);
      const existingBindingValue =
        bindings.services?.[service.name]?.serviceId;
      let awsService: AwsService;
      let createdService = false;
      let binding: EcsServiceBinding;
      if (existingBindingValue) {
        binding = this.parseServiceBinding(existingBindingValue);
        this.assertBindingCluster(binding, clusterArn);
        this.assertDesiredBinding(binding, service, workloadKind);
        const current = await this.client.getService(
          clusterArn,
          binding.serviceArn
        );
        if (!current || current.status === 'INACTIVE') {
          return this.failedDeploy(
            service,
            `Bound ECS service ${binding.serviceArn} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`
          );
        }
        this.assertServiceBinding(current, binding, clusterArn);
        const currentTask = await this.requiredTaskDefinition(current);
        this.assertTaskBinding(currentTask, binding);
        this.assertTaskConfiguration(currentTask, binding);
        await this.runtimeStatus(current, binding, currentTask);
        const nextTaskInput = this.updatedTaskDefinitionInput({
          currentTask,
          binding,
          service,
          envVars,
        });
        const nextTask = await this.client.registerTaskDefinition(
          nextTaskInput
        );
        mutation = {
          binding: existingBindingValue,
          serviceArn: binding.serviceArn,
          createdService: false,
          mutationAttempted: true,
          taskDefinitionArn: nextTask.taskDefinitionArn,
        };
        await this.client.updateService({
          clusterArn,
          serviceArn: binding.serviceArn,
          taskDefinitionArn: nextTask.taskDefinitionArn,
        });
        awsService = await this.waitForService({
          clusterArn,
          serviceArn: binding.serviceArn,
          taskDefinitionArn: nextTask.taskDefinitionArn!,
          allowZero: true,
        });
      } else {
        const serviceName = this.serviceName(environment, service.name);
        const matches = (await this.client.listServices(clusterArn)).filter(
          (candidate) => candidate.serviceName === serviceName
        );
        if (matches.length > 0) {
          return this.failedDeploy(
            service,
            [
              `ECS service "${serviceName}" already exists: ${matches
                .map((candidate) => candidate.serviceArn)
                .join(', ')}.`,
              'Hypervibe will not silently adopt a name match. Explicit AWS import support is required before adoption; otherwise remove the conflict and run hv_plan again.',
            ].join(' ')
          );
        }
        await this.assertTargetGroupAvailable(
          clusterArn,
          workloadKind,
          service
        );
        const taskFamily = this.taskFamily(environment, service.name);
        const containerName = this.containerName(service.name);
        const serviceArn = this.serviceArn(clusterArn, serviceName);
        binding = {
          version: 1,
          serviceArn,
          taskFamily,
          containerName,
          workloadKind,
          executionRoleArn: this.credentials.executionRoleArn,
          ...(this.credentials.taskRoleArn
            ? { taskRoleArn: this.credentials.taskRoleArn }
            : {}),
          cpu: this.credentials.cpu,
          memory: this.credentials.memory,
          containerPort: this.credentials.containerPort,
          subnetIds: [...this.credentials.subnetIds].sort(),
          securityGroupIds: [...this.credentials.securityGroupIds].sort(),
          assignPublicIp: this.credentials.assignPublicIp,
          ...(this.publicWeb(service, workloadKind)
            ? {
                targetGroupArn: this.credentials.targetGroupArn,
                url: this.prerequisiteUrl(prerequisites),
              }
            : {}),
        };
        const bindingValue = this.serviceBinding(binding);
        const task = await this.client.registerTaskDefinition(
          this.bootstrapTaskDefinitionInput({
            environment,
            service,
            envVars,
            binding,
          })
        );
        mutation = {
          binding: bindingValue,
          serviceArn,
          createdService: true,
          mutationAttempted: true,
          taskDefinitionArn: task.taskDefinitionArn,
        };
        const created = await this.client.createService({
          cluster: clusterArn,
          serviceName,
          clientToken: this.hash(
            `${environment.projectId}:${environment.name}:${service.name}:ecs-service`,
            32
          ),
          taskDefinition: task.taskDefinitionArn,
          desiredCount: 0,
          capacityProviderStrategy: [{
            capacityProvider: 'FARGATE',
            weight: 1,
            base: 0,
          }],
          platformVersion: 'LATEST',
          deploymentConfiguration: {
            minimumHealthyPercent: 100,
            maximumPercent: 200,
            deploymentCircuitBreaker: {
              enable: true,
              rollback: true,
            },
          },
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: this.credentials.subnetIds,
              securityGroups: this.credentials.securityGroupIds,
              assignPublicIp: this.credentials.assignPublicIp
                ? 'ENABLED'
                : 'DISABLED',
            },
          },
          ...(binding.targetGroupArn
            ? {
                loadBalancers: [{
                  targetGroupArn: binding.targetGroupArn,
                  containerName,
                  containerPort: this.credentials.containerPort,
                }],
                healthCheckGracePeriodSeconds: 60,
              }
            : {}),
          enableECSManagedTags: true,
          enableExecuteCommand: false,
          propagateTags: 'SERVICE',
          tags: this.serviceTags(environment, service, workloadKind),
        });
        if (created.serviceArn !== serviceArn) {
          throw new Error(
            `AWS returned ECS service ${created.serviceArn} outside the reviewed durable identity ${serviceArn}.`
          );
        }
        awsService = await this.waitForService({
          clusterArn,
          serviceArn,
          taskDefinitionArn: task.taskDefinitionArn!,
          allowZero: true,
        });
        createdService = true;
      }

      const externalId = this.serviceBinding(binding);
      const url = this.publicUrl(
        service,
        workloadKind,
        prerequisites
      );
      const task = await this.requiredTaskDefinition(awsService);
      return {
        serviceId: service.id,
        externalId,
        ...(url ? { url } : {}),
        status: 'configured',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared AWS ECS service for exact-digest CI deployment: ${awsService.serviceName}`
            : `Configured AWS ECS service; an exact-digest CI deployment is still required: ${awsService.serviceName}`,
          data: {
            serviceId: externalId,
            ecsServiceArn: awsService.serviceArn,
            clusterArn,
            taskDefinitionArn: task.taskDefinitionArn,
            taskFamily: binding.taskFamily,
            resourceType: workloadKind,
            createdService,
            deploymentDeferred: true,
            pendingImage:
              task.containerDefinitions?.[0]?.image === BOOTSTRAP_IMAGE,
            ...(url ? { url } : {}),
          },
        },
      };
    } catch (error) {
      return this.failedDeploy(
        service,
        this.formatError(error),
        mutation
      );
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    return this.mutateEnvironmentVariables({
      environment,
      service,
      vars,
      deleteKeys: [],
      options,
    });
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    const retired = Array.from(new Set(keys))
      .filter((key) => !INTERNAL_ENV_KEYS.has(key))
      .sort();
    return this.mutateEnvironmentVariables({
      environment,
      service,
      vars: {},
      deleteKeys: retired,
      options: {},
    });
  }

  async deleteService(
    serviceBindingValue: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const binding = this.parseServiceBinding(serviceBindingValue);
      const clusterArn = this.clusterArnFromServiceArn(binding.serviceArn);
      let service = await this.client.getService(
        clusterArn,
        binding.serviceArn
      );
      if (service && service.status !== 'INACTIVE') {
        await this.client.updateService({
          clusterArn,
          serviceArn: binding.serviceArn,
          desiredCount: 0,
        });
        const drained = await this.waitForServiceDrained(
          clusterArn,
          binding.serviceArn
        );
        if (!drained) {
          return {
            success: false,
            error: `ECS service ${binding.serviceArn} still has running or pending tasks; task-definition cleanup was skipped.`,
          };
        }
        await this.client.deleteService(clusterArn, binding.serviceArn);
        service = await this.waitForServiceDeleted(
          clusterArn,
          binding.serviceArn
        );
        if (service) {
          return {
            success: false,
            error: `ECS service ${binding.serviceArn} did not reach terminal INACTIVE/absent state; task-definition cleanup was skipped.`,
          };
        }
      }
      await this.deleteTaskDefinitionFamily(binding.taskFamily);
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async deleteProject(
    clusterArn: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const cluster = await this.client.getCluster(clusterArn);
      if (!cluster || cluster.status === 'INACTIVE') {
        return { success: true };
      }
      const dependents = (await this.client.listServices(clusterArn)).filter(
        (service) => service.status !== 'INACTIVE'
      );
      if (dependents.length > 0) {
        return {
          success: false,
          error: `ECS cluster ${clusterArn} still contains services: ${dependents
            .map((service) => service.serviceArn)
            .join(', ')}. Delete the dependent service actions first.`,
        };
      }
      await this.client.deleteCluster(clusterArn);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_AWS_ECS_CLUSTER_DELETE_ATTEMPTS',
        120
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_AWS_ECS_CLUSTER_DELETE_DELAY_MS',
        2000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const observed = await this.client.getCluster(clusterArn);
        if (!observed || observed.status === 'INACTIVE') {
          return { success: true };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      return {
        success: false,
        error: `ECS cluster ${clusterArn} remained active after ${attempts} deletion checks.`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async getDeployStatus(
    _environment: Environment,
    serviceBindingValue: string
  ): Promise<{ status: string; url?: string }> {
    if (!this.client) return { status: 'unknown' };
    try {
      const binding = this.parseServiceBinding(serviceBindingValue);
      const clusterArn = this.clusterArnFromServiceArn(binding.serviceArn);
      const service = await this.client.getService(
        clusterArn,
        binding.serviceArn
      );
      if (!service || service.status === 'INACTIVE') {
        return { status: 'absent' };
      }
      const status = await this.runtimeStatus(service, binding);
      return {
        status: status === 'running' ? 'deployed' : status,
        ...(binding.url ? { url: binding.url } : {}),
      };
    } catch {
      return { status: 'unknown' };
    }
  }

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const bindings = parseHostingBindings(environment);
    const clusters = await this.client.listClusters();
    if (!bindings.projectId) {
      const name = this.clusterName(environment);
      const matches = clusters.filter(
        (cluster) => cluster.clusterName === name
      );
      if (matches.length > 0) {
        throw new Error([
          `ECS clusters matching this Hypervibe environment exist without a durable local binding: ${matches
            .map((cluster) => `${cluster.clusterName} (${cluster.clusterArn})`)
            .join(', ')}.`,
          'Explicit AWS import support is required before adoption; Hypervibe will not silently bind a name match.',
        ].join(' '));
      }
      return this.emptyObservation(false);
    }
    const cluster = clusters.find(
      (candidate) => candidate.clusterArn === bindings.projectId
    );
    if (!cluster || cluster.status === 'INACTIVE') {
      return this.emptyObservation(false);
    }

    const [services, prerequisites] = await Promise.all([
      this.client.listServices(cluster.clusterArn!),
      this.client.verifyPrerequisites(),
    ]);
    const parsedBindings = new Map<string, EcsServiceBinding>();
    const boundServiceArns = new Set<string>();
    for (const [logicalName, value] of Object.entries(
      bindings.services ?? {}
    )) {
      if (!value.serviceId) continue;
      const parsed = this.parseServiceBinding(value.serviceId);
      this.assertBindingCluster(parsed, cluster.clusterArn!);
      parsedBindings.set(logicalName, parsed);
      boundServiceArns.add(parsed.serviceArn);
    }
    const unbound = services.filter(
      (service) =>
        service.status !== 'INACTIVE'
        && service.serviceArn
        && !boundServiceArns.has(service.serviceArn)
    );
    if (unbound.length > 0) {
      throw new Error([
        `ECS services exist in the bound Hypervibe cluster without durable local bindings: ${unbound
          .map((service) => `${service.serviceName} (${service.serviceArn})`)
          .join(', ')}.`,
        'Explicit AWS import support is required before adoption; Hypervibe will not silently choose a name match.',
      ].join(' '));
    }

    const servicesByArn = new Map(
      services.flatMap((service) =>
        service.serviceArn ? [[service.serviceArn, service] as const] : []
      )
    );
    const observed: ObservedService[] = [];
    for (const [logicalName, binding] of parsedBindings) {
      const service = servicesByArn.get(binding.serviceArn);
      if (!service || service.status === 'INACTIVE') continue;
      observed.push(await this.observedService(
        logicalName,
        service,
        binding,
        prerequisites
      ));
    }
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: cluster.clusterArn,
      environmentId: cluster.clusterArn,
      services: observed,
      databases: [],
      caches: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'unknown',
        caches: 'unknown',
        storage: 'complete',
      },
      partial: false,
      warnings: [],
    };
  }

  private async mutateEnvironmentVariables(params: {
    environment: Environment;
    service: Service;
    vars: Record<string, string>;
    deleteKeys: string[];
    options: DeploymentMutationOptions;
  }): Promise<Receipt> {
    const bindings = parseHostingBindings(params.environment);
    const value = bindings.services?.[params.service.name]?.serviceId;
    const clusterArn = bindings.projectId;
    if (!this.client || !value || !clusterArn) {
      return {
        success: false,
        message: 'Failed to update AWS ECS environment variables',
        error: !this.client
          ? 'Not connected. Call connect() first.'
          : `No AWS ECS durable binding exists for ${params.service.name}.`,
      };
    }
    try {
      const binding = this.parseServiceBinding(value);
      this.assertBindingCluster(binding, clusterArn);
      this.assertDesiredBinding(
        binding,
        params.service,
        this.nonCronWorkloadKind(params.service)
      );
      const service = await this.client.getService(
        clusterArn,
        binding.serviceArn
      );
      if (!service || service.status === 'INACTIVE') {
        return {
          success: false,
          message: 'Failed to update AWS ECS environment variables',
          error: `Bound ECS service ${binding.serviceArn} was not found.`,
          data: { staleBinding: true },
        };
      }
      const currentTask = await this.requiredTaskDefinition(service);
      this.assertTaskBinding(currentTask, binding);
      this.assertTaskConfiguration(currentTask, binding);
      await this.runtimeStatus(service, binding, currentTask);
      const nextTask = await this.client.registerTaskDefinition(
        this.updatedTaskDefinitionInput({
          currentTask,
          binding,
          service: params.service,
          envVars: params.vars,
          deleteKeys: params.deleteKeys,
        })
      );
      await this.client.updateService({
        clusterArn,
        serviceArn: binding.serviceArn,
        taskDefinitionArn: nextTask.taskDefinitionArn,
      });
      await this.waitForService({
        clusterArn,
        serviceArn: binding.serviceArn,
        taskDefinitionArn: nextTask.taskDefinitionArn!,
        allowZero: true,
      });
      return {
        success: true,
        message: params.deleteKeys.length > 0
          ? `Deleted explicitly retired AWS ECS environment variables for ${params.service.name}`
          : `Updated AWS ECS environment variables for ${params.service.name}`,
        data: {
          serviceId: value,
          taskDefinitionArn: nextTask.taskDefinitionArn,
          ...(params.deleteKeys.length > 0
            ? { deletedKeys: params.deleteKeys }
            : {
                variableCount: Object.keys(
                  this.runtimeEnvVars(params.vars)
                ).length,
              }),
          ...(params.options.deferDeployment
            ? { deploymentDeferred: true }
            : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update AWS ECS environment variables',
        error: this.formatError(error),
      };
    }
  }

  private async observedService(
    logicalName: string,
    service: AwsService,
    binding: EcsServiceBinding,
    prerequisites: AwsEcsPrerequisites
  ): Promise<ObservedService> {
    this.assertServiceBinding(
      service,
      binding,
      service.clusterArn!
    );
    const task = await this.requiredTaskDefinition(service);
    this.assertTaskBinding(task, binding);
    this.assertTaskConfiguration(task, binding);
    const container = this.primaryContainer(task, binding.containerName);
    const environment = container.environment ?? [];
    this.assertCompleteEnvironment(environment);
    const runtime = environment.filter(
      (entry) => entry.name && !INTERNAL_ENV_KEYS.has(entry.name)
    );
    const values = new Map(
      runtime.flatMap((entry) =>
        entry.name && typeof entry.value === 'string'
          ? [[entry.name, entry.value] as const]
          : []
      )
    );
    const startCommand = this.environmentValue(
      environment,
      START_COMMAND_KEY
    );
    const healthCheckPath = this.environmentValue(
      environment,
      HEALTH_CHECK_PATH_KEY
    );
    const publicService = (service.loadBalancers ?? []).length > 0;
    const url = publicService
      ? this.prerequisiteUrl(prerequisites)
      : undefined;
    return {
      name: logicalName,
      externalId: this.serviceBinding(binding),
      workloadKind: binding.workloadKind,
      ...(url ? { url } : {}),
      customDomains: [],
      config: {
        ...(startCommand ? { startCommand } : {}),
        ...(healthCheckPath ? { healthCheckPath } : {}),
        public: publicService,
      },
      sourceState: 'disconnected',
      envVarKeys: Array.from(values.keys()).sort(),
      envVarHashes: Object.fromEntries(
        Array.from(values, ([key, value]) => [key, hashEnvValue(value)])
      ),
      status: await this.runtimeStatus(service, binding, task),
    };
  }

  private bootstrapTaskDefinitionInput(params: {
    environment: Environment;
    service: Service;
    envVars: Record<string, string>;
    binding: EcsServiceBinding;
  }): RegisterTaskDefinitionCommandInput {
    const environment = this.updatedEnvironment(
      [],
      params.service,
      params.envVars
    );
    return {
      family: params.binding.taskFamily,
      taskRoleArn: this.credentials!.taskRoleArn,
      executionRoleArn: this.credentials!.executionRoleArn,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: this.credentials!.cpu,
      memory: this.credentials!.memory,
      runtimePlatform: {
        cpuArchitecture: 'X86_64',
        operatingSystemFamily: 'LINUX',
      },
      containerDefinitions: [{
        name: params.binding.containerName,
        image: BOOTSTRAP_IMAGE,
        essential: true,
        entryPoint: ['/bin/sh', '-lc'],
        command: ['while true; do sleep 3600; done'],
        environment,
        ...(params.binding.workloadKind === 'web'
          ? {
              portMappings: [{
                name: 'http',
                containerPort: this.credentials!.containerPort,
                hostPort: this.credentials!.containerPort,
                protocol: 'tcp',
                appProtocol: 'http',
              }],
            }
          : {}),
      }],
      tags: this.serviceTags(
        params.environment,
        params.service,
        params.binding.workloadKind
      ),
    };
  }

  private updatedTaskDefinitionInput(params: {
    currentTask: TaskDefinition;
    binding: EcsServiceBinding;
    service: Service;
    envVars: Record<string, string>;
    deleteKeys?: string[];
  }): RegisterTaskDefinitionCommandInput {
    const container = this.primaryContainer(
      params.currentTask,
      params.binding.containerName
    );
    const updatedContainer: ContainerDefinition = {
      ...container,
      environment: this.updatedEnvironment(
        container.environment ?? [],
        params.service,
        params.envVars,
        params.deleteKeys
      ),
    };
    return {
      family: params.binding.taskFamily,
      taskRoleArn: this.credentials!.taskRoleArn,
      executionRoleArn: this.credentials!.executionRoleArn,
      networkMode: 'awsvpc',
      containerDefinitions: (params.currentTask.containerDefinitions ?? [])
        .map((candidate) =>
          candidate.name === params.binding.containerName
            ? updatedContainer
            : candidate
        ),
      volumes: params.currentTask.volumes,
      placementConstraints: params.currentTask.placementConstraints,
      requiresCompatibilities: ['FARGATE'],
      cpu: this.credentials!.cpu,
      memory: this.credentials!.memory,
      ipcMode: params.currentTask.ipcMode,
      pidMode: params.currentTask.pidMode,
      proxyConfiguration: params.currentTask.proxyConfiguration,
      inferenceAccelerators: params.currentTask.inferenceAccelerators,
      ephemeralStorage: params.currentTask.ephemeralStorage,
      runtimePlatform: {
        cpuArchitecture: 'X86_64',
        operatingSystemFamily: 'LINUX',
      },
      tags: [{
        key: 'hypervibe-managed',
        value: 'true',
      }],
    };
  }

  private updatedEnvironment(
    current: KeyValuePair[],
    service: Service,
    vars: Record<string, string>,
    deleteKeys: string[] = []
  ): KeyValuePair[] {
    const runtime = this.runtimeEnvVars(vars);
    const deleted = new Set(deleteKeys);
    if (current.some(
      (entry) =>
        typeof entry.name !== 'string'
        || typeof entry.value !== 'string'
    )) {
      throw new Error(
        'AWS returned an incomplete ECS task environment; Hypervibe refused an update that could erase variables.'
      );
    }
    const names = current.map((entry) => entry.name!);
    if (new Set(names).size !== names.length) {
      throw new Error(
        'AWS returned duplicate ECS task environment names; Hypervibe refused to choose one.'
      );
    }
    const values = new Map(
      current.flatMap((entry) =>
        entry.name && typeof entry.value === 'string'
          ? [[entry.name, entry.value] as const]
          : []
      ).filter(([name]) =>
        !deleted.has(name)
        && !(name in runtime)
        && ![START_COMMAND_KEY, HEALTH_CHECK_PATH_KEY].includes(name)
      )
    );
    for (const key of deleted) values.delete(key);
    for (const [key, value] of Object.entries(runtime)) {
      values.set(key, value);
    }
    if (!deleted.has('PORT') && !values.has('PORT')) {
      values.set('PORT', String(this.credentials!.containerPort));
    }
    values.set(START_COMMAND_KEY, this.requiredStartCommand(service));
    const healthPath = service.buildConfig.healthCheckPath?.trim();
    if (healthPath && serviceWorkloadKind(service) === 'web') {
      values.set(HEALTH_CHECK_PATH_KEY, healthPath);
    } else {
      values.delete(HEALTH_CHECK_PATH_KEY);
    }
    return Array.from(values, ([name, value]) => ({ name, value }))
      .sort((left, right) => left.name!.localeCompare(right.name!));
  }

  private runtimeEnvVars(
    vars: Record<string, string>
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(vars).filter(([key]) =>
        key !== 'IMAGE_URI'
        && !key.startsWith('IMAGE_URI_')
        && !key.startsWith('HYPERVIBE_SOURCE_')
        && !INTERNAL_ENV_KEYS.has(key)
      )
    );
  }

  private primaryContainer(
    task: TaskDefinition,
    containerName: string
  ): ContainerDefinition {
    const matches = (task.containerDefinitions ?? []).filter(
      (container) => container.name === containerName
    );
    if (matches.length !== 1) {
      throw new Error(
        `ECS task definition ${task.taskDefinitionArn} must contain exactly one bound container named ${containerName}.`
      );
    }
    return matches[0]!;
  }

  private async requiredTaskDefinition(
    service: AwsService
  ): Promise<TaskDefinition> {
    if (!service.taskDefinition) {
      throw new Error(
        `ECS service ${service.serviceArn} has no task-definition binding.`
      );
    }
    return this.client!.getTaskDefinition(service.taskDefinition);
  }

  private async waitForCluster(
    clusterArn: string
  ): Promise<NonNullable<Awaited<ReturnType<
    EcsFargateClient['getCluster']
  >>>> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AWS_ECS_CLUSTER_READY_ATTEMPTS',
      120
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AWS_ECS_CLUSTER_READY_DELAY_MS',
      2000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const cluster = await this.client!.getCluster(clusterArn);
      if (cluster?.status === 'ACTIVE') return cluster;
      if (cluster && ['INACTIVE', 'FAILED'].includes(cluster.status ?? '')) {
        throw new Error(
          `ECS cluster ${clusterArn} entered terminal state ${cluster.status}.`
        );
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(
      `ECS cluster ${clusterArn} did not reach ACTIVE after ${attempts} checks.`
    );
  }

  private async waitForService(params: {
    clusterArn: string;
    serviceArn: string;
    taskDefinitionArn: string;
    allowZero: boolean;
  }): Promise<AwsService> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AWS_ECS_SERVICE_READY_ATTEMPTS',
      180
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AWS_ECS_SERVICE_READY_DELAY_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const service = await this.client!.getService(
        params.clusterArn,
        params.serviceArn
      );
      if (!service || service.status === 'INACTIVE') {
        throw new Error(
          `ECS service ${params.serviceArn} disappeared while waiting for convergence.`
        );
      }
      const primary = (service.deployments ?? []).find(
        (deployment) => deployment.status === 'PRIMARY'
      );
      const desired = service.desiredCount ?? -1;
      if (
        service.status === 'ACTIVE'
        && service.taskDefinition === params.taskDefinitionArn
        && primary?.taskDefinition === params.taskDefinitionArn
        && primary.rolloutState === 'COMPLETED'
        && service.pendingCount === 0
        && (
          params.allowZero && desired === 0
          || desired > 0 && service.runningCount === desired
        )
      ) {
        return service;
      }
      if (
        primary?.rolloutState === 'FAILED'
        || service.status === 'DRAINING'
      ) {
        throw new Error(
          `ECS service ${params.serviceArn} entered terminal deployment state ${primary?.rolloutState ?? service.status}.`
        );
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(
      `ECS service ${params.serviceArn} did not converge to ${params.taskDefinitionArn} after ${attempts} checks.`
    );
  }

  private async waitForServiceDrained(
    clusterArn: string,
    serviceArn: string
  ): Promise<boolean> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AWS_ECS_SERVICE_DELETE_ATTEMPTS',
      180
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AWS_ECS_SERVICE_DELETE_DELAY_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const service = await this.client!.getService(clusterArn, serviceArn);
      if (
        !service
        || service.status === 'INACTIVE'
        || (
          service.desiredCount === 0
          && service.runningCount === 0
          && service.pendingCount === 0
        )
      ) {
        return true;
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    return false;
  }

  private async waitForServiceDeleted(
    clusterArn: string,
    serviceArn: string
  ): Promise<AwsService | null> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AWS_ECS_SERVICE_DELETE_ATTEMPTS',
      180
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AWS_ECS_SERVICE_DELETE_DELAY_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const service = await this.client!.getService(clusterArn, serviceArn);
      if (!service || service.status === 'INACTIVE') return null;
      if (attempt < attempts) await this.delay(delayMs);
    }
    return this.client!.getService(clusterArn, serviceArn);
  }

  private async deleteTaskDefinitionFamily(family: string): Promise<void> {
    const active = await this.client!.listTaskDefinitionArns(
      family,
      'ACTIVE'
    );
    for (const arn of active) {
      await this.client!.deregisterTaskDefinition(arn);
    }
    const inactive = await this.client!.listTaskDefinitionArns(
      family,
      'INACTIVE'
    );
    await this.client!.deleteTaskDefinitions(inactive);
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AWS_ECS_TASK_DEFINITION_DELETE_ATTEMPTS',
      180
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AWS_ECS_TASK_DEFINITION_DELETE_DELAY_MS',
      5000
    );
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const [remainingActive, remainingInactive, deleting] =
        await Promise.all([
          this.client!.listTaskDefinitionArns(family, 'ACTIVE'),
          this.client!.listTaskDefinitionArns(family, 'INACTIVE'),
          this.client!.listTaskDefinitionArns(
            family,
            'DELETE_IN_PROGRESS'
          ),
        ]);
      if (
        remainingActive.length === 0
        && remainingInactive.length === 0
        && deleting.length === 0
      ) {
        return;
      }
      if (attempt < attempts) await this.delay(delayMs);
    }
    throw new Error(
      `ECS task-definition family ${family} remained observable after ${attempts} terminal deletion checks.`
    );
  }

  private async runtimeStatus(
    service: AwsService,
    binding: EcsServiceBinding,
    observedTask?: TaskDefinition
  ): Promise<'running' | 'failed' | 'empty' | 'unknown'> {
    const task = observedTask ?? await this.requiredTaskDefinition(service);
    this.assertTaskBinding(task, binding);
    this.assertTaskConfiguration(task, binding);
    const container = this.primaryContainer(task, binding.containerName);
    const environment = container.environment ?? [];
    this.assertCompleteEnvironment(environment);
    const image = container.image;
    if (image === BOOTSTRAP_IMAGE) {
      if (
        service.desiredCount !== 0
        || (service.runningCount ?? 0) !== 0
        || (service.pendingCount ?? 0) !== 0
      ) {
        throw new Error(
          `ECS bootstrap service ${binding.serviceArn} must remain scaled to zero.`
        );
      }
      return 'empty';
    }
    if (!image || service.desiredCount !== 1) {
      throw new Error(
        `ECS service ${binding.serviceArn} must run exactly one task from an exact managed ECR digest.`
      );
    }
    const imagePrefix = `${this.client!.repositoryUri()}@`;
    const digest = image.startsWith(imagePrefix)
      ? image.slice(imagePrefix.length)
      : '';
    const markerDigest = this.environmentValue(
      environment,
      IMAGE_DIGEST_KEY
    );
    const markerSha = this.environmentValue(environment, DEPLOY_SHA_KEY);
    if (
      !/^sha256:[a-f0-9]{64}$/.test(digest)
      || markerDigest !== digest
      || !/^[a-f0-9]{40}$/.test(markerSha ?? '')
    ) {
      throw new Error(
        `ECS service ${binding.serviceArn} does not expose the exact managed image digest and Git SHA markers.`
      );
    }
    const primary = (service.deployments ?? []).find(
      (deployment) => deployment.status === 'PRIMARY'
    );
    if (primary?.rolloutState === 'FAILED') return 'failed';
    if (
      service.status === 'ACTIVE'
      && primary?.rolloutState === 'COMPLETED'
      && primary.taskDefinition === service.taskDefinition
      && (service.desiredCount ?? 0) > 0
      && service.runningCount === service.desiredCount
      && service.pendingCount === 0
    ) {
      return 'running';
    }
    return 'unknown';
  }

  private assertPublicPrerequisites(
    service: Service,
    workloadKind: Exclude<WorkloadKind, 'cron'>,
    prerequisites: AwsEcsPrerequisites
  ): void {
    if (!this.publicWeb(service, workloadKind)) return;
    if (
      !this.credentials?.targetGroupArn
      || !prerequisites.targetGroup
      || !prerequisites.loadBalancer
    ) {
      throw new Error(
        'Public AWS ECS web services require one verified, externally owned ALB targetGroupArn.'
      );
    }
    const healthPath = service.buildConfig.healthCheckPath?.trim();
    if (
      healthPath
      && prerequisites.targetGroup.HealthCheckPath !== healthPath
    ) {
      throw new Error(
        `External ALB target group ${this.credentials.targetGroupArn} uses health path ${prerequisites.targetGroup.HealthCheckPath ?? 'unknown'}, not the desired ${healthPath}. Update the external target group before apply.`
      );
    }
  }

  private async assertTargetGroupAvailable(
    _clusterArn: string,
    workloadKind: Exclude<WorkloadKind, 'cron'>,
    service: Service
  ): Promise<void> {
    if (!this.publicWeb(service, workloadKind)) return;
    const targetGroupArn = this.credentials!.targetGroupArn!;
    const clusters = await this.client!.listClusters();
    const services = (
      await Promise.all(
        clusters.flatMap((cluster) =>
          cluster.clusterArn
            ? [this.client!.listServices(cluster.clusterArn)]
            : []
        )
      )
    ).flat();
    const conflicts = services.filter((candidate) =>
      (candidate.loadBalancers ?? []).some(
        (loadBalancer) => loadBalancer.targetGroupArn === targetGroupArn
      )
    );
    if (conflicts.length > 0) {
      throw new Error(
        `External ALB target group ${targetGroupArn} is already attached to ECS services: ${conflicts.map((candidate) => candidate.serviceArn).join(', ')}. Hypervibe will not choose or reattach it implicitly.`
      );
    }
  }

  private assertServiceBinding(
    service: AwsService,
    binding: EcsServiceBinding,
    clusterArn: string
  ): void {
    const loadBalancers = service.loadBalancers ?? [];
    const expectedLoadBalancer = binding.targetGroupArn
      ? loadBalancers.length === 1
        && loadBalancers[0]?.targetGroupArn === binding.targetGroupArn
        && loadBalancers[0]?.containerName === binding.containerName
        && loadBalancers[0]?.containerPort
          === binding.containerPort
      : loadBalancers.length === 0;
    const network = service.networkConfiguration?.awsvpcConfiguration;
    const expectedNetwork = (
      network
      && this.sameStringSet(
        network.subnets ?? [],
        binding.subnetIds
      )
      && this.sameStringSet(
        network.securityGroups ?? [],
        binding.securityGroupIds
      )
      && network.assignPublicIp
        === (binding.assignPublicIp ? 'ENABLED' : 'DISABLED')
    );
    if (
      service.serviceArn !== binding.serviceArn
      || service.clusterArn !== clusterArn
      || !expectedLoadBalancer
      || !expectedNetwork
    ) {
      throw new Error(
        `ECS service ${binding.serviceArn} does not match its applied durable binding and network scope.`
      );
    }
  }

  private assertDesiredBinding(
    binding: EcsServiceBinding,
    service: Service,
    workloadKind: Exclude<WorkloadKind, 'cron'>
  ): void {
    const desiredPublic = this.publicWeb(service, workloadKind);
    if (
      binding.workloadKind !== workloadKind
      || Boolean(binding.targetGroupArn) !== desiredPublic
      || (
        desiredPublic
        && binding.targetGroupArn !== this.credentials!.targetGroupArn
      )
      || (desiredPublic && !binding.url)
      || binding.executionRoleArn !== this.credentials!.executionRoleArn
      || binding.taskRoleArn !== this.credentials!.taskRoleArn
      || binding.cpu !== this.credentials!.cpu
      || binding.memory !== this.credentials!.memory
      || binding.containerPort !== this.credentials!.containerPort
      || binding.assignPublicIp !== this.credentials!.assignPublicIp
      || !this.sameStringSet(
        binding.subnetIds,
        this.credentials!.subnetIds
      )
      || !this.sameStringSet(
        binding.securityGroupIds,
        this.credentials!.securityGroupIds
      )
    ) {
      throw new Error(
        `ECS service ${binding.serviceArn} requires explicit replacement because its workload, public routing, IAM role, Fargate size, port, or network binding changed.`
      );
    }
  }

  private assertTaskBinding(
    task: TaskDefinition,
    binding: EcsServiceBinding
  ): void {
    const match = task.taskDefinitionArn?.match(
      /^arn:aws:ecs:([a-z0-9-]+):(\d{12}):task-definition\/([^:]+):\d+$/
    );
    if (
      !match
      || match[1] !== this.credentials!.region
      || match[2] !== this.client!.accountId()
      || match[3] !== binding.taskFamily
      || task.family !== binding.taskFamily
    ) {
      throw new Error(
        `ECS task definition ${task.taskDefinitionArn ?? 'unknown'} does not match bound family ${binding.taskFamily}.`
      );
    }
  }

  private assertTaskConfiguration(
    task: TaskDefinition,
    binding: EcsServiceBinding
  ): void {
    const compatibilities = task.requiresCompatibilities ?? [];
    const container = this.primaryContainer(task, binding.containerName);
    const portMappings = container.portMappings ?? [];
    const bootstrap = container.image === BOOTSTRAP_IMAGE;
    const expectedCommand = (
      container.entryPoint?.length === 2
      && container.entryPoint[0] === '/bin/sh'
      && container.entryPoint[1] === '-lc'
      && container.command?.length === 1
      && container.command[0] === (
        bootstrap
          ? 'while true; do sleep 3600; done'
          : 'exec sh -lc "$HYPERVIBE_START_COMMAND"'
      )
    );
    const expectedPorts = binding.workloadKind === 'web'
      ? portMappings.length === 1
        && portMappings[0]?.containerPort === binding.containerPort
        && portMappings[0]?.hostPort === binding.containerPort
        && portMappings[0]?.protocol === 'tcp'
      : portMappings.length === 0;
    if (
      task.status !== 'ACTIVE'
      || task.networkMode !== 'awsvpc'
      || compatibilities.length !== 1
      || compatibilities[0] !== 'FARGATE'
      || task.executionRoleArn !== binding.executionRoleArn
      || task.taskRoleArn !== binding.taskRoleArn
      || task.cpu !== binding.cpu
      || task.memory !== binding.memory
      || task.runtimePlatform?.cpuArchitecture !== 'X86_64'
      || task.runtimePlatform?.operatingSystemFamily !== 'LINUX'
      || (task.containerDefinitions ?? []).length !== 1
      || (task.volumes ?? []).length !== 0
      || (task.placementConstraints ?? []).length !== 0
      || task.proxyConfiguration !== undefined
      || (task.inferenceAccelerators ?? []).length !== 0
      || task.ephemeralStorage !== undefined
      || container.essential !== true
      || (container.secrets ?? []).length !== 0
      || (container.mountPoints ?? []).length !== 0
      || (container.volumesFrom ?? []).length !== 0
      || !expectedPorts
      || !expectedCommand
    ) {
      throw new Error(
        `ECS task definition ${task.taskDefinitionArn} drifted outside the applied Fargate, IAM role, runtime, or port scope.`
      );
    }
  }

  private assertBindingCluster(
    binding: EcsServiceBinding,
    clusterArn: string
  ): void {
    if (this.clusterArnFromServiceArn(binding.serviceArn) !== clusterArn) {
      throw new Error(
        `ECS service ${binding.serviceArn} is outside bound cluster ${clusterArn}.`
      );
    }
  }

  private clusterName(environment: Environment): string {
    return `hv-${this.hash(environment.projectId, 8)}-${this.hash(environment.name, 8)}`;
  }

  private serviceName(
    environment: Environment,
    serviceName: string
  ): string {
    return `hv-${this.hash(environment.projectId, 7)}-${this.hash(environment.name, 6)}-${this.hash(serviceName, 8)}`;
  }

  private taskFamily(
    environment: Environment,
    serviceName: string
  ): string {
    return this.serviceName(environment, serviceName);
  }

  private containerName(serviceName: string): string {
    const value = serviceName
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64);
    return value || `hv-${this.hash(serviceName, 8)}`;
  }

  private clusterArn(clusterName: string): string {
    return `arn:aws:ecs:${this.credentials!.region}:${this.client!.accountId()}:cluster/${clusterName}`;
  }

  private serviceArn(clusterArn: string, serviceName: string): string {
    const clusterName = clusterArn.split(':cluster/')[1];
    if (!clusterName) throw new Error(`Invalid ECS cluster ARN ${clusterArn}.`);
    return `arn:aws:ecs:${this.credentials!.region}:${this.client!.accountId()}:service/${clusterName}/${serviceName}`;
  }

  private clusterArnFromServiceArn(serviceArn: string): string {
    const match = serviceArn.match(
      /^arn:aws:ecs:([a-z0-9-]+):(\d{12}):service\/([^/]+)\/[^/]+$/
    );
    if (!match) throw new Error(`Invalid long-form ECS service ARN ${serviceArn}.`);
    return `arn:aws:ecs:${match[1]}:${match[2]}:cluster/${match[3]}`;
  }

  private serviceBinding(binding: EcsServiceBinding): string {
    return `${BINDING_PREFIX}${Buffer.from(
      JSON.stringify(binding),
      'utf8'
    ).toString('base64url')}`;
  }

  private parseServiceBinding(value: string): EcsServiceBinding {
    if (!value.startsWith(BINDING_PREFIX)) {
      throw new Error('Invalid AWS ECS service binding version.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        Buffer.from(value.slice(BINDING_PREFIX.length), 'base64url')
          .toString('utf8')
      );
    } catch {
      throw new Error('Invalid AWS ECS service binding encoding.');
    }
    if (
      !parsed
      || typeof parsed !== 'object'
      || (parsed as { version?: unknown }).version !== 1
      || typeof (parsed as { serviceArn?: unknown }).serviceArn !== 'string'
      || typeof (parsed as { taskFamily?: unknown }).taskFamily !== 'string'
      || typeof (parsed as { containerName?: unknown }).containerName !== 'string'
      || typeof (parsed as { executionRoleArn?: unknown }).executionRoleArn
        !== 'string'
      || (
        (parsed as { taskRoleArn?: unknown }).taskRoleArn !== undefined
        && typeof (parsed as { taskRoleArn?: unknown }).taskRoleArn !== 'string'
      )
      || typeof (parsed as { cpu?: unknown }).cpu !== 'string'
      || typeof (parsed as { memory?: unknown }).memory !== 'string'
      || !Number.isInteger(
        (parsed as { containerPort?: unknown }).containerPort
      )
      || !Array.isArray((parsed as { subnetIds?: unknown }).subnetIds)
      || !Array.isArray(
        (parsed as { securityGroupIds?: unknown }).securityGroupIds
      )
      || typeof (parsed as { assignPublicIp?: unknown }).assignPublicIp
        !== 'boolean'
      || !['web', 'worker'].includes(
        String((parsed as { workloadKind?: unknown }).workloadKind)
      )
      || (
        (parsed as { targetGroupArn?: unknown }).targetGroupArn !== undefined
        && typeof (parsed as { targetGroupArn?: unknown }).targetGroupArn
          !== 'string'
      )
      || (
        (parsed as { url?: unknown }).url !== undefined
        && (
          typeof (parsed as { url?: unknown }).url !== 'string'
          || !/^https?:\/\/[^/]+$/.test(
            (parsed as { url: string }).url
          )
        )
      )
    ) {
      throw new Error('Invalid AWS ECS service binding fields.');
    }
    const binding = parsed as EcsServiceBinding;
    if (
      !/^[A-Za-z0-9_-]+$/.test(binding.taskFamily)
      || !/^[A-Za-z0-9_-]+$/.test(binding.containerName)
      || !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(
        binding.executionRoleArn
      )
      || (
        binding.taskRoleArn
        && !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(
          binding.taskRoleArn
        )
      )
      || !/^\d+$/.test(binding.cpu)
      || !/^\d+$/.test(binding.memory)
      || binding.containerPort < 1
      || binding.containerPort > 65535
      || binding.subnetIds.length < 1
      || binding.subnetIds.length > 16
      || binding.securityGroupIds.length < 1
      || binding.securityGroupIds.length > 5
      || binding.subnetIds.some(
        (id) => typeof id !== 'string' || !/^subnet-[a-f0-9]+$/.test(id)
      )
      || binding.securityGroupIds.some(
        (id) => typeof id !== 'string' || !/^sg-[a-f0-9]+$/.test(id)
      )
      || new Set(binding.subnetIds).size !== binding.subnetIds.length
      || new Set(binding.securityGroupIds).size
        !== binding.securityGroupIds.length
      || Boolean(binding.targetGroupArn) !== Boolean(binding.url)
      || (
        binding.workloadKind === 'worker'
        && (
          binding.targetGroupArn !== undefined
          || binding.url !== undefined
        )
      )
    ) {
      throw new Error('Invalid AWS ECS service task/container identity.');
    }
    this.clusterArnFromServiceArn(binding.serviceArn);
    return binding;
  }

  private environmentTags(
    environment: Environment
  ): Array<{ key: string; value: string }> {
    return [
      { key: 'hypervibe-managed', value: 'true' },
      { key: 'hypervibe-project-id', value: environment.projectId },
      { key: 'hypervibe-environment', value: environment.name },
    ];
  }

  private serviceTags(
    environment: Environment,
    service: Service,
    workloadKind: Exclude<WorkloadKind, 'cron'>
  ): Array<{ key: string; value: string }> {
    return [
      ...this.environmentTags(environment),
      { key: 'hypervibe-service', value: service.name },
      { key: 'hypervibe-workload-kind', value: workloadKind },
    ];
  }

  private publicWeb(
    service: Service,
    workloadKind: Exclude<WorkloadKind, 'cron'>
  ): boolean {
    return (
      workloadKind === 'web'
      && service.buildConfig.public !== false
    );
  }

  private publicUrl(
    service: Service,
    workloadKind: Exclude<WorkloadKind, 'cron'>,
    prerequisites: AwsEcsPrerequisites
  ): string | undefined {
    return this.publicWeb(service, workloadKind)
      ? this.prerequisiteUrl(prerequisites)
      : undefined;
  }

  private prerequisiteUrl(
    prerequisites: AwsEcsPrerequisites
  ): string | undefined {
    return prerequisites.publicUrl;
  }

  private environmentValue(
    environment: KeyValuePair[],
    name: string
  ): string | undefined {
    return environment.find((entry) => entry.name === name)?.value;
  }

  private assertCompleteEnvironment(environment: KeyValuePair[]): void {
    if (environment.some(
      (entry) =>
        typeof entry.name !== 'string'
        || typeof entry.value !== 'string'
    )) {
      throw new Error(
        'AWS returned an incomplete ECS task environment; Hypervibe preserved state instead of treating missing values as absent.'
      );
    }
    const names = environment.map((entry) => entry.name!);
    if (new Set(names).size !== names.length) {
      throw new Error(
        'AWS returned duplicate ECS task environment names; Hypervibe refused to choose one.'
      );
    }
  }

  private sameStringSet(left: string[], right: string[]): boolean {
    return (
      left.length === right.length
      && new Set(left).size === left.length
      && left.every((value) => right.includes(value))
    );
  }

  private requiredStartCommand(service: Service): string {
    const command = service.buildConfig.startCommand?.trim();
    if (!command) {
      throw new Error(
        `AWS ECS service ${service.name} requires startCommand.`
      );
    }
    return command;
  }

  private nonCronWorkloadKind(
    service: Service
  ): Exclude<WorkloadKind, 'cron'> {
    const kind = serviceWorkloadKind(service);
    if (kind === 'cron') {
      throw new Error(
        'Amazon ECS scheduled tasks require a separate EventBridge lifecycle adapter.'
      );
    }
    return kind;
  }

  private emptyObservation(projectExists: boolean): ObservedState {
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists,
      services: [],
      databases: [],
      caches: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'unknown',
        caches: 'unknown',
        storage: 'complete',
      },
      partial: false,
      warnings: [],
    };
  }

  private failedDeploy(
    service: Service,
    error: string,
    mutation?: ServiceMutation
  ): DeployResult {
    return {
      serviceId: service.id,
      ...(mutation ? { externalId: mutation.binding } : {}),
      status: 'failed',
      receipt: {
        success: false,
        message: `AWS ECS deployment failed for ${service.name}`,
        error,
        ...(mutation
          ? {
              data: {
                ecsServiceArn: mutation.serviceArn,
                createdService: mutation.createdService,
                mutationAttempted: true,
                ...(mutation.taskDefinitionArn
                  ? { taskDefinitionArn: mutation.taskDefinitionArn }
                  : {}),
              },
            }
          : {}),
      },
    };
  }

  private hash(value: string, length: number): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

providerRegistry.register({
  metadata: {
    name: 'ecs',
    displayName: 'AWS ECS on Fargate',
    category: 'deployment',
    credentialsSchema: EcsCredentialsSchema,
    setupHelpUrl:
      'https://console.aws.amazon.com/iam/home#/security_credentials',
    lifecycle: {
      hosting: { customDomains: 'unsupported' },
    },
    orchestration: {
      project: { shareAcrossEnvironments: false },
      diff: {
        requiresBranchDeployForCode: false,
        serviceCreatesBillable: true,
      },
      ci: {
        displayName: 'AWS ECS on Fargate',
        requiredSecrets: AWS_ECS_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          AWS_ACCESS_KEY_ID: 'accessKeyId',
          AWS_SECRET_ACCESS_KEY: 'secretAccessKey',
          AWS_REGION: 'region',
          AWS_ECR_REPOSITORY_URI: 'ecrRepositoryUri',
        },
        buildGitHubActionsSteps: buildAwsEcsGitHubActionsSteps,
      },
    },
  },
  factory: (credentials) => {
    const validated = EcsCredentialsSchema.parse(credentials);
    const adapter = new EcsFargateAdapter();
    void adapter.connect(validated);
    return adapter;
  },
});
