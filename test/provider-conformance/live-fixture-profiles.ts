import { providerContracts } from './provider-matrix.js';

/** Capability coverage is explicit; a profile is not evidence that it has passed live. */
export const liveFixtureProfiles = [
  { id: 'gcp-engine', provider: 'cloudrun', path: 'engine', runner: 'test/provider-conformance/provider-lifecycle.live.test.ts',
    capabilities: ['engine:cloudrun'], release: 'local-commit', nativeResources: ['google_cloud_run_v2_service', 'google_cloud_run_v2_service_iam_member'] },
  { id: 'railway', provider: 'railway', path: 'managed-workflow', runner: 'test/provider-conformance/provider-managed-workflow.live.test.ts',
    capabilities: ['hosting:railway', 'database:railway', 'cache:railway', 'storage:railway', 'queue:railway'], release: 'managed-ci', nativeResources: ['services', 'volumes', 'buckets'] },
  { id: 'cloudflare-load-balancer', provider: 'cloudflare', path: 'infrastructure', runner: 'test/provider-conformance/provider-infrastructure.live.test.ts',
    capabilities: ['load-balancer:cloudflare'], release: 'managed-origins', nativeResources: ['load-balancer', 'pool', 'monitor'] },
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
  if (!profile) throw new Error(`Live fixture ${id} is unavailable. AWS and Azure infrastructure remain planned; they cannot count as passing live tests.`);
  return profile;
}
