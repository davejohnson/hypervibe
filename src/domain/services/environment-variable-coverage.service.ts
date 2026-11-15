import type { EnvironmentSpec, ProjectSpec } from '../spec/spec.schema.js';
import { isDeepStrictEqual } from 'node:util';

type ActiveDeclaration = 'ordinary' | 'env_file' | 'managed_secret';

export type EnvironmentVariableCoverageIssue = {
  reason: 'missing_environment' | 'mixed_secret_boundary';
  key: string;
  environment?: string;
  declaredIn: string[];
  requiredEnvironments: string[];
  message: string;
};

export type EnvironmentVariableCoverageReport = {
  complete: boolean;
  issues: EnvironmentVariableCoverageIssue[];
};

function releaseEnvironmentEntries(spec: ProjectSpec): Array<[string, EnvironmentSpec]> {
  return Object.entries(spec.environments)
    .filter(([name]) => name.trim().toLowerCase() !== 'local')
    .sort(([left], [right]) => left.localeCompare(right));
}

function sharesService(left: EnvironmentSpec, right: EnvironmentSpec): boolean {
  const leftServices = new Set(Object.keys(left.services));
  return Object.keys(right.services).some((service) => leftServices.has(service));
}

function activeDeclarations(spec: ProjectSpec): Map<string, Map<string, ActiveDeclaration>> {
  const declarations = new Map<string, Map<string, ActiveDeclaration>>();
  const record = (key: string, environment: string, declaration: ActiveDeclaration) => {
    const environments = declarations.get(key) ?? new Map<string, ActiveDeclaration>();
    environments.set(environment, declaration);
    declarations.set(key, environments);
  };

  for (const [environmentName, environment] of releaseEnvironmentEntries(spec)) {
    for (const key of Object.keys(environment.envVars)) record(key, environmentName, 'ordinary');
    for (const key of environment.envFile?.include ?? []) record(key, environmentName, 'env_file');
  }
  for (const [key, secret] of Object.entries(spec.secrets)) {
    for (const environmentName of secret.environments) {
      if (environmentName.trim().toLowerCase() !== 'local') record(key, environmentName, 'managed_secret');
    }
  }
  return declarations;
}

export function environmentVariableCoverage(spec: ProjectSpec): EnvironmentVariableCoverageReport {
  const releaseEnvironments = new Map(releaseEnvironmentEntries(spec));
  const issues: EnvironmentVariableCoverageIssue[] = [];

  for (const [key, declarations] of activeDeclarations(spec)) {
    const declaredIn = Array.from(declarations.keys()).sort();
    const declaringEnvironments = declaredIn
      .map((name) => releaseEnvironments.get(name))
      .filter((environment): environment is EnvironmentSpec => environment !== undefined);
    const requiredEnvironments = Array.from(releaseEnvironments.entries())
      .filter(([, environment]) => declaringEnvironments.some((declaring) => sharesService(declaring, environment)))
      .map(([name]) => name)
      .sort();
    const kinds = new Set(declarations.values());
    const managedSecret = kinds.has('managed_secret');
    const nonSecret = kinds.has('ordinary') || kinds.has('env_file');
    if (managedSecret && nonSecret) {
      issues.push({
        reason: 'mixed_secret_boundary',
        key,
        declaredIn,
        requiredEnvironments,
        message: `${key} crosses the managed-secret and ordinary configuration boundary across release environments.`,
      });
      continue;
    }

    for (const environmentName of requiredEnvironments) {
      if (declarations.has(environmentName)) continue;
      const environment = releaseEnvironments.get(environmentName)!;
      if (environment.envVarExceptions?.includes(key) || environment.removeEnvVars?.includes(key)) continue;
      issues.push({
        reason: 'missing_environment',
        key,
        environment: environmentName,
        declaredIn,
        requiredEnvironments,
        message: `${key} is required for matching services but has no desired-state declaration or explicit exception in ${environmentName}.`,
      });
    }
  }

  issues.sort((left, right) => (
    left.key.localeCompare(right.key)
    || left.reason.localeCompare(right.reason)
    || (left.environment ?? '').localeCompare(right.environment ?? '')
  ));
  return { complete: issues.length === 0, issues };
}

export function environmentVariableCoverageIssueId(issue: EnvironmentVariableCoverageIssue): string {
  return `${issue.reason}:${issue.key}:${issue.environment ?? ''}`;
}

/** A service rename does not introduce runtime inputs or grant secret ownership. */
export function introducedEnvironmentVariableCoverageIssues(
  previous: ProjectSpec | null,
  next: ProjectSpec
): EnvironmentVariableCoverageIssue[] {
  const baseline = previous && {
    ...previous,
    environments: Object.fromEntries(Object.entries(previous.environments).map(([name, before]) => {
      const after = next.environments[name];
      if (!after || !isDeepStrictEqual(before.hosting, after.hosting)) return [name, before];
      const removed = Object.keys(before.services).filter((key) => !(key in after.services));
      const added = Object.keys(after.services).filter((key) => !(key in before.services));
      const retainedUnchanged = Object.keys(before.services)
        .filter((key) => key in after.services)
        .every((key) => isDeepStrictEqual(before.services[key], after.services[key]));
      if (!removed.length || removed.length !== added.length || !retainedUnchanged) return [name, before];
      const unmatched = added.map((key) => after.services[key]);
      for (const key of removed) {
        const match = unmatched.findIndex((service) => isDeepStrictEqual(before.services[key], service));
        if (match < 0) return [name, before];
        unmatched.splice(match, 1);
      }
      // Keep all old declarations. New keys/targets or mixed ownership in the
      // candidate must still fail, including when submitted with the rename.
      return [name, { ...before, services: after.services }];
    })),
  };
  const existing = new Set(baseline
    ? environmentVariableCoverage(baseline).issues.map(environmentVariableCoverageIssueId)
    : []);
  return environmentVariableCoverage(next).issues.filter((issue) => !existing.has(environmentVariableCoverageIssueId(issue)));
}
