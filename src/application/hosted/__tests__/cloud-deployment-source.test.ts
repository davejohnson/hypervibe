import { describe, expect, it, vi } from 'vitest';
import * as hosted from '../cloud-deployment-session.js';
import * as authentication from '../../../domain/services/cloud-deployment-authentication.js';
import { brokerTarget, gcpBrokerTarget } from '../../../domain/services/__tests__/cloud-deployment-ci.fixture.js';
import type { CloudDeploymentConnectionV1, CloudDeploymentSourceAuthorizationV1 } from '../../../domain/ports/cloud-deployment.port.js';
import type { CloudInstallationDriver } from '../../../domain/ports/cloud-installation.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';

// Synthetic shared authorization boundary. The owner-approved source transition
// is an independent grant, not a rewritten installation receipt or native IAM
// operation. Provider-native identity checks remain in their transport suites.
function fixture(provider: 'aws' | 'gcp' | 'azure' = 'gcp') {
  const connection = structuredClone((provider === 'aws' ? brokerTarget() : gcpBrokerTarget()).deploymentAccess!.connection);
  connection.source.branch = 'feature/setup';
  if (provider === 'azure') {
    const tenantId = '11111111-1111-4111-8111-111111111111', subscriptionId = '22222222-2222-4222-8222-222222222222';
    const principal = (name: string, digit: string) => ({ kind: 'azure-managed-identity' as const, tenantId, subscriptionId,
      clientId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      principalId: `${digit.repeat(8)}-${digit.repeat(4)}-5${digit.repeat(3)}-9${digit.repeat(3)}-${digit.repeat(12)}`,
      identityResourceId: `/subscriptions/${subscriptionId}/resourceGroups/customer/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}` });
    connection.provider = provider; connection.hostingProvider = 'azure-container-apps';
    connection.nativeScope = { tenantId, subscriptionId, resourceGroup: 'customer', location: 'westus' };
    connection.deployment.hostingProvider = connection.hostingProvider; connection.deployment.region = 'westus';
    connection.principals = { provision: principal('provision', '3'), release: principal('release', '4') };
    connection.runtimeIdentities = [{ workload: 'web', installationId: connection.installationId, owner: 'b'.repeat(64), principal: principal('runtime', '5') }];
  }
  const contract = { provider, hostingProvider: connection.hostingProvider, parseScope: (value: unknown) => value as Record<string, string> };
  const assertSourcePlacement = vi.fn();
  const verifyReleaseTargets = vi.fn(async () => [{ workload: 'web', kind: 'service',
    service: { id: 'native-service', lifetimeId: 'original-service-uid' }, registry: { id: 'native-registry', lifetimeId: 'original-registry-uid' } }]);
  const driver = { provider, parseScope: contract.parseScope, deployment: { hostingProvider: connection.hostingProvider,
    assertSourcePlacement, verifyReleaseTargets, parseReleaseTargets: (value: unknown) => value } } as unknown as CloudInstallationDriver;
  const source = { ...connection.source, branch: 'main', revision: 'c'.repeat(40), specDigest: 'd'.repeat(64) };
  const connectionDigest = canonicalJsonSha256(connection);
  const fields = { schemaVersion: 1 as const, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', connectionDigest,
    previousDigest: canonicalJsonSha256({ schemaVersion: 1, connectionDigest, source: connection.source }), from: connection.source, source };
  const authorization: CloudDeploymentSourceAuthorizationV1 = { ...fields, digest: canonicalJsonSha256(fields) };
  const input = { connection, sourceAuthorization: authorization, source, spec: {} as any, bindings: {}, driver,
    signal: new AbortController().signal, authorize: vi.fn(async () => true), authentication: { host: {
      verifyIdentity: vi.fn(async () => connection.hostIdentity), getIdToken: vi.fn(async () => 'host-id-token'), getAccessToken: vi.fn(async () => 'host-access-token') } } };
  return { connection, contract, driver, source, authorization, input, assertSourcePlacement, verifyReleaseTargets };
}
function transient(connection: CloudDeploymentConnectionV1): any {
  const principal = connection.principals.provision;
  return principal.kind === 'aws-role' ? { kind: 'aws-sts', principal, getCredentials: vi.fn() }
    : principal.kind === 'gcp-service-account' ? { kind: 'gcp-impersonation', principal, getAccessToken: vi.fn() }
      : { kind: 'azure-federation', principal, getAccessToken: vi.fn() };
}
describe('separately reviewed deployment source authority', () => {
  it.each(['aws', 'gcp', 'azure'] as const)('%s carries separate source authority through adapter validation without changing the native receipt', provider => {
    const f = fixture(provider), original = structuredClone(f.connection), auth = transient(f.connection);
    const checked = authentication.validateCloudDeploymentAdapterInputV1({ connection: f.connection,
      sourceAuthorization: f.authorization, capability: 'provision', authentication: auth }, f.contract);
    expect(checked.sourceAuthorization).toEqual(f.authorization);
    expect(checked.connection).toEqual(original); expect(canonicalJsonSha256(checked.connection)).toBe(f.authorization.connectionDigest);
    expect(auth.getAccessToken ?? auth.getCredentials).not.toHaveBeenCalled();
  });
  it('accepts target-branch release proof only with the exact separate authority and keeps original native identity', async () => {
    const f = fixture(), original = structuredClone(f.connection);
    await expect(hosted.verifyCloudDeploymentReleaseTargetsV1({ ...f.input, sourceAuthorization: undefined } as any)).rejects.toMatchObject({ code: 'scope_mismatch' });
    const verified = await hosted.verifyCloudDeploymentReleaseTargetsV1(f.input);
    expect(verified.source).toEqual(f.source); expect(f.connection).toEqual(original);
    expect(f.verifyReleaseTargets).toHaveBeenCalledWith(expect.objectContaining({ connection: original, source: f.source }));
    expect(f.input.authorize).toHaveBeenCalled();
  });
  it('rejects old-branch release proof once an independently approved source overlay is supplied', async () => {
    const f = fixture();
    await expect(hosted.verifyCloudDeploymentReleaseTargetsV1({ ...f.input, source: f.connection.source })).rejects.toMatchObject({ code: 'scope_mismatch' });
    expect(f.verifyReleaseTargets).not.toHaveBeenCalled();
  });
  it('prepares the exact predecessor-linked proposal with provider placement checks and no native calls', () => {
    const f = fixture(), before = structuredClone(f.connection);
    const prepared = (hosted as any).prepareCloudDeploymentSourceAuthorizationV1({ connection: f.connection, id: f.authorization.id,
      source: f.source, spec: {}, driver: f.driver });
    expect(prepared).toEqual(f.authorization); expect(f.assertSourcePlacement).toHaveBeenCalledWith({}, before);
    expect(f.verifyReleaseTargets).not.toHaveBeenCalled(); expect(f.connection).toEqual(before);
    expect((authentication as any).cloudDeploymentEffectiveSourceV1(f.connection, prepared)).toEqual(f.source);
    expect((authentication as any).cloudDeploymentSourceAuthorityDigestV1(f.connection, prepared)).toBe(prepared.digest);
  });
  it('rejects tampering, cross-connection scope, foreign repositories and credential-shaped extra fields', () => {
    const f = fixture();
    for (const value of [{ ...f.authorization, digest: 'f'.repeat(64) }, { ...f.authorization, connectionDigest: 'e'.repeat(64) },
      { ...f.authorization, token: 'private-token' }, { ...f.authorization, source: { ...f.source, repository: 'github.com/other/app' } }]) {
      expect(() => (authentication as any).parseCloudDeploymentSourceAuthorizationV1(value, f.connection)).toThrow();
    }
    expect(() => authentication.validateCloudDeploymentAdapterInputV1({ connection: { ...f.connection, environment: 'staging' },
      sourceAuthorization: f.authorization, capability: 'provision', authentication: transient(f.connection) }, f.contract)).toThrow();
  });
  it('links a later explicit transfer to the active predecessor, with no same-branch or changed placement shortcut', () => {
    const f = fixture(), source = { ...f.source, branch: 'trunk', revision: 'e'.repeat(40) };
    const next = (hosted as any).prepareCloudDeploymentSourceAuthorizationV1({ connection: f.connection, previous: f.authorization,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', source, spec: {}, driver: f.driver });
    expect(next.from).toEqual(f.source); expect(next.previousDigest).toBe(f.authorization.digest);
    expect(() => (hosted as any).prepareCloudDeploymentSourceAuthorizationV1({ connection: f.connection, previous: f.authorization,
      id: next.id, source: f.source, spec: {}, driver: f.driver })).toThrow();
    f.assertSourcePlacement.mockImplementation(() => { throw new Error('Different native placement'); });
    expect(() => (hosted as any).prepareCloudDeploymentSourceAuthorizationV1({ connection: f.connection, id: next.id, source, spec: {}, driver: f.driver })).toThrow();
  });
});
