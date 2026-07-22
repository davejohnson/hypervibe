import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupRulesCommand,
  RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import type { Component } from '../../../../domain/entities/component.entity.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { RdsAdapter } from '../rds.adapter.js';

const now = new Date();
const environment = {
  id: 'env-1',
  projectId: 'project-1',
  name: 'production',
  platformBindings: {},
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
  },
  createdAt: now,
  updatedAt: now,
} as Component;

async function connectedAdapter(params?: { publiclyAccessible?: boolean; rules?: Array<Record<string, unknown>> }) {
  const adapter = new RdsAdapter();
  await adapter.connect({
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    region: 'us-west-2',
  });
  const instance = {
    DBInstanceIdentifier: component.externalId!,
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
