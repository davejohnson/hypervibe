import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute, parse, validate } from 'graphql';
import { RailwayAdapter } from '../railway.adapter.js';
import { inspectRailwayProject } from '../railway-inspection.driver.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { schema } from './railway-http.fixture.js';

const projectId = 'project-source-contract';
const serviceId = 'shared-web';
const productionId = 'production-instance-environment';
const securityId = 'security-instance-environment';
const scope = { projectId, environmentId: securityId };
const trigger = (environmentId = productionId) => ({
  id: `trigger-${environmentId}`, projectId, serviceId, environmentId,
  repository: 'owner/sequence', branch: environmentId === productionId ? 'main' : 'security',
});
const connection = (nodes: readonly unknown[], more = false) => ({
  edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: more, endCursor: more ? 'next' : null },
});

// Synthetic state executed through graphql-request and the pinned official SDL.
// DeploymentTrigger owns projectId/serviceId/environmentId; serviceConnect and
// serviceDisconnect accept only a global Service ID. Official Railway CLI
// b62467ef1b5303e3e340283ed96425dcf9612993, commands/service.rs also documents
// repository connection as service-level. No successful live mutation is claimed.
async function fixture(options: {
  siblings?: boolean; triggers?: ReadonlyArray<Record<string, unknown>>; triggerMore?: boolean;
  instanceRepo?: string; pageSize?: number; malformedInventory?: boolean;
  returnedProjectId?: string; inventoryFailure?: boolean;
  projectEnvironments?: readonly string[]; environmentPageSize?: number;
  malformedEnvironmentInventory?: boolean; environmentInventoryFailure?: boolean;
} = {}) {
  const instances = [securityId, ...(options.siblings === false ? [] : [productionId])].map(environmentId => ({
    id: `${serviceId}-${environmentId}`, serviceId, environmentId, deletedAt: null,
    source: environmentId === productionId ? { repo: 'owner/sequence' } : { repo: options.instanceRepo ?? null },
    domains: { serviceDomains: [], customDomains: [] }, activeDeployments: [],
  }));
  const triggers = options.triggers ?? [trigger()];
  const service = {
    id: serviceId, name: 'web', projectId: options.returnedProjectId ?? projectId,
    repoTriggers: () => connection(triggers, options.triggerMore),
    serviceInstances: ({ after }: { after?: string }) => {
      if (options.inventoryFailure) throw new Error('Synthetic inventory failure');
      const start = after ? Number(after) : 0;
      const end = Math.min(start + (options.pageSize ?? instances.length), instances.length);
      return {
        edges: instances.slice(start, end).map(node => ({ node })),
        pageInfo: options.malformedInventory ? null : { hasNextPage: end < instances.length, endCursor: end < instances.length ? String(end) : null },
      };
    },
  };
  const mutations: string[] = [];
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const errors: string[] = [];
  const rootValue = {
    project: () => ({
      id: projectId, name: 'source-contract',
      environments: ({ after }: { after?: string }) => {
        if (options.environmentInventoryFailure) throw new Error('Synthetic project environment inventory failure');
        const environments = options.projectEnvironments ?? [securityId, productionId];
        const start = after ? Number(after) : 0;
        const end = Math.min(start + (options.environmentPageSize ?? environments.length), environments.length);
        return { edges: environments.slice(start, end).map(id => ({ node: { id, name: id === securityId ? 'security' : 'production', config: {} } })),
          pageInfo: options.malformedEnvironmentInventory ? null : { hasNextPage: end < environments.length, endCursor: end < environments.length ? String(end) : null } };
      },
      services: connection([service]), buckets: connection([]), plugins: connection([]),
    }),
    service: () => service,
    serviceInstance: ({ environmentId }: { environmentId: string }) => instances.find(instance => instance.environmentId === environmentId),
    variables: () => ({}),
    variablesForServiceDeployment: () => ({}),
    serviceConnect: () => { mutations.push('serviceConnect'); return { id: serviceId }; },
    serviceDisconnect: () => { mutations.push('serviceDisconnect'); return { id: serviceId }; },
    serviceDelete: () => { mutations.push('serviceDelete'); return true; },
  };
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    const document = parse(request.query);
    expect(validate(schema, document)).toEqual([]);
    const result = await execute({ schema, document, variableValues: request.variables, rootValue });
    errors.push(...(result.errors ?? []).map(error => error.message));
    return Response.json(result);
  }));
  const adapter = new RailwayAdapter();
  await adapter.connect({ apiToken: 'synthetic-source-contract-token' });
  const environment: Environment = {
    id: 'local-security', projectId: 'local-project', name: 'security',
    platformBindings: { ...scope, services: { web: { serviceId } } },
    createdAt: new Date(), updatedAt: new Date(),
  };
  return { adapter, environment, mutations, requests, errors };
}

afterEach(() => vi.unstubAllGlobals());

describe('Railway shared Service source boundaries', () => {
  it('does not attribute the production trigger to an empty security instance', async () => {
    const state = await fixture();
    const result = await state.adapter.observe(state.environment);
    expect(result.services[0]).toMatchObject({ name: 'web', sourceState: 'disconnected' });
    expect(result.services[0].source).toBeUndefined();
    expect(state.errors).toEqual([]);
    expect(state.mutations).toEqual([]);
  });

  it('selects only the exact target trigger even when the production trigger comes first', async () => {
    const state = await fixture({ triggers: [trigger(), trigger(securityId)] });
    const result = await state.adapter.observe(state.environment);
    expect(result.services[0]).toMatchObject({ sourceState: 'connected', source: { repo: 'owner/sequence', branch: 'security' } });
    expect(state.errors).toEqual([]);
  });

  it.each([
    ['wrong project', { triggers: [{ ...trigger(securityId), projectId: 'other-project' }] }],
    ['wrong service', { triggers: [{ ...trigger(securityId), serviceId: 'other-service' }] }],
    ['missing service', { triggers: [{ ...trigger(securityId), serviceId: null }] }],
    ['incomplete inventory', { triggerMore: true }],
    ['ambiguous target', { triggers: [trigger(securityId), { ...trigger(securityId), id: 'second-trigger', branch: 'other' }] }],
    ['conflicting instance source', { instanceRepo: 'owner/another', triggers: [trigger(securityId)] }],
  ] as const)('keeps %s source evidence unknown and non-actionable', async (_label, options) => {
    const state = await fixture(options);
    const result = await state.adapter.observe(state.environment);
    expect(result.services[0].sourceState).toBe('unknown');
    expect(result.services[0].source).toBeUndefined();
    expect(result.partial).toBe(true);
    expect(state.mutations).toEqual([]);
  });

  it.each(['connect', 'disconnect'] as const)('blocks global %s when a sibling instance is on a later inventory page', async action => {
    const state = await fixture({ pageSize: 1 });
    const receipt = action === 'connect'
      ? await state.adapter.connectServiceToRepo({ serviceId, ...scope, repo: 'owner/sequence', branch: 'security' })
      : await state.adapter.disconnectDeploySource({ serviceId, ...scope });
    expect(receipt.success).toBe(false);
    expect(state.mutations).toEqual([]);
    expect(state.requests.some(request => request.variables.after === '1')).toBe(true);
    expect(state.errors).toEqual([]);
  });

  it.each(['connect', 'disconnect'] as const)('allows global %s only for the exact sole instance', async action => {
    const state = await fixture({ siblings: false, triggers: [], projectEnvironments: [securityId] });
    const receipt = action === 'connect'
      ? await state.adapter.connectServiceToRepo({ serviceId, ...scope, repo: 'owner/sequence', branch: 'security' })
      : await state.adapter.disconnectDeploySource({ serviceId, ...scope });
    expect(receipt.success).toBe(true);
    expect(state.mutations).toEqual([action === 'connect' ? 'serviceConnect' : 'serviceDisconnect']);
    expect(state.errors).toEqual([]);
  });

  it.each(['connect', 'disconnect'] as const)('blocks global %s when another project environment has no service instance', async action => {
    // The CLI says matching *project* environments. Its contract does not
    // promise exclusion of empty environments, so a sole instance is not proof
    // that a global source mutation has only the reviewed environment's effect.
    const state = await fixture({ siblings: false, triggers: [], environmentPageSize: 1 });
    const receipt = action === 'connect'
      ? await state.adapter.connectServiceToRepo({ serviceId, ...scope, repo: 'owner/sequence', branch: 'security' })
      : await state.adapter.disconnectDeploySource({ serviceId, ...scope });
    expect(receipt.success).toBe(false);
    expect(state.mutations).toEqual([]);
    expect(state.requests.some(request => request.query.includes('project') && request.variables.after === '1')).toBe(true);
    expect(state.errors).toEqual([]);
  });

  it.each([
    ['partial', { malformedEnvironmentInventory: true }],
    ['failed', { environmentInventoryFailure: true }],
    ['duplicate', { projectEnvironments: [securityId, securityId] }],
    ['wrong target', { projectEnvironments: [productionId] }],
  ] as const)('blocks global source changes when project environments are %s', async (_label, options) => {
    const state = await fixture({ siblings: false, triggers: [], ...options });
    expect((await state.adapter.disconnectDeploySource({ serviceId, ...scope })).success).toBe(false);
    expect(state.mutations).toEqual([]);
  });

  it.each([
    ['wrong project', { returnedProjectId: 'other-project' }, scope],
    ['wrong target environment', {}, { ...scope, environmentId: 'other-environment' }],
    ['partial inventory', { malformedInventory: true }, scope],
    ['failed inventory', { inventoryFailure: true }, scope],
    ['missing caller scope', {}, {}],
  ] as const)('blocks source mutation for %s', async (_label, options, target) => {
    const state = await fixture({ ...options, siblings: false, triggers: [] });
    expect((await state.adapter.disconnectDeploySource({ serviceId, ...target })).success).toBe(false);
    expect(state.mutations).toEqual([]);
  });

  it('retains the existing prohibition on deleting a sibling-shared service', async () => {
    const state = await fixture({ pageSize: 1 });
    expect(await state.adapter.deleteService(serviceId, { scope: 'environment', ...scope }, { allowMutation: true }))
      .toMatchObject({ success: false });
    expect(state.mutations).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  it('keeps import inspection sources on their actual instance, without a mixed-parent fallback', async () => {
    const state = await fixture();
    const result = await inspectRailwayProject(state.adapter, projectId, { includeEnvVarNames: false });
    expect(result?.services[0]).toMatchObject({
      repo: null, branch: null,
      instancesByEnv: {
        [productionId]: { sourceState: 'connected', source: { repo: 'owner/sequence', branch: 'main' } },
        [securityId]: { sourceState: 'disconnected' },
      },
    });
    expect(result?.services[0].instancesByEnv[securityId]).not.toHaveProperty('source');
    expect(state.errors).toEqual([]);
    expect(state.mutations).toEqual([]);
  });
});
