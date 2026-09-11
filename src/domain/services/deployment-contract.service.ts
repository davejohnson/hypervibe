import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { readRepoSpecFile } from '../spec/repo-spec-file.js';
import type { ProjectSpec } from '../spec/spec.schema.js';

export const APPLIED_SPEC_HASH_VARIABLE = 'HYPERVIBE_APPLIED_SPEC_HASH';
export const APPLIED_SPEC_HASH_OPERATION = 'githubActionsAppliedSpecHash';

type DeploymentContractSpec = {
  version?: unknown;
  project?: unknown;
  gitRemoteUrl?: unknown;
  runtime?: unknown;
  secrets?: unknown;
  environments?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
    ...(spec.runtime !== undefined ? { runtime: spec.runtime } : {}),
    environmentName,
    environment,
    secrets: applicableSecrets,
  };
}

export function environmentDeploymentContractHash(
  spec: DeploymentContractSpec,
  environmentName: string
): string {
  return canonicalJsonSha256(environmentDeploymentContract(spec, environmentName));
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
