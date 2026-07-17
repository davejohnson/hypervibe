import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { AuditRepository } from '../../adapters/db/repositories/audit.repository.js';
import { RailwayAdapter } from '../../adapters/providers/railway/railway.adapter.js';
import type { RailwayProjectDetails } from '../../adapters/providers/railway/railway.adapter.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { RailwayCredentials } from '../entities/connection.entity.js';
import type { ComponentType } from '../entities/component.entity.js';
import { detectGitRemoteUrl } from '../../lib/git-remote.js';
import { syncProjectIntent } from './intent.service.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const auditRepo = new AuditRepository();

export interface ImportCandidate {
  name: string;
  railwayId: string;
  environmentCount: number;
  serviceCount: number;
}

export interface ImportServiceSummary {
  name: string;
  railwayId: string;
  repo: string | null;
  branch: string | null;
  hasGitHubDeploy: boolean;
  instancesByEnv: Record<string, {
    domains: string[];
    customDomains: string[];
    startCommand?: string;
    healthcheckPath?: string;
    numReplicas?: number;
    sleepApplication?: boolean;
  }>;
}

export interface ImportComponentSummary {
  type: ComponentType;
  railwayId: string;
}

export interface RailwayProjectInspection {
  details: RailwayProjectDetails;
  environments: Array<{ name: string; railwayId: string }>;
  services: ImportServiceSummary[];
  components: ImportComponentSummary[];
  storage: Array<{ name: string; railwayId: string; environments: Array<{ name: string; region?: string }> }>;
  envVarNames: string[];
  autoDetected: Record<string, string>;
  needsMapping: string[];
}

export type ImportResult =
  | { status: 'already_exists' }
  | {
    status: 'imported';
    project: { id: string; name: string };
    environments: Array<{ name: string; id: string; railwayId: string }>;
    services: Array<{ name: string; id: string; railwayId: string }>;
    components: Array<{ type: string; environmentId: string; railwayId: string }>;
    intent: unknown;
  };

export interface ImportRailwayProjectOptions {
  force?: boolean;
  storageMappings?: Record<string, string>;
}

export function mapPluginToComponentType(pluginName: string): ComponentType {
  const normalized = pluginName.toLowerCase();
  if (normalized.includes('postgres')) return 'postgres';
  return pluginName;
}

/**
 * Open a connected RailwayAdapter using the stored global Railway connection.
 * Returns null when no Railway connection is configured. Callers own
 * disconnect().
 */
export async function connectRailwayForImport(): Promise<RailwayAdapter | null> {
  const connection = connectionRepo.findByProvider('railway');
  if (!connection) return null;

  const secretStore = getSecretStore();
  const credentials = secretStore.decryptObject<RailwayCredentials>(connection.credentialsEncrypted);
  const adapter = new RailwayAdapter();
  await adapter.connect(credentials);
  return adapter;
}

/** List Railway projects available to import, with environment/service counts. */
export async function listRailwayImportCandidates(adapter: RailwayAdapter): Promise<ImportCandidate[]> {
  const projects = await adapter.listProjects();
  return Promise.all(
    projects.map(async (p) => {
      const details = await adapter.getProjectDetails(p.id);
      return {
        name: p.name,
        railwayId: p.id,
        environmentCount: details?.environments.edges.length ?? 0,
        serviceCount: details?.services.edges.length ?? 0,
      };
    })
  );
}

/**
 * Fetch full details for a Railway project and reshape into raw data for the
 * agent to interpret (environments, services, components, env var names, plus
 * auto-detected environment mappings). Returns null when details cannot be
 * fetched.
 */
export async function inspectRailwayProject(
  adapter: RailwayAdapter,
  railwayProjectId: string
): Promise<RailwayProjectInspection | null> {
  const details = await adapter.getProjectDetails(railwayProjectId);
  if (!details) return null;

  const environments = details.environments.edges.map((e) => ({
    name: e.node.name,
    railwayId: e.node.id,
  }));

  const services: ImportServiceSummary[] = details.services.edges.map((e) => {
    const instances = e.node.serviceInstances?.edges ?? [];
    const instancesByEnv: ImportServiceSummary['instancesByEnv'] = {};

    for (const inst of instances) {
      const envId = inst.node.environmentId;
      instancesByEnv[envId] = {
        domains: inst.node.domains?.serviceDomains?.map((d) => d.domain) ?? [],
        customDomains: inst.node.domains?.customDomains?.map((d) => d.domain) ?? [],
        startCommand: inst.node.startCommand,
        healthcheckPath: inst.node.healthcheckPath,
        numReplicas: inst.node.numReplicas,
        sleepApplication: inst.node.sleepApplication,
      };
    }

    return {
      name: e.node.name,
      railwayId: e.node.id,
      repo: e.node.repoTriggers.edges[0]?.node.repository ?? null,
      branch: e.node.repoTriggers.edges[0]?.node.branch ?? null,
      hasGitHubDeploy: e.node.repoTriggers.edges.length > 0,
      instancesByEnv,
    };
  });

  const components: ImportComponentSummary[] = details.plugins.edges.map((e) => ({
    type: mapPluginToComponentType(e.node.name),
    railwayId: e.node.id,
  }));
  const storage = (details.buckets?.edges ?? []).map((edge) => ({
    name: edge.node.name,
    railwayId: edge.node.id,
    environments: details.environments.edges.flatMap((environment) => {
      const instance = environment.node.config?.buckets?.[edge.node.id];
      return instance && instance.isDeleted !== true ? [{ name: environment.node.name, region: instance.region }] : [];
    }),
  }));

  // Fetch environment variable names (raw data for the agent to interpret),
  // sampled from the first environment's first service.
  let envVarNames: string[] = [];
  if (environments.length > 0 && services.length > 0) {
    const sampleVars = await adapter.getServiceVariables(
      details.id,
      services[0].railwayId,
      environments[0].railwayId
    );
    envVarNames = Object.keys(sampleVars);
  }

  // Auto-detect exact-match environment names; anything else is raw data for
  // the agent to classify.
  const autoDetected: Record<string, string> = {};
  const needsMapping: string[] = [];
  for (const env of environments) {
    const normalized = env.name.toLowerCase();
    if (normalized === 'production' || normalized === 'staging' || normalized === 'development') {
      autoDetected[env.name] = normalized;
    } else {
      needsMapping.push(env.name);
    }
  }

  return { details, environments, services, components, storage, envVarNames, autoDetected, needsMapping };
}

/**
 * Perform the actual import: create the local project, environments (with
 * Railway platform bindings), services, and components.
 */
export async function importRailwayProject(
  details: RailwayProjectDetails,
  environmentMappings: Record<string, string>,
  services: ImportServiceSummary[],
  components: ImportComponentSummary[],
  options: ImportRailwayProjectOptions = {}
): Promise<ImportResult> {
  const existingProject = projectRepo.findByName(details.name);
  if (existingProject && !options.force) {
    return { status: 'already_exists' };
  }

  // Extract git remote URL from service repo triggers
  const repoUrl = services.find((s) => s.repo)?.repo ?? undefined;
  const gitRemoteUrl = repoUrl
    ? `https://github.com/${repoUrl}`
    : detectGitRemoteUrl() ?? undefined;

  const project = existingProject
    ? projectRepo.update(existingProject.id, {
      defaultPlatform: 'railway',
      gitRemoteUrl: gitRemoteUrl ?? existingProject.gitRemoteUrl,
      policies: existingProject.policies,
    }) ?? existingProject
    : projectRepo.create({
      name: details.name,
      defaultPlatform: 'railway',
      gitRemoteUrl,
    });

  // Create environments with Railway bindings
  const createdEnvironments: Array<{ name: string; id: string; railwayId: string }> = [];

  for (const [railwayEnvName, infraType] of Object.entries(environmentMappings)) {
    const railwayEnv = details.environments.edges.find((e) => e.node.name === railwayEnvName);
    if (!railwayEnv) continue;

    const existingEnv = envRepo.findByProjectAndName(project.id, infraType);
    const env = existingEnv
      ? envRepo.update(existingEnv.id, {
        platformBindings: {
          ...existingEnv.platformBindings,
          provider: 'railway',
          projectId: details.id,
          environmentId: railwayEnv.node.id,
          services: (existingEnv.platformBindings as { services?: Record<string, unknown> }).services ?? {},
        },
      }) ?? existingEnv
      : envRepo.create({
        projectId: project.id,
        name: infraType,
        platformBindings: {
          provider: 'railway',
          projectId: details.id,
          environmentId: railwayEnv.node.id,
          services: {},
        },
      });

    const adoptedStorage = Object.entries(options.storageMappings ?? {}).flatMap(([bucketId, desiredName]) => {
      const bucket = details.buckets?.edges.find((edge) => edge.node.id === bucketId)?.node;
      const instance = railwayEnv.node.config?.buckets?.[bucketId];
      if (!bucket || !instance || instance.isDeleted === true || !instance.region) return [];
      return [[desiredName, {
        provider: 'railway', externalId: bucket.id, region: instance.region,
        services: [], envKeys: [], updatedAt: new Date().toISOString(),
      }] as const];
    });
    if (adoptedStorage.length > 0) {
      envRepo.updatePlatformBindings(env.id, {
        storageProviders: { railway: { projectId: details.id, environmentId: railwayEnv.node.id } },
        storage: Object.fromEntries(adoptedStorage),
      });
    }

    createdEnvironments.push({
      name: infraType,
      id: env.id,
      railwayId: railwayEnv.node.id,
    });
  }

  // Create services
  const createdServices: Array<{ name: string; id: string; railwayId: string }> = [];

  for (const svc of services) {
    const firstInstance = Object.values(svc.instancesByEnv)[0];
    const buildConfig = {
      ...(svc.repo ? { builder: 'nixpacks' as const } : {}),
      ...(firstInstance?.startCommand ? { startCommand: firstInstance.startCommand } : {}),
      ...(firstInstance?.healthcheckPath ? { healthCheckPath: firstInstance.healthcheckPath } : {}),
    };
    const existingService = serviceRepo.findByProjectAndName(project.id, svc.name);
    const service = existingService
      ? serviceRepo.update(existingService.id, {
        buildConfig: { ...existingService.buildConfig, ...buildConfig },
        envVarSpec: existingService.envVarSpec,
      }) ?? existingService
      : serviceRepo.create({
        projectId: project.id,
        name: svc.name,
        buildConfig,
        envVarSpec: {},
      });

    createdServices.push({
      name: svc.name,
      id: service.id,
      railwayId: svc.railwayId,
    });

    // Update environment bindings with service info
    for (const env of createdEnvironments) {
      const existingEnv = envRepo.findById(env.id);
      if (existingEnv) {
        const bindings = existingEnv.platformBindings as {
          provider?: string;
          projectId?: string;
          environmentId?: string;
          services?: Record<string, { serviceId: string }>;
        };
        bindings.services = bindings.services || {};
        bindings.services[svc.name] = { serviceId: svc.railwayId };
        envRepo.update(env.id, { platformBindings: bindings });
      }
    }
  }

  // Create components for each environment
  const createdComponents: Array<{ type: string; environmentId: string; railwayId: string }> = [];

  for (const comp of components) {
    for (const env of createdEnvironments) {
      const existingComponent = componentRepo.findByEnvironmentAndType(env.id, comp.type);
      if (existingComponent) {
        componentRepo.update(existingComponent.id, {
          type: comp.type,
          externalId: comp.railwayId,
          bindings: existingComponent.bindings,
        });
      } else {
        componentRepo.create({
          environmentId: env.id,
          type: comp.type,
          externalId: comp.railwayId,
          bindings: {},
        });
      }

      createdComponents.push({
        type: comp.type,
        environmentId: env.id,
        railwayId: comp.railwayId,
      });
    }
  }

  // Audit log
  auditRepo.create({
    action: existingProject ? 'project.reimported' : 'project.imported',
    resourceType: 'project',
    resourceId: project.id,
    details: {
      name: project.name,
      source: 'railway',
      providerProjectId: details.id,
      environmentCount: createdEnvironments.length,
      serviceCount: createdServices.length,
      componentCount: createdComponents.length,
    },
  });

  return {
    status: 'imported',
    project: { id: project.id, name: project.name },
    environments: createdEnvironments,
    services: createdServices,
    components: createdComponents,
    intent: syncProjectIntent(project.id),
  };
}
