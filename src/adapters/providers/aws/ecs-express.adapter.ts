import type { ProviderEnvironmentVariablesRequest, ProviderEnvironmentVariablesResult } from '../../../domain/ports/provider-env-vars.port.js';
import { createEcsRegistryCredentialLifecycle } from './ecs-registry-credential.js';
import { AwsSecretsAdapter } from '../secretmanagers/aws-secrets.adapter.js';
import { createHash } from 'node:crypto';
import { ecsTaskDefinitionWriter } from './ecs-task-definition-writer.js';
import { ecsCurrentConfiguration, ecsTaskDefinitionInput, ecsVolumeFingerprint } from './ecs-volume-runtime.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import {
  DescribeClustersCommand,
  DescribeExpressGatewayServiceCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  UpdateExpressGatewayServiceCommand,
  RegisterTaskDefinitionCommand,
  type ECSExpressGatewayService,
  type ExpressGatewayServiceConfiguration,
  type TaskDefinition,
  type UpdateExpressGatewayServiceRequest,
  type KeyValuePair,
} from '@aws-sdk/client-ecs';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import {
  type Service,
} from '../../../domain/entities/service.entity.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import {
  hashEnvValue,
  type ObservedService,
  type ObservedState,
} from '../../../domain/ports/observe.port.js';
import type {
  DeploymentMutationOptions,
  IProviderAdapter,
  ProviderCapabilities,
  Receipt,
  VerifyResult,
} from '../../../domain/ports/provider.port.js';
import { providerRegistry, type ProviderInspectionRequest } from '../../../domain/registry/provider.registry.js';
import { HYPERVIBE_MANAGED_NODE_VERSION } from '../../../domain/services/managed-runtime.js';
import { environmentForInspection } from '../../../domain/registry/provider-inspection.js';
import {
  buildEcsExpressGitHubActionsSteps,
  ECS_EXPRESS_CI_REQUIRED_SECRETS,
} from './ecs-express-ci.workflow.js';

const BOOTSTRAP_IMAGE = `public.ecr.aws/docker/library/node:${HYPERVIBE_MANAGED_NODE_VERSION}-alpine`;
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

const EcsExpressAuthenticationSchema = z.object({
  accessKeyId: z.string().trim().min(16, 'AWS access key ID is required'),
  secretAccessKey: z.string().min(32, 'AWS secret access key is required'),
}).strict();

export const EcsExpressCredentialsSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { region: _legacyRegion, ...authentication } = input as Record<string, unknown>;
  return authentication;
}, EcsExpressAuthenticationSchema);

export type EcsExpressCredentials = z.infer<typeof EcsExpressCredentialsSchema>;

const DEFAULT_ECS_REGION = 'us-west-2';
const EcsRegionSchema = z.string().trim().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, 'AWS region is invalid');
type ConnectedEcsExpressCredentials = EcsExpressCredentials & { region: string };

type AwsClients = { ecs: ECSClient; sts: STSClient; };




export class EcsExpressAdapter implements IProviderAdapter {
  readonly name = 'ecs';
  readonly registryCredentialLifecycle = createEcsRegistryCredentialLifecycle(async (environment, service) => {
    const binding = parseHostingBindings(environment); const arn = binding.services?.[service]?.serviceId;
    if (binding.provider !== this.name || !binding.projectId || binding.environmentId !== binding.projectId || !arn) throw new Error();
    const identity = this.parseClusterArn(binding.projectId);
    if (await this.resolveAccountId() !== identity.accountId) throw new Error();
    const current = await this.getExpressService(arn);
    if (!current) throw new Error();
    this.assertExpressScope(current, binding.projectId, arn, environment.id);
    const runtime = await this.runtimeConfiguration(this.currentConfiguration(current), arn);
    const credentialReference = runtime.container.repositoryCredentials?.credentialsParameter;
    const { credentials } = this.connected();
    if (!runtime.container.image || typeof credentialReference !== 'string'
      || !credentialReference.startsWith(`arn:aws:secretsmanager:${credentials.region}:${identity.accountId}:secret:`)) throw new Error();
    return { provider: this.name, projectId: binding.projectId, environmentId: binding.projectId, serviceId: arn, instanceId: arn,
      image: runtime.container.image, credentialReference, registry: runtime.container.image.split('/')[0]!, activation: 'deferred' };
  }, async () => {
    const { credentials } = this.connected();
    const secrets = new AwsSecretsAdapter();
    await secrets.connect({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, region: credentials.region });
    return secrets;
  });

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [],
    supportsAutoWiring: false,
    supportsHealthChecks: true,
    supportsCronSchedule: false,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false,
    managedTls: true,
    supportsObserve: true,
    credentialUpdateActivation: 'provider-rollout',
    credentialValueEvidence: 'readback',
  };

  private credentials: ConnectedEcsExpressCredentials | null = null;
  private clients: AwsClients | null = null;
  private accountId: string | null = null;

  async connect(credentials: unknown): Promise<void> {
    const parsed = EcsExpressCredentialsSchema.parse(credentials);
    const legacyRegion = credentials && typeof credentials === 'object' && typeof (credentials as Record<string, unknown>).region === 'string'
      ? (credentials as Record<string, string>).region
      : DEFAULT_ECS_REGION;
    this.credentials = { ...parsed, region: EcsRegionSchema.parse(legacyRegion) };
    this.replaceClients();
  }

  configureTarget(target: { region?: string }): void {
    if (!target.region) return;
    const credentials = this.connected().credentials;
    const region = EcsRegionSchema.parse(target.region);
    if (region === credentials.region) return;
    this.credentials = { ...credentials, region };
    this.accountId = null;
    this.replaceClients();
  }

  private replaceClients(): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    for (const client of Object.values(this.clients ?? {})) client.destroy();
    const config = {
      region: this.credentials.region,
      credentials: {
        accessKeyId: this.credentials.accessKeyId,
        secretAccessKey: this.credentials.secretAccessKey,
      },
    };
    this.clients = {
      ecs: new ECSClient(config),
      sts: new STSClient(config),
    };
  }

  async verify(): Promise<VerifyResult> {
    try {
      const { clients, credentials } = this.connected();
      const [identity] = await Promise.all([
        clients.sts.send(new GetCallerIdentityCommand({})),
        clients.ecs.send(new ListClustersCommand({ maxResults: 1 })),
      ]);
      if (!identity.Account || !/^\d{12}$/.test(identity.Account)) {
        return { success: false, error: 'AWS did not return a valid account identity.' };
      }
      this.accountId = identity.Account;
      return {
        success: true,
        email: `AWS account ${identity.Account} (${credentials.region})`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    for (const client of Object.values(this.clients ?? {})) client.destroy();
    this.clients = null;
    this.credentials = null;
    this.accountId = null;
  }

  async readProviderEnvironmentVariables(request: ProviderEnvironmentVariablesRequest): Promise<ProviderEnvironmentVariablesResult> {
    try {
      const binding = parseHostingBindings(request.environment);
      const arn = binding.services?.[request.service.name]?.serviceId;
      if (binding.provider !== this.name || !binding.projectId || !arn) throw new Error();
      this.parseClusterArn(binding.projectId);
      const current = await this.getExpressService(arn);
      if (!current) throw new Error();
      this.assertExpressScope(current, binding.projectId, arn, request.environment.id);
      const config = this.currentConfiguration(current);
      const runtime = await this.runtimeConfiguration(config, arn);
      if (!config || !runtime.container?.image) throw new Error();
      const entries = runtime.container.environment ?? [];
      const references = runtime.container.secrets ?? [];
      if (!Array.isArray(entries) || !Array.isArray(references) || [...entries, ...references].some(entry => typeof entry.name !== 'string')
        || new Set([...entries, ...references].map(entry => entry.name)).size !== entries.length + references.length) throw new Error();
      const variables = Object.fromEntries(entries.filter(entry => typeof entry.value === 'string').map(entry => [entry.name!, entry.value!]));
      const unresolvedKeys = [...references.map(entry => entry.name!), ...entries.filter(entry => typeof entry.value !== 'string').map(entry => entry.name!)].sort();
      return { success: true, variables, ...(unresolvedKeys.length ? { unresolvedKeys } : {}) };
    } catch { return { success: false, error: 'Exact ECS service configuration could not be verified.' }; }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    if (options.requireCredentialUpdate) {
      let attempted = false;
      try {
        const binding = parseHostingBindings(environment);
        const arn = binding.services?.[service.name]?.serviceId;
        if (binding.provider !== this.name || !binding.projectId || !arn) throw new Error();
        this.parseClusterArn(binding.projectId);
        const current = await this.getExpressService(arn);
        if (!current) throw new Error();
        this.assertExpressScope(current, binding.projectId, arn, environment.id);
        const config = this.currentConfiguration(current);
        const runtime = await this.runtimeConfiguration(config, arn);
        if (!config || !runtime.container?.image) throw new Error();
        const existing = runtime.container.environment ?? [];
        if (!Array.isArray(existing) || existing.some((entry: any) => typeof entry.name !== 'string') || new Set(existing.map((entry: any) => entry.name)).size !== existing.length) throw new Error();
        const remaining = new Map(Object.entries(vars));
        const values = existing.map((entry: any) => {
          if (!remaining.has(entry.name)) return entry;
          const value = remaining.get(entry.name); remaining.delete(entry.name);
          return { name: entry.name, value };
        }).concat([...remaining].map(([name, value]) => ({ name, value })));
        // A selected literal replaces only its own native secret reference.
        const secrets = (runtime.container.secrets ?? []).filter((entry: any) => !Object.hasOwn(vars, entry.name));
        attempted = true;
        const changed = await this.updateRuntimeConfiguration(arn, config, { environment: values, ...(runtime.container.secrets ? { secrets } : {}) }, { serviceArn: arn });
        const after = await this.waitForExpress(arn, runtime.container.image, current.currentDeployment, changed.taskDefinitionArn, runtime.task?.taskRoleArn ?? config.taskRoleArn ?? null);
        this.assertExpressScope(after, binding.projectId, arn, environment.id);
        const actual = await this.runtimeConfiguration(this.currentConfiguration(after), arn);
        const readback = new Map((actual.container.environment ?? []).map((entry: any) => [entry.name, entry.value]));
        if (Object.entries(vars).some(([key, value]) => readback.get(key) !== value)) throw new Error();
        return { success: true, message: 'Selected ECS credential configuration verified; native rolling deployment initiated.', data: {
          serviceId: arn, credentialValueEvidence: 'readback', credentialUpdateActivation: 'provider-rollout', configurationUpdated: true, runtimeRolloutRequired: true,
          rolloutBaseline: current.currentDeployment ? { state: 'present', deploymentId: current.currentDeployment } : { state: 'unknown' },
          deploymentId: after.currentDeployment, mutationAttempted: true,
        } };
      } catch { return { success: false, message: attempted ? 'ECS credential write requires readback recovery.' : 'Exact ECS credential target could not be verified; no write attempted.', data: { mutationAttempted: attempted } }; }
    }
    return { success: false, message: 'Only reviewed credential updates are available for existing workloads. Resource configuration is moving to OpenTofu.' };
  }

  async observe(environment: Environment): Promise<ObservedState> {
    const bindings = parseHostingBindings(environment);
    if (!bindings.projectId) return this.emptyObservation(false);
    const cluster = await this.getCluster(bindings.projectId);
    if (!cluster || cluster.status === 'INACTIVE') {
      return {
        ...this.emptyObservation(false),
        projectId: bindings.projectId,
        environmentId: bindings.environmentId,
      };
    }
    const identity = this.parseClusterArn(bindings.projectId);
    if (identity.accountId !== await this.resolveAccountId()) throw new Error('Bound ECS cluster belongs to a different AWS account.');
    const projectReady = this.hasManagedTags(cluster.tags, environment.id);
    const services: ObservedService[] = [];
    for (const [name, binding] of Object.entries(bindings.services ?? {})) {
      if (!binding.serviceId) continue;
      const express = await this.getExpressService(binding.serviceId);
      if (!express) continue;
      this.assertExpressScope(express, bindings.projectId, binding.serviceId, environment.id);
      const config = this.currentConfiguration(express);
      const runtime = await this.runtimeConfiguration(config, binding.serviceId);
      const environmentValues: KeyValuePair[] = runtime.container.environment ?? [];
      const values = Object.fromEntries(
        environmentValues
          .filter((item): item is { name: string; value: string } => Boolean(item.name) && typeof item.value === 'string')
          .map((item) => [item.name, item.value])
      );
      const visible = Object.entries(values).filter(([key]) => !INTERNAL_ENV_KEYS.has(key));
      services.push({
        name,
        externalId: binding.serviceId,
        workloadKind: 'web',
        customDomains: binding.customDomains ?? [],
        ...(this.expressUrl(express) ? { url: this.expressUrl(express) } : {}),
        config: {
          ...(values[START_COMMAND_KEY] ? { startCommand: values[START_COMMAND_KEY] } : {}),
          ...(values[HEALTH_CHECK_PATH_KEY] ? { healthCheckPath: values[HEALTH_CHECK_PATH_KEY] } : {}),
          public: true,
        },
        sourceState: 'disconnected',
        envVarKeys: [...new Set([...visible.map(([key]) => key), ...(runtime.container.secrets ?? []).map((entry: { name?: string }) => entry.name).filter((key: unknown): key is string => typeof key === 'string' && !INTERNAL_ENV_KEYS.has(key))])].sort(),
        envVarState: (runtime.container.secrets?.length ?? 0) > 0 ? 'unknown' : 'resolved',
        envVarHashes: Object.fromEntries(visible.map(([key, value]) => [key, hashEnvValue(value)])),
        ...(express.currentDeployment ? { deployment: {
          id: express.currentDeployment, status: express.status?.statusCode,
          ...(Array.isArray(express.activeConfigurations) && express.activeConfigurations.every(configuration => typeof configuration.serviceRevisionArn === 'string' && configuration.serviceRevisionArn.length > 0)
            ? { activeDeploymentIds: [...new Set(express.activeConfigurations.map(configuration => configuration.serviceRevisionArn!))].sort(), activeDeploymentCoverage: 'traffic' as const } : {}),
          envVarHashes: Object.fromEntries(visible.map(([key, value]) => [key, hashEnvValue(value)])),
          configurationState: (runtime.container.secrets?.length ?? 0) > 0 ? 'unknown' as const : 'resolved' as const,
        } } : {}),
        status: express.status?.statusCode === 'ACTIVE'
          ? (runtime.container.image === BOOTSTRAP_IMAGE ? 'empty' : 'running')
          : express.status?.statusCode === 'INACTIVE' ? 'failed' : 'unknown',
      });
    }
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: projectReady,
      projectId: bindings.projectId,
      environmentId: bindings.environmentId ?? bindings.projectId,
      services,
      databases: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: 'complete',
        databases: 'complete',
      },
      partial: false,
      warnings: projectReady ? [] : ['The bound ECS cluster does not have this environment’s ownership tags.'],
    };
  }

  async inspectEnvironmentResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const environment = environmentForInspection(request);
    const bindings = parseHostingBindings(environment);
    const accountId = await this.resolveAccountId();
    const candidates = bindings.projectId ? [] : await this.findClusterArns([
      this.clusterName(request.project!.name, environment), this.legacyClusterName(request.project!.name, environment),
    ]);
    if (candidates.length > 1) throw new Error('Multiple current/legacy ECS environment candidates require explicit identity selection.');
    const clusterArn = bindings.projectId ?? candidates[0]
      ?? `arn:aws:ecs:${this.connected().credentials.region}:${accountId}:cluster/${this.clusterName(request.project!.name, environment)}`;
    const cluster = await this.getCluster(clusterArn);
    if (!cluster) {
      return {
        observation: 'absent',
        resource: 'environment',
        project: { id: clusterArn },
        environment: { name: environment.name, region: this.connected().credentials.region },
        services: [],
      };
    }
    const serviceArns = await this.listServiceArns(clusterArn);
    const services = (await Promise.all(serviceArns.slice(0, request.limit).map(async (serviceArn) => {
      const service = await this.getExpressService(serviceArn);
      return {
        id: serviceArn,
        name: serviceArn.split('/').pop() ?? serviceArn,
        workloadKind: 'web',
        resourceType: 'express-service',
        managedByHypervibe: Boolean(service && this.hasManagedTag(service.tags)),
        status: service?.status?.statusCode ?? null,
      };
    })));
    return {
      observation: 'present',
      resource: 'environment',
      project: { id: clusterArn },
      environment: { name: environment.name, region: this.connected().credentials.region },
      services,
      managedByHypervibe: this.hasManagedTag(cluster.tags),
      partial: serviceArns.length > request.limit,
    };
  }

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    const identity = await this.connected().clients.sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account || !/^\d{12}$/.test(identity.Account)) {
      throw new Error('AWS did not return a valid account identity.');
    }
    this.accountId = identity.Account;
    return identity.Account;
  }

  private connected(): { clients: AwsClients; credentials: ConnectedEcsExpressCredentials } {
    if (!this.clients || !this.credentials) throw new Error('Not connected. Call connect() first.');
    return { clients: this.clients, credentials: this.credentials };
  }

  private clusterName(_projectName: string, environment: Environment): string {
    // Bound cluster names also seed IAM names; retain the scope discriminator
    // inside their shortest prefix limit instead of truncating it downstream.
    return resourceName(environment.name, { maxLength: 42, scope: [environment.projectId] });
  }

  private legacyClusterName(projectName: string, environment: Environment): string {
    return this.safeName(`hv-${projectName}-${environment.name}`, 44, `${environment.projectId}:${environment.name}`);
  }

  private safeName(value: string, prefixLength: number, salt: string): string {
    const prefix = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, prefixLength) || 'hypervibe';
    return `${prefix}-${this.hash(salt).slice(0, 10)}`;
  }

  private parseClusterArn(value: string): { accountId: string; clusterName: string } {
    const match = value.match(/^arn:aws(?:-[a-z]+)?:ecs:([^:]+):(\d{12}):cluster\/([A-Za-z0-9_-]+)$/);
    if (!match || match[1] !== this.connected().credentials.region) {
      throw new Error(`Invalid or cross-region ECS cluster ARN: ${value}`);
    }
    return { accountId: match[2]!, clusterName: match[3]! };
  }

  private hasManagedTags(
    tags: Array<{ key?: string; value?: string; Key?: string; Value?: string }> | undefined,
    environmentId: string
  ): boolean {
    const values = new Map((tags ?? []).map((tag) => [tag.key ?? tag.Key, tag.value ?? tag.Value]));
    return values.get('managed-by') === 'hypervibe'
      && values.get('hypervibe-environment-id') === environmentId;
  }

  private hasManagedTag(
    tags: Array<{ key?: string; value?: string; Key?: string; Value?: string }> | undefined
  ): boolean {
    return (tags ?? []).some((tag) => (tag.key ?? tag.Key) === 'managed-by'
      && (tag.value ?? tag.Value) === 'hypervibe');
  }

  private async getCluster(clusterArn: string) {
    const output = await this.connected().clients.ecs.send(new DescribeClustersCommand({ clusters: [clusterArn], include: ['TAGS'] }));
    const failures = (output.failures ?? []).filter(
      (failure) => failure.arn === clusterArn
    );
    if (failures.length > 1) {
      throw new Error(`AWS returned duplicate failures for ECS cluster ${clusterArn}.`);
    }
    if (failures.length === 1) {
      const failure = failures[0]!;
      if (failure.reason === 'MISSING') return null;
      throw new Error(
        `AWS ECS cluster observation failed for ${clusterArn}: ${failure.reason ?? 'unknown failure'}${failure.detail ? ` (${failure.detail})` : ''}.`
      );
    }
    const clusters = output.clusters ?? [];
    if (clusters.length > 1) {
      throw new Error(`AWS returned duplicate ECS cluster identity ${clusterArn}.`);
    }
    const cluster = clusters[0];
    if (!cluster) {
      throw new Error(
        `AWS returned neither ECS cluster ${clusterArn} nor a provider-confirmed MISSING failure.`
      );
    }
    if (cluster.clusterArn !== clusterArn) {
      throw new Error(
        `AWS returned ECS cluster ${cluster.clusterArn ?? 'without an ARN'} when ${clusterArn} was requested.`
      );
    }
    return cluster;
  }

  private async findClusterArns(names: string | string[]): Promise<string[]> {
    const candidates = Array.isArray(names) ? names : [names];
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const output = await this.connected().clients.ecs.send(new ListClustersCommand({ nextToken, maxResults: 100 }));
      if (!Array.isArray(output.clusterArns)) {
        throw new Error('AWS ECS cluster observation returned an invalid cluster list.');
      }
      arns.push(...output.clusterArns.filter((arn) => candidates.includes(arn.split('/').at(-1)!)));
      nextToken = output.nextToken;
    } while (nextToken);
    return arns.sort();
  }

  private async listServiceArns(clusterArn: string): Promise<string[]> {
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const output = await this.connected().clients.ecs.send(new ListServicesCommand({ cluster: clusterArn, nextToken, maxResults: 100 }));
      if (!Array.isArray(output.serviceArns)) {
        throw new Error(`AWS ECS service observation returned an invalid service list for ${clusterArn}.`);
      }
      arns.push(...output.serviceArns);
      nextToken = output.nextToken;
    } while (nextToken);
    return arns.sort();
  }

  private async getExpressService(serviceArn: string): Promise<ECSExpressGatewayService | null> {
    try {
      const service = (await this.connected().clients.ecs.send(
        new DescribeExpressGatewayServiceCommand({ serviceArn, include: ['TAGS'] })
      )).service;
      if (!service) {
        throw new Error(
          `AWS returned no ECS Express service and no not-found error for ${serviceArn}.`
        );
      }
      if (service.serviceArn !== serviceArn) {
        throw new Error(
          `AWS returned ECS Express service ${service.serviceArn ?? 'without an ARN'} when ${serviceArn} was requested.`
        );
      }
      return service;
    } catch (error) {
      if (this.hasErrorName(error, 'ResourceNotFoundException', 'ServiceNotFoundException', 'ClusterNotFoundException')) return null;
      throw error;
    }
  }

  private assertExpressScope(
    service: ECSExpressGatewayService,
    clusterArn: string,
    serviceArn: string,
    environmentId?: string
  ): void {
    if (service.serviceArn !== serviceArn || service.cluster !== clusterArn) {
      throw new Error(`ECS Express service ${serviceArn} resolved outside bound cluster ${clusterArn}.`);
    }
    if (!this.hasManagedTag(service.tags)
      || (environmentId && !this.hasManagedTags(service.tags, environmentId))) {
      throw new Error(`ECS Express service ${serviceArn} is not owned by this Hypervibe environment.`);
    }
  }

  private currentConfiguration(service: ECSExpressGatewayService): ExpressGatewayServiceConfiguration | undefined {
    return ecsCurrentConfiguration(service);
  }

  private async runtimeConfiguration(config: ExpressGatewayServiceConfiguration | undefined, serviceArn: string): Promise<{ container: any; task?: TaskDefinition; tags?: Array<{ key?: string; value?: string }> }> {
    if (!config?.taskDefinitionArn) {
      if (!config?.primaryContainer?.image) throw new Error('ECS runtime configuration is not observable.');
      return { container: config.primaryContainer };
    }
    const arn = config.taskDefinitionArn;
    if (!arn.startsWith(serviceArn.split(':service/')[0] + ':task-definition/') || !/:\d+$/.test(arn)) throw new Error('ECS task definition is outside the bound account or region.');
    const result = await this.connected().clients.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn, include: ['TAGS'] }));
    const task = result.taskDefinition;
    if (task?.taskDefinitionArn !== arn || task.status !== 'ACTIVE'
      || arn !== `${serviceArn.split(':service/')[0]}:task-definition/${task.family}:${task.revision}`) throw new Error('ECS exact task definition could not be verified.');
    if (config.taskRoleArn !== undefined && config.taskRoleArn !== task.taskRoleArn) throw new Error('ECS current task role disagrees with the exact task definition.');
    ecsTaskDefinitionInput(task, {});
    return { container: task.containerDefinitions!.find((container) => container.name === 'Main')!, task, tags: result.tags };
  }

  private async updateRuntimeConfiguration(serviceArn: string, config: ExpressGatewayServiceConfiguration, patch: Record<string, unknown>, changes: UpdateExpressGatewayServiceRequest) {
    const current = await this.runtimeConfiguration(config, serviceArn);
    if (!current.task) return { output: await this.connected().clients.ecs.send(new UpdateExpressGatewayServiceCommand({ ...changes, taskRoleArn: config.taskRoleArn, primaryContainer: { ...current.container, ...patch } })), taskDefinitionArn: undefined };
    const input = { ...ecsTaskDefinitionInput(current.task, patch), ...(current.tags ? { tags: current.tags } : {}) };
    const registered = await ecsTaskDefinitionWriter(this.connected().clients.ecs).send(new RegisterTaskDefinitionCommand(input));
    const arn = registered.taskDefinition?.taskDefinitionArn;
    const prefix = current.task.taskDefinitionArn!.replace(/:\d+$/, ':');
    if (!arn?.startsWith(prefix) || !/^\d+$/.test(arn.slice(prefix.length))) throw new Error('ECS did not acknowledge a revision of the bound task-definition family.');
    const observed = await this.runtimeConfiguration({ taskDefinitionArn: arn }, serviceArn);
    if (ecsVolumeFingerprint(observed.task) !== ecsVolumeFingerprint(current.task)) throw new Error('ECS task revision changed retained volume mounts or runtime identity.');
    const preserves = (expected: any, value: any): boolean => Array.isArray(expected)
      ? Array.isArray(value) && expected.length === value.length && expected.every((entry, i) => preserves(entry, value[i]))
      : expected && typeof expected === 'object'
        ? Boolean(value) && Object.entries(expected).every(([key, entry]) => entry === undefined || preserves(entry, value[key]))
        : expected === value;
    if (!preserves(input, { ...ecsTaskDefinitionInput(observed.task, {}), ...(observed.tags ? { tags: observed.tags } : {}) })) throw new Error('ECS task revision did not preserve reviewed runtime configuration.');
    const { primaryContainer: _primary, executionRoleArn: _execution, taskRoleArn: _role, cpu: _cpu, memory: _memory, ...compatible } = changes;
    return { output: await this.connected().clients.ecs.send(new UpdateExpressGatewayServiceCommand({ ...compatible, taskDefinitionArn: arn })), taskDefinitionArn: arn };
  }

  private expressUrl(service: ECSExpressGatewayService): string | undefined {
    const endpoint = this.currentConfiguration(service)?.ingressPaths?.find(
      (path) => path.accessType === 'PUBLIC'
    )?.endpoint ?? this.currentConfiguration(service)?.ingressPaths?.[0]?.endpoint;
    if (!endpoint) return undefined;
    return endpoint.startsWith('http') ? endpoint : `https://${endpoint}`;
  }

  private async waitForExpress(
    serviceArn: string,
    image?: string,
    previousDeployment?: string,
    taskDefinitionArn?: string,
    taskRoleArn?: string | null
  ): Promise<ECSExpressGatewayService> {
    const attempts = this.attempts('HYPERVIBE_ECS_EXPRESS_WAIT_ATTEMPTS', 120);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const service = await this.getExpressService(serviceArn);
      if (!service) throw new Error(`ECS Express service ${serviceArn} disappeared during reconciliation.`);
      const config = this.currentConfiguration(service);
      const runtime = await this.runtimeConfiguration(config, serviceArn);
      if (service.status?.statusCode === 'ACTIVE'
        && (!image || runtime.container.image === image)
        && (!taskDefinitionArn || config?.taskDefinitionArn === taskDefinitionArn)
        && (taskRoleArn === undefined || (runtime.task?.taskRoleArn ?? config?.taskRoleArn ?? null) === taskRoleArn)
        && (!previousDeployment || (
          Boolean(service.currentDeployment)
          && service.currentDeployment !== previousDeployment
        ))
        && this.expressUrl(service)) {
        return service;
      }
      if (service.status?.statusCode === 'INACTIVE') {
        throw new Error(`ECS Express service ${serviceArn} became inactive: ${service.status.statusReason ?? 'unknown reason'}.`);
      }
      if (attempt < attempts) await this.delay();
    }
    throw new Error(`ECS Express service ${serviceArn} did not become active.`);
  }

  private emptyObservation(projectExists: boolean): ObservedState {
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists,
      services: [],
      databases: [],
      completeness: { project: 'complete', environment: 'complete', services: 'complete', databases: 'complete' },
      partial: false,
      warnings: [],
    };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private attempts(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async delay(): Promise<void> {
    const parsed = Number(process.env.HYPERVIBE_ECS_WAIT_DELAY_MS ?? 1000);
    if (Number.isFinite(parsed) && parsed > 0) await new Promise((resolve) => setTimeout(resolve, parsed));
  }

  private hasErrorName(error: unknown, ...names: string[]): boolean {
    return Boolean(error && typeof error === 'object' && names.includes(String((error as { name?: unknown }).name)));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

providerRegistry.register({
  metadata: {
    name: 'ecs',
    displayName: 'AWS ECS Express Mode',
    category: 'deployment',
    credentialsSchema: EcsExpressCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    credentials: {
      environmentVariableAliases: [
        ['HYPERVIBE_AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'],
        ['HYPERVIBE_AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'],
      ],
    },
    maturity: {
      lifecycle: {
        hosting: { status: 'planned', reason: 'Resource lifecycle is moving to OpenTofu; this adapter provides connections and existing-resource operations only.' },
      },
    },
    orchestration: {
      project: { shareAcrossEnvironments: false },
      diff: { workloadKindObservation: 'exact' },
      ci: {
        rendererRevision: 1,
        displayName: 'AWS ECS Express Mode',
        requiredSecrets: ECS_EXPRESS_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          AWS_ACCESS_KEY_ID: 'accessKeyId',
          AWS_SECRET_ACCESS_KEY: 'secretAccessKey',
        },
        buildGitHubActionsSteps: buildEcsExpressGitHubActionsSteps,
      },
    },
  },
  factory: async (credentials) => {
    const adapter = new EcsExpressAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['environment'],
    defaultResource: 'environment',
    selectors: {
      environment: { mode: 'environment-forensics', required: ['project', 'env'], optional: ['scope', 'region', 'limit'], list: true },
    },
    inspect: (adapter, request) => (
      adapter as EcsExpressAdapter
    ).inspectEnvironmentResources(request),
  },
});
