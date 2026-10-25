import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProviderRegistry } from '../provider.registry.js';
import type { CloudDeploymentAdapterInputV1, CloudDeploymentConnectionV1 } from '../../ports/cloud-deployment.port.js';

// Synthetic registry/token boundary, not native STS compatibility evidence.
const provision = { kind: 'aws-role' as const, accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/provision', roleId: 'AROA1111111111111111', audience: 'https://hypervibe.dev/deployment/provision' };
const release = { ...provision, roleArn: 'arn:aws:iam::123456789012:role/release', roleId: 'AROA2222222222222222', audience: 'https://hypervibe.dev/deployment/release' };
const connection: CloudDeploymentConnectionV1 = { schemaVersion: 1, purpose: 'deployment', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planDigest: 'a'.repeat(64),
  customerId: 'customer', appId: 'app', environment: 'production', provider: 'aws', hostingProvider: 'test-hosting', nativeScope: { accountId: provision.accountId, region: 'us-west-2' },
  deployment: { hostingProvider: 'test-hosting', region: 'us-west-2', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'b'.repeat(40), specDigest: 'c'.repeat(64) },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789', serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com',
    subject: '123456789012345678901', issuer: 'https://accounts.google.com' }, principals: { provision, release },
  runtimeIdentities: (['task', 'execution', 'infrastructure'] as const).map((purpose, index) => ({ workload: 'web', installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner: 'd'.repeat(64),
    principal: { kind: 'aws-role', purpose, accountId: provision.accountId, roleArn: `arn:aws:iam::${provision.accountId}:role/${purpose}`, roleId: `AROA333333333333333${index}` } })) };
function fixture(declared = true) {
  const registry = new ProviderRegistry(); const legacy = vi.fn(() => ({ legacy: true }));
  const factory = vi.fn(async (input: CloudDeploymentAdapterInputV1) => ({ input }));
  registry.register({ metadata: { name: 'test-hosting', displayName: 'Synthetic hosting', category: 'deployment', credentialsSchema: z.object({ secret: z.string() }) }, factory: legacy,
    ...(declared ? { transientAuthentication: { provider: 'aws' as const, hostingProvider: 'test-hosting',
      parseScope: (value: unknown) => z.object({ accountId: z.string().regex(/^\d{12}$/), region: z.literal('us-west-2') }).strict().parse(value), createAdapter: factory } } : {}) });
  const getCredentials = vi.fn(async () => ({ accessKeyId: 'ASIA1111111111111111', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session', expiresAt: new Date(Date.now() + 900_000).toISOString() }));
  const input: CloudDeploymentAdapterInputV1 = { connection, capability: 'provision', authentication: { kind: 'aws-sts', principal: provision, getCredentials } };
  return { registry, legacy, factory, getCredentials, input };
}
describe('registry declared transient deployment authentication', () => {
  it('requires explicit declaration and never falls back to legacy credentials', async () => {
    const f = fixture(false);
    await expect(f.registry.createTransientAdapter('test-hosting', f.input)).rejects.toThrow();
    expect(f.legacy).not.toHaveBeenCalled(); expect(f.getCredentials).not.toHaveBeenCalled();
  });
  it('constructs with bound refresh callbacks without obtaining or persisting cloud credentials', async () => {
    const f = fixture(); const adapter = await f.registry.createTransientAdapter<{ input: CloudDeploymentAdapterInputV1 }>('test-hosting', f.input);
    expect(f.getCredentials).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
    if (adapter.input.authentication.kind !== 'aws-sts') throw new Error('Wrong auth kind');
    await adapter.input.authentication.getCredentials(new AbortController().signal);
    await adapter.input.authentication.getCredentials(new AbortController().signal);
    expect(f.getCredentials).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(adapter.input.connection)).not.toMatch(/synthetic-secret|synthetic-session|accessKeyId/);
  });
  it('rejects purpose/principal substitution and undeclared native scope fields before construction', async () => {
    const f = fixture();
    for (const input of [
      { ...f.input, capability: 'release' as const },
      { ...f.input, connection: { ...connection, purpose: 'collection' } },
      { ...f.input, connection: { ...connection, nativeScope: { ...connection.nativeScope, clientSecret: 'value' } } },
    ]) await expect(f.registry.createTransientAdapter('test-hosting', input as any)).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled(); expect(f.getCredentials).not.toHaveBeenCalled();
  });
  it('rejects expired, incomplete and value-echoing responses with credential-free errors', async () => {
    const f = fixture(); const adapter = await f.registry.createTransientAdapter<{ input: CloudDeploymentAdapterInputV1 }>('test-hosting', f.input);
    if (adapter.input.authentication.kind !== 'aws-sts') throw new Error('Wrong auth kind');
    f.getCredentials.mockResolvedValueOnce({ accessKeyId: 'ASIA1111111111111111', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session', expiresAt: new Date(Date.now() - 1).toISOString() });
    await expect(adapter.input.authentication.getCredentials(new AbortController().signal)).rejects.toMatchObject({ code: 'authorization_expired' });
    f.getCredentials.mockRejectedValueOnce(new Error('provider echoed synthetic-secret'));
    await expect(adapter.input.authentication.getCredentials(new AbortController().signal)).rejects.toMatchObject({ message: 'Cloud deployment access: authorization_unavailable.' });
    f.getCredentials.mockResolvedValueOnce({ accessKeyId: 'ASIA1111111111111111', secretAccessKey: 'synthetic-secret', expiresAt: new Date(Date.now() + 900_000).toISOString() } as any);
    await expect(adapter.input.authentication.getCredentials(new AbortController().signal)).rejects.toMatchObject({ code: 'authorization_unavailable' });
  });
});
