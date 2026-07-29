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
  HerokuClient,
  type HerokuApp,
  type HerokuFormation,
  type HerokuRelease,
} from './heroku.client.js';
import {
  buildHerokuGitHubActionsSteps,
  HEROKU_CI_REQUIRED_SECRETS,
} from './heroku-ci.workflow.js';
import {
  HerokuCredentialsSchema,
  type HerokuCredentials,
} from './heroku.credentials.js';

const START_COMMAND_KEY = 'HYPERVIBE_START_COMMAND';
const HEALTH_CHECK_PATH_KEY = 'HYPERVIBE_HEALTH_CHECK_PATH';
const DEPLOY_SHA_KEY = 'HYPERVIBE_DEPLOY_SHA';
const IMAGE_ID_KEY = 'HYPERVIBE_IMAGE_ID';
const INTERNAL_CONFIG_KEYS = new Set([
  START_COMMAND_KEY,
  HEALTH_CHECK_PATH_KEY,
  DEPLOY_SHA_KEY,
  IMAGE_ID_KEY,
]);

interface HerokuServiceBinding {
  appId: string;
  processType: 'web' | 'worker';
  dynoSize: string;
}

export class HerokuAdapter implements IProviderAdapter {
  readonly name = 'heroku';

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

  private credentials: HerokuCredentials | null = null;
  private client: HerokuClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = HerokuCredentialsSchema.parse(credentials);
    this.client = new HerokuClient(this.credentials.apiKey);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const [account] = await Promise.all([
        this.client.getAccount(),
        this.client.listApps(),
      ]);
      return { success: true, email: account.email };
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
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    try {
      const account = await this.client.getAccount();
      const boundId = parseHostingBindings(environment).projectId;
      if (boundId && boundId !== account.id) {
        return {
          success: false,
          message: 'Failed to bind Heroku account',
          error: `The environment is bound to Heroku account ${boundId}, but the verified token belongs to ${account.id}. Hypervibe will not silently rebind it.`,
        };
      }
      return {
        success: true,
        message: `Using existing Heroku account: ${account.email}`,
        data: {
          projectId: account.id,
          projectName: account.email,
          created: false,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to verify Heroku account',
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
        message: 'Heroku add-ons are not implicit service components.',
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
        'Heroku Scheduler is a separate add-on lifecycle and is not supported by the Heroku hosting adapter.'
      );
    }
    if (!service.buildConfig.startCommand?.trim()) {
      return this.failedDeploy(
        service,
        'Heroku services require startCommand so the container runtime command remains declarative and observable.'
      );
    }
    if (workloadKind === 'web' && service.buildConfig.public === false) {
      return this.failedDeploy(
        service,
        'Heroku Common Runtime web processes are public. Use workloadKind "worker" for a service with no public route.'
      );
    }

    const bindings = parseHostingBindings(environment);
    try {
      await this.assertAccountBinding(bindings.projectId);
    } catch (error) {
      return this.failedDeploy(service, this.formatError(error));
    }

    const expectedName = this.serviceName(environment, service.name);
    const existingBinding = bindings.services?.[service.name]?.serviceId;
    let app: HerokuApp | null = null;
    let attemptedAppId: string | undefined;
    let attemptedCreate = false;
    try {
      if (existingBinding) {
        const parsed = this.parseServiceBinding(existingBinding);
        if (parsed.processType !== workloadKind) {
          return this.failedDeploy(
            service,
            `Bound Heroku service ${existingBinding} is a ${parsed.processType} process, but ${service.name} requires ${workloadKind}. Apply the reviewed replace action after the old binding is retired.`
          );
        }
        app = await this.client.getApp(parsed.appId);
        if (!app) {
          return this.failedDeploy(
            service,
            `Bound Heroku app ${parsed.appId} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`
          );
        }
        this.assertContainerApp(app);
      } else {
        const matches = (await this.client.listApps())
          .filter((candidate) => candidate.name === expectedName);
        if (matches.length > 0) {
          return this.failedDeploy(
            service,
            [
              `Heroku app name "${expectedName}" is already present: ${matches
                .map((candidate) => candidate.id)
                .join(', ')}.`,
              'Hypervibe will not silently adopt a name match. Use hv_import for the intended app or remove the conflicting app, then run hv_plan again.',
            ].join(' ')
          );
        }
        attemptedCreate = true;
        app = await this.client.createApp({
          name: expectedName,
          region: this.credentials.region,
          stack: 'container',
        });
        attemptedAppId = app.id;
        if (app.name !== expectedName) {
          throw new Error(
            `Heroku returned app ${app.id} outside the reviewed name identity.`
          );
        }
        this.assertContainerApp(app);
      }

      attemptedAppId = app.id;
      const externalId = this.serviceBinding(
        app.id,
        workloadKind,
        this.credentials.dynoSize
      );
      await this.client.patchConfigVars(
        app.id,
        this.configPatch(service, envVars)
      );
      const url = workloadKind === 'web'
        ? app.web_url ?? undefined
        : undefined;
      return {
        serviceId: service.id,
        externalId,
        ...(url ? { url } : {}),
        status: 'configured',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared Heroku app for exact-SHA CI deployment: ${app.name}`
            : `Configured empty Heroku app; an exact-SHA CI release is still required: ${app.name}`,
          data: {
            serviceId: externalId,
            appId: app.id,
            serviceName: app.name,
            resourceType: workloadKind,
            createdService: attemptedCreate,
            deploymentDeferred: true,
            pendingImage: true,
            ...(url ? { url } : {}),
          },
        },
      };
    } catch (error) {
      return this.failedDeploy(
        service,
        this.formatError(error),
        attemptedAppId
          ? {
              externalId: this.serviceBinding(
                attemptedAppId,
                workloadKind,
                this.credentials.dynoSize
              ),
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
        message: 'Failed to update Heroku config vars',
        error: serviceId
          ? 'Not connected. Call connect() first.'
          : `No Heroku service binding exists for ${service.name}.`,
        data: { staleBinding: !serviceId },
      };
    }
    try {
      const binding = this.parseServiceBinding(serviceId);
      const app = await this.client.getApp(binding.appId);
      if (!app) {
        return {
          success: false,
          message: 'Failed to update Heroku config vars',
          error: `Bound Heroku app ${binding.appId} was not found.`,
          data: { staleBinding: true },
        };
      }
      this.assertContainerApp(app);
      await this.client.patchConfigVars(
        binding.appId,
        this.configPatch(service, vars)
      );
      return {
        success: true,
        message: `Updated Heroku config vars for ${service.name}`,
        data: {
          serviceId,
          variableCount: Object.keys(this.runtimeEnvVars(vars)).length,
          ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update Heroku config vars',
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
        message: 'Failed to delete Heroku config vars',
        error: `No Heroku service binding exists for ${service.name}.`,
      };
    }
    try {
      const binding = this.parseServiceBinding(serviceId);
      const app = await this.client.getApp(binding.appId);
      if (!app) {
        return {
          success: false,
          message: 'Failed to delete Heroku config vars',
          error: `Bound Heroku app ${binding.appId} was not found.`,
          data: { staleBinding: true },
        };
      }
      const retired = Array.from(new Set(keys))
        .filter((key) => !INTERNAL_CONFIG_KEYS.has(key))
        .sort();
      await this.client.patchConfigVars(
        binding.appId,
        Object.fromEntries(retired.map((key) => [key, null]))
      );
      return {
        success: true,
        message: `Deleted explicitly retired Heroku config vars for ${service.name}`,
        data: { serviceId, deletedKeys: retired },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Heroku config vars',
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
      const binding = this.parseServiceBinding(serviceId);
      if (!await this.client.getApp(binding.appId)) {
        return { success: true };
      }
      await this.client.deleteApp(binding.appId);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_HEROKU_APP_DELETE_ATTEMPTS',
        120
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_HEROKU_APP_DELETE_DELAY_MS',
        2000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!await this.client.getApp(binding.appId)) {
          return { success: true };
        }
        if (attempt < attempts) {
          await this.delay(delayMs);
        }
      }
      return {
        success: false,
        error: `Heroku app ${binding.appId} remained observable after ${attempts} deletion checks.`,
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
      const binding = this.parseServiceBinding(serviceId);
      const app = await this.client.getApp(binding.appId);
      if (!app) {
        return { status: 'absent' };
      }
      const [formations, releases] = await Promise.all([
        this.client.listFormations(binding.appId),
        this.client.listReleases(binding.appId),
      ]);
      const formation = formations.find(
        (candidate) => candidate.type === binding.processType
      );
      const status = this.deployStatus(formation, releases[0]);
      const url = binding.processType === 'web'
        ? app.web_url ?? undefined
        : undefined;
      return { status, ...(url ? { url } : {}) };
    } catch {
      return { status: 'unknown' };
    }
  }

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const bindings = parseHostingBindings(environment);
    const account = await this.client.getAccount();
    if (!bindings.projectId) {
      return this.emptyObservation(false);
    }
    if (bindings.projectId !== account.id) {
      throw new Error(
        `Bound Heroku account ${bindings.projectId} does not match the verified token account ${account.id}.`
      );
    }

    const allApps = await this.client.listApps();
    const boundAppIds = new Set<string>();
    for (const binding of Object.values(bindings.services ?? {})) {
      if (binding.serviceId) {
        boundAppIds.add(this.parseServiceBinding(binding.serviceId).appId);
      }
    }
    const prefix = this.servicePrefix(environment);
    const unbound = allApps.filter(
      (app) => app.name.startsWith(prefix) && !boundAppIds.has(app.id)
    );
    if (unbound.length > 0) {
      throw new Error([
        `Heroku apps matching this environment exist without durable local bindings: ${unbound
          .map((app) => `${app.name} (${app.id})`)
          .join(', ')}.`,
        'Use hv_import to adopt the intended apps; Hypervibe will not silently bind name matches.',
      ].join(' '));
    }

    const appsById = new Map(allApps.map((app) => [app.id, app]));
    const services: ObservedService[] = [];
    for (const [logicalName, localBinding] of Object.entries(
      bindings.services ?? {}
    )) {
      if (!localBinding.serviceId) continue;
      const parsed = this.parseServiceBinding(localBinding.serviceId);
      const app = appsById.get(parsed.appId);
      if (!app) continue;
      this.assertContainerApp(app);
      services.push(
        await this.observedService(logicalName, localBinding.serviceId, app, parsed)
      );
    }

    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: account.id,
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

  private async observedService(
    logicalName: string,
    externalId: string,
    app: HerokuApp,
    binding: HerokuServiceBinding
  ): Promise<ObservedService> {
    const [configVars, formations, releases] = await Promise.all([
      this.client!.getConfigVars(binding.appId),
      this.client!.listFormations(binding.appId),
      this.client!.listReleases(binding.appId),
    ]);
    const runtimeVars = Object.fromEntries(
      Object.entries(configVars).filter(([key]) => !INTERNAL_CONFIG_KEYS.has(key))
    );
    const formation = formations.find(
      (candidate) => candidate.type === binding.processType
    );
    return {
      name: logicalName,
      externalId,
      workloadKind: binding.processType,
      ...(binding.processType === 'web' && app.web_url
        ? { url: app.web_url }
        : {}),
      customDomains: [],
      config: {
        ...(configVars[START_COMMAND_KEY]
          ? { startCommand: configVars[START_COMMAND_KEY] }
          : {}),
        ...(configVars[HEALTH_CHECK_PATH_KEY]
          ? { healthCheckPath: configVars[HEALTH_CHECK_PATH_KEY] }
          : {}),
        public: binding.processType === 'web',
      },
      envVarKeys: Object.keys(runtimeVars).sort(),
      envVarHashes: Object.fromEntries(
        Object.entries(runtimeVars).map(([key, value]) => [
          key,
          hashEnvValue(value),
        ])
      ),
      status: this.observedRuntimeStatus(formation, releases[0]),
    };
  }

  private observedRuntimeStatus(
    formation: HerokuFormation | undefined,
    release: HerokuRelease | undefined
  ): 'running' | 'failed' | 'empty' | 'unknown' {
    if (!formation || formation.quantity === 0) return 'empty';
    if (release?.status === 'succeeded') return 'running';
    if (release && ['failed', 'expired'].includes(release.status)) return 'failed';
    return 'unknown';
  }

  private deployStatus(
    formation: HerokuFormation | undefined,
    release: HerokuRelease | undefined
  ): string {
    if (!formation || formation.quantity === 0) return 'empty';
    if (release?.status === 'succeeded') return 'deployed';
    if (release?.status === 'pending') return 'deploying';
    if (release && ['failed', 'expired'].includes(release.status)) return 'failed';
    return 'unknown';
  }

  private configPatch(
    service: Service,
    vars: Record<string, string>
  ): Record<string, string | null> {
    return {
      ...this.runtimeEnvVars(vars),
      [START_COMMAND_KEY]: this.requiredStartCommand(service),
      [HEALTH_CHECK_PATH_KEY]:
        serviceWorkloadKind(service) === 'web'
          ? service.buildConfig.healthCheckPath?.trim() || null
          : null,
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
        && !INTERNAL_CONFIG_KEYS.has(key)
      )
    );
  }

  private requiredStartCommand(service: Service): string {
    const command = service.buildConfig.startCommand?.trim();
    if (!command) {
      throw new Error(
        `Heroku service ${service.name} requires startCommand so the runtime command remains declarative and observable.`
      );
    }
    return command;
  }

  private async assertAccountBinding(boundAccountId?: string): Promise<void> {
    if (!boundAccountId) {
      throw new Error(
        'No verified Heroku account binding exists for this environment.'
      );
    }
    const account = await this.client!.getAccount();
    if (account.id !== boundAccountId) {
      throw new Error(
        `Bound Heroku account ${boundAccountId} does not match the verified token account ${account.id}.`
      );
    }
  }

  private assertContainerApp(app: HerokuApp): void {
    if (app.stack?.name !== 'container') {
      throw new Error(
        `Bound Heroku app ${app.id} uses stack ${app.stack?.name ?? 'unknown'}, not container. Hypervibe will not change an existing app's deployment method implicitly.`
      );
    }
  }

  private servicePrefix(environment: Environment): string {
    const projectHash = createHash('sha256')
      .update(environment.projectId)
      .digest('hex')
      .slice(0, 8);
    const environmentHash = createHash('sha256')
      .update(environment.name)
      .digest('hex')
      .slice(0, 6);
    return `hv-${projectHash}-${environmentHash}-`;
  }

  private serviceName(
    environment: Environment,
    logicalName: string
  ): string {
    const serviceHash = createHash('sha256')
      .update(logicalName)
      .digest('hex')
      .slice(0, 8);
    return `${this.servicePrefix(environment)}${serviceHash}`;
  }

  private serviceBinding(
    appId: string,
    workloadKind: Exclude<WorkloadKind, 'cron'>,
    dynoSize: string
  ): string {
    return `${appId}:${workloadKind}:${dynoSize}`;
  }

  private parseServiceBinding(value: string): HerokuServiceBinding {
    const [appId, processType, dynoSize, ...extra] = value.split(':');
    if (
      !/^[0-9a-f-]{36}$/i.test(appId ?? '')
      || !['web', 'worker'].includes(processType ?? '')
      || !/^[A-Za-z0-9_-]+$/.test(dynoSize ?? '')
      || extra.length > 0
    ) {
      throw new Error(
        `Invalid Heroku service binding "${value}". Expected app-uuid:web|worker:dyno-size.`
      );
    }
    return {
      appId,
      processType: processType as 'web' | 'worker',
      dynoSize,
    };
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
        message: `Heroku deployment failed for ${service.name}`,
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
    name: 'heroku',
    displayName: 'Heroku',
    category: 'deployment',
    credentialsSchema: HerokuCredentialsSchema,
    setupHelpUrl: 'https://dashboard.heroku.com/account',
    credentials: {
      defaultScalarKey: 'apiKey',
      environmentVariableAliases: [
        ['HEROKU_API_KEY', 'HYPERVIBE_HEROKU_API_KEY'],
      ],
    },
    orchestration: {
      project: { shareAcrossEnvironments: true },
      diff: {
        requiresBranchDeployForCode: false,
        serviceCreatesBillable: true,
      },
      ci: {
        displayName: 'Heroku',
        requiredSecrets: HEROKU_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          HEROKU_API_KEY: 'apiKey',
        },
        buildGitHubActionsSteps: buildHerokuGitHubActionsSteps,
      },
    },
  },
  factory: (credentials) => {
    const validated = HerokuCredentialsSchema.parse(credentials);
    const adapter = new HerokuAdapter();
    void adapter.connect(validated);
    return adapter;
  },
});
