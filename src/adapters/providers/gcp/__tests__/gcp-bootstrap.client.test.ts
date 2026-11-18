import { describe, expect, it, vi } from 'vitest';
import {
  GcpBootstrapApiError,
  GcpBootstrapClient,
  GcpBootstrapKeyCleanupRequiredError,
} from '../gcp-bootstrap.client.js';

const PROJECT_ID = 'bootstrap-proj';
const PROJECT_NAME = 'projects/123456789012';
const ACCOUNT_ID = 'hypervibe-deployer';
const ACCOUNT_EMAIL = `${ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com`;
const ACCOUNT_NAME = `projects/${PROJECT_ID}/serviceAccounts/${ACCOUNT_EMAIL}`;
const KEY_NAME = `${ACCOUNT_NAME}/keys/8e6e3936d7024646f8ceb39792006c07f4a9760c`;

function client(fetchImpl: typeof fetch, overrides: {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): GcpBootstrapClient {
  return new GcpBootstrapClient({
    accessToken: 'access-token-that-must-stay-private',
    fetch: fetchImpl,
    sleep: overrides.sleep ?? vi.fn(async () => undefined),
    maxAttempts: overrides.maxAttempts ?? 3,
    delayMs: 7,
  });
}

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: PROJECT_NAME,
    projectId: PROJECT_ID,
    state: 'ACTIVE',
    parent: 'organizations/987654321',
    ...overrides,
  };
}


function key(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: KEY_NAME,
    privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE',
    keyAlgorithm: 'KEY_ALG_RSA_2048',
    ...overrides,
  };
}

describe('GcpBootstrapClient', () => {
  it('treats only an exact 404 as absent and safely redacts provider and transport errors', async () => {
    const absent = client(vi.fn(async () => new Response(
      '{"privateKeyData":"response-secret"}',
      { status: 404 }
    )) as typeof fetch);
    await expect(absent.getProject(PROJECT_ID)).resolves.toBeNull();

    const forbidden = client(vi.fn(async () => new Response(
      '{"privateKeyData":"response-secret","token":"provider-token"}',
      { status: 403 }
    )) as typeof fetch);
    const forbiddenError = await forbidden.getProject(PROJECT_ID).catch((error: unknown) => error);
    expect(forbiddenError).toBeInstanceOf(GcpBootstrapApiError);
    expect(forbiddenError).toMatchObject({ status: 403 });
    expect(String(forbiddenError)).not.toContain('response-secret');
    expect(String(forbiddenError)).not.toContain('provider-token');
    expect(String(forbiddenError)).not.toContain('access-token-that-must-stay-private');

    const transport = client(vi.fn(async () => {
      throw new Error('transport-secret');
    }) as typeof fetch);
    const transportError = await transport.getProject(PROJECT_ID).catch((error: unknown) => error);
    expect(transportError).toMatchObject({ status: undefined });
    expect(String(transportError)).not.toContain('transport-secret');
    expect(String(transportError)).not.toContain('access-token-that-must-stay-private');
  });

  it('rejects a successful null project response, including after a forbidden lookup', async () => {
    await expect(client(async () => Response.json(null)).getProject(PROJECT_ID))
      .rejects.toThrow(/project lookup.*object/);
    const search = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(Response.json(null));
    await expect(client(search).getProject(PROJECT_ID)).rejects.toThrow(/project search.*object/);
  });

  it.each([
    [{}, 'absent'],
    [{ projects: [] }, 'absent'],
    [{ projects: null, nextPageToken: null }, 'absent'],
    [{ projects: {} }, 'projects must be a list'],
    [{ projects: [{}] }, 'projectId is missing'],
  ] as const)('checks the search response before reporting project absence', async (response, expected) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(Response.json(response));
    const read = client(fetch).getProject(PROJECT_ID);
    if (expected === 'absent') {
      await expect(read).resolves.toBeNull();
    } else {
      await expect(read).rejects.toThrow(expected);
    }
  });

  it('continues an incomplete project search before reporting absence', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ projects: [], nextPageToken: 'page 2' }))
      .mockResolvedValueOnce(Response.json({ projects: [project()] }));
    await expect(client(fetch).getProject(PROJECT_ID)).resolves.toMatchObject({ projectId: PROJECT_ID });
    expect(new URL(fetch.mock.calls[2]![0]).searchParams.get('pageToken')).toBe('page 2');
  });

  it.each([
    [{ billingAccounts: {} }, 'billingAccounts must be a list'],
    [{ billingAccounts: [{ name: 'billingAccounts/ABC' }, { name: 'billingAccounts/ABC' }] }, 'name must be unique'],
  ])('names malformed billing list fields without exposing identities', async (body, rule) => {
    const message = String(await client(async () => Response.json(body)).listOpenBillingAccounts().catch(error => error));
    expect(message).toContain(rule);
    expect(message).not.toContain('billingAccounts/ABC');
  });

  it('paginates and returns only exact open Cloud Billing accounts', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/billingAccounts?pageSize=100')) {
        return Response.json({
          billingAccounts: [
            { name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC', open: true, displayName: 'Primary' },
            { name: 'billingAccounts/DDDDDD-EEEEEE-FFFFFF', open: false, displayName: 'Closed' },
          ],
          nextPageToken: 'next page',
        });
      }
      if (url.endsWith('/billingAccounts?pageSize=100&pageToken=next%20page')) {
        return Response.json({
          billingAccounts: [{ name: 'billingAccounts/111111-222222-333333', open: true }],
        });
      }
      throw new Error('Unexpected request');
    });

    await expect(client(fetchMock as typeof fetch).listOpenBillingAccounts()).resolves.toEqual([
      { name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC', open: true, displayName: 'Primary' },
      { name: 'billingAccounts/111111-222222-333333', open: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, false])('filters closed accounts with open=%s across pages', async (open) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        billingAccounts: [{ name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC', open }],
        nextPageToken: 'next page',
      }))
      .mockResolvedValueOnce(Response.json({
        billingAccounts: [{ name: 'billingAccounts/111111-222222-333333', open: true }],
      }));

    await expect(client(fetchMock).listOpenBillingAccounts()).resolves.toEqual([
      { name: 'billingAccounts/111111-222222-333333', open: true },
    ]);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['https://cloudbilling.googleapis.com/v1/billingAccounts?pageSize=100', 'GET'],
      ['https://cloudbilling.googleapis.com/v1/billingAccounts?pageSize=100&pageToken=next%20page', 'GET'],
    ]);
  });

  it.each([undefined, null, ''])('accepts a non-subaccount with masterBillingAccount=%s', async (masterBillingAccount) => {
    const fetchMock = vi.fn(async () => Response.json({ billingAccounts: [
      { name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC', open: true, masterBillingAccount },
      { name: 'billingAccounts/111111-222222-333333', open: true,
        masterBillingAccount: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC' },
    ] }));
    await expect(client(fetchMock).listOpenBillingAccounts()).resolves.toEqual([
      { name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC', open: true },
      { name: 'billingAccounts/111111-222222-333333', open: true,
        masterBillingAccount: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC' },
    ]);
  });

  it.each([
    ['open', 'false', 'true or false'], ['open', 0, 'true or false'], ['open', {}, 'true or false'],
    ['name', undefined, 'missing'], ['name', 'projects/not-a-billing-account', 'billingAccounts/'],
    ['masterBillingAccount', 'bad-parent', 'billingAccounts/'], ['masterBillingAccount', 0, 'text'],
  ] as const)('identifies an invalid billing field %s', async (field, value, rule) => {
    const fetchMock = vi.fn(async () => Response.json({ billingAccounts: [
      { name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC', open: true, [field]: value },
    ] }));
    const message = String(await client(fetchMock).listOpenBillingAccounts().catch(error => error));
    expect(message).toContain(field);
    expect(message).toContain(rule);
    expect(message).not.toContain('AAAAAA-BBBBBB-CCCCCC');
    expect(message).not.toContain('bad-parent');
  });

  it.each([
    {}, { billingEnabled: null, billingAccountName: null },
    { billingEnabled: false, billingAccountName: '' },
    { billingAccountName: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC' },
  ])('normalizes unlinked or disabled project billing: %j', async (fields) => {
    const fetchMock = vi.fn(async () => Response.json({
      name: `projects/${PROJECT_ID}/billingInfo`, projectId: PROJECT_ID, ...fields,
    }));
    await expect(client(fetchMock).getProjectBillingInfo(PROJECT_ID)).resolves.toEqual({
      name: `projects/${PROJECT_ID}/billingInfo`, projectId: PROJECT_ID,
      billingEnabled: false, billingAccountName: fields.billingAccountName ?? '',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://cloudbilling.googleapis.com/v1/projects/${PROJECT_ID}/billingInfo`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it.each([
    { name: undefined }, { projectId: undefined }, { projectId: 'another-project' },
    { billingEnabled: 'false' }, { billingEnabled: 0 },
    { billingAccountName: 0 }, { billingAccountName: 'bad-account' },
    { billingEnabled: true },
  ])('keeps malformed or contradictory project billing unknown: %j', async (fields) => {
    const fetchMock = vi.fn(async () => Response.json({
      name: `projects/${PROJECT_ID}/billingInfo`, projectId: PROJECT_ID, ...fields,
    }));
    const field = fields.billingEnabled === true ? 'billingAccountName' : Object.keys(fields)[0]!;
    const message = String(await client(fetchMock).getProjectBillingInfo(PROJECT_ID).catch(error => error));
    expect(message).toContain(field);
    expect(message).not.toContain(PROJECT_ID);
    expect(message).not.toContain('another-project');
  });

  it('observes exact service state and does not interpret forbidden as absence', async () => {
    const serviceName = 'iam.googleapis.com';
    const stateFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/v3/projects/${PROJECT_ID}`)) return Response.json(project());
      return Response.json({
        name: `${PROJECT_NAME}/services/${serviceName}`,
        parent: PROJECT_NAME,
        config: { name: serviceName },
        state: 'DISABLED',
      });
    });

    await expect(client(stateFetch as typeof fetch).getServiceState(
      PROJECT_ID,
      serviceName
    )).resolves.toBe('DISABLED');

    const forbidden = vi.fn(async (input: string | URL | Request) => (
      String(input).endsWith(`/v3/projects/${PROJECT_ID}`)
        ? Response.json(project())
        : new Response(null, { status: 403 })
    ));
    await expect(client(forbidden as typeof fetch).getServiceState(
      PROJECT_ID,
      serviceName
    )).rejects.toMatchObject({ status: 403 });
  });

  it('identifies rejected project, service, service account and key fields without returning their values', async () => {
    const sensitive = 'unexpected-private-value';
    const serviceName = 'iam.googleapis.com';
    const cases: Array<[() => Promise<unknown>, RegExp]> = [
      [() => client(async () => Response.json(project({ projectId: sensitive }))).getProject(PROJECT_ID), /projectId.*requested/],
      [() => client(async url => String(url).includes('/v3/projects/') ? Response.json(project())
        : Response.json({ name: `${PROJECT_NAME}/services/${serviceName}`, parent: PROJECT_NAME, config: { name: sensitive } }))
        .getServiceState(PROJECT_ID, serviceName), /config.name.*requested/],
      [() => client(async () => Response.json({ name: ACCOUNT_NAME, projectId: PROJECT_ID, email: ACCOUNT_EMAIL, uniqueId: sensitive }))
        .getServiceAccount(PROJECT_ID, ACCOUNT_ID), /uniqueId.*numeric/],
      [() => client(async () => Response.json({ name: KEY_NAME, keyAlgorithm: sensitive })).getServiceAccountKey(KEY_NAME),
        /keyAlgorithm.*KEY_ALG_RSA_2048/],
    ];
    for (const [read, rule] of cases) {
      const message = String(await read().catch(error => error));
      expect(message).toMatch(rule);
      for (const value of [sensitive, PROJECT_ID, PROJECT_NAME, KEY_NAME]) expect(message).not.toContain(value);
    }
  });

  it('rejects uncertain service-account policy state before mutation', async () => {
    const uniqueId = '109876543210987654321';
    const missingEtag = client(vi.fn(async () => Response.json({
      version: 1,
      bindings: [],
    })) as typeof fetch);
    await expect(missingEtag.getServiceAccountIamPolicy(PROJECT_ID, uniqueId))
      .rejects.toThrow('invalid response');

    const fetchMock = vi.fn(async () => Response.json({ etag: 'etag', bindings: [] }));
    await expect(client(fetchMock as typeof fetch).getServiceAccountIamPolicy(
      PROJECT_ID,
      'not-numeric'
    )).rejects.toThrow('exact numeric identity');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a key without exposing extra response fields and verifies its exact identity', async () => {
    const privateKeyData = Buffer.from('{"private_key":"private-material"}').toString('base64');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/keys') && init?.method === 'POST') {
        expect(init.body).toBe(JSON.stringify({
          privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE',
          keyAlgorithm: 'KEY_ALG_RSA_2048',
        }));
        return Response.json(key({ privateKeyData, validAfterTime: 'sensitive-extra' }));
      }
      expect(url).toBe(`https://iam.googleapis.com/v1/${KEY_NAME}`);
      return Response.json({ name: KEY_NAME, keyAlgorithm: 'KEY_ALG_RSA_2048' });
    });

    const created = await client(fetchMock as typeof fetch).createServiceAccountKey(
      PROJECT_ID,
      ACCOUNT_ID
    );
    expect(created).toEqual({ name: KEY_NAME, privateKeyData });
    expect(Object.keys(created)).toEqual(['name', 'privateKeyData']);
  });

  it('best-effort deletes the exact created key when verification errors', async () => {
    const privateKeyData = Buffer.from('{"private_key":"private-material"}').toString('base64');
    const methods: string[] = [];
    let cleanupStarted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') return Response.json(key({ privateKeyData }));
      expect(String(input)).toBe(`https://iam.googleapis.com/v1/${KEY_NAME}`);
      if (method === 'DELETE') {
        cleanupStarted = true;
        return new Response(null, { status: 204 });
      }
      return cleanupStarted
        ? new Response(null, { status: 404 })
        : new Response('{"privateKeyData":"provider-secret"}', { status: 403 });
    });

    const error = await client(fetchMock as typeof fetch).createServiceAccountKey(
      PROJECT_ID,
      ACCOUNT_ID
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 403 });
    expect(String(error)).not.toContain(privateKeyData);
    expect(String(error)).not.toContain('provider-secret');
    expect(methods).toEqual(['POST', 'GET', 'DELETE', 'GET']);
  });

  it('best-effort deletes the exact created key when its one-time credential payload is invalid', async () => {
    const methods: string[] = [];
    let cleanupStarted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') {
        return Response.json(key({ privateKeyData: 'not-base64' }));
      }
      expect(String(input)).toBe(`https://iam.googleapis.com/v1/${KEY_NAME}`);
      if (method === 'DELETE') {
        cleanupStarted = true;
        return new Response(null, { status: 204 });
      }
      return cleanupStarted
        ? new Response(null, { status: 404 })
        : Response.json({ name: KEY_NAME, keyAlgorithm: 'KEY_ALG_RSA_2048' });
    });

    await expect(client(fetchMock as typeof fetch).createServiceAccountKey(
      PROJECT_ID,
      ACCOUNT_ID
    )).rejects.toThrow(/privateKeyData.*base64/);
    expect(methods).toEqual(['POST', 'DELETE', 'GET']);
  });

  it('reports the exact safe key resource when invalid response cleanup cannot be verified', async () => {
    const providerSecret = 'provider-private-key-material';
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      expect(method === 'POST' || String(input) === `https://iam.googleapis.com/v1/${KEY_NAME}`)
        .toBe(true);
      if (method === 'POST') {
        return Response.json(key({
          privateKeyData: 'not-base64',
          providerSecret,
        }));
      }
      if (method === 'DELETE') {
        return new Response(JSON.stringify({ privateKeyData: providerSecret }), { status: 403 });
      }
      throw new Error(`Unexpected request: ${method} ${String(input)}`);
    });

    const error = await client(fetchMock as typeof fetch).createServiceAccountKey(
      PROJECT_ID,
      ACCOUNT_ID
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GcpBootstrapKeyCleanupRequiredError);
    expect(error).toMatchObject({ keyResourceName: KEY_NAME });
    expect(String(error)).not.toContain(providerSecret);
    expect(methods).toEqual(['POST', 'DELETE']);
  });

  it('best-effort deletes the exact created key after verification times out', async () => {
    const privateKeyData = Buffer.from('{"private_key":"private-material"}').toString('base64');
    const sleep = vi.fn(async () => undefined);
    const methods: string[] = [];
    let cleanupStarted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') return Response.json(key({ privateKeyData }));
      expect(String(input)).toBe(`https://iam.googleapis.com/v1/${KEY_NAME}`);
      if (method === 'DELETE') {
        cleanupStarted = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });

    await expect(client(fetchMock as typeof fetch, {
      maxAttempts: 2,
      sleep,
    }).createServiceAccountKey(PROJECT_ID, ACCOUNT_ID)).rejects.toThrow(
      'key creation did not converge before the retry limit'
    );
    expect(cleanupStarted).toBe(true);
    expect(methods).toEqual(['POST', 'GET', 'GET', 'DELETE', 'GET']);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('deletes the exact key and confirms absence while preserving 403 as unknown', async () => {
    const sleep = vi.fn(async () => undefined);
    let observations = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`https://iam.googleapis.com/v1/${KEY_NAME}`);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      observations += 1;
      return observations === 1
        ? Response.json({ name: KEY_NAME, keyAlgorithm: 'KEY_ALG_RSA_2048' })
        : new Response(null, { status: 404 });
    });
    await expect(client(fetchMock as typeof fetch, { sleep }).deleteServiceAccountKey(KEY_NAME))
      .resolves.toBe(true);
    expect(sleep).toHaveBeenCalledOnce();

    const forbidden = client(vi.fn(async () => new Response('private body', { status: 403 })) as typeof fetch);
    await expect(forbidden.deleteServiceAccountKey(KEY_NAME)).rejects.toMatchObject({ status: 403 });
  });


});
