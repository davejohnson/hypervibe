import { describe, expect, it, vi } from 'vitest';
import * as sessions from '../cloud-deployment-session.js';
import type { CloudDeploymentConnectionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import type { CloudInstallationDriver } from '../../../domain/ports/cloud-installation.port.js';

// Synthetic shared broker boundary; native IAM/token proof is tested by provider transports.
const principal = (name: string, id: string) => ({ kind: 'gcp-service-account' as const, projectId: 'customer-project', projectNumber: '987654321',
  serviceAccountEmail: `${name}@customer-project.iam.gserviceaccount.com`, serviceAccountUniqueId: id });
const connection: CloudDeploymentConnectionV1 = { schemaVersion: 1, purpose: 'deployment', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planDigest: 'a'.repeat(64),
  customerId: 'customer', appId: 'app', environment: 'production', provider: 'gcp', hostingProvider: 'cloudrun', nativeScope: { projectId: 'customer-project', projectNumber: '987654321' },
  deployment: { hostingProvider: 'cloudrun', region: 'us-central1', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'b'.repeat(40), specDigest: 'c'.repeat(64) },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789', serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com',
    subject: '123456789012345678901', issuer: 'https://accounts.google.com' },
  runtimeIdentities: [{ workload: 'web', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner: 'd'.repeat(64), principal: principal('runtime', '333333333333333333333') }],
  principals: { provision: principal('provision', '111111111111111111111'), release: principal('release', '222222222222222222222') } };
function fixture() {
  const issueSession = vi.fn(async (input: any) => { await input.beforeIssue(); return { kind: 'gcp-impersonation', principal: connection.principals[input.capability as 'provision'],
    token: 'transient-secret', expiresAt: new Date(Date.now() + 900_000).toISOString() }; });
  const driver = { provider: 'gcp', parseScope: (value: unknown) => value, deployment: { hostingProvider: 'cloudrun', issueSession,
    assertSourcePlacement: vi.fn() } } as unknown as CloudInstallationDriver;
  const verifyIdentity = vi.fn(async () => connection.hostIdentity);
  const input = { connection, driver, capability: 'provision' as const, authorize: vi.fn(async () => true), signal: new AbortController().signal,
    authentication: { host: { verifyIdentity, getAccessToken: vi.fn(async () => 'host-token'), getIdToken: vi.fn(async () => 'host-jwt') } } };
  return { input, issueSession, verifyIdentity };
}
describe('temporary deployment session boundary', () => {
  it('rechecks independent host identity and authorization immediately before session issuance', async () => {
    const f = fixture(); const result = await sessions.issueCloudDeploymentSessionV1(f.input);
    expect(result).toMatchObject({ kind: 'gcp-impersonation', principal: connection.principals.provision });
    expect(f.input.authorize).toHaveBeenCalledTimes(3); expect(f.verifyIdentity).toHaveBeenCalledTimes(3);
  });
  it('rejects revocation between native observations and minting, without returning provider diagnostics', async () => {
    const f = fixture(); f.input.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(sessions.issueCloudDeploymentSessionV1(f.input)).rejects.toMatchObject({ code: 'authorization_unavailable' });
    f.input.authorize.mockResolvedValue(true); f.issueSession.mockRejectedValueOnce(new Error('echo transient-secret'));
    await expect(sessions.issueCloudDeploymentSessionV1(f.input)).rejects.toMatchObject({ message: 'Cloud deployment access: authorization_unavailable.' });
  });
  it('rejects mismatched host, substituted principals, scope targets, and omitted final authorization', async () => {
    const f = fixture(); f.verifyIdentity.mockResolvedValueOnce({ ...connection.hostIdentity, subject: '999999999999999999999' });
    await expect(sessions.issueCloudDeploymentSessionV1(f.input)).rejects.toThrow(); expect(f.issueSession).not.toHaveBeenCalled();
    await expect(sessions.issueCloudDeploymentSessionV1({ ...f.input, target: 'container-registry' })).rejects.toThrow();
    f.issueSession.mockImplementationOnce(async input => { await input.beforeIssue(); return { kind: 'gcp-impersonation', principal: connection.principals.release,
      token: 'transient-secret', expiresAt: new Date(Date.now() + 900_000).toISOString() }; });
    await expect(sessions.issueCloudDeploymentSessionV1(f.input)).rejects.toThrow();
    f.issueSession.mockImplementationOnce(async () => ({ kind: 'gcp-impersonation', principal: connection.principals.provision,
      token: 'transient-secret', expiresAt: new Date(Date.now() + 900_000).toISOString() }));
    await expect(sessions.issueCloudDeploymentSessionV1(f.input)).rejects.toThrow();
  });
  it('withholds an issued session when authority is revoked while native issuance is in flight', async () => {
    const f = fixture(); let allowed = true;
    f.input.authorize.mockImplementation(async () => allowed);
    f.issueSession.mockImplementationOnce(async input => {
      await input.beforeIssue(); allowed = false;
      return { kind: 'gcp-impersonation', principal: connection.principals.provision,
        token: 'transient-secret', expiresAt: new Date(Date.now() + 900_000).toISOString() };
    });
    await expect(sessions.issueCloudDeploymentSessionV1(f.input)).rejects.toMatchObject({ code: 'authorization_unavailable' });
  });
  it('honors parent cancellation even when a host callback never settles', async () => {
    const f = fixture(); const controller = new AbortController(); f.verifyIdentity.mockImplementationOnce(() => new Promise(() => {}));
    const result = sessions.issueCloudDeploymentSessionV1({ ...f.input, signal: controller.signal }); controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'authorization_unavailable' }); expect(f.issueSession).not.toHaveBeenCalled();
  });
  it('does not dispatch a deferred authority callback after cancellation', async () => {
    const f = fixture(), controller = new AbortController();
    queueMicrotask(() => controller.abort());
    await expect(sessions.issueCloudDeploymentSessionV1({ ...f.input, signal: controller.signal })).rejects.toMatchObject({ code: 'authorization_unavailable' });
    expect(f.input.authorize).not.toHaveBeenCalled();
    expect(f.verifyIdentity).not.toHaveBeenCalled();
    expect(f.issueSession).not.toHaveBeenCalled();
  });
});

describe('native release target verification boundary', () => {
  const targets = [{ workload: 'web', kind: 'service',
    service: { id: 'projects/customer-project/locations/us-central1/services/web-production', lifetimeId: 'native-service-uid' },
    registry: { id: 'projects/customer-project/locations/us-central1/repositories/images', lifetimeId: '2026-10-24T12:00:00Z' } }];
  function releaseFixture() {
    const f = fixture();
    const verifyReleaseTargets = vi.fn(async () => structuredClone(targets));
    Object.assign(f.input.driver.deployment!, { verifyReleaseTargets, parseReleaseTargets: (value: unknown) => value });
    return { ...f, verifyReleaseTargets, releaseInput: { ...f.input, spec: {} as any, bindings: { synthetic: 'untrusted-binding' },
      source: { ...connection.source, revision: 'd'.repeat(40) } } };
  }
  it('binds native observations to the current authorized source without rewriting installation evidence', async () => {
    const f = releaseFixture();
    const result = await (sessions as any).verifyCloudDeploymentReleaseTargetsV1(f.releaseInput);
    expect(result).toEqual({ schemaVersion: 1, installationId: connection.installationId, provider: 'gcp', hostingProvider: 'cloudrun',
      customerId: connection.customerId, appId: connection.appId, environment: connection.environment, source: f.releaseInput.source, targets });
    expect(connection.source.revision).toBe('b'.repeat(40));
    expect(f.verifyReleaseTargets).toHaveBeenCalledOnce();
  });
  it('rejects missing or duplicate workloads and value-bearing native receipts', async () => {
    for (const result of [[], [targets[0], targets[0]], [{ ...targets[0], accessToken: 'must-not-escape' }]]) {
      const f = releaseFixture(); f.verifyReleaseTargets.mockResolvedValue(result as any);
      await expect((sessions as any).verifyCloudDeploymentReleaseTargetsV1(f.releaseInput)).rejects.toThrow();
      expect(f.verifyReleaseTargets).toHaveBeenCalledOnce();
    }
  });
  it('rechecks authority after native observation and never reflects provider diagnostics', async () => {
    const f = releaseFixture(); f.input.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect((sessions as any).verifyCloudDeploymentReleaseTargetsV1(f.releaseInput)).rejects.toThrow();
    expect(f.verifyReleaseTargets).toHaveBeenCalledOnce();
    f.input.authorize.mockResolvedValue(true); f.verifyReleaseTargets.mockRejectedValueOnce(new Error('private-provider-value'));
    await expect((sessions as any).verifyCloudDeploymentReleaseTargetsV1(f.releaseInput)).rejects.toMatchObject({ message: 'Cloud deployment access: authorization_unavailable.' });
  });
});
