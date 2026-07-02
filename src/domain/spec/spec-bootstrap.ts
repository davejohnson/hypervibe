import type { EnvironmentSpec } from './spec.schema.js';
import type { DesiredState } from '../services/spec.service.js';

export interface BootstrapParams {
  projectName: string;
  environmentName: string;
  services: string[];
  crons?: DesiredState['crons'];
  domain?: string;
  databaseProvider?: 'supabase' | 'cloudsql' | 'railway';
  setupEmail: boolean;
  serviceConfig?: DesiredState['serviceConfig'];
  envVars?: DesiredState['envVars'];
  deploy?: DesiredState['deploy'];
  /** Poll web services' healthCheckPath over HTTP after deploy (hv_deploy). */
  verifyHttpHealth?: boolean;
  /** Managed queue env vars resolved by the caller (see queue-env.ts). */
  queueEnvVars?: Record<string, string>;
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
    config.workloadKind = service.workloadKind;
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
      ...(env.deploy.trigger ? { trigger: env.deploy.trigger } : {}),
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

/**
 * Apply plan-frozen deploy overrides (hv_plan services=/envVars=) to
 * bootstrap params: restrict services/crons to the subset and merge one-off
 * env vars last so they win over spec and database-derived vars, matching
 * hv_deploy's historical behavior.
 */
export function applyOverridesToBootstrapParams(
  params: BootstrapParams,
  overrides: { services?: string[]; envVars?: Record<string, string> }
): BootstrapParams {
  const next: BootstrapParams = { ...params };
  if (overrides.services?.length) {
    const keep = new Set(overrides.services);
    next.services = params.services.filter((name) => keep.has(name));
    if (params.crons) {
      const crons = Object.fromEntries(Object.entries(params.crons).filter(([name]) => keep.has(name)));
      if (Object.keys(crons).length > 0) {
        next.crons = crons;
      } else {
        delete next.crons;
      }
    }
  }
  if (overrides.envVars && Object.keys(overrides.envVars).length > 0) {
    next.envVars = { ...(params.envVars ?? {}), ...overrides.envVars };
  }
  return next;
}
