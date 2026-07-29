import { createHash } from 'crypto';
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
  AzureContainerAppsClient,
  type AzureContainerApp,
  type AzureContainerAppContainer,
  type AzureContainerAppEnv,
  type AzureContainerAppRevision,
} from './azure-container-apps.client.js';
import {
  buildAzureContainerAppsGitHubActionsSteps,
  AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS,
} from './azure-container-apps-ci.workflow.js';
import {
  AzureContainerAppsCredentialsSchema,
  type AzureContainerAppsCredentials,
} from './azure-container-apps.credentials.js';

const BOOTSTRAP_IMAGE = 'mcr.microsoft.com/k8se/quickstart:latest';
const REGISTRY_SECRET_NAME = 'hypervibe-acr-password';
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

interface ObservedAzureService {
  service: ObservedService;
  unknownSecretKeys: string[];
}

export class AzureContainerAppsAdapter implements IProviderAdapter {
  readonly name = 'azure-container-apps';

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
    supportsDeferredDeploy: true,
  };

  private credentials: AzureContainerAppsCredentials | null = null;
  private client: AzureContainerAppsClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = AzureContainerAppsCredentialsSchema.parse(credentials);
    this.client = new AzureContainerAppsClient(this.credentials);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client || !this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await this.client.verifyScope();
      const registry = await this.client.getRegistry();
      if (
        registry.id.toLowerCase() !== this.credentials.registryId.toLowerCase()
      ) {
        return {
          success: false,
          error: 'Azure returned a registry outside the configured resource ID.',
        };
      }
      if (
        registry.properties?.loginServer?.toLowerCase()
        !== this.credentials.registryServer
      ) {
        return {
          success: false,
          error: `Azure registry ${registry.id} reports login server ${registry.properties?.loginServer ?? 'unknown'}, not ${this.credentials.registryServer}.`,
        };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.client = null;
  }

  async ensureProject(
    _projectName: string,
    environment: Environment
  ): Promise<Receipt> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const boundId = parseHostingBindings(environment).projectId;
    if (boundId) {
      try {
        const existing = await this.client.getManagedEnvironment(boundId);
        if (!existing) {
          return {
            success: false,
            message: 'Failed to ensure Azure Container Apps environment',
            error: `Bound Azure managed environment ${boundId} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`,
          };
        }
        const ready = await this.waitForManagedEnvironment(boundId);
        return {
          success: true,
          message: `Using bound Azure Container Apps environment: ${ready.name}`,
          data: {
            projectId: ready.id,
            projectName: ready.name,
            created: false,
          },
        };
      } catch (error) {
        return {
          success: false,
          message: 'Failed to ensure Azure Container Apps environment',
          error: this.formatError(error),
        };
      }
    }

    const name = this.environmentName(environment);
    const attemptedEnvironmentId =
      this.client.managedEnvironmentResourceId(name);
    let mutationAttempted = false;
    try {
      const matches = (await this.client.listManagedEnvironments())
        .filter((candidate) => candidate.name.toLowerCase() === name);
      if (matches.length > 0) {
        return {
          success: false,
          message: 'Failed to ensure Azure Container Apps environment',
          error: [
            `Azure managed environment "${name}" already exists: ${matches
              .map((candidate) => candidate.id)
              .join(', ')}.`,
            'Hypervibe will not silently adopt a name match. Use hv_import for the intended environment or remove the conflict, then run hv_plan again.',
          ].join(' '),
          data: {
            duplicateProjectIds: matches.map((candidate) => candidate.id).sort(),
          },
        };
      }

      mutationAttempted = true;
      const created = await this.client.createManagedEnvironment(name, {
        location: this.credentials.location,
        tags: this.environmentTags(environment),
        properties: {
          zoneRedundant: false,
        },
      });
      const identity = this.client.parseManagedEnvironmentId(created.id);
      if (
        created.name.toLowerCase() !== name
        || identity.name.toLowerCase() !== name
      ) {
        throw new Error(
          `Azure returned managed environment ${created.id} outside the reviewed name identity.`
        );
      }
      const ready = await this.waitForManagedEnvironment(created.id);
      return {
        success: true,
        message: `Created Azure Container Apps environment: ${ready.name}`,
        data: {
          projectId: ready.id,
          projectName: ready.name,
          created: true,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to create Azure Container Apps environment',
        error: this.formatError(error),
        ...(mutationAttempted
          ? {
              data: {
                projectId: attemptedEnvironmentId,
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
        message: 'Azure datastores use separate provider adapters and explicit plan actions.',
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
        'Azure Container Apps Jobs are a distinct lifecycle resource and are not supported by this hosting adapter.'
      );
    }
    if (!service.buildConfig.startCommand?.trim()) {
      return this.failedDeploy(
        service,
        'Azure Container Apps services require startCommand so runtime behavior remains declarative and observable.'
      );
    }

    const bindings = parseHostingBindings(environment);
    const managedEnvironmentId = bindings.projectId;
    if (!managedEnvironmentId) {
      return this.failedDeploy(
        service,
        'No Azure Container Apps managed-environment binding exists for this environment.'
      );
    }

    let mutation:
      | { externalId: string; createdService: boolean; mutationAttempted: true }
      | undefined;
    try {
      const managedEnvironment =
        await this.client.getManagedEnvironment(managedEnvironmentId);
      if (!managedEnvironment) {
        return this.failedDeploy(
          service,
          `Bound Azure managed environment ${managedEnvironmentId} was not found. Re-run hv_plan; Hypervibe will not create a service under an unknown environment.`
        );
      }
      await this.waitForManagedEnvironment(managedEnvironmentId);

      const existingBinding =
        bindings.services?.[service.name]?.serviceId;
      let app: AzureContainerApp | null = null;
      let createdService = false;
      if (existingBinding) {
        app = await this.client.getContainerApp(existingBinding);
        if (!app) {
          return this.failedDeploy(
            service,
            `Bound Azure Container App ${existingBinding} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`
          );
        }
        this.assertAppEnvironment(app, managedEnvironmentId);
      } else {
        const expectedName = this.appName(environment, service.name);
        const matches = (await this.client.listContainerApps())
          .filter((candidate) =>
            candidate.name.toLowerCase() === expectedName
          );
        if (matches.length > 0) {
          return this.failedDeploy(
            service,
            [
              `Azure Container App "${expectedName}" already exists: ${matches
                .map((candidate) => candidate.id)
                .join(', ')}.`,
              'Hypervibe will not silently adopt a name match. Use hv_import for the intended app or remove the conflict, then run hv_plan again.',
            ].join(' ')
          );
        }
        const createBody = this.containerAppBody({
          app: null,
          environment,
          managedEnvironmentId,
          service,
          envVars,
          workloadKind,
        });
        mutation = {
          externalId: this.client.containerAppResourceId(expectedName),
          createdService: true,
          mutationAttempted: true,
        };
        const created = await this.client.createContainerApp(
          expectedName,
          createBody
        );
        mutation = {
          externalId: created.id,
          createdService: true,
          mutationAttempted: true,
        };
        const identity = this.client.parseContainerAppId(created.id);
        if (
          created.name.toLowerCase() !== expectedName
          || identity.name.toLowerCase() !== expectedName
        ) {
          throw new Error(
            `Azure returned Container App ${created.id} outside the reviewed name identity.`
          );
        }
        this.assertAppEnvironment(created, managedEnvironmentId);
        app = await this.waitForContainerApp(created.id);
        this.assertAppEnvironment(app, managedEnvironmentId);
        createdService = true;
      }

      if (!app) {
        throw new Error('Azure Container App mutation returned no resource identity.');
      }
      mutation = {
        externalId: app.id,
        createdService,
        mutationAttempted: true,
      };
      if (!createdService) {
        const patch = await this.containerAppPatch({
          app,
          environment,
          service,
          envVars,
          workloadKind,
        });
        await this.client.patchContainerApp(app.id, patch);
        app = await this.waitForContainerApp(app.id);
      }

      const url = this.publicUrl(app);
      return {
        serviceId: service.id,
        externalId: app.id,
        ...(url ? { url } : {}),
        status: 'configured',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared Azure Container App for exact-digest CI deployment: ${app.name}`
            : `Configured Azure Container App; an exact-digest CI deployment is still required: ${app.name}`,
          data: {
            serviceId: app.id,
            appId: app.id,
            serviceName: app.name,
            resourceType: workloadKind,
            createdService,
            deploymentDeferred: true,
            pendingImage: app.properties?.template?.containers?.[0]?.image
              === BOOTSTRAP_IMAGE,
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
    const serviceId = parseHostingBindings(environment)
      .services?.[service.name]?.serviceId;
    if (!this.client || !this.credentials || !serviceId) {
      return {
        success: false,
        message: 'Failed to update Azure Container App environment variables',
        error: serviceId
          ? 'Not connected. Call connect() first.'
          : `No Azure Container App binding exists for ${service.name}.`,
        data: { staleBinding: !serviceId },
      };
    }
    try {
      const app = await this.client.getContainerApp(serviceId);
      if (!app) {
        return {
          success: false,
          message: 'Failed to update Azure Container App environment variables',
          error: `Bound Azure Container App ${serviceId} was not found.`,
          data: { staleBinding: true },
        };
      }
      const patch = await this.containerAppPatch({
        app,
        environment,
        service,
        envVars: vars,
        workloadKind: this.nonCronWorkloadKind(service),
      });
      await this.client.patchContainerApp(app.id, patch);
      await this.waitForContainerApp(app.id);
      return {
        success: true,
        message: `Updated Azure Container App environment variables for ${service.name}`,
        data: {
          serviceId,
          variableCount: Object.keys(this.runtimeEnvVars(vars)).length,
          ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update Azure Container App environment variables',
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
    if (!this.client || !this.credentials || !serviceId) {
      return {
        success: false,
        message: 'Failed to delete Azure Container App environment variables',
        error: serviceId
          ? 'Not connected. Call connect() first.'
          : `No Azure Container App binding exists for ${service.name}.`,
      };
    }
    try {
      const app = await this.client.getContainerApp(serviceId);
      if (!app) {
        return {
          success: false,
          message: 'Failed to delete Azure Container App environment variables',
          error: `Bound Azure Container App ${serviceId} was not found.`,
          data: { staleBinding: true },
        };
      }
      const retired = Array.from(new Set(keys))
        .filter((key) => !INTERNAL_ENV_KEYS.has(key))
        .sort();
      const patch = await this.containerAppPatch({
        app,
        environment,
        service,
        envVars: {},
        workloadKind: this.nonCronWorkloadKind(service),
        deleteKeys: retired,
      });
      await this.client.patchContainerApp(app.id, patch);
      await this.waitForContainerApp(app.id);
      return {
        success: true,
        message: `Deleted explicitly retired Azure Container App environment variables for ${service.name}`,
        data: { serviceId, deletedKeys: retired },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Azure Container App environment variables',
        error: this.formatError(error),
      };
    }
  }

  async disconnectDeploySource(params: {
    serviceId: string;
  }): Promise<Receipt> {
    if (!this.client) {
      return {
        success: false,
        message: 'Failed to disconnect Azure native source controls',
        error: 'Not connected. Call connect() first.',
      };
    }
    try {
      const app = await this.client.getContainerApp(params.serviceId);
      if (!app) {
        return {
          success: false,
          message: 'Failed to disconnect Azure native source controls',
          error: `Bound Azure Container App ${params.serviceId} was not found.`,
          data: { staleBinding: true },
        };
      }
      const controls = await this.client.listSourceControls(app.id);
      for (const control of controls) {
        await this.client.deleteSourceControl(app.id, control.name);
      }
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_AZURE_SOURCE_DELETE_ATTEMPTS',
        60
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_AZURE_SOURCE_DELETE_DELAY_MS',
        2000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const remaining = await this.client.listSourceControls(app.id);
        if (remaining.length === 0) {
          return {
            success: true,
            message: `Disconnected ${controls.length} Azure native source control${controls.length === 1 ? '' : 's'}`,
            data: {
              serviceId: app.id,
              disconnectedCount: controls.length,
            },
          };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      return {
        success: false,
        message: 'Failed to disconnect Azure native source controls',
        error: `Azure Container App ${app.id} still reports native source controls after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to disconnect Azure native source controls',
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
      if (!await this.client.getContainerApp(serviceId)) {
        return { success: true };
      }
      await this.client.deleteContainerApp(serviceId);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_AZURE_APP_DELETE_ATTEMPTS',
        120
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_AZURE_APP_DELETE_DELAY_MS',
        2000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!await this.client.getContainerApp(serviceId)) {
          return { success: true };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      return {
        success: false,
        error: `Azure Container App ${serviceId} remained observable after ${attempts} deletion checks.`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async deleteProject(
    projectId: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      if (!await this.client.getManagedEnvironment(projectId)) {
        return { success: true };
      }
      const dependents = (await this.client.listContainerApps())
        .filter((app) =>
          this.appEnvironmentId(app)?.toLowerCase()
          === projectId.toLowerCase()
        );
      if (dependents.length > 0) {
        return {
          success: false,
          error: `Azure managed environment ${projectId} still contains Container Apps: ${dependents.map((app) => app.id).join(', ')}. Delete the dependent service actions first.`,
        };
      }
      await this.client.deleteManagedEnvironment(projectId);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_AZURE_ENV_DELETE_ATTEMPTS',
        180
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_AZURE_ENV_DELETE_DELAY_MS',
        2000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!await this.client.getManagedEnvironment(projectId)) {
          return { success: true };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      return {
        success: false,
        error: `Azure managed environment ${projectId} remained observable after ${attempts} deletion checks.`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async getDeployStatus(
    _environment: Environment,
    serviceId: string
  ): Promise<{ status: string; url?: string }> {
    if (!this.client) return { status: 'unknown' };
    try {
      const app = await this.client.getContainerApp(serviceId);
      if (!app) return { status: 'absent' };
      const revisions = await this.client.listContainerAppRevisions(serviceId);
      const status = this.runtimeStatus(app, revisions);
      const url = this.publicUrl(app);
      return {
        status: status === 'running'
          ? 'deployed'
          : status,
        ...(url ? { url } : {}),
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
    const environments = await this.client.listManagedEnvironments();
    if (!bindings.projectId) {
      const expectedName = this.environmentName(environment);
      const matches = environments.filter(
        (candidate) => candidate.name.toLowerCase() === expectedName
      );
      if (matches.length > 0) {
        throw new Error([
          `Azure managed environments matching this Hypervibe environment exist without a durable local binding: ${matches
            .map((candidate) => `${candidate.name} (${candidate.id})`)
            .join(', ')}.`,
          'Use hv_import to adopt the intended environment; Hypervibe will not silently bind a name match.',
        ].join(' '));
      }
      return this.emptyObservation(false);
    }

    const managedEnvironment = environments.find(
      (candidate) =>
        candidate.id.toLowerCase() === bindings.projectId!.toLowerCase()
    );
    if (!managedEnvironment) {
      return this.emptyObservation(false);
    }

    const allApps = await this.client.listContainerApps();
    const environmentApps = allApps.filter(
      (app) =>
        this.appEnvironmentId(app)?.toLowerCase()
        === managedEnvironment.id.toLowerCase()
    );
    const boundIds = new Set(
      Object.values(bindings.services ?? {})
        .flatMap((binding) =>
          binding.serviceId ? [binding.serviceId.toLowerCase()] : []
        )
    );
    const unbound = environmentApps.filter(
      (app) => !boundIds.has(app.id.toLowerCase())
    );
    if (unbound.length > 0) {
      throw new Error([
        `Azure Container Apps exist in the bound managed environment without durable local bindings: ${unbound
          .map((app) => `${app.name} (${app.id})`)
          .join(', ')}.`,
        'Use hv_import to adopt the intended apps; Hypervibe will not silently choose a name match.',
      ].join(' '));
    }

    const appsById = new Map(
      environmentApps.map((app) => [app.id.toLowerCase(), app])
    );
    const observed: ObservedAzureService[] = [];
    for (const [logicalName, binding] of Object.entries(
      bindings.services ?? {}
    )) {
      if (!binding.serviceId) continue;
      const app = appsById.get(binding.serviceId.toLowerCase());
      if (!app) continue;
      observed.push(await this.observedService(logicalName, app));
    }
    const unknownSecretKeys = observed.flatMap(
      (entry) => entry.unknownSecretKeys.map(
        (key) => `${entry.service.name}:${key}`
      )
    );
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: managedEnvironment.id,
      environmentId: managedEnvironment.id,
      services: observed.map((entry) => entry.service),
      databases: [],
      caches: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: unknownSecretKeys.length > 0 ? 'unknown' : 'complete',
        databases: 'unknown',
        caches: 'unknown',
        storage: 'complete',
      },
      partial: unknownSecretKeys.length > 0,
      warnings: unknownSecretKeys.length > 0
        ? [
            `Azure did not return values for bound Container App secrets, so service configuration is unknown for: ${unknownSecretKeys.join(', ')}.`,
          ]
        : [],
    };
  }

  private async observedService(
    logicalName: string,
    app: AzureContainerApp
  ): Promise<ObservedAzureService> {
    const [secrets, revisions, sourceControls] = await Promise.all([
      this.client!.listContainerAppSecrets(app.id),
      this.client!.listContainerAppRevisions(app.id),
      this.client!.listSourceControls(app.id),
    ]);
    const secretValues = new Map(
      secrets.flatMap((secret) =>
        secret.name && typeof secret.value === 'string'
          ? [[secret.name, secret.value] as const]
          : []
      )
    );
    const container = this.primaryContainer(app);
    const env = container.env ?? [];
    const runtimeEnv = env.filter(
      (entry) => !INTERNAL_ENV_KEYS.has(entry.name)
    );
    const unknownSecretKeys = runtimeEnv
      .filter((entry) =>
        entry.secretRef && !secretValues.has(entry.secretRef)
      )
      .map((entry) => entry.name)
      .sort();
    const envVarHashes = Object.fromEntries(
      runtimeEnv.flatMap((entry) => {
        const value = typeof entry.value === 'string'
          ? entry.value
          : entry.secretRef
          ? secretValues.get(entry.secretRef)
          : undefined;
        return value === undefined
          ? []
          : [[entry.name, hashEnvValue(value)]];
      })
    );
    const ingress = app.properties?.configuration?.ingress;
    const workloadKind = this.observedWorkloadKind(app);
    const startCommand = env.find(
      (entry) => entry.name === START_COMMAND_KEY
    )?.value;
    const healthCheckPath = env.find(
      (entry) => entry.name === HEALTH_CHECK_PATH_KEY
    )?.value;
    const url = this.publicUrl(app);
    const source = sourceControls.length === 1
      ? {
          ...(sourceControls[0]!.properties?.repoUrl
            ? { repo: sourceControls[0]!.properties!.repoUrl }
            : {}),
          ...(sourceControls[0]!.properties?.branch
            ? { branch: sourceControls[0]!.properties!.branch }
            : {}),
        }
      : undefined;
    return {
      service: {
        name: logicalName,
        externalId: app.id,
        workloadKind,
        ...(url ? { url } : {}),
        customDomains: (ingress?.customDomains ?? [])
          .flatMap((domain) => domain.name ? [domain.name] : [])
          .sort(),
        config: {
          ...(startCommand ? { startCommand } : {}),
          ...(healthCheckPath ? { healthCheckPath } : {}),
          public: Boolean(ingress?.external),
        },
        ...(source && Object.keys(source).length > 0 ? { source } : {}),
        sourceState: sourceControls.length > 0
          ? 'connected'
          : 'disconnected',
        envVarKeys: runtimeEnv.map((entry) => entry.name).sort(),
        envVarHashes,
        status: this.runtimeStatus(app, revisions),
      },
      unknownSecretKeys,
    };
  }

  private containerAppBody(params: {
    app: null;
    environment: Environment;
    managedEnvironmentId: string;
    service: Service;
    envVars: Record<string, string>;
    workloadKind: Exclude<WorkloadKind, 'cron'>;
  }): Record<string, unknown> {
    const secrets = this.updatedSecrets([], params.envVars);
    const env = this.updatedContainerEnv(
      [],
      params.service,
      params.envVars
    );
    return {
      location: this.credentials!.location,
      tags: this.serviceTags(
        params.environment,
        params.service,
        params.workloadKind
      ),
      properties: {
        environmentId: params.managedEnvironmentId,
        configuration: {
          activeRevisionsMode: 'Single',
          secrets,
          registries: [this.registryCredentials()],
          ...(params.workloadKind === 'web'
            ? {
                ingress: {
                  external: params.service.buildConfig.public !== false,
                  targetPort: this.targetPort(env, secrets),
                  allowInsecure: false,
                  transport: 'auto',
                },
              }
            : {}),
        },
        template: {
          containers: [
            {
              name: this.containerName(params.service.name),
              image: BOOTSTRAP_IMAGE,
              command: ['/bin/sh'],
              args: ['-lc', 'while true; do sleep 3600; done'],
              env,
              resources: {
                cpu: this.credentials!.cpu,
                memory: this.credentials!.memory,
              },
            },
          ],
          scale: this.scale(params.workloadKind),
        },
      },
    };
  }

  private async containerAppPatch(params: {
    app: AzureContainerApp;
    environment: Environment;
    service: Service;
    envVars: Record<string, string>;
    workloadKind: Exclude<WorkloadKind, 'cron'>;
    deleteKeys?: string[];
  }): Promise<Record<string, unknown>> {
    const currentContainer = this.primaryContainer(params.app);
    const liveSecrets = await this.client!.listContainerAppSecrets(
      params.app.id
    );
    const expectedSecretNames = (
      params.app.properties?.configuration?.secrets ?? []
    ).flatMap((secret) => secret.name ? [secret.name] : []);
    const secretsWithValues = new Map(
      liveSecrets.flatMap((secret) =>
        secret.name && typeof secret.value === 'string'
          ? [[secret.name, secret.value] as const]
          : []
      )
    );
    const unavailable = expectedSecretNames.filter(
      (name) => !secretsWithValues.has(name)
    );
    if (unavailable.length > 0) {
      throw new Error(
        `Azure did not return values for existing Container App secrets: ${unavailable.join(', ')}. Hypervibe refused an update that could erase them.`
      );
    }
    const deleteKeys = params.deleteKeys ?? [];
    const secrets = this.updatedSecrets(
      Array.from(secretsWithValues, ([name, value]) => ({ name, value })),
      params.envVars,
      deleteKeys
    );
    const env = this.updatedContainerEnv(
      currentContainer.env ?? [],
      params.service,
      params.envVars,
      deleteKeys
    );
    const currentTemplate = {
      ...(params.app.properties?.template ?? {}),
    };
    delete currentTemplate.revisionSuffix;
    const currentIngress = params.app.properties?.configuration?.ingress
      ? { ...params.app.properties.configuration.ingress }
      : undefined;
    if (currentIngress) delete currentIngress.fqdn;
    const targetPort = this.targetPort(env, secrets);
    const probes = this.probes(
      params.service,
      params.workloadKind,
      targetPort,
      currentContainer.image !== BOOTSTRAP_IMAGE
    );
    const nextContainer: AzureContainerAppContainer = {
      ...currentContainer,
      env,
      resources: {
        cpu: this.credentials!.cpu,
        memory: this.credentials!.memory,
      },
      ...(probes.length > 0 ? { probes } : { probes: [] }),
    };
    return {
      location: params.app.location,
      tags: {
        ...(params.app.tags ?? {}),
        ...this.serviceTags(
          params.environment,
          params.service,
          params.workloadKind
        ),
      },
      properties: {
        configuration: {
          activeRevisionsMode: 'Single',
          secrets,
          registries: this.updatedRegistries(params.app),
          ...(params.workloadKind === 'web'
            ? {
                ingress: {
                  ...(currentIngress ?? {}),
                  external: params.service.buildConfig.public !== false,
                  targetPort,
                  allowInsecure: false,
                  transport: 'auto',
                },
              }
            : { ingress: null }),
        },
        template: {
          ...currentTemplate,
          containers: [nextContainer],
          scale: {
            ...(params.app.properties?.template?.scale ?? {}),
            ...this.scale(params.workloadKind),
          },
        },
      },
    };
  }

  private updatedSecrets(
    existing: Array<{ name: string; value: string }>,
    vars: Record<string, string>,
    deleteKeys: string[] = []
  ): Array<{ name: string; value: string }> {
    const byName = new Map(existing.map((secret) => [secret.name, secret.value]));
    byName.set(REGISTRY_SECRET_NAME, this.credentials!.clientSecret);
    for (const key of deleteKeys) {
      byName.delete(this.envSecretName(key));
    }
    for (const [key, value] of Object.entries(this.runtimeEnvVars(vars))) {
      byName.set(this.envSecretName(key), value);
    }
    if (
      !deleteKeys.includes('PORT')
      && !byName.has(this.envSecretName('PORT'))
    ) {
      byName.set(this.envSecretName('PORT'), '80');
    }
    if (!Array.from(byName.values()).every((value) => typeof value === 'string')) {
      throw new Error('Azure Container App secret preservation is incomplete.');
    }
    return Array.from(byName, ([name, value]) => ({ name, value }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private updatedContainerEnv(
    existing: AzureContainerAppEnv[],
    service: Service,
    vars: Record<string, string>,
    deleteKeys: string[] = []
  ): AzureContainerAppEnv[] {
    const runtime = this.runtimeEnvVars(vars);
    const deleted = new Set(deleteKeys);
    const byName = new Map(
      existing
        .filter((entry) =>
          !deleted.has(entry.name)
          && !(entry.name in runtime)
          && ![START_COMMAND_KEY, HEALTH_CHECK_PATH_KEY].includes(entry.name)
        )
        .map((entry) => [entry.name, { ...entry }])
    );
    for (const key of deleted) byName.delete(key);
    for (const key of Object.keys(runtime)) {
      byName.set(key, {
        name: key,
        secretRef: this.envSecretName(key),
      });
    }
    if (!deleted.has('PORT') && !byName.has('PORT')) {
      byName.set('PORT', {
        name: 'PORT',
        secretRef: this.envSecretName('PORT'),
      });
    }
    byName.set(START_COMMAND_KEY, {
      name: START_COMMAND_KEY,
      value: this.requiredStartCommand(service),
    });
    const healthPath = service.buildConfig.healthCheckPath?.trim();
    if (healthPath && serviceWorkloadKind(service) === 'web') {
      byName.set(HEALTH_CHECK_PATH_KEY, {
        name: HEALTH_CHECK_PATH_KEY,
        value: healthPath,
      });
    } else {
      byName.delete(HEALTH_CHECK_PATH_KEY);
    }
    return Array.from(byName.values())
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private updatedRegistries(
    app: AzureContainerApp
  ): Array<Record<string, unknown>> {
    const existing = app.properties?.configuration?.registries ?? [];
    return [
      ...existing.filter(
        (registry) =>
          registry.server?.toLowerCase() !== this.credentials!.registryServer
      ),
      this.registryCredentials(),
    ];
  }

  private registryCredentials(): Record<string, string> {
    return {
      server: this.credentials!.registryServer,
      username: this.credentials!.clientId,
      passwordSecretRef: REGISTRY_SECRET_NAME,
    };
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

  private targetPort(
    env: AzureContainerAppEnv[],
    secrets: Array<{ name: string; value: string }>
  ): number {
    const portEntry = env.find((entry) => entry.name === 'PORT');
    const secretValues = new Map(
      secrets.map((secret) => [secret.name, secret.value])
    );
    const value = portEntry?.value
      ?? (portEntry?.secretRef
        ? secretValues.get(portEntry.secretRef)
        : undefined);
    if (value && this.validPort(value)) {
      return Number(value);
    }
    return 80;
  }

  private probes(
    service: Service,
    workloadKind: Exclude<WorkloadKind, 'cron'>,
    port: number,
    imageReady: boolean
  ): NonNullable<AzureContainerAppContainer['probes']> {
    const path = service.buildConfig.healthCheckPath?.trim();
    if (workloadKind !== 'web' || !path || !imageReady) return [];
    return [
      {
        type: 'Liveness',
        httpGet: { path, port, scheme: 'HTTP' },
        initialDelaySeconds: 10,
        periodSeconds: 10,
        timeoutSeconds: 5,
        failureThreshold: 6,
      },
      {
        type: 'Readiness',
        httpGet: { path, port, scheme: 'HTTP' },
        initialDelaySeconds: 5,
        periodSeconds: 5,
        timeoutSeconds: 5,
        failureThreshold: 12,
      },
    ];
  }

  private scale(
    workloadKind: Exclude<WorkloadKind, 'cron'>
  ): { minReplicas: number; maxReplicas: number } {
    return workloadKind === 'worker'
      ? { minReplicas: 1, maxReplicas: 1 }
      : { minReplicas: 0, maxReplicas: 10 };
  }

  private primaryContainer(app: AzureContainerApp): AzureContainerAppContainer {
    const containers = app.properties?.template?.containers;
    if (!Array.isArray(containers) || containers.length !== 1) {
      throw new Error(
        `Azure Container App ${app.id} must contain exactly one Hypervibe-managed container.`
      );
    }
    return containers[0]!;
  }

  private observedWorkloadKind(
    app: AzureContainerApp
  ): 'web' | 'worker' {
    const tagged = app.tags?.['hypervibe-workload-kind'];
    if (tagged === 'web' || tagged === 'worker') return tagged;
    return app.properties?.configuration?.ingress ? 'web' : 'worker';
  }

  private runtimeStatus(
    app: AzureContainerApp,
    revisions: AzureContainerAppRevision[]
  ): 'running' | 'failed' | 'empty' | 'unknown' {
    const image = app.properties?.template?.containers?.[0]?.image;
    if (!image || image === BOOTSTRAP_IMAGE) return 'empty';
    const latestName = app.properties?.latestRevisionName;
    const latest = revisions.find((revision) => revision.name === latestName);
    const provisioning = latest?.properties?.provisioningState
      ?? app.properties?.provisioningState;
    const health = latest?.properties?.healthState;
    const running = latest?.properties?.runningState
      ?? app.properties?.runningStatus;
    if ([provisioning, health, running].some(
      (value) =>
        ['Failed', 'Canceled', 'Degraded', 'Unhealthy'].includes(value ?? '')
    )) {
      return 'failed';
    }
    if (
      app.properties?.latestReadyRevisionName === latestName
      && app.properties?.provisioningState === 'Succeeded'
      && ['Running', 'Healthy', 'RunningAtMaxScale'].includes(
        running ?? health ?? ''
      )
    ) {
      return 'running';
    }
    return 'unknown';
  }

  private async waitForManagedEnvironment(
    resourceId: string
  ): Promise<NonNullable<Awaited<ReturnType<
    AzureContainerAppsClient['getManagedEnvironment']
  >>>> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_ENV_READY_ATTEMPTS',
      180
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_ENV_READY_DELAY_MS',
      2000
    );
    let observed = await this.client!.getManagedEnvironment(resourceId);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const state = observed?.properties?.provisioningState;
      if (observed && state === 'Succeeded') return observed;
      if (['Failed', 'Canceled'].includes(state ?? '')) {
        throw new Error(
          `Azure managed environment ${resourceId} entered terminal provisioning state ${state}.`
        );
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
        observed = await this.client!.getManagedEnvironment(resourceId);
      }
    }
    throw new Error(
      `Azure managed environment ${resourceId} did not reach Succeeded after ${attempts} checks.`
    );
  }

  private async waitForContainerApp(
    resourceId: string
  ): Promise<AzureContainerApp> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_AZURE_APP_READY_ATTEMPTS',
      120
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_AZURE_APP_READY_DELAY_MS',
      2000
    );
    let observed = await this.client!.getContainerApp(resourceId);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const state = observed?.properties?.provisioningState;
      if (observed && state === 'Succeeded') return observed;
      if (['Failed', 'Canceled'].includes(state ?? '')) {
        throw new Error(
          `Azure Container App ${resourceId} entered terminal provisioning state ${state}.`
        );
      }
      if (attempt < attempts) {
        await this.delay(delayMs);
        observed = await this.client!.getContainerApp(resourceId);
      }
    }
    throw new Error(
      `Azure Container App ${resourceId} did not reach Succeeded after ${attempts} checks.`
    );
  }

  private environmentName(environment: Environment): string {
    const projectHash = createHash('sha256')
      .update(environment.projectId)
      .digest('hex')
      .slice(0, 8);
    const environmentHash = createHash('sha256')
      .update(environment.name)
      .digest('hex')
      .slice(0, 8);
    return `hv-${projectHash}-${environmentHash}`;
  }

  private appName(environment: Environment, serviceName: string): string {
    const projectHash = createHash('sha256')
      .update(environment.projectId)
      .digest('hex')
      .slice(0, 7);
    const environmentHash = createHash('sha256')
      .update(environment.name)
      .digest('hex')
      .slice(0, 6);
    const serviceHash = createHash('sha256')
      .update(serviceName)
      .digest('hex')
      .slice(0, 8);
    return `hv-${projectHash}-${environmentHash}-${serviceHash}`;
  }

  private containerName(serviceName: string): string {
    return this.sanitizeName(serviceName, 32);
  }

  private sanitizeName(value: string, maxLength: number): string {
    const sanitized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, maxLength)
      .replace(/-$/, '');
    return /^[a-z]/.test(sanitized) && sanitized.length >= 2
      ? sanitized
      : `hv-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
  }

  private environmentTags(
    environment: Environment
  ): Record<string, string> {
    return {
      'hypervibe-managed': 'true',
      'hypervibe-project-id': environment.projectId,
      'hypervibe-environment': environment.name,
    };
  }

  private serviceTags(
    environment: Environment,
    service: Service,
    workloadKind: Exclude<WorkloadKind, 'cron'>
  ): Record<string, string> {
    return {
      ...this.environmentTags(environment),
      'hypervibe-service': service.name,
      'hypervibe-workload-kind': workloadKind,
    };
  }

  private appEnvironmentId(app: AzureContainerApp): string | undefined {
    return app.properties?.environmentId
      ?? app.properties?.managedEnvironmentId;
  }

  private assertAppEnvironment(
    app: AzureContainerApp,
    environmentId: string
  ): void {
    if (
      this.appEnvironmentId(app)?.toLowerCase()
      !== environmentId.toLowerCase()
    ) {
      throw new Error(
        `Bound Azure Container App ${app.id} does not belong to managed environment ${environmentId}.`
      );
    }
  }

  private publicUrl(app: AzureContainerApp): string | undefined {
    const ingress = app.properties?.configuration?.ingress;
    return ingress?.external && ingress.fqdn
      ? `https://${ingress.fqdn}`
      : undefined;
  }

  private envSecretName(key: string): string {
    return `hv-env-${createHash('sha256')
      .update(key)
      .digest('hex')
      .slice(0, 20)}`;
  }

  private requiredStartCommand(service: Service): string {
    const value = service.buildConfig.startCommand?.trim();
    if (!value) {
      throw new Error(
        `Azure Container Apps service ${service.name} requires startCommand.`
      );
    }
    return value;
  }

  private nonCronWorkloadKind(
    service: Service
  ): Exclude<WorkloadKind, 'cron'> {
    const kind = serviceWorkloadKind(service);
    if (kind === 'cron') {
      throw new Error(
        'Azure Container Apps Jobs require a separate lifecycle adapter.'
      );
    }
    return kind;
  }

  private validPort(value: string): boolean {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535;
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
        message: `Azure Container Apps deployment failed for ${service.name}`,
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
    name: 'azure-container-apps',
    displayName: 'Azure Container Apps',
    category: 'deployment',
    credentialsSchema: AzureContainerAppsCredentialsSchema,
    setupHelpUrl:
      'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    credentials: {
      environmentVariableAliases: [
        ['AZURE_TENANT_ID', 'HYPERVIBE_AZURE_TENANT_ID'],
        ['AZURE_SUBSCRIPTION_ID', 'HYPERVIBE_AZURE_SUBSCRIPTION_ID'],
        ['AZURE_CLIENT_ID', 'HYPERVIBE_AZURE_CLIENT_ID'],
        ['AZURE_CLIENT_SECRET', 'HYPERVIBE_AZURE_CLIENT_SECRET'],
        ['AZURE_REGISTRY_SERVER', 'HYPERVIBE_AZURE_REGISTRY_SERVER'],
      ],
    },
    orchestration: {
      project: { shareAcrossEnvironments: false },
      diff: {
        requiresBranchDeployForCode: false,
        serviceCreatesBillable: true,
      },
      ci: {
        displayName: 'Azure Container Apps',
        requiredSecrets: AZURE_CONTAINER_APPS_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          AZURE_TENANT_ID: 'tenantId',
          AZURE_SUBSCRIPTION_ID: 'subscriptionId',
          AZURE_CLIENT_ID: 'clientId',
          AZURE_CLIENT_SECRET: 'clientSecret',
          AZURE_REGISTRY_SERVER: 'registryServer',
        },
        buildGitHubActionsSteps:
          buildAzureContainerAppsGitHubActionsSteps,
      },
      nativeBranchDeploy: {
        ciModeSourcePolicy: 'disconnect',
      },
    },
  },
  factory: (credentials) => {
    const validated = AzureContainerAppsCredentialsSchema.parse(credentials);
    const adapter = new AzureContainerAppsAdapter();
    void adapter.connect(validated);
    return adapter;
  },
});
