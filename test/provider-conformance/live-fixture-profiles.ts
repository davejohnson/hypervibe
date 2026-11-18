import { providerContracts } from './provider-matrix.js';

/** Capability coverage is explicit; a profile is not evidence that it has passed live. */
export const liveFixtureProfiles = [
  ...(['cloudflare', 'gcp', 'aws', 'azure'] as const).map(provider => ({ id: `dns-${provider}` as const, provider,
    path: 'dns' as const, runner: 'test/provider-conformance/dns-lifecycle.live.test.ts', capabilities: [`dns:${provider}`],
    release: 'retained-prepared-app' as const, nativeResources: ['dns-records'] })),
  { id: 'gcp-engine', provider: 'cloudrun', path: 'engine', runner: 'test/provider-conformance/provider-lifecycle.live.test.ts',
    capabilities: ['engine:cloudrun'], release: 'local-commit', nativeResources: ['google_cloud_run_v2_service', 'google_cloud_run_v2_service_iam_member'] },
  ...(['aws', 'azure'] as const).map(provider => ({ id: `${provider}-engine` as const, provider, path: 'engine-environment' as const,
    runner: 'test/provider-conformance/engine-environment.live.test.ts', capabilities: [`engine:${provider}`], release: 'local-commit' as const,
    nativeResources: provider === 'aws' ? ['vpc', 'vpc-endpoint', 'nat-gateway', 'db-cluster', 'db-instance', 'db-cluster-snapshot', 'ecs-cluster', 'ecr-repository', 's3-bucket'] : ['every resource in the project resource group'] })),
  { id: 'railway', provider: 'railway', path: 'managed-workflow', runner: 'test/provider-conformance/provider-managed-workflow.live.test.ts',
    capabilities: ['hosting:railway', 'database:railway', 'cache:railway', 'storage:railway', 'queue:railway'], release: 'managed-ci', nativeResources: ['services', 'volumes', 'buckets'] },
] as const;

export function liveFixtureCoverage(): Array<{ capability: string; status: string; profile?: string }> {
  return providerContracts.map((contract) => {
    const capability = `${contract.kind}:${contract.provider}`;
    if (contract.status === 'planned') return { capability, status: 'unavailable' };
    const profile = liveFixtureProfiles.find((entry) => (entry.capabilities as readonly string[]).includes(capability));
    if (!profile) throw new Error(`Implemented provider ${capability} has no disposable live fixture profile.`);
    return { capability, status: 'requires-live-proof', profile: profile.id };
  });
}

export function selectLiveFixtureProfile(id: string) {
  const profile = liveFixtureProfiles.find((entry) => entry.id === id);
  if (!profile) throw new Error(`Live fixture ${id} is unavailable. A profile that is not registered cannot count as a passing live test.`);
  return profile;
}
