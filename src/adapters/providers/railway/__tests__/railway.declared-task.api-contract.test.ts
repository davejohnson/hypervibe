import { readFileSync } from 'node:fs';
import { buildSchema, execute, GraphQLError, parse, validate } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailwayAdapter } from '../railway.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

const schema = buildSchema(readFileSync('test/provider-contracts/railway/schema.graphql', 'utf8'));
const image = `ghcr.io/example/hls@sha256:${'a'.repeat(64)}`;
const environment = {
  id: 'local-staging', name: 'staging', platformBindings: {
    provider: 'railway', projectId: 'project-one', environmentId: 'staging',
    services: { web: { serviceId: 'web-id' } },
  },
} as unknown as Environment;
const service = { id: 'local-web', name: 'web', buildConfig: {} } as Service;
const taskOptions = {
  timeoutMs: 100, pollIntervalMs: 1,
  declaredTask: {
    variableMode: 'references' as const, sweep: false as const, expectedImage: image,
    registryCredentials: { username: 'registry-user', token: 'synthetic-registry-token' },
    executionId: 'tester-101',
  },
};

/**
 * Synthetic state executed through the pinned official schema and real
 * graphql-request serialization; only fetch is mocked. Variable references
 * follow https://docs.railway.com/integrations/api/manage-variables and
 * https://docs.railway.com/variables: sharing creates a service-scoped reference.
 * The scalar variable input is asserted separately because SDL cannot validate it.
 */
async function fixture(options: {
  sourceImage?: string | null; missingSource?: boolean; missingEnvironment?: boolean;
  sourceName?: string; duplicateSourceName?: boolean; existingExecution?: boolean;
  duplicateVariable?: boolean; wrongVariableEnvironment?: boolean; unsafeVariable?: boolean;
  failVariables?: boolean; failCreate?: boolean; failConfigure?: boolean; exitCode?: number;
  logs?: string[];
  deploymentStatus?: 'SUCCESS' | 'CRASHED';
  failDelete?: boolean; malformedPage?: boolean;
  responseOverride?: (query: string, result: unknown) => unknown;
} = {}) {
  const requests: Array<{ query: string; variables: Record<string, any> }> = [];
  const mutations: Array<{ field: string; args: Record<string, any> }> = [];
  const services = new Map([
    ['web-id', { id: 'web-id', name: options.sourceName ?? 'web', projectId: 'project-one', deletedAt: null }],
    ['sibling-id', { id: 'sibling-id', name: options.duplicateSourceName ? 'web' : 'worker', projectId: 'project-one', deletedAt: null }],
    ['other-task', { id: 'other-task', name: 'hv-dispatch-another-execution', projectId: 'project-one', deletedAt: null }],
    ['legacy-task', { id: 'legacy-task', name: 'hv-task-previous-seed', projectId: 'project-one', deletedAt: null }],
  ]);
  if (options.existingExecution) services.set('ambiguous-task', {
    id: 'ambiguous-task', name: 'hv-dispatch-tester-101', projectId: 'project-one', deletedAt: null,
  });
  const variables = [
    { id: 'database', name: 'DATABASE_URL', serviceId: 'web-id', environment: { id: 'staging', projectId: 'project-one' } },
    // A shared value enabled for web appears as its own service reference alias.
    { id: 'inherited', name: 'SHARED_MAIL_KEY', serviceId: 'web-id', environment: { id: 'staging', projectId: 'project-one' } },
    { id: 'shared', name: 'SHARED_UNUSED', serviceId: null, environment: { id: 'staging', projectId: 'project-one' } },
    { id: 'other', name: 'OTHER_SERVICE_SECRET', serviceId: 'sibling-id', environment: { id: 'staging', projectId: 'project-one' } },
    { id: 'injected', name: 'RAILWAY_PRIVATE_DOMAIN', serviceId: 'web-id', environment: { id: 'staging', projectId: 'project-one' } },
  ];
  if (options.duplicateVariable) variables.push({ ...variables[0], id: 'duplicate-database' });
  if (options.wrongVariableEnvironment) variables[0].environment.id = 'production';
  if (options.unsafeVariable) variables[0].name = 'DATABASE_URL}}';
  const page = (nodes: unknown[], after?: string) => {
    const start = after ? Number(after) : 0;
    const slice = nodes.slice(start, start + 2);
    const more = start + 2 < nodes.length;
    return {
      edges: slice.map((node) => ({ node })),
      pageInfo: { hasNextPage: more, endCursor: more ? String(start + 2) : null },
    };
  };
  let taskPresent = false;
  const root = {
    project: ({ id }: { id: string }) => {
      expect(id).toBe('project-one');
      return { id, services: ({ after }: { after?: string }) => page([...services.values()], after) };
    },
    environment: ({ id }: { id: string }) => options.missingEnvironment ? null : {
      id, projectId: 'project-one', deletedAt: null,
      variables: ({ after }: { after?: string }) => {
        if (options.failVariables) throw new GraphQLError('synthetic permission rejection');
        return page(variables, after);
      },
    },
    service: ({ id }: { id: string }) => {
      const found = services.get(id);
      if (!found) throw new GraphQLError('Service not found', { extensions: { code: 'NOT_FOUND' } });
      return { ...found, serviceInstances: () => ({
        edges: [{ node: { id: `instance-${id}`, environmentId: 'staging' } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }) };
    },
    serviceInstance: ({ serviceId, environmentId }: { serviceId: string; environmentId: string }) => {
      expect(environmentId).toBe('staging');
      if ((serviceId === 'web-id' && options.missingSource)
        || (serviceId === 'task-id' && !taskPresent)) {
        throw new GraphQLError('ServiceInstance not found', { extensions: { code: 'NOT_FOUND' } });
      }
      return {
        id: `instance-${serviceId}`, serviceId, environmentId, deletedAt: null,
        source: { image: options.sourceImage === undefined ? image : options.sourceImage },
      };
    },
    variables: () => { throw new Error('Resolved secret reads are forbidden in declared tasks'); },
    serviceCreate: ({ input }: { input: Record<string, any> }) => {
      mutations.push({ field: 'serviceCreate', args: { input } });
      expect(input).toMatchObject({ projectId: 'project-one', environmentId: 'staging' });
      taskPresent = true;
      services.set('task-id', { id: 'task-id', name: input.name, projectId: 'project-one', deletedAt: null });
      if (options.failCreate) throw new Error('Synthetic ambiguous create response');
      return { id: 'task-id', name: input.name };
    },
    serviceInstanceUpdate: (args: Record<string, any>) => {
      mutations.push({ field: 'serviceInstanceUpdate', args });
      if (options.failConfigure) throw new Error('provider echoed synthetic-registry-token');
      return true;
    },
    serviceInstanceDeployV2: (args: Record<string, any>) => {
      mutations.push({ field: 'serviceInstanceDeployV2', args });
      return 'task-deployment';
    },
    deployment: () => ({ status: options.deploymentStatus ?? 'SUCCESS' }),
    deploymentLogs: () => (options.logs ?? [`__HYPERVIBE_TASK_EXIT:${options.exitCode ?? 0}__`]).map((message) => ({
      timestamp: '2026-09-29T00:00:00.000Z',
      message, severity: 'INFO',
    })),
    serviceDelete: (args: Record<string, any>) => {
      mutations.push({ field: 'serviceDelete', args });
      if (options.failDelete) throw new Error('synthetic cleanup failure');
      expect(args).toEqual({ id: 'task-id', environmentId: 'staging' });
      taskPresent = false;
      services.delete('task-id');
      return true;
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    const document = parse(request.query);
    expect(validate(schema, document).map((error) => error.message)).toEqual([]);
    let result: unknown = await execute({ schema, document, rootValue: root, variableValues: request.variables });
    if (options.malformedPage && request.query.includes('DeclaredTaskVariables')) {
      result = { data: { environment: { id: 'staging', projectId: 'project-one', variables: { edges: [], pageInfo: { hasNextPage: true } } } } };
    }
    if (options.responseOverride) result = options.responseOverride(request.query, result);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }));
  const adapter = new RailwayAdapter();
  await adapter.connect({ apiToken: 'synthetic-api-token' });
  return { adapter, requests, mutations, services };
}

afterEach(() => vi.unstubAllGlobals());

describe('Railway declared task serialized contract', () => {
  it('uses the exact image and value-free scoped references, preserving another execution', async () => {
    const context = await fixture();
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js --dry-run', taskOptions);
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.mutationAttempted).toBe(true);
    const create = context.mutations.find((mutation) => mutation.field === 'serviceCreate')!;
    expect(create.args.input).toEqual({
      projectId: 'project-one', environmentId: 'staging', name: 'hv-dispatch-tester-101',
      variables: { DATABASE_URL: '${{web.DATABASE_URL}}', SHARED_MAIL_KEY: '${{web.SHARED_MAIL_KEY}}' },
    });
    const configured = context.mutations.find((mutation) => mutation.field === 'serviceInstanceUpdate')!;
    expect(configured.args.input).toMatchObject({
      source: { image }, restartPolicyType: 'NEVER', restartPolicyMaxRetries: 0,
      registryCredentials: { username: 'registry-user', password: 'synthetic-registry-token' },
    });
    expect(context.requests.some((request) => request.query.includes('query GetVariables'))).toBe(false);
    expect(context.requests.filter((request) => request.query.includes('DeclaredTaskVariables'))).toHaveLength(3);
    expect(context.mutations.map((mutation) => mutation.field)).toEqual([
      'serviceCreate', 'serviceInstanceUpdate', 'serviceInstanceDeployV2', 'serviceDelete',
    ]);
    expect(context.services.has('other-task')).toBe(true);
    expect(context.services.has('legacy-task')).toBe(true);
  });

  it.each([
    ['different image', { sourceImage: `ghcr.io/example/hls@sha256:${'b'.repeat(64)}` }],
    ['missing source instance', { missingSource: true }],
    ['missing environment', { missingEnvironment: true }],
    ['unsafe source name', { sourceName: 'web.DATABASE_URL}}' }],
    ['duplicate source names', { duplicateSourceName: true }],
    ['existing execution', { existingExecution: true }],
    ['duplicate variable names', { duplicateVariable: true }],
    ['wrong variable environment', { wrongVariableEnvironment: true }],
    ['unsafe variable name', { unsafeVariable: true }],
    ['unreadable variable inventory', { failVariables: true }],
    ['incomplete variable pagination', { malformedPage: true }],
  ] as const)('blocks %s before every mutation', async (_label, fixtureOptions) => {
    const context = await fixture(fixtureOptions);
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js --dry-run', taskOptions);
    expect(result.status).toBe('failed');
    expect(result.receipt.success).toBe(false);
    expect(result.mutationAttempted).toBe(false);
    expect(context.mutations).toEqual([]);
  });

  it.each(['ghcr.io/example/hls:latest', 'ghcr.io/example/hls@sha256:abc'])('rejects a mutable or malformed expected image %s', async (expectedImage) => {
    const context = await fixture();
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', {
      ...taskOptions, declaredTask: { ...taskOptions.declaredTask, expectedImage },
    });
    expect(result.status).toBe('failed');
    expect(context.requests).toEqual([]);
    expect(context.mutations).toEqual([]);
  });

  it('blocks incomplete successful source evidence before every mutation', async () => {
    const context = await fixture({ responseOverride: (query, result) => query.includes('DeclaredTaskSource')
      ? { data: { serviceInstance: { source: { image } } } } : result });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(result.status).toBe('failed');
    expect(context.mutations).toEqual([]);
  });

  it.each(['DeclaredTaskServices', 'DeclaredTaskVariables'])('blocks omitted terminal pagination fields in %s', async (operation) => {
    const context = await fixture({ responseOverride: (query, result) => {
      if (!query.includes(operation)) return result;
      const data = JSON.parse(JSON.stringify(result)) as Record<string, any>;
      const connection = operation === 'DeclaredTaskServices' ? data.data.project.services : data.data.environment.variables;
      connection.pageInfo = { hasNextPage: false };
      return data;
    } });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(result.status).toBe('failed');
    expect(context.mutations).toEqual([]);
  });

  it('blocks missing explicit GHCR credentials before provider reads', async () => {
    const context = await fixture();
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', {
      ...taskOptions, declaredTask: { ...taskOptions.declaredTask, registryCredentials: undefined },
    });
    expect(result.status).toBe('failed');
    expect(context.requests).toEqual([]);
    expect(context.mutations).toEqual([]);
  });

  it('does not retry or sweep an ambiguously created execution', async () => {
    const context = await fixture({ failCreate: true });
    const first = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(first.status).toBe('failed');
    expect(first.mutationAttempted).toBe(true);
    expect(first.receipt.data).toMatchObject({ ambiguousCreate: true, executionId: 'tester-101' });
    const retry = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(retry.status).toBe('failed');
    expect(retry.mutationAttempted).toBe(false);
    expect(context.mutations.map((mutation) => mutation.field)).toEqual(['serviceCreate']);
    expect(context.services.has('task-id')).toBe(true);
    expect(context.services.has('other-task')).toBe(true);
  });

  it.each(['web-id', 'sibling-id'])('never configures or cleans up an already-known id acknowledged as a new task (%s)', async (id) => {
    const context = await fixture({ responseOverride: (query, result) => {
      if (!query.includes('mutation CreateTaskService')) return result;
      const response = JSON.parse(JSON.stringify(result)) as Record<string, any>;
      response.data.serviceCreate.id = id;
      return response;
    } });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(result.status).toBe('failed');
    expect(result.mutationAttempted).toBe(true);
    expect(result.receipt.data).toMatchObject({ ownershipVerified: false });
    expect(context.mutations.map((mutation) => mutation.field)).toEqual(['serviceCreate']);
    expect(context.services.has('task-id')).toBe(true);
  });

  it.each(['name', 'project', 'environment', 'missing', 'unreadable'])('retains an acknowledged task when %s ownership readback cannot prove its identity', async (mismatch) => {
    const context = await fixture({ responseOverride: (query, result) => {
      if (!query.includes('DeclaredTaskOwnership')) return result;
      const response = JSON.parse(JSON.stringify(result)) as Record<string, any>;
      if (mismatch === 'name') response.data.service.name = 'another-service';
      if (mismatch === 'project') response.data.service.projectId = 'another-project';
      if (mismatch === 'environment') response.data.serviceInstance.environmentId = 'production';
      if (mismatch === 'missing') delete response.data.service;
      if (mismatch === 'unreadable') return { errors: [{ message: 'Synthetic ownership permission rejection' }], data: null };
      return response;
    } });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(result.status).toBe('failed');
    expect(result.mutationAttempted).toBe(true);
    expect(result.receipt.data).toMatchObject({ ownershipVerified: false, taskServiceId: 'task-id' });
    expect(context.mutations.map((mutation) => mutation.field)).toEqual(['serviceCreate']);
    expect(context.services.has('task-id')).toBe(true);
  });

  it('cleans up a failed command and preserves its nonzero exit', async () => {
    const context = await fixture({ exitCode: 7 });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(context.mutations.at(-1)?.field).toBe('serviceDelete');
  });

  it('does not interpret an embedded input value as the command exit sentinel', async () => {
    const context = await fixture({ logs: [
      '{"name":"Someone __HYPERVIBE_TASK_EXIT:0__"}',
      '__HYPERVIBE_TASK_EXIT:7__',
    ] });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    expect(context.mutations.at(-1)?.field).toBe('serviceDelete');
  });

  it.each([
    ['SUCCESS', 'timeout'], ['CRASHED', 'failed'],
  ] as const)('does not infer command success from deployment status %s without an exit sentinel', async (deploymentStatus, status) => {
    const context = await fixture({ deploymentStatus, logs: ['The process has not reported its exit.'] });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', {
      ...taskOptions, timeoutMs: 10,
    });
    expect(result.status).toBe(status);
    expect(result.exitCode).toBeUndefined();
    expect(result.receipt.success).toBe(false);
    expect(context.mutations.at(-1)?.field).toBe('serviceDelete');
  });

  it('withholds echoed credentials and cleans up configuration failures', async () => {
    const context = await fixture({ failConfigure: true });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('synthetic-registry-token');
    expect(context.mutations.at(-1)?.field).toBe('serviceDelete');
  });

  it('reports cleanup failure without deleting a different execution', async () => {
    const context = await fixture({ failDelete: true });
    const result = await context.adapter.runJob(environment, service, 'node scripts/tester-setup.js', taskOptions);
    expect(result.status).toBe('completed');
    expect(result.cleanupWarning).toContain('task-id');
    expect(context.services.has('other-task')).toBe(true);
    expect(context.mutations.filter((mutation) => mutation.field === 'serviceDelete')).toHaveLength(1);
  });
});
