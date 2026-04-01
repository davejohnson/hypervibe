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

const INTENT_SCHEMA_VERSION = '3';

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
  desired: {
    state: Record<string, unknown> | null;
    environmentName?: string;
    serviceName?: string;
    domain?: string;
    databaseProvider?: string;
    setupEmail?: boolean;
    deploy?: {
      strategy?: 'branch' | 'manual';
      branches?: {
        staging?: string;
        production?: string;
      };
    };
    migrations?: {
      mode?: 'none' | 'releaseCommand' | 'tool';
      runInDeploy?: boolean;
      command?: string;
    };
    protection: {
      protectedEnvironments: string[];
      requireApprovalForProtectedEnvironments: boolean;
    };
  };
  observed: {
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
  };
  drift: Array<{
    check: string;
    status: 'ok' | 'warning';
    message: string;
  }>;
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

function hasVerifiedConnection(
  connections: Array<{ provider: string; status: string; scope: string | null }>,
  provider: string
): boolean {
  return connections.some((c) => c.provider === provider && c.status === 'verified');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

export function buildDriftSignals(
  desiredState: Record<string, unknown> | null,
  connections: Array<{ provider: string; status: string; scope: string | null }>,
  policies?: Record<string, unknown>
): Array<{ check: string; status: 'ok' | 'warning'; message: string }> {
  const drift: Array<{ check: string; status: 'ok' | 'warning'; message: string }> = [];
  const protectedEnvironments = toStringArray(policies?.protectedEnvironments).map((e) => e.toLowerCase());
  const productionProtected = protectedEnvironments.some((e) => e === 'production' || e === 'prod');
  drift.push({
    check: 'policy.productionProtected',
    status: productionProtected ? 'ok' : 'warning',
    message: productionProtected
      ? 'Production environment is protected by policy'
      : 'Production environment is not protected by policy',
  });

  const requireProtectedApprovals = policies?.requireApprovalForProtectedEnvironments !== false;
  drift.push({
    check: 'policy.protectedApprovals',
    status: requireProtectedApprovals ? 'ok' : 'warning',
    message: requireProtectedApprovals
      ? 'Protected environments require approval IDs'
      : 'Protected environments do not require approval IDs',
  });

  if (!desiredState) return drift;

  const desiredDbProvider = typeof desiredState.databaseProvider === 'string' ? desiredState.databaseProvider : undefined;
  if (desiredDbProvider) {
    const ok = hasVerifiedConnection(connections, desiredDbProvider);
    drift.push({
      check: 'databaseProvider.connection',
      status: ok ? 'ok' : 'warning',
      message: ok
        ? `Desired database provider "${desiredDbProvider}" has a verified connection`
        : `Desired database provider "${desiredDbProvider}" is missing a verified connection`,
    });
  }

  const desiredDomain = typeof desiredState.domain === 'string' ? desiredState.domain : undefined;
  if (desiredDomain) {
    const ok = hasVerifiedConnection(connections, 'cloudflare');
    drift.push({
      check: 'domain.dnsConnection',
      status: ok ? 'ok' : 'warning',
      message: ok
        ? `Desired domain "${desiredDomain}" has a verified Cloudflare connection`
        : `Desired domain "${desiredDomain}" is set but no verified Cloudflare connection was found`,
    });
  }

  const setupEmail = desiredState.setupEmail;
  if (setupEmail === true) {
    const ok = hasVerifiedConnection(connections, 'sendgrid');
    drift.push({
      check: 'email.connection',
      status: ok ? 'ok' : 'warning',
      message: ok
        ? 'Desired email setup has a verified SendGrid connection'
        : 'Desired email setup is enabled but no verified SendGrid connection was found',
    });
  }

  const deploy = asRecord(desiredState.deploy);
  const branches = asRecord(deploy?.branches);
  const stagingBranch = typeof branches?.staging === 'string' ? branches.staging : undefined;
  const productionBranch = typeof branches?.production === 'string' ? branches.production : undefined;
  if (stagingBranch && productionBranch) {
    const distinct = stagingBranch !== productionBranch;
    drift.push({
      check: 'deploy.branchesDistinct',
      status: distinct ? 'ok' : 'warning',
      message: distinct
        ? `Deploy branches are distinct (staging=${stagingBranch}, production=${productionBranch})`
        : `Deploy branches are identical (${stagingBranch}); use separate branches for safer promotion`,
    });
  }

  const migrations = asRecord(desiredState.migrations);
  const runInDeploy = migrations?.runInDeploy;
  if (runInDeploy === true) {
    const mode = typeof migrations.mode === 'string' ? migrations.mode : undefined;
    const validMode = mode === 'releaseCommand' || mode === 'tool';
    drift.push({
      check: 'migrations.deployMode',
      status: validMode ? 'ok' : 'warning',
      message: validMode
        ? `Deploy-time migrations configured with mode "${mode}"`
        : 'Deploy-time migrations enabled without a supported mode (expected "releaseCommand" or "tool")',
    });
  }

  return drift;
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
  const drift = buildDriftSignals(desiredState, connectionSummaries, project.policies);
  const desiredDeploy = asRecord(desiredState?.deploy);
  const desiredDeployBranches = asRecord(desiredDeploy?.branches);
  const desiredMigrations = asRecord(desiredState?.migrations);
  const protectedEnvironments = toStringArray(project.policies?.protectedEnvironments);
  const desired = {
    state: desiredState,
    environmentName: typeof desiredState?.environmentName === 'string' ? desiredState.environmentName : undefined,
    serviceName: typeof desiredState?.serviceName === 'string' ? desiredState.serviceName : undefined,
    domain: typeof desiredState?.domain === 'string' ? desiredState.domain : undefined,
    databaseProvider: typeof desiredState?.databaseProvider === 'string' ? desiredState.databaseProvider : undefined,
    setupEmail: typeof desiredState?.setupEmail === 'boolean' ? desiredState.setupEmail : undefined,
    deploy: desiredDeploy
      ? {
          strategy: desiredDeploy.strategy === 'branch' || desiredDeploy.strategy === 'manual' ? desiredDeploy.strategy : undefined,
          branches: desiredDeployBranches
            ? {
                staging: typeof desiredDeployBranches.staging === 'string' ? desiredDeployBranches.staging : undefined,
                production: typeof desiredDeployBranches.production === 'string' ? desiredDeployBranches.production : undefined,
              }
            : undefined,
        }
      : undefined,
    migrations: desiredMigrations
      ? {
          mode:
            desiredMigrations.mode === 'none' ||
            desiredMigrations.mode === 'releaseCommand' ||
            desiredMigrations.mode === 'tool'
              ? desiredMigrations.mode
              : undefined,
          runInDeploy: typeof desiredMigrations.runInDeploy === 'boolean' ? desiredMigrations.runInDeploy : undefined,
          command: typeof desiredMigrations.command === 'string' ? desiredMigrations.command : undefined,
        }
      : undefined,
    protection: {
      protectedEnvironments,
      requireApprovalForProtectedEnvironments: project.policies?.requireApprovalForProtectedEnvironments !== false,
    },
  };
  const observed = {
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
    desired,
    observed,
    drift,
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
