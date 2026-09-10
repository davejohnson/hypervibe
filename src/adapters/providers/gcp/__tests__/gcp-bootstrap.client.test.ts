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

function serviceAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: ACCOUNT_NAME,
    projectId: PROJECT_ID,
    uniqueId: '109876543210987654321',
    email: ACCOUNT_EMAIL,
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
  it('uses exact CRM v3 project URLs and waits for the exact create operation', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT_ID}`) {
        return Response.json(project());
      }
      if (url === 'https://cloudresourcemanager.googleapis.com/v3/projects'
        && init?.method === 'POST') {
        return Response.json({ name: 'operations/create-project-1' });
      }
      if (url === 'https://cloudresourcemanager.googleapis.com/v3/operations/create-project-1') {
        const priorPolls = fetchMock.mock.calls.filter(([candidate]) =>
          String(candidate).endsWith('/operations/create-project-1')).length;
        return priorPolls === 1
          ? Response.json({ name: 'operations/create-project-1', done: false })
          : Response.json({
            name: 'operations/create-project-1',
            done: true,
            response: project(),
          });
      }
      throw new Error('Unexpected request');
    });
    const api = client(fetchMock as typeof fetch, { sleep });

    await expect(api.getProject(PROJECT_ID)).resolves.toEqual(project());
    const operation = await api.createProject({
      projectId: PROJECT_ID,
      displayName: 'Hypervibe',
      parent: 'organizations/987654321',
    });
    await expect(api.waitForProjectOperation(operation.name, {
      projectId: PROJECT_ID,
      parent: 'organizations/987654321',
    })).resolves.toEqual(project());

    expect(fetchMock).toHaveBeenCalledWith(
      `https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT_ID}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer access-token-that-must-stay-private' }),
      })
    );
    expect(fetchMock.mock.calls.filter(([candidate]) => (
      String(candidate) === `https://cloudresourcemanager.googleapis.com/v3/projects/${PROJECT_ID}`
    ))).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloudresourcemanager.googleapis.com/v3/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectId: PROJECT_ID,
          displayName: 'Hypervibe',
          parent: 'organizations/987654321',
        }),
      })
    );
    expect(sleep).toHaveBeenCalledWith(7);
  });

  it('rejects a different project or operation identity', async () => {
    const wrongProjectFetch = vi.fn(async () => Response.json(project({ projectId: 'other-project' })));
    await expect(client(wrongProjectFetch as typeof fetch).getProject(PROJECT_ID))
      .rejects.toThrow('different or invalid resource identity');

    const wrongOperationFetch = vi.fn(async () => Response.json({
      name: 'operations/different',
      done: true,
      response: project(),
    }));
    await expect(client(wrongOperationFetch as typeof fetch).waitForProjectOperation(
      'operations/expected',
      { projectId: PROJECT_ID }
    )).rejects.toThrow('different operation identity');
  });

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

  it('updates project billing and returns only after exact read-after-write convergence', async () => {
    const billingAccountName = 'billingAccounts/AAAAAA-BBBBBB-CCCCCC';
    const sleep = vi.fn(async () => undefined);
    let observations = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        `https://cloudbilling.googleapis.com/v1/projects/${PROJECT_ID}/billingInfo`
      );
      if (init?.method === 'PUT') {
        expect(init.body).toBe(JSON.stringify({ billingAccountName }));
        return Response.json({
          name: `projects/${PROJECT_ID}/billingInfo`,
          projectId: PROJECT_ID,
          billingAccountName,
          billingEnabled: true,
        });
      }
      observations += 1;
      return Response.json({
        name: `projects/${PROJECT_ID}/billingInfo`,
        projectId: PROJECT_ID,
        billingAccountName: observations === 1 ? '' : billingAccountName,
        billingEnabled: observations !== 1,
      });
    });

    await expect(client(fetchMock as typeof fetch, { sleep }).updateProjectBillingInfo(
      PROJECT_ID,
      billingAccountName
    )).resolves.toMatchObject({ billingAccountName, billingEnabled: true });
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('enables an exact service, waits for its LRO, and verifies ENABLED state', async () => {
    const serviceName = 'iam.googleapis.com';
    const exactServiceName = `${PROJECT_NAME}/services/${serviceName}`;
    const sleep = vi.fn(async () => undefined);
    let operationPolls = 0;
    let servicePolls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/v3/projects/${PROJECT_ID}`)) return Response.json(project());
      if (url.endsWith(`/v1/projects/${PROJECT_ID}/services/${serviceName}`)) {
        servicePolls += 1;
        return Response.json({
          name: exactServiceName,
          parent: PROJECT_NAME,
          config: { name: serviceName },
          state: servicePolls < 3 ? 'DISABLED' : 'ENABLED',
        });
      }
      if (url.endsWith(`/v1/projects/${PROJECT_ID}/services/${serviceName}:enable`)) {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe('{}');
        return Response.json({ name: 'operations/service-enable-1' });
      }
      if (url.endsWith('/v1/operations/service-enable-1')) {
        operationPolls += 1;
        return Response.json({
          name: 'operations/service-enable-1',
          done: operationPolls > 1,
          ...(operationPolls > 1 ? { response: {} } : {}),
        });
      }
      throw new Error('Unexpected request');
    });

    await expect(client(fetchMock as typeof fetch, { sleep }).enableService(
      PROJECT_ID,
      serviceName
    )).resolves.toBe('enabled');
    expect(operationPolls).toBe(2);
    expect(servicePolls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('reports an already-enabled exact service without issuing a mutation', async () => {
    const serviceName = 'iam.googleapis.com';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/v3/projects/${PROJECT_ID}`)) return Response.json(project());
      if (url.endsWith(`/v1/projects/${PROJECT_ID}/services/${serviceName}`)) {
        return Response.json({
          name: `${PROJECT_NAME}/services/${serviceName}`,
          parent: PROJECT_NAME,
          config: { name: serviceName },
          state: 'ENABLED',
        });
      }
      throw new Error('Unexpected request');
    });

    await expect(client(fetchMock as typeof fetch).enableService(
      PROJECT_ID,
      serviceName
    )).resolves.toBe('already_enabled');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(':enable'))).toBe(false);
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

  it('gets and sets an exact numeric service-account policy with its etag', async () => {
    const uniqueId = '109876543210987654321';
    const resourceUrl = `https://iam.googleapis.com/v1/projects/${PROJECT_ID}`
      + `/serviceAccounts/${uniqueId}`;
    const original = {
      version: 3,
      etag: 'BwW-policy-etag=',
      bindings: [{
        role: 'roles/viewer',
        members: ['user:owner@example.com'],
        condition: { title: 'reviewed', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' },
      }],
    };
    const updated = {
      ...original,
      bindings: [
        ...original.bindings,
        {
          role: 'roles/iam.serviceAccountUser',
          members: [`serviceAccount:${ACCOUNT_EMAIL}`],
        },
      ],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === `${resourceUrl}:getIamPolicy`) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          options: { requestedPolicyVersion: 3 },
        });
        return Response.json(original);
      }
      if (url === `${resourceUrl}:setIamPolicy`) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          policy: updated,
          updateMask: 'bindings,etag',
        });
        return Response.json({ ...updated, etag: 'BwW-next-etag=' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const api = client(fetchMock as typeof fetch);

    await expect(api.getServiceAccountIamPolicy(PROJECT_ID, uniqueId))
      .resolves.toEqual(original);
    await expect(api.setServiceAccountIamPolicy(PROJECT_ID, uniqueId, updated))
      .resolves.toEqual({ ...updated, etag: 'BwW-next-etag=' });
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

  it('creates an exact IAM service account and verifies it after acknowledgement', async () => {
    const sleep = vi.fn(async () => undefined);
    let observations = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/projects/${PROJECT_ID}/serviceAccounts`) && init?.method === 'POST') {
        expect(init.body).toBe(JSON.stringify({
          accountId: ACCOUNT_ID,
          serviceAccount: { displayName: 'Hypervibe deployer' },
        }));
        return Response.json(serviceAccount());
      }
      expect(url).toBe(
        `https://iam.googleapis.com/v1/projects/${PROJECT_ID}`
          + `/serviceAccounts/${encodeURIComponent(ACCOUNT_EMAIL)}`
      );
      observations += 1;
      return observations === 1
        ? new Response(null, { status: 404 })
        : Response.json(serviceAccount());
    });

    await expect(client(fetchMock as typeof fetch, { sleep }).createServiceAccount({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      displayName: 'Hypervibe deployer',
    })).resolves.toEqual(serviceAccount());
    expect(sleep).toHaveBeenCalledOnce();
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
    )).rejects.toThrow('different or invalid resource identity');
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

  it('fails closed when mutation acknowledgement identities do not match', async () => {
    const wrongBilling = vi.fn(async () => Response.json({
      name: 'projects/another-project/billingInfo',
      projectId: 'another-project',
      billingAccountName: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC',
      billingEnabled: true,
    }));
    await expect(client(wrongBilling as typeof fetch).updateProjectBillingInfo(
      PROJECT_ID,
      'billingAccounts/AAAAAA-BBBBBB-CCCCCC'
    )).rejects.toThrow('different or invalid resource identity');

    const privateKeyData = Buffer.from('private-material').toString('base64');
    const wrongKey = vi.fn(async () => Response.json(key({
      name: `projects/${PROJECT_ID}/serviceAccounts/other-account@${PROJECT_ID}.iam.gserviceaccount.com/keys/abcdef123456`,
      privateKeyData,
    })));
    await expect(client(wrongKey as typeof fetch).createServiceAccountKey(PROJECT_ID, ACCOUNT_ID))
      .rejects.toThrow('different or invalid resource identity');
  });
});
