import { readFileSync } from 'node:fs';
import { buildSchema, execute, GraphQLError, parse, validate } from 'graphql';
import { expect, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

export const schema = buildSchema(readFileSync('test/provider-contracts/railway/schema.graphql', 'utf8'));
export const projectId = 'project-contract';
export const productionId = 'environment-production';
export const stagingId = 'environment-staging';

type Instance = {
  id: string; serviceId: string; environmentId: string; deletedAt: string | null;
  source: { image?: string }; domains: { serviceDomains: Array<{ domain: string }>; customDomains: [] };
};
type ProviderService = { id: string; name: string; instances: Map<string, Instance> };
const connection = (nodes: unknown[], more = false, cursor: string | null = null) => ({
  edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: more, endCursor: cursor },
});

/** Synthetic provider state, executed by the official schema, not a recorded live lifecycle. */
export async function railwayHttpFixture(options: {
  stagingExists?: boolean; projectExists?: boolean; pageSize?: number; dropCreateResponse?: boolean;
  responseOverride?: (request: { query: string; variables: Record<string, any> }) => Response | undefined;
} = {}) {
  let projectExists = options.projectExists !== false;
  const services = new Map<string, ProviderService>();
  const environments = new Map([[productionId, { id: productionId, name: 'production', config: {} }]]);
  if (options.stagingExists !== false) environments.set(stagingId, { id: stagingId, name: 'staging', config: {} });
  const volumes = new Map<string, Record<string, unknown>>();
  const variables = new Map<string, Record<string, string>>();
  const mutations: Array<{ field: string; args: Record<string, any> }> = [];
  const requests: Array<{ query: string; variables: Record<string, any> }> = [];
  const contractErrors: string[] = [];

  function addService(id: string, name: string, environmentId: string) {
    const service = { id, name, instances: new Map<string, Instance>() };
    service.instances.set(environmentId, {
      id: `instance-${id}-${environmentId}`, serviceId: id, environmentId, deletedAt: null,
      source: {}, domains: { serviceDomains: [], customDomains: [] },
    });
    services.set(id, service);
    return service;
  }
  for (const name of ['postgres-db', 'redis-db', 'web']) addService(`production-${name}`, name, productionId);

  function serviceNode(service: ProviderService) {
    return {
      id: service.id, name: service.name, projectId, repoTriggers: connection([]),
      serviceInstances: ({ after }: { after?: string }) => {
        const instances = [...service.instances.values()];
        const start = after ? Number(after) : 0;
        const end = start + (options.pageSize ?? 100);
        const more = end < instances.length;
        return connection(instances.slice(start, end), more, more ? String(end) : null);
      },
    };
  }

  const root: Record<string, (args: any) => unknown> = {
    projects: () => connection(projectExists ? [{ id: projectId, name: 'contract-project' }] : []),
    projectCreate: ({ input }) => {
      expect(input).toMatchObject({ name: 'contract-project', workspaceId: 'workspace-contract' });
      projectExists = true;
      return { id: projectId, name: input.name };
    },
    project: ({ id }) => {
      expect(id).toBe(projectId);
      expect(projectExists).toBe(true);
      return {
      id: projectId, name: 'contract-project', environments: connection([...environments.values()]),
      services: connection([...services.values()].map(serviceNode)), buckets: connection([]), plugins: connection([]),
      };
    },
    environment: ({ id }) => ({
      ...environments.get(id), volumeInstances: connection([...volumes.values()].filter((v) => v.environmentId === id)),
    }),
    service: ({ id }) => services.has(id) ? serviceNode(services.get(id)!) : null,
    serviceInstance: ({ serviceId, environmentId }) => {
      const instance = services.get(serviceId)?.instances.get(environmentId);
      if (!instance) {
        // Error semantics observed in run c8ac543a-c31e-4c86-8fde-956c5fd676ee.
        // The envelope is reconstructed; this is not a raw HTTP recording.
        throw new GraphQLError('ServiceInstance not found', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
      }
      return instance;
    },
    variables: ({ serviceId, environmentId }) => variables.get(`${serviceId}/${environmentId}`) ?? {},
    environmentCreate: ({ input }) => {
      expect(input.projectId).toBe(projectId);
      const environment = { id: stagingId, name: input.name, config: {} };
      environments.set(stagingId, environment);
      return environment;
    },
    serviceCreate: ({ input }) => {
      expect(input).toMatchObject({ projectId, environmentId: stagingId });
      const service = addService(`staging-${input.name}`, input.name, input.environmentId);
      service.instances.get(stagingId)!.source = input.source ?? {};
      return serviceNode(service);
    },
    variableCollectionUpsert: ({ input }) => {
      expect(input.projectId).toBe(projectId);
      expect(services.get(input.serviceId)?.instances.has(input.environmentId)).toBe(true);
      variables.set(`${input.serviceId}/${input.environmentId}`, { ...input.variables });
      return true;
    },
    volumeCreate: ({ input }) => {
      const id = `volume-${input.serviceId}`;
      volumes.set(id, {
        id: `instance-${id}`, serviceId: input.serviceId, environmentId: input.environmentId,
        mountPath: input.mountPath, deletedAt: null, isPendingDeletion: false,
        volume: { id, projectId },
      });
      return { id };
    },
    serviceInstanceRedeploy: ({ serviceId, environmentId }) => {
      expect(services.get(serviceId)?.instances.has(environmentId)).toBe(true);
      return true;
    },
    serviceDelete: ({ id, environmentId }) => {
      services.get(id)!.instances.get(environmentId)!.deletedAt = '2026-09-12T00:00:00Z';
      return true;
    },
    serviceDomainCreate: ({ input }) => {
      const domain = { domain: 'contract-web.up.railway.app' };
      services.get(input.serviceId)!.instances.get(input.environmentId)!.domains.serviceDomains.push(domain);
      return domain;
    },
  };
  for (const field of ['projectCreate', 'environmentCreate', 'serviceCreate', 'variableCollectionUpsert', 'volumeCreate', 'serviceInstanceRedeploy', 'serviceDelete', 'serviceDomainCreate']) {
    const resolve = root[field];
    root[field] = (args) => {
      if (!['projectCreate', 'environmentCreate'].includes(field)) {
        expect(args.input?.environmentId ?? args.environmentId).toBe(stagingId);
      }
      mutations.push({ field, args });
      return resolve(args);
    };
  }

  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(url)).pathname).toBe('/graphql/v2');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-contract-token');
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    const override = options.responseOverride?.(request);
    if (override) return override;
    const document = parse(request.query);
    const errors = validate(schema, document);
    if (errors.length) {
      contractErrors.push(...errors.map((error) => error.message));
      return Response.json({ errors }, { status: 400 });
    }
    const result = await execute({ schema, document, variableValues: request.variables, rootValue: root });
    contractErrors.push(...(result.errors ?? [])
      .filter((error) => error.extensions.code !== 'INTERNAL_SERVER_ERROR')
      .map((error) => error.message));
    if (options.dropCreateResponse && request.query.includes('mutation CreateService')) {
      throw new TypeError('Synthetic connection reset after serviceCreate committed');
    }
    return Response.json(result);
  }));
  const adapter = new RailwayAdapter();
  await adapter.connect({ apiToken: 'synthetic-contract-token', workspaceId: 'workspace-contract' });
  const environment: Environment = {
    id: 'local-staging', projectId: 'local-project', name: 'staging',
    platformBindings: { projectId, ...(options.stagingExists !== false ? { environmentId: stagingId } : {}) },
    createdAt: new Date(), updatedAt: new Date(),
  };
  return { adapter, environment, services, environments, mutations, requests, variables, contractErrors };
}
