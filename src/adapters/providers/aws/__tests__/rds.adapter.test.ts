import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { RdsAdapter } from '../rds.adapter.js';

const now = new Date();
const ACCOUNT_ID = '123456789012';
const REGION = 'us-west-2';
const VPC_ID = 'vpc-1';
const WORKLOAD_SECURITY_GROUP_ID = 'sg-workload';
const CLUSTER_NAME = 'hv-invoice-perfect-production-0123456789';
const CLUSTER_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}`;
const environment = {
  id: 'env-1',
  projectId: 'project-1',
  name: 'production',
  platformBindings: {
    provider: 'ecs',
    projectId: CLUSTER_ARN,
    environmentId: CLUSTER_ARN,
    services: {},
    awsNetwork: {
      accountId: ACCOUNT_ID,
      region: REGION,
      vpcId: VPC_ID,
      subnetIds: ['subnet-a', 'subnet-b'],
      workloadSecurityGroupId: WORKLOAD_SECURITY_GROUP_ID,
    },
  },
  createdAt: now,
  updatedAt: now,
} as Environment;
const component = {
  id: 'component-1',
  environmentId: environment.id,
  type: 'postgres',
  externalId: 'production-postgres',
  bindings: {
    provider: 'rds',
    username: 'hypervibe_admin',
    password: 'db-secret',
    database: 'app',
    securityGroupId: 'sg-database',
    securityGroupVpcId: VPC_ID,
    securityGroupName: 'production-postgres-hypervibe-db',
    securityGroupManagedByHypervibe: true,
    securityGroupRuntimeIngressManaged: true,
    workloadSecurityGroupId: WORKLOAD_SECURITY_GROUP_ID,
    subnetIds: ['subnet-a', 'subnet-b'],
    providerScope: { accountId: '123456789012', region: 'us-west-2' },
  },
  createdAt: now,
  updatedAt: now,
} as Component;

function managedSecurityGroup(
  identifier: string,
  groupId = 'sg-database',
  withRuntimeIngress = true
) {
  return {
    GroupId: groupId,
    GroupName: `${identifier}-hypervibe-db`,
    VpcId: 'vpc-1',
    Tags: [
      { Key: 'ManagedBy', Value: 'Hypervibe' },
      { Key: 'Database', Value: identifier },
    ],
    IpPermissions: withRuntimeIngress ? [{
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      UserIdGroupPairs: [{ GroupId: WORKLOAD_SECURITY_GROUP_ID }],
    }] : [],
  };
}

function workloadSecurityGroup() {
  return {
    GroupId: WORKLOAD_SECURITY_GROUP_ID,
    GroupName: `${CLUSTER_NAME}-hypervibe-workloads`,
    VpcId: VPC_ID,
    Tags: [
      { Key: 'managed-by', Value: 'hypervibe' },
      { Key: 'hypervibe-environment-id', Value: environment.id },
      { Key: 'hypervibe-ecs-cluster-arn', Value: CLUSTER_ARN },
    ],
  };
}

function workloadNetworkResponse(command: unknown): Record<string, unknown> | undefined {
  if (command instanceof DescribeVpcsCommand) {
    return { Vpcs: [{ VpcId: VPC_ID, IsDefault: true }] };
  }
  if (command instanceof DescribeSubnetsCommand) {
    return {
      Subnets: [
        { SubnetId: 'subnet-a', VpcId: VPC_ID, AvailabilityZone: `${REGION}a`, DefaultForAz: true },
        { SubnetId: 'subnet-b', VpcId: VPC_ID, AvailabilityZone: `${REGION}b`, DefaultForAz: true },
      ],
    };
  }
  if (command instanceof DescribeSecurityGroupsCommand
    && command.input.GroupIds?.[0] === WORKLOAD_SECURITY_GROUP_ID) {
    return { SecurityGroups: [workloadSecurityGroup()] };
  }
  return undefined;
}

async function connectedAdapter(params?: { publiclyAccessible?: boolean; rules?: Array<Record<string, unknown>> }) {
  const adapter = new RdsAdapter();
  await adapter.connect({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    region: 'us-west-2',
  });
  const instance = {
    DBInstanceIdentifier: component.externalId!,
    DBInstanceArn: `arn:aws:rds:us-west-2:123456789012:db:${component.externalId}`,
    DBInstanceStatus: 'available',
    PubliclyAccessible: params?.publiclyAccessible ?? true,
    Endpoint: { Address: 'production.example.rds.amazonaws.com', Port: 5432 },
    VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-database' }],
  };
  const rdsSend = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeDBInstancesCommand) return { DBInstances: [instance] };
    throw new Error(`Unexpected RDS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
  const ec2Send = vi.fn(async (command: unknown) => {
    const networkResponse = workloadNetworkResponse(command);
    if (networkResponse) return networkResponse;
    if (command instanceof DescribeSecurityGroupsCommand
      && command.input.GroupIds?.[0] === 'sg-database') {
      return { SecurityGroups: [managedSecurityGroup(component.externalId!)] };
    }
    if (command instanceof DescribeSecurityGroupRulesCommand) {
      return { SecurityGroupRules: params?.rules ?? [] };
    }
    if (command instanceof AuthorizeSecurityGroupIngressCommand) {
      return { SecurityGroupRules: [{ SecurityGroupRuleId: 'sgr-temporary' }] };
    }
    if (command instanceof RevokeSecurityGroupIngressCommand) return {};
    throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
  (adapter as unknown as { rds: { send: typeof rdsSend } }).rds = { send: rdsSend };
  (adapter as unknown as { ec2: { send: typeof ec2Send } }).ec2 = { send: ec2Send };
  const stsSend = vi.fn(async (command: unknown) => {
    if (command instanceof GetCallerIdentityCommand) return { Account: '123456789012' };
    throw new Error(`Unexpected STS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  });
  (adapter as unknown as { sts: { send: typeof stsSend } }).sts = { send: stsSend };
  return { adapter, rdsSend, ec2Send };
}

describe('RdsAdapter temporary database access', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds the caller IPv4 as a temporary /32 rule and revokes exactly that rule', async () => {
    const { adapter, ec2Send } = await connectedAdapter();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('203.0.113.42\n')));

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);

    expect(access).toEqual({
      connectionUrl: 'postgresql://hypervibe_admin:db-secret@production.example.rds.amazonaws.com:5432/app?sslmode=require',
      source: 'temporary_firewall',
      temporary: true,
      releaseToken: 'sgr-temporary',
    });
    const authorize = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof AuthorizeSecurityGroupIngressCommand) as AuthorizeSecurityGroupIngressCommand;
    expect(authorize.input).toMatchObject({
      GroupId: 'sg-database',
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        IpRanges: [{
          CidrIp: '203.0.113.42/32',
          Description: 'Hypervibe operation-scoped database query',
        }],
      }],
    });

    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);
    const revoke = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof RevokeSecurityGroupIngressCommand) as RevokeSecurityGroupIngressCommand;
    expect(revoke.input).toEqual({ GroupId: 'sg-database', SecurityGroupRuleIds: ['sgr-temporary'] });
  });

  it('adopts and later removes a stale Hypervibe rule from an interrupted process', async () => {
    const { adapter, ec2Send } = await connectedAdapter({
      rules: [{
        GroupId: 'sg-database',
        SecurityGroupRuleId: 'sgr-stale',
        IsEgress: false,
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        CidrIpv4: '203.0.113.42/32',
        Description: 'Hypervibe operation-scoped database query',
      }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('203.0.113.42\n')));

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);
    expect(access).toMatchObject({ source: 'temporary_firewall', temporary: true, releaseToken: 'sgr-stale' });
    expect(ec2Send.mock.calls.some(([command]) => command instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);

    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);
    const revoke = ec2Send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof RevokeSecurityGroupIngressCommand) as RevokeSecurityGroupIngressCommand;
    expect(revoke.input.SecurityGroupRuleIds).toEqual(['sgr-stale']);
  });

  it('preserves matching user-managed ingress instead of claiming it as temporary', async () => {
    const { adapter, ec2Send } = await connectedAdapter({
      rules: [{
        GroupId: 'sg-database',
        SecurityGroupRuleId: 'sgr-user',
        IsEgress: false,
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        CidrIpv4: '203.0.113.0/24',
        Description: 'Office network',
      }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('203.0.113.42\n')));

    const access = await adapter.acquireTemporaryDatabaseAccess(environment, component, 5432);
    expect(access).toMatchObject({ source: 'direct', temporary: false });
    await adapter.releaseTemporaryDatabaseAccess(environment, component, access);

    expect(ec2Send.mock.calls.some(([command]) => command instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof RevokeSecurityGroupIngressCommand)).toBe(false);
  });

  it('refuses to create implicit infrastructure for a private-only RDS instance', async () => {
    const { adapter, ec2Send } = await connectedAdapter({ publiclyAccessible: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.acquireTemporaryDatabaseAccess(environment, component, 5432))
      .rejects.toThrow('durable VPC/SSM network path');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ec2Send).not.toHaveBeenCalled();
  });
});

describe('RdsAdapter lifecycle reconciliation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function lifecycleAdapter(params: {
    rdsSend: (command: unknown) => Promise<unknown>;
    ec2Send?: (command: unknown) => Promise<unknown>;
  }) {
    const adapter = new RdsAdapter();
    await adapter.connect({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
      region: 'us-west-2',
      vpcId: 'vpc-1',
    });
    const rdsSend = vi.fn(params.rdsSend);
    const providerEc2Send = params.ec2Send ?? (async (command: unknown) => {
      throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
    });
    const ec2Send = vi.fn(async (command: unknown) => {
      const networkResponse = workloadNetworkResponse(command);
      if (networkResponse) return networkResponse;
      return providerEc2Send(command);
    });
    (adapter as unknown as { rds: { send: typeof rdsSend } }).rds = { send: rdsSend };
    (adapter as unknown as { ec2: { send: typeof ec2Send } }).ec2 = { send: ec2Send };
    const stsSend = vi.fn(async (command: unknown) => {
      if (command instanceof GetCallerIdentityCommand) return { Account: '123456789012' };
      throw new Error(`Unexpected STS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
    });
    (adapter as unknown as { sts: { send: typeof stsSend } }).sts = { send: stsSend };
    return { adapter, rdsSend, ec2Send };
  }

  it('inventories bounded RDS instances with account and region scope', async () => {
    const { adapter } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (!(command instanceof DescribeDBInstancesCommand)) throw new Error('Unexpected RDS command');
        return {
          DBInstances: [
            {
              DBInstanceIdentifier: 'customer-primary',
              DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:customer-primary',
              Engine: 'postgres',
              EngineVersion: '17.4',
              DBInstanceStatus: 'available',
              AvailabilityZone: 'us-west-2a',
            },
            {
              DBInstanceIdentifier: 'analytics',
              DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:analytics',
              Engine: 'postgres',
              DBInstanceStatus: 'stopped',
            },
          ],
        };
      },
    });

    const result = await adapter.inspectDatabaseResources({ resource: 'database', limit: 1 });

    expect(result).toMatchObject({
      observation: 'present',
      resource: 'database',
      databases: [{
        id: 'customer-primary',
        engine: 'postgres',
        providerScope: { accountId: '123456789012', region: 'us-west-2' },
      }],
      truncated: true,
      partial: false,
    });
  });

  it('turns out-of-band RDS ingress drift into unknown observation instead of a noop', async () => {
    const drifted = {
      ...managedSecurityGroup(component.externalId!),
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: 5432,
        ToPort: 5432,
        IpRanges: [{ CidrIp: '0.0.0.0/0' }],
      }],
    };
    const { adapter, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          return {
            DBInstances: [{
              DBInstanceIdentifier: component.externalId!,
              DBInstanceArn: `arn:aws:rds:${REGION}:${ACCOUNT_ID}:db:${component.externalId}`,
              DBInstanceStatus: 'available',
              VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-database' }],
            }],
          };
        }
        throw new Error('No mutation is allowed during RDS observation');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [drifted] };
        }
        throw new Error('No mutation is allowed during RDS observation');
      },
    });

    await expect(adapter.observeDatabase(environment, component))
      .rejects.toThrow('ingress is not limited to ECS workload security group');
    expect(ec2Send.mock.calls.some(([command]) => command instanceof AuthorizeSecurityGroupIngressCommand)).toBe(false);
  });

  it('propagates an observation failure instead of reporting the database absent', async () => {
    const { adapter } = await lifecycleAdapter({
      rdsSend: async () => {
        const error = new Error('AWS throttled the observation');
        Object.assign(error, { name: 'ThrottlingException' });
        throw error;
      },
    });

    await expect(adapter.observeDatabase(environment, component))
      .rejects.toThrow('AWS throttled the observation');
  });

  it('observes an adopted external id before considering a deterministic fallback name', async () => {
    const observedIdentifiers: Array<string | undefined> = [];
    const { adapter } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (!(command instanceof DescribeDBInstancesCommand)) throw new Error('Unexpected RDS command');
        observedIdentifiers.push(command.input.DBInstanceIdentifier);
        return {
          DBInstances: [{
          DBInstanceIdentifier: 'adopted-rds-id',
          DBInstanceArn: 'arn:aws:rds:us-west-2:123456789012:db:adopted-rds-id',
          DBInstanceStatus: 'available',
          VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-database' }],
          }],
        };
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [managedSecurityGroup('adopted-rds-id')] };
        }
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });
    const adopted = { ...component, externalId: 'adopted-rds-id' } as Component;

    const observed = await adapter.observeDatabase(environment, adopted, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(observedIdentifiers).toEqual(['adopted-rds-id']);
    expect(observed?.externalId).toBe('adopted-rds-id');
  });
});
