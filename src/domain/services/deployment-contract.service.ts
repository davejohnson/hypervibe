import { createHash } from 'crypto';
import { readRepoSpecFile } from '../spec/repo-spec-file.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

export const APPLIED_SPEC_HASH_VARIABLE = 'HYPERVIBE_APPLIED_SPEC_HASH';
export const APPLIED_SPEC_HASH_OPERATION = 'githubActionsAppliedSpecHash';

type DeploymentContractSpec = {
  version?: unknown;
  project?: unknown;
  gitRemoteUrl?: unknown;
  secrets?: unknown;
  environments?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

export function environmentDeploymentContract(
  spec: DeploymentContractSpec,
  environmentName: string
): Record<string, unknown> {
  const environments = asRecord(spec.environments) ?? {};
  const environment = environments[environmentName];
  if (!asRecord(environment)) {
    throw new Error(`Spec has no environment "${environmentName}".`);
  }

  const applicableSecrets = Object.fromEntries(
    Object.entries(asRecord(spec.secrets) ?? {})
      .filter(([, value]) => {
        const environmentsForSecret = asRecord(value)?.environments;
        return Array.isArray(environmentsForSecret) && environmentsForSecret.includes(environmentName);
      })
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  );

  return {
    version: spec.version,
    project: spec.project,
    gitRemoteUrl: spec.gitRemoteUrl ?? null,
    environmentName,
    environment,
    secrets: applicableSecrets,
  };
}

export function environmentDeploymentContractHash(
  spec: DeploymentContractSpec,
  environmentName: string
): string {
  const canonical = canonicalize(environmentDeploymentContract(spec, environmentName));
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * GitHub Actions hashes the committed JSON document. Use that same raw
 * document when available so schema defaults do not create false mismatches.
 */
export function environmentDeploymentContractHashForApply(
  spec: ProjectSpec,
  environmentName: string
): string {
  const repoSpec = readRepoSpecFile();
  const source = repoSpec?.spec.project === spec.project ? repoSpec.document : spec;
  return environmentDeploymentContractHash(source as DeploymentContractSpec, environmentName);
}
