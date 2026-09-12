import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeonAdapter } from '../neon/neon.adapter.js';
import { SupabaseAdapter } from '../supabase/supabase.adapter.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';

// Only the transport is intercepted. Adapters serialize requests and decode HTTP
// responses normally. These are synthetic contracts, not live-provider evidence.
function pinnedApi(provider: 'neon' | 'supabase') {
  const base = `test/provider-contracts/${provider}/`;
  const source = JSON.parse(readFileSync(`${base}source.json`, 'utf8'));
  const raw = readFileSync(`${base}${source.schemaFile}`, 'utf8');
  expect(createHash('sha256').update(raw).digest('hex')).toBe(source.schemaSha256);
  const document = JSON.parse(raw);
  // OpenAPI annotations are not JSON Schema assertions; format coverage is not
  // claimed. Type, enum, requiredness, bounds, patterns and references are checked.
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(document, provider);
  return {
    document,
    validate(pointer: string, value: unknown) {
      const check = ajv.compile({ $ref: `${provider}#${pointer}` });
      return check(value) ? [] : check.errors;
    },
  };
}

const environment: Environment = {
  id: 'local-staging', projectId: 'local-project', name: 'staging',
  platformBindings: {}, createdAt: new Date(), updatedAt: new Date(),
};

afterEach(() => vi.unstubAllGlobals());

describe('pinned REST API contracts', () => {
  it('sends Neon organization scope in the documented create body, not an invented query parameter', async () => {
    const api = pinnedApi('neon');
    const requests: Array<{ url: URL; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://console.neon.tech');
      expect(url.pathname).toBe('/api/v2/projects');
      if (init?.method === 'POST') {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        // Stop before allocating a database or simulating successful readiness.
        return Response.json({ message: 'Synthetic create rejection' }, { status: 400 });
      }
      expect(url.searchParams.get('org_id')).toBe('org-contract');
      return Response.json({ projects: [], pagination: {} });
    }));
    const adapter = new NeonAdapter();
    await adapter.connect({ apiKey: 'synthetic-key', organizationId: 'org-contract', regionId: 'aws-us-east-1' });
    expect((await adapter.provision('postgres', environment)).receipt.success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(api.validate('/components/schemas/ProjectCreateRequest', requests[0].body)).toEqual([]);
    const documentedQuery = (api.document.paths['/projects'].post.parameters ?? [])
      .filter((parameter: { in: string }) => parameter.in === 'query')
      .map((parameter: { name: string }) => parameter.name);
    expect([...requests[0].url.searchParams.keys()].filter((key) => !documentedQuery.includes(key))).toEqual([]);
    expect(requests[0].body).toMatchObject({ project: { org_id: 'org-contract' } });
  });

  it('sends the provider-returned Supabase slug, which need not equal its legacy organization id', async () => {
    const api = pinnedApi('supabase');
    const organizations = [{ id: 'legacy-org-id', slug: 'actual-org-slug', name: 'Contract organization' }];
    expect(api.validate('/paths/~1v1~1organizations/get/responses/200/content/application~1json/schema', organizations)).toEqual([]);
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.supabase.com');
      if (url.pathname === '/v1/organizations') return Response.json(organizations);
      expect(url.pathname).toBe('/v1/projects');
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return Response.json({ message: 'Synthetic create rejection' }, { status: 400 });
      }
      return Response.json([]);
    }));
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'synthetic-key', organizationId: 'legacy-org-id' });
    expect((await adapter.provision('postgres', environment)).receipt.success).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(api.validate('/components/schemas/V1CreateProjectBody', bodies[0])).toEqual([]);
    expect(bodies[0]).toMatchObject({ organization_slug: 'actual-org-slug' });
    expect(bodies[0]).not.toHaveProperty('organization_id');
  });

  it('rejects malformed positive response fixtures instead of accepting hand-written types', () => {
    const api = pinnedApi('supabase');
    const project = {
      id: 'abcdefghijklmnopqrst', ref: 'abcdefghijklmnopqrst', organization_id: 'legacy-org-id',
      organization_slug: 'actual-org-slug', name: 'contract-project', region: 'us-east-1',
      created_at: '2026-09-12T00:00:00Z', status: 'COMING_UP',
    };
    expect(api.validate('/components/schemas/V1ProjectResponse_Output', project)).toEqual([]);
    expect(api.validate('/components/schemas/V1ProjectResponse_Output', { ...project, ref: undefined })).not.toEqual([]);
    expect(api.validate('/components/schemas/V1ProjectResponse_Output', { ...project, status: 'MADE_UP' })).not.toEqual([]);
    expect(api.validate('/components/schemas/OrganizationResponseV1_Output', { id: 'legacy-org-id', name: 'Missing slug' })).not.toEqual([]);
    expect(pinnedApi('neon').validate('/components/schemas/ProjectCreateRequest', { project: { org_id: 42 } })).not.toEqual([]);
  });

  it('does not write when the selected Supabase organization has no usable slug', async () => {
    const mutations = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') mutations();
      return Response.json([{ id: 'legacy-org-id', name: 'Incomplete provider response' }]);
    }));
    const adapter = new SupabaseAdapter();
    await adapter.connect({ accessToken: 'synthetic-key', organizationId: 'legacy-org-id' });
    const result = await adapter.provision('postgres', environment);
    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('slug');
    expect(mutations).not.toHaveBeenCalled();
  });
});
