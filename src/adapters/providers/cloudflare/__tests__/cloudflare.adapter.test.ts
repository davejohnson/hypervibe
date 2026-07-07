import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareAdapter } from '../cloudflare.adapter.js';

function cfResponse<T>(result: T, init?: { success?: boolean; errors?: Array<{ code: number; message: string }>; status?: number }) {
  return Response.json({
    success: init?.success ?? true,
    errors: init?.errors ?? [],
    messages: [],
    result,
  }, { status: init?.status ?? 200 });
}

function cfDnsRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'record-1',
    zone_id: 'zone-1',
    zone_name: 'hlspropertycare.com',
    name: 'staging.hlspropertycare.com',
    type: 'CNAME',
    content: 'old-target.up.railway.app',
    proxied: false,
    proxiable: true,
    ttl: 1,
    created_on: '2026-07-07T00:00:00.000Z',
    modified_on: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('CloudflareAdapter.verify', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifies a valid token even when the scoped zone is not found yet', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse({ id: 'token-1' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([]);
      }
      if (href.includes('/zones?page=')) {
        return cfResponse([]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'valid-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('could not find a Cloudflare zone');
  });

  it('normalizes copied Authorization header values before calling Cloudflare', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => cfResponse({ id: 'token-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: ' "Bearer cf-real-token" ' });

    const result = await adapter.verify();

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer cf-real-token');
  });

  it('verifies account API tokens through the account endpoint', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/accounts/account-1/tokens/verify')) {
        return cfResponse({ id: 'token-1', status: 'active' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([{ id: 'zone-1', name: 'apreskeys.com', status: 'active', paused: false, type: 'full', name_servers: [] }]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_123456789012345678901234567890123456789012345678', accountId: 'account-1' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.zones).toEqual(['apreskeys.com']);
    expect(result.warning).toContain('Account API Token verified');
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/user/tokens/verify'), expect.anything());
  });

  it('verifies a separate user Registrar token when present', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (href.endsWith('/accounts/account-1/tokens/verify')) {
        expect(auth).toBe('Bearer cfat_dns');
        return cfResponse({ id: 'dns-token', status: 'active' });
      }
      if (href.endsWith('/user/tokens/verify')) {
        expect(auth).toBe('Bearer cfut_registrar');
        return cfResponse({ id: 'registrar-token' });
      }
      if (href.includes('/zones?name=')) {
        expect(auth).toBe('Bearer cfat_dns');
        return cfResponse([{ id: 'zone-1', name: 'apreskeys.com', status: 'active', paused: false, type: 'full', name_servers: [] }]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_dns', accountId: 'account-1', registrarApiToken: 'cfut_registrar' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('Account API Token verified for DNS');
  });

  it('rejects account API tokens supplied as registrarApiToken', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/accounts/account-1/tokens/verify')) {
        return cfResponse({ id: 'dns-token', status: 'active' });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_dns', accountId: 'account-1', registrarApiToken: 'cfat_registrar' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires a Cloudflare User API Token');
    expect(result.error).toContain('registrarApiToken');
    expect(result.error).toContain('https://dash.cloudflare.com/profile/api-tokens');
  });

  it('falls back to account token verification for unprefixed tokens when accountId is present', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse(null, {
          success: false,
          status: 401,
          errors: [{ code: 1000, message: 'Invalid API Token' }],
        });
      }
      if (href.endsWith('/accounts/account-1/tokens/verify')) {
        return cfResponse({ id: 'token-1', status: 'active' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([]);
      }
      if (href.includes('/zones?page=')) {
        return cfResponse([]);
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'legacyAccountTokenValueWithoutPrefix', accountId: 'account-1' });

    const result = await adapter.verify('invoiceperfect.com');

    expect(result.success).toBe(true);
    expect(result.tokenKind).toBe('account');
    expect(result.warning).toContain('Account API Token verified');
  });

  it('explains that account API tokens need accountId', async () => {
    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_123456789012345678901234567890123456789012345678' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Manage Account > Account API Tokens');
    expect(result.error).toContain('https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(result.error).toContain('My Profile > API Tokens');
    expect(result.error).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(result.error).toContain('cfat_');
    expect(result.error).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(result.error).toContain('Zone > Zone > Read');
    expect(result.error).toContain('Zone > Zone Settings > Read or Edit');
    expect(result.error).toContain('Zone > DNS > Edit/Write');
  });

  it('verifies a valid token even when zone access cannot be confirmed', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse({ id: 'token-1' });
      }
      if (href.includes('/zones?name=')) {
        return cfResponse([], {
          success: false,
          status: 403,
          errors: [{ code: 9109, message: 'Missing permission to list zones' }],
        });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'valid-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(true);
    expect(result.warning).toContain('could not confirm Cloudflare zone access');
  });

  it('still rejects invalid API tokens', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/user/tokens/verify')) {
        return cfResponse(null, {
          success: false,
          status: 401,
          errors: [{ code: 10000, message: 'Authentication error' }],
        });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'bad-token' });

    const result = await adapter.verify('apreskeys.com');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Manage Account > Account API Tokens');
    expect(result.error).toContain('https://dash.cloudflare.com/?to=/:account/api-tokens');
    expect(result.error).toContain('My Profile > API Tokens');
    expect(result.error).toContain('https://dash.cloudflare.com/profile/api-tokens');
    expect(result.error).toContain('cfat_');
    expect(result.error).toContain('cfut_');
    expect(result.error).toContain('Zone > Zone > Read');
    expect(result.error).toContain('Zone > Zone Settings > Read or Edit');
    expect(result.error).toContain('Zone > DNS > Edit/Write');
  });
});

describe('CloudflareAdapter.upsertDnsRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates a stale existing record instead of creating a duplicate', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/dns_records?page=')) {
        return cfResponse([cfDnsRecord()]);
      }
      if (href.includes('/dns_records/record-1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          content: 'binlu2a8.up.railway.app',
          proxied: false,
        });
        return cfResponse(cfDnsRecord({
          content: 'binlu2a8.up.railway.app',
          modified_on: '2026-07-07T00:01:00.000Z',
        }));
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    const result = await adapter.upsertDnsRecord(
      'zone-1',
      'staging.hlspropertycare.com',
      'CNAME',
      'binlu2a8.up.railway.app',
      { proxied: false }
    );

    expect(result.action).toBe('updated');
    expect(result.record.content).toBe('binlu2a8.up.railway.app');
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET', 'PATCH']);
  });

  it('treats an equivalent existing CNAME as converged without writing', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/dns_records?page=')) {
        return cfResponse([cfDnsRecord({
          name: 'Staging.HLSPropertyCare.com.',
          content: 'BINLU2A8.UP.RAILWAY.APP.',
        })]);
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    const result = await adapter.upsertDnsRecord(
      'zone-1',
      'staging.hlspropertycare.com.',
      'CNAME',
      'binlu2a8.up.railway.app',
      { proxied: false }
    );

    expect(result.action).toBe('updated');
    expect(result.record.id).toBe('record-1');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('recovers when a create races an existing DNS record', async () => {
    let listCount = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/dns_records?page=')) {
        listCount += 1;
        return cfResponse(listCount === 1 ? [] : [cfDnsRecord()]);
      }
      if (href.endsWith('/dns_records') && init?.method === 'POST') {
        return cfResponse(null, {
          success: false,
          status: 409,
          errors: [{ code: 81058, message: 'An identical record already exists.' }],
        });
      }
      if (href.includes('/dns_records/record-1') && init?.method === 'PATCH') {
        return cfResponse(cfDnsRecord({
          content: 'binlu2a8.up.railway.app',
          modified_on: '2026-07-07T00:01:00.000Z',
        }));
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_dns' });

    const result = await adapter.upsertDnsRecord(
      'zone-1',
      'staging',
      'CNAME',
      'binlu2a8.up.railway.app',
      { proxied: false }
    );

    expect(result.action).toBe('updated');
    expect(result.record.content).toBe('binlu2a8.up.railway.app');
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET', 'POST', 'GET', 'PATCH']);
  });
});

describe('CloudflareAdapter Registrar token routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses registrarApiToken for Registrar calls and apiToken for DNS calls', async () => {
    const authorizations: Array<{ url: string; authorization?: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      authorizations.push({
        url: href,
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      if (href.includes('/registrar/domain-check')) {
        return cfResponse({ domains: [{ name: 'apreskeys.com', registrable: true }] });
      }
      if (href.includes('/registrar/registrations') && init?.method === 'POST') {
        return cfResponse({
          completed: false,
          created_at: '2026-06-15T00:00:00.000Z',
          updated_at: '2026-06-15T00:00:01.000Z',
          links: { self: '/status' },
          state: 'in_progress',
        });
      }
      if (href.includes('/dns_records')) {
        return cfResponse({
          id: 'record-1',
          zone_id: 'zone-1',
          zone_name: 'apreskeys.com',
          name: 'apreskeys.com',
          type: 'CNAME',
          content: 'target.example.com',
          proxied: false,
          proxiable: true,
          ttl: 1,
          created_on: '2026-06-15T00:00:00.000Z',
          modified_on: '2026-06-15T00:00:00.000Z',
        });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_dns', accountId: 'account-1', registrarApiToken: 'cfut_registrar' });

    await adapter.checkRegistrarDomains('account-1', ['apreskeys.com']);
    await adapter.createRegistrarRegistration('account-1', { domainName: 'apreskeys.com', years: 1 });
    await adapter.createDnsRecord('zone-1', { type: 'CNAME', name: 'apreskeys.com', content: 'target.example.com' });

    expect(authorizations).toEqual([
      expect.objectContaining({ authorization: 'Bearer cfut_registrar' }),
      expect.objectContaining({ authorization: 'Bearer cfut_registrar' }),
      expect.objectContaining({ authorization: 'Bearer cfat_dns' }),
    ]);
  });

  it('uses a single user apiToken for Registrar calls when no registrarApiToken is configured', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer cfut_combined');
      if (href.includes('/registrar/domain-check')) {
        return cfResponse({ domains: [{ name: 'apreskeys.com', registrable: true }] });
      }
      throw new Error(`unexpected url: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfut_combined', accountId: 'account-1' });

    await adapter.checkRegistrarDomains('account-1', ['apreskeys.com']);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails Registrar calls before calling Cloudflare when only an account apiToken is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareAdapter();
    adapter.connect({ apiToken: 'cfat_dns', accountId: 'account-1' });

    await expect(adapter.checkRegistrarDomains('account-1', ['apreskeys.com']))
      .rejects.toThrow(/registrarApiToken\/CLOUDFLARE_REGISTRAR_API_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
