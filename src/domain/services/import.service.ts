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

  return { details, environments, services, components, envVarNames, autoDetected, needsMapping };
}

/**
 * Perform the actual import: create the local project, environments (with
 * Railway platform bindings), services, and components.
 */
export async function importRailwayProject(
  details: RailwayProjectDetails,
  environmentMappings: Record<string, string>,
  services: ImportServiceSummary[],
  components: ImportComponentSummary[]
): Promise<ImportResult> {
  // Check if project already exists
  const existingProject = projectRepo.findByName(details.name);
  if (existingProject) {
    return { status: 'already_exists' };
  }

  // Extract git remote URL from service repo triggers
  const repoUrl = services.find((s) => s.repo)?.repo ?? undefined;
  const gitRemoteUrl = repoUrl
    ? `https://github.com/${repoUrl}`
    : detectGitRemoteUrl() ?? undefined;

  // Create the project
  const project = projectRepo.create({
    name: details.name,
    defaultPlatform: 'railway',
    gitRemoteUrl,
  });

  // Create environments with Railway bindings
  const createdEnvironments: Array<{ name: string; id: string; railwayId: string }> = [];

  for (const [railwayEnvName, infraType] of Object.entries(environmentMappings)) {
    const railwayEnv = details.environments.edges.find((e) => e.node.name === railwayEnvName);
    if (!railwayEnv) continue;

    const env = envRepo.create({
      projectId: project.id,
      name: infraType,
      platformBindings: {
        provider: 'railway',
        projectId: details.id,
        environmentId: railwayEnv.node.id,
        services: {},
      },
    });

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
    const service = serviceRepo.create({
      projectId: project.id,
      name: svc.name,
      buildConfig: {
        ...(svc.repo ? { builder: 'nixpacks' as const } : {}),
        ...(firstInstance?.startCommand ? { startCommand: firstInstance.startCommand } : {}),
        ...(firstInstance?.healthcheckPath ? { healthCheckPath: firstInstance.healthcheckPath } : {}),
      },
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
      componentRepo.create({
        environmentId: env.id,
        type: comp.type,
        externalId: comp.railwayId,
        bindings: {},
      });

      createdComponents.push({
        type: comp.type,
        environmentId: env.id,
        railwayId: comp.railwayId,
      });
    }
  }

  // Audit log
  auditRepo.create({
    action: 'project.imported',
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
