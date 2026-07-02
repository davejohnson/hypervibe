import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { adapterFactory } from './adapter.factory.js';
import { getProjectScopeHints } from './project-scope.js';
import { DeployOrchestrator } from './deploy.orchestrator.js';
import { CloudflareAdapter, type CloudflareCredentials } from '../../adapters/providers/cloudflare/cloudflare.adapter.js';
import type { GitHubCredentials } from '../../adapters/providers/github/github.adapter.js';
import { syncProjectIntent } from './intent.service.js';
import { InfraTransaction } from './infra.transaction.js';
import { getCloudPrepareProfile, isCloudPrepared } from './cloud-prepare.js';
import { snapshotEnvironmentBindings } from './local-state.transaction.js';
import { resolveProject } from './resolve-project.js';
import { normalizeGitRemoteForBuild } from '../../lib/git-remote.js';
import { hostingProviderForEnvironment } from './hosting-env.service.js';
import { buildRailwayGitHubRepoAccessHelp, isRailwayGitHubRepoAccessError } from './railway-help.js';
import { formatConnectionGuidance } from './connection-guidance.js';
import type { WorkloadKind } from '../entities/service.entity.js';
import type { Receipt } from '../ports/provider.port.js';
import { parseHostingBindings, type IHostingAdapter } from '../ports/hosting.port.js';
import {
  DB_PROVIDERS,
  type DesiredState,
  workloadKindForServiceName,
} from './spec.service.js';
import { resolveGitDeploySource } from './deploy-source.js';
import { provisionBootstrapDatabase, type DbProvision } from './bootstrap-database.js';
import { setupBootstrapEmail } from './bootstrap-email.js';
import { attachBootstrapDomain } from './bootstrap-domain.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const connectionRepo = new ConnectionRepository();

type SourceConfigurableHostingAdapter = {
  connectServiceToRepo?: (params: { serviceId: string; repo: string; branch: string }) => Promise<Receipt>;
  isGitHubRepoAccessible?: (fullRepoName: string) => Promise<boolean | null>;
};

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

  const bindings = parseHostingBindings(latestEnvironment);
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
  verifyHttpHealth?: boolean;
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
    const workloadKind = runtimeConfig?.workloadKind ?? service?.buildConfig.workloadKind ?? workloadKindForServiceName(serviceName, index);
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
  let dbProvision: DbProvision | undefined;

  if (params.databaseProvider) {
    const dbResult = await provisionBootstrapDatabase({
      projectName: params.projectName,
      databaseProvider: params.databaseProvider,
      project,
      environment,
      tx,
    });
    if (!dbResult.ok) {
      return dbResult.failure;
    }
    environment = dbResult.environment;
    dbProvision = dbResult.dbProvision;
    dbEnsureReceipt = dbResult.dbEnsureReceipt;
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
    ...(params.verifyHttpHealth ? { verifyHttpHealth: true } : {}),
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
    const boundServices = parseHostingBindings(latestEnvironment).services ?? {};
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
    const emailResult = await setupBootstrapEmail({
      domain: params.domain,
      workloads,
      environment,
      hostingAdapter,
      scopeHints,
      summary,
    });
    if (emailResult.failure) {
      return emailResult.failure;
    }
  }

  if (params.domain) {
    await attachBootstrapDomain({
      domain: params.domain,
      environment,
      hostingAdapter,
      serviceWorkloads,
      scopeHints,
      targetPlatform,
      deployUrls: deploy.urls,
      summary,
    });
  }

  summary.intent = syncProjectIntent(project.id);
  return { success: deploy.success, summary };
}
