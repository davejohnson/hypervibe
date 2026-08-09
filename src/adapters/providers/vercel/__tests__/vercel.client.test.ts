import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VercelApiError,
  VercelClient,
} from '../vercel.client.js';

const TEAM_ID = 'team_1234567890';
const PROJECT_ID = 'prj_1234567890';

function jsonResponse(
  body: unknown,
  status = 200
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204
      ? {}
      : { 'Content-Type': 'application/json' },
  });
}

function project(
  id = PROJECT_ID,
  name = 'hv-project'
) {
  return {
    id,
    accountId: TEAM_ID,
    name,
  };
}

describe('VercelClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scopes project calls to the configured team and sends a bearer token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(project()));
    vi.stubGlobal('fetch', fetchMock);
    const client = new VercelClient({
      accessToken: 'vercel-secret-token',
      teamId: TEAM_ID,
    });

    await expect(client.getProject(PROJECT_ID)).resolves.toEqual(project());

    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(input.pathname).toBe(`/v9/projects/${PROJECT_ID}`);
    expect(input.searchParams.get('teamId')).toBe(TEAM_ID);
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer vercel-secret-token'
    );
  });

  it('follows every project continuation without turning truncation into absence', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get('from');
      if (!cursor) {
        return jsonResponse({
          projects: [project(PROJECT_ID, 'first')],
          pagination: { next: 'cursor-2' },
        });
      }
      if (cursor === 'cursor-2') {
        return jsonResponse({
          projects: [project('prj_abcdefghij', 'second')],
          pagination: { next: null },
        });
      }
      throw new Error(`unexpected cursor: ${cursor}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new VercelClient({
      accessToken: 'token',
      teamId: TEAM_ID,
    });

    await expect(client.listProjects()).resolves.toEqual([
      project(PROJECT_ID, 'first'),
      project('prj_abcdefghij', 'second'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('blocks repeated project identities across pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        projects: [project()],
        pagination: { next: 'cursor-2' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        projects: [project()],
        pagination: { next: null },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new VercelClient({
        accessToken: 'token',
        teamId: TEAM_ID,
      }).listProjects()
    ).rejects.toThrow(/duplicate project identity/);
  });

  it('treats only provider-confirmed 404 as absence', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 403));
    vi.stubGlobal('fetch', fetchMock);
    const client = new VercelClient({ accessToken: 'token' });

    await expect(client.getProject(PROJECT_ID)).resolves.toBeNull();
    await expect(client.getProject(PROJECT_ID)).rejects.toEqual(
      expect.objectContaining<Partial<VercelApiError>>({
        name: 'VercelApiError',
        status: 403,
      })
    );
  });

  it('never includes provider response messages or credentials in API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({
        error: {
          code: 'forbidden',
          message: 'secret-bearing-provider-message',
        },
      }, 403))
    );
    const client = new VercelClient({
      accessToken: 'vercel-secret-token',
    });

    const rejection = expect(client.getUser()).rejects;
    await rejection.toThrow('Vercel REST API error: 403 (forbidden)');
    await rejection.not.toThrow(/secret-bearing-provider-message/);
    await rejection.not.toThrow(/vercel-secret-token/);
  });

  it('blocks an environment-variable response with an unusable continuation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({
        envs: [],
        pagination: { next: 123 },
      }))
    );
    const client = new VercelClient({ accessToken: 'token' });

    await expect(
      client.listProjectEnvironmentVariables(PROJECT_ID)
    ).rejects.toThrow(/without a supported continuation parameter/);
  });

  it('follows project-domain pagination and verifies project ownership', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request
    ) => {
      const url = new URL(String(input));
      const until = url.searchParams.get('until');
      if (!until) {
        return jsonResponse({
          domains: [{
            name: 'example.com',
            projectId: PROJECT_ID,
            verified: true,
          }],
          pagination: { next: 100 },
        });
      }
      return jsonResponse({
        domains: [{
          name: 'www.example.com',
          projectId: PROJECT_ID,
          verified: false,
        }],
        pagination: { next: null },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new VercelClient({ accessToken: 'token' });

    await expect(client.listProjectDomains(PROJECT_ID)).resolves.toEqual([
      {
        name: 'example.com',
        projectId: PROJECT_ID,
        verified: true,
      },
      {
        name: 'www.example.com',
        projectId: PROJECT_ID,
        verified: false,
      },
    ]);
  });

  it('creates, observes, configures, and removes one exact project domain', async () => {
    const domain = {
      name: 'app.example.com',
      apexName: 'example.com',
      projectId: PROJECT_ID,
      verified: false,
      verification: [{ type: 'TXT', domain: '_vercel.app.example.com', value: 'verify-1' }],
    };
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') return jsonResponse(domain);
      if (url.pathname.endsWith('/config')) return jsonResponse({ misconfigured: true });
      if (init?.method === 'DELETE') return jsonResponse(undefined, 204);
      return jsonResponse(domain);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new VercelClient({ accessToken: 'token', teamId: TEAM_ID });

    await expect(client.addProjectDomain(PROJECT_ID, domain.name)).resolves.toEqual(domain);
    await expect(client.getProjectDomain(PROJECT_ID, domain.name)).resolves.toEqual(domain);
    await expect(client.getDomainConfig(domain.name)).resolves.toEqual({ misconfigured: true });
    await expect(client.removeProjectDomain(PROJECT_ID, domain.name)).resolves.toBeUndefined();

    const [postUrl, postInit] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(postUrl.pathname).toBe(`/v10/projects/${PROJECT_ID}/domains`);
    expect(postUrl.searchParams.get('teamId')).toBe(TEAM_ID);
    expect(JSON.parse(String(postInit.body))).toEqual({ name: domain.name });
    const [deleteUrl] = fetchMock.mock.calls[3] as unknown as [URL, RequestInit];
    expect(deleteUrl.pathname).toBe(`/v9/projects/${PROJECT_ID}/domains/${domain.name}`);
  });
});
