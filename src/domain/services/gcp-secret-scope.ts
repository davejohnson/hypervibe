import { createHash } from 'node:crypto';
import type { ProjectSpec } from '../spec/spec.schema.js';
import { engineSecretId } from './engine-secret-id.js';

/**
 * Google Cloud access boundary for secrets limited to named services.
 *
 * Project setup gives the shared runtime identity Secret Accessor on the whole
 * project, so leaving a secret out of a service's environment does not stop that
 * service reading it through the Secret Manager API. A limited secret is a real
 * boundary only when:
 *   - every service it names runs as its own service account, and
 *   - every other identity's project-wide Secret Accessor grant carries a
 *     condition that excludes the secret.
 * Both are project IAM, which only an administrator can change, so they live in
 * one reviewed project-setup contribution. This module is its pure description.
 */
export const GCP_SECRET_SCOPE_CONTRIBUTION = 'prepare-secret-scope';

type ScopeSpec = Pick<ProjectSpec, 'environments' | 'secrets'>;

/** Declared secrets that name services in this environment: key -> sorted service names. */
export function gcpScopedSecrets(spec: ScopeSpec, environmentName: string): Record<string, string[]> {
  return Object.fromEntries(Object.entries(spec.secrets ?? {})
    .filter(([, secret]) => secret.services && secret.environments.includes(environmentName))
    .map(([key, secret]) => [key, [...secret.services!].sort()] as const)
    .sort(([a], [b]) => a.localeCompare(b)));
}

/** Services that some limited secret names; each runs as its own identity. */
export function gcpScopedServices(spec: ScopeSpec, environmentName: string): string[] {
  const declared = Object.keys(spec.environments[environmentName]?.services ?? {});
  const named = new Set(Object.values(gcpScopedSecrets(spec, environmentName)).flat());
  return declared.filter((service) => named.has(service)).sort();
}

/** Service account id (6-30 characters) for one service of one environment. */
export function gcpServiceIdentityAccountId(environmentName: string, service: string): string {
  const slug = `${environmentName}-${service}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18).replace(/-+$/g, '');
  const hash = createHash('sha256').update(`${environmentName}/${service}`).digest('hex').slice(0, 8);
  return `hv-${slug || 'svc'}-${hash}`;
}

export function gcpServiceIdentityEmail(gcpProjectId: string, environmentName: string, service: string): string {
  return `${gcpServiceIdentityAccountId(environmentName, service)}@${gcpProjectId}.iam.gserviceaccount.com`;
}

/** Limited-secret shapes the Google Cloud boundary cannot cover. Any entry must block planning. */
export function gcpSecretScopeProblems(spec: ScopeSpec, environmentName: string): string[] {
  const environment = spec.environments[environmentName];
  if (!environment || environment.hosting.provider !== 'cloudrun') return [];
  const scoped = gcpScopedSecrets(spec, environmentName);
  if (!Object.keys(scoped).length) return [];
  const problems: string[] = [];
  if ((environment.hosting as { gcpRuntimeSecretGrants?: string }).gcpRuntimeSecretGrants) {
    problems.push(`${environmentName} sets gcpRuntimeSecretGrants, which grants each secret to the shared runtime identity. It cannot be combined with secrets limited to named services (${Object.keys(scoped).join(', ')}). Remove one of the two.`);
  }
  for (const service of gcpScopedServices(spec, environmentName)) {
    const declared = environment.services[service] as { workloadKind?: string; onDemand?: unknown } | undefined;
    if (declared?.workloadKind === 'worker' && declared.onDemand) {
      const keys = Object.entries(scoped).filter(([, services]) => services.includes(service)).map(([key]) => key);
      problems.push(`${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} limited to ${service}, an on-demand worker. Its waker must act as the worker's identity, which Hypervibe cannot isolate yet. Remove ${service} from "services" or remove its onDemand setting.`);
    }
  }
  return problems.sort();
}

/** What one workload was last known to run as and to reference, read from a refreshed plan or a completed apply. */
export interface GcpAppliedWorkload { identity: string; secretIds: string[] }

export interface GcpSecretScopeEnvironment {
  name: string;
  /** Workloads bound in this environment (services, workers, jobs and the release command). */
  boundWorkloads: string[];
  /** Local evidence per workload; a bound workload without it may hold any secret of its environment. */
  applied: Record<string, GcpAppliedWorkload>;
}

export interface GcpSecretScopeIdentity {
  environment: string;
  service: string;
  accountId: string;
  email: string;
  /** Secret ids this identity's project-wide Secret Accessor grant excludes. */
  excludedSecretIds: string[];
}

/** The reviewed content of the project-setup contribution, without Google's project number. */
export interface GcpSecretScopeDescriptor {
  gcpProjectId: string;
  runtimeServiceAccountEmail: string;
  identities: GcpSecretScopeIdentity[];
  /** Secret ids the shared runtime identity's project-wide Secret Accessor grant excludes. */
  runtimeExcludedSecretIds: string[];
}

/**
 * The setup this spec needs in one Google Cloud project.
 *
 * An identity is excluded from a limited secret only when no workload known to
 * run as that identity still references it: excluding earlier would stop a
 * running service from starting. `retained` keeps identities an earlier setup
 * created, so a service keeps its identity until the environment stops using it.
 */
export function gcpSecretScopeDescriptor(params: {
  spec: ScopeSpec; gcpProjectId: string; runtimeServiceAccountEmail: string;
  environments: GcpSecretScopeEnvironment[];
  retained?: Array<Pick<GcpSecretScopeIdentity, 'environment' | 'service'>>;
}): GcpSecretScopeDescriptor {
  const { spec, gcpProjectId, runtimeServiceAccountEmail } = params;
  const pairs = new Map<string, { environment: string; service: string }>();
  for (const entry of params.retained ?? []) pairs.set(`${entry.environment}/${entry.service}`, { environment: entry.environment, service: entry.service });
  for (const environment of params.environments) {
    for (const service of gcpScopedServices(spec, environment.name)) pairs.set(`${environment.name}/${service}`, { environment: environment.name, service });
  }
  const limited = params.environments.flatMap((environment) => Object.entries(gcpScopedSecrets(spec, environment.name))
    .map(([key, services]) => ({ environment, secretId: engineSecretId(environment.name, key), services })));
  /** No workload that runs (or may run) as this identity still references the secret. */
  const released = (identity: string, shared: boolean, secret: typeof limited[number]) => secret.environment.boundWorkloads.every((workload) => {
    const known = secret.environment.applied[workload];
    // Unknown workloads predate this record: assume the shared identity and every secret of their environment.
    if (!known) return !shared;
    return known.identity !== identity || !known.secretIds.includes(secret.secretId);
  });
  const identities = [...pairs.values()].map(({ environment, service }) => {
    const email = gcpServiceIdentityEmail(gcpProjectId, environment, service);
    return {
      environment, service, accountId: gcpServiceIdentityAccountId(environment, service), email,
      excludedSecretIds: limited
        .filter((secret) => !(secret.environment.name === environment && secret.services.includes(service)) && released(email, false, secret))
        .map((secret) => secret.secretId).sort(),
    };
  }).sort((a, b) => a.email.localeCompare(b.email));
  if (new Set(identities.map((identity) => identity.accountId)).size !== identities.length) {
    throw new Error('Two services resolve to the same service identity name. Rename one of them.');
  }
  return {
    gcpProjectId, runtimeServiceAccountEmail, identities,
    runtimeExcludedSecretIds: limited.filter((secret) => released(runtimeServiceAccountEmail, true, secret)).map((secret) => secret.secretId).sort(),
  };
}

/** Limited secrets whose boundary is not in force under the verified setup, with the reason. */
export function gcpUnlockedSecrets(spec: ScopeSpec, environmentName: string, verified: GcpSecretScopeDescriptor | undefined): string[] {
  return Object.entries(gcpScopedSecrets(spec, environmentName)).filter(([key, services]) => {
    const secretId = engineSecretId(environmentName, key);
    if (!verified?.runtimeExcludedSecretIds.includes(secretId)) return true;
    return verified.identities.some((identity) => !(identity.environment === environmentName && services.includes(identity.service))
      && !identity.excludedSecretIds.includes(secretId));
  }).map(([key]) => key).sort();
}
