import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { adapterFactory } from './adapter.factory.js';
import { getProjectScopeHints } from './project-scope.js';
import { DeployOrchestrator } from './deploy.orchestrator.js';
import { CloudflareAdapter, type CloudflareCredentials } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import { SendGridAdapter, assessSendGridScopes, type SendGridCredentials } from '../../adapters/providers/sendgrid/sendgrid.adapter.js';
import type { GitHubCredentials } from '../../adapters/providers/github/github.adapter.js';
import { syncProjectIntent } from './intent.service.js';
import { InfraTransaction } from './infra.transaction.js';
import { getCloudPrepareProfile, isCloudPrepared } from './cloud-prepare.js';
import {
  snapshotComponentRecord,
  snapshotEnvironmentBindings,
} from './local-state.transaction.js';
import { resolveProject } from './resolve-project.js';
import { normalizeGitRemoteForBuild } from '../../lib/git-remote.js';
import { hostingProviderForEnvironment } from './hosting-env.service.js';
import { buildRailwayGitHubRepoAccessHelp, isRailwayGitHubRepoAccessError } from './railway-help.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import {
  callCustomDomainAttach,
  customDomainAttachBindingMissingMessage,
  customDomainAttachUnsupportedMessage,
  providerRequiresCustomDomainAttach,
  supportsCustomDomainAttach,
  type DomainAttachCapableAdapter,
} from './domain-attach-policy.js';
import type { Component } from '../entities/component.entity.js';
import type { WorkloadKind } from '../entities/service.entity.js';
import type { Receipt } from '../ports/provider.port.js';
import type { HostingBindings, IHostingAdapter } from '../ports/hosting.port.js';
import {
  DB_PROVIDERS,
  type DesiredState,
  resolveExistingDatabaseState,
  workloadKindForServiceName,
} from './spec.service.js';
import { resolveGitDeploySource } from './deploy-source.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();

type SourceConfigurableHostingAdapter = {
  connectServiceToRepo?: (params: { serviceId: string; repo: string; branch: string }) => Promise<Receipt>;
  isGitHubRepoAccessible?: (fullRepoName: string) => Promise<boolean | null>;
};

type DatabaseEnsuringAdapter = {
  ensureDatabase?: (component: Component, databaseName?: string) => Promise<Receipt>;
};

async function ensureDatabaseIfSupported(
  adapter: unknown,
  component: Component,
  databaseName?: string
): Promise<Receipt | undefined> {
  const databaseAdapter = adapter as DatabaseEnsuringAdapter;
  if (typeof databaseAdapter.ensureDatabase !== 'function') {
    return undefined;
  }
  return databaseAdapter.ensureDatabase(component, databaseName);
}

function defaultPublicForWorkload(workloadKind: WorkloadKind): boolean {
  return workloadKind === 'web';
}

function recordConnectedDeploySource(params: {
  environmentId: string;
  provider: string;
  serviceName: string;
  serviceId: string;
  repo: string;
  branch: string;
  tx: InfraTransaction;
}): void {
  const latestEnvironment = envRepo.findById(params.environmentId);
  if (!latestEnvironment) {
    return;
  }

  const bindings = latestEnvironment.platformBindings as Partial<HostingBindings>;
  const services = { ...(bindings.services ?? {}) };
  services[params.serviceName] = {
    ...(services[params.serviceName] ?? {}),
    serviceId: params.serviceId,
    source: {
      repo: params.repo,
      branch: params.branch,
    },
  };

  snapshotEnvironmentBindings({
    tx: params.tx,
    envRepo,
    environmentId: params.environmentId,
    label: `environment_bindings_deploy_source_${params.serviceName}`,
  });
  envRepo.updatePlatformBindings(params.environmentId, {
    provider: params.provider,
    services,
  });
}

export async function executeBootstrap(params: {
  projectName: string;
  environmentName: string;
  services: string[];
  crons?: DesiredState['crons'];
  domain?: string;
  /** Omit to skip database provisioning entirely. */
  databaseProvider?: (typeof DB_PROVIDERS)[number];
  setupEmail: boolean;
  serviceConfig?: DesiredState['serviceConfig'];
  envVars?: DesiredState['envVars'];
  deploy?: DesiredState['deploy'];
}): Promise<{ success: boolean; summary: Record<string, unknown> }> {
  const tx = new InfraTransaction();
  let project = resolveProject({ projectName: params.projectName });
  if (!project) {
    project = projectRepo.create({ name: params.projectName, defaultPlatform: 'cloudrun' });
    const createdProjectId = project.id;
    tx.addStep({
      id: `project:${createdProjectId}`,
      label: 'project_create',
      resource: { provider: 'hypervibe', type: 'project', id: createdProjectId, name: project.name },
      compensate: async () => ({
        success: projectRepo.delete(createdProjectId),
        message: `Deleted local project ${createdProjectId}`,
      }),
    });
  }
  const scopeHints = getProjectScopeHints(project);

  let environment = envRepo.findByProjectAndName(project.id, params.environmentName);
  if (!environment) {
    environment = envRepo.create({ projectId: project.id, name: params.environmentName });
    const createdEnvironmentId = environment.id;
    tx.addStep({
      id: `environment:${createdEnvironmentId}`,
      label: 'env_create',
      resource: { provider: 'hypervibe', type: 'environment', id: createdEnvironmentId, name: environment.name },
      compensate: async () => ({
        success: envRepo.delete(createdEnvironmentId),
        message: `Deleted local environment ${createdEnvironmentId}`,
      }),
    });
  }

  const serviceWorkloads = params.services.map((serviceName, index) => {
    let service = serviceRepo.findByProjectAndName(project.id, serviceName);
    const runtimeConfig = params.serviceConfig?.[serviceName];
    const workloadKind = service?.buildConfig.workloadKind ?? workloadKindForServiceName(serviceName, index);
    const publicAccess = typeof runtimeConfig?.public === 'boolean'
      ? runtimeConfig.public
      : defaultPublicForWorkload(workloadKind);
    if (!service) {
      service = serviceRepo.create({
        projectId: project.id,
        name: serviceName,
        buildConfig: {
          workloadKind,
          builder: 'nixpacks',
          ...(runtimeConfig?.startCommand ? { startCommand: runtimeConfig.startCommand } : {}),
          ...(runtimeConfig?.releaseCommand ? { releaseCommand: runtimeConfig.releaseCommand } : {}),
          ...(runtimeConfig?.healthCheckPath ? { healthCheckPath: runtimeConfig.healthCheckPath } : {}),
          public: publicAccess,
        },
      });
      const createdServiceId = service.id;
      tx.addStep({
        id: `service:${createdServiceId}`,
        label: 'service_create',
        resource: { provider: 'hypervibe', type: 'service', id: createdServiceId, name: service.name },
        compensate: async () => ({
          success: serviceRepo.delete(createdServiceId),
          message: `Deleted local service ${createdServiceId}`,
        }),
      });
    } else {
      const nextBuildConfig = {
        ...service.buildConfig,
        workloadKind,
        ...(runtimeConfig?.startCommand ? { startCommand: runtimeConfig.startCommand } : {}),
        ...(runtimeConfig?.releaseCommand ? { releaseCommand: runtimeConfig.releaseCommand } : {}),
        ...(runtimeConfig?.healthCheckPath ? { healthCheckPath: runtimeConfig.healthCheckPath } : {}),
        public: publicAccess,
      };
      const buildConfigChanged = JSON.stringify(service.buildConfig) !== JSON.stringify(nextBuildConfig);
      if (buildConfigChanged) {
        service = serviceRepo.update(service.id, {
          buildConfig: nextBuildConfig,
        }) ?? service;
      }
    }
    return service;
  });
  const cronWorkloads = Object.entries(params.crons ?? {}).map(([cronName, cronConfig]) => {
    let service = serviceRepo.findByProjectAndName(project.id, cronName);
    if (!service) {
      service = serviceRepo.create({
        projectId: project.id,
        name: cronName,
        buildConfig: {
          workloadKind: 'cron',
          builder: 'nixpacks',
          cronSchedule: cronConfig.schedule,
          ...(cronConfig.command ? { startCommand: cronConfig.command } : {}),
        },
      });
      const createdServiceId = service.id;
      tx.addStep({
        id: `service:${createdServiceId}`,
        label: 'cron_create',
        resource: { provider: 'hypervibe', type: 'cron', id: createdServiceId, name: service.name },
        compensate: async () => ({
          success: serviceRepo.delete(createdServiceId),
          message: `Deleted local cron job ${createdServiceId}`,
        }),
      });
    } else {
      service = serviceRepo.update(service.id, {
        buildConfig: {
          ...service.buildConfig,
          workloadKind: 'cron',
          builder: service.buildConfig.builder ?? 'nixpacks',
          cronSchedule: cronConfig.schedule,
          ...(cronConfig.command ? { startCommand: cronConfig.command } : {}),
        },
      }) ?? service;
    }
    return service;
  });
  const workloads = [...serviceWorkloads, ...cronWorkloads];

  if (workloads.length === 0) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: 'No workloads resolved for infrastructure apply',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const targetPlatform = hostingProviderForEnvironment(project, environment);
  const cloudPrepareProfile = getCloudPrepareProfile(targetPlatform);
  if (cloudPrepareProfile && !isCloudPrepared(project, targetPlatform)) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `${cloudPrepareProfile.label} is not prepared for Hypervibe deploys. Run hv_connect provider="${targetPlatform}" action="prepare" confirm=true before applying.`,
        action: 'cloud_prepare',
        provider: targetPlatform,
        requiredVersion: cloudPrepareProfile.version,
        requiredApis: cloudPrepareProfile.requiredApis,
        requiredRoles: cloudPrepareProfile.requiredRoles,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  let dbEnsureReceipt: Receipt | undefined;
  let dbProvision: {
    component: Component;
    receipt: { success: boolean; message: string; error?: string; data?: Record<string, unknown> };
    connectionUrl?: string;
    envVars?: Record<string, string>;
  } | undefined;

  if (params.databaseProvider) {
  const databaseProvider = params.databaseProvider;
  const existingDatabase = resolveExistingDatabaseState(environment.id, databaseProvider);

  if (existingDatabase.status === 'match' && existingDatabase.component) {
    if (params.databaseProvider === 'cloudsql') {
      const dbAdapterResult = await adapterFactory.getDatabaseAdapter(params.databaseProvider, project);
      if (!dbAdapterResult.success || !dbAdapterResult.adapter) {
        const cleanup = await tx.rollback();
        return {
          success: false,
          summary: {
            error: dbAdapterResult.error || 'Database adapter unavailable',
            rollback: cleanup,
            transaction: { created: tx.listResources() },
          },
        };
      }
      dbEnsureReceipt = await ensureDatabaseIfSupported(dbAdapterResult.adapter, existingDatabase.component);
      if (dbEnsureReceipt && !dbEnsureReceipt.success) {
        const cleanup = await tx.rollback();
        return {
          success: false,
          summary: {
            error: dbEnsureReceipt.error || dbEnsureReceipt.message,
            rollback: cleanup,
            transaction: { created: tx.listResources() },
            debug: {
              phase: 'db_ensure',
              provider: params.databaseProvider,
              receiptData: dbEnsureReceipt.data ?? null,
            },
          },
        };
      }
    }
    dbProvision = {
      component: existingDatabase.component,
      receipt: {
        success: true,
        message: `Reusing existing postgres on ${params.databaseProvider}`,
        data: {
          phase: 'reuseExisting',
          provider: params.databaseProvider,
          componentId: existingDatabase.component.externalId ?? existingDatabase.component.id,
        },
      },
      connectionUrl: existingDatabase.connectionUrl,
      envVars: existingDatabase.envVars,
    };
  } else {
    const dbAdapterResult = await adapterFactory.getDatabaseAdapter(params.databaseProvider, project);
    if (!dbAdapterResult.success || !dbAdapterResult.adapter) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          error: dbAdapterResult.error || 'Database adapter unavailable',
          rollback: cleanup,
          transaction: { created: tx.listResources() },
        },
      };
    };

    snapshotEnvironmentBindings({
      tx,
      envRepo,
      environmentId: environment.id,
      label: 'environment_bindings_db_provision',
    });
    dbProvision = await dbAdapterResult.adapter.provision('postgres', environment, {
      databaseName: 'app',
    });
    if (!dbProvision.receipt.success) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          error: dbProvision.receipt.error || dbProvision.receipt.message,
          rollback: cleanup,
          transaction: { created: tx.listResources() },
          debug: {
            phase: 'db_provision',
            provider: params.databaseProvider,
            receiptData: dbProvision.receipt.data ?? null,
          },
        },
      };
    }
    const dbReceiptData = (dbProvision.receipt.data ?? {}) as Record<string, unknown>;
    const provisionProjectId =
      (typeof dbReceiptData.projectId === 'string' ? dbReceiptData.projectId : null) ??
      (typeof dbReceiptData.providerProjectId === 'string' ? dbReceiptData.providerProjectId : null);
    const provisionCreatedProject = dbReceiptData.ensureProjectCreated === true;
    if (params.databaseProvider === 'railway' && provisionCreatedProject && provisionProjectId) {
      tx.addStep({
        id: `provider-project:${provisionProjectId}`,
        label: 'db_provision_ensure_project',
        resource: {
          provider: 'railway',
          type: 'project',
          id: provisionProjectId,
          name: params.projectName,
        },
        compensate: async () => {
          const hosting = await adapterFactory.getHostingAdapter(project!);
          if (!hosting.success || !hosting.adapter || typeof hosting.adapter.deleteProject !== 'function') {
            return {
              success: false,
              error: `Manual cleanup required: railway project ${provisionProjectId}`,
            };
          }
          const deleted = await hosting.adapter.deleteProject(provisionProjectId);
          return {
            success: deleted.success,
            error: deleted.error,
            message: deleted.success ? `Deleted provider project ${provisionProjectId}` : undefined,
          };
        },
      });
    }
    // DB provisioning may update provider bindings; refresh the environment object before deploy planning.
    environment = envRepo.findById(environment.id) ?? environment;
    tx.addStep({
      id: `database:${dbProvision.component.externalId ?? dbProvision.component.id}`,
      label: 'db_provision',
      resource: {
        provider: params.databaseProvider,
        type: dbProvision.component.type,
        id: dbProvision.component.externalId ?? dbProvision.component.id,
        metadata: { environmentId: environment.id },
      },
      compensate: async () => dbAdapterResult.adapter!.destroy(dbProvision!.component),
    });

    const existingComponent = componentRepo.findByEnvironmentAndType(environment.id, 'postgres');
    if (existingComponent) {
      snapshotComponentRecord({
        tx,
        componentRepo,
        component: existingComponent,
        label: 'component_record_update',
      });
      const existingBindings = existingComponent.bindings as Record<string, unknown>;
      const existingProvider = typeof existingBindings.provider === 'string' ? existingBindings.provider : undefined;
      const nextBindings = existingProvider && existingProvider !== params.databaseProvider
        ? {
            ...(dbProvision.component.bindings as Record<string, unknown>),
            previousProvider: existingProvider,
            previousExternalId: existingComponent.externalId ?? undefined,
            previousBindings: existingComponent.bindings,
          }
        : dbProvision.component.bindings;
      componentRepo.update(existingComponent.id, {
        bindings: nextBindings,
        externalId: dbProvision.component.externalId ?? undefined,
      });
    } else {
      const createdComponent = componentRepo.create({
        environmentId: environment.id,
        type: 'postgres',
        bindings: dbProvision.component.bindings,
        externalId: dbProvision.component.externalId ?? undefined,
      });
      tx.addStep({
        id: `component:${createdComponent.id}`,
        label: 'component_record_create',
        resource: { provider: 'hypervibe', type: 'component', id: createdComponent.id, name: 'postgres' },
        compensate: async () => ({
          success: componentRepo.delete(createdComponent.id),
          message: `Deleted local component ${createdComponent.id}`,
        }),
      });
    }
  }
  }

  const hostingProject = project.defaultPlatform?.toLowerCase() === targetPlatform
    ? project
    : { ...project, defaultPlatform: targetPlatform };
  const hostingResult = await adapterFactory.getHostingAdapter(hostingProject);
  if (!hostingResult.success || !hostingResult.adapter) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: hostingResult.error || 'Hosting adapter unavailable',
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }
  const hostingAdapter = hostingResult.adapter as unknown as IHostingAdapter;
  if (!hostingAdapter.capabilities || typeof hostingAdapter.deploy !== 'function') {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `Provider ${targetPlatform} is not a hosting adapter`,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const unsupportedReleaseCommands = Object.entries(params.serviceConfig ?? {})
    .filter(([, config]) => Boolean(config?.releaseCommand))
    .map(([serviceName]) => serviceName);
  if (unsupportedReleaseCommands.length > 0 && !hostingAdapter.capabilities.supportsReleaseCommand) {
    const cleanup = await tx.rollback();
    return {
      success: false,
      summary: {
        error: `Provider ${hostingAdapter.name} does not support releaseCommand/predeploy configuration via API for services: ${unsupportedReleaseCommands.join(', ')}. Move the command to migrations.mode="tool" or remove releaseCommand from serviceConfig.`,
        rollback: cleanup,
        transaction: { created: tx.listResources() },
      },
    };
  }

  const orchestrator = new DeployOrchestrator();
  const deploySource = resolveGitDeploySource(project, params.environmentName, params.deploy);
  const deployTrigger = params.deploy?.trigger ?? 'ci';
  const sourceRepoUrl = normalizeGitRemoteForBuild(project.gitRemoteUrl);
  const secretStore = getSecretStore();
  const githubConnection = sourceRepoUrl && hostingAdapter.name === 'cloudrun'
    ? connectionRepo.findBestMatchFromHints('github', scopeHints)
    : null;
  const githubCredentials = githubConnection
    ? secretStore.decryptObject<GitHubCredentials>(githubConnection.credentialsEncrypted)
    : null;
  const sourceEnvVars: Record<string, string> = sourceRepoUrl
    ? {
        HYPERVIBE_SOURCE_REPO_URL: sourceRepoUrl,
        HYPERVIBE_SOURCE_REVISION: deploySource.source?.branch ?? params.deploy?.branches?.production ?? 'main',
        ...(githubCredentials?.apiToken ? { HYPERVIBE_GITHUB_TOKEN: githubCredentials.apiToken } : {}),
      }
    : {};
  const deployEnvVars = {
    ...sourceEnvVars,
    ...(dbProvision?.envVars ?? {}),
    ...(params.envVars ?? {}),
  };
  const deploy = await orchestrator.execute({
    project,
    environment,
    services: workloads,
    envVars: Object.keys(deployEnvVars).length > 0 ? deployEnvVars : undefined,
    adapter: hostingAdapter,
  });

  const summary: Record<string, unknown> = {
    project: project.name,
    environment: environment.name,
    service: serviceWorkloads[0]?.name ?? cronWorkloads[0]?.name,
    services: serviceWorkloads.map((service) => service.name),
    ...(cronWorkloads.length > 0 ? { crons: cronWorkloads.map((service) => service.name) } : {}),
    deploymentRunId: deploy.run.id,
    deploymentSuccess: deploy.success,
    urls: deploy.urls,
    serviceUrls: deploy.serviceUrls,
    primaryUrl: deploy.primaryUrl,
    deploymentCreatedResources: deploy.createdResources,
    deploymentRollback: deploy.rollback,
    transaction: {
      created: tx.listResources(),
    },
    debug: {
      dbProvision: dbProvision
        ? {
            provider: params.databaseProvider,
            receiptData: dbProvision.receipt.data ?? null,
            databaseEnsureReceipt: dbEnsureReceipt
              ? {
                  success: dbEnsureReceipt.success,
                  message: dbEnsureReceipt.message,
                  data: dbEnsureReceipt.data ?? null,
                }
              : undefined,
          }
        : null,
    },
  };

  if (!deploy.success) {
    const cleanup = await tx.rollback();
    summary.rollback = cleanup;
    return {
      success: false,
      summary: {
        ...summary,
        error: deploy.errors.join('; ') || 'Deploy failed',
      },
    };
  }

  if (params.deploy?.strategy === 'branch' && deployTrigger === 'native') {
    if (!deploySource.source) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: deploySource.error || 'Branch deploy source configuration is incomplete',
          rollback: cleanup,
        },
      };
    }

    const latestEnvironment = envRepo.findById(environment.id) ?? environment;
    const latestBindings = latestEnvironment.platformBindings as Record<string, unknown>;
    const boundServices = (latestBindings.services as Record<string, { serviceId: string; url?: string }> | undefined) ?? {};
    const sourceAdapter = hostingAdapter as IHostingAdapter & SourceConfigurableHostingAdapter;

    if (typeof sourceAdapter.connectServiceToRepo !== 'function') {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: `Provider ${hostingAdapter.name} does not support repo-linked deploy source configuration`,
          rollback: cleanup,
        },
      };
    }

    const sourceFailures: string[] = [];
    let repoAccessHelp: ReturnType<typeof buildRailwayGitHubRepoAccessHelp> | undefined;
    for (const service of workloads) {
      const serviceId = boundServices[service.name]?.serviceId;
      if (!serviceId) {
        sourceFailures.push(`${service.name}: missing bound provider service ID`);
        continue;
      }

      const receipt = await sourceAdapter.connectServiceToRepo({
        serviceId,
        repo: deploySource.source.repo,
        branch: deploySource.source.branch,
      });
      if (!receipt.success) {
        const error = receipt.error || receipt.message;
        sourceFailures.push(`${service.name}: ${error}`);
        if (!repoAccessHelp && isRailwayGitHubRepoAccessError(error)) {
          repoAccessHelp = buildRailwayGitHubRepoAccessHelp(deploySource.source.repo);
        }
      } else {
        recordConnectedDeploySource({
          environmentId: environment.id,
          provider: hostingAdapter.name,
          serviceName: service.name,
          serviceId,
          repo: deploySource.source.repo,
          branch: deploySource.source.branch,
          tx,
        });
      }
    }

    if (sourceFailures.length > 0) {
      const cleanup = await tx.rollback();
      return {
        success: false,
        summary: {
          ...summary,
          error: `Failed to configure deploy source for ${sourceFailures.join('; ')}`,
          rollback: cleanup,
          ...(repoAccessHelp
            ? {
                help: repoAccessHelp,
                nextSteps: repoAccessHelp.nextSteps,
              }
            : {}),
        },
      };
    }

    // serviceConnect succeeds even when the Railway GitHub App cannot see the
    // repo (builds work, but the UI shows "repo not found" and pushes never
    // auto-deploy). Verify and surface the GitHub-side fix when needed.
    const repoAccess = typeof sourceAdapter.isGitHubRepoAccessible === 'function'
      ? await sourceAdapter.isGitHubRepoAccessible(deploySource.source.repo)
      : null;

    summary.deploySource = {
      strategy: 'branch',
      trigger: 'native',
      repo: deploySource.source.repo,
      branch: deploySource.source.branch,
      services: serviceWorkloads.map((service) => service.name),
      ...(cronWorkloads.length > 0 ? { crons: cronWorkloads.map((service) => service.name) } : {}),
      ...(repoAccess === false
        ? {
            warning: `Railway's GitHub App cannot access ${deploySource.source.repo}: native Railway pushes to GitHub will NOT auto-deploy until the user grants the Railway GitHub App access, confirms a Railway project member has connected GitHub contributor access, accepts any pending app permission updates, and waits for Railway caches to refresh.`,
            help: buildRailwayGitHubRepoAccessHelp(deploySource.source.repo),
          }
        : {}),
    };
  } else if (params.deploy?.strategy === 'branch') {
    const branch = deploySource.source?.branch
      ?? params.deploy.branches?.production
      ?? params.deploy.branches?.staging
      ?? 'main';
    summary.deploymentMode = 'provision';
    summary.appDeployment = {
      status: 'pending_ci',
      reason: 'Infrastructure is configured; application code deploys when the GitHub Actions branch workflow runs.',
    };
    summary.appDeploymentPending = true;
    summary.deploySource = {
      strategy: 'branch',
      trigger: 'ci',
      ...(deploySource.source ? { repo: deploySource.source.repo } : {}),
      branch,
      services: serviceWorkloads.map((service) => service.name),
      ...(cronWorkloads.length > 0 ? { crons: cronWorkloads.map((service) => service.name) } : {}),
      nextSteps: [
        'Run hv_plan and hv_apply for this environment to create or update the GitHub Actions deploy workflow and sync available provider secrets.',
        `Push to ${branch} or trigger the workflow to build the image and deploy it through provider APIs.`,
        'Use hv_ci_status to inspect workflow runs, then hv_health after a successful workflow run.',
      ],
    };
  }

  if (params.setupEmail) {
    const sgConnection = connectionRepo.findBestMatchFromHints('sendgrid', scopeHints);
    if (sgConnection) {
      const sgCreds = secretStore.decryptObject<SendGridCredentials>(sgConnection.credentialsEncrypted);
      const sgAdapter = new SendGridAdapter();
      sgAdapter.connect(sgCreds);
      const sendgridPermissions = assessSendGridScopes(await sgAdapter.getScopes());
      const missingSendgridScopes: Record<string, string[]> = {};
      if (!sendgridPermissions.hasMailSend) {
        missingSendgridScopes.mailSend = sendgridPermissions.missingScopes.mailSend;
      }
      if (params.domain) {
        if (!sendgridPermissions.canManageDomainAuthentication) {
          missingSendgridScopes.domainAuthentication = sendgridPermissions.missingScopes.domainAuthentication;
        }
      } else if (!sendgridPermissions.canManageDomainAuthentication && !sendgridPermissions.canManageSenderVerification) {
        missingSendgridScopes.domainAuthentication = sendgridPermissions.missingScopes.domainAuthentication;
        missingSendgridScopes.senderVerification = sendgridPermissions.missingScopes.senderVerification;
      }

      if (Object.keys(missingSendgridScopes).length > 0) {
        return {
          success: false,
          summary: {
            ...summary,
            sendgridApiKeySynced: false,
            sendgridApiKeySyncError: `SendGrid API key is valid but cannot complete setupEmail. ${sendgridPermissions.recommendation} ${formatConnectionGuidance('sendgrid', { intro: 'Confirm the SendGrid API key type and permissions.' })}`,
            sendgridMissingScopes: missingSendgridScopes,
          },
        };
      }

      const latestEnvironment = envRepo.findById(environment.id) ?? environment;
      const sendgridFailures: string[] = [];
      for (const service of workloads) {
        const receipt = await hostingAdapter.setEnvVars(latestEnvironment, service, {
          SENDGRID_API_KEY: sgCreds.apiKey,
        });
        if (!receipt.success) {
          sendgridFailures.push(`${service.name}: ${receipt.error || receipt.message}`);
        }
      }
      summary.sendgridApiKeySynced = sendgridFailures.length === 0;
      if (sendgridFailures.length > 0) {
        summary.sendgridApiKeySyncError = sendgridFailures.join('; ');
      }

      if (params.domain) {
        const existingDomains = await sgAdapter.listDomainAuthentications();
        const existingAuth = existingDomains.find((d) => d.domain.toLowerCase() === params.domain!.toLowerCase());
        const auth = existingAuth ?? await sgAdapter.createDomainAuthentication(params.domain, { default: false });
        const records = [auth.dns.dkim1, auth.dns.dkim2, auth.dns.mail_cname].filter(
          (r): r is NonNullable<typeof r> => Boolean(r)
        );

        const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);
        if (cfConnection) {
          const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
          const cfAdapter = new CloudflareAdapter();
          cfAdapter.connect(cfCreds);
          const zone = await cfAdapter.findZoneByName(params.domain);
          if (zone) {
            const dnsResults: Array<{ name: string; type: string; action: string }> = [];
            for (const record of records) {
              const upsert = await cfAdapter.upsertDnsRecord(zone.id, record.host, record.type, record.data, {
                proxied: false,
              });
              dnsResults.push({ name: record.host, type: record.type, action: upsert.action });
            }
            summary.sendgridDnsSynced = true;
            summary.sendgridDnsRecords = dnsResults;
          } else {
            summary.sendgridDnsSynced = false;
            summary.sendgridDnsError = `Cloudflare zone not found for ${params.domain}`;
          }
        } else {
          summary.sendgridDnsSynced = false;
          summary.sendgridDnsError = `No Cloudflare connection available for domain DNS setup. ${formatConnectionGuidance('cloudflare', { scope: params.domain })}`;
        }
      }
    } else {
      summary.sendgridApiKeySynced = false;
      summary.sendgridApiKeySyncError = `No SendGrid connection found. ${formatConnectionGuidance('sendgrid')}`;
    }
  }

  let providerDomainConfigured = false;
  let providerDomainAttachFailed = false;
  if (params.domain) {
    try {
      const latestEnvironment = envRepo.findById(environment.id) ?? environment;
      const latestBindings = latestEnvironment.platformBindings as Record<string, unknown>;
      const boundServices = (latestBindings.services as Record<string, { serviceId: string; url?: string }> | undefined) ?? {};
      const boundProjectId = typeof latestBindings.projectId === 'string' ? latestBindings.projectId : undefined;
      const boundEnvironmentId =
        typeof latestBindings.environmentId === 'string' ? latestBindings.environmentId : null;
      const domainAdapter = hostingAdapter as IHostingAdapter & DomainAttachCapableAdapter;
      const targetService = serviceWorkloads[0];
      const targetServiceId = targetService ? boundServices[targetService.name]?.serviceId : undefined;
      const domainProvider = hostingAdapter.name || targetPlatform;
      const requiresProviderAttach = providerRequiresCustomDomainAttach(domainProvider);

      if (targetService && targetServiceId && boundEnvironmentId && supportsCustomDomainAttach(domainAdapter)) {
        const receipt = await callCustomDomainAttach(domainAdapter, {
          projectId: boundProjectId,
          serviceId: targetServiceId,
          environmentId: boundEnvironmentId,
          domain: params.domain,
        });

        if (!receipt.success) {
          providerDomainAttachFailed = true;
          summary.customDomainAttached = false;
          summary.customDomainError = receipt.error || receipt.message;
        } else {
          providerDomainConfigured = true;
          summary.customDomainAttached = true;
          summary.customDomain = {
            domain: params.domain,
            service: targetService.name,
            created: receipt.data?.created === true,
          };

          const dnsRecords = Array.isArray(receipt.data?.dnsRecords)
            ? receipt.data.dnsRecords as Array<Record<string, unknown>>
            : [];
          const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);

          if (!cfConnection) {
            summary.domainDnsConfigured = false;
            summary.domainDnsError = `No Cloudflare connection available for ${params.domain}. ${formatConnectionGuidance('cloudflare', { scope: params.domain })}`;
          } else {
            const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
            const cfAdapter = new CloudflareAdapter();
            cfAdapter.connect(cfCreds);
            const zone = await cfAdapter.findZoneByName(params.domain);
            if (!zone) {
              summary.domainDnsConfigured = false;
              summary.domainDnsError = `Cloudflare zone not found for ${params.domain}`;
            } else if (dnsRecords.length === 0) {
              summary.domainDnsConfigured = false;
              summary.domainDnsError = `Railway did not return required DNS records for ${params.domain}`;
            } else {
              const results: Array<{ name: string; type: string; target: string; action: string }> = [];
              for (const record of dnsRecords) {
                const name = typeof record.name === 'string' ? record.name : '';
                const type = typeof record.type === 'string' ? record.type : '';
                const value = typeof record.value === 'string' ? record.value : '';
                if (!name || !type || !value) {
                  continue;
                }

                const upsert = await cfAdapter.upsertDnsRecord(zone.id, name, type, value, {
                  proxied: false,
                });
                results.push({ name, type, target: value, action: upsert.action });
              }
              summary.domainDnsConfigured = results.length > 0;
              summary.domainDnsRecords = results;
              if (results.length === 0) {
                summary.domainDnsError = `Railway returned no usable DNS records for ${params.domain}`;
              }
            }
          }
        }
      } else if (requiresProviderAttach) {
        providerDomainAttachFailed = true;
        summary.customDomainAttached = false;
        summary.customDomainError = targetService && targetServiceId && boundEnvironmentId
          ? customDomainAttachUnsupportedMessage(domainProvider, params.domain)
          : customDomainAttachBindingMissingMessage(domainProvider, params.domain);
      }
    } catch (error) {
      providerDomainAttachFailed = true;
      summary.customDomainAttached = false;
      summary.customDomainError = error instanceof Error ? error.message : String(error);
      summary.domainDnsConfigured = false;
    }
  }

  if (!providerDomainConfigured && !providerDomainAttachFailed && params.domain && deploy.urls[0]) {
    try {
      const targetHost = new URL(deploy.urls[0]).hostname;
      const cfConnection = connectionRepo.findBestMatchFromHints('cloudflare', [params.domain, ...scopeHints]);
      if (cfConnection) {
        const cfCreds = secretStore.decryptObject<CloudflareCredentials>(cfConnection.credentialsEncrypted);
        const cfAdapter = new CloudflareAdapter();
        cfAdapter.connect(cfCreds);
        const zone = await cfAdapter.findZoneByName(params.domain);
        if (zone) {
          const result = await cfAdapter.upsertDnsRecord(zone.id, params.domain, 'CNAME', targetHost, { proxied: true });
          summary.domainDnsConfigured = true;
          summary.domainDns = { name: params.domain, type: 'CNAME', target: targetHost, action: result.action };
        } else {
          summary.domainDnsConfigured = false;
          summary.domainDnsError = `Cloudflare zone not found for ${params.domain}`;
        }
      } else {
        summary.domainDnsConfigured = false;
        summary.domainDnsError = `No Cloudflare connection available for ${params.domain}. ${formatConnectionGuidance('cloudflare', { scope: params.domain })}`;
      }
    } catch {
      summary.domainDnsConfigured = false;
    }
  }

  summary.intent = syncProjectIntent(project.id);
  return { success: deploy.success, summary };
}
