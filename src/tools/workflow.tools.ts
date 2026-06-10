import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import type { Component } from '../domain/entities/component.entity.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import { serviceWorkloadKind, type Service } from '../domain/entities/service.entity.js';
import { syncProjectIntent } from '../domain/services/intent.service.js';
import { resolveProject } from './resolve-project.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();

const reliabilityTierSchema = z.enum(['prototype', 'standard', 'production', 'critical']);
const targetProfileSchema = z.enum(['auto', 'railway', 'gcp-cloud-run', 'aws-apprunner', 'aws-ecs-fargate']);
const sourceProviderSchema = z.enum(['railway', 'render', 'gcp-cloud-run', 'aws-apprunner', 'aws-ecs-fargate']);
const databaseIntentSchema = z.enum(['none', 'postgres']);
const serviceRoleSchema = z.enum(['web', 'worker', 'cron', 'job']);

type ReliabilityTier = z.infer<typeof reliabilityTierSchema>;
type TargetProfile = z.infer<typeof targetProfileSchema>;
type DatabaseIntent = z.infer<typeof databaseIntentSchema>;
type TargetProfileId = Exclude<TargetProfile, 'auto'>;
type ServiceRole = z.infer<typeof serviceRoleSchema>;

interface TargetProfileDefinition {
  id: TargetProfileId;
  label: string;
  status: 'available' | 'planned';
  deploymentProvider: string;
  databaseProvider?: string;
  migrationStrategy: 'predeploy' | 'external';
  strengths: string[];
  limitations: string[];
}

const TARGET_PROFILES: Record<TargetProfileId, TargetProfileDefinition> = {
  railway: {
    id: 'railway',
    label: 'Railway',
    status: 'available',
    deploymentProvider: 'railway',
    databaseProvider: 'railway',
    migrationStrategy: 'predeploy',
    strengths: ['Fastest prototype path', 'Existing deploy and import support', 'Simple Postgres wiring'],
    limitations: ['Lower production control than hyperscalers', 'Provider outage risk is harder to mitigate'],
  },
  'gcp-cloud-run': {
    id: 'gcp-cloud-run',
    label: 'GCP Cloud Run + Cloud SQL',
    status: 'available',
    deploymentProvider: 'cloudrun',
    databaseProvider: 'cloudsql',
    migrationStrategy: 'external',
    strengths: ['Good hyperscaler default for containers', 'Managed scale-to-zero runtime', 'Cloud SQL production path'],
    limitations: ['Requires project Git remote plus one-time cloud_prepare', 'Release-command migrations need an explicit job path'],
  },
  'aws-apprunner': {
    id: 'aws-apprunner',
    label: 'AWS App Runner + RDS',
    status: 'available',
    deploymentProvider: 'apprunner',
    databaseProvider: 'rds',
    migrationStrategy: 'external',
    strengths: ['Simple AWS managed runtime', 'RDS database target is already modeled'],
    limitations: ['Less standard than ECS/Fargate for serious AWS production', 'Current adapter assumes image-based deploys'],
  },
  'aws-ecs-fargate': {
    id: 'aws-ecs-fargate',
    label: 'AWS ECS/Fargate + RDS',
    status: 'planned',
    deploymentProvider: 'ecs',
    databaseProvider: 'rds',
    migrationStrategy: 'external',
    strengths: ['Best long-term AWS production target', 'Strong control over networking, IAM, scaling, and rollbacks'],
    limitations: ['Adapter is not implemented yet', 'Needs VPC, ALB, ECR, task definitions, IAM, and service discovery modeling'],
  },
};

function jsonResponse(payload: Record<string, unknown>) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(payload),
    }],
  };
}

function hasVerifiedConnection(provider: string): boolean {
  return connectionRepo.findAllByProvider(provider).some((connection) => connection.status === 'verified');
}

function connectionStatusForTarget(target: TargetProfileDefinition, database: DatabaseIntent): Array<{ provider: string; required: boolean; verified: boolean }> {
  const providers = [
    { provider: target.deploymentProvider, required: true },
    ...(database === 'postgres' && target.databaseProvider
      ? [{ provider: target.databaseProvider, required: true }]
      : []),
    { provider: 'cloudflare', required: false },
  ];

  const seen = new Set<string>();
  return providers
    .filter(({ provider }) => {
      if (seen.has(provider)) return false;
      seen.add(provider);
      return true;
    })
    .map(({ provider, required }) => ({
      provider,
      required,
      verified: hasVerifiedConnection(provider),
    }));
}

function chooseTarget(requested: TargetProfile | undefined, reliabilityTier: ReliabilityTier): Exclude<TargetProfile, 'auto'> {
  if (requested && requested !== 'auto') return requested;
  return 'gcp-cloud-run';
}

function normalizeServices(services: string[] | undefined): string[] {
  const normalized = (services ?? ['web'])
    .map((service) => service.trim())
    .filter((service) => service.length > 0);
  return Array.from(new Set(normalized.length > 0 ? normalized : ['web']));
}

function getComponentProvider(component: Component): string | undefined {
  const bindings = component.bindings as Record<string, unknown>;
  return typeof bindings.provider === 'string' ? bindings.provider : undefined;
}

function targetProjectName(sourceProjectName: string, target: TargetProfileDefinition, override?: string): string {
  return override?.trim() || `${sourceProjectName}-${target.id}`;
}

function inferServiceRole(service: Service): ServiceRole {
  const workloadKind = serviceWorkloadKind(service);
  if (workloadKind === 'cron') return 'cron';
  if (workloadKind === 'worker') return 'worker';
  if (workloadKind === 'job') return 'job';
  const name = service.name.toLowerCase();
  if (/worker|queue|consumer|processor/.test(name)) return 'worker';
  if (/job|task|migrate/.test(name)) return 'job';
  return 'web';
}

function serviceRolePriority(role: ServiceRole): number {
  switch (role) {
    case 'web':
      return 0;
    case 'worker':
      return 1;
    case 'cron':
      return 2;
    case 'job':
      return 3;
  }
}

function orderServicesForMove(
  services: Service[],
  overrides?: Record<string, ServiceRole>
): Service[] {
  return [...services].sort((a, b) => {
    const roleA = overrides?.[a.name] ?? inferServiceRole(a);
    const roleB = overrides?.[b.name] ?? inferServiceRole(b);
    return serviceRolePriority(roleA) - serviceRolePriority(roleB) || a.name.localeCompare(b.name);
  });
}

function resolveServiceRoles(
  services: Service[],
  overrides?: Record<string, ServiceRole>
): Array<{ name: string; role: ServiceRole; source: 'inferred' | 'override' }> {
  return services.map((service) => {
    const override = overrides?.[service.name];
    return {
      name: service.name,
      role: override ?? inferServiceRole(service),
      source: override ? 'override' : 'inferred',
    };
  });
}

function namesForRoles(
  serviceRoles: Array<{ name: string; role: ServiceRole }>,
  roles: ServiceRole[]
): string[] {
  const roleSet = new Set<ServiceRole>(roles);
  return serviceRoles.filter((service) => roleSet.has(service.role)).map((service) => service.name);
}

function serviceConfigFromSource(services: Service[]): Record<string, {
  startCommand?: string;
  healthCheckPath?: string;
}> | undefined {
  const config: Record<string, {
    startCommand?: string;
    healthCheckPath?: string;
  }> = {};

  for (const service of services) {
    const next = {
      ...(service.buildConfig.startCommand ? { startCommand: service.buildConfig.startCommand } : {}),
      ...(service.buildConfig.healthCheckPath ? { healthCheckPath: service.buildConfig.healthCheckPath } : {}),
    };
    if (Object.keys(next).length > 0) {
      config[service.name] = next;
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function cronsFromSource(services: Service[]): Record<string, {
  schedule: string;
  command?: string;
}> | undefined {
  const crons: Record<string, { schedule: string; command?: string }> = {};

  for (const service of services) {
    if (serviceWorkloadKind(service) !== 'cron' || !service.buildConfig.cronSchedule) {
      continue;
    }
    crons[service.name] = {
      schedule: service.buildConfig.cronSchedule,
      ...(service.buildConfig.startCommand ? { command: service.buildConfig.startCommand } : {}),
    };
  }

  return Object.keys(crons).length > 0 ? crons : undefined;
}

function migrationIntentFromSource(services: Service[]): { mode: 'tool'; runInDeploy: true; command: string } | undefined {
  const migrationCommand = services.find((service) =>
    typeof service.buildConfig.releaseCommand === 'string' && service.buildConfig.releaseCommand.trim().length > 0
  )?.buildConfig.releaseCommand?.trim();

  return migrationCommand
    ? { mode: 'tool', runInDeploy: true, command: migrationCommand }
    : undefined;
}

function customDomainsFromEnvironment(environment: Environment | undefined, services: Service[]): string[] {
  if (!environment) return [];
  const bindings = environment.platformBindings as {
    services?: Record<string, { customDomains?: string[] }>;
    domains?: Record<string, unknown>;
  };
  const domains = new Set<string>();
  const serviceBindings = bindings.services ?? {};
  for (const service of services) {
    for (const domain of serviceBindings[service.name]?.customDomains ?? []) {
      domains.add(domain);
    }
  }
  for (const domain of Object.keys(bindings.domains ?? {})) {
    domains.add(domain);
  }
  return Array.from(domains).sort();
}

function buildTargetDesiredSetArgs(params: {
  projectName: string;
  environmentName: string;
  services: Service[];
  target: TargetProfileDefinition;
  hasPostgres: boolean;
  domain?: string;
}): Record<string, unknown> {
  const serviceRoles = resolveServiceRoles(params.services);
  const cronNames = new Set(namesForRoles(serviceRoles, ['cron']));
  const deployableServices = params.services.filter((service) => !cronNames.has(service.name));
  const cronServices = params.services.filter((service) => cronNames.has(service.name));
  const serviceConfig = serviceConfigFromSource(deployableServices);
  const crons = cronsFromSource(cronServices);
  const migrations = migrationIntentFromSource(params.services);
  const shouldIncludeMigrations = params.target.migrationStrategy === 'predeploy';

  return {
    projectName: params.projectName,
    environmentName: params.environmentName,
    ...(deployableServices.length > 0 ? { services: deployableServices.map((service) => service.name) } : {}),
    ...(crons ? { crons } : {}),
    setupEmail: false,
    ...(params.hasPostgres && params.target.databaseProvider
      ? { databaseProvider: params.target.databaseProvider }
      : {}),
    ...(params.domain ? { domain: params.domain } : {}),
    ...(serviceConfig ? { serviceConfig } : {}),
    ...(shouldIncludeMigrations && migrations ? { migrations } : {}),
  };
}

function desiredStateFromToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { projectName: _projectName, ...desiredState } = args;
  return desiredState;
}

function buildMovePayload(params: {
  project: Project;
  target: TargetProfile;
  environmentName: string;
  keepSourceWarm: boolean;
  targetProjectName?: string;
  serviceRoles?: Record<string, ServiceRole>;
}): Record<string, unknown> {
  const selectedTarget = TARGET_PROFILES[chooseTarget(params.target, 'production')];
  const services = orderServicesForMove(serviceRepo.findByProjectId(params.project.id), params.serviceRoles);
  const environments = envRepo.findByProjectId(params.project.id);
  const sourceEnvironment = environments.find((environment) => environment.name === params.environmentName) ?? environments[0];
  const components = sourceEnvironment ? componentRepo.findByEnvironmentId(sourceEnvironment.id) : [];
  const hasPostgres = components.some((component) => component.type === 'postgres');
  const domains = customDomainsFromEnvironment(sourceEnvironment, services);
  const serviceRoles = resolveServiceRoles(services, params.serviceRoles);
  const trafficServices = namesForRoles(serviceRoles, ['web']);
  const backgroundServices = namesForRoles(serviceRoles, ['worker']);
  const scheduledServices = namesForRoles(serviceRoles, ['cron']);
  const jobServices = namesForRoles(serviceRoles, ['job']);
  const databaseCutoverServices = services.map((service) => service.name);
  const generatedTargetProjectName = targetProjectName(params.project.name, selectedTarget, params.targetProjectName);
  const connections = connectionStatusForTarget(selectedTarget, hasPostgres ? 'postgres' : 'none');
  const risks = portabilityRisks({
    services,
    components,
    sourceProvider: params.project.defaultPlatform,
    target: selectedTarget,
  });
  const parallelDesiredSetArgs = buildTargetDesiredSetArgs({
    projectName: generatedTargetProjectName,
    environmentName: sourceEnvironment?.name ?? params.environmentName,
    services,
    target: selectedTarget,
    hasPostgres,
  });
  const cutoverDesiredSetArgs = domains[0]
    ? buildTargetDesiredSetArgs({
        projectName: generatedTargetProjectName,
        environmentName: sourceEnvironment?.name ?? params.environmentName,
        services,
        target: selectedTarget,
        hasPostgres,
        domain: domains[0],
      })
    : undefined;
  const migrationIntent = migrationIntentFromSource(services);
  const migrationPlan = migrationIntent
    ? {
        strategy: selectedTarget.migrationStrategy,
        command: migrationIntent.command,
        includedInDesiredState: selectedTarget.migrationStrategy === 'predeploy',
        nextTool: selectedTarget.migrationStrategy === 'predeploy' ? 'infra_apply' : 'db_migrate',
      }
    : undefined;
  const dbMigrationArgs = hasPostgres && selectedTarget.databaseProvider
    ? {
        projectName: generatedTargetProjectName,
        environment: sourceEnvironment?.name ?? params.environmentName,
        targetProvider: selectedTarget.databaseProvider,
        strategy: 'snapshot',
        services: databaseCutoverServices,
      }
    : undefined;
  const cutoverPlan = {
    databaseStrategy: hasPostgres
      ? {
          selected: 'snapshot',
          status: 'available',
          writeFreezeRequired: true,
          reason: 'Snapshot copy uses pg_dump/pg_restore; writes after the dump starts are not replicated.',
          alternatives: [
            { strategy: 'logical_replication', status: 'planned', reason: 'Needed for low-downtime high-write moves' },
            { strategy: 'managed_migration', status: 'planned', reason: 'Provider-specific DMS/Database Migration Service path' },
            { strategy: 'read_replica_promote', status: 'planned', reason: 'Only possible where source/target providers support compatible replicas' },
          ],
        }
      : undefined,
    services: {
      traffic: trafficServices,
      background: backgroundServices,
      scheduled: scheduledServices,
      jobs: jobServices,
      databaseEnvCutover: databaseCutoverServices,
    },
    order: [
      { step: 'deploy_target_dark', detail: 'Deploy target services without production DNS or production traffic' },
      ...(hasPostgres
        ? [
            { step: 'copy_database', detail: 'Run snapshot copy to target database and verify row counts/checksums' },
            { step: 'run_target_migrations', detail: 'Run schema migrations against the target database using a one-off job' },
            { step: 'freeze_writes', detail: 'Stop writes on the source before final snapshot/cutover; pause source workers and cron first' },
          ]
        : []),
      ...(backgroundServices.length > 0 ? [{ step: 'pause_source_workers', detail: `Pause source worker services: ${backgroundServices.join(', ')}` }] : []),
      ...(scheduledServices.length > 0 ? [{ step: 'pause_source_cron', detail: `Pause source scheduled services: ${scheduledServices.join(', ')}` }] : []),
      ...(hasPostgres ? [{ step: 'cutover_database_env', detail: `Set DATABASE_URL on target services: ${databaseCutoverServices.join(', ')}` }] : []),
      { step: 'switch_traffic', detail: trafficServices.length > 0 ? `Switch DNS/traffic for web services: ${trafficServices.join(', ')}` : 'Switch DNS/traffic after target verification' },
      ...(backgroundServices.length > 0 ? [{ step: 'resume_target_workers', detail: `Resume target worker services: ${backgroundServices.join(', ')}` }] : []),
      ...(scheduledServices.length > 0 ? [{ step: 'resume_target_cron', detail: `Resume target scheduled services: ${scheduledServices.join(', ')}` }] : []),
      { step: 'observe_and_rollback_window', detail: params.keepSourceWarm ? 'Keep source stack available until rollback window expires' : 'Proceed to source decommission after verification' },
    ],
  };

  return {
    success: true,
    mode: 'move',
    project: {
      id: params.project.id,
      name: params.project.name,
      sourceProvider: params.project.defaultPlatform,
      environmentName: sourceEnvironment?.name ?? params.environmentName,
    },
    target: {
      id: selectedTarget.id,
      label: selectedTarget.label,
      status: selectedTarget.status,
    },
    targetProject: {
      name: generatedTargetProjectName,
      defaultPlatform: selectedTarget.deploymentProvider,
      exists: Boolean(projectRepo.findByName(generatedTargetProjectName)),
      reason: 'Moves use a separate target project so the source stack remains available for rollback.',
    },
    serviceRoles,
    generatedArgs: {
      createTargetProject: {
        name: generatedTargetProjectName,
        defaultPlatform: selectedTarget.deploymentProvider,
        ...(params.project.gitRemoteUrl ? { gitRemoteUrl: params.project.gitRemoteUrl } : {}),
      },
      parallelDeployDesiredSet: parallelDesiredSetArgs,
      parallelDeployPlan: parallelDesiredSetArgs,
      ...(cutoverDesiredSetArgs
        ? {
            cutoverDesiredSet: cutoverDesiredSetArgs,
            cutoverPlan: cutoverDesiredSetArgs,
          }
        : {}),
      ...(migrationPlan && selectedTarget.migrationStrategy === 'external'
        ? {
            targetMigration: {
              tool: 'db_migrate',
              args: {
                projectName: generatedTargetProjectName,
                environment: sourceEnvironment?.name ?? params.environmentName,
                serviceName: services[0]?.name,
                command: migrationPlan.command,
              },
            },
          }
        : {}),
      ...(dbMigrationArgs
        ? {
            databaseCopy: {
              tool: 'db_migrate_provider',
              args: {
                ...dbMigrationArgs,
                phase: 'copy',
              },
              requires: ['sourceConnectionUrl for the source production database if it is not already recorded locally'],
            },
            databaseCutover: {
              tool: 'db_migrate_provider',
              args: {
                ...dbMigrationArgs,
                phase: 'cutover',
              },
              requires: ['targetConnectionUrl or a prior successful copy phase'],
            },
          }
        : {}),
    },
    ...(migrationPlan ? { migrationPlan } : {}),
    cutoverPlan,
    readiness: {
      connections,
      blocked: selectedTarget.status === 'planned' || connections.some((connection) => connection.required && !connection.verified),
    },
    phases: [
      { step: 'assess', detail: 'Confirm portable services, database, domains, secrets, and provider-specific gaps' },
      { step: 'provision_parallel_target', detail: `Create ${selectedTarget.label} resources without changing production DNS` },
      { step: 'sync_config', detail: 'Copy env var names, secret mappings, domains, health checks, and migration policy' },
      ...(hasPostgres ? [{ step: 'migrate_database', detail: 'Copy or replicate Postgres data, verify row counts/checksums, and prepare rollback' }] : []),
      { step: 'verify_target', detail: 'Run health checks, smoke tests, logs checks, and migration verification on the target' },
      { step: 'cutover', detail: 'Switch DNS/traffic only after verification passes' },
      { step: 'rollback_window', detail: params.keepSourceWarm ? 'Keep source stack warm until rollback window expires' : 'Source stack can be decommissioned after cutover verification' },
      { step: 'decommission_source', detail: 'Remove or scale down source resources after rollback window' },
    ],
    risks,
    observedInfrastructure: observedProject(params.project),
    nextTools: [
      'project_create',
      'infra_desired_set',
      'infra_plan',
      ...(hasPostgres ? ['db_migrate_provider'] : []),
      ...(migrationPlan && selectedTarget.migrationStrategy === 'external' ? ['db_migrate'] : []),
      'infra_apply',
      'cloudflare_dns_list',
    ],
  };
}

function observedProject(project: Project): Record<string, unknown> {
  const environments = envRepo.findByProjectId(project.id);
  const services = serviceRepo.findByProjectId(project.id);
  const componentsByEnvironment = new Map<string, Component[]>();
  for (const environment of environments) {
    componentsByEnvironment.set(environment.id, componentRepo.findByEnvironmentId(environment.id));
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      defaultPlatform: project.defaultPlatform,
      gitRemoteUrl: project.gitRemoteUrl,
    },
    environments: environments.map((environment) => summarizeEnvironment(environment, services, componentsByEnvironment.get(environment.id) ?? [])),
  };
}

function summarizeEnvironment(environment: Environment, services: Service[], components: Component[]): Record<string, unknown> {
  const bindings = environment.platformBindings as {
    provider?: string;
    projectId?: string;
    environmentId?: string;
    railwayProjectId?: string;
    railwayEnvironmentId?: string;
    services?: Record<string, { serviceId?: string; url?: string; customDomains?: string[] }>;
    domains?: Record<string, unknown>;
  };
  const serviceBindings = bindings.services ?? {};
  return {
    name: environment.name,
    provider: bindings.provider,
    providerProjectId: bindings.projectId ?? bindings.railwayProjectId,
    providerEnvironmentId: bindings.environmentId ?? bindings.railwayEnvironmentId,
    services: services.map((service) => ({
      name: service.name,
      workloadKind: serviceWorkloadKind(service),
      startCommand: service.buildConfig.startCommand,
      releaseCommand: service.buildConfig.releaseCommand,
      healthCheckPath: service.buildConfig.healthCheckPath,
      cronSchedule: service.buildConfig.cronSchedule,
      providerServiceId: serviceBindings[service.name]?.serviceId,
      url: serviceBindings[service.name]?.url,
      customDomains: serviceBindings[service.name]?.customDomains ?? [],
    })),
    components: components.map((component) => ({
      type: component.type,
      provider: getComponentProvider(component),
      externalId: component.externalId,
      managed: Boolean(component.externalId),
    })),
    domains: Object.keys(bindings.domains ?? {}),
  };
}

function portabilityRisks(params: {
  services: Service[];
  components: Component[];
  sourceProvider?: string;
  target: TargetProfileDefinition;
}): Array<{ severity: 'info' | 'warning' | 'blocked'; risk: string; mitigation: string }> {
  const risks: Array<{ severity: 'info' | 'warning' | 'blocked'; risk: string; mitigation: string }> = [];

  if (params.target.status === 'planned') {
    risks.push({
      severity: 'blocked',
      risk: `${params.target.label} target is not implemented yet`,
      mitigation: 'Use gcp-cloud-run or aws-apprunner now, or implement the ECS/Fargate adapter before applying this move.',
    });
  }

  const hasPostgres = params.components.some((component) => component.type === 'postgres');
  if (hasPostgres) {
    risks.push({
      severity: 'warning',
      risk: 'Database move requires an explicit copy, verification, and cutover window',
      mitigation: 'Use db_migrate_provider for staged Postgres copy/cutover before changing DNS.',
    });
  }

  const servicesWithReleaseCommands = params.services.filter((service) => Boolean(service.buildConfig.releaseCommand));
  if (servicesWithReleaseCommands.length > 0 && params.target.id !== 'railway') {
    risks.push({
      severity: 'warning',
      risk: `Release/predeploy commands are configured for ${servicesWithReleaseCommands.map((service) => service.name).join(', ')}`,
      mitigation: 'Model migrations as a one-off job or CI step on the target cloud.',
    });
  }

  if (params.sourceProvider === 'railway') {
    risks.push({
      severity: 'info',
      risk: 'Railway private references and service domains are provider-specific',
      mitigation: 'Replace them with target provider env vars, managed database URLs, and Cloudflare DNS records.',
    });
  }

  return risks;
}

function nextToolsForTarget(target: TargetProfileDefinition, database: DatabaseIntent): string[] {
  if (target.id === 'railway') {
    return ['connection_create', 'infra_desired_set', 'infra_plan', 'infra_apply'];
  }
  if (target.id === 'gcp-cloud-run') {
    return database === 'postgres'
      ? ['connection_create provider="cloudrun"', 'connection_create provider="cloudsql"', 'cloud_prepare provider="cloudrun"', 'infra_desired_set', 'infra_plan']
      : ['connection_create provider="cloudrun"', 'cloud_prepare provider="cloudrun"', 'infra_desired_set', 'infra_plan'];
  }
  if (target.id === 'aws-apprunner') {
    return database === 'postgres'
      ? ['connection_create provider="apprunner"', 'connection_create provider="rds"', 'infra_desired_set', 'infra_plan']
      : ['connection_create provider="apprunner"', 'infra_desired_set', 'infra_plan'];
  }
  return ['implement ecs/fargate provider adapter', 'move_plan target="aws-ecs-fargate"'];
}

export function registerWorkflowTools(server: McpServer): void {
  server.tool(
    'launch_plan',
    'Plan new app infrastructure from intent using the Launch workflow.',
    {
      projectName: z.string().min(1).describe('Project/app name to launch'),
      environmentName: z.string().optional().describe('Environment to launch (default: production)'),
      target: targetProfileSchema.optional().describe('Desired cloud target (default: auto)'),
      reliabilityTier: reliabilityTierSchema.optional().describe('Reliability profile (default: production)'),
      services: z.array(z.string().min(1)).optional().describe('Services to launch (default: ["web"])'),
      database: databaseIntentSchema.optional().describe('Database intent (default: postgres)'),
      domain: z.string().optional().describe('Optional production domain'),
      migrationCommand: z.string().optional().describe('Optional deploy-time migration command'),
    },
    async ({ projectName, environmentName = 'production', target = 'auto', reliabilityTier = 'production', services, database = 'postgres', domain, migrationCommand }) => {
      const selectedTarget = TARGET_PROFILES[chooseTarget(target, reliabilityTier)];
      const normalizedServices = normalizeServices(services);
      const desiredInfrastructure = {
        mode: 'launch',
        projectName,
        environmentName,
        services: normalizedServices,
        target: selectedTarget.id,
        reliabilityTier,
        runtime: 'container',
        database,
        domain,
        migrations: migrationCommand
          ? { mode: 'tool', runInDeploy: true, command: migrationCommand }
          : undefined,
      };
      const connections = connectionStatusForTarget(selectedTarget, database);

      return jsonResponse({
        success: true,
        mode: 'launch',
        desiredInfrastructure,
        recommendation: {
          target: selectedTarget.id,
          label: selectedTarget.label,
          status: selectedTarget.status,
          reason: selectedTarget.id === 'railway'
            ? 'Railway target selected explicitly; useful for speed, less ideal for reliability.'
            : 'Production reliability tier favors a hyperscaler target with managed runtime and database primitives.',
          strengths: selectedTarget.strengths,
          limitations: selectedTarget.limitations,
        },
        readiness: {
          connections,
          blocked: selectedTarget.status === 'planned' || connections.some((connection) => connection.required && !connection.verified),
        },
        nextTools: nextToolsForTarget(selectedTarget, database),
      });
    }
  );

  server.tool(
    'import_plan',
    'Plan how to discover and adopt existing infrastructure using the Import workflow.',
    {
      projectName: z.string().optional().describe('Existing local project name, if already adopted'),
      sourceProvider: sourceProviderSchema.optional().describe('Source provider to import from (default: gcp-cloud-run)'),
      externalProjectName: z.string().optional().describe('Provider-side project/app name to discover'),
    },
    async ({ projectName, sourceProvider = 'gcp-cloud-run', externalProjectName }) => {
      const project = projectName ? resolveProject({ projectName }) : null;
      const provider = sourceProvider === 'gcp-cloud-run' ? 'cloudrun'
        : sourceProvider === 'aws-apprunner' ? 'apprunner'
          : sourceProvider === 'aws-ecs-fargate' ? 'ecs'
            : sourceProvider;
      const providerReady = provider !== 'ecs' && hasVerifiedConnection(provider);

      if (!project) {
        return jsonResponse({
          success: true,
          mode: 'import',
          imported: false,
          sourceProvider,
          externalProjectName,
          readiness: {
            providerConnection: {
              provider,
              verified: providerReady,
            },
            blocked: !providerReady,
          },
          plan: [
            { step: 'discover', detail: sourceProvider === 'railway' ? 'List or fetch Railway project details' : `Discover ${sourceProvider} resources` },
            { step: 'normalize', detail: 'Build provider-neutral observed infrastructure graph' },
            { step: 'adopt', detail: 'Create local project, environments, services, components, and provider bindings' },
            { step: 'risk_report', detail: 'Report missing health checks, migration gaps, unmanaged secrets, DNS, backups, and provider-specific resources' },
          ],
          nextTools: sourceProvider === 'railway'
            ? ['project_import', 'setup_scan', 'infra_desired_set']
            : ['provider-specific import adapter required', 'import_plan'],
        });
      }

      const services = serviceRepo.findByProjectId(project.id);
      const environments = envRepo.findByProjectId(project.id);
      const components = environments.flatMap((environment) => componentRepo.findByEnvironmentId(environment.id));

      return jsonResponse({
        success: true,
        mode: 'import',
        imported: true,
        sourceProvider: project.defaultPlatform,
        observedInfrastructure: observedProject(project),
        portability: {
          portable: [
            'service names and runtime commands',
            'health check paths',
            'database component intent',
            'custom domain intent when recorded in bindings',
          ],
          needsDecision: [
            'secret source of truth',
            'database copy/cutover window',
            'target cloud and region',
            'rollback retention period',
          ],
          risks: portabilityRisks({
            services,
            components,
            sourceProvider: project.defaultPlatform,
            target: TARGET_PROFILES['gcp-cloud-run'],
          }),
        },
        nextTools: ['move_plan', 'infra_desired_set', 'setup_scan'],
      });
    }
  );

  server.tool(
    'move_plan',
    'Plan provider-to-provider migration or reproduction using the Move workflow.',
    {
      projectName: z.string().min(1).describe('Imported or existing local project to move'),
      target: targetProfileSchema.describe('Target cloud profile'),
      targetProjectName: z.string().optional().describe('Optional local project name for the parallel target stack'),
      environmentName: z.string().optional().describe('Environment to move first (default: production)'),
      keepSourceWarm: z.boolean().optional().describe('Keep source stack available for rollback after cutover (default: true)'),
      serviceRoles: z.record(serviceRoleSchema).optional().describe('Optional service role overrides by service name: web, worker, cron, or job'),
    },
    async ({ projectName, target, targetProjectName, environmentName = 'production', keepSourceWarm = true, serviceRoles }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return jsonResponse({
          success: false,
          error: `Project not found: ${projectName}. Use import_plan or project_import before move_plan.`,
        });
      }

      return jsonResponse(buildMovePayload({
        project,
        target,
        environmentName,
        keepSourceWarm,
        targetProjectName,
        serviceRoles,
      }));
    }
  );

  server.tool(
    'move_prepare',
    'Create/update the parallel target project and desired state for a Move workflow.',
    {
      projectName: z.string().min(1).describe('Imported or existing local project to move'),
      target: targetProfileSchema.describe('Target cloud profile'),
      targetProjectName: z.string().optional().describe('Optional local project name for the parallel target stack'),
      environmentName: z.string().optional().describe('Environment to move first (default: production)'),
      keepSourceWarm: z.boolean().optional().describe('Keep source stack available for rollback after cutover (default: true)'),
      serviceRoles: z.record(serviceRoleSchema).optional().describe('Optional service role overrides by service name: web, worker, cron, or job'),
      confirm: z.boolean().optional().describe('Set true to create/update the target project desired state'),
    },
    async ({ projectName, target, targetProjectName, environmentName = 'production', keepSourceWarm = true, serviceRoles, confirm = false }) => {
      const project = resolveProject({ projectName });
      if (!project) {
        return jsonResponse({
          success: false,
          error: `Project not found: ${projectName}. Use import_plan or project_import before move_prepare.`,
        });
      }

      const payload = buildMovePayload({
        project,
        target,
        environmentName,
        keepSourceWarm,
        targetProjectName,
        serviceRoles,
      });
      const generatedArgs = payload.generatedArgs as {
        createTargetProject: { name: string; defaultPlatform: string; gitRemoteUrl?: string };
        parallelDeployDesiredSet: Record<string, unknown>;
      };

      if (!confirm) {
        return jsonResponse({
          ...payload,
          mode: 'move_prepare',
          preview: true,
          message: 'Call again with confirm=true to create/update the parallel target project desired state.',
        });
      }

      const existingTargetProject = projectRepo.findByName(generatedArgs.createTargetProject.name);
      if (existingTargetProject && existingTargetProject.defaultPlatform !== generatedArgs.createTargetProject.defaultPlatform) {
        return jsonResponse({
          success: false,
          error: `Target project "${existingTargetProject.name}" already exists with defaultPlatform "${existingTargetProject.defaultPlatform}", expected "${generatedArgs.createTargetProject.defaultPlatform}".`,
          targetProject: {
            id: existingTargetProject.id,
            name: existingTargetProject.name,
            defaultPlatform: existingTargetProject.defaultPlatform,
          },
        });
      }

      const desiredState = desiredStateFromToolArgs(generatedArgs.parallelDeployDesiredSet);
      const preparedProject = existingTargetProject
        ? projectRepo.update(existingTargetProject.id, {
            policies: {
              ...(existingTargetProject.policies ?? {}),
              desiredState,
            },
          }) ?? existingTargetProject
        : projectRepo.create({
            name: generatedArgs.createTargetProject.name,
            defaultPlatform: generatedArgs.createTargetProject.defaultPlatform,
            gitRemoteUrl: generatedArgs.createTargetProject.gitRemoteUrl,
            policies: { desiredState },
          });
      const intent = syncProjectIntent(preparedProject.id);

      return jsonResponse({
        ...payload,
        mode: 'move_prepare',
        prepared: true,
        targetProject: {
          id: preparedProject.id,
          name: preparedProject.name,
          defaultPlatform: preparedProject.defaultPlatform,
          created: !existingTargetProject,
        },
        desiredState,
        intent,
        nextTools: ['infra_plan', 'infra_apply', 'db_migrate_provider', 'move_plan'],
      });
    }
  );
}
