import type { EnvironmentSpec } from './spec.schema.js';
import type { DesiredState } from '../services/spec.service.js';

export interface BootstrapParams {
  projectName: string;
  environmentName: string;
  services: string[];
  crons?: DesiredState['crons'];
  domain?: string;
  databaseProvider?: 'supabase' | 'rds' | 'cloudsql' | 'railway';
  setupEmail: boolean;
  serviceConfig?: DesiredState['serviceConfig'];
  envVars?: DesiredState['envVars'];
  deploy?: DesiredState['deploy'];
}

function classifyEnvName(name: string): 'staging' | 'production' | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.includes('prod')) return 'production';
  if (normalized.includes('stag')) return 'staging';
  return null;
}

/**
 * Convert one environment section of a ProjectSpec into the parameter shape
 * executeBootstrap expects (the legacy DesiredState layout).
 */
export function specToBootstrapParams(
  projectName: string,
  environmentName: string,
  env: EnvironmentSpec
): BootstrapParams {
  const services: string[] = [];
  const crons: NonNullable<DesiredState['crons']> = {};
  const serviceConfig: NonNullable<DesiredState['serviceConfig']> = {};

  for (const [name, service] of Object.entries(env.services)) {
    if (service.workloadKind === 'cron') {
      crons[name] = {
        schedule: service.cronSchedule!,
        ...(service.startCommand ? { command: service.startCommand } : {}),
        ...(service.timeZone ? { timeZone: service.timeZone } : {}),
      };
    } else {
      services.push(name);
    }

    const config: Record<string, unknown> = {};
    if (service.startCommand !== undefined) config.startCommand = service.startCommand;
    if (service.releaseCommand !== undefined) config.releaseCommand = service.releaseCommand;
    if (service.healthCheckPath !== undefined) config.healthCheckPath = service.healthCheckPath;
    if (service.cronSchedule !== undefined) config.cronSchedule = service.cronSchedule;
    if (service.public !== undefined) config.public = service.public;
    if (Object.keys(config).length > 0) {
      serviceConfig[name] = config as NonNullable<DesiredState['serviceConfig']>[string];
    }
  }

  let deploy: DesiredState['deploy'];
  if (env.deploy?.strategy) {
    const kind = classifyEnvName(environmentName);
    deploy = {
      strategy: env.deploy.strategy,
      ...(env.deploy.branch && kind
        ? { branches: { [kind]: env.deploy.branch } }
        : {}),
    };
  }

  return {
    projectName,
    environmentName,
    services,
    ...(Object.keys(crons).length > 0 ? { crons } : {}),
    ...(env.domain ? { domain: env.domain } : {}),
    ...(env.database ? { databaseProvider: env.database.provider } : {}),
    setupEmail: env.email.enabled,
    ...(Object.keys(serviceConfig).length > 0 ? { serviceConfig } : {}),
    ...(Object.keys(env.envVars).length > 0 ? { envVars: env.envVars } : {}),
    ...(deploy ? { deploy } : {}),
  };
}
