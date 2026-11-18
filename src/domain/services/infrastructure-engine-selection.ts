import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';

/** Hosting providers the managed OpenTofu engine builds. Everything else is Railway, which the engine never touches. */
export const ENGINE_HOSTING_PROVIDERS: readonly string[] = ['cloudrun', 'aws', 'azure'];

/** The engine is not a choice: Google Cloud, AWS and Azure always use it; Railway never does. */
export function isEngineManaged(environment: EnvironmentSpec | undefined): boolean {
  return environment !== undefined && ENGINE_HOSTING_PROVIDERS.includes(environment.hosting.provider);
}

export type EnvironmentProfile = 'production' | 'testing';

/** production and staging share one shape; everything else is a cheap testing environment. */
export function environmentProfile(environmentName: string): EnvironmentProfile {
  return /prod|stag/i.test(environmentName) ? 'production' : 'testing';
}

const present = (value: unknown): boolean => value !== undefined && value !== null
  && !(typeof value === 'object' && Object.keys(value as object).length === 0);

/**
 * Capabilities no OpenTofu engine builds yet. Every cloud refuses them the same way,
 * so declared intent is never silently dropped from a plan. A cloud adds only its own
 * differences in its own planner.
 */
export function commonEngineProblems(environment: EnvironmentSpec): string[] {
  const problems: string[] = [];
  const unsupported: Array<[string, unknown]> = [
    ['domainRecreateRevision', environment.domainRecreateRevision],
    ['domainRegistration', environment.hosting.provider === 'cloudrun' ? undefined : environment.domainRegistration], ['webhooks', environment.webhooks], ['ios', environment.ios],
    ['backups', environment.backups?.mode === 'daily' ? environment.backups : undefined],
    ['email', environment.email?.enabled ? environment.email : undefined],
    ['deploy.trigger="native"', environment.deploy?.trigger === 'native' ? environment.deploy : undefined],
    ['deploy.promoteFrom', environment.deploy?.promoteFrom], ['deploy.promotionTests', environment.deploy?.promotionTests],
  ];
  for (const [field, value] of unsupported) {
    if (present(value)) problems.push(`${field} is not yet managed by the OpenTofu engine; this capability must be implemented before this environment can be deployed.`);
  }
  if (environment.migrations?.mode === 'tool') {
    problems.push('migrations.mode="tool" is not yet supported by the OpenTofu engine'
      + (environment.hosting.provider === 'cloudrun' ? '; use "releaseCommand".' : '.'));
  }
  for (const field of ['seedCommand', 'resilience', 'credentialAliases', 'freshInitialization'] as const) {
    if (environment.database?.[field] !== undefined) {
      problems.push(field === 'seedCommand'
        ? 'database.seedCommand is not yet supported by the OpenTofu engine: remove it from the spec and have the app seed an empty database when it starts (for example in its migrations).'
        : `database.${field} is not yet supported by the OpenTofu engine.`);
    }
  }
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.volume) problems.push(`Service ${name}: filesystem volumes are not yet managed by the OpenTofu engine.`);
    if (service.releaseCommand) problems.push(`Service ${name}: release commands are not yet supported by the OpenTofu engine.`);
  }
  if (environment.hosting.provider !== 'cloudrun') problems.push(...googleOnlyProblems(environment));
  return problems;
}

/** Settings only the Google Cloud engine builds so far; the other clouds refuse them instead of dropping them. */
function googleOnlyProblems(environment: EnvironmentSpec): string[] {
  const cloud = environment.hosting.provider === 'aws' ? 'AWS' : 'Azure';
  const problems: string[] = [];
  if (environment.migrations?.mode === 'releaseCommand') problems.push(`migrations.mode="releaseCommand" is not yet supported on ${cloud}.`);
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.alwaysOn) problems.push(`Service ${name}: alwaysOn is not yet supported on ${cloud}.`);
  }
  if (environment.database?.size) problems.push(`database.size is not yet supported on ${cloud}.`);
  if (environment.database?.deletionProtection !== undefined) problems.push(`database.deletionProtection is not yet supported on ${cloud}.`);
  for (const [name, storage] of Object.entries(environment.storage ?? {})) {
    if (storage.versioning) problems.push(`Storage ${name}: versioning is not yet supported on ${cloud}.`);
    if (storage.browserUploads) problems.push(`Storage ${name}: browserUploads is not yet supported on ${cloud}.`);
  }
  return problems;
}

/** Unsupported desired state must block planning instead of falling back to another engine. */
export function engineEnvironmentProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName];
  if (!environment) return [`Spec has no environment "${environmentName}".`];
  // AWS and Azure add their own provider capabilities in their engine planners.
  if ((environment.hosting.provider === 'aws' || environment.hosting.provider === 'azure') && isEngineManaged(environment)) return commonEngineProblems(environment);
  const problems: string[] = [];
  if (!isEngineManaged(environment)) problems.push('The OpenTofu engine currently supports only hosting.provider="cloudrun".');
  problems.push(...commonEngineProblems(environment));
  // Cloud Run cannot switch traffic to another environment yet; AWS and Azure can.
  if (present(environment.domainTarget)) problems.push('domainTarget is not yet managed by the OpenTofu engine; this capability must be implemented before this environment can be deployed.');
  if (environment.migrations?.mode === 'releaseCommand' && !environment.migrations.command?.trim()) problems.push('migrations.mode="releaseCommand" needs a command.');
  if (environment.domain) {
    if (environment.domainProxy) problems.push('domainProxy must be off: Google issues the certificate and needs DNS-only records.');
    if (domainServiceFor(environment) === undefined) problems.push('A custom domain needs exactly one public web service to point at.');
  }
  for (const [name, storage] of Object.entries(environment.storage ?? {})) {
    if (storage.provider !== 'gcs') problems.push(`Storage ${name}: the OpenTofu engine manages buckets only with provider "gcs".`);
    if (storage.purpose === 'backup') problems.push(`Storage ${name}: backup destinations are not yet managed by the OpenTofu engine.`);
    for (const service of storage.injectInto) {
      if (!environment.services[service]) problems.push(`Storage ${name}: injectInto names undeclared service ${service}.`);
    }
  }
  if (environment.cache && environment.cache.provider !== 'memorystore') {
    problems.push('The OpenTofu engine manages caches only with provider "memorystore".');
  }
  const database = environment.database;
  if (database) {
    if (database.engine !== 'postgres') problems.push('The OpenTofu engine manages Cloud SQL only with engine "postgres".');
    if (database.provider !== 'cloudsql') problems.push('The OpenTofu engine manages databases only with provider "cloudsql".');
  }
  for (const [name, service] of Object.entries(environment.services)) {
    if (service.workloadKind === 'cron' && (!service.cronSchedule || !service.startCommand)) {
      problems.push(`Scheduled job ${name} needs cronSchedule and startCommand (the command each run executes).`);
    }
    if (service.workloadKind !== 'web' && service.cpu && Number(service.cpu) < 1) {
      // Worker pools and jobs keep CPU always allocated, which Cloud Run allows only from 1 vCPU.
      problems.push(`Service ${name}: background workers and scheduled jobs on Cloud Run need at least 1 vCPU (cpu "${service.cpu}" is rejected by Google).`);
    }
    if (service.onDemand && !environment.database) {
      problems.push(`Service ${name}: an on-demand worker counts pending work in the app database, so the environment needs a database.`);
    }
  }
  return problems;
}

export function domainServiceFor(environment: EnvironmentSpec): string | undefined {
  const candidates = Object.entries(environment.services)
    .filter(([, service]) => service.workloadKind !== 'worker' && service.workloadKind !== 'cron' && service.public !== false)
    .map(([name]) => name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

