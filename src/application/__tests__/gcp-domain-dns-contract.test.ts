import { afterEach, describe, expect, it, vi } from 'vitest';
import { planDomain, executeDomainAction, DOMAIN_VERIFY_OPERATION, DOMAIN_READY_OPERATION, type DomainContext } from '../infrastructure-engine-domain.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const context: DomainContext = { gcpProjectId: 'dns-contract-project', region: 'us-central1', serviceName: 'web-production',
  adapter: { siteVerificationAccessToken: async () => 'synthetic-site', engineAccessToken: async () => 'synthetic-engine',
    engineDeploymentIdentity: () => 'deploy@dns-contract-project.iam.gserviceaccount.com' } as never };
const owned = { items: [{ id: 'dns://example.com', site: { type: 'INET_DOMAIN', identifier: 'example.com' },
  owners: ['deploy@dns-contract-project.iam.gserviceaccount.com'] }] };
const mapping = { metadata: { name: 'app.example.com', namespace: '123456789', uid: 'mapping-uid', generation: 1 },
  spec: { routeName: 'web-production' }, status: { observedGeneration: 1,
    conditions: [{ type: 'Ready', status: 'True' }, { type: 'CertificateProvisioned', status: 'True' }],
    resourceRecords: [{ name: 'app', type: 'CNAME', rrdata: 'provider-observed.example.net.' }] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('Cloud Run domain source contract', () => {
  it('plans base-domain ownership TXT before any mapping traffic requirements', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith('/webResource')) return json({ items: [] });
      if (url.endsWith('/token')) return json({ token: 'google-site-verification=fixture-proof', method: 'DNS_TXT' });
      if (url.includes('/domainmappings/')) return json({}, 404);
      throw Error('Unexpected request');
    }));
    const result = await planDomain(context, 'app.example.com', '/', 'example.com');
    expect(result).toMatchObject({ ownershipPresent: false, mappingPresent: false, verificationDomain: 'example.com',
      dnsRecords: [{ name: 'example.com', type: 'TXT', values: ['google-site-verification=fixture-proof'] }] });
    expect(requests.find(request => request.url.endsWith('/token'))?.body).toEqual({ site: { type: 'INET_DOMAIN', identifier: 'example.com' }, verificationMethod: 'DNS_TXT' });
    expect(result.before).toHaveLength(1);
    expect(result.before[0]?.metadata).toMatchObject({ operation: DOMAIN_VERIFY_OPERATION, verificationDomain: 'example.com' });
  });

  it('treats Site Verification permission failures as unknown ownership', async () => {
    const fetch = vi.fn(async () => json({ error: { message: 'Permission denied' } }, 403));
    vi.stubGlobal('fetch', fetch);
    const result = await planDomain(context, 'app.example.com', '/', 'example.com');
    expect(result.blocked).toContain('403');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses complete provider-observed mapping records rather than a hardcoded Google target', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/webResource') ? json(owned) : json(mapping)));
    const result = await planDomain(context, 'app.example.com', '/', 'example.com');
    expect(result).toMatchObject({ ownershipPresent: true, mappingPresent: true,
      dnsRecords: [{ name: 'app.example.com', type: 'CNAME', values: ['provider-observed.example.net'] }] });
    expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocks a mapping attached to a different native service', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/webResource') ? json(owned) : json({ ...mapping, spec: { routeName: 'other-service' } })));
    expect((await planDomain(context, 'app.example.com', '/', 'example.com')).blocked).toContain('service');
  });

  it('returns a readiness noop only after the mapped hostname returns successful HTTPS', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/webResource')
      ? json(owned) : String(input).startsWith('https://app.example.com') ? new Response('ready', { status: 200 }) : json(mapping)));
    const result = await planDomain(context, 'app.example.com', '/', 'example.com');
    expect(result.after[0]).toMatchObject({ type: 'noop', metadata: { operation: DOMAIN_READY_OPERATION } });
  });

  it('does not silently move base-domain proof into a delegated child zone', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await planDomain(context, 'app.example.com', '/', 'app.example.com')).blocked).toContain('example.com');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('verifies only the already staged base-domain TXT without requesting a new token', async () => {
    const calls: string[] = [];
    let verified = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('/webResource')) return json(verified ? owned : { items: [] });
      if (url.includes('webResource?')) {
        expect(JSON.parse(String(init?.body))).toEqual({ site: { type: 'INET_DOMAIN', identifier: 'example.com' } });
        verified = true; return json(owned.items[0]);
      }
      throw Error('Unexpected write');
    }));
    const result = await executeDomainAction(context, { id: 'domain-verify:app.example.com', type: 'create',
      resource: { kind: 'domain', name: 'app.example.com ownership', provider: 'gcp' }, verified: true, reason: 'Verify staged proof',
      metadata: { operation: DOMAIN_VERIFY_OPERATION, domain: 'app.example.com', verificationDomain: 'example.com' } });
    expect(result.success).toBe(true);
    expect(calls.some(url => url.endsWith('/token'))).toBe(false);
  });

  it.each([301, 401, 404, 500])('does not report readiness for HTTPS status %s', async status => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).startsWith('https://app.example.com') ? new Response('', { status }) : json(mapping)));
    const result = await executeDomainAction(context, { id: 'domain-ready:app.example.com', type: 'update',
      resource: { kind: 'domain', name: 'app.example.com certificate', provider: 'gcp' }, verified: true, reason: 'Check readiness',
      metadata: { operation: DOMAIN_READY_OPERATION, domain: 'app.example.com', healthPath: '/' } });
    expect(result).toMatchObject({ success: false, status: 'pending' });
  });
});
