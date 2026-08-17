import type { ComponentType } from '../../../domain/entities/component.entity.js';
import type { ProviderInspectionRequest } from '../../../domain/registry/provider.registry.js';
import type { RailwayAdapter, RailwayProjectDetails } from './railway.adapter.js';

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
  datastoreEngine?: 'postgres' | 'redis';
  instancesByEnv: Record<string, {
    domains: string[];
    customDomains: string[];
    startCommand?: string;
    releaseCommand?: string;
    healthcheckPath?: string;
    cronSchedule?: string;
    numReplicas?: number;
    sleepApplication?: boolean;
  }>;
}

export interface ImportComponentSummary {
  type: ComponentType;
  railwayId: string;
  name: string;
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

function mapPluginToComponentType(pluginName: string): ComponentType {
  const normalized = pluginName.toLowerCase();
  if (normalized.includes('postgres')) return 'postgres';
  if (normalized.includes('redis') || normalized.includes('valkey')) return 'redis';
  return pluginName;
}

function classifyRailwayDatastoreEngine(name: string): 'postgres' | 'redis' | undefined {
  const normalized = name.toLowerCase();
  if (normalized.includes('postgres')) return 'postgres';
  if (normalized.includes('redis') || normalized.includes('valkey')) return 'redis';
  return undefined;
}

function normalizeRailwayPreDeployCommand(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const commands = value.filter(
    (command): command is string => typeof command === 'string' && command.trim().length > 0
  );
  return commands.length > 0 ? commands.join(' && ') : undefined;
}

export async function listRailwayImportCandidates(
  adapter: RailwayAdapter,
  limit = 25
): Promise<ImportCandidate[]> {
  const projects = (await adapter.listProjects()).slice(0, limit);
  return Promise.all(projects.map(async (project) => {
    const details = await adapter.getProjectDetails(project.id);
    return {
      name: project.name,
      railwayId: project.id,
      environmentCount: details?.environments.edges.length ?? 0,
      serviceCount: details?.services.edges.length ?? 0,
    };
  }));
}

export async function inspectRailwayProject(
  adapter: RailwayAdapter,
  railwayProjectId: string
): Promise<RailwayProjectInspection | null> {
  const details = await adapter.getProjectDetails(railwayProjectId);
  if (!details) return null;

  const environments = details.environments.edges.map((environment) => ({
    name: environment.node.name,
    railwayId: environment.node.id,
  }));
  const services: ImportServiceSummary[] = details.services.edges.map((serviceEdge) => {
    const instancesByEnv: ImportServiceSummary['instancesByEnv'] = {};
    for (const instanceEdge of serviceEdge.node.serviceInstances?.edges ?? []) {
      const instance = instanceEdge.node;
      instancesByEnv[instance.environmentId] = {
        domains: instance.domains?.serviceDomains?.map((domain) => domain.domain) ?? [],
        customDomains: instance.domains?.customDomains?.map((domain) => domain.domain) ?? [],
        startCommand: instance.startCommand,
        releaseCommand: normalizeRailwayPreDeployCommand(instance.preDeployCommand),
        healthcheckPath: instance.healthcheckPath,
        cronSchedule: instance.cronSchedule,
        numReplicas: instance.numReplicas,
        sleepApplication: instance.sleepApplication,
      };
    }
    const datastoreEngine = classifyRailwayDatastoreEngine(serviceEdge.node.name);
    return {
      name: serviceEdge.node.name,
      railwayId: serviceEdge.node.id,
      repo: serviceEdge.node.repoTriggers.edges[0]?.node.repository ?? null,
      branch: serviceEdge.node.repoTriggers.edges[0]?.node.branch ?? null,
      hasGitHubDeploy: serviceEdge.node.repoTriggers.edges.length > 0,
      ...(datastoreEngine ? { datastoreEngine } : {}),
      instancesByEnv,
    };
  });
  const components: ImportComponentSummary[] = details.plugins.edges.map((plugin) => ({
    type: mapPluginToComponentType(plugin.node.name),
    railwayId: plugin.node.id,
    name: plugin.node.name,
  }));
  const storage = (details.buckets?.edges ?? []).map((bucket) => ({
    name: bucket.node.name,
    railwayId: bucket.node.id,
    environments: details.environments.edges.flatMap((environment) => {
      const instance = environment.node.config?.buckets?.[bucket.node.id];
      return instance && instance.isDeleted !== true
        ? [{ name: environment.node.name, region: instance.region }]
        : [];
    }),
  }));

  let envVarNames: string[] = [];
  if (environments[0] && services[0]) {
    const variables = await adapter.getServiceVariables(
      details.id,
      services[0].railwayId,
      environments[0].railwayId
    );
    envVarNames = Object.keys(variables);
  }

  const autoDetected: Record<string, string> = {};
  const needsMapping: string[] = [];
  for (const environment of environments) {
    const normalized = environment.name.toLowerCase();
    if (['production', 'staging', 'development'].includes(normalized)) {
      autoDetected[environment.name] = normalized;
    } else {
      needsMapping.push(environment.name);
    }
  }

  return { details, environments, services, components, storage, envVarNames, autoDetected, needsMapping };
}

export async function inspectRailwayResources(
  adapter: RailwayAdapter,
  request: ProviderInspectionRequest
): Promise<Record<string, unknown>> {
  if (request.resource && !['project', 'environment'].includes(request.resource)) {
    throw new Error(`Unsupported Railway inspection resource "${request.resource}". Use project or environment.`);
  }
  const bindingProjectId = typeof request.binding?.projectId === 'string'
    ? request.binding.projectId
    : undefined;
  const selectedId = request.id ?? bindingProjectId;
  const selectedName = request.name ?? request.project?.name;
  if (!selectedId && !selectedName) {
    return {
      observation: 'present',
      resource: 'project',
      projects: await listRailwayImportCandidates(adapter, request.limit),
    };
  }

  let projectId = selectedId;
  let matches: Array<{ id: string; name: string }> = [];
  if (!projectId) {
    matches = await adapter.findProjectsByName(selectedName!);
    if (matches.length === 0) {
      return { observation: 'absent', resource: request.resource ?? 'project', name: selectedName };
    }
    if (matches.length > 1) {
      return {
        observation: 'ambiguous',
        resource: request.resource ?? 'project',
        name: selectedName,
        projects: matches.slice(0, request.limit).map((project) => ({ id: project.id, name: project.name })),
      };
    }
    projectId = matches[0].id;
  }

  const inspection = await inspectRailwayProject(adapter, projectId);
  if (!inspection) {
    return { observation: 'absent', resource: request.resource ?? 'project', id: projectId };
  }
  if (request.resource === 'environment') {
    const boundEnvironmentId = typeof request.binding?.environmentId === 'string'
      ? request.binding.environmentId
      : undefined;
    const candidates = inspection.environments.filter((environment) => (
      boundEnvironmentId
        ? environment.railwayId === boundEnvironmentId
        : environment.name === request.environment?.name
    ));
    if (candidates.length === 0) {
      return {
        observation: 'absent',
        resource: 'environment',
        project: { id: inspection.details.id, name: inspection.details.name },
        name: request.environment?.name,
      };
    }
    if (candidates.length > 1) {
      return {
        observation: 'ambiguous',
        resource: 'environment',
        project: { id: inspection.details.id, name: inspection.details.name },
        environments: candidates.map((environment) => ({ id: environment.railwayId, name: environment.name })),
      };
    }
    const selectedEnvironment = candidates[0]!;
    return {
      observation: 'present',
      resource: 'environment',
      project: { id: inspection.details.id, name: inspection.details.name },
      environment: { id: selectedEnvironment.railwayId, name: selectedEnvironment.name },
      services: inspection.services
        .filter((service) => Boolean(service.instancesByEnv[selectedEnvironment.railwayId]))
        .map((service) => ({
          id: service.railwayId,
          name: service.name,
          instance: service.instancesByEnv[selectedEnvironment.railwayId],
          datastoreEngine: service.datastoreEngine,
        })),
      components: inspection.components.map((component) => ({ id: component.railwayId, name: component.name, type: component.type })),
      storage: inspection.storage
        .filter((bucket) => bucket.environments.some((environment) => environment.name === selectedEnvironment.name))
        .map((bucket) => ({ id: bucket.railwayId, name: bucket.name })),
    };
  }
  return {
    observation: 'present',
    resource: 'project',
    project: { id: inspection.details.id, name: inspection.details.name },
    environments: inspection.environments.map((environment) => ({ id: environment.railwayId, name: environment.name })),
    services: inspection.services.map((service) => ({
      id: service.railwayId,
      name: service.name,
      repo: service.repo,
      branch: service.branch,
      hasGitHubDeploy: service.hasGitHubDeploy,
      datastoreEngine: service.datastoreEngine,
      instancesByEnvironmentId: service.instancesByEnv,
    })),
    components: inspection.components.map((component) => ({ id: component.railwayId, name: component.name, type: component.type })),
    storage: inspection.storage.map((bucket) => ({ id: bucket.railwayId, name: bucket.name, environments: bucket.environments })),
    envVarNames: inspection.envVarNames,
    autoDetected: inspection.autoDetected,
    needsMapping: inspection.needsMapping,
  };
}
