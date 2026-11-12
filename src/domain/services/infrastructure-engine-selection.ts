import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';

/** Cloud Run always uses OpenTofu; AWS keeps its explicit engine selection. */
export function isEngineManaged(environment: EnvironmentSpec | undefined): boolean {
  return environment?.hosting.provider === 'cloudrun'
    || (environment?.hosting.provider === 'aws' && environment.hosting.engine === 'opentofu');
}

/** Reject an explicit engine on providers for which that engine has no implementation. */
export function engineSelectionProblem(environment: EnvironmentSpec): string | undefined {
  if (environment.hosting.engine !== undefined && !isEngineManaged(environment)) {
    return `hosting.engine="${environment.hosting.engine}" is not supported with hosting.provider="${environment.hosting.provider}". OpenTofu currently manages Cloud Run and explicitly selected AWS environments.`;
  }
  return undefined;
}

/** Unsupported desired state must block GCP planning instead of falling back to another engine. */
export function engineEnvironmentProblems(spec: ProjectSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName];
  if (!environment) return [`Spec has no environment "${environmentName}".`];
  // AWS validates its provider capabilities in the AWS engine planner.
  if (environment.hosting.provider === 'aws' && isEngineManaged(environment)) return [];
  const problems: string[] = [];
  if (!isEngineManaged(environment)) problems.push('The OpenTofu engine currently supports only hosting.provider="cloudrun".');
  const unsupported: Array<[string, unknown]> = [
    ['loadBalancer', environment.loadBalancer],
    ['domainTarget', environment.domainTarget], ['domainRecreateRevision', environment.domainRecreateRevision],
    ['domainRegistration', environment.domainRegistration], ['webhooks', environment.webhooks], ['ios', environment.ios],
    ['backups', environment.backups?.mode === 'daily' ? environment.backups : undefined],
    ['email', environment.email?.enabled ? environment.email : undefined],
    ['deploy.trigger="native"', environment.deploy?.trigger === 'native' ? environment.deploy : undefined],
    ['deploy.promoteFrom', environment.deploy?.promoteFrom], ['deploy.promotionTests', environment.deploy?.promotionTests],
  ];
  for (const [field, value] of unsupported) {
    if (value !== undefined && value !== null && !(typeof value === 'object' && Object.keys(value as object).length === 0)) {
      problems.push(`${field} is not yet managed by the OpenTofu engine; this capability must be implemented before this environment can be deployed.`);
    }
  }
  if (environment.migrations?.mode === 'tool') problems.push('migrations.mode="tool" is not yet supported by the OpenTofu engine; use "releaseCommand".');
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
    for (const field of ['seedCommand', 'resilience', 'credentialAliases', 'freshInitialization'] as const) {
      if (database[field] !== undefined) {
        problems.push(field === 'seedCommand'
          ? 'database.seedCommand is not yet supported by the OpenTofu engine: remove it from the spec and have the app seed an empty database when it starts (for example in its migrations).'
          : `database.${field} is not yet supported by the OpenTofu engine.`);
      }
    }
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
    if (service.volume) problems.push(`Service ${name}: filesystem volumes are not yet managed by the OpenTofu engine.`);
    if (service.releaseCommand) problems.push(`Service ${name}: release commands are not yet supported by the OpenTofu engine.`);
  }
  return problems;
}

export function domainServiceFor(environment: EnvironmentSpec): string | undefined {
  const candidates = Object.entries(environment.services)
    .filter(([, service]) => service.workloadKind !== 'worker' && service.workloadKind !== 'cron' && service.public !== false)
    .map(([name]) => name);
  return candidates.length === 1 ? candidates[0] : undefined;
}

