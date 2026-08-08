import { createHash } from 'crypto';
import type { ComponentType } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import {
  serviceWorkloadKind,
  type Service,
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
  VercelClient,
  type VercelDeployment,
  type VercelEnvironmentVariable,
  type VercelProject,
  type VercelProjectDomain,
} from './vercel.client.js';
import {
  buildVercelGitHubActionsSteps,
  VERCEL_CI_REQUIRED_SECRETS,
} from './vercel-ci.workflow.js';
import {
  VercelCredentialsSchema,
  type VercelCredentials,
} from './vercel.credentials.js';
import {
  formatVercelScopeBinding,
  formatVercelServiceBinding,
  parseVercelServiceBinding,
} from './vercel.binding.js';

const START_COMMAND_KEY = 'HYPERVIBE_START_COMMAND';
const HEALTH_CHECK_PATH_KEY = 'HYPERVIBE_HEALTH_CHECK_PATH';
const INTERNAL_ENV_KEYS = new Set([
  HEALTH_CHECK_PATH_KEY,
]);
const RESERVED_ENV_KEYS = new Set([
  START_COMMAND_KEY,
  ...INTERNAL_ENV_KEYS,
]);
const ENV_COMMENT = 'Managed by Hypervibe';

interface VercelScope {
  kind: 'team' | 'user';
  id: string;
  binding: string;
  label: string;
  email?: string;
}

interface ObservedVercelService {
  service: ObservedService;
  unknownKeys: string[];
}

export class VercelAdapter implements IProviderAdapter {
  readonly name = 'vercel';

  readonly capabilities: ProviderCapabilities = {
    supportedBuilders: ['buildpack', 'static'],
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

  private credentials: VercelCredentials | null = null;
  private client: VercelClient | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = VercelCredentialsSchema.parse(credentials);
    this.client = new VercelClient(this.credentials);
  }

  async verify(): Promise<VerifyResult> {
    if (!this.client) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const [scope] = await Promise.all([
        this.scope(),
        this.client.listProjects(),
      ]);
      return {
        success: true,
        ...(scope.email ? { email: scope.email } : {}),
      };
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
      const scope = await this.scope();
      const boundId = parseHostingBindings(environment).projectId;
      if (boundId && boundId !== scope.binding) {
        return {
          success: false,
          message: 'Failed to bind Vercel account scope',
          error: `The environment is bound to Vercel scope ${boundId}, but the verified token targets ${scope.binding}. Hypervibe will not silently rebind it.`,
        };
      }
      return {
        success: true,
        message: `Using existing Vercel ${scope.kind}: ${scope.label}`,
        data: {
          projectId: scope.binding,
          projectName: scope.label,
          created: false,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to verify Vercel account scope',
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
        message: 'Vercel Marketplace datastores require their own lifecycle provider.',
      },
    };
  }

  async deploy(
    service: Service,
    environment: Environment,
    envVars: Record<string, string>,
    options: DeploymentMutationOptions = {}
  ): Promise<DeployResult> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const serviceError = this.validateService(service);
    if (serviceError) return this.failedDeploy(service, serviceError);

    const bindings = parseHostingBindings(environment);
    let scope: VercelScope;
    try {
      scope = await this.assertScopeBinding(bindings.projectId);
    } catch (error) {
      return this.failedDeploy(service, this.formatError(error));
    }

    const expectedName = this.serviceProjectName(environment, service.name);
    const existingBinding = bindings.services?.[service.name]?.serviceId;
    let project: VercelProject | null = null;
    let createdService = false;
    let createAttempted = false;
    let attemptedProjectId: string | undefined;
    try {
      if (existingBinding) {
        const binding = parseVercelServiceBinding(existingBinding);
        this.assertServiceScopeBinding(binding.scope.binding, scope);
        project = await this.client.getProject(binding.projectId);
        if (!project) {
          return this.failedDeploy(
            service,
            `Bound Vercel project ${binding.projectId} was not found. Re-run hv_plan; Hypervibe will not create a replacement from a stale binding.`
          );
        }
        this.assertProjectScope(project, scope);
      } else {
        const matches = (await this.client.listProjects())
          .filter((candidate) => candidate.name === expectedName);
        if (matches.length > 0) {
          return this.failedDeploy(
            service,
            [
              `Vercel project name "${expectedName}" is already present: ${matches
                .map((candidate) => candidate.id)
                .join(', ')}.`,
              'Hypervibe will not silently adopt a name match. Use hv_import for the intended project or remove the conflict, then run hv_plan again.',
            ].join(' ')
          );
        }
        createAttempted = true;
        project = await this.client.createProject(expectedName);
        attemptedProjectId = project.id;
        createdService = true;
        this.assertProjectScope(project, scope);
        if (project.name !== expectedName) {
          throw new Error(
            `Vercel returned project ${project.id} outside the reviewed name identity.`
          );
        }
      }

      attemptedProjectId = project.id;
      if (project.link) {
        return this.failedDeploy(
          service,
          `Bound Vercel project ${project.id} has a native Git source. Disconnect it in Vercel and re-run hv_plan before Hypervibe manages exact-SHA CI deployments.`
        );
      }
      await this.syncProjectEnvironmentVariables(project, service, envVars);
      const latest = await this.latestDeployment(project.id);
      const url = latest?.url ? this.deploymentUrl(latest.url) : undefined;
      const serviceBinding = formatVercelServiceBinding(
        scope.binding,
        project.id
      );
      return {
        serviceId: service.id,
        externalId: serviceBinding,
        ...(url ? { url } : {}),
        status: 'configured',
        receipt: {
          success: true,
          message: options.deferDeployment
            ? `Prepared Vercel project for exact-SHA CI deployment: ${project.name}`
            : `Configured source-less Vercel project; an exact-SHA CI deployment is still required: ${project.name}`,
          data: {
            serviceId: serviceBinding,
            vercelProjectId: project.id,
            serviceName: project.name,
            resourceType: 'web',
            createdService,
            deploymentDeferred: true,
            pendingDeployment: !latest,
            ...(url ? { url } : {}),
          },
        },
      };
    } catch (error) {
      return this.failedDeploy(
        service,
        this.formatError(error),
        createAttempted || attemptedProjectId
          ? {
              ...(attemptedProjectId
                ? {
                    externalId: formatVercelServiceBinding(
                      scope.binding,
                      attemptedProjectId
                    ),
                  }
                : {}),
              createdService,
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
        message: 'Failed to update Vercel environment variables',
        error: serviceId
          ? 'Not connected. Call connect() first.'
          : `No Vercel service binding exists for ${service.name}.`,
        data: { staleBinding: !serviceId },
      };
    }
    try {
      const scope = await this.assertScopeBinding(
        parseHostingBindings(environment).projectId
      );
      const binding = parseVercelServiceBinding(serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) {
        return {
          success: false,
          message: 'Failed to update Vercel environment variables',
          error: `Bound Vercel project ${binding.projectId} was not found.`,
          data: { staleBinding: true },
        };
      }
      this.assertProjectScope(project, scope);
      await this.syncProjectEnvironmentVariables(project, service, vars);
      return {
        success: true,
        message: `Updated production Vercel environment variables for ${service.name}`,
        data: {
          serviceId,
          variableCount: Object.keys(this.runtimeEnvVars(vars)).length,
          ...(options.deferDeployment ? { deploymentDeferred: true } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update Vercel environment variables',
        error: this.formatError(error),
      };
    }
  }

  async deleteEnvVars(
    environment: Environment,
    service: Service,
    keys: string[]
  ): Promise<Receipt> {
    const bindings = parseHostingBindings(environment);
    const serviceId = bindings.services?.[service.name]?.serviceId;
    if (!this.client || !serviceId) {
      return {
        success: false,
        message: 'Failed to delete Vercel environment variables',
        error: serviceId
          ? 'Not connected. Call connect() first.'
          : `No Vercel service binding exists for ${service.name}.`,
      };
    }
    const retired = Array.from(new Set(keys))
      .filter((key) => !RESERVED_ENV_KEYS.has(key))
      .sort();
    try {
      const scope = await this.assertScopeBinding(bindings.projectId);
      const binding = parseVercelServiceBinding(serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) {
        return {
          success: false,
          message: 'Failed to delete Vercel environment variables',
          error: `Bound Vercel project ${binding.projectId} was not found.`,
          data: { staleBinding: true },
        };
      }
      this.assertProjectScope(project, scope);
      let variables = await this.client.listProjectEnvironmentVariables(
        binding.projectId
      );
      const deletedKeys: string[] = [];
      for (const key of retired) {
        const matches = this.productionVariables(variables, key);
        this.assertSingleVariableIdentity(key, matches);
        const match = matches[0];
        if (!match) continue;
        this.assertMutableVariable(key, match);
        if (!match.id) {
          throw new Error(
            `Vercel environment variable ${key} has no durable ID; Hypervibe refused an ambiguous deletion.`
          );
        }
        await this.client.deleteProjectEnvironmentVariable(
          binding.projectId,
          match.id
        );
        deletedKeys.push(key);
        variables = variables.filter((candidate) => candidate !== match);
      }

      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_VERCEL_ENV_DELETE_ATTEMPTS',
        30
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_VERCEL_ENV_DELETE_DELAY_MS',
        1000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const observed = await this.client.listProjectEnvironmentVariables(
          binding.projectId
        );
        const remaining = retired.filter(
          (key) => this.productionVariables(observed, key).length > 0
        );
        if (remaining.length === 0) {
          return {
            success: true,
            message: `Deleted explicitly retired production Vercel environment variables for ${service.name}`,
            data: { serviceId, deletedKeys },
          };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      return {
        success: false,
        message: 'Failed to delete Vercel environment variables',
        error: `Vercel project ${binding.projectId} still reports retired environment variable names after ${attempts} checks.`,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to delete Vercel environment variables',
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
      const scope = await this.scope();
      const binding = parseVercelServiceBinding(serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) return { success: true };
      this.assertProjectScope(project, scope);
      await this.client.deleteProject(binding.projectId);
      const attempts = this.positiveIntegerEnv(
        'HYPERVIBE_VERCEL_PROJECT_DELETE_ATTEMPTS',
        120
      );
      const delayMs = this.nonNegativeIntegerEnv(
        'HYPERVIBE_VERCEL_PROJECT_DELETE_DELAY_MS',
        1000
      );
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!await this.client.getProject(binding.projectId)) {
          return { success: true };
        }
        if (attempt < attempts) await this.delay(delayMs);
      }
      return {
        success: false,
        error: `Vercel project ${binding.projectId} remained observable after ${attempts} deletion checks.`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async getDeployStatus(
    environment: Environment,
    serviceId: string
  ): Promise<{ status: string; url?: string }> {
    if (!this.client) return { status: 'unknown' };
    try {
      const scope = await this.assertScopeBinding(
        parseHostingBindings(environment).projectId
      );
      const binding = parseVercelServiceBinding(serviceId);
      this.assertServiceScopeBinding(binding.scope.binding, scope);
      const project = await this.client.getProject(binding.projectId);
      if (!project) return { status: 'absent' };
      this.assertProjectScope(project, scope);
      const deployment = await this.latestDeployment(binding.projectId);
      if (!deployment) return { status: 'empty' };
      const url = deployment.url
        ? this.deploymentUrl(deployment.url)
        : undefined;
      return {
        status: this.deployStatus(deployment),
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
    if (!bindings.projectId) {
      return this.emptyObservation(false);
    }
    const scope = await this.assertScopeBinding(bindings.projectId);
    const projects = await this.client.listProjects();
    for (const project of projects) {
      this.assertProjectScope(project, scope);
    }

    const boundServices = Object.entries(bindings.services ?? {})
      .flatMap(([logicalName, binding]) => {
        if (!binding.serviceId) return [];
        const parsed = parseVercelServiceBinding(binding.serviceId);
        this.assertServiceScopeBinding(parsed.scope.binding, scope);
        return [{
          logicalName,
          binding: parsed.binding,
          projectId: parsed.projectId,
        }];
      });
    const boundIds = new Set(
      boundServices.map((binding) => binding.projectId)
    );
    const prefix = this.servicePrefix(environment);
    const unbound = projects.filter(
      (project) =>
        project.name.startsWith(prefix)
        && !boundIds.has(project.id)
    );
    if (unbound.length > 0) {
      throw new Error([
        `Vercel projects matching this environment exist without durable local bindings: ${unbound
          .map((project) => `${project.name} (${project.id})`)
          .join(', ')}.`,
        'Use hv_import to adopt the intended projects; Hypervibe will not silently bind name matches.',
      ].join(' '));
    }

    const projectsById = new Map(
      projects.map((project) => [project.id, project])
    );
    const observed: ObservedVercelService[] = [];
    for (const binding of boundServices) {
      const project = projectsById.get(binding.projectId);
      if (!project) continue;
      observed.push(await this.observedService(
        binding.logicalName,
        binding.binding,
        project
      ));
    }
    const unknownKeys = observed.flatMap(
      (entry) => entry.unknownKeys.map(
        (key) => `${entry.service.name}:${key}`
      )
    );
    return {
      provider: this.name,
      observedAt: new Date().toISOString(),
      projectExists: true,
      projectId: scope.binding,
      services: observed.map((entry) => entry.service),
      databases: [],
      caches: [],
      completeness: {
        project: 'complete',
        environment: 'complete',
        services: unknownKeys.length > 0 ? 'unknown' : 'complete',
        databases: 'unknown',
        caches: 'unknown',
        storage: 'complete',
      },
      partial: unknownKeys.length > 0,
      warnings: unknownKeys.length > 0
        ? [
            `Vercel did not return decrypted values for production environment variables, so service configuration is unknown for: ${unknownKeys.join(', ')}.`,
          ]
        : [],
    };
  }

  private async observedService(
    logicalName: string,
    serviceBinding: string,
    project: VercelProject
  ): Promise<ObservedVercelService> {
    const [variables, deployments, domains] = await Promise.all([
      this.client!.listProjectEnvironmentVariables(project.id),
      this.client!.listDeployments(project.id),
      this.client!.listProjectDomains(project.id),
    ]);
    const production = variables.filter(
      (variable) => this.targetsProduction(variable)
    );
    const byKey = new Map<string, VercelEnvironmentVariable[]>();
    for (const variable of production) {
      const entries = byKey.get(variable.key) ?? [];
      entries.push(variable);
      byKey.set(variable.key, entries);
    }
    for (const [key, entries] of byKey) {
      this.assertSingleVariableIdentity(key, entries);
      if (INTERNAL_ENV_KEYS.has(key)) {
        this.assertHypervibeInternalVariable(key, entries[0]!);
      }
    }

    const runtime = production.filter(
      (variable) => !RESERVED_ENV_KEYS.has(variable.key)
    );
    const unknownKeys = runtime
      .filter((variable) => !this.variableValueIsKnown(variable))
      .map((variable) => variable.key)
      .sort();
    const knownRuntime = runtime.filter(
      (variable) => this.variableValueIsKnown(variable)
    );
    const healthVariable = byKey.get(HEALTH_CHECK_PATH_KEY)?.[0];
    for (const internal of [healthVariable]) {
      if (internal && !this.variableValueIsKnown(internal)) {
        unknownKeys.push(internal.key);
      }
    }
    const latest = deployments[0];
    const url = latest?.url
      ? this.deploymentUrl(latest.url)
      : undefined;
    const source = this.projectSource(project);
    return {
      service: {
        name: logicalName,
        externalId: serviceBinding,
        workloadKind: 'web',
        ...(url ? { url } : {}),
        customDomains: domains.map((domain) => domain.name).sort(),
        customDomainStatus: this.customDomainStatus(domains),
        config: {
          ...(healthVariable && this.variableValueIsKnown(healthVariable)
            ? { healthCheckPath: healthVariable.value }
            : {}),
          public: true,
        },
        ...(source ? { source } : {}),
        sourceState: project.link ? 'connected' : 'disconnected',
        envVarKeys: runtime.map((variable) => variable.key).sort(),
        envVarHashes: Object.fromEntries(
          knownRuntime.map((variable) => [
            variable.key,
            hashEnvValue(variable.value),
          ])
        ),
        status: latest
          ? this.observedRuntimeStatus(latest)
          : 'empty',
      },
      unknownKeys: Array.from(new Set(unknownKeys)).sort(),
    };
  }

  private async syncProjectEnvironmentVariables(
    project: VercelProject,
    service: Service,
    vars: Record<string, string>
  ): Promise<void> {
    const current = await this.client!.listProjectEnvironmentVariables(
      project.id
    );
    const desired = this.desiredVariables(service, vars);
    const desiredKeys = new Set(desired.map((variable) => variable.key));
    for (const variable of desired) {
      const matches = this.productionVariables(current, variable.key);
      this.assertSingleVariableIdentity(variable.key, matches);
      const existing = matches[0];
      if (existing) {
        this.assertMutableVariable(variable.key, existing);
        if (INTERNAL_ENV_KEYS.has(variable.key)) {
          this.assertHypervibeInternalVariable(variable.key, existing);
        }
      }
    }

    for (const key of INTERNAL_ENV_KEYS) {
      if (desiredKeys.has(key)) continue;
      const matches = this.productionVariables(current, key);
      this.assertSingleVariableIdentity(key, matches);
      const existing = matches[0];
      if (!existing) continue;
      this.assertHypervibeInternalVariable(key, existing);
      if (!existing.id) {
        throw new Error(
          `Vercel internal environment marker ${key} has no durable ID; Hypervibe refused an ambiguous deletion.`
        );
      }
      await this.client!.deleteProjectEnvironmentVariable(
        project.id,
        existing.id
      );
    }
    await this.client!.upsertProjectEnvironmentVariables(project.id, desired);
  }

  private desiredVariables(
    service: Service,
    vars: Record<string, string>
  ): Array<{
    key: string;
    value: string;
    type: 'sensitive';
    target: ['production'];
    comment: string;
  }> {
    const healthCheckPath = service.buildConfig.healthCheckPath?.trim();
    const values = {
      ...this.runtimeEnvVars(vars),
      ...(healthCheckPath
        ? { [HEALTH_CHECK_PATH_KEY]: healthCheckPath }
        : {}),
    };
    return Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        value,
        type: 'sensitive' as const,
        target: ['production'] as ['production'],
        comment: ENV_COMMENT,
      }));
  }

  private runtimeEnvVars(
    vars: Record<string, string>
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(vars).filter(([key]) =>
        key !== 'IMAGE_URI'
        && !key.startsWith('IMAGE_URI_')
        && !key.startsWith('HYPERVIBE_SOURCE_')
        && !RESERVED_ENV_KEYS.has(key)
      )
    );
  }

  private validateService(service: Service): string | undefined {
    const workloadKind = serviceWorkloadKind(service);
    if (workloadKind !== 'web') {
      return 'Vercel Projects support web deployments in this adapter. Workers and cron jobs require a different provider lifecycle.';
    }
    if (service.buildConfig.public === false) {
      return 'Vercel web deployments are public unless separately protected. Hypervibe does not implicitly create deployment-protection policy.';
    }
    if (service.buildConfig.startCommand?.trim()) {
      return 'Vercel source deployments do not run an arbitrary long-lived startCommand. Omit startCommand and use a Vercel-supported framework or static build.';
    }
    if (
      service.buildConfig.buildCommand?.trim()
      || service.buildConfig.dockerfilePath?.trim()
      || service.buildConfig.builder === 'dockerfile'
    ) {
      return 'This Vercel adapter uses provider framework/static auto-detection and does not apply buildCommand or Dockerfile overrides.';
    }
    if ((service.buildConfig.watchPaths?.length ?? 0) > 0) {
      return 'Vercel watchPaths are not supported by the exact-SHA managed workflow, which deploys the complete reviewed commit.';
    }
    if (service.buildConfig.releaseCommand?.trim()) {
      return 'Vercel release commands are not supported. Use declarative database.seedCommand for first seed/bootstrap data, and run schema migrations during application startup.';
    }
    return undefined;
  }

  private async scope(): Promise<VercelScope> {
    if (!this.client) {
      throw new Error('Not connected. Call connect() first.');
    }
    const user = await this.client.getUser();
    if (!user?.id) {
      throw new Error('Vercel returned an incomplete user identity.');
    }
    const teamId = this.client.configuredTeamId;
    if (teamId) {
      const team = await this.client.getTeam(teamId);
      if (!team?.id || team.id !== teamId || !team.slug) {
        throw new Error(
          'Vercel returned a team identity outside the configured team scope.'
        );
      }
      return {
        kind: 'team',
        id: team.id,
        binding: formatVercelScopeBinding('team', team.id),
        label: team.slug,
        ...(user.email ? { email: user.email } : {}),
      };
    }
    return {
      kind: 'user',
      id: user.id,
      binding: formatVercelScopeBinding('user', user.id),
      label: user.username ?? user.email ?? user.id,
      ...(user.email ? { email: user.email } : {}),
    };
  }

  private async assertScopeBinding(
    boundScope?: string
  ): Promise<VercelScope> {
    if (!boundScope) {
      throw new Error(
        'No verified Vercel account-scope binding exists for this environment.'
      );
    }
    const scope = await this.scope();
    if (boundScope !== scope.binding) {
      throw new Error(
        `Bound Vercel scope ${boundScope} does not match the verified token scope ${scope.binding}.`
      );
    }
    return scope;
  }

  private assertProjectScope(
    project: VercelProject,
    scope: VercelScope
  ): void {
    this.assertProjectId(project.id);
    if (project.accountId !== scope.id) {
      throw new Error(
        `Vercel project ${project.id} belongs to account ${project.accountId}, not bound scope ${scope.id}.`
      );
    }
  }

  private assertServiceScopeBinding(
    boundScope: string,
    scope: VercelScope
  ): void {
    if (boundScope !== scope.binding) {
      throw new Error(
        `Bound Vercel service scope ${boundScope} does not match the verified token scope ${scope.binding}.`
      );
    }
  }

  private assertProjectId(value: string): void {
    if (!/^prj_[A-Za-z0-9]+$/.test(value)) {
      throw new Error(
        `Invalid Vercel project binding "${value}". Expected a durable prj_ project ID.`
      );
    }
  }

  private productionVariables(
    variables: VercelEnvironmentVariable[],
    key: string
  ): VercelEnvironmentVariable[] {
    return variables.filter(
      (variable) =>
        variable.key === key
        && this.targetsProduction(variable)
    );
  }

  private targetsProduction(variable: VercelEnvironmentVariable): boolean {
    if (variable.target === undefined) return true;
    return Array.isArray(variable.target)
      ? variable.target.includes('production')
      : variable.target === 'production';
  }

  private assertSingleVariableIdentity(
    key: string,
    variables: VercelEnvironmentVariable[]
  ): void {
    if (variables.length > 1) {
      throw new Error(
        `Vercel project contains multiple production environment variables named ${key}: ${variables
          .map((variable) => variable.id ?? 'missing-id')
          .join(', ')}. Hypervibe will not choose one implicitly.`
      );
    }
  }

  private assertMutableVariable(
    key: string,
    variable: VercelEnvironmentVariable
  ): void {
    if (variable.configurationId) {
      throw new Error(
        `Vercel environment variable ${key} is owned by integration configuration ${variable.configurationId}. Hypervibe refused to overwrite or delete it.`
      );
    }
  }

  private assertHypervibeInternalVariable(
    key: string,
    variable: VercelEnvironmentVariable
  ): void {
    this.assertMutableVariable(key, variable);
    if (variable.comment !== ENV_COMMENT) {
      throw new Error(
        `Reserved Vercel environment marker ${key} is not marked as Hypervibe-owned. Remove or rename the conflicting variable before retrying.`
      );
    }
  }

  private variableValueIsKnown(
    variable: VercelEnvironmentVariable
  ): boolean {
    return ['plain', 'system'].includes(variable.type)
      || variable.decrypted === true;
  }

  private async latestDeployment(
    projectId: string
  ): Promise<VercelDeployment | undefined> {
    return (await this.client!.listDeployments(projectId))[0];
  }

  private observedRuntimeStatus(
    deployment: VercelDeployment
  ): 'running' | 'failed' | 'unknown' {
    if (deployment.readyState === 'READY') return 'running';
    if (
      ['BLOCKED', 'CANCELED', 'ERROR'].includes(deployment.readyState)
    ) {
      return 'failed';
    }
    return 'unknown';
  }

  private deployStatus(deployment: VercelDeployment): string {
    if (deployment.readyState === 'READY') return 'deployed';
    if (
      ['BUILDING', 'INITIALIZING', 'QUEUED'].includes(
        deployment.readyState
      )
    ) {
      return 'deploying';
    }
    if (
      ['BLOCKED', 'CANCELED', 'ERROR'].includes(deployment.readyState)
    ) {
      return 'failed';
    }
    return 'unknown';
  }

  private deploymentUrl(url: string): string {
    return `https://${url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`;
  }

  private projectSource(
    project: VercelProject
  ): { repo?: string; branch?: string } | undefined {
    const link = project.link;
    if (!link) return undefined;
    const repo = link.org && link.repo
      ? `${link.org}/${link.repo}`
      : link.projectNameWithNamespace
        ?? link.projectName
        ?? link.projectUrl;
    const source = {
      ...(repo ? { repo } : {}),
      ...(link.productionBranch ? { branch: link.productionBranch } : {}),
    };
    return Object.keys(source).length > 0 ? source : undefined;
  }

  private customDomainStatus(
    domains: VercelProjectDomain[]
  ): Record<string, { dnsConfigured?: boolean }> {
    return Object.fromEntries(
      domains.map((domain) => [
        domain.name,
        { dnsConfigured: domain.verified },
      ])
    );
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

  private serviceProjectName(
    environment: Environment,
    logicalName: string
  ): string {
    const serviceHash = createHash('sha256')
      .update(logicalName)
      .digest('hex')
      .slice(0, 8);
    return `${this.servicePrefix(environment)}${serviceHash}`;
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
      externalId?: string;
      createdService: boolean;
      mutationAttempted: true;
    }
  ): DeployResult {
    return {
      serviceId: service.id,
      ...(mutation?.externalId
        ? { externalId: mutation.externalId }
        : {}),
      status: 'failed',
      receipt: {
        success: false,
        message: `Vercel deployment configuration failed for ${service.name}`,
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
    name: 'vercel',
    displayName: 'Vercel',
    category: 'deployment',
    credentialsSchema: VercelCredentialsSchema,
    setupHelpUrl: 'https://vercel.com/account/settings/tokens',
    credentials: {
      defaultScalarKey: 'accessToken',
      environmentVariableAliases: [
        [
          'VERCEL_ACCESS_TOKEN',
          'VERCEL_TOKEN',
          'HYPERVIBE_VERCEL_ACCESS_TOKEN',
        ],
      ],
    },
    lifecycle: {
      hosting: { customDomains: 'unsupported' },
    },
    orchestration: {
      project: { shareAcrossEnvironments: true },
      diff: {
        requiresBranchDeployForCode: false,
        serviceCreatesBillable: true,
      },
      ci: {
        displayName: 'Vercel',
        requiredSecrets: VERCEL_CI_REQUIRED_SECRETS,
        secretCredentialKeys: {
          VERCEL_ACCESS_TOKEN: 'accessToken',
        },
        buildGitHubActionsSteps: buildVercelGitHubActionsSteps,
      },
      nativeBranchDeploy: {
        nonNativeSourcePolicy: 'block',
      },
    },
  },
  factory: (credentials) => {
    const validated = VercelCredentialsSchema.parse(credentials);
    const adapter = new VercelAdapter();
    void adapter.connect(validated);
    return adapter;
  },
});
