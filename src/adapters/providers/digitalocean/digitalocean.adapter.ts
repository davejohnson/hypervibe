import { createHash } from 'crypto';
import type { Component, ComponentType } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import {
  serviceWorkloadKind,
  type Service,
  type WorkloadKind,
} from '../../../domain/entities/service.entity.js';
import type {
  ComponentResult,
  DeployResult,
  DeploymentMutationOptions,
  IProviderAdapter,
  ProviderCapabilities,
  Receipt,
  VerifyResult,
} from '../../../domain/ports/provider.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { parseGitHubRepoFromRemote } from '../../../lib/git-remote.js';
import {
  hashEnvValue,
  type ObservedService,
  type ObservedState,
} from '../../../domain/ports/observe.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { DigitalOceanCacheAdapter } from './digitalocean-cache.adapter.js';
import {
  DigitalOceanClient,
  type DigitalOceanApp,
  type DigitalOceanAppComponent,
  type DigitalOceanAppDomain,
  type DigitalOceanAppEnv,
  type DigitalOceanAppImage,
  type DigitalOceanAppSpec,
} from './digitalocean.client.js';
import { DigitalOceanDatabaseAdapter } from './digitalocean-database.adapter.js';
import {
  DigitalOceanCredentialsSchema,
  type DigitalOceanCredentials,
} from './digitalocean.credentials.js';
import {
  buildDigitalOceanGitHubActionsSteps,
  DIGITALOCEAN_CI_REQUIRED_SECRETS,
} from './digitalocean-ci.workflow.js';

type ComponentCollection = 'services' | 'workers' | 'jobs';

interface ComponentMatch {
  collection: ComponentCollection;
  component: DigitalOceanAppComponent;
}

export class DigitalOceanAdapter implements IProviderAdapter {
  readonly name = 'digitalocean';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['dockerfile', 'buildpack', 'static'],
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

  private credentials: DigitalOceanCredentials | null = null;
  private client: DigitalOceanClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = DigitalOceanCredentialsSchema.parse(credentials);
    this.client = new DigitalOceanClient(this.credentials.apiToken);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await Promise.all([
        this.client.verifyAppAccess(),
        this.client.verifyDatabaseAccess(),
      ]);
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.client = null;
  }

  async createDatabaseAdapter(): Promise<DigitalOceanDatabaseAdapter> {
    if (!this.credentials) {
      throw new Error('DigitalOcean adapter is not connected.');
    }
    const adapter = new DigitalOceanDatabaseAdapter();
    await adapter.connect(this.credentials);
    return adapter;
  }

  async createCacheAdapter(): Promise<DigitalOceanCacheAdapter> {
    if (!this.credentials) {
      throw new Error('DigitalOcean adapter is not connected.');
    }
    const adapter = new DigitalOceanCacheAdapter();
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
    const bindings = parseHostingBindings(environment);
    if (bindings.projectId) {
      try {
        const bound = await this.client.getApp(bindings.projectId);
        if (!bound) {
          return {
            success: false,
            message: 'Failed to ensure DigitalOcean app',
            error: `Bound DigitalOcean app ${bindings.projectId} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`,
          };
        }
        const registryName = (await this.resolveContainerRegistry(true)).name;
        return {
          success: true,
          message: `Using bound DigitalOcean app: ${bound.spec.name}`,
          data: {
            projectId: bound.id,
            projectName: bound.spec.name,
            registryName,
            created: false,
          },
        };
      } catch (error) {
        return {
          success: false,
          message: 'Failed to ensure DigitalOcean app',
          error: `Could not verify bound DigitalOcean app ${bindings.projectId}: ${this.formatError(error)}`,
        };
      }
    }

    const appName = this.appName(environment);
    let matches: DigitalOceanApp[];
    try {
      matches = await this.client.findAppsByName(appName);
    } catch (error) {
      return {
        success: false,
        message: 'Failed to ensure DigitalOcean app',
        error: `Could not check whether DigitalOcean app "${appName}" exists, so Hypervibe refused to create a possible duplicate. ${this.formatError(error)}`,
      };
    }
    if (matches.length > 0) {
      return {
        success: false,
        message: 'Failed to ensure DigitalOcean app',
        error: [
          `DigitalOcean app name "${appName}" is already present: ${matches
            .map((app) => app.id)
            .join(', ')}.`,
          'Hypervibe will not silently adopt a name match. Use hv_import for the intended app or remove the duplicate, then run hv_plan again.',
        ].join(' '),
        data: { duplicateProjectIds: matches.map((app) => app.id).sort() },
      };
    }

    let registryName: string;
    try {
      registryName = (await this.resolveContainerRegistry(true)).name;
    } catch (error) {
      return {
        success: false,
        message: 'Failed to ensure DigitalOcean container registry',
        error: this.formatError(error),
      };
    }

    try {
      const created = await this.client.createApp({
        name: appName,
        region: this.credentials.appRegion,
      });
      return {
        success: true,
        message: `Created DigitalOcean app: ${created.spec.name}`,
        data: {
          projectId: created.id,
          projectName: created.spec.name,
          registryName,
          created: true,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to create DigitalOcean app',
        error: this.formatError(error),
        data: { registryName },
      };
    }
  }

  async ensureComponent(
    type: ComponentType,
    environment: Environment
  ): Promise<ComponentResult> {
    const component: Component = {
      id: '',
      environmentId: environment.id,
      type,
      bindings: {},
      externalId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return {
      component,
      receipt: {
        success: false,
        message: 'DigitalOcean datastores use the provider database/cache adapters and explicit plan actions.',
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
    const appId = bindings.projectId;
    if (!appId) {
      return this.failedDeploy(service, 'No DigitalOcean app is bound to this environment.');
    }

    let attemptedExternalId: string | undefined;
    let attemptedCreate = false;
    try {
      const app = await this.client.getApp(appId);
      if (!app) {
        return this.failedDeploy(
          service,
          `Bound DigitalOcean app ${appId} was not found. Re-run hv_plan before applying.`
        );
      }
      const componentName = this.componentName(service.name);
      const matches = this.componentMatches(app.spec, componentName);
      if (matches.length > 1) {
        return this.failedDeploy(
          service,
          `Multiple DigitalOcean App Platform components match "${componentName}". Hypervibe will not guess which component to update.`,
          appId
        );
      }

      const existing = matches[0];
      let imageUri = this.imageUriForService(service, envVars);
      let pendingImage = false;
      if (options.deferDeployment) {
        const registry = (await this.resolveContainerRegistry(false)).name;
        if (!existing?.component.image) {
          const repository = parseGitHubRepoFromRemote(
            envVars.HYPERVIBE_SOURCE_REPO_URL
          );
          if (!repository) {
            return this.failedDeploy(
              service,
              'DigitalOcean CI deploys require a GitHub gitRemoteUrl so Hypervibe can reserve the exact DOCR repository that the generated workflow will publish.',
              appId
            );
          }
          imageUri =
            `registry.digitalocean.com/${registry}/${repository.toLowerCase()}:hypervibe-pending`;
          pendingImage = true;
        } else {
          imageUri = undefined;
        }
      }
      if (!existing && !imageUri) {
        return this.failedDeploy(
          service,
          `DigitalOcean App Platform needs IMAGE_URI or ${this.imageEnvKey(service)} to create ${service.name}. The CI workflow must publish an exact-SHA image before this action.`,
          appId
        );
      }
      const workloadKind = serviceWorkloadKind(service);
      const targetCollection = this.collectionFor(workloadKind);
      const runtimeEnv = this.runtimeEnvVars(service, envVars);
      const component = this.componentSpec({
        service,
        workloadKind,
        existing: existing?.component,
        imageUri,
        envVars: runtimeEnv,
      });
      const nextSpec = this.replaceComponent(
        app.spec,
        componentName,
        targetCollection,
        component
      );
      attemptedExternalId = this.serviceExternalId(
        app.id,
        targetCollection,
        componentName
      );
      attemptedCreate = !existing;
      const updated = await this.client.updateApp(app.id, nextSpec);
      const updatedMatches = this.componentMatches(
        updated.spec,
        componentName
      );
      if (
        updated.id !== app.id
        || updatedMatches.length !== 1
        || updatedMatches[0]?.collection !== targetCollection
      ) {
        return this.failedDeploy(
          service,
          `DigitalOcean app update did not confirm exactly one ${targetCollection} component named ${componentName}.`,
          appId,
          {
            externalId: attemptedExternalId,
            createdService: attemptedCreate,
            mutationAttempted: true,
          }
        );
      }
      const externalId = attemptedExternalId;
      const url = workloadKind === 'web'
        ? updated.live_url ?? updated.default_ingress
        : undefined;
      return {
        serviceId: service.id,
        externalId,
        ...(url ? { url } : {}),
        status: options.deferDeployment ? 'configured' : 'deploying',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared DigitalOcean App Platform component for exact-SHA CI deployment: ${componentName}`
            : `Configured DigitalOcean App Platform component: ${componentName}`,
          data: {
            appId: updated.id,
            componentName,
            resourceType: targetCollection,
            createdService: !existing,
            ...(!pendingImage && imageUri ? { imageUri } : {}),
            ...(options.deferDeployment
              ? {
                  deploymentDeferred: true,
                  ...(pendingImage ? { pendingImage: true } : {}),
                }
              : {}),
            ...(url ? { url } : {}),
          },
        },
      };
    } catch (error) {
      return this.failedDeploy(
        service,
        this.formatError(error),
        appId,
        attemptedExternalId
          ? {
              externalId: attemptedExternalId,
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
    _options: DeploymentMutationOptions = {}
  ): Promise<Receipt> {
    return this.mutateComponentEnvironment(environment, service, (existing) =>
      this.mergeEnv(existing, this.runtimeEnvVars(service, vars), service)
    );
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    const retired = new Set(keys);
    return this.mutateComponentEnvironment(environment, service, (existing) =>
      existing.filter((entry) => !retired.has(entry.key))
    );
  }

  async deleteService(
    serviceId: string
  ): Promise<{ success: boolean; error?: string; message?: string }> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    const parsed = this.parseServiceExternalId(serviceId);
    if (!parsed) {
      return {
        success: false,
        error: `DigitalOcean service binding "${serviceId}" is invalid. Expected appId:collection:componentName.`,
      };
    }
    try {
      const app = await this.client.getApp(parsed.appId);
      if (!app) {
        return {
          success: true,
          message: `DigitalOcean app ${parsed.appId} is already absent`,
        };
      }
      const matches = this.componentMatches(app.spec, parsed.componentName);
      if (matches.length === 0) {
        return {
          success: true,
          message: `DigitalOcean component ${parsed.componentName} is already absent`,
        };
      }
      if (matches.length > 1) {
        return {
          success: false,
          error: `Multiple DigitalOcean components match "${parsed.componentName}". Refusing ambiguous deletion.`,
        };
      }
      if (matches[0]?.collection !== parsed.collection) {
        return {
          success: false,
          error: `DigitalOcean component ${parsed.componentName} is in ${matches[0]?.collection}, but the reviewed binding targets ${parsed.collection}.`,
        };
      }

      const nextSpec = this.removeComponent(app.spec, parsed.componentName);
      await this.client.updateApp(app.id, nextSpec);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_DIGITALOCEAN_COMPONENT_DELETE_ATTEMPTS',
        30
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_DIGITALOCEAN_COMPONENT_DELETE_DELAY_MS',
        1000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const current = await this.client.getApp(app.id);
        if (!current || this.componentMatches(
          current.spec,
          parsed.componentName
        ).length === 0) {
          return {
            success: true,
            message: `Deleted DigitalOcean component ${parsed.componentName}`,
          };
        }
        if (attempt < attempts) {
          await this.delay(delayMs);
        }
      }
      return {
        success: false,
        error: `DigitalOcean component ${parsed.componentName} remained observable after ${attempts} deletion checks.`,
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
      await this.client.destroyApp(projectId);
      return { success: true };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async attachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
  }): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    try {
      const identity = this.requireDomainServiceIdentity(params);
      const app = await this.client.getApp(identity.appId);
      if (!app) {
        return {
          success: false,
          message: 'Failed to attach DigitalOcean custom domain',
          error: `Bound DigitalOcean app ${identity.appId} was not found.`,
        };
      }
      this.assertDomainServiceExists(app, identity);
      const desiredMatches = this.appSpecDomainMatches(app, params.domain);
      if (desiredMatches.length > 1) {
        throw new Error(`DigitalOcean app ${app.id} contains multiple spec entries for ${params.domain}.`);
      }
      if (desiredMatches.length === 0) {
        await this.client.updateApp(app.id, {
          ...app.spec,
          domains: [
            ...(app.spec.domains ?? []),
            { domain: params.domain, type: 'ALIAS' },
          ],
        });
      }

      const currentApp = await this.client.getApp(app.id);
      if (!currentApp) {
        throw new Error(`DigitalOcean app ${app.id} disappeared after its domain spec was updated.`);
      }
      const current = this.requireSingleObservedDomain(currentApp, params.domain);
      return {
        success: true,
        message: desiredMatches.length > 0
          ? 'DigitalOcean custom domain already attached'
          : 'DigitalOcean custom domain attached',
        data: {
          domain: current.spec.domain,
          customDomainId: current.id,
          created: desiredMatches.length === 0,
          providerVerified: current.phase === 'ACTIVE',
          ...(current.phase ? { certificateStatus: current.phase } : {}),
          dnsRecords: this.appDomainDnsRecords(currentApp, current),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to attach DigitalOcean custom domain',
        error: this.formatError(error),
      };
    }
  }

  async detachCustomDomain(params: {
    projectId?: string;
    serviceId: string;
    environmentId: string;
    domain: string;
    customDomainId?: string;
  }): Promise<Receipt> {
    if (!this.client) throw new Error('Not connected. Call connect() first.');
    try {
      const identity = this.requireDomainServiceIdentity(params);
      const app = await this.client.getApp(identity.appId);
      if (!app) {
        return {
          success: false,
          message: 'Failed to detach DigitalOcean custom domain',
          error: `Bound DigitalOcean app ${identity.appId} was not found, so domain absence cannot be verified.`,
        };
      }
      this.assertDomainServiceExists(app, identity);
      const observedMatches = this.observedDomainMatches(app, params.domain);
      const specMatches = this.appSpecDomainMatches(app, params.domain);
      if (observedMatches.length > 1 || specMatches.length > 1) {
        throw new Error(`DigitalOcean app ${app.id} contains multiple domain identities for ${params.domain}.`);
      }
      const observed = observedMatches[0];
      const specDomain = specMatches[0];
      if (!observed && !specDomain) {
        return {
          success: true,
          message: 'DigitalOcean custom domain is already absent',
          data: { domain: params.domain, customDomainId: params.customDomainId, alreadyAbsent: true },
        };
      }
      if (!observed) {
        throw new Error(`DigitalOcean still has ${params.domain} in the app spec but did not return its durable domain id.`);
      }
      if (params.customDomainId && observed.id !== params.customDomainId) {
        return {
          success: false,
          message: 'DigitalOcean custom-domain identity changed',
          error: `Reviewed custom-domain id ${params.customDomainId} does not match observed id ${observed.id} for ${params.domain}.`,
        };
      }
      if (!specDomain) {
        throw new Error(`DigitalOcean returned domain id ${observed.id}, but ${params.domain} was absent from the full app spec; refusing an unverifiable update.`);
      }

      const remainingDomains = (app.spec.domains ?? []).filter(
        (domain) => domain !== specDomain
      );
      const nextSpec: DigitalOceanAppSpec = { ...app.spec };
      if (remainingDomains.length > 0) nextSpec.domains = remainingDomains;
      else delete nextSpec.domains;
      await this.client.updateApp(app.id, nextSpec);

      const currentApp = await this.client.getApp(app.id);
      if (!currentApp) {
        throw new Error(`DigitalOcean app ${app.id} disappeared after its domain spec was updated.`);
      }
      if (
        this.observedDomainMatches(currentApp, params.domain).length > 0
        || this.appSpecDomainMatches(currentApp, params.domain).length > 0
      ) {
        return {
          success: false,
          message: 'DigitalOcean custom-domain deletion is not complete',
          error: `${params.domain} remains attached to DigitalOcean app ${app.id}.`,
        };
      }
      return {
        success: true,
        message: 'DigitalOcean custom domain detached',
        data: { domain: params.domain, customDomainId: observed.id, deleted: true },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to detach DigitalOcean custom domain',
        error: this.formatError(error),
      };
    }
  }

  async getDeployStatus(
    environment: Environment,
    deploymentId: string
  ): Promise<{ status: string; url?: string }> {
    if (!this.client) {
      return { status: 'unknown' };
    }
    const appId = parseHostingBindings(environment).projectId;
    if (!appId) {
      return { status: 'unknown' };
    }
    const app = await this.client.getApp(appId);
    if (!app) {
      return { status: 'absent' };
    }
    const deployment = app.in_progress_deployment?.id === deploymentId
      ? app.in_progress_deployment
      : app.active_deployment?.id === deploymentId
        ? app.active_deployment
        : app.in_progress_deployment ?? app.active_deployment;
    return {
      status: deployment?.phase?.toLowerCase() ?? 'unknown',
      ...(app.live_url ? { url: app.live_url } : {}),
    };
  }

  async observe(environment: Environment): Promise<ObservedState> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const bindings = parseHostingBindings(environment);
    let app: DigitalOceanApp | null;
    if (bindings.projectId) {
      app = await this.client.getApp(bindings.projectId);
    } else {
      const appName = this.appName(environment);
      const matches = await this.client.findAppsByName(appName);
      if (matches.length > 0) {
        throw new Error([
          `DigitalOcean app name "${appName}" exists without a durable local binding: ${matches
            .map((candidate) => candidate.id)
            .join(', ')}.`,
          'Use hv_import to adopt the intended app; Hypervibe will not silently bind a name match.',
        ].join(' '));
      }
      app = null;
    }

    if (!app) {
      return {
        provider: this.name,
        observedAt: new Date().toISOString(),
        projectExists: false,
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

    const domainOwnerId = this.observedDomainOwnerId(app, bindings);
    const services: ObservedService[] = [];
    for (const collection of this.collections()) {
      for (const component of app.spec[collection] ?? []) {
        services.push(this.observedService(
          app,
          collection,
          component,
          domainOwnerId === this.serviceExternalId(app.id, collection, component.name)
        ));
      }
    }
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: app.id,
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

  private async mutateComponentEnvironment(
    environment: Environment,
    service: Service,
    mutate: (env: DigitalOceanAppEnv[]) => DigitalOceanAppEnv[]
  ): Promise<Receipt> {
    if (!this.client) {
      return { success: false, message: 'Not connected' };
    }
    const bindings = parseHostingBindings(environment);
    const appId = bindings.projectId;
    if (!appId) {
      return {
        success: false,
        message: `Failed to update DigitalOcean environment variables for ${service.name}`,
        error: 'No DigitalOcean app is bound to this environment.',
      };
    }
    try {
      const app = await this.client.getApp(appId);
      if (!app) {
        return {
          success: false,
          message: `Failed to update DigitalOcean environment variables for ${service.name}`,
          error: `Bound DigitalOcean app ${appId} was not found.`,
        };
      }
      const componentName = this.componentName(service.name);
      const matches = this.componentMatches(app.spec, componentName);
      if (matches.length !== 1) {
        return {
          success: false,
          message: `Failed to update DigitalOcean environment variables for ${service.name}`,
          error: matches.length === 0
            ? `DigitalOcean component ${componentName} was not found.`
            : `Multiple DigitalOcean components match ${componentName}; refusing an ambiguous update.`,
          data: { staleBinding: matches.length === 0 },
        };
      }
      const match = matches[0]!;
      const nextComponent = {
        ...match.component,
        envs: mutate(match.component.envs ?? []),
      };
      const nextSpec = this.replaceComponent(
        app.spec,
        componentName,
        match.collection,
        nextComponent
      );
      await this.client.updateApp(app.id, nextSpec);
      return {
        success: true,
        message: `Updated DigitalOcean environment variables for ${componentName}`,
        data: {
          appId: app.id,
          componentName,
          variableCount: nextComponent.envs.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to update DigitalOcean environment variables for ${service.name}`,
        error: this.formatError(error),
      };
    }
  }

  private componentSpec(input: {
    service: Service;
    workloadKind: WorkloadKind;
    existing?: DigitalOceanAppComponent;
    imageUri?: string;
    envVars: Record<string, string>;
  }): DigitalOceanAppComponent {
    const { service, workloadKind, existing, imageUri, envVars } = input;
    const image = imageUri ? this.parseImageUri(imageUri) : existing?.image;
    const next: DigitalOceanAppComponent = {
      ...(existing ?? {}),
      name: this.componentName(service.name),
      ...(image ? { image } : {}),
      envs: this.mergeEnv(existing?.envs ?? [], envVars, service),
      instance_size_slug:
        existing?.instance_size_slug ?? this.credentials?.appInstanceSize,
      instance_count: existing?.instance_count ?? 1,
    };
    if (imageUri) {
      delete next.github;
      delete next.git;
    }
    if (service.buildConfig.startCommand?.trim()) {
      next.run_command = service.buildConfig.startCommand.trim();
    }
    if (service.buildConfig.dockerfilePath?.trim()) {
      next.dockerfile_path = service.buildConfig.dockerfilePath.trim();
    }
    if (workloadKind === 'web') {
      next.http_port = this.positiveInteger(envVars.PORT, existing?.http_port ?? 8080);
      if (service.buildConfig.public !== false) {
        next.routes = existing?.routes?.length
          ? existing.routes
          : [{
              path: this.componentName(service.name) === 'web'
                ? '/'
                : `/${this.componentName(service.name)}`,
            }];
      } else {
        delete next.routes;
      }
      if (service.buildConfig.healthCheckPath?.trim()) {
        next.health_check = {
          ...(existing?.health_check ?? {}),
          http_path: service.buildConfig.healthCheckPath.trim(),
        };
      }
    }
    if (workloadKind === 'cron') {
      next.kind = 'SCHEDULED';
      next.schedule = { cron: service.buildConfig.cronSchedule?.trim() };
    }
    return next;
  }

  private mergeEnv(
    existing: DigitalOceanAppEnv[],
    vars: Record<string, string>,
    service: Service
  ): DigitalOceanAppEnv[] {
    const merged = new Map(existing.map((entry) => [entry.key, entry]));
    const secretKeys = new Set(service.envVarSpec.secrets ?? []);
    for (const [key, value] of Object.entries(vars)) {
      merged.set(key, {
        key,
        value,
        scope: 'RUN_TIME',
        type: secretKeys.has(key) ? 'SECRET' : 'GENERAL',
      });
    }
    return [...merged.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    );
  }

  private runtimeEnvVars(
    service: Service,
    envVars: Record<string, string>
  ): Record<string, string> {
    const internal = new Set([
      'IMAGE_URI',
      this.imageEnvKey(service),
      'HYPERVIBE_SOURCE_REPO_URL',
      'HYPERVIBE_SOURCE_REVISION',
      'HYPERVIBE_GITHUB_TOKEN',
    ]);
    return Object.fromEntries(
      Object.entries(envVars).filter(([key]) => !internal.has(key))
    );
  }

  private imageUriForService(
    service: Service,
    envVars: Record<string, string>
  ): string | undefined {
    return envVars[this.imageEnvKey(service)]?.trim()
      || envVars.IMAGE_URI?.trim()
      || undefined;
  }

  private imageEnvKey(service: Service): string {
    const serviceKey = service.name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    return `IMAGE_URI_${serviceKey}`;
  }

  private parseImageUri(value: string): DigitalOceanAppImage {
    const withoutScheme = value.replace(/^https?:\/\//, '');
    const digestIndex = withoutScheme.indexOf('@sha256:');
    const digest = digestIndex >= 0
      ? withoutScheme.slice(digestIndex + 1)
      : undefined;
    const reference = digestIndex >= 0
      ? withoutScheme.slice(0, digestIndex)
      : withoutScheme;
    const slash = reference.indexOf('/');
    if (slash <= 0) {
      throw new Error(`Unsupported DigitalOcean image URI: ${value}`);
    }
    const registryHost = reference.slice(0, slash);
    let repositoryPath = reference.slice(slash + 1);
    const lastSlash = repositoryPath.lastIndexOf('/');
    const colon = repositoryPath.lastIndexOf(':');
    const tag = colon > lastSlash ? repositoryPath.slice(colon + 1) : undefined;
    if (tag) {
      repositoryPath = repositoryPath.slice(0, colon);
    }
    if (!repositoryPath) {
      throw new Error(`Unsupported DigitalOcean image URI: ${value}`);
    }

    if (registryHost === 'registry.digitalocean.com') {
      const [registry, ...repositoryParts] = repositoryPath.split('/');
      if (!registry || repositoryParts.length === 0) {
        throw new Error(
          'DigitalOcean Container Registry images must include registry and repository names.'
        );
      }
      return {
        registry_type: 'DOCR',
        registry,
        repository: repositoryParts.join('/'),
        ...(digest ? { digest } : { tag: tag ?? 'latest' }),
        deploy_on_push: { enabled: false },
      };
    }
    if (registryHost === 'ghcr.io') {
      return {
        registry_type: 'GHCR',
        registry: registryHost,
        repository: repositoryPath,
        ...(digest ? { digest } : { tag: tag ?? 'latest' }),
        deploy_on_push: { enabled: false },
      };
    }
    if (
      registryHost === 'docker.io'
      || registryHost === 'registry-1.docker.io'
    ) {
      return {
        registry_type: 'DOCKER_HUB',
        registry: 'docker.io',
        repository: repositoryPath,
        ...(digest ? { digest } : { tag: tag ?? 'latest' }),
        deploy_on_push: { enabled: false },
      };
    }
    throw new Error(
      `DigitalOcean App Platform image registry "${registryHost}" is unsupported. Use DOCR, GHCR, or Docker Hub.`
    );
  }

  private async resolveContainerRegistry(
    createIfMissing: boolean
  ): Promise<{ name: string }> {
    if (!this.client || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const existing = (await this.client.listContainerRegistries())
      .filter((registry) => registry.name?.trim())
      .sort((left, right) => left.name.localeCompare(right.name));
    if (existing.length > 0) {
      return existing[0]!;
    }
    if (!createIfMissing) {
      throw new Error(
        'No DigitalOcean Container Registry exists. Re-run hv_plan so the explicit project action can create Hypervibe\'s free Starter registry before service configuration.'
      );
    }

    const accountUuid = await this.client.getAccountUuid();
    const suffix = accountUuid.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!suffix) {
      throw new Error('DigitalOcean account UUID cannot produce a stable registry name.');
    }
    const name = `hypervibe-${suffix}`.slice(0, 63).replace(/-+$/, '');
    try {
      return await this.client.createContainerRegistry({
        name,
        region: this.credentials.region,
      });
    } catch (error) {
      const observed = await this.client.getContainerRegistry(name);
      if (observed) return observed;
      throw error;
    }
  }

  private observedService(
    app: DigitalOceanApp,
    collection: ComponentCollection,
    component: DigitalOceanAppComponent,
    ownsDomains = false
  ): ObservedService {
    const env = component.envs ?? [];
    const source = component.github?.repo
      ? {
          repo: component.github.repo,
          ...(component.github.branch
            ? { branch: component.github.branch }
            : {}),
        }
      : component.git?.repo_clone_url
        ? {
            repo: component.git.repo_clone_url,
            ...(component.git.branch ? { branch: component.git.branch } : {}),
          }
        : undefined;
    const phase = (
      app.in_progress_deployment?.phase
      ?? app.active_deployment?.phase
      ?? ''
    ).toUpperCase();
    const status: ObservedService['status'] =
      ['ERROR', 'CANCELED', 'SUPERSEDED'].includes(phase)
        ? 'failed'
        : app.active_deployment
          ? 'running'
          : component.image || source
            ? 'unknown'
            : 'empty';
    return {
      name: component.name,
      externalId: this.serviceExternalId(app.id, collection, component.name),
      workloadKind: collection === 'workers'
        ? 'worker'
        : collection === 'jobs'
          ? 'cron'
          : 'web',
      ...(collection === 'services' && app.live_url
        ? { url: app.live_url }
        : {}),
      customDomains: ownsDomains
        ? (app.domains ?? []).map((domain) => domain.spec.domain).sort()
        : [],
      ...(ownsDomains && (app.domains?.length ?? 0) > 0
        ? { customDomainStatus: this.observedDomainStatus(app) }
        : {}),
      config: {
        ...(component.run_command
          ? { startCommand: component.run_command }
          : {}),
        ...(component.schedule?.cron
          ? { cronSchedule: component.schedule.cron }
          : {}),
        ...(component.health_check?.http_path
          ? { healthCheckPath: component.health_check.http_path }
          : {}),
        public: collection === 'services',
      },
      ...(source ? { source } : {}),
      sourceState: source ? 'connected' : 'disconnected',
      envVarKeys: env.map((entry) => entry.key).sort(),
      envVarHashes: Object.fromEntries(
        env
          .filter((entry) =>
            entry.type !== 'SECRET'
            && typeof entry.value === 'string'
          )
          .map((entry) => [entry.key, hashEnvValue(entry.value!)])
      ),
      status,
    };
  }

  private componentMatches(
    spec: DigitalOceanAppSpec,
    componentName: string
  ): ComponentMatch[] {
    const matches: ComponentMatch[] = [];
    for (const collection of this.collections()) {
      for (const component of spec[collection] ?? []) {
        if (component.name === componentName) {
          matches.push({ collection, component });
        }
      }
    }
    return matches;
  }

  private requireDomainServiceIdentity(params: {
    projectId?: string;
    serviceId: string;
  }): { appId: string; collection: ComponentCollection; componentName: string } {
    const identity = this.parseServiceExternalId(params.serviceId);
    if (!identity) {
      throw new Error(`DigitalOcean service binding ${params.serviceId} is malformed.`);
    }
    if (params.projectId && params.projectId !== identity.appId) {
      throw new Error(`DigitalOcean project binding ${params.projectId} does not match service app ${identity.appId}.`);
    }
    if (identity.collection !== 'services') {
      throw new Error(`DigitalOcean custom domains can only attach to public service components, not ${identity.collection}.`);
    }
    return identity;
  }

  private assertDomainServiceExists(
    app: DigitalOceanApp,
    identity: { appId: string; collection: ComponentCollection; componentName: string }
  ): void {
    if (app.id !== identity.appId) {
      throw new Error(`DigitalOcean app identity changed from ${identity.appId} to ${app.id}.`);
    }
    const matches = this.componentMatches(app.spec, identity.componentName).filter(
      (match) => match.collection === identity.collection
    );
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `Bound DigitalOcean service component ${identity.componentName} was not found in app ${app.id}.`
        : `Multiple DigitalOcean service components match ${identity.componentName} in app ${app.id}.`);
    }
  }

  private appSpecDomainMatches(app: DigitalOceanApp, domain: string) {
    return (app.spec.domains ?? []).filter(
      (candidate) => candidate.domain.toLowerCase() === domain.toLowerCase()
    );
  }

  private observedDomainMatches(app: DigitalOceanApp, domain: string): DigitalOceanAppDomain[] {
    return (app.domains ?? []).filter(
      (candidate) => candidate.spec.domain.toLowerCase() === domain.toLowerCase()
    );
  }

  private requireSingleObservedDomain(app: DigitalOceanApp, domain: string): DigitalOceanAppDomain {
    const matches = this.observedDomainMatches(app, domain);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? `DigitalOcean did not return a durable domain id for ${domain} after the app spec update.`
        : `DigitalOcean returned multiple domain ids for ${domain}.`);
    }
    return matches[0]!;
  }

  private appDomainDnsRecords(
    app: DigitalOceanApp,
    domain: DigitalOceanAppDomain
  ): Array<{ name: string; type: string; value: string; purpose: string }> {
    const ingress = this.appIngressHostname(app);
    const records = [{
      name: domain.spec.domain,
      type: 'CNAME',
      value: ingress,
      purpose: 'traffic',
    }];
    for (const validation of domain.spec.validations ?? []) {
      if (!validation.txt_name || !validation.txt_value) {
        throw new Error(`DigitalOcean returned an incomplete TXT validation record for ${domain.spec.domain}.`);
      }
      records.push({
        name: validation.txt_name,
        type: 'TXT',
        value: validation.txt_value,
        purpose: 'verification',
      });
    }
    return records;
  }

  private appIngressHostname(app: DigitalOceanApp): string {
    const raw = app.default_ingress ?? app.live_url;
    if (!raw) {
      throw new Error(`DigitalOcean app ${app.id} did not expose its required ingress hostname.`);
    }
    const normalized = raw.match(/^https?:\/\//i)
      ? new URL(raw).hostname
      : raw.replace(/\/+$/, '');
    if (!normalized) {
      throw new Error(`DigitalOcean app ${app.id} returned an invalid ingress hostname.`);
    }
    return normalized;
  }

  private observedDomainOwnerId(
    app: DigitalOceanApp,
    bindings: ReturnType<typeof parseHostingBindings>
  ): string | undefined {
    if ((app.domains?.length ?? 0) === 0) return undefined;
    const boundOwner = bindings.domainDns?.serviceId;
    if (boundOwner) {
      const identity = this.requireDomainServiceIdentity({
        projectId: app.id,
        serviceId: boundOwner,
      });
      this.assertDomainServiceExists(app, identity);
      return boundOwner;
    }
    const services = app.spec.services ?? [];
    if (services.length !== 1) {
      throw new Error(`DigitalOcean app ${app.id} has custom domains and ${services.length} public services, but no durable domain-to-service binding. Use hv_import to adopt the intended ownership.`);
    }
    return this.serviceExternalId(app.id, 'services', services[0]!.name);
  }

  private observedDomainStatus(app: DigitalOceanApp): NonNullable<ObservedService['customDomainStatus']> {
    return Object.fromEntries((app.domains ?? []).map((domain) => [
      domain.spec.domain,
      {
        providerVerified: domain.phase === 'ACTIVE',
        certificateStatus: domain.phase ?? 'UNKNOWN',
        dnsConfigured: domain.phase === 'ACTIVE',
        dnsRecords: this.appDomainDnsRecords(app, domain),
      },
    ]));
  }

  private replaceComponent(
    spec: DigitalOceanAppSpec,
    componentName: string,
    collection: ComponentCollection,
    component: DigitalOceanAppComponent
  ): DigitalOceanAppSpec {
    const next = this.removeComponent(spec, componentName);
    return {
      ...next,
      [collection]: [
        ...(next[collection] ?? []),
        component,
      ].sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private removeComponent(
    spec: DigitalOceanAppSpec,
    componentName: string
  ): DigitalOceanAppSpec {
    const next: DigitalOceanAppSpec = { ...spec };
    for (const collection of this.collections()) {
      const filtered = (spec[collection] ?? []).filter(
        (component) => component.name !== componentName
      );
      if (filtered.length > 0) {
        next[collection] = filtered;
      } else {
        delete next[collection];
      }
    }
    return next;
  }

  private collectionFor(kind: WorkloadKind): ComponentCollection {
    if (kind === 'worker') return 'workers';
    if (kind === 'cron') return 'jobs';
    return 'services';
  }

  private collections(): ComponentCollection[] {
    return ['services', 'workers', 'jobs'];
  }

  private serviceExternalId(
    appId: string,
    collection: ComponentCollection,
    componentName: string
  ): string {
    return `${appId}:${collection}:${componentName}`;
  }

  private parseServiceExternalId(serviceId: string): {
    appId: string;
    collection: ComponentCollection;
    componentName: string;
  } | null {
    const [appId, collection, ...componentParts] = serviceId.split(':');
    const componentName = componentParts.join(':');
    if (
      !appId
      || !this.collections().includes(collection as ComponentCollection)
      || !componentName
    ) {
      return null;
    }
    return {
      appId,
      collection: collection as ComponentCollection,
      componentName,
    };
  }

  private appName(environment: Environment): string {
    const projectHash = createHash('sha256')
      .update(environment.projectId)
      .digest('hex')
      .slice(0, 8);
    return this.sanitizeName(`hv-${projectHash}-${environment.name}`, 32);
  }

  private componentName(name: string): string {
    return this.sanitizeName(name, 32);
  }

  private sanitizeName(value: string, maxLength: number): string {
    const sanitized = value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, maxLength)
      .replace(/-$/, '');
    if (sanitized.length >= 2) {
      return sanitized;
    }
    return `hv-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`
      .slice(0, maxLength);
  }

  private failedDeploy(
    service: Service,
    error: string,
    appId?: string,
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
        message: `DigitalOcean deployment failed for ${service.name}`,
        error,
        ...(appId || mutation
          ? {
              data: {
                ...(appId ? { appId } : {}),
                ...(mutation
                  ? {
                      createdService: mutation.createdService,
                      mutationAttempted: mutation.mutationAttempted,
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
  }

  private positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    return this.positiveInteger(process.env[name], fallback);
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
    name: 'digitalocean',
    displayName: 'DigitalOcean',
    category: 'deployment',
    credentialsSchema: DigitalOceanCredentialsSchema,
    setupHelpUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    credentials: {
      defaultScalarKey: 'apiToken',
      environmentVariableAliases: [
        ['DIGITALOCEAN_TOKEN', 'HYPERVIBE_DIGITALOCEAN_TOKEN'],
      ],
    },
    orchestration: {
      project: { shareAcrossEnvironments: false },
      diff: {
        requiresBranchDeployForCode: false,
      },
      ci: {
        displayName: 'DigitalOcean App Platform',
        requiredSecrets: DIGITALOCEAN_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          DIGITALOCEAN_TOKEN: 'apiToken',
        },
        buildGitHubActionsSteps: buildDigitalOceanGitHubActionsSteps,
      },
      nativeBranchDeploy: {
        nonNativeSourcePolicy: 'block',
      },
    },
    lifecycle: {
      hosting: { customDomains: 'managed' },
      databaseEngines: ['postgres'],
      cacheEngines: ['redis'],
    },
  },
  factory: (credentials) => {
    const validated = DigitalOceanCredentialsSchema.parse(credentials);
    const adapter = new DigitalOceanAdapter();
    void adapter.connect(validated);
    return adapter;
  },
  derivedAdapters: {
    database: (adapter) =>
      (adapter as DigitalOceanAdapter).createDatabaseAdapter(),
    cache: (adapter) =>
      (adapter as DigitalOceanAdapter).createCacheAdapter(),
  },
});
