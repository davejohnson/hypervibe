import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
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
    const ec2Send = vi.fn(params.ec2Send ?? (async (command: unknown) => {
      throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
    }));
    (adapter as unknown as { rds: { send: typeof rdsSend } }).rds = { send: rdsSend };
    (adapter as unknown as { ec2: { send: typeof ec2Send } }).ec2 = { send: ec2Send };
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

  it('provisions with the provider resource identity instead of the logical database name', async () => {
    let describeCount = 0;
    const instance = {
      DBInstanceIdentifier: 'invoice-perfect-production-postgres',
      DBInstanceArn: 'arn:aws:rds:us-west-2:123:db:invoice-perfect-production-postgres',
      DBInstanceStatus: 'available',
      PubliclyAccessible: true,
      Endpoint: { Address: 'invoice-perfect.example.rds.amazonaws.com', Port: 5432 },
    };
    const { adapter, rdsSend } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof CreateDBInstanceCommand) return { DBInstance: instance };
        if (command instanceof DescribeDBInstancesCommand) {
          describeCount += 1;
          return { DBInstances: describeCount === 1 ? [] : [instance] };
        }
        throw new Error(`Unexpected RDS command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) {
          return { SecurityGroups: [{ GroupId: 'sg-existing' }] };
        }
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
      databaseName: 'invoice_perfect',
    });

    expect(result.receipt.success).toBe(true);
    expect(result.component.externalId).toBe('invoice-perfect-production-postgres');
    const create = rdsSend.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof CreateDBInstanceCommand) as CreateDBInstanceCommand;
    expect(create.input).toMatchObject({
      DBInstanceIdentifier: 'invoice-perfect-production-postgres',
      DBName: 'invoice_perfect',
      VpcSecurityGroupIds: ['sg-existing'],
    });
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

  it('does not tear down networking when failed provisioning leaves database existence unknown', async () => {
    let describeCount = 0;
    const { adapter, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof CreateDBInstanceCommand) return {};
        if (command instanceof DescribeDBInstancesCommand) {
          describeCount += 1;
          if (describeCount === 1) return { DBInstances: [] };
          const error = new Error('RDS observation unavailable');
          Object.assign(error, { name: 'ServiceUnavailable' });
          throw error;
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DescribeSecurityGroupsCommand) return { SecurityGroups: [] };
        if (command instanceof CreateSecurityGroupCommand) return { GroupId: 'sg-new' };
        throw new Error(`Unexpected EC2 command: ${(command as { constructor?: { name?: string } }).constructor?.name}`);
      },
    });

    const result = await adapter.provision('postgres', environment, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(result.receipt.success).toBe(false);
    expect(result.receipt.data).toMatchObject({
      resourceCreated: 'unknown',
      securityGroupId: 'sg-new',
      liveObservationError: 'RDS observation unavailable',
    });
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(false);
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
            DBInstanceStatus: 'available',
          }],
        };
      },
    });
    const adopted = { ...component, externalId: 'adopted-rds-id' } as Component;

    const observed = await adapter.observeDatabase(environment, adopted, {
      resourceName: 'invoice-perfect-production-postgres',
    });

    expect(observedIdentifiers).toEqual(['adopted-rds-id']);
    expect(observed?.externalId).toBe('adopted-rds-id');
  });

  it('waits for terminal absence before deleting its managed security group', async () => {
    vi.stubEnv('HYPERVIBE_RDS_READY_ATTEMPTS', '4');
    vi.stubEnv('HYPERVIBE_RDS_READY_DELAY_MS', '0');
    let describeCount = 0;
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DeleteDBInstanceCommand) return {};
        if (command instanceof DescribeDBInstancesCommand) {
          describeCount += 1;
          if (describeCount < 3) {
            return {
              DBInstances: [{
                DBInstanceIdentifier: component.externalId!,
                DBInstanceStatus: describeCount === 1 ? 'available' : 'deleting',
              }],
            };
          }
          return { DBInstances: [] };
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DeleteSecurityGroupCommand) return {};
        throw new Error('Unexpected EC2 command');
      },
    });
    const managed = {
      ...component,
      bindings: {
        ...component.bindings,
        securityGroupManagedByHypervibe: true,
      },
    } as Component;

    const result = await adapter.destroy(managed);

    expect(result.success).toBe(true);
    expect(describeCount).toBe(3);
    expect(rdsSend.mock.calls.some(([command]) => command instanceof DeleteDBInstanceCommand)).toBe(true);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(true);
  });

  it('treats an already-absent instance and security group as idempotent success', async () => {
    const { adapter, rdsSend, ec2Send } = await lifecycleAdapter({
      rdsSend: async (command) => {
        if (command instanceof DescribeDBInstancesCommand) {
          const error = new Error('DB instance not found');
          Object.assign(error, { name: 'DBInstanceNotFoundFault' });
          throw error;
        }
        throw new Error('Unexpected RDS command');
      },
      ec2Send: async (command) => {
        if (command instanceof DeleteSecurityGroupCommand) {
          const error = new Error('Security group not found');
          Object.assign(error, { name: 'InvalidGroup.NotFound' });
          throw error;
        }
        throw new Error('Unexpected EC2 command');
      },
    });
    const managed = {
      ...component,
      bindings: {
        ...component.bindings,
        securityGroupManagedByHypervibe: true,
      },
    } as Component;

    const result = await adapter.destroy(managed);

    expect(result.success).toBe(true);
    expect(result.message).toContain('already absent');
    expect(rdsSend.mock.calls.some(([command]) => command instanceof DeleteDBInstanceCommand)).toBe(false);
    expect(ec2Send.mock.calls.some(([command]) => command instanceof DeleteSecurityGroupCommand)).toBe(true);
  });
});
