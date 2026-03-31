import { ProjectRepository } from '../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../../adapters/db/repositories/component.repository.js';
import { SecretMappingRepository } from '../../adapters/db/repositories/secret-mapping.repository.js';
import { ConnectionRepository } from '../../adapters/db/repositories/connection.repository.js';
import { IntegrationRepository } from '../../adapters/db/repositories/integration.repository.js';
import { getProjectScopeHints } from './project-scope.js';
import type { Project } from '../entities/project.entity.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const secretMappingRepo = new SecretMappingRepository();
const connectionRepo = new ConnectionRepository();
const integrationRepo = new IntegrationRepository();

const INTENT_SCHEMA_VERSION = '1';

interface IntentEnvironmentSummary {
  name: string;
  kind: 'local' | 'staging' | 'production' | 'custom';
  hosting: {
    railwayBound: boolean;
    railwayEnvironmentId?: string;
    boundServices: string[];
  };
  services: Array<{
    name: string;
    builder?: string;
    railwayServiceBound: boolean;
  }>;
  components: Array<{
    type: string;
    managed: boolean;
  }>;
}

interface ProjectIntentSchema {
  schemaVersion: typeof INTENT_SCHEMA_VERSION;
  generatedAt: string;
  source: 'derived';
  project: {
    id: string;
    name: string;
    defaultPlatform: string;
    gitRemoteUrl?: string;
  };
  desiredState: Record<string, unknown> | null;
  overview: {
    environments: number;
    services: number;
    components: number;
    secretMappings: number;
  };
  hosting: {
    platform: string;
    environments: IntentEnvironmentSummary[];
  };
  integrations: {
    connections: Array<{
      provider: string;
      status: string;
      scope: string | null;
    }>;
    storedKeys: Array<{
      provider: string;
      mode: string;
      updatedAt: string;
    }>;
    secretMappings: Array<{
      envVar: string;
      provider: string;
      service: string | 'all';
      environments: string[] | 'all';
    }>;
  };
}

function classifyEnvironment(name: string): 'local' | 'staging' | 'production' | 'custom' {
  const normalized = name.toLowerCase();
  if (normalized === 'local') return 'local';
  if (normalized.includes('prod') || normalized === 'production') return 'production';
  if (normalized.includes('stag') || normalized === 'staging') return 'staging';
  return 'custom';
}

function inferSecretProvider(secretRef: string): string {
  const match = secretRef.match(/^([a-z0-9_-]+):\/\//i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function buildIntent(project: Project): ProjectIntentSchema {
  const environments = envRepo.findByProjectId(project.id);
  const services = serviceRepo.findByProjectId(project.id);
  const mappings = secretMappingRepo.findByProjectId(project.id);
  const scopeHints = getProjectScopeHints(project);

  const environmentSummaries: IntentEnvironmentSummary[] = environments.map((env) => {
    const bindings = env.platformBindings as {
      railwayEnvironmentId?: string;
      railwayProjectId?: string;
      services?: Record<string, { serviceId: string }>;
    };
    const serviceBindings = bindings.services ?? {};
    const components = componentRepo.findByEnvironmentId(env.id);

    return {
      name: env.name,
      kind: classifyEnvironment(env.name),
      hosting: {
        railwayBound: Boolean(bindings.railwayProjectId),
        railwayEnvironmentId: bindings.railwayEnvironmentId,
        boundServices: Object.keys(serviceBindings),
      },
      services: services.map((service) => ({
        name: service.name,
        builder: service.buildConfig.builder,
        railwayServiceBound: Boolean(serviceBindings[service.name]?.serviceId),
      })),
      components: components.map((component) => ({
        type: component.type,
        managed: Boolean(component.externalId),
      })),
    };
  });

  const providersToCheck = [
    'railway',
    'cloudflare',
    'sendgrid',
    'supabase',
    'rds',
    'cloudsql',
    'stripe',
    'recaptcha',
  ];

  const connectionSummaries: Array<{ provider: string; status: string; scope: string | null }> = [];
  for (const provider of providersToCheck) {
    const connection = connectionRepo.findBestMatchFromHints(provider, scopeHints);
    if (!connection) continue;
    connectionSummaries.push({
      provider: connection.provider,
      status: connection.status,
      scope: connection.scope,
    });
  }

  const integrationSummaries = integrationRepo.findAll().map((key) => ({
    provider: key.provider,
    mode: key.mode,
    updatedAt: key.updatedAt.toISOString(),
  }));

  const secretMappingSummaries = mappings.map((mapping) => ({
    envVar: mapping.envVar,
    provider: inferSecretProvider(mapping.secretRef),
    service: mapping.serviceName ?? 'all',
    environments: mapping.environments.length > 0 ? mapping.environments : ('all' as const),
  }));

  const componentCount = environmentSummaries.reduce((sum, env) => sum + env.components.length, 0);
  const desiredState = (project.policies?.desiredState as Record<string, unknown> | undefined) ?? null;

  return {
    schemaVersion: INTENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: 'derived',
    project: {
      id: project.id,
      name: project.name,
      defaultPlatform: project.defaultPlatform,
      gitRemoteUrl: project.gitRemoteUrl,
    },
    desiredState,
    overview: {
      environments: environmentSummaries.length,
      services: services.length,
      components: componentCount,
      secretMappings: mappings.length,
    },
    hosting: {
      platform: project.defaultPlatform,
      environments: environmentSummaries,
    },
    integrations: {
      connections: connectionSummaries,
      storedKeys: integrationSummaries,
      secretMappings: secretMappingSummaries,
    },
  };
}

export function syncProjectIntent(projectId: string): ProjectIntentSchema | null {
  const project = projectRepo.findById(projectId);
  if (!project) return null;

  const intent = buildIntent(project);
  const nextPolicies = {
    ...(project.policies ?? {}),
    intent,
  };
  projectRepo.update(project.id, { policies: nextPolicies });
  return intent;
}

export function getProjectIntent(projectId: string, refresh = true): ProjectIntentSchema | null {
  if (refresh) {
    return syncProjectIntent(projectId);
  }
  const project = projectRepo.findById(projectId);
  if (!project) return null;

  const existingIntent = project.policies?.intent as ProjectIntentSchema | undefined;
  return existingIntent ?? buildIntent(project);
}
