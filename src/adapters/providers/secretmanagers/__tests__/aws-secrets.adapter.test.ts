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
    vi.unstubAllGlobals();
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
      'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target'
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
    expect(headers['Authorization']).toContain('SignedHeaders=content-type;host;x-amz-date;x-amz-target,');
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

  it('uses the AWS SDK default provider chain when explicit keys are omitted', async () => {
    const resolveDefaultCredentials = vi.fn(async () => ({
      accessKeyId: 'AKIA_PROFILE',
      secretAccessKey: 'profile-secret',
      sessionToken: 'profile-session',
    }));
    const fetchMock = stubListSecretsFetch();

    const adapter = new AwsSecretsAdapter(resolveDefaultCredentials);
    await adapter.connect({ region: 'us-west-2' });
    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(resolveDefaultCredentials).toHaveBeenCalledOnce();
    const headers = requestHeaders(fetchMock);
    expect(headers['Authorization']).toContain('Credential=AKIA_PROFILE/');
    expect(headers['X-Amz-Security-Token']).toBe('profile-session');
  });

  it('rejects a partial explicit key pair instead of mixing credential sources', async () => {
    const adapter = new AwsSecretsAdapter(vi.fn());

    await expect(adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_PARTIAL',
    })).rejects.toThrow('accessKeyId and secretAccessKey must be provided together');
  });

  it('sends and verifies the requested secret version', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app',
      Name: 'app',
      VersionId: 'version-2',
      SecretString: JSON.stringify({ API_KEY: 'secret' }),
      VersionStages: ['AWSCURRENT'],
      CreatedDate: 1,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });

    await expect(adapter.getSecret('app', 'API_KEY', 'version-1')).rejects.toThrow(
      'returned version version-2, not requested version version-1'
    );
    const calls = fetchMock.mock.calls as unknown[][];
    const init = calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ SecretId: 'app', VersionId: 'version-1' });
  });

  it('rejects a key selector for a binary secret instead of ignoring it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:binary',
      Name: 'binary',
      VersionId: 'version-1',
      SecretBinary: Buffer.from('secret').toString('base64'),
      VersionStages: ['AWSCURRENT'],
      CreatedDate: 1,
    })));
    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });

    await expect(adapter.getSecret('binary', 'API_KEY')).rejects.toThrow(
      "Cannot select key 'API_KEY' from binary secret"
    );
  });

  it('enforces name prefixes after AWS list responses', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      SecretList: [
        { ARN: 'arn:one', Name: 'production/api' },
        { ARN: 'arn:two', Name: 'staging/api' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AwsSecretsAdapter();
    await adapter.connect({
      region: 'us-east-1',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
    });

    await expect(adapter.listSecrets('production/')).resolves.toEqual([
      { path: 'production/api', updatedAt: undefined },
    ]);
    const calls = fetchMock.mock.calls as unknown[][];
    const init = calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      Filters: [{ Key: 'name', Values: ['production/'] }],
    });
  });

  // #330: the action (X-Amz-Target) is part of the signature, so it cannot be swapped in transit.
  // The expected signature is derived here from the AWS Signature Version 4 specification, not from the adapter.
  it('signs the action header and produces the Signature Version 4 value for the request it sends', async () => {
    const { createHash, createHmac } = await import('node:crypto');
    const fetchMock = stubListSecretsFetch();
    const adapter = new AwsSecretsAdapter();
    await adapter.connect({ region: 'eu-west-1', accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret', sessionToken: 'sts-session-token' });
    await adapter.verify();
    const headers = requestHeaders(fetchMock);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();
    const amzDate = headers['X-Amz-Date']!; const date = amzDate.slice(0, 8);
    const canonical = ['POST', '/', '',
      `content-type:application/x-amz-json-1.1\nhost:${new URL(url).host}\nx-amz-date:${amzDate}\nx-amz-security-token:sts-session-token\nx-amz-target:${headers['X-Amz-Target']}\n`,
      'content-type;host;x-amz-date;x-amz-security-token;x-amz-target', sha(init.body)].join('\n');
    const scope = `${date}/eu-west-1/secretsmanager/aws4_request`;
    const key = hmac(hmac(hmac(hmac('AWS4secret', date), 'eu-west-1'), 'secretsmanager'), 'aws4_request');
    const signature = createHmac('sha256', key).update(['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n')).digest('hex');
    expect(headers['X-Amz-Target']).toMatch(/^secretsmanager\./);
    expect(headers['Authorization']).toBe(`AWS4-HMAC-SHA256 Credential=AKIA_TEST/${scope}, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=${signature}`);
  });

  // #368: the region becomes part of the host name that receives the signed request.
  it.each(['us-east-1.attacker.example/x', 'evil.example#', 'us-east-1@evil.example', 'US-EAST-1'])('refuses the region %j before sending anything', async (region) => {
    const fetchMock = stubListSecretsFetch();
    const adapter = new AwsSecretsAdapter();
    // Refused when connecting, or at the latest when the request is built; never sent.
    const outcome = await (async () => { await adapter.connect({ region, accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' }); return adapter.verify(); })().catch(() => ({ success: false }));
    expect(outcome.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['us-east-1', 'eu-central-2', 'us-gov-west-1', 'ap-southeast-4'])('sends region %s only to its own AWS host', async (region) => {
    const fetchMock = stubListSecretsFetch();
    const adapter = new AwsSecretsAdapter();
    await adapter.connect({ region, accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret' });
    await adapter.verify();
    expect(new URL((fetchMock.mock.calls[0] as [string])[0]).host).toBe(`secretsmanager.${region}.amazonaws.com`);
  });
});
