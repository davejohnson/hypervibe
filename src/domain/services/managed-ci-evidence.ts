export const MANAGED_CI_RELEASE_EVIDENCE_VERSION = 4;
export const MANAGED_CI_RELEASE_EVIDENCE_FILE = 'hypervibe-server-release.json';

/** Shared generated-runtime source so every managed CI provider hashes the same raw spec contract. */
export const MANAGED_CI_DEPLOYMENT_CONTRACT_RUNTIME_SOURCE = `
function asEvidenceRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function canonicalizeEvidence(value) {
  if (Array.isArray(value)) return value.map(canonicalizeEvidence);
  const record = asEvidenceRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalizeEvidence(child)])
  );
}

function deploymentContractFingerprint(spec, environmentName) {
  const document = asEvidenceRecord(spec);
  const environment = asEvidenceRecord(document && document.environments)?.[environmentName];
  if (!document || !asEvidenceRecord(environment)) {
    throw new Error('Hypervibe spec has no environment "' + environmentName + '".');
  }
  const secrets = Object.fromEntries(
    Object.entries(asEvidenceRecord(document.secrets) || {})
      .filter(([, value]) => {
        const environments = asEvidenceRecord(value)?.environments;
        return Array.isArray(environments) && environments.includes(environmentName);
      })
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  );
  return createHash('sha256').update(JSON.stringify(canonicalizeEvidence({
    version: document.version,
    project: document.project,
    gitRemoteUrl: document.gitRemoteUrl ?? null,
    ...(document.runtime !== undefined ? { runtime: document.runtime } : {}),
    environmentName,
    environment,
    secrets,
  })), 'utf8').digest('hex');
}
`.trim();

export function managedCiReleaseArtifactPrefix(environmentName: string): string {
  const environment = environmentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `hypervibe-server-release-v${MANAGED_CI_RELEASE_EVIDENCE_VERSION}-${environment}-`;
}

export function managedCiReleaseArtifactName(environmentName: string, sha: string): string {
  return `${managedCiReleaseArtifactPrefix(environmentName)}${sha}`;
}
