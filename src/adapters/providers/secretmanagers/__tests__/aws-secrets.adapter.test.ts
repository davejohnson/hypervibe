import { afterEach, describe, expect, it, vi } from 'vitest';
import { AwsSecretsAdapter } from '../aws-secrets.adapter.js';

function stubListSecretsFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => Response.json({ SecretList: [] }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('AwsSecretsAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('signs requests with X-Amz-Security-Token when a sessionToken is provided', async () => {
    const fetchMock = stubListSecretsFetch();

    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      sessionToken: 'sts-session-token',
    });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    const headers = requestHeaders(fetchMock);
    expect(headers['X-Amz-Security-Token']).toBe('sts-session-token');
    expect(headers['Authorization']).toContain(
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token'
    );
  });

  it('omits the security token header when no sessionToken is set', async () => {
    const fetchMock = stubListSecretsFetch();

    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    const headers = requestHeaders(fetchMock);
    expect(headers['X-Amz-Security-Token']).toBeUndefined();
    expect(headers['Authorization']).toContain('SignedHeaders=content-type;host;x-amz-date,');
  });

  it('falls back to AWS_SESSION_TOKEN alongside the key environment variables', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA_ENV');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', 'env-session-token');
    const fetchMock = stubListSecretsFetch();

    const adapter = new AwsSecretsAdapter();
    await adapter.connect({ region: 'us-east-1' });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    const headers = requestHeaders(fetchMock);
    expect(headers['X-Amz-Security-Token']).toBe('env-session-token');
    expect(headers['Authorization']).toContain('Credential=AKIA_ENV/');
  });
});
