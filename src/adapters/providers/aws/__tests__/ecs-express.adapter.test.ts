import { describe, expect, it, vi } from 'vitest';
import {
  EcsExpressAdapter,
  EcsExpressCredentialsSchema,
} from '../ecs-express.adapter.js';

const ACCOUNT_ID = '123456789012';
const REGION = 'us-west-2';
const CLUSTER_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/hv-app-production-0123456789`;
const SERVICE_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/hv-app-production-0123456789/hv-web-0123456789`;

const credentials = {
  accessKeyId: 'AKIAEXAMPLE12345678',
  secretAccessKey: 'aws-secret-value-that-is-long-enough-for-validation',
  region: REGION,
};


async function adapterWithSend(send: (command: unknown) => Promise<unknown>): Promise<EcsExpressAdapter> {
  const adapter = new EcsExpressAdapter();
  await adapter.connect(credentials);
  const client = { send, destroy: vi.fn() };
  (adapter as unknown as { clients: Record<string, typeof client> }).clients = {
    acm: client,
    ec2: client,
    ecr: client,
    ecs: client,
    elb: client,
    iam: client,
    sts: client,
  };
  (adapter as unknown as { accountId: string }).accountId = ACCOUNT_ID;
  return adapter;
}

function commandName(command: unknown): string {
  return (command as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
}


describe('EcsExpressAdapter operational boundaries', () => {

  it('forensically inventories an abandoned environment from logical context only', async () => {
    const adapter = await adapterWithSend(async (command) => (command as { constructor: { name: string } }).constructor.name === 'ListClustersCommand'
      ? { clusterArns: [] } : {});
    const internal = adapter as any;
    const getCluster = vi.spyOn(internal, 'getCluster').mockImplementation(async (...args: unknown[]) => ({
      clusterArn: String(args[0]),
      status: 'ACTIVE',
      tags: [{ key: 'managed-by', value: 'hypervibe' }],
    }));
    vi.spyOn(internal, 'listServiceArns').mockResolvedValue([SERVICE_ARN]);
    vi.spyOn(internal, 'getExpressService').mockResolvedValue({
      serviceArn: SERVICE_ARN,
      status: { statusCode: 'ACTIVE' },
      tags: [{ key: 'managed-by', value: 'hypervibe' }],
    });

    const inspected = await adapter.inspectEnvironmentResources({
      resource: 'environment',
      limit: 25,
      project: { id: 'project-local', name: 'app' },
      environment: { id: 'environment-local', projectId: 'project-local', name: 'production' },
    });

    expect(inspected).toMatchObject({
      observation: 'present',
      resource: 'environment',
      managedByHypervibe: true,
      services: [{ id: SERVICE_ARN, managedByHypervibe: true }],
    });
    expect(getCluster).toHaveBeenCalledOnce();
  });

  it('keeps region out of credentials while accepting a legacy value during migration', () => {
    expect(EcsExpressCredentialsSchema.parse(credentials)).toEqual({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    });
    expect(() => EcsExpressCredentialsSchema.parse({
      ...credentials,
      clusterArn: CLUSTER_ARN,
    })).toThrow();
  });

  it('uses explicit desired-state region instead of the legacy connection value', async () => {
    const adapter = await adapterWithSend(async () => ({}));
    adapter.configureTarget({ region: 'us-east-1' });
    const runtime = (adapter as unknown as { credentials: { region: string } }).credentials;
    expect(runtime.region).toBe('us-east-1');
  });


  it.each([
    ['cluster', 'findClusterArns', ['hv-app-production-0123456789'], 'ListClustersCommand'],
    ['service', 'listServiceArns', [CLUSTER_ARN], 'ListServicesCommand'],
  ])('rejects an incomplete AWS %s list before mutation', async (_label, method, args, expectedCommand) => {
    const calls: string[] = [];
    const adapter = await adapterWithSend(async (command) => {
      calls.push(commandName(command));
      return {};
    });

    await expect((adapter as any)[method](...args)).rejects.toThrow(/invalid .* list/i);
    expect(calls).toEqual([expectedCommand]);
  });
});
