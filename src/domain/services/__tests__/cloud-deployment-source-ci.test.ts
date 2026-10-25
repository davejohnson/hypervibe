import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { buildGitHubDeploymentSessionRuntime, reviewedCloudDeploymentCiAccess } from '../cloud-deployment-ci.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { brokerTarget, gcpBrokerTarget } from './cloud-deployment-ci.fixture.js';
import '../../../adapters/providers/aws/ecs-express.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import '../../../adapters/providers/azure/azure-container-apps.adapter.js';

// Synthetic retained receipts and broker responses. The independently specified
// source-transition contract preserves native receipt bytes and binds each request
// to the separately reviewed source authority; GitHub workflow_dispatch requires
// the native default branch. Executed output is tested, not source-string presence.
function azureTarget() {
  const target = brokerTarget(), connection = target.deploymentAccess!.connection;
  const subscriptionId = '12345678-1234-4678-8678-123456789012', tenantId = '22345678-1234-4678-8678-123456789012';
  const group = `/subscriptions/${subscriptionId}/resourceGroups/isolated-production`;
  const principal = (name: string, n: number) => ({ kind: 'azure-managed-identity' as const, tenantId, subscriptionId,
    clientId: `${n}2345678-1234-4678-8678-123456789012`, principalId: `${n}3345678-1234-4678-8678-123456789012`,
    identityResourceId: `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}` });
  connection.provider = 'azure'; connection.hostingProvider = 'azure-container-apps';
  connection.nativeScope = { tenantId, subscriptionId, resourceGroup: 'isolated-production', location: 'canadacentral' };
  connection.deployment.hostingProvider = 'azure-container-apps'; connection.deployment.region = 'canadacentral';
  connection.principals = { provision: principal('provision', 3), release: principal('release', 4) };
  connection.runtimeIdentities = [{ workload: 'web', installationId: connection.installationId, owner: 'b'.repeat(64), principal: principal('runtime', 5) }];
  target.providerRegion = 'canadacentral';
  return target;
}
function transitioned(provider: string) {
  const target = provider === 'gcp' ? gcpBrokerTarget() : provider === 'azure' ? azureTarget() : brokerTarget();
  const access = target.deploymentAccess!, connection = access.connection;
  connection.source.branch = 'feature/initial-app';
  const connectionDigest = canonicalJsonSha256(connection);
  const proposal = { schemaVersion: 1, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', connectionDigest,
    previousDigest: canonicalJsonSha256({ schemaVersion: 1, connectionDigest, source: connection.source }),
    from: structuredClone(connection.source), source: { ...connection.source, branch: 'main', revision: 'd'.repeat(40), specDigest: 'e'.repeat(64) } };
  const authorization = { ...proposal, digest: canonicalJsonSha256(proposal) };
  Object.assign(access, { sourceAuthorization: authorization });
  return { target, authorization, original: JSON.stringify(connection) };
}
async function runtime(provider: string) {
  const f = transitioned(provider), principal = f.target.deploymentAccess!.connection.principals.release;
  const calls: Array<{ url: string; init: RequestInit }> = [], content = '{}';
  const core = { getIDToken: vi.fn(async () => 'synthetic-oidc'), setSecret: vi.fn() };
  const github = { rest: { repos: { getContent: vi.fn(async () => ({ data: { type: 'file', encoding: 'base64', content: 'e30=', size: 2 } })) } } };
  const context = { sha: 'd'.repeat(40), ref: 'refs/heads/main', repo: { owner: 'example', repo: 'app' } };
  const session = { principal, expiresAt: new Date(Date.now() + 900000).toISOString(), ...(provider === 'aws'
    ? { kind: 'aws-sts', accessKeyId: 'ASIA' + '2'.repeat(17), secretAccessKey: 'synthetic-key', sessionToken: 'synthetic-session' }
    : provider === 'gcp' ? { kind: 'gcp-impersonation', token: 'synthetic-token' }
    : { kind: 'azure-federation', target: 'resource-manager', token: 'synthetic-token' }) };
  const state = { rejected: false };
  const fetch = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return state.rejected
    ? new Response('synthetic-private-provider-echo', { status: 403 }) : Response.json(session); });
  const code = buildGitHubDeploymentSessionRuntime(f.target);
  const get = new Function('require', 'core', 'github', 'context', 'fetch', `${code}; return hvDeploymentSession;`)(createRequire(import.meta.url), core, github, context, fetch);
  return { ...f, calls, content, core, context, session, state, get: () => get(provider === 'azure' ? 'resource-manager' : undefined) };
}
describe.each(['aws', 'gcp', 'azure'])('%s emitted CI after reviewed source transfer', provider => {
  it('uses the default branch and exact source authority while preserving the original native receipt', async () => {
    const f = await runtime(provider);
    expect(await f.get()).toEqual(f.session);
    expect(reviewedCloudDeploymentCiAccess(f.target).connection).toEqual(JSON.parse(f.original));
    expect(canonicalJsonSha256(reviewedCloudDeploymentCiAccess(f.target).connection)).toBe(f.authorization.connectionDigest);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ expectedSourceRevision: f.context.sha,
      expectedSourceDigest: createHash('sha256').update(f.content).digest('hex'), sourceAuthorityDigest: f.authorization.digest,
      ...(provider === 'azure' ? { target: 'resource-manager' } : {}) });
  });
  it('rejects the retired branch before acquiring a token or contacting the broker', async () => {
    const f = await runtime(provider); f.context.ref = 'refs/heads/feature/initial-app';
    await expect(f.get()).rejects.toThrow('Cloud deployment release access could not be verified.');
    expect(f.calls).toHaveLength(0); expect(f.core.getIDToken).not.toHaveBeenCalled();
  });
  it('does not fall back or repeat a refused authority after another source transition', async () => {
    const f = await runtime(provider); f.state.rejected = true;
    await expect(f.get()).rejects.toThrow(/^Cloud deployment release access could not be verified\.$/);
    expect(f.calls).toHaveLength(1);
  });
  it('rejects changed receipt identity and an overlay naming another branch', () => {
    const first = transitioned(provider); first.target.deploymentAccess!.connection.planDigest = 'f'.repeat(64);
    expect(() => buildGitHubDeploymentSessionRuntime(first.target)).toThrow();
    const second = transitioned(provider); second.target.branch = second.target.deploymentAccess!.sourceBranch = 'another';
    expect(() => buildGitHubDeploymentSessionRuntime(second.target)).toThrow();
  });
});
