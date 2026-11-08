import { createPostgresCredentialLifecycle } from '../database/database-credential.js';
import { AwsSecretsAdapter } from '../secretmanagers/aws-secrets.adapter.js';
import { environmentResourceName } from '../../../domain/services/resource-names.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  ModifyDBInstanceCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
  RDSClient,
  type DBInstance,
} from '@aws-sdk/client-rds';
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RevokeSecurityGroupIngressCommand,
  type SecurityGroup,
  type SecurityGroupRule,
  type Subnet,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { Component } from '../../../domain/entities/component.entity.js';
import type {
  DatabaseCapabilities,
  DatabaseTargetOptions,
  IDatabaseOperations,
} from '../../../domain/ports/database.port.js';
import type { TemporaryDatabaseAccess, VerifyResult } from '../../../domain/ports/provider.port.js';
import type { IObservableDatabase, ObservedDatabase } from '../../../domain/ports/observe.port.js';
import {
  providerRegistry,
  standardDatabaseRuntimeProjection,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import {
  type AwsWorkloadNetwork,
  hasWorkloadSecurityGroupTags,
  parseAwsWorkloadNetworkBinding,
  parseEcsClusterArn,
  workloadNetworksMatch,
  workloadSecurityGroupName,
} from './aws-workload-network.js';

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
const DATABASE_PORT = 5432;


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

export class RdsAdapter implements IDatabaseOperations, IObservableDatabase {
  readonly name = 'rds';

  readonly credentialLifecycle = createPostgresCredentialLifecycle(() => this, {
    identity: async component => {
      const instance = component.externalId ? await this.describeInstance(component.externalId) : null;
      if (!instance) throw new Error('The bound RDS instance is absent or unknown.');
      const arn = instance.MasterUsername === component.bindings.username ? instance.MasterUserSecret?.SecretArn : undefined;
      if (!arn) return { inputMode: 'supplied' };
      const scope = component.bindings.providerScope as Record<string, unknown>;
      if (!/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[^\s]+$/.test(arn)
        || arn.split(':')[3] !== scope.region || arn.split(':')[4] !== scope.accountId) throw new Error('RDS master secret belongs to a different account or region.');
      return { inputMode: 'provider-generated', providerScope: { masterUserSecretArn: arn } };
    },
    readCurrent: async (_component, target) => {
      if (target.inputMode !== 'provider-generated') return null;
      if (!this.credentials || !target.providerScope.masterUserSecretArn) throw new Error('The bound RDS master secret is unavailable.');
      const secrets = new AwsSecretsAdapter();
      await secrets.connect({ accessKeyId: this.credentials.accessKeyId, secretAccessKey: this.credentials.secretAccessKey, sessionToken: this.credentials.sessionToken, region: this.credentials.region });
      const value = await secrets.readCredentialJson(target.providerScope.masterUserSecretArn);
      if (value.username !== target.username || typeof value.password !== 'string' || !value.password) throw new Error('RDS master secret returned a different database user.');
      return value.password;
    },
    rotate: async (_component, target, replacement) => {
      if (!this.rds) return { state: 'blocked' };
      const instance = await this.describeInstance(target.externalId);
      if (!instance) return { state: 'blocked' };
      if (instance.MasterUsername !== target.username) return undefined;
      // ApplyImmediately also applies unrelated pending modifications. A scoped
      // password plan has no authority to apply those changes.
      if (Object.values(instance.PendingModifiedValues ?? {}).some(value => value !== undefined && (!Array.isArray(value) || value.length > 0))) return { state: 'blocked' };
      if (target.inputMode === 'provider-generated') {
        if (!this.credentials || instance.MasterUserSecret?.SecretArn !== target.providerScope.masterUserSecretArn) return { state: 'blocked' };
        // A generated reset is not idempotent. Disable SDK transport retries;
        // the encrypted plan recovers from the exact existing secret instead.
        const resetClient = new RDSClient({ region: this.credentials.region, credentials: { accessKeyId: this.credentials.accessKeyId, secretAccessKey: this.credentials.secretAccessKey, ...(this.credentials.sessionToken ? { sessionToken: this.credentials.sessionToken } : {}) }, maxAttempts: 1 });
        try {
          const response = await resetClient.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: target.externalId, RotateMasterUserPassword: true, ApplyImmediately: true }));
          return { state: response.DBInstance?.DBInstanceIdentifier === target.externalId ? 'acknowledged' : 'unknown' };
        } finally { resetClient.destroy(); }
      }
      if (instance.MasterUserSecret || !replacement) return { state: 'blocked' };
      const response = await this.rds.send(new ModifyDBInstanceCommand({
        DBInstanceIdentifier: target.externalId, MasterUserPassword: replacement, ApplyImmediately: true,
      }));
      return { state: response.DBInstance?.DBInstanceIdentifier === target.externalId ? 'acknowledged' : 'unknown' };
    },
  });

  readonly capabilities: DatabaseCapabilities = {
    supportedDatabases: ['postgres'],
    supportsPooling: false,
    supportsReadReplicas: false,
    supportsPointInTimeRecovery: false,
    serverlessOptimized: false,
    supportsTemporaryDatabaseAccess: true,
    prefersTemporaryDatabaseAccess: true,
  };

  private credentials: RdsCredentials | null = null;
  private rds: RDSClient | null = null;
  private ec2: EC2Client | null = null;
  private sts: STSClient | null = null;
  private accountId: string | null = null;
  private temporaryIngress = new Map<string, TemporaryIngress>();

  async connect(credentials: unknown): Promise<void> {
    this.credentials = RdsCredentialsSchema.parse(credentials);
    this.replaceClients();
  }

  configureTarget(target: DatabaseTargetOptions): void {
    if (!target.region) return;
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    const region = z.string().trim().regex(
      /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/,
      'AWS region is invalid'
    ).parse(target.region);
    if (region === this.credentials.region) return;
    this.credentials = { ...this.credentials, region };
    this.replaceClients();
  }

  private replaceClients(): void {
    if (!this.credentials) throw new Error('Not connected. Call connect() first.');
    this.rds?.destroy();
    this.ec2?.destroy();
    this.sts?.destroy();
    const awsCredentials = {
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      ...(this.credentials.sessionToken ? { sessionToken: this.credentials.sessionToken } : {}),
    };
    this.rds = new RDSClient({ region: this.credentials.region, credentials: awsCredentials });
    this.ec2 = new EC2Client({ region: this.credentials.region, credentials: awsCredentials });
    this.sts = new STSClient({ region: this.credentials.region, credentials: awsCredentials });
    this.accountId = null;
  }

  async verify(): Promise<VerifyResult> {
    if (!this.rds || !this.ec2 || !this.sts || !this.credentials) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      const [, , accountId] = await Promise.all([
        this.rds.send(new DescribeDBInstancesCommand({ MaxRecords: 20 })),
        this.ec2.send(new DescribeVpcsCommand({ MaxResults: 5 })),
        this.resolveAccountId(),
      ]);
      return { success: true, email: `AWS account ${accountId} RDS (${this.credentials.region})` };
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
    this.sts?.destroy();
    this.rds = null;
    this.ec2 = null;
    this.sts = null;
    this.credentials = null;
    this.accountId = null;
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    if (!this.rds || !component.externalId) return null;
    await this.assertComponentScope(component);
    const bindings = component.bindings as Record<string, unknown>;
    const instance = await this.describeInstance(component.externalId);
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
    environment: Environment,
    component: Component,
    applicationPort: number
  ): Promise<TemporaryDatabaseAccess> {
    if (!this.rds || !this.ec2 || !component.externalId) {
      throw new Error('Amazon RDS access requires a connected adapter and a tracked DB instance.');
    }
    await this.assertComponentScope(component);
    const instance = await this.describeInstance(component.externalId);
    if (!instance?.Endpoint?.Address || !instance.Endpoint.Port) {
      throw new Error(`Amazon RDS instance ${component.externalId} has no available endpoint.`);
    }
    if (instance.PubliclyAccessible !== true) {
      throw new Error('The Amazon RDS instance is private. Configure a durable VPC/SSM network path in desired state or pass a reachable connectionName; hv_db_query will not create a billable proxy or bastion implicitly.');
    }
    const network = await this.resolveWorkloadNetwork(environment);
    const port = instance.Endpoint.Port || applicationPort;
    const groupId = this.securityGroupId(component, instance);
    if (!groupId) {
      throw new Error('Amazon RDS instance has no VPC security group available for operation-scoped access.');
    }
    await this.assertInstanceNetwork(instance, component.externalId, groupId, network);
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
    component: Component,
    access: TemporaryDatabaseAccess
  ): Promise<void> {
    if (!access.temporary) return;
    await this.assertComponentScope(component);
    if (!access.releaseToken) throw new Error('Temporary Amazon RDS access is missing its cleanup token.');
    const ingress = this.temporaryIngress.get(access.releaseToken);
    if (!ingress) return;
    await this.revokeIngress(ingress);
    this.temporaryIngress.delete(access.releaseToken);
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!component.externalId) return { status: 'unknown' };
    let instance: DBInstance | null;
    try {
      await this.assertComponentScope(component);
      instance = await this.describeInstance(component.externalId);
    } catch (error) {
      return {
        status: 'unknown',
        message: `Failed to observe instance: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!instance) return { status: 'unknown', message: 'Instance not found' };
    return { status: this.normalizedStatus(instance.DBInstanceStatus), message: instance.DBInstanceStatus };
  }

  async observeDatabase(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedDatabase | null> {
    if (component) await this.assertComponentScope(component);
    const identifier = component?.externalId
      ?? this.sanitizeIdentifier(options?.resourceName || environmentResourceName('postgres', environment));
    const instance = await this.describeInstance(identifier);
    if (!instance) return null;
    if (component) {
      const network = await this.resolveWorkloadNetwork(environment);
      const bindings = component.bindings as Record<string, unknown>;
      const securityGroupId = typeof bindings.securityGroupId === 'string'
        ? bindings.securityGroupId
        : undefined;
      await this.assertInstanceNetwork(instance, identifier, securityGroupId, network);
    }
    return {
      provider: 'rds',
      engine: 'postgres',
      externalId: instance.DBInstanceIdentifier ?? identifier,
      providerScope: this.instanceScope(instance),
      name: instance.DBInstanceIdentifier ?? identifier,
      status: this.normalizedStatus(instance.DBInstanceStatus),
    };
  }

  async inspectDatabaseResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    if (!this.rds || !this.credentials) {
      throw new Error('Not connected. Call connect() first.');
    }
    const selected = request.id ?? request.name;
    let instances: DBInstance[];
    let truncated = false;
    if (selected) {
      const instance = await this.describeInstance(selected);
      instances = instance ? [instance] : [];
    } else {
      const response = await this.rds.send(new DescribeDBInstancesCommand({
        MaxRecords: Math.max(20, Math.min(request.limit, 100)),
      }));
      instances = response.DBInstances ?? [];
      truncated = Boolean(response.Marker) || instances.length > request.limit;
    }
    const databases = instances.slice(0, request.limit).map((instance) => ({
      id: instance.DBInstanceIdentifier,
      name: instance.DBInstanceIdentifier,
      engine: instance.Engine === 'postgres' ? 'postgres' : instance.Engine ?? 'unknown',
      ...(instance.EngineVersion ? { databaseVersion: instance.EngineVersion } : {}),
      status: this.normalizedStatus(instance.DBInstanceStatus),
      ...(instance.AvailabilityZone ? { availabilityZone: instance.AvailabilityZone } : {}),
      providerScope: this.instanceScope(instance),
    }));
    return {
      observation: instances.length > 0 ? 'present' : 'absent',
      resource: 'database',
      databases,
      ...(instances.length === 0 && selected
        ? { [request.id ? 'id' : 'name']: selected }
        : {}),
      truncated,
      partial: false,
    };
  }

  private instanceScope(instance: DBInstance): Record<string, string> {
    const arn = instance.DBInstanceArn?.split(':');
    const region = arn?.[3];
    const accountId = arn?.[4];
    if (!region || !accountId) {
      throw new Error(
        `Amazon RDS instance ${instance.DBInstanceIdentifier ?? 'without an identifier'} returned no durable account/region scope.`
      );
    }
    return { accountId, region };
  }

  private async assertComponentScope(component: Component): Promise<void> {
    if (!this.credentials) throw new Error('Amazon RDS adapter is not connected.');
    const bindings = component.bindings as Record<string, unknown>;
    const rawScope = bindings.providerScope;
    const scope = rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)
      ? rawScope as Record<string, unknown>
      : null;
    const accountId = typeof scope?.accountId === 'string' ? scope.accountId : undefined;
    const region = typeof scope?.region === 'string' ? scope.region : undefined;
    if (!accountId || !region) {
      throw new Error(
        `Amazon RDS binding ${component.externalId ?? component.id} is missing its durable accountId/region provider scope; re-import or re-plan the database before using it.`
      );
    }
    this.configureTarget({ region });
    if (region !== this.credentials.region) {
      throw new Error(
        `Amazon RDS binding scope region ${region} does not match connected region ${this.credentials.region}.`
      );
    }
    const connectedAccountId = await this.resolveAccountId();
    if (accountId !== connectedAccountId) {
      throw new Error(
        `Amazon RDS binding scope account ${accountId} does not match connected account ${connectedAccountId}.`
      );
    }
  }

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    if (!this.sts) throw new Error('Amazon STS adapter is not connected.');
    const identity = await this.sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account || !/^\d{12}$/.test(identity.Account)) {
      throw new Error('AWS did not return a valid account identity for the RDS connection.');
    }
    this.accountId = identity.Account;
    return this.accountId;
  }

  private configureForEcsEnvironment(
    environment: Environment,
    requestedRegion?: string
  ): { projectId: string; accountId: string; region: string; clusterName: string } {
    const hosting = parseHostingBindings(environment);
    if (hosting.provider !== 'ecs' || !hosting.projectId) {
      throw new Error('Amazon RDS requires this environment to be bound to AWS ECS Express.');
    }
    const cluster = parseEcsClusterArn(hosting.projectId);
    if (requestedRegion && requestedRegion !== cluster.region) {
      throw new Error(
        `Amazon RDS region ${requestedRegion} must match the bound ECS workload region ${cluster.region}.`
      );
    }
    this.configureTarget({ region: cluster.region });
    return { projectId: hosting.projectId, ...cluster };
  }

  private async resolveWorkloadNetwork(
    environment: Environment,
    requestedRegion?: string
  ): Promise<AwsWorkloadNetwork> {
    if (!this.credentials || !this.ec2 || !this.rds) {
      throw new Error('Not connected. Call connect() first.');
    }
    const cluster = this.configureForEcsEnvironment(environment, requestedRegion);

    const accountId = await this.resolveAccountId();
    if (cluster.accountId !== accountId) {
      throw new Error(
        `Bound ECS cluster ${cluster.projectId} is outside the connected AWS account ${accountId}.`
      );
    }
    const persisted = parseAwsWorkloadNetworkBinding(environment);
    if (!persisted) {
      throw new Error(
        'The ECS project has no reviewed AWS workload-network binding. Apply the ECS project action before provisioning RDS.'
      );
    }
    if (persisted.accountId !== accountId || persisted.region !== cluster.region) {
      throw new Error(
        'The persisted AWS workload-network binding is outside the connected account or bound ECS region.'
      );
    }

    const vpcs = await this.ec2.send(new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }],
    }));
    if (!Array.isArray(vpcs.Vpcs)) {
      throw new Error('AWS default-VPC observation returned an invalid VPC list.');
    }
    if (vpcs.Vpcs.length !== 1 || !vpcs.Vpcs[0]?.VpcId || vpcs.Vpcs[0].IsDefault !== true) {
      throw new Error('AWS did not return exactly one complete default VPC for the bound ECS region.');
    }
    const vpcId = vpcs.Vpcs[0].VpcId;
    if (persisted.vpcId !== vpcId) {
      throw new Error(
        `Persisted AWS workload VPC ${persisted.vpcId} is not the exact default VPC ${vpcId}.`
      );
    }
    if (this.credentials.vpcId && this.credentials.vpcId !== vpcId) {
      throw new Error(
        `Legacy RDS connection VPC ${this.credentials.vpcId} does not match the reviewed ECS workload VPC ${vpcId}.`
      );
    }
    if (this.credentials.dbSubnetGroupName) {
      const subnetGroups = await this.rds.send(new DescribeDBSubnetGroupsCommand({
        DBSubnetGroupName: this.credentials.dbSubnetGroupName,
      }));
      const groups = subnetGroups.DBSubnetGroups;
      if (!Array.isArray(groups) || groups.length !== 1) {
        throw new Error(
          `AWS did not return exactly one RDS subnet group named ${this.credentials.dbSubnetGroupName}.`
        );
      }
      const subnetGroup = groups[0]!;
      if (subnetGroup.DBSubnetGroupName !== this.credentials.dbSubnetGroupName
        || subnetGroup.VpcId !== vpcId) {
        throw new Error(
          `RDS subnet group ${this.credentials.dbSubnetGroupName} is outside the reviewed ECS workload VPC ${vpcId}.`
        );
      }
    }

    const subnetIds = await this.defaultVpcSubnetIds(vpcId);
    const workloadGroup = await this.securityGroupById(persisted.workloadSecurityGroupId);
    if (!workloadGroup) {
      throw new Error(
        `Bound AWS workload security group ${persisted.workloadSecurityGroupId} is absent; RDS will not create or select a replacement.`
      );
    }
    if (workloadGroup.GroupName !== workloadSecurityGroupName(cluster.clusterName)
      || workloadGroup.VpcId !== vpcId
      || !hasWorkloadSecurityGroupTags(workloadGroup.Tags, cluster.projectId, environment.id)) {
      throw new Error(
        `AWS workload security group ${persisted.workloadSecurityGroupId} is outside the reviewed ECS project identity.`
      );
    }
    const observed: AwsWorkloadNetwork = {
      accountId,
      region: cluster.region,
      vpcId,
      subnetIds,
      workloadSecurityGroupId: persisted.workloadSecurityGroupId,
    };
    if (!workloadNetworksMatch(persisted, observed)) {
      throw new Error(
        'The AWS workload-network identity changed after ECS project reconciliation; re-run hv_plan before provisioning RDS.'
      );
    }
    return observed;
  }

  private async defaultVpcSubnetIds(vpcId: string): Promise<string[]> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    const output = await this.ec2.send(new DescribeSubnetsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'default-for-az', Values: ['true'] },
      ],
    }));
    if (!Array.isArray(output.Subnets)) {
      throw new Error(`AWS returned an invalid default-subnet list for VPC ${vpcId}.`);
    }
    const zones = new Set<string>();
    const subnetIds = output.Subnets.map((subnet: Subnet) => {
      if (!subnet.SubnetId
        || subnet.VpcId !== vpcId
        || subnet.DefaultForAz !== true
        || !subnet.AvailabilityZone) {
        throw new Error(`AWS returned an incomplete or cross-VPC default subnet for ${vpcId}.`);
      }
      zones.add(subnet.AvailabilityZone);
      return subnet.SubnetId;
    });
    if (new Set(subnetIds).size !== subnetIds.length) {
      throw new Error(`AWS returned duplicate default-subnet identities for VPC ${vpcId}.`);
    }
    if (subnetIds.length < 2 || zones.size < 2) {
      throw new Error(
        `Amazon RDS requires default subnets in at least two availability zones of VPC ${vpcId}.`
      );
    }
    return subnetIds.sort();
  }

  private assertRuntimeIngress(
    group: SecurityGroup,
    network: AwsWorkloadNetwork
  ): void {
    if (!Array.isArray(group.IpPermissions) || group.IpPermissions.length !== 1) {
      throw new Error(
        `RDS security group ${group.GroupId ?? 'without an ID'} does not have exactly one ECS-workload ingress rule.`
      );
    }
    const permission = group.IpPermissions[0]!;
    const pairs = permission.UserIdGroupPairs ?? [];
    if (permission.IpProtocol !== 'tcp'
      || permission.FromPort !== DATABASE_PORT
      || permission.ToPort !== DATABASE_PORT
      || pairs.length !== 1
      || pairs[0]?.GroupId !== network.workloadSecurityGroupId
      || (permission.IpRanges?.length ?? 0) > 0
      || (permission.Ipv6Ranges?.length ?? 0) > 0
      || (permission.PrefixListIds?.length ?? 0) > 0) {
      throw new Error(
        `RDS security group ${group.GroupId ?? 'without an ID'} ingress is not limited to ECS workload security group ${network.workloadSecurityGroupId} on port ${DATABASE_PORT}.`
      );
    }
  }

  private async assertInstanceNetwork(
    instance: DBInstance,
    identifier: string,
    securityGroupId: string | undefined,
    network: AwsWorkloadNetwork
  ): Promise<void> {
    if (!securityGroupId) {
      throw new Error(`RDS instance ${identifier} is missing its reviewed database security-group identity.`);
    }
    const attached = (instance.VpcSecurityGroups ?? [])
      .map((item) => item.VpcSecurityGroupId)
      .filter((value): value is string => Boolean(value));
    if (attached.length !== 1 || attached[0] !== securityGroupId) {
      throw new Error(
        `RDS instance ${identifier} is not attached exclusively to reviewed security group ${securityGroupId}.`
      );
    }
    const group = await this.securityGroupById(securityGroupId);
    if (!group) {
      throw new Error(`RDS security group ${securityGroupId} is absent.`);
    }
    this.assertManagedSecurityGroup(group, identifier, network.vpcId);
    this.assertRuntimeIngress(group, network);
  }

  private async securityGroupById(groupId: string): Promise<SecurityGroup | null> {
    if (!this.ec2) throw new Error('Amazon EC2 adapter is not connected.');
    try {
      const output = await this.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
      if (!Array.isArray(output.SecurityGroups)) {
        throw new Error(`AWS returned an invalid exact security-group collection for ${groupId}.`);
      }
      if (output.SecurityGroups.length !== 1) {
        throw new Error(`AWS returned no exact security group and no InvalidGroup.NotFound response for ${groupId}.`);
      }
      const group = output.SecurityGroups[0]!;
      if (group.GroupId !== groupId) {
        throw new Error(`AWS returned security group ${group.GroupId ?? 'without an ID'} when ${groupId} was requested.`);
      }
      return group;
    } catch (error) {
      if (this.hasErrorName(error, 'InvalidGroup.NotFound')) return null;
      throw error;
    }
  }

  private assertManagedSecurityGroup(
    group: SecurityGroup,
    identifier: string,
    vpcId?: string,
    allowLegacyDatabaseTag = false
  ): void {
    const tags = new Map((group.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
    const expectedName = this.sanitizeIdentifier(`${identifier}-hypervibe-db`);
    const databaseTag = tags.get('Database');
    if (group.GroupName !== expectedName
      || !group.VpcId
      || (vpcId && group.VpcId !== vpcId)
      || tags.get('ManagedBy') !== 'Hypervibe'
      || (databaseTag !== identifier && !(allowLegacyDatabaseTag && databaseTag === undefined))) {
      throw new Error(`RDS security group ${group.GroupId ?? 'without an ID'} is outside the reviewed database/VPC identity.`);
    }
  }

  private async describeInstance(identifier: string): Promise<DBInstance | null> {
    if (!this.rds) throw new Error('Amazon RDS adapter is not connected.');
    try {
      const response = await this.rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
      if (!Array.isArray(response.DBInstances) || response.DBInstances.length !== 1) {
        throw new Error(
          `Amazon RDS returned ${response.DBInstances?.length ?? 0} instances for exact identifier ${identifier}; absence was not confirmed by a not-found response.`
        );
      }
      const instance = response.DBInstances[0];
      if (
        !instance.DBInstanceIdentifier
        || instance.DBInstanceIdentifier.toLowerCase() !== identifier.toLowerCase()
      ) {
        throw new Error(
          `Amazon RDS returned an instance that did not match exact identifier ${identifier}.`
        );
      }
      return instance;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'DBInstanceNotFound' || name === 'DBInstanceNotFoundFault') return null;
      throw error;
    }
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

  private hasErrorName(error: unknown, name: string): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { name?: unknown; code?: unknown };
    return candidate.name === name || candidate.code === name;
  }

  private sanitizeIdentifier(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
  }
}

providerRegistry.register({
  metadata: {
    name: 'rds',
    displayName: 'Amazon RDS',
    category: 'database',
    credentialsSchema: RdsCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    connectionAliases: ['ecs'],
    maturity: {
      lifecycle: {
        database: { status: 'planned', reason: 'Resource lifecycle is moving to OpenTofu; this adapter provides connections and existing-resource operations only.' },
      },
    },
  },
  inspection: {
    resources: ['database'],
    defaultResource: 'database',
    selectors: {
      database: {
        mode: 'provider-resource',
        optional: ['project', 'scope', 'id', 'name', 'limit'],
        mutuallyExclusive: [['id', 'name']],
        list: true,
        scopeKeys: ['accountId', 'region'],
      },
    },
    inspect: (adapter, request) => (
      adapter as RdsAdapter
    ).inspectDatabaseResources(request),
  },
  databaseRuntime: standardDatabaseRuntimeProjection,
  factory: async (credentials) => {
    const adapter = new RdsAdapter();
    await adapter.connect(credentials);
    return adapter;
  },
});
