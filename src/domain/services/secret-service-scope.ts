import type { ProjectSpec } from '../spec/spec.schema.js';

/**
 * Hosting providers that inject a declared secret only into its named services.
 * Every other provider gives an environment's secrets to all of its services, so
 * a secret that names services is refused there instead of reaching all of them.
 */
export const SECRET_SERVICE_SCOPE_PROVIDERS: readonly string[] = ['cloudrun'];

type ScopeSpec = {
  environments: Record<string, { hosting: { provider: string }; services: Record<string, unknown> } | undefined>;
  /** Absent in partial specs some callers build; treated as no declarations. */
  secrets?: Record<string, { environments: string[]; services?: string[] } | undefined>;
};

/** The services of one environment that receive a declared secret: all of them unless it names services. */
export function secretServicesFor(spec: Pick<ProjectSpec, 'environments' | 'secrets'>, environmentName: string, key: string): string[] {
  const scope = spec as ScopeSpec;
  const all = Object.keys(scope.environments[environmentName]?.services ?? {});
  const named = scope.secrets?.[key]?.services;
  return (named ? all.filter((service) => named.includes(service)) : all).sort();
}

/** A key with no declaration (a derived or imported setting) reaches every service, as before. */
export function secretTargetsService(spec: Pick<ProjectSpec, 'environments' | 'secrets'>, environmentName: string, key: string, service: string): boolean {
  const declared = (spec as ScopeSpec).secrets?.[key];
  if (!declared?.services || !declared.environments.includes(environmentName)) return true;
  return declared.services.includes(service);
}

/** Secrets that name services in an environment whose hosting cannot limit them. Any entry must block planning. */
export function secretServiceScopeProblems(spec: Pick<ProjectSpec, 'environments' | 'secrets'>, environmentName: string): string[] {
  const scope = spec as ScopeSpec;
  const provider = scope.environments[environmentName]?.hosting.provider;
  if (provider === undefined || SECRET_SERVICE_SCOPE_PROVIDERS.includes(provider)) return [];
  return Object.entries(scope.secrets ?? {})
    .filter(([, secret]) => secret?.services && secret.environments.includes(environmentName))
    .map(([key]) => `Secret ${key} is limited to named services, which hosting provider "${provider}" does not support yet: every service in ${environmentName} would receive it. Remove "services" from the secret or host ${environmentName} on Cloud Run.`)
    .sort();
}
