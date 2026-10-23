import { readFileSync } from 'node:fs';
import { buildSchema, execute, parse, validate } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';

const schema = buildSchema(readFileSync('test/provider-contracts/railway/schema.graphql', 'utf8'));
const projectId = 'project-domain-contract';
const serviceId = 'shared-web';
const productionId = 'environment-production';
const environmentId = 'environment-staging';
const domain = 'staging.example.test';
const target = { projectId, serviceId, environmentId, domain };
const oldId = 'domain-staging';

// Synthetic provider state executed against the pinned official Railway SDL.
// Production-first pagination reconstructs the shared-service recovery case;
// it is not a recording of a live custom-domain lifecycle.
async function fixture(options: {
  pageSize?: number;
  keepDeleted?: boolean;
  instanceAbsent?: boolean;
  refresh?: 'disappear' | 'replace' | 'reject';
  creationResponse?: 'missing-id' | 'wrong-domain';
  override?: (data: any, query: string, reads: number) => any;
} = {}) {
  const makeDomain = (id: string, env: string, hostname: string) => ({
    id, projectId, serviceId, environmentId: env, domain: hostname,
    status: { verified: true, certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALID',
      dnsRecords: [], verificationDnsHost: null, verificationToken: null },
  });
  const production = makeDomain('domain-production', productionId, 'example.test');
  const domains = [production, makeDomain(oldId, environmentId, domain)];
  if (options.refresh) domains[1].status.verified = false;
  const requests: Array<{ query: string; variables: Record<string, any> }> = [];
  const mutations: Array<{ field: string; args: any }> = [];
  let reads = 0;
  const instance = (env: string) => ({
    id: `instance-${env}`, serviceId, environmentId: env, deletedAt: null,
    domains: { customDomains: domains.filter(item => item.environmentId === env), serviceDomains: [] },
  });
  const root = {
    service: ({ id }: { id: string }) => {
      expect(id).toBe(serviceId);
      return { id: serviceId, projectId,
        serviceInstances: ({ after, first }: { after?: string; first?: number }) => {
          const nodes = [instance(productionId), instance(environmentId)];
          const start = after ? Number(after) : 0;
          const end = start + Math.min(first ?? 100, options.pageSize ?? 100);
          return { edges: nodes.slice(start, end).map(node => ({ node })),
            pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } };
        } };
    },
    serviceInstance: (args: { serviceId: string; environmentId: string }) => {
      expect(args).toEqual({ serviceId, environmentId });
      if (options.instanceAbsent) return null;
      return instance(environmentId);
    },
    customDomainUpdate: (args: { id: string; environmentId: string }) => {
      mutations.push({ field: 'customDomainUpdate', args });
      if (options.refresh === 'disappear') domains.splice(1, 1);
      if (options.refresh === 'replace') domains[1].id = 'unreviewed-replacement';
      return options.refresh !== 'reject';
    },
    customDomainDelete: (args: { id: string }) => {
      mutations.push({ field: 'customDomainDelete', args });
      if (!options.keepDeleted) {
        const index = domains.findIndex(item => item.id === args.id);
        if (index >= 0) domains.splice(index, 1);
      }
      return true;
    },
    customDomainCreate: ({ input }: { input: typeof target }) => {
      mutations.push({ field: 'customDomainCreate', args: { input } });
      const created = makeDomain('domain-recreated', input.environmentId, input.domain);
      domains.push(created);
      return created;
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(url)).pathname).toBe('/graphql/v2');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-domain-token');
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    const document = parse(request.query);
    expect(validate(schema, document)).toEqual([]);
    const result = await execute({ schema, document, variableValues: request.variables, rootValue: root });
    if (options.instanceAbsent && request.query.includes('GetServiceEnvironmentInstance')) {
      // Non-null singular fields propagate a missing result as a GraphQL
      // error, which cannot authorize implicit provisioning.
      expect(result.errors).toHaveLength(1);
    } else expect(result.errors).toBeUndefined();
    if (options.creationResponse && request.query.includes('mutation CreateCustomDomain')) {
      const created = { ...(result.data?.customDomainCreate as Record<string, unknown>) };
      if (options.creationResponse === 'missing-id') delete created.id;
      else created.domain = 'unrelated.example.test';
      return Response.json({ data: { customDomainCreate: created } });
    }
    if (request.query.includes('GetServiceCustomDomains')) {
      reads++;
      // Deliberately invalid HTTP-200 envelopes test fail-closed handling;
      // positive responses above are produced by the official schema.
      return Response.json({ data: options.override?.(result.data, request.query, reads) ?? result.data });
    }
    return Response.json(result);
  }));
  const adapter = new RailwayAdapter();
  await adapter.connect({ apiToken: 'synthetic-domain-token' });
  return { adapter, requests, mutations, domains, production };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Railway custom-domain HTTP observation and cleanup', () => {
  it('finds the staging domain after the first production instance page', async () => {
    const f = await fixture({ pageSize: 1 });
    expect(await f.adapter.getCustomDomainStatus(target)).toMatchObject({ id: oldId, domain });
    expect(f.requests.filter(request => request.query.includes('GetServiceCustomDomains'))).toHaveLength(2);
    expect(f.mutations).toEqual([]);
  });

  it('deletes only the exact staging attachment after complete instance observation', async () => {
    const f = await fixture({ pageSize: 1 });
    expect(await f.adapter.detachCustomDomain({ ...target, customDomainId: oldId })).toMatchObject({
      success: true, data: { deleted: true, customDomainId: oldId },
    });
    expect(f.mutations).toEqual([{ field: 'customDomainDelete', args: { id: oldId } }]);
    expect(f.domains).toEqual([f.production]);
  });

  it('recreates only staging after terminal absence and verifies the new attachment', async () => {
    const f = await fixture({ pageSize: 1 });
    expect(await f.adapter.recreateCustomDomain(target)).toMatchObject({
      success: true, data: { recreated: true, previousCustomDomainId: oldId, customDomainId: 'domain-recreated' },
    });
    expect(f.mutations).toEqual([
      { field: 'customDomainDelete', args: { id: oldId } },
      { field: 'customDomainCreate', args: { input: target } },
    ]);
    expect(f.domains).toContainEqual(f.production);
    expect(f.domains.filter(item => item.environmentId === environmentId)).toEqual([
      expect.objectContaining({ id: 'domain-recreated', domain, serviceId, projectId }),
    ]);
  });

  it.each([
    ['missing service', () => ({})],
    ['null service', () => ({ service: null })],
    ['wrong service', (data: any) => ({ service: { ...data.service, id: 'another-service' } })],
    ['wrong project', (data: any) => ({ service: { ...data.service, projectId: 'another-project' } })],
    ['missing connection', (data: any) => ({ service: { id: data.service.id } })],
    ['missing edges', (data: any) => ({ service: { ...data.service, serviceInstances: {} } })],
    ['null edges', (data: any) => ({ service: { ...data.service, serviceInstances: { edges: null } } })],
    ['missing pageInfo', (data: any) => {
      delete data.service.serviceInstances.pageInfo; return data;
    }],
    ['invalid pageInfo', (data: any) => {
      data.service.serviceInstances.pageInfo = { hasNextPage: 'false', endCursor: null }; return data;
    }],
    ['missing domains', (data: any) => {
      delete data.service.serviceInstances.edges[1].node.domains; return data;
    }],
    ['missing customDomains', (data: any) => {
      data.service.serviceInstances.edges[1].node.domains = {}; return data;
    }],
    ['null customDomains', (data: any) => {
      data.service.serviceInstances.edges[1].node.domains.customDomains = null; return data;
    }],
    ['missing domain identity', (data: any) => {
      delete data.service.serviceInstances.edges[1].node.domains.customDomains[0].id; return data;
    }],
    ['missing domain status', (data: any) => {
      delete data.service.serviceInstances.edges[1].node.domains.customDomains[0].status; return data;
    }],
    ['duplicate environment', (data: any) => {
      data.service.serviceInstances.edges.push(data.service.serviceInstances.edges[1]); return data;
    }],
  ] as const)('keeps %s unknown instead of authorizing an absence result', async (_label, override) => {
    const f = await fixture({ override });
    await expect(f.adapter.getCustomDomainStatus(target)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('rejects a missing continuation cursor before treating staging as absent', async () => {
    const f = await fixture({ pageSize: 1, override: data => {
      data.service.serviceInstances.pageInfo = { hasNextPage: true, endCursor: null }; return data;
    } });
    await expect(f.adapter.getCustomDomainStatus(target)).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  it('does not reuse a repeated cursor or ignore malformed later pages', async () => {
    const f = await fixture({ pageSize: 1, override: data => {
      data.service.serviceInstances.pageInfo = { hasNextPage: true, endCursor: '1' }; return data;
    } });
    await expect(f.adapter.getCustomDomainStatus(target)).rejects.toThrow();
    expect(f.requests).toHaveLength(2);
    expect(f.mutations).toEqual([]);
  });

  it('does not claim a new attachment without exact provider readback', async () => {
    const f = await fixture({ override: (data, _query, reads) => {
      if (reads > 1) data.service.serviceInstances.edges[1].node.domains.customDomains = [];
      return data;
    } });
    f.domains.splice(1, 1);
    expect(await f.adapter.attachCustomDomain(target)).toMatchObject({ success: false });
    expect(f.mutations).toEqual([{ field: 'customDomainCreate', args: { input: target } }]);
  });

  it('does not claim recreation without exact replacement readback', async () => {
    const f = await fixture({ override: (data, _query, reads) => {
      if (reads > 2) data.service.serviceInstances.edges[1].node.domains.customDomains = [];
      return data;
    } });
    expect(await f.adapter.recreateCustomDomain(target)).toMatchObject({ success: false });
    expect(f.mutations.map(item => item.field)).toEqual(['customDomainDelete', 'customDomainCreate']);
  });

  it('does not acknowledge detach when the deletion readback is incomplete', async () => {
    const f = await fixture({ override: (data, _query, reads) => reads > 1 ? {} : data });
    expect(await f.adapter.detachCustomDomain({ ...target, customDomainId: oldId })).toMatchObject({ success: false });
    expect(f.mutations).toEqual([{ field: 'customDomainDelete', args: { id: oldId } }]);
  });

  it('does not recreate after an incomplete deletion readback', async () => {
    const f = await fixture({ override: (data, _query, reads) => reads > 1 ? {} : data });
    expect(await f.adapter.recreateCustomDomain(target)).toMatchObject({ success: false });
    expect(f.mutations).toEqual([{ field: 'customDomainDelete', args: { id: oldId } }]);
  });

  it('refuses to delete a changed exact domain identity', async () => {
    const f = await fixture();
    expect(await f.adapter.detachCustomDomain({ ...target, customDomainId: 'reviewed-other-id' }))
      .toMatchObject({ success: false });
    expect(f.mutations).toEqual([]);
  });

  it('refuses to recreate a replacement of the reviewed custom-domain identity', async () => {
    const f = await fixture({ pageSize: 1 });
    const reviewed = { ...target, customDomainId: 'reviewed-other-id' };
    expect(await f.adapter.recreateCustomDomain(reviewed)).toMatchObject({ success: false });
    expect(f.mutations).toEqual([]);
    expect(f.domains).toContainEqual(f.production);
    expect(f.domains.find(item => item.environmentId === environmentId)?.id).toBe(oldId);
  });

  it('retries recreation after terminal absence of the reviewed custom-domain identity', async () => {
    const f = await fixture({ pageSize: 1 });
    f.domains.splice(1, 1);
    const reviewed = { ...target, customDomainId: oldId };
    expect(await f.adapter.recreateCustomDomain(reviewed)).toMatchObject({
      success: true, data: { created: true, recreated: false, customDomainId: 'domain-recreated' },
    });
    expect(f.mutations).toEqual([{ field: 'customDomainCreate', args: { input: target } }]);
    expect(f.domains).toContainEqual(f.production);
  });

  it.each(['absent', 'replaced'] as const)(
    'does not create or refresh when the reviewed attachment is %s at the adapter boundary', async state => {
      const f = await fixture({ pageSize: 1 });
      if (state === 'absent') f.domains.splice(1, 1);
      else {
        f.domains[1].id = 'unreviewed-replacement';
        f.domains[1].status.verified = false;
      }
      const reviewed = { ...target, customDomainId: oldId };
      expect(await f.adapter.attachCustomDomain(reviewed)).toMatchObject({ success: false });
      expect(f.mutations).toEqual([]);
      expect(f.domains).toContainEqual(f.production);
    },
  );

  it('refreshes the exact reviewed attachment when it remains present', async () => {
    const f = await fixture();
    f.domains[1].status.verified = false;
    const reviewed = { ...target, customDomainId: oldId };
    expect(await f.adapter.attachCustomDomain(reviewed)).toMatchObject({
      success: true, data: { customDomainId: oldId, refreshed: true },
    });
    expect(f.mutations).toEqual([{ field: 'customDomainUpdate', args: { id: oldId, environmentId } }]);
  });

  it('keeps a nonterminal deletion pending without creating a replacement', async () => {
    const f = await fixture({ keepDeleted: true });
    expect(await f.adapter.recreateCustomDomain(target)).toMatchObject({ success: false });
    expect(f.mutations).toEqual([{ field: 'customDomainDelete', args: { id: oldId } }]);
    expect(f.domains).toContainEqual(f.production);
  });

  it.each(['attachCustomDomain', 'recreateCustomDomain'] as const)(
    '%s never provisions a missing destination service instance', async method => {
      const f = await fixture({ instanceAbsent: true });
      expect(await f.adapter[method](target)).toMatchObject({ success: false });
      expect(f.mutations).toEqual([]);
      expect(f.requests).toHaveLength(1);
    },
  );

  it.each(['disappear', 'replace', 'reject'] as const)(
    'does not claim refresh success when the provider result is %s', async refresh => {
      const f = await fixture({ refresh });
      expect(await f.adapter.attachCustomDomain(target)).toMatchObject({ success: false });
      expect(f.mutations).toEqual([{ field: 'customDomainUpdate', args: { id: oldId, environmentId } }]);
    },
  );

  it.each(['attachCustomDomain', 'recreateCustomDomain'] as const)(
    '%s retains a validated creation identity after unknown, absent or conflicting readback', async method => {
      for (const failure of ['unknown', 'absent', 'conflicting']) {
        const f = await fixture({ override: (data, _query, reads) => {
          if (reads <= (method === 'attachCustomDomain' ? 1 : 2)) return data;
          if (failure === 'unknown') return {};
          if (failure === 'absent') data.service.serviceInstances.edges[1].node.domains.customDomains = [];
          else data.service.serviceInstances.edges[1].node.domains.customDomains[0].id = 'unreviewed-domain';
          return data;
        } });
        if (method === 'attachCustomDomain') f.domains.splice(1, 1);
        expect(await f.adapter[method](target)).toMatchObject({ success: false, data: {
          phase: 'customDomainCreateVerification', creationAcknowledged: true,
          customDomainId: 'domain-recreated', ...target,
        } });
        expect(f.mutations.filter(item => item.field === 'customDomainCreate')).toHaveLength(1);
        expect(f.domains).toContainEqual(f.production);
      }
    },
  );

  it.each(['missing-id', 'wrong-domain'] as const)(
    'does not retain an invalid create acknowledgement: %s', async creationResponse => {
      const f = await fixture({ creationResponse });
      f.domains.splice(1, 1);
      const result = await f.adapter.attachCustomDomain(target);
      expect(result.success).toBe(false);
      expect(result.data?.creationAcknowledged).not.toBe(true);
      expect(f.mutations.filter(item => item.field === 'customDomainCreate')).toHaveLength(1);
    },
  );
});
