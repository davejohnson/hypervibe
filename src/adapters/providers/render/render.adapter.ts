import { createHash } from 'crypto';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
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
import { parseGitHubRepoFromRemote } from '../../../lib/git-remote.js';
import { RenderCacheAdapter } from './render-cache.adapter.js';
import {
  RenderClient,
  type RenderEnvVar,
  type RenderService,
  type RenderServiceType,
} from './render.client.js';
import {
  RenderCredentialsSchema,
  type RenderCredentials,
} from './render.credentials.js';
import { RenderDatabaseAdapter } from './render-database.adapter.js';
import {
  buildRenderGitHubActionsSteps,
  RENDER_BOOTSTRAP_IMAGE,
  RENDER_CI_REQUIRED_SECRETS,
} from './render-ci.workflow.js';

export class RenderAdapter implements IProviderAdapter {
  readonly name = 'render';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile'],
    supportedComponents: [],
    supportsAutoWiring: false,
    supportsHealthChecks: true,
    supportsCronSchedule: true,
    supportsReleaseCommand: false,
    supportsMultiEnvironment: false,
    managedTls: true,
    supportsObserve: true,
    supportsDeferredDeploy: true,
  };

  private credentials: RenderCredentials | null = null;
  private client: RenderClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = RenderCredentialsSchema.parse(credentials);
    this.client = new RenderClient(this.credentials.apiKey);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client || !this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const owner = await this.client.getOwner(this.credentials.ownerId);
      if (!owner) {
        return {
          success: false,
          error: `Render workspace ${this.credentials.ownerId} was not found.`,
        };
      }
      await Promise.all([
        this.client.listServices(this.credentials.ownerId),
        this.client.listPostgres(this.credentials.ownerId),
        this.client.listKeyValues(this.credentials.ownerId),
        ...(this.credentials.registryCredentialId
          ? [this.verifyRegistryCredential(this.credentials.registryCredentialId)]
          : []),
      ]);
      return { success: true, email: owner.email };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.client = null;
  }

  async createDatabaseAdapter(): Promise<RenderDatabaseAdapter> {
    if (!this.credentials) {
      throw new Error('Render adapter is not connected.');
    }
    const adapter = new RenderDatabaseAdapter();
    await adapter.connect(this.credentials);
    return adapter;
  }

  async createCacheAdapter(): Promise<RenderCacheAdapter> {
    if (!this.credentials) {
      throw new Error('Render adapter is not connected.');
    }
    const adapter = new RenderCacheAdapter();
    await adapter.connect(this.credentials);
    return adapter;
  }

  async ensureProject(
    _projectName: string,
    environment: Environment
  ): Promise<Receipt> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const boundId = parseHostingBindings(environment).projectId;
    if (boundId && boundId !== this.credentials.ownerId) {
      return {
        success: false,
        message: 'Failed to bind Render workspace',
        error: `The environment is bound to Render workspace ${boundId}, but the verified connection targets ${this.credentials.ownerId}. Hypervibe will not silently rebind it.`,
      };
    }
    try {
      const owner = await this.client.getOwner(
        boundId ?? this.credentials.ownerId
      );
      if (!owner) {
        return {
          success: false,
          message: 'Failed to bind Render workspace',
          error: `Render workspace ${boundId ?? this.credentials.ownerId} was not found. Hypervibe will not create or replace a workspace implicitly.`,
        };
      }
      return {
        success: true,
        message: `Using existing Render workspace: ${owner.name}`,
        data: {
          projectId: owner.id,
          projectName: owner.name,
          created: false,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to verify Render workspace',
        error: this.formatError(error),
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
        message: 'Render datastores use explicit database/cache plan actions.',
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
    const bindings = parseHostingBindings(environment);
    if (bindings.projectId !== this.credentials.ownerId) {
      return this.failedDeploy(
        service,
        'No verified Render workspace binding exists for this environment.'
      );
    }

    const boundServiceId = bindings.services?.[service.name]?.serviceId;
    const providerName = this.serviceName(environment, service.name);
    let attemptedServiceId: string | undefined;
    let attemptedCreate = false;
    try {
      let existing: RenderService | null = null;
      if (boundServiceId) {
        existing = await this.client.getService(boundServiceId);
        if (!existing) {
          return this.failedDeploy(
            service,
            `Bound Render service ${boundServiceId} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`
          );
        }
        this.assertServiceIdentity(existing, providerName);
      } else {
        const matches = (await this.client.listServices(this.credentials.ownerId))
          .filter((candidate) => candidate.name === providerName);
        if (matches.length > 0) {
          return this.failedDeploy(
            service,
            [
              `Render service name "${providerName}" is already present: ${matches
                .map((candidate) => candidate.id)
                .join(', ')}.`,
              'Hypervibe will not silently adopt a name match. Use hv_import for the intended service or remove the duplicate, then run hv_plan again.',
            ].join(' ')
          );
        }
      }

      const workloadKind = serviceWorkloadKind(service);
      const serviceType = this.serviceType(service, workloadKind);
      if (existing && existing.type !== serviceType) {
        return this.failedDeploy(
          service,
          `Bound Render service ${existing.id} has type ${existing.type}, but ${service.name} requires ${serviceType}. Apply the reviewed replace action after the old binding is retired.`
        );
      }

      const image = await this.resolveImage(
        service,
        envVars,
        existing,
        options.deferDeployment === true
      );
      if (!existing && !image.imagePath) {
        return this.failedDeploy(
          service,
          `Render needs IMAGE_URI or ${this.imageEnvKey(service)} to create ${service.name}.`
        );
      }
      const runtimeEnv = this.runtimeEnvVars(envVars);
      if (!existing) {
        attemptedCreate = true;
        const created = await this.client.createService({
          type: serviceType,
          name: providerName,
          ownerId: this.credentials.ownerId,
          autoDeploy: 'no',
          image: {
            ownerId: this.credentials.ownerId,
            imagePath: image.imagePath,
            ...(image.registryCredentialId && !image.pendingImage
              ? { registryCredentialId: image.registryCredentialId }
              : {}),
          },
          envVars: this.sortedEnvVars(runtimeEnv),
          serviceDetails: this.serviceDetails(service, workloadKind),
        });
        attemptedServiceId = created.service.id;
        this.assertServiceIdentity(created.service, providerName);
        return this.successfulDeploy({
          service,
          providerService: created.service,
          deployId: created.deployId,
          created: true,
          deferred: options.deferDeployment === true,
          pendingImage: image.pendingImage,
          imageUri: image.pendingImage ? undefined : image.imagePath,
        });
      }

      attemptedServiceId = existing.id;
      const updated = await this.client.updateService(existing.id, {
        autoDeploy: 'no',
        ...(image.imagePath && image.imagePath !== existing.imagePath
          ? {
              image: {
                ownerId: this.credentials.ownerId,
                imagePath: image.imagePath,
                ...(image.registryCredentialId
                  ? { registryCredentialId: image.registryCredentialId }
                  : {}),
              },
            }
          : {}),
        serviceDetails: this.serviceDetails(service, workloadKind),
      });
      this.assertServiceIdentity(updated, providerName);
      await this.mergeEnvVars(existing.id, runtimeEnv);
      return this.successfulDeploy({
        service,
        providerService: updated,
        created: false,
        deferred: options.deferDeployment === true,
        pendingImage: false,
        imageUri: image.imagePath,
      });
    } catch (error) {
      return this.failedDeploy(
        service,
        this.formatError(error),
        attemptedServiceId
          ? {
              externalId: attemptedServiceId,
              createdService: attemptedCreate,
              mutationAttempted: true,
            }
          : undefined
      );
    }
  }

  async setEnvVars(
    environment: Environment,
    service: Service,
    vars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    const serviceId = parseHostingBindings(environment)
      .services?.[service.name]?.serviceId;
    if (!this.client || !serviceId) {
      return {
        success: false,
        message: 'Failed to update Render environment variables',
        error: serviceId
          ? 'Not connected. Call connect() first.'
          : `No Render service binding exists for ${service.name}.`,
        data: { staleBinding: !serviceId },
      };
    }
    try {
      const existing = await this.client.getService(serviceId);
      if (!existing) {
        return {
          success: false,
          message: 'Failed to update Render environment variables',
          error: `Bound Render service ${serviceId} was not found.`,
          data: { staleBinding: true },
        };
      }
      await this.mergeEnvVars(serviceId, this.runtimeEnvVars(vars));
      return {
        success: true,
        message: `Updated Render environment variables for ${service.name}`,
        data: {
          serviceId,
          variableCount: Object.keys(this.runtimeEnvVars(vars)).length,
          ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update Render environment variables',
        error: this.formatError(error),
      };
    }
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    const serviceId = parseHostingBindings(environment)
      .services?.[service.name]?.serviceId;
    if (!this.client || !serviceId) {
      return {
        success: false,
        message: 'Failed to delete Render environment variables',
        error: `No Render service binding exists for ${service.name}.`,
      };
    }
    try {
      const retired = new Set(keys);
      const existing = await this.client.listEnvVars(serviceId);
      await this.client.replaceEnvVars(
        serviceId,
        existing.filter((entry) => !retired.has(entry.key))
      );
      return {
        success: true,
        message: `Deleted explicitly retired Render environment variables for ${service.name}`,
        data: { serviceId, deletedKeys: [...retired].sort() },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Render environment variables',
        error: this.formatError(error),
      };
    }
  }

  async disconnectDeploySource(params: {
    serviceId: string;
  }): Promise<Receipt> {
    if (!this.client) {
      return { success: false, message: 'Not connected' };
    }
    try {
      const service = await this.client.getService(params.serviceId);
      if (!service) {
        return {
          success: false,
          message: 'Failed to verify Render deploy source',
          error: `Render service ${params.serviceId} was not found.`,
        };
      }
      if (service.repo) {
        return {
          success: false,
          message: 'Render deploy source is still connected',
          error: `Render service ${params.serviceId} is Git-backed. Hypervibe will not claim CI ownership until it is replaced by an image-backed service through a reviewed lifecycle action.`,
        };
      }
      return {
        success: true,
        message: `Render service ${params.serviceId} is image-backed and has no native Git source`,
        data: { sourceState: 'disconnected' },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to verify Render deploy source',
        error: this.formatError(error),
      };
    }
  }

  async deleteService(
    serviceId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      if (!await this.client.getService(serviceId)) {
        return { success: true };
      }
      await this.client.deleteService(serviceId);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_RENDER_SERVICE_DELETE_ATTEMPTS',
        120
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_RENDER_SERVICE_DELETE_DELAY_MS',
        2000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!await this.client.getService(serviceId)) {
          return { success: true };
        }
        if (attempt < attempts) {
          await this.delay(delayMs);
        }
      }
      return {
        success: false,
        error: `Render service ${serviceId} remained observable after ${attempts} deletion checks.`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async getDeployStatus(
    _environment: Environment,
    serviceId: string
  ): Promise<{ status: string; url?: string }> {
    if (!this.client) {
      return { status: 'unknown' };
    }
    try {
      const service = await this.client.getService(serviceId);
      if (!service) {
        return { status: 'absent' };
      }
      const deploy = (await this.client.listDeploys(serviceId))[0];
      const status = this.normalizedDeployStatus(deploy?.status);
      const url = service.type === 'web_service'
        ? service.serviceDetails?.url
        : undefined;
      return { status, ...(url ? { url } : {}) };
    } catch {
      return { status: 'unknown' };
    }
  }

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const bindings = parseHostingBindings(environment);
    if (!bindings.projectId) {
      const owner = await this.client.getOwner(this.credentials.ownerId);
      if (!owner) {
        throw new Error(`Render workspace ${this.credentials.ownerId} was not found.`);
      }
      return this.emptyObservation(false);
    }
    if (bindings.projectId !== this.credentials.ownerId) {
      throw new Error(
        `Bound Render workspace ${bindings.projectId} does not match the verified connection workspace ${this.credentials.ownerId}.`
      );
    }
    const owner = await this.client.getOwner(bindings.projectId);
    if (!owner) {
      return this.emptyObservation(false);
    }

    const allServices = await this.client.listServices(bindings.projectId);
    const boundIds = new Set(
      Object.values(bindings.services ?? {})
        .map((binding) => binding.serviceId)
        .filter((id): id is string => Boolean(id))
    );
    const prefix = `${this.servicePrefix(environment)}-`;
    const unbound = allServices.filter(
      (service) => service.name.startsWith(prefix) && !boundIds.has(service.id)
    );
    if (unbound.length > 0) {
      throw new Error([
        `Render services matching this environment exist without durable local bindings: ${unbound
          .map((service) => `${service.name} (${service.id})`)
          .join(', ')}.`,
        'Use hv_import to adopt the intended services; Hypervibe will not silently bind name matches.',
      ].join(' '));
    }

    const services: ObservedService[] = [];
    for (const [logicalName, binding] of Object.entries(
      bindings.services ?? {}
    )) {
      if (!binding.serviceId) {
        continue;
      }
      const service = allServices.find(
        (candidate) => candidate.id === binding.serviceId
      );
      if (!service) {
        continue;
      }
      services.push(await this.observedService(logicalName, service));
    }
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: owner.id,
      services,
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

  private async resolveImage(
    service: Service,
    envVars: Record<string, string>,
    existing: RenderService | null,
    deferred: boolean
  ): Promise<{
    imagePath?: string;
    registryCredentialId?: string;
    pendingImage: boolean;
  }> {
    if (!deferred) {
      return {
        imagePath:
          envVars[this.imageEnvKey(service)]
          ?? envVars.IMAGE_URI
          ?? existing?.imagePath,
        registryCredentialId:
          this.credentials?.registryCredentialId
          ?? existing?.registryCredential?.id,
        pendingImage: false,
      };
    }
    const credentialId =
      this.credentials?.registryCredentialId
      ?? existing?.registryCredential?.id;
    if (!credentialId) {
      throw new Error(
        'Render CI deploys require registryCredentialId in the verified connection. Hypervibe will not create or rotate a registry credential from a service or CI action.'
      );
    }
    await this.verifyRegistryCredential(credentialId);
    if (existing?.imagePath) {
      return {
        imagePath: existing.imagePath,
        registryCredentialId: credentialId,
        pendingImage: existing.imagePath === RENDER_BOOTSTRAP_IMAGE,
      };
    }
    const repository = parseGitHubRepoFromRemote(
      envVars.HYPERVIBE_SOURCE_REPO_URL
    );
    if (!repository) {
      throw new Error(
        'Render CI deploys require a GitHub gitRemoteUrl so Hypervibe can reserve the exact GHCR repository used by the generated workflow.'
      );
    }
    return {
      imagePath: RENDER_BOOTSTRAP_IMAGE,
      registryCredentialId: credentialId,
      pendingImage: true,
    };
  }

  private serviceDetails(
    service: Service,
    workloadKind: WorkloadKind
  ): Record<string, unknown> {
    const details: Record<string, unknown> = {
      runtime: 'image',
      plan: this.credentials!.servicePlan,
      region: this.credentials!.region,
      ...(service.buildConfig.startCommand
        ? {
            envSpecificDetails: {
              dockerCommand: service.buildConfig.startCommand,
            },
          }
        : {}),
    };
    if (workloadKind === 'web' && service.buildConfig.healthCheckPath) {
      details.healthCheckPath = service.buildConfig.healthCheckPath;
    }
    if (workloadKind === 'cron') {
      if (!service.buildConfig.cronSchedule) {
        throw new Error(`Render cron service ${service.name} needs cronSchedule.`);
      }
      details.schedule = service.buildConfig.cronSchedule;
    }
    return details;
  }

  private serviceType(
    service: Service,
    workloadKind: WorkloadKind
  ): RenderServiceType {
    if (workloadKind === 'cron') return 'cron_job';
    if (workloadKind === 'worker') return 'background_worker';
    return service.buildConfig.public === false
      ? 'private_service'
      : 'web_service';
  }

  private async mergeEnvVars(
    serviceId: string,
    vars: Record<string, string>
  ): Promise<void> {
    const current = await this.client!.listEnvVars(serviceId);
    const merged = new Map<string, string>(
      current.map((entry) => [entry.key, entry.value])
    );
    for (const [key, value] of Object.entries(vars)) {
      merged.set(key, value);
    }
    await this.client!.replaceEnvVars(
      serviceId,
      this.sortedEnvVars(Object.fromEntries(merged))
    );
  }

  private runtimeEnvVars(
    vars: Record<string, string>
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(vars).filter(([key]) =>
        key !== 'IMAGE_URI'
        && !key.startsWith('IMAGE_URI_')
        && !key.startsWith('HYPERVIBE_SOURCE_')
      )
    );
  }

  private sortedEnvVars(vars: Record<string, string>): RenderEnvVar[] {
    return Object.entries(vars)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value }));
  }

  private successfulDeploy(params: {
    service: Service;
    providerService: RenderService;
    deployId?: string;
    created: boolean;
    deferred: boolean;
    pendingImage: boolean;
    imageUri?: string;
  }): DeployResult {
    const url = params.providerService.type === 'web_service'
      ? params.providerService.serviceDetails?.url
      : undefined;
    return {
      serviceId: params.service.id,
      externalId: params.providerService.id,
      ...(url ? { url } : {}),
      status: params.deferred ? 'configured' : 'deploying',
      receipt: {
        success: true,
        message: params.deferred
          ? `Prepared Render service for exact-SHA CI deployment: ${params.providerService.name}`
          : `Configured Render service: ${params.providerService.name}`,
        data: {
          serviceId: params.providerService.id,
          serviceName: params.providerService.name,
          resourceType: params.providerService.type,
          createdService: params.created,
          ...(params.deployId ? { deployId: params.deployId } : {}),
          ...(params.imageUri ? { imageUri: params.imageUri } : {}),
          ...(params.deferred
            ? {
                deploymentDeferred: true,
                ...(params.pendingImage ? { pendingImage: true } : {}),
              }
            : {}),
          ...(url ? { url } : {}),
        },
      },
    };
  }

  private async observedService(
    logicalName: string,
    service: RenderService
  ): Promise<ObservedService> {
    const envVars = await this.client!.listEnvVars(service.id);
    const deploys = await this.client!.listDeploys(service.id);
    const envVarHashes = Object.fromEntries(
      envVars.map((entry) => [entry.key, hashEnvValue(entry.value)])
    );
    return {
      name: logicalName,
      externalId: service.id,
      workloadKind: this.observedWorkloadKind(service.type),
      ...(service.type === 'web_service' && service.serviceDetails?.url
        ? { url: service.serviceDetails.url }
        : {}),
      customDomains: [],
      config: {
        startCommand:
          service.serviceDetails?.envSpecificDetails?.dockerCommand,
        healthCheckPath: service.serviceDetails?.healthCheckPath,
        cronSchedule: service.serviceDetails?.schedule,
        public: service.type === 'web_service',
      },
      sourceState: service.repo ? 'connected' : 'disconnected',
      ...(service.repo
        ? { source: { repo: service.repo, branch: service.branch } }
        : {}),
      envVarKeys: envVars.map((entry) => entry.key).sort(),
      envVarHashes,
      status: deploys.length === 0
        ? 'empty'
        : this.observedRuntimeStatus(deploys[0]?.status),
    };
  }

  private observedWorkloadKind(type: RenderServiceType): WorkloadKind {
    if (type === 'cron_job') return 'cron';
    if (type === 'background_worker') return 'worker';
    return 'web';
  }

  private observedRuntimeStatus(
    status?: string
  ): 'running' | 'failed' | 'empty' | 'unknown' {
    if (status === 'live') return 'running';
    if (['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled']
      .includes(status ?? '')) {
      return 'failed';
    }
    return 'unknown';
  }

  private normalizedDeployStatus(status?: string): string {
    if (status === 'live') return 'deployed';
    if (['build_failed', 'update_failed', 'pre_deploy_failed'].includes(status ?? '')) {
      return 'failed';
    }
    if (status === 'canceled') return 'canceled';
    return status ?? 'unknown';
  }

  private assertServiceIdentity(
    service: RenderService,
    expectedName: string
  ): void {
    if (
      service.ownerId !== this.credentials?.ownerId
      || service.name !== expectedName
    ) {
      throw new Error(
        `Render returned service ${service.id} outside the reviewed workspace/name identity.`
      );
    }
  }

  private async verifyRegistryCredential(id: string): Promise<void> {
    const credential = await this.client!.getRegistryCredential(id);
    if (!credential) {
      throw new Error(
        `Render registry credential ${id} was not found. Hypervibe will not create or replace it implicitly.`
      );
    }
    if (credential.registry !== 'GITHUB') {
      throw new Error(
        `Render registry credential ${id} targets ${credential.registry}, not GitHub Container Registry.`
      );
    }
  }

  private servicePrefix(environment: Environment): string {
    const projectHash = createHash('sha256')
      .update(environment.projectId)
      .digest('hex')
      .slice(0, 8);
    return this.sanitizeName(
      `hv-${projectHash}-${environment.name}`,
      70
    );
  }

  private serviceName(
    environment: Environment,
    logicalName: string
  ): string {
    return this.sanitizeName(
      `${this.servicePrefix(environment)}-${logicalName}`,
      100
    );
  }

  private sanitizeName(value: string, maxLength: number): string {
    const sanitized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, maxLength)
      .replace(/-$/, '');
    return sanitized || `hv-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
  }

  private imageEnvKey(service: Service): string {
    return `IMAGE_URI_${service.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
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
    mutation?: {
      externalId: string;
      createdService: boolean;
      mutationAttempted: true;
    }
  ): DeployResult {
    return {
      serviceId: service.id,
      ...(mutation ? { externalId: mutation.externalId } : {}),
      status: 'failed',
      receipt: {
        success: false,
        message: `Render deployment failed for ${service.name}`,
        error,
        ...(mutation
          ? {
              data: {
                createdService: mutation.createdService,
                mutationAttempted: mutation.mutationAttempted,
              },
            }
          : {}),
      },
    };
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
    name: 'render',
    displayName: 'Render',
    category: 'deployment',
    credentialsSchema: RenderCredentialsSchema,
    setupHelpUrl: 'https://dashboard.render.com/u/settings#api-keys',
    credentials: {
      defaultScalarKey: 'apiKey',
      environmentVariableAliases: [
        ['RENDER_API_KEY', 'HYPERVIBE_RENDER_API_KEY'],
      ],
    },
    orchestration: {
      project: { shareAcrossEnvironments: true },
      diff: {
        requiresBranchDeployForCode: false,
        serviceCreatesBillable: true,
      },
      ci: {
        displayName: 'Render',
        requiredSecrets: RENDER_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          RENDER_API_KEY: 'apiKey',
          RENDER_REGISTRY_CREDENTIAL_ID: 'registryCredentialId',
        },
        buildGitHubActionsSteps: buildRenderGitHubActionsSteps,
      },
      nativeBranchDeploy: {
        ciModeSourcePolicy: 'block',
      },
    },
    lifecycle: {
      databaseEngines: ['postgres'],
      cacheEngines: ['redis'],
    },
  },
  factory: (credentials) => {
    const validated = RenderCredentialsSchema.parse(credentials);
    const adapter = new RenderAdapter();
    void adapter.connect(validated);
    return adapter;
  },
  derivedAdapters: {
    database: (adapter) =>
      (adapter as RenderAdapter).createDatabaseAdapter(),
    cache: (adapter) =>
      (adapter as RenderAdapter).createCacheAdapter(),
  },
});
