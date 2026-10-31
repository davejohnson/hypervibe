import { describe, expect, it, vi } from 'vitest';
import { createGcpSecretDestinationDriver } from '../../src/adapters/providers/gcp/gcp-secret-destination.js';
import { createAzureSecretDestinationDriver } from '../../src/adapters/providers/azure/azure-secret-destination.js';
import { createAwsSecretDestinationDriver } from '../../src/adapters/providers/aws/aws-secret-destination.js';
import { runtimeSecretReferenceSchema } from '../../src/domain/ports/secret-destination.port.js';

// Reconstructed wire contracts, reviewed 2026-10-24. Official source links and
// unsupported providers are recorded in docs/secret-destination-delivery.md.
// Only transport/auth-token acquisition is controlled; serialization is real.
const value = 'synthetic-owner-value-do-not-persist';
const attemptId = '0c32f514-7d53-4d72-8792-cc6c5635ed72';
const context = { accountId: 'hc-account', repository: 'acme/app', environment: 'staging', key: 'FLOW_KEY',
  sourceRevision: 'a'.repeat(40), sourceDigest: 'b'.repeat(64) };
const gcp = { provider: 'gcp-secret-manager' as const, projectId: 'test-project', projectNumber: '123456789012', secretId: 'staging-flow' };
const azure = { provider: 'azure-key-vault' as const, tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: '22222222-2222-4222-8222-222222222222', resourceGroup: 'test-group', vaultName: 'test-vault', secretName: 'staging-flow' };
const aws = { provider: 'aws-secrets' as const, accountId: '123456789012', region: 'us-west-2',
  secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:staging-flow-AbCdEf' };
const options = { deadlineMs: 1000 };
const json = (body: unknown, status = 200) => Response.json(body, { status });
const gcpProject = { name: 'projects/123456789012', projectId: 'test-project', state: 'ACTIVE' };
const azureVault = { id: `/subscriptions/${azure.subscriptionId}/resourceGroups/test-group/providers/Microsoft.KeyVault/vaults/test-vault`,
  properties: { tenantId: azure.tenantId, vaultUri: 'https://test-vault.vault.azure.net/' } };
const stsHandler = { handle: async () => ({ response: { statusCode: 200, headers: { 'content-type': 'text/xml' },
  body: new TextEncoder().encode(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/test</Arn><UserId>synthetic</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`) } }) };

describe('secret destination real serialized boundaries', () => {
  function scopedWriter(provider: 'aws' | 'gcp' | 'azure') {
    const events: string[] = [];
    if (provider === 'aws') {
      const handler = { handle: async (request: { headers: Record<string, string>; body: string }) => {
        const target = request.headers['x-amz-target']; const body = JSON.parse(request.body);
        let response;
        if (target.endsWith('.DescribeSecret')) response = { ARN: aws.secretArn };
        else if (target.endsWith('.ListSecretVersionIds')) { events.push('last-read'); response = { ARN: aws.secretArn, Versions: [] }; }
        else { events.push('write'); response = { ARN: aws.secretArn, VersionId: body.ClientRequestToken, VersionStages: body.VersionStages }; }
        return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: new TextEncoder().encode(JSON.stringify(response)) } };
      } };
      return { events, destination: aws, driver: createAwsSecretDestinationDriver({ accountId: aws.accountId, region: aws.region,
        credentials: { accessKeyId: 'synthetic-access-key', secretAccessKey: 'synthetic-secret-key' } }, { requestHandler: handler, stsRequestHandler: stsHandler }) };
    }
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://cloudresourcemanager.googleapis.com/')) return json(gcpProject);
      if (String(url).startsWith('https://management.azure.com/')) return json(azureVault);
      if (init?.method === 'PUT' || init?.method === 'POST') {
        events.push('write');
        return provider === 'gcp' ? json({ name: 'projects/123456789012/secrets/staging-flow/versions/1', state: 'ENABLED' })
          : json({ ...JSON.parse(String(init.body)), id: `https://test-vault.vault.azure.net/secrets/staging-flow/${'d'.repeat(32)}` });
      }
      if (String(url).includes('/versions')) { events.push('last-read'); return json(provider === 'gcp' ? {} : { value: [] }); }
      return json({ name: 'projects/123456789012/secrets/staging-flow' });
    };
    return { events, destination: provider === 'gcp' ? gcp : azure, driver: provider === 'gcp'
      ? createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber, getAccessToken: async () => 'synthetic-token' }, { fetch: request })
      : createAzureSecretDestinationDriver({ tenantId: azure.tenantId, subscriptionId: azure.subscriptionId, getAccessToken: async () => 'synthetic-token' }, { fetch: request }) };
  }
  it.each(['aws', 'gcp', 'azure'] as const)('%s rechecks host authority after the final native metadata read and refuses revoked authority before writing', async provider => {
    const { events, destination, driver } = scopedWriter(provider);
    const beforeWrite = vi.fn(async () => { events.push('authorization'); throw new Error(value); });
    const result = await driver.deliver({ attemptId, context, destination }, value, { ...options, beforeWrite });
    expect(result).toEqual({ status: 'unknown', code: 'authorization_unconfirmed' });
    expect(events).toEqual(['last-read', 'authorization']); expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(value);
  });
  it.each(['aws', 'gcp', 'azure'] as const)('%s dispatches only after the accepted final authority check', async provider => {
    const { events, destination, driver } = scopedWriter(provider);
    const result = await driver.deliver({ attemptId, context, destination }, value, { ...options,
      beforeWrite: async () => { events.push('authorization'); } });
    expect(result.status).toBe('delivered'); expect(events).toEqual(['last-read', 'authorization', 'write']);
  });
  it.each(['aws', 'gcp', 'azure'] as const)('%s stops when final authorization cancels its operation', async provider => {
    const { events, destination, driver } = scopedWriter(provider); const controller = new AbortController();
    const result = await driver.deliver({ attemptId, context, destination }, value, { ...options, signal: controller.signal,
      beforeWrite: async () => { events.push('authorization'); controller.abort(); } });
    expect(result).toEqual({ status: 'unknown', code: 'deadline_exceeded' });
    expect(events).toEqual(['last-read', 'authorization']);
  });
  it('the final authorization callback shares the operation deadline and cannot write after timing out', async () => {
    const { events, destination, driver } = scopedWriter('gcp');
    let release!: () => void;
    const result = await driver.deliver({ attemptId, context, destination }, value, { deadlineMs: 30,
      beforeWrite: async () => { events.push('authorization'); await new Promise<void>(resolve => { release = resolve; }); } });
    expect(result).toEqual({ status: 'unknown', code: 'deadline_exceeded' }); release();
    await Promise.resolve(); expect(events).toEqual(['last-read', 'authorization']);
  });
  it.each(['observe', 'deliver'] as const)('GCP %s independently binds project number to ID before secret access even with cross-project credentials', async action => {
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://cloudresourcemanager.googleapis.com/')) return json({ ...gcpProject, projectId: 'other-project' });
      // The token can access the numbered project. Secret access alone cannot
      // prove that number belongs to the project ID approved by the owner.
      if (String(url).endsWith(':addVersion')) return json({ name: 'projects/123456789012/secrets/staging-flow/versions/1', state: 'ENABLED' });
      if (String(url).includes('/versions')) return json({});
      return json({ name: 'projects/123456789012/secrets/staging-flow' });
    });
    const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: async () => 'synthetic-cross-project-token' }, { fetch: request });
    const result = action === 'deliver' ? await driver.deliver({ attemptId, context, destination: gcp }, value, options) : await driver.observe(gcp, options);
    expect(result).toEqual({ status: action === 'deliver' ? 'rejected' : 'unknown', code: 'scope_mismatch' });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual(['https://cloudresourcemanager.googleapis.com/v3/projects/123456789012']);
  });
  it.each([{ ...gcpProject, state: 'DELETE_REQUESTED' }, { name: gcpProject.name }, {}])('GCP blocks incomplete or inactive project metadata before secret work', async project => {
    const request = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://cloudresourcemanager.googleapis.com/')
      ? json(project) : String(url).includes('/versions') ? json({}) : json({ name: 'projects/123456789012/secrets/staging-flow' }));
    const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    expect((await driver.observe(gcp, options)).status).toBe('unknown');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([403, 404])('GCP project metadata HTTP %s does not imply an absent secret', async status => {
    const request = vi.fn(async () => json({ error: { message: value } }, status));
    const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    expect(await driver.observe(gcp, options)).toEqual({ status: 'unknown', code: status === 403 ? 'access_denied' : 'provider_unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([{ versions: [] }, {}])('GCP writes once to the exact existing empty secret and returns only a numeric version reference (%j)', async emptyVersions => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://cloudresourcemanager.googleapis.com/')) return json(gcpProject);
      if (String(url).endsWith(':addVersion')) {
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(JSON.parse(String(init?.body)).payload.data).toBe(Buffer.from(value).toString('base64'));
        return json({ name: 'projects/123456789012/secrets/staging-flow/versions/1', state: 'ENABLED' });
      }
      if (String(url).includes('/versions')) return json(emptyVersions);
      return json({ name: 'projects/123456789012/secrets/staging-flow' });
    });
    const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    const result = await driver.deliver({ attemptId, context, destination: gcp }, value, options);
    expect(result).toEqual({ status: 'delivered', reference: { destination: gcp, version: '1' } });
    expect(JSON.stringify(result)).not.toContain(value);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('GCP never replays an uncertain addVersion or adopts another newly visible version', async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://cloudresourcemanager.googleapis.com/')) return json(gcpProject);
      if (String(url).endsWith(':addVersion')) throw new Error(value);
      if (String(url).includes('/versions')) return json({ versions: [] });
      return json({ name: 'projects/123456789012/secrets/staging-flow' });
    });
    const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    const attempt = { attemptId, context, destination: gcp };
    const result = await driver.deliver(attempt, value, options);
    expect(result).toEqual({ status: 'unknown', code: 'write_uncertain' });
    request.mockClear();
    expect(await driver.reconcile(attempt, options)).toEqual({ status: 'unknown', code: 'reconciliation_unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects second-environment/project identity substitution before credentials or transport', async () => {
    const token = vi.fn(async () => 'synthetic-token');
    const request = vi.fn();
    const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: token }, { fetch: request });
    expect(await driver.deliver({ attemptId, context, destination: { ...gcp, projectNumber: '999999999999' } }, value, options))
      .toEqual({ status: 'rejected', code: 'scope_mismatch' });
    expect(token).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses existing GCP versions and unknown metadata without adding a version', async () => {
    for (const response of [json({ versions: [{ name: 'projects/123456789012/secrets/staging-flow/versions/1', state: 'ENABLED' }] }),
      json({ error: { message: value } }, 403), json({ versions: [{ state: 'ENABLED' }] })]) {
      const request = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://cloudresourcemanager.googleapis.com/')
        ? json(gcpProject) : String(url).includes('/versions') ? response : json({ name: 'projects/123456789012/secrets/staging-flow' }));
      const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
        getAccessToken: async () => 'synthetic-token' }, { fetch: request });
      const result = await driver.deliver({ attemptId, context, destination: gcp }, value, options);
      expect(result.status).not.toBe('delivered');
      expect(JSON.stringify(result)).not.toContain(value);
      expect(request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    }
  });

  it('Azure correlates a version tag after an uncertain response without a second SET or value read', async () => {
    let submitted: Record<string, unknown> | undefined;
    let recovering = false;
    const version = 'c'.repeat(32);
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://management.azure.com/')) return json(azureVault);
      if (init?.method === 'PUT') { submitted = JSON.parse(String(init.body)); throw new Error(value); }
      expect(String(url)).toContain('/secrets/staging-flow/versions?');
      return json({ value: recovering ? [{ id: `https://test-vault.vault.azure.net/secrets/staging-flow/${version}`,
        tags: submitted?.tags, attributes: { enabled: true } }] : [] });
    });
    const driver = createAzureSecretDestinationDriver({ tenantId: azure.tenantId, subscriptionId: azure.subscriptionId,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    const attempt = { attemptId, context, destination: azure };
    expect(await driver.deliver(attempt, value, options)).toEqual({ status: 'unknown', code: 'write_uncertain' });
    recovering = true;
    expect(await driver.reconcile(attempt, options)).toEqual({ status: 'delivered', reference: { destination: azure, version } });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(submitted?.value).toBe(value);
  });

  it('Azure discards echoed values and rejects foreign pagination destinations without following them', async () => {
    const request = vi.fn(async (url: string | URL | Request) => String(url).startsWith('https://management.azure.com/')
      ? json(azureVault) : json({ value: [], nextLink: `https://attacker.invalid/secrets?echo=${value}` }));
    const driver = createAzureSecretDestinationDriver({ tenantId: azure.tenantId, subscriptionId: azure.subscriptionId,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    const result = await driver.reconcile({ attemptId, context, destination: azure }, options);
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(value);
    expect(request.mock.calls.every(([url]) => !String(url).includes('attacker.invalid'))).toBe(true);
  });

  it('AWS SDK sends the stable native version token and recovers it without GetSecretValue', async () => {
    const requests: Array<{ target: string; body: Record<string, unknown> }> = [];
    let written = false;
    const handler = { handle: async (request: { headers: Record<string, string>; body: string }) => {
      const target = request.headers['x-amz-target'];
      const body = JSON.parse(request.body); requests.push({ target, body });
      let result: unknown;
      if (target.endsWith('.DescribeSecret')) result = { ARN: aws.secretArn, Name: 'staging-flow', VersionIdsToStages: {} };
      else if (target.endsWith('.ListSecretVersionIds')) result = { ARN: aws.secretArn, Versions: written ? [{ VersionId: attemptId, VersionStages: [`hv-${attemptId}`] }] : [] };
      else if (target.endsWith('.PutSecretValue')) { written = true; throw new Error(value); }
      else throw new Error('unexpected AWS operation');
      return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: new TextEncoder().encode(JSON.stringify(result)) } };
    } };
    const driver = createAwsSecretDestinationDriver({ accountId: aws.accountId, region: aws.region,
      credentials: { accessKeyId: 'synthetic-access-key', secretAccessKey: 'synthetic-secret-key' } },
    { requestHandler: handler, stsRequestHandler: { handle: async (request: { body: string }) => {
      expect(String(request.body)).toContain('Action=GetCallerIdentity');
      return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: new TextEncoder().encode(
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/test</Arn><UserId>synthetic</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></GetCallerIdentityResponse>`) } };
    } } });
    const attempt = { attemptId, context, destination: aws };
    expect(await driver.deliver(attempt, value, options)).toEqual({ status: 'unknown', code: 'write_uncertain' });
    expect(await driver.reconcile(attempt, options)).toEqual({ status: 'delivered', reference: { destination: aws, version: attemptId } });
    expect(requests.filter(r => r.target.endsWith('.PutSecretValue'))).toEqual([{ target: 'secretsmanager.PutSecretValue', body: {
      SecretId: aws.secretArn, SecretString: value, ClientRequestToken: attemptId, VersionStages: [`hv-${attemptId}`],
    } }]);
    expect(requests.some(r => r.target.endsWith('.GetSecretValue'))).toBe(false);
  });

  it('rejects floating versions and mismatched complete AWS resource scope', () => {
    expect(runtimeSecretReferenceSchema.safeParse({ destination: gcp, version: 'latest' }).success).toBe(false);
    expect(runtimeSecretReferenceSchema.safeParse({ destination: { ...aws, accountId: '999999999999' }, version: attemptId }).success).toBe(false);
    expect(runtimeSecretReferenceSchema.safeParse({ destination: azure, version: 'current' }).success).toBe(false);
  });

  it('rejects missing transient values before token or metadata work', async () => {
    const token = vi.fn(async () => 'synthetic-token');
    const request = vi.fn(async () => json({ name: 'projects/123456789012/secrets/staging-flow' }));
    const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: token }, { fetch: request });
    expect(await driver.deliver({ attemptId, context, destination: gcp }, undefined as unknown as string, options))
      .toEqual({ status: 'rejected', code: 'invalid_input' });
    expect(token).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds AWS SDK serialized response bodies instead of accepting oversized ignored fields', async () => {
    const handler = { handle: async (request: { headers: Record<string, string> }) => ({ response: { statusCode: 200,
      headers: { 'content-type': 'application/x-amz-json-1.1' }, body: new TextEncoder().encode(JSON.stringify(
        request.headers['x-amz-target'].endsWith('.DescribeSecret')
          ? { ARN: aws.secretArn, Name: 'staging-flow', ignored: 'x'.repeat(1_048_577) }
          : { ARN: aws.secretArn, Versions: [] })) } }) };
    const driver = createAwsSecretDestinationDriver({ accountId: aws.accountId, region: aws.region,
      credentials: { accessKeyId: 'synthetic-access-key', secretAccessKey: 'synthetic-secret-key' } },
    { requestHandler: handler, stsRequestHandler: stsHandler });
    expect(await driver.observe(aws, options)).toEqual({ status: 'unknown', code: 'invalid_response' });
  });

  it('Azure returns a value-free receipt even when its real success response echoes the submitted value', async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://management.azure.com/')) return json(azureVault);
      if (init?.method === 'PUT') {
        const submitted = JSON.parse(String(init.body));
        return json({ ...submitted, id: `https://test-vault.vault.azure.net/secrets/staging-flow/${'d'.repeat(32)}` });
      }
      return json({ value: [] });
    });
    const driver = createAzureSecretDestinationDriver({ tenantId: azure.tenantId, subscriptionId: azure.subscriptionId,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    const result = await driver.deliver({ attemptId, context, destination: azure }, value, options);
    expect(result).toEqual({ status: 'delivered', reference: { destination: azure, version: 'd'.repeat(32) } });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it('bounds a stalled REST body and refuses a foreign Azure vault before any data-plane call', async () => {
    let cancelled = false;
    const gcpDriver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: async () => 'synthetic-token' }, { fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
    })) });
    expect(await gcpDriver.observe(gcp, { deadlineMs: 20 })).toEqual({ status: 'unknown', code: 'deadline_exceeded' });
    expect(cancelled).toBe(true);
    const request = vi.fn(async () => json({ ...azureVault, properties: { ...azureVault.properties, vaultUri: 'https://other-vault.vault.azure.net/' } }));
    const azureDriver = createAzureSecretDestinationDriver({ tenantId: azure.tenantId, subscriptionId: azure.subscriptionId,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    expect(await azureDriver.deliver({ attemptId, context, destination: azure }, value, options))
      .toEqual({ status: 'unknown', code: 'invalid_response' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('an already cancelled call does not request tokens or enter provider work', async () => {
    const token = vi.fn(async () => 'synthetic-token');
    const request = vi.fn(async () => json({}));
    const driver = createGcpSecretDestinationDriver({ projectId: gcp.projectId, projectNumber: gcp.projectNumber,
      getAccessToken: token }, { fetch: request });
    const cancelled = new AbortController(); cancelled.abort();
    expect(await driver.deliver({ attemptId, context, destination: gcp }, value, { signal: cancelled.signal }))
      .toEqual({ status: 'unknown', code: 'deadline_exceeded' });
    expect(token).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('Azure recovery rejects duplicate tagged versions and never accepts a tag from another source context', async () => {
    let submitted: Record<string, unknown> | undefined;
    let recovering = false;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://management.azure.com/')) return json(azureVault);
      if (init?.method === 'PUT') { submitted = JSON.parse(String(init.body)); throw new Error(value); }
      return json({ value: recovering ? ['c', 'd'].map(char => ({ id: `https://test-vault.vault.azure.net/secrets/staging-flow/${char.repeat(32)}`,
        attributes: { enabled: true }, tags: submitted?.tags })) : [] });
    });
    const driver = createAzureSecretDestinationDriver({ tenantId: azure.tenantId, subscriptionId: azure.subscriptionId,
      getAccessToken: async () => 'synthetic-token' }, { fetch: request });
    const attempt = { attemptId, context, destination: azure };
    await driver.deliver(attempt, value, options); recovering = true;
    expect(await driver.reconcile(attempt, options)).toEqual({ status: 'unknown', code: 'attempt_ambiguous' });
    expect(await driver.reconcile({ ...attempt, context: { ...context, environment: 'production' } }, options))
      .toEqual({ status: 'unknown', code: 'attempt_not_found' });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
});
