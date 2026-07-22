import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  RDSClient,
  type DBInstance,
} from '@aws-sdk/client-rds';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RevokeSecurityGroupIngressCommand,
  type SecurityGroupRule,
} from '@aws-sdk/client-ec2';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type {
  DatabaseCapabilities,
  IDatabaseAdapter,
  ProvisionResult,
  ProvisionableType,
} from '../../../domain/ports/database.port.js';
import type { Receipt, TemporaryDatabaseAccess, VerifyResult } from '../../../domain/ports/provider.port.js';
import type { IObservableDatabase, ObservedDatabase } from '../../../domain/ports/observe.port.js';
import { providerRegistry } from '../../../domain/registry/provider.registry.js';
import { buildDatabaseEnvVarsFromComponent } from '../../../domain/services/database-env.js';

export const RdsCredentialsSchema = z.object({
  accessKeyId: z.string().min(1, 'Access key ID is required').describe('AWS IAM access key ID'),
  secretAccessKey: z.string().min(1, 'Secret access key is required').describe('AWS IAM secret access key'),
  sessionToken: z.string().optional().describe('Required when using temporary AWS STS credentials'),
  region: z.string().default('us-east-1').describe('AWS region containing the RDS instance'),
  vpcId: z.string().optional().describe('VPC for new RDS instances; defaults to the region default VPC'),
  dbSubnetGroupName: z.string().optional().describe('Existing DB subnet group for new RDS instances'),
});

export type RdsCredentials = z.infer<typeof RdsCredentialsSchema>;

type TemporaryIngress = {
  groupId: string;
  ruleId?: string;
  cidr: string;
  port: number;
};

const PUBLIC_IP_ENDPOINT = 'https://checkip.amazonaws.com/';
const TEMPORARY_INGRESS_DESCRIPTION = 'Hypervibe operation-scoped database query';
const DEFAULT_POLL_ATTEMPTS = 120;
const DEFAULT_POLL_DELAY_MS = 15_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeDatabaseUrl(params: {
  username: string;
  password: string;
  host: string;
  port: number;
  database: string;
}): string {
  const auth = `${encodeURIComponent(params.username)}:${encodeURIComponent(params.password)}`;
  return `postgresql://${auth}@${params.host}:${params.port}/${encodeURIComponent(params.database)}?sslmode=require`;
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function cidrContainsIpv4(cidr: string | undefined, address: string): boolean {
  if (!cidr) return false;
  const [networkText, prefixText] = cidr.split('/');
  const network = ipv4ToInt(networkText);
  const target = ipv4ToInt(address);
  const prefix = Number(prefixText);
  if (network === null || target === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (network & mask) === (target & mask);
}

function ruleAllows(rule: SecurityGroupRule, address: string, port: number): boolean {
  return rule.IsEgress !== true
    && rule.IpProtocol === 'tcp'
    && (rule.FromPort ?? -1) <= port
    && (rule.ToPort ?? -1) >= port
    && cidrContainsIpv4(rule.CidrIpv4, address);
}

function hypervibeTemporaryRule(
  rule: SecurityGroupRule,
  address: string,
  port: number
): TemporaryIngress | null {
  if (!ruleAllows(rule, address, port) || rule.Description !== TEMPORARY_INGRESS_DESCRIPTION) {
    return null;
  }
  if (!rule.GroupId || !rule.CidrIpv4) return null;
  return {
    groupId: rule.GroupId,
    ruleId: rule.SecurityGroupRuleId,
    cidr: rule.CidrIpv4,
    port,
  };
}

export class RdsAdapter implements IDatabaseAdapter, IObservableDatabase {
  readonly name = 'rds';

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: false,
    supportsReadReplicas: true,
    supportsPointInTimeRecovery: true,
    serverlessOptimized: false,
    supportsTemporaryDatabaseAccess: true,
    prefersTemporaryDatabaseAccess: true,
  };

  private credentials: RdsCredentials | null = null;
  private rds: RDSClient | null = null;
  private ec2: EC2Client | null = null;
  private temporaryIngress = new Map<string, TemporaryIngress>();

  async connect(credentials: unknown): Promise<void> {
    this.credentials = RdsCredentialsSchema.parse(credentials);
    const awsCredentials = {
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      ...(this.credentials.sessionToken ? { sessionToken: this.credentials.sessionToken } : {}),
    };
    this.rds = new RDSClient({ region: this.credentials.region, credentials: awsCredentials });
    this.ec2 = new EC2Client({ region: this.credentials.region, credentials: awsCredentials });
  }

  async verify(): Promise<VerifyResult> {
    if (!this.rds || !this.ec2 || !this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await Promise.all([
        this.rds.send(new DescribeDBInstancesCommand({ MaxRecords: 20 })),
        this.ec2.send(new DescribeVpcsCommand({ MaxResults: 5 })),
      ]);
      return { success: true, email: `AWS RDS (${this.credentials.region})` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async disconnect(): Promise<void> {
    for (const [token, ingress] of this.temporaryIngress) {
      await this.revokeIngress(ingress).catch(() => {});
      this.temporaryIngress.delete(token);
    }
    this.rds?.destroy();
    this.ec2?.destroy();
    this.rds = null;
    this.ec2 = null;
    this.credentials = null;
  }

  async provision(
    type: ProvisionableType,
    environment: Environment,
    options?: { size?: string; region?: string; databaseName?: string }
  ): Promise<ProvisionResult> {
    if (!this.rds || !this.ec2 || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (type !== 'postgres') {
      return this.failedProvision(environment, type, `Amazon RDS adapter supports postgres. Requested type: ${type}`);
    }

    const identifier = this.sanitizeIdentifier(`${environment.name}-postgres`);
    const database = this.sanitizeDatabaseName(options?.databaseName ?? 'app');
    const username = 'hypervibe_admin';
    const password = this.generatePassword();
    let securityGroupId: string | undefined;
    let securityGroupCreated = false;
    try {
      const securityGroup = await this.ensureSecurityGroup(identifier);
      securityGroupId = securityGroup.id;
      securityGroupCreated = securityGroup.created;
      await this.rds.send(new CreateDBInstanceCommand({
        DBInstanceIdentifier: identifier,
        DBInstanceClass: options?.size ?? 'db.t4g.micro',
        Engine: 'postgres',
        MasterUsername: username,
        MasterUserPassword: password,
        AllocatedStorage: 20,
        DBName: database,
        Port: 5432,
        PubliclyAccessible: true,
        StorageEncrypted: true,
        BackupRetentionPeriod: 7,
        MultiAZ: false,
        StorageType: 'gp3',
        VpcSecurityGroupIds: [securityGroupId],
        ...(this.credentials.dbSubnetGroupName ? { DBSubnetGroupName: this.credentials.dbSubnetGroupName } : {}),
        Tags: [
          { Key: 'Environment', Value: environment.name },
          { Key: 'ManagedBy', Value: 'Hypervibe' },
        ],
      }));

      const instance = await this.waitForInstance(identifier, 'available');
      if (!instance.Endpoint?.Address || !instance.Endpoint.Port) {
        throw new Error(`RDS instance ${identifier} became available without an endpoint.`);
      }
      const connectionUrl = encodeDatabaseUrl({
        username,
        password,
        host: instance.Endpoint.Address,
        port: instance.Endpoint.Port,
        database,
      });
      const component: Component = {
        id: '',
        environmentId: environment.id,
        type: 'postgres',
        bindings: {
          provider: 'rds',
          instanceId: identifier,
          instanceArn: instance.DBInstanceArn,
          connectionString: connectionUrl,
          host: instance.Endpoint.Address,
          port: instance.Endpoint.Port,
          username,
          password,
          database,
          securityGroupId,
          securityGroupManagedByHypervibe: securityGroupCreated,
          publiclyAccessible: instance.PubliclyAccessible === true,
        },
        externalId: identifier,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return {
        component,
        connectionUrl,
        envVars: buildDatabaseEnvVarsFromComponent(component).envVars,
        receipt: {
          success: true,
          message: `Created and verified Amazon RDS PostgreSQL instance ${identifier}`,
          data: { instanceId: identifier, status: instance.DBInstanceStatus, securityGroupId },
        },
      };
    } catch (error) {
      const live = await this.describeInstance(identifier).catch(() => null);
      if (!live && securityGroupCreated && securityGroupId) {
        await this.ec2.send(new DeleteSecurityGroupCommand({ GroupId: securityGroupId })).catch(() => {});
      }
      return this.failedProvision(
        environment,
        type,
        `Failed to provision Amazon RDS PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
        { instanceId: identifier, resourceCreated: Boolean(live), securityGroupId }
      );
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.rds || !component.externalId) return null;
    const bindings = component.bindings as Record<string, unknown>;
    const instance = await this.describeInstance(component.externalId).catch(() => null);
    if (!instance?.Endpoint?.Address || !instance.Endpoint.Port) return null;
    const username = typeof bindings.username === 'string' ? bindings.username : undefined;
    const password = typeof bindings.password === 'string' ? bindings.password : undefined;
    const database = typeof bindings.database === 'string' ? bindings.database : undefined;
    if (!username || !password || !database) return null;
    return encodeDatabaseUrl({
      username,
      password,
      database,
      host: instance.Endpoint.Address,
      port: instance.Endpoint.Port,
    });
  }

  async acquireTemporaryDatabaseAccess(
    _environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    if (!this.rds || !this.ec2 || !component.externalId) {
      throw new Error('Amazon RDS access requires a connected adapter and a tracked DB instance.');
    }
    const instance = await this.describeInstance(component.externalId);
    if (!instance?.Endpoint?.Address || !instance.Endpoint.Port) {
      throw new Error(`Amazon RDS instance ${component.externalId} has no available endpoint.`);
    }
    if (instance.PubliclyAccessible !== true) {
      throw new Error('The Amazon RDS instance is private. Configure a durable VPC/SSM network path in desired state or pass a reachable connectionName; hv_db_query will not create a billable proxy or bastion implicitly.');
    }
    const port = instance.Endpoint.Port || applicationPort;
    const groupId = this.securityGroupId(component, instance);
    if (!groupId) {
      throw new Error('Amazon RDS instance has no VPC security group available for operation-scoped access.');
    }
    const address = await this.resolvePublicIpv4();
    const cidr = `${address}/32`;
    const rules = await this.ec2.send(new DescribeSecurityGroupRulesCommand({
      Filters: [{ Name: 'group-id', Values: [groupId] }],
    }));
    const connectionUrl = await this.getConnectionUrl(component);
    if (!connectionUrl) {
      throw new Error('Amazon RDS bindings are missing database credentials.');
    }
    const staleTemporaryRule = (rules.SecurityGroupRules ?? [])
      .map((rule) => hypervibeTemporaryRule(rule, address, port))
      .find((rule): rule is TemporaryIngress => Boolean(rule));
    if (staleTemporaryRule) {
      const releaseToken = staleTemporaryRule.ruleId ?? randomUUID();
      this.temporaryIngress.set(releaseToken, staleTemporaryRule);
      return {
        connectionUrl,
        source: 'temporary_firewall',
        temporary: true,
        releaseToken,
      };
    }
    if ((rules.SecurityGroupRules ?? []).some((rule) => ruleAllows(rule, address, port))) {
      return { connectionUrl, source: 'direct', temporary: false };
    }

    const authorized = await this.ec2.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [{
        IpProtocol: 'tcp',
        FromPort: port,
        ToPort: port,
        IpRanges: [{ CidrIp: cidr, Description: TEMPORARY_INGRESS_DESCRIPTION }],
      }],
    }));
    const ruleId = authorized.SecurityGroupRules?.[0]?.SecurityGroupRuleId;
    const releaseToken = ruleId ?? randomUUID();
    this.temporaryIngress.set(releaseToken, { groupId, ruleId, cidr, port });
    return {
      connectionUrl,
      source: 'temporary_firewall',
      temporary: true,
      releaseToken,
    };
  }

  async releaseTemporaryDatabaseAccess(
    _environment: Environment,
    _component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void> {
    if (!access.temporary) return;
    if (!access.releaseToken) throw new Error('Temporary Amazon RDS access is missing its cleanup token.');
    const ingress = this.temporaryIngress.get(access.releaseToken);
    if (!ingress) return;
    await this.revokeIngress(ingress);
    this.temporaryIngress.delete(access.releaseToken);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.rds || !this.ec2 || !component.externalId) {
      return { success: false, message: 'Amazon RDS adapter is not connected or the component has no instance ID' };
    }
    try {
      await this.rds.send(new DeleteDBInstanceCommand({
        DBInstanceIdentifier: component.externalId,
        SkipFinalSnapshot: true,
        DeleteAutomatedBackups: true,
      }));
      await this.waitForInstance(component.externalId, 'deleted');
      const bindings = component.bindings as Record<string, unknown>;
      const groupId = typeof bindings.securityGroupId === 'string' ? bindings.securityGroupId : undefined;
      if (groupId && bindings.securityGroupManagedByHypervibe === true) {
        await this.ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
      }
      return { success: true, message: `Deleted Amazon RDS instance ${component.externalId}` };
    } catch (error) {
      return {
        success: false,
        message: `Failed to delete Amazon RDS instance ${component.externalId}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!component.externalId) return { status: 'unknown' };
    const instance = await this.describeInstance(component.externalId).catch(() => null);
    if (!instance) return { status: 'unknown', message: 'Instance not found' };
    return { status: this.normalizedStatus(instance.DBInstanceStatus), message: instance.DBInstanceStatus };
  }

  async observeDatabase(environment: Environment): Promise<ObservedDatabase | null> {
    const identifier = this.sanitizeIdentifier(`${environment.name}-postgres`);
    const instance = await this.describeInstance(identifier).catch(() => null);
    if (!instance) return null;
    return {
      provider: 'rds',
      engine: 'postgres',
      externalId: instance.DBInstanceIdentifier ?? identifier,
      name: instance.DBInstanceIdentifier ?? identifier,
      status: this.normalizedStatus(instance.DBInstanceStatus),
    };
  }

  private async ensureSecurityGroup(identifier: string): Promise<{ id: string; created: boolean }> {
    if (!this.ec2 || !this.credentials) throw new Error('Amazon EC2 adapter is not connected.');
    const vpcId = this.credentials.vpcId ?? await this.defaultVpcId();
    const groupName = this.sanitizeIdentifier(`${identifier}-hypervibe-db`);
    const existing = await this.ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [groupName] },
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'tag:ManagedBy', Values: ['Hypervibe'] },
      ],
    }));
    const existingId = existing.SecurityGroups?.[0]?.GroupId;
    if (existingId) return { id: existingId, created: false };
    const created = await this.ec2.send(new CreateSecurityGroupCommand({
      GroupName: groupName,
      Description: `Operation-scoped PostgreSQL access for ${identifier}`,
      VpcId: vpcId,
      TagSpecifications: [{
        ResourceType: 'security-group',
        Tags: [{ Key: 'ManagedBy', Value: 'Hypervibe' }, { Key: 'Database', Value: identifier }],
      }],
    }));
    if (!created.GroupId) throw new Error('AWS did not return an ID for the RDS security group.');
    return { id: created.GroupId, created: true };
  }

  private async defaultVpcId(): Promise<string> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    const response = await this.ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }],
    }));
    const vpcId = response.Vpcs?.[0]?.VpcId;
    if (!vpcId) {
      throw new Error('No default VPC exists in this region. Set vpcId and dbSubnetGroupName in the rds connection credentials.');
    }
    return vpcId;
  }

  private async describeInstance(identifier: string): Promise<DBInstance | null> {
    if (!this.rds) throw new Error('Amazon RDS adapter is not connected.');
    try {
      const response = await this.rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
      return response.DBInstances?.[0] ?? null;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'DBInstanceNotFound' || name === 'DBInstanceNotFoundFault') return null;
      throw error;
    }
  }

  private async waitForInstance(identifier: string, target: 'available' | 'deleted'): Promise<DBInstance> {
    const attempts = Number(process.env.HYPERVIBE_RDS_READY_ATTEMPTS ?? DEFAULT_POLL_ATTEMPTS);
    const delayMs = Number(process.env.HYPERVIBE_RDS_READY_DELAY_MS ?? DEFAULT_POLL_DELAY_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const instance = await this.describeInstance(identifier);
      if (target === 'deleted' && !instance) return { DBInstanceIdentifier: identifier };
      if (target === 'available' && instance?.DBInstanceStatus === 'available') return instance;
      if (instance && /failed|incompatible|storage-full|restore-error/i.test(instance.DBInstanceStatus ?? '')) {
        throw new Error(`RDS instance ${identifier} entered terminal status ${instance.DBInstanceStatus}.`);
      }
      if (attempt < attempts - 1) await delay(delayMs);
    }
    throw new Error(`RDS instance ${identifier} did not become ${target} before timeout.`);
  }

  private securityGroupId(component: Component, instance: DBInstance): string | undefined {
    const bindings = component.bindings as Record<string, unknown>;
    return typeof bindings.securityGroupId === 'string'
      ? bindings.securityGroupId
      : instance.VpcSecurityGroups?.[0]?.VpcSecurityGroupId;
  }

  private async resolvePublicIpv4(): Promise<string> {
    const response = await fetch(PUBLIC_IP_ENDPOINT, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Could not determine the Hypervibe caller IP: ${response.status}.`);
    const address = (await response.text()).trim();
    if (ipv4ToInt(address) === null) throw new Error('AWS public-IP lookup did not return a valid IPv4 address.');
    return address;
  }

  private async revokeIngress(ingress: TemporaryIngress): Promise<void> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    await this.ec2.send(new RevokeSecurityGroupIngressCommand({
      GroupId: ingress.groupId,
      ...(ingress.ruleId
        ? { SecurityGroupRuleIds: [ingress.ruleId] }
        : {
          IpPermissions: [{
            IpProtocol: 'tcp',
            FromPort: ingress.port,
            ToPort: ingress.port,
            IpRanges: [{ CidrIp: ingress.cidr }],
          }],
        }),
    }));
  }

  private normalizedStatus(status?: string): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    if (!status) return 'unknown';
    if (['available', 'backing-up', 'maintenance', 'storage-optimization'].includes(status)) return 'running';
    if (['stopped', 'stopping', 'deleting'].includes(status)) return 'stopped';
    if (/failed|incompatible|storage-full|restore-error/.test(status)) return 'error';
    return 'provisioning';
  }

  private failedProvision(
    environment: Environment,
    type: ProvisionableType,
    error: string,
    data?: Record<string, unknown>
  ): ProvisionResult {
    return {
      component: {
        id: '', environmentId: environment.id, type, bindings: {}, externalId: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
      receipt: { success: false, message: 'Failed to provision Amazon RDS instance', error, data },
    };
  }

  private sanitizeIdentifier(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
  }

  private sanitizeDatabaseName(value: string): string {
    const normalized = value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
    return normalized.slice(0, 63) || 'app';
  }

  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&*+-=?';
    let password = '';
    for (let index = 0; index < 32; index += 1) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}

providerRegistry.register({
  metadata: {
    name: 'rds',
    displayName: 'Amazon RDS',
    category: 'database',
    credentialsSchema: RdsCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
  },
  factory: (credentials) => {
    const adapter = new RdsAdapter();
    adapter.connect(credentials);
    return adapter;
  },
});
