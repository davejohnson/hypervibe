import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreateServerlessCacheCommand,
  DeleteServerlessCacheCommand,
  DescribeServerlessCachesCommand,
} from '@aws-sdk/client-elasticache';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
} from '@aws-sdk/client-ec2';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { ElastiCacheAdapter } from '../elasticache.adapter.js';

const CACHE_NAME = 'invoice-perfect-production-redis';
const CACHE_ARN =
  `arn:aws:elasticache:us-west-2:123456789012:serverlesscache:${CACHE_NAME}`;
const AWS_SECRET = 'aws-secret-access-key-never-output';

function environment(): Environment {
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function component(externalId = CACHE_ARN): Component {
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'redis',
    externalId,
    bindings: {
      provider: 'elasticache',
      instanceId: externalId,
      cacheName: CACHE_NAME,
      securityGroupId: 'sg-cache',
      securityGroupManagedByHypervibe: true,
      tls: true,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function cache(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ServerlessCacheName: CACHE_NAME,
    ARN: CACHE_ARN,
    Status: 'available',
    Engine: 'valkey',
    Endpoint: {
      Address: 'cache.serverless.usw2.cache.amazonaws.com',
      Port: 6379,
    },
    SecurityGroupIds: ['sg-cache'],
    SubnetIds: ['subnet-a', 'subnet-b'],
    ...overrides,
  };
}

async function connected(params?: {
  elasticacheSend?: (command: unknown) => Promise<unknown>;
  ec2Send?: (command: unknown) => Promise<unknown>;
}) {
  const adapter = new ElastiCacheAdapter();
  await adapter.connect({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: AWS_SECRET,
    region: 'us-west-2',
    subnetIds: ['subnet-a', 'subnet-b'],
    securityGroupIds: ['sg-workload'],
  });
  const elasticacheSend = vi.fn(params?.elasticacheSend ?? (async (command: unknown) => {
    throw new Error(
      `Unexpected ElastiCache command: ${(command as { constructor?: { name?: string } }).constructor?.name}`
    );
  }));
  const ec2Send = vi.fn(params?.ec2Send ?? (async (command: unknown) => {
    throw new Error(
      `Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`
    );
  }));
  (adapter as unknown as {
    elasticache: { send: typeof elasticacheSend };
  }).elasticache = { send: elasticacheSend };
  (adapter as unknown as {
    ec2: { send: typeof ec2Send };
  }).ec2 = { send: ec2Send };
  return { adapter, elasticacheSend, ec2Send };
}

describe('ElastiCacheAdapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not mutate when complete cache observation fails', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          const error = new Error('AWS throttled cache observation');
          Object.assign(error, { name: 'ThrottlingException' });
          throw error;
        }
        throw new Error('Unexpected mutation');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain('AWS throttled cache observation');
    expect(
      elasticacheSend.mock.calls.some(([command]) =>
        command instanceof CreateServerlessCacheCommand
      )
    ).toBe(false);
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('blocks a cache name match without creating networking or a replacement', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return { ServerlessCaches: [cache()] };
        }
        throw new Error('Unexpected mutation');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.error).toContain(CACHE_ARN);
    expect(result.receipt.error).toContain('will not choose or silently adopt');
    expect(
      elasticacheSend.mock.calls.some(([command]) =>
        command instanceof CreateServerlessCacheCommand
      )
    ).toBe(false);
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('creates an isolated ingress group and a TLS serverless Valkey cache', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_DELAY_MS', '0');
    let listCount = 0;
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          listCount += 1;
          return {
            ServerlessCaches: listCount === 1 ? [] : [cache()],
          };
        }
        if (command instanceof CreateServerlessCacheCommand) {
          return { ServerlessCache: cache({ Status: 'creating' }) };
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSubnetsCommand) {
          return {
            Subnets: [
              {
                SubnetId: 'subnet-a',
                VpcId: 'vpc-1',
                AvailabilityZone: 'us-west-2a',
              },
              {
                SubnetId: 'subnet-b',
                VpcId: 'vpc-1',
                AvailabilityZone: 'us-west-2b',
              },
            ],
          };
        }
        if (command instanceof DescribeSecurityGroupsCommand) {
          return command.input.GroupIds
            ? {
              SecurityGroups: [{
                GroupId: 'sg-workload',
                VpcId: 'vpc-1',
              }],
            }
            : { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) {
          return { GroupId: 'sg-cache' };
        }
        if (command instanceof AuthorizeSecurityGroupIngressCommand) {
          return {};
        }
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: 'Invoice Perfect Production Redis',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe(CACHE_ARN);
    expect(result.connectionUrl).toBe(
      'rediss://cache.serverless.usw2.cache.amazonaws.com:6379'
    );
    expect(result.envVars).toEqual({ REDIS_URL: result.connectionUrl });
    const authorize = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) =>
        command instanceof AuthorizeSecurityGroupIngressCommand
      ) as AuthorizeSecurityGroupIngressCommand;
    expect(authorize.input).toMatchObject({
      GroupId: 'sg-cache',
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 6379,
        ToPort: 6379,
        UserIdGroupPairs: [{
          GroupId: 'sg-workload',
          Description: 'Hypervibe workload access to ElastiCache',
        }],
      }],
    });
    const create = elasticacheSend.mock.calls
      .map(([command]) => command)
      .find((command) =>
        command instanceof CreateServerlessCacheCommand
      ) as CreateServerlessCacheCommand;
    expect(create.input).toMatchObject({
      ServerlessCacheName: CACHE_NAME,
      Engine: 'valkey',
      SecurityGroupIds: ['sg-cache'],
      SubnetIds: ['subnet-a', 'subnet-b'],
      SnapshotRetentionLimit: 1,
      CacheUsageLimits: {
        DataStorage: { Maximum: 5, Unit: 'GB' },
        ECPUPerSecond: { Maximum: 1000 },
      },
    });
    expect(JSON.stringify(result.receipt)).not.toContain(AWS_SECRET);
    expect(JSON.stringify(result.receipt)).not.toContain('rediss://');
  });

  it('preserves cache and network identity when create outcome is unknown', async () => {
    let listCount = 0;
    const { adapter, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          listCount += 1;
          if (listCount === 1) return { ServerlessCaches: [] };
          const error = new Error('ElastiCache observation unavailable');
          Object.assign(error, { name: 'ServiceUnavailable' });
          throw error;
        }
        if (command instanceof CreateServerlessCacheCommand) {
          throw new Error('connection closed after request transmission');
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSubnetsCommand) {
          return {
            Subnets: [
              { SubnetId: 'subnet-a', VpcId: 'vpc-1', AvailabilityZone: 'us-west-2a' },
              { SubnetId: 'subnet-b', VpcId: 'vpc-1', AvailabilityZone: 'us-west-2b' },
            ],
          };
        }
        if (command instanceof DescribeSecurityGroupsCommand) {
          return command.input.GroupIds
            ? { SecurityGroups: [{ GroupId: 'sg-workload', VpcId: 'vpc-1' }] }
            : { SecurityGroups: [] };
        }
        if (command instanceof CreateSecurityGroupCommand) {
          return { GroupId: 'sg-cache' };
        }
        if (command instanceof AuthorizeSecurityGroupIngressCommand) return {};
        if (command instanceof DeleteSecurityGroupCommand) return {};
        throw new Error('Unexpected EC2 command');
      },
    });

    const result = await adapter.provision('redis', environment(), {
      resourceName: CACHE_NAME,
    });

    expect(result.receipt.success).toBe(false);
    expect(result.component.bindings).toMatchObject({
      cacheName: CACHE_NAME,
      securityGroupId: 'sg-cache',
      securityGroupManagedByHypervibe: true,
      mutationAttempted: true,
    });
    expect(result.receipt.data).toMatchObject({
      cacheName: CACHE_NAME,
      cacheMutationAttempted: true,
      resourceCreated: 'unknown',
      securityGroupId: 'sg-cache',
      liveObservationError: 'ElastiCache observation unavailable',
    });
    expect(
      ec2Send.mock.calls.some(([command]) =>
        command instanceof DeleteSecurityGroupCommand
      )
    ).toBe(false);
  });

  it('uses the durable ARN first when names disagree', async () => {
    const { adapter } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          return {
            ServerlessCaches: [
              cache({ ServerlessCacheName: 'renamed-cache' }),
              cache({
                ARN: 'arn:aws:elasticache:us-west-2:123:serverlesscache:unrelated',
                ServerlessCacheName: CACHE_NAME,
              }),
            ],
          };
        }
        throw new Error('Unexpected ElastiCache command');
      },
    });

    const observed = await adapter.observeCache(environment(), component());

    expect(observed).toMatchObject({
      externalId: CACHE_ARN,
      name: 'renamed-cache',
      status: 'running',
    });
  });

  it('waits for cache absence before retrying and deleting the managed security group', async () => {
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_READY_DELAY_MS', '0');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_NETWORK_DELETE_ATTEMPTS', '3');
    vi.stubEnv('HYPERVIBE_ELASTICACHE_NETWORK_DELETE_DELAY_MS', '0');
    let deleted = false;
    let readsAfterDelete = 0;
    let groupDeleteAttempts = 0;
    const order: string[] = [];
    const { adapter } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          order.push('describe-cache');
          if (!deleted) return { ServerlessCaches: [cache()] };
          readsAfterDelete += 1;
          return {
            ServerlessCaches: readsAfterDelete === 1
              ? [cache({ Status: 'deleting' })]
              : [],
          };
        }
        if (command instanceof DeleteServerlessCacheCommand) {
          deleted = true;
          order.push('delete-cache');
          return {};
        }
        throw new Error('Unexpected ElastiCache command');
      },
      ec2Send: async (command) => {
        if (command instanceof DeleteSecurityGroupCommand) {
          groupDeleteAttempts += 1;
          order.push('delete-security-group');
          if (groupDeleteAttempts === 1) {
            const error = new Error('resource still in use');
            Object.assign(error, { name: 'DependencyViolation' });
            throw error;
          }
          return {};
        }
        throw new Error('Unexpected EC2 command');
      },
    });

    const receipt = await adapter.destroy(component());

    expect(receipt.success).toBe(true);
    expect(readsAfterDelete).toBe(2);
    expect(groupDeleteAttempts).toBe(2);
    expect(order.indexOf('delete-security-group')).toBeGreaterThan(
      order.lastIndexOf('describe-cache')
    );
  });

  it('does not delete networking when cache observation is unknown', async () => {
    const { adapter, elasticacheSend, ec2Send } = await connected({
      elasticacheSend: async (command) => {
        if (command instanceof DescribeServerlessCachesCommand) {
          const error = new Error('Access denied');
          Object.assign(error, { name: 'AccessDeniedException' });
          throw error;
        }
        throw new Error('Unexpected ElastiCache mutation');
      },
    });

    const receipt = await adapter.destroy(component());

    expect(receipt.success).toBe(false);
    expect(receipt.error).toContain('Access denied');
    expect(
      elasticacheSend.mock.calls.some(([command]) =>
        command instanceof DeleteServerlessCacheCommand
      )
    ).toBe(false);
    expect(ec2Send).not.toHaveBeenCalled();
  });
});
