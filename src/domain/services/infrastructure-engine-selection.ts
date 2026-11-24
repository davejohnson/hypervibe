import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import { secretServiceScopeProblems } from './secret-service-scope.js';
import { gcpSecretScopeProblems } from './gcp-secret-scope.js';
import { gcpDatabaseAliasProblems } from './gcp-runtime-env.js';

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
  if (Object.values(environment.services).some(service => service.removeEnvVars?.length)) {
    problems.push('This cloud does not support confirmed service-specific variable retirement yet.');
  }
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
  if (environment.database?.placement === 'app') problems.push(`database.placement="app" (one database server shared by the app's environments) is not yet supported on ${cloud}; it is tracked in issue #831. Remove it to give this environment its own database.`);
  return problems;
}

/**
 * What `database.placement: "app"` (the environment's own database on one server the app's environments use together)
 * cannot be combined with yet. Each is refused whole, before anything is requested or created, never half done.
 */
export function sharedDatabaseSpecProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName];
  const database = environment?.database;
  const problems: string[] = [];
  const onServer = 'on the app\'s shared database server';
  const from = environment?.dataMigration?.fromEnvironment;
  if (from && environment?.dataMigration?.include.database && spec.environments[from]?.database?.placement === 'app') {
    problems.push(`dataMigration copies the database of ${from}, which is ${onServer}. That is not available yet.`);
  }
  if (database?.placement !== 'app') return problems;
  if (Object.values(environment!.services).some((service) => service.workloadKind === 'worker' && service.onDemand)) {
    problems.push(`${environmentName} has an on-demand worker that counts pending work in the database. That is not available yet ${onServer}; give ${environmentName} its own database (remove "placement") or run the worker all the time.`);
  }
  if (database.size !== undefined) problems.push(`database.size cannot be set for ${environmentName}: its database is ${onServer}, whose size is not chosen by one environment. Remove "size", or remove "placement" to give ${environmentName} its own database.`);
  if (database.version !== undefined) problems.push(`database.version cannot be set for ${environmentName}: its database is ${onServer} (PostgreSQL 16), and one environment cannot change the version for the others. Remove "version", or remove "placement".`);
  if (database.deletionProtection === true) problems.push(`database.deletionProtection cannot be turned on for ${environmentName}: ${onServer} only the server is protected, and removing ${environmentName}'s database always asks for confirmation. Remove "deletionProtection", or remove "placement" to give ${environmentName} a protected database of its own.`);
  if (environment!.dataMigration) problems.push(`dataMigration is not available yet for ${environmentName}, whose database is ${onServer}.`);
  return problems;
}

/** Use the account that owns the declared primary Cloudflare zone. */
export function gcpRegistrarSpec(spec: EnvironmentSpec): EnvironmentSpec | string {
  const registration = spec.domainRegistration;
  const dns = spec.dns;
  if (spec.hosting.provider !== 'cloudrun' || !registration?.register || !spec.domain || dns?.provider !== 'cloudflare'
    || dns.zone.name !== spec.domain.trim().toLowerCase().replace(/\.$/, '')
    || registration.accountId && registration.accountId !== dns.zone.accountId) {
    return 'Cloud Run domainRegistration needs the primary domain’s Cloudflare DNS zone and the same account for registration and DNS.';
  }
  return { ...spec, domainRegistration: { ...registration, accountId: dns.zone.accountId } };
}

/** Unsupported desired state must block planning instead of falling back to another engine. */
export function engineEnvironmentProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName];
  if (!environment) return [`Spec has no environment "${environmentName}".`];
  // AWS and Azure add their own provider capabilities in their engine planners.
  // A secret limited to named services must never fall back to every service.
  const scopeProblems = secretServiceScopeProblems(spec, environmentName);
  if ((environment.hosting.provider === 'aws' || environment.hosting.provider === 'azure') && isEngineManaged(environment)) return [...commonEngineProblems(environment), ...scopeProblems];
  const problems: string[] = [...scopeProblems, ...gcpSecretScopeProblems(spec, environmentName), ...gcpDatabaseAliasProblems(environment), ...sharedDatabaseSpecProblems(spec, environmentName)];
  if (!isEngineManaged(environment)) problems.push('The OpenTofu engine currently supports only hosting.provider="cloudrun".');
  problems.push(...commonEngineProblems(environment));
  if (environment.domainRegistration?.register) {
    const registrar = gcpRegistrarSpec(environment);
    if (typeof registrar === 'string') problems.push(registrar);
  }
  // Cloud Run cannot switch traffic to another environment yet; AWS and Azure can.
  if (present(environment.domainTarget)) problems.push('domainTarget is not yet managed by the OpenTofu engine; this capability must be implemented before this environment can be deployed.');
  if (environment.migrations?.mode === 'releaseCommand' && !environment.migrations.command?.trim()) problems.push('migrations.mode="releaseCommand" needs a command.');
  if (environment.domain || environment.domains?.length) {
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



/** Preserve the primary hostname used by existing specs and DNS integrations. */
export function environmentDomains(environment: EnvironmentSpec) {
  const primary = environment.domain?.trim().toLowerCase().replace(/\.$/, '');
  return [...(primary ? [{ domain: primary, dns: environment.dns }] : []), ...(environment.domains ?? [])];
}
