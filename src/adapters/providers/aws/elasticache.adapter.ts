import { z } from 'zod';
import {
  CreateServerlessCacheCommand,
  DeleteServerlessCacheCommand,
  DescribeServerlessCachesCommand,
  ElastiCacheClient,
  type ServerlessCache,
} from '@aws-sdk/client-elasticache';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  EC2Client,
  type SecurityGroup,
} from '@aws-sdk/client-ec2';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type {
  CacheCapabilities,
  CacheEngine,
  CacheProvisionResult,
  ICacheAdapter,
} from '../../../domain/ports/cache.port.js';
import type { ObservedCache } from '../../../domain/ports/observe.port.js';
import type { Receipt, VerifyResult } from '../../../domain/ports/provider.port.js';
import {
  providerRegistry,
  type ProviderInspectionRequest,
} from '../../../domain/registry/provider.registry.js';

export const ElastiCacheCredentialsSchema = z.object({
  accessKeyId: z.string().min(1, 'AWS access key ID is required'),
  secretAccessKey: z.string().min(1, 'AWS secret access key is required'),
  sessionToken: z.string().optional()
    .describe('Required when using temporary AWS STS credentials'),
  region: z.string().default('us-east-1'),
  subnetIds: z.array(z.string().min(1)).min(
    2,
    'At least two subnet IDs in distinct availability zones are required for ElastiCache Serverless'
  ),
  securityGroupIds: z.array(z.string().min(1)).min(
    1,
    'At least one workload security group ID is required'
  ),
  maximumDataStorageGb: z.number().int().min(1).default(5),
  maximumEcpuPerSecond: z.number().int().min(1).default(1000),
  snapshotRetentionDays: z.number().int().min(0).max(35).default(1),
});

export type ElastiCacheCredentials = z.infer<typeof ElastiCacheCredentialsSchema>;

const DEFAULT_ATTEMPTS = 120;
const DEFAULT_DELAY_MS = 5_000;
const CACHE_PORT = 6379;

class ElastiCacheNetworkSetupError extends Error {
  constructor(
    message: string,
    readonly groupName: string,
    readonly groupId?: string
  ) {
    super(message);
    this.name = 'ElastiCacheNetworkSetupError';
  }
}

export class ElastiCacheAdapter implements ICacheAdapter {
  readonly name = 'elasticache';

  readonly capabilities: CacheCapabilities = {
    supportedCaches: ['redis'],
    supportsTls: true,
    supportsHighAvailability: true,
    supportsPersistence: true,
    serverlessOptimized: true,
  };

  private credentials: ElastiCacheCredentials | null = null;
  private elasticache: ElastiCacheClient | null = null;
  private ec2: EC2Client | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = ElastiCacheCredentialsSchema.parse(credentials);
    const awsCredentials = {
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      ...(this.credentials.sessionToken
        ? { sessionToken: this.credentials.sessionToken }
        : {}),
    };
    this.elasticache = new ElastiCacheClient({
      region: this.credentials.region,
      credentials: awsCredentials,
    });
    this.ec2 = new EC2Client({
      region: this.credentials.region,
      credentials: awsCredentials,
    });
  }

  async verify(): Promise<VerifyResult> {
    if (!this.credentials || !this.elasticache || !this.ec2) {
      return { success: false, error: 'Not connected. Call connect() first.' };
    }
    try {
      await Promise.all([
        this.elasticache.send(new DescribeServerlessCachesCommand({ MaxResults: 20 })),
        this.ec2.send(new DescribeSubnetsCommand({
          SubnetIds: this.credentials.subnetIds,
        })),
        this.ec2.send(new DescribeSecurityGroupsCommand({
          GroupIds: this.credentials.securityGroupIds,
        })),
      ]);
      return {
        success: true,
        email: `AWS ElastiCache (${this.credentials.region})`,
      };
    } catch (error) {
      return { success: false, error: this.formatError(error) };
    }
  }

  async disconnect(): Promise<void> {
    this.elasticache?.destroy();
    this.ec2?.destroy();
    this.elasticache = null;
    this.ec2 = null;
    this.credentials = null;
  }

  async provision(
    engine: CacheEngine,
    environment: Environment,
    options?: {
      size?: string;
      region?: string;
      resourceName?: string;
    }
  ): Promise<CacheProvisionResult> {
    if (!this.credentials || !this.elasticache || !this.ec2) {
      throw new Error('Not connected. Call connect() first.');
    }
    if (engine !== 'redis') {
      return this.failedProvision(
        environment,
        engine,
        `Amazon ElastiCache supports Redis-compatible Valkey. Requested engine: ${engine}`
      );
    }

    const cacheName = this.sanitizeName(
      options?.resourceName ?? `${environment.name}-redis`
    );
    let securityGroupId: string | undefined;
    let cacheMutationAttempted = false;
    let created: ServerlessCache | undefined;

    try {
      const matches = (await this.listServerlessCaches()).filter(
        (cache) => cache.ServerlessCacheName === cacheName
      );
      if (matches.length > 0) {
        throw new Error([
          `Amazon ElastiCache serverless cache "${cacheName}" already exists: ${matches
            .map((cache) => `${cache.ServerlessCacheName} (${cache.ARN ?? 'ARN unavailable'})`)
            .join(', ')}.`,
          'Hypervibe will not choose or silently adopt a name match. Bind/import the intended cache or remove the duplicate, then run hv_plan again.',
        ].join(' '));
      }

      securityGroupId = await this.createCacheSecurityGroup(cacheName);
      cacheMutationAttempted = true;
      const response = await this.elasticache.send(
        new CreateServerlessCacheCommand({
          ServerlessCacheName: cacheName,
          Description: `Hypervibe managed Valkey cache for ${environment.name}`,
          Engine: 'valkey',
          SecurityGroupIds: [securityGroupId],
          SubnetIds: this.credentials.subnetIds,
          CacheUsageLimits: {
            DataStorage: {
              Maximum: this.credentials.maximumDataStorageGb,
              Unit: 'GB',
            },
            ECPUPerSecond: {
              Maximum: this.credentials.maximumEcpuPerSecond,
            },
          },
          SnapshotRetentionLimit: this.credentials.snapshotRetentionDays,
          Tags: [
            { Key: 'ManagedBy', Value: 'Hypervibe' },
            { Key: 'Environment', Value: environment.name },
          ],
        })
      );
      created = response.ServerlessCache;
      const ready = await this.waitForCache(
        created?.ARN ?? cacheName,
        cacheName,
        'available'
      );
      if (!ready.ARN) {
        throw new Error(
          `ElastiCache serverless cache ${cacheName} became available without an ARN.`
        );
      }
      if (!ready.Endpoint?.Address || !ready.Endpoint.Port) {
        throw new Error(
          `ElastiCache serverless cache ${cacheName} became available without an endpoint.`
        );
      }
      const connectionUrl = this.connectionUrl(
        ready.Endpoint.Address,
        ready.Endpoint.Port
      );
      const component = this.component(
        environment,
        ready,
        securityGroupId,
        connectionUrl
      );
      return {
        component,
        connectionUrl,
        envVars: { REDIS_URL: connectionUrl },
        receipt: {
          success: true,
          message: `Created and verified Amazon ElastiCache serverless Valkey cache ${cacheName}`,
          data: {
            cacheArn: ready.ARN,
            cacheName: ready.ServerlessCacheName,
            status: ready.Status,
            engine: ready.Engine,
            securityGroupId,
            region: this.credentials.region,
          },
        },
      };
    } catch (error) {
      if (error instanceof ElastiCacheNetworkSetupError) {
        securityGroupId = error.groupId;
      }
      let live = created;
      let liveObservationError: string | undefined;
      let absenceConfirmed = false;
      if (cacheMutationAttempted) {
        try {
          const matches = (await this.listServerlessCaches()).filter(
            (cache) => cache.ServerlessCacheName === cacheName
          );
          live = matches[0] ?? live;
          absenceConfirmed = matches.length === 0 && !live;
        } catch (observeError) {
          liveObservationError = this.formatError(observeError);
        }
      } else {
        absenceConfirmed = true;
      }

      if (absenceConfirmed && securityGroupId) {
        try {
          await this.deleteSecurityGroupById(securityGroupId);
          securityGroupId = undefined;
        } catch (cleanupError) {
          liveObservationError = [
            liveObservationError,
            `Security-group cleanup failed: ${this.formatError(cleanupError)}`,
          ].filter(Boolean).join(' ');
        }
      }

      return {
        component: live?.ARN
          ? this.partialComponent(environment, live, securityGroupId)
          : cacheMutationAttempted || securityGroupId
            ? this.uncertainComponent(environment, cacheName, securityGroupId)
            : this.emptyComponent(environment, engine),
        receipt: {
          success: false,
          message: cacheMutationAttempted
            ? 'ElastiCache creation was attempted, but readiness could not be proven'
            : 'Failed to provision Amazon ElastiCache serverless cache',
          error: this.formatError(error),
          data: {
            cacheName,
            cacheArn: live?.ARN,
            cacheMutationAttempted,
            resourceCreated: live
              ? true
              : cacheMutationAttempted && !absenceConfirmed
                ? 'unknown'
                : false,
            securityGroupId,
            ...(error instanceof ElastiCacheNetworkSetupError
              ? { securityGroupName: error.groupName }
              : {}),
            ...(liveObservationError ? { liveObservationError } : {}),
          },
        },
      };
    }
  }

  async getConnectionUrl(component: Component): Promise<string | null> {
    const stored = component.bindings.connectionString
      ?? component.bindings.connectionUrl;
    if (typeof stored === 'string') {
      return stored;
    }
    const cache = await this.cacheForComponent(component);
    if (!cache?.Endpoint?.Address || !cache.Endpoint.Port) {
      return null;
    }
    return this.connectionUrl(cache.Endpoint.Address, cache.Endpoint.Port);
  }

  async destroy(component: Component): Promise<Receipt> {
    if (!this.elasticache || !this.ec2 || !component.externalId) {
      return {
        success: false,
        message: 'ElastiCache adapter is not connected or the component has no cache ARN',
      };
    }
    try {
      const existing = await this.cacheForComponent(component);
      if (existing) {
        if (!existing.ServerlessCacheName) {
          throw new Error(
            `ElastiCache resource ${component.externalId} has no serverless cache name.`
          );
        }
        await this.elasticache.send(new DeleteServerlessCacheCommand({
          ServerlessCacheName: existing.ServerlessCacheName,
        }));
        await this.waitForCache(
          existing.ARN ?? component.externalId,
          existing.ServerlessCacheName,
          'deleted'
        );
      }

      await this.deleteManagedSecurityGroup(component);
      return {
        success: true,
        message: existing
          ? `Deleted Amazon ElastiCache serverless cache ${existing.ServerlessCacheName}`
          : `Amazon ElastiCache serverless cache is already absent: ${component.externalId}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to delete Amazon ElastiCache serverless cache ${component.externalId}`,
        error: this.formatError(error),
      };
    }
  }

  async getStatus(component: Component): Promise<{
    status: 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown';
    message?: string;
  }> {
    if (!component.externalId) {
      return { status: 'unknown' };
    }
    try {
      const cache = await this.cacheForComponent(component);
      if (!cache) {
        return { status: 'stopped', message: 'Cache is absent' };
      }
      return {
        status: this.normalizedStatus(cache.Status),
        message: cache.Status,
      };
    } catch (error) {
      return { status: 'unknown', message: this.formatError(error) };
    }
  }

  async observeCache(
    environment: Environment,
    component?: Component | null,
    options?: { resourceName?: string }
  ): Promise<ObservedCache | null> {
    let cache: ServerlessCache | null;
    if (component?.externalId) {
      cache = await this.cacheByDurableId(component.externalId);
    } else {
      const cacheName = this.sanitizeName(
        options?.resourceName ?? `${environment.name}-redis`
      );
      const matches = (await this.listServerlessCaches()).filter(
        (candidate) => candidate.ServerlessCacheName === cacheName
      );
      if (matches.length > 1) {
        throw new Error(
          `Multiple Amazon ElastiCache serverless caches match "${cacheName}": ${matches
            .map((candidate) => candidate.ARN ?? candidate.ServerlessCacheName)
            .join(', ')}`
        );
      }
      cache = matches[0] ?? null;
    }
    if (!cache) {
      return null;
    }
    if (!cache.ARN) {
      throw new Error(
        `Amazon ElastiCache serverless cache ${cache.ServerlessCacheName ?? '(unnamed)'} has no durable ARN.`
      );
    }
    return {
      provider: 'elasticache',
      engine: 'redis',
      externalId: cache.ARN,
      providerScope: this.providerScope(cache),
      name: cache.ServerlessCacheName,
      status: this.normalizedStatus(cache.Status),
    };
  }

  async inspectCacheResources(
    request: ProviderInspectionRequest
  ): Promise<Record<string, unknown>> {
    const caches = await this.listServerlessCaches();
    const matched = caches
      .filter((cache) => !request.id || cache.ARN === request.id)
      .filter((cache) => !request.name
        || cache.ServerlessCacheName?.toLowerCase() === request.name.toLowerCase());
    const ambiguous = Boolean(request.name && matched.length > 1);
    return {
      observation: ambiguous ? 'ambiguous' : matched.length > 0 ? 'present' : 'absent',
      resource: 'cache',
      caches: matched.slice(0, request.limit).map((cache) => {
        if (!cache.ARN || !cache.ServerlessCacheName) {
          throw new Error('Amazon ElastiCache returned a serverless cache without its durable ARN and name.');
        }
        return {
          id: cache.ARN,
          name: cache.ServerlessCacheName,
          engine: cache.Engine ?? 'valkey',
          status: cache.Status ?? 'unknown',
          providerScope: this.providerScope(cache),
        };
      }),
      ...(matched.length === 0 && (request.id || request.name)
        ? { [request.id ? 'id' : 'name']: request.id ?? request.name }
        : {}),
      truncated: matched.length > request.limit,
      partial: false,
    };
  }

  private async createCacheSecurityGroup(cacheName: string): Promise<string> {
    if (!this.credentials || !this.ec2) {
      throw new Error('Not connected. Call connect() first.');
    }
    const subnets = await this.ec2.send(new DescribeSubnetsCommand({
      SubnetIds: this.credentials.subnetIds,
    }));
    const foundSubnetIds = new Set(
      (subnets.Subnets ?? []).map((subnet) => subnet.SubnetId).filter(Boolean)
    );
    const missingSubnets = this.credentials.subnetIds.filter(
      (subnetId) => !foundSubnetIds.has(subnetId)
    );
    if (missingSubnets.length > 0) {
      throw new Error(
        `AWS did not return these configured ElastiCache subnet IDs: ${missingSubnets.join(', ')}`
      );
    }
    const vpcIds = new Set(
      (subnets.Subnets ?? []).map((subnet) => subnet.VpcId).filter(Boolean)
    );
    if (vpcIds.size !== 1) {
      throw new Error('ElastiCache subnet IDs must all belong to exactly one VPC.');
    }
    const availabilityZones = new Set(
      (subnets.Subnets ?? []).map((subnet) => subnet.AvailabilityZone).filter(Boolean)
    );
    if (availabilityZones.size < 2) {
      throw new Error(
        'ElastiCache Serverless requires configured subnets in at least two availability zones.'
      );
    }
    const vpcId = [...vpcIds][0]!;

    const sourceGroups = await this.ec2.send(new DescribeSecurityGroupsCommand({
      GroupIds: this.credentials.securityGroupIds,
    }));
    this.assertWorkloadSecurityGroups(sourceGroups.SecurityGroups ?? [], vpcId);

    const groupName = `${cacheName}-hypervibe-cache`;
    const existing = await this.ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [groupName] },
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'tag:ManagedBy', Values: ['Hypervibe'] },
        { Name: 'tag:Cache', Values: [cacheName] },
      ],
    }));
    if ((existing.SecurityGroups?.length ?? 0) > 0) {
      throw new Error([
        `A Hypervibe-named ElastiCache security group already exists for "${cacheName}": ${existing.SecurityGroups
          ?.map((group) => group.GroupId)
          .filter(Boolean)
          .join(', ')}.`,
        'Hypervibe will not silently adopt a name match. Import/bind the intended cache state or remove the stale security group.',
      ].join(' '));
    }

    let groupId: string | undefined;
    try {
      const created = await this.ec2.send(new CreateSecurityGroupCommand({
        GroupName: groupName,
        Description: `Valkey access for Hypervibe cache ${cacheName}`,
        VpcId: vpcId,
        TagSpecifications: [{
          ResourceType: 'security-group',
          Tags: [
            { Key: 'ManagedBy', Value: 'Hypervibe' },
            { Key: 'Cache', Value: cacheName },
          ],
        }],
      }));
      groupId = created.GroupId;
    } catch (error) {
      // The tagged-name preflight above proved absence. A unique match after
      // an uncertain create response is therefore the resource from this
      // mutation, not silent adoption of user infrastructure.
      try {
        const observed = await this.ec2.send(new DescribeSecurityGroupsCommand({
          Filters: [
            { Name: 'group-name', Values: [groupName] },
            { Name: 'vpc-id', Values: [vpcId] },
            { Name: 'tag:ManagedBy', Values: ['Hypervibe'] },
            { Name: 'tag:Cache', Values: [cacheName] },
          ],
        }));
        if (observed.SecurityGroups?.length === 1) {
          groupId = observed.SecurityGroups[0].GroupId;
        }
      } catch {
        // Preserve the original mutation error below; absence is unknown.
      }
      if (!groupId) {
        throw new ElastiCacheNetworkSetupError(
          `ElastiCache security-group creation outcome is unknown: ${this.formatError(error)}`,
          groupName
        );
      }
    }
    if (!groupId) {
      throw new ElastiCacheNetworkSetupError(
        'AWS did not return an ID for the ElastiCache security group.',
        groupName
      );
    }

    try {
      await this.ec2.send(new AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [{
          IpProtocol: 'tcp',
          FromPort: CACHE_PORT,
          ToPort: CACHE_PORT,
          UserIdGroupPairs: this.credentials.securityGroupIds.map((groupId) => ({
            GroupId: groupId,
            Description: 'Hypervibe workload access to ElastiCache',
          })),
        }],
      }));
      return groupId;
    } catch (error) {
      let ingressConfirmed = false;
      let observationUnknown = false;
      try {
        const observed = await this.ec2.send(new DescribeSecurityGroupsCommand({
          GroupIds: [groupId],
        }));
        const group = observed.SecurityGroups?.find(
          (candidate) => candidate.GroupId === groupId
        );
        const allowedSources = new Set(
          (group?.IpPermissions ?? [])
            .filter((permission) =>
              permission.IpProtocol === 'tcp'
              && (permission.FromPort ?? -1) <= CACHE_PORT
              && (permission.ToPort ?? -1) >= CACHE_PORT
            )
            .flatMap((permission) =>
              permission.UserIdGroupPairs?.map((pair) => pair.GroupId) ?? []
            )
            .filter(Boolean)
        );
        ingressConfirmed = this.credentials.securityGroupIds.every(
          (sourceId) => allowedSources.has(sourceId)
        );
      } catch {
        observationUnknown = true;
      }
      if (ingressConfirmed) {
        return groupId;
      }
      if (!observationUnknown) {
        try {
          await this.deleteSecurityGroupById(groupId);
          throw error;
        } catch (cleanupError) {
          if (cleanupError === error) throw error;
          throw new ElastiCacheNetworkSetupError(
            `ElastiCache ingress failed and security-group cleanup failed: ${this.formatError(cleanupError)}`,
            groupName,
            groupId
          );
        }
      }
      throw new ElastiCacheNetworkSetupError(
        `ElastiCache ingress outcome is unknown: ${this.formatError(error)}`,
        groupName,
        groupId
      );
    }
  }

  private assertWorkloadSecurityGroups(
    groups: SecurityGroup[],
    vpcId: string
  ): void {
    const found = new Set(groups.map((group) => group.GroupId).filter(Boolean));
    const missing = this.credentials!.securityGroupIds.filter(
      (groupId) => !found.has(groupId)
    );
    if (missing.length > 0) {
      throw new Error(
        `AWS did not return these configured workload security groups: ${missing.join(', ')}`
      );
    }
    const wrongVpc = groups.filter((group) => group.VpcId !== vpcId);
    if (wrongVpc.length > 0) {
      throw new Error(
        `Workload security groups must share the ElastiCache VPC ${vpcId}: ${wrongVpc
          .map((group) => group.GroupId)
          .join(', ')}`
      );
    }
  }

  private async listServerlessCaches(): Promise<ServerlessCache[]> {
    if (!this.elasticache) {
      throw new Error('Not connected. Call connect() first.');
    }
    const caches: ServerlessCache[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.elasticache.send(
        new DescribeServerlessCachesCommand({
          MaxResults: 100,
          NextToken: nextToken,
        })
      );
      caches.push(...(response.ServerlessCaches ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
    return caches;
  }

  private async cacheForComponent(
    component: Component
  ): Promise<ServerlessCache | null> {
    if (!component.externalId) {
      return null;
    }
    return this.cacheByDurableId(component.externalId);
  }

  private async cacheByDurableId(
    externalId: string
  ): Promise<ServerlessCache | null> {
    const caches = await this.listServerlessCaches();
    return caches.find((cache) => cache.ARN === externalId) ?? null;
  }

  private async waitForCache(
    durableId: string,
    cacheName: string,
    target: 'available' | 'deleted'
  ): Promise<ServerlessCache> {
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_ELASTICACHE_READY_ATTEMPTS',
      DEFAULT_ATTEMPTS
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_ELASTICACHE_READY_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const caches = await this.listServerlessCaches();
      const cache = caches.find((candidate) =>
        candidate.ARN === durableId
        || (
          !durableId.startsWith('arn:')
          && candidate.ServerlessCacheName === cacheName
        )
      );
      if (target === 'deleted' && !cache) {
        return {
          ARN: durableId,
          ServerlessCacheName: cacheName,
          Status: 'deleted',
        };
      }
      if (target === 'available' && cache?.Status?.toLowerCase() === 'available') {
        return cache;
      }
      if (cache && /create-failed|failed/i.test(cache.Status ?? '')) {
        throw new Error(
          `ElastiCache serverless cache ${cacheName} entered terminal status ${cache.Status}.`
        );
      }
      if (attempt < attempts - 1) await this.delay(delayMs);
    }
    throw new Error(
      `ElastiCache serverless cache ${cacheName} did not become ${target} before timeout.`
    );
  }

  private async deleteManagedSecurityGroup(component: Component): Promise<void> {
    const groupId = component.bindings.securityGroupId;
    if (
      component.bindings.securityGroupManagedByHypervibe === true
      && typeof groupId === 'string'
    ) {
      await this.deleteSecurityGroupById(groupId);
    }
  }

  private async deleteSecurityGroupById(groupId: string): Promise<void> {
    if (!this.ec2) {
      throw new Error('Not connected. Call connect() first.');
    }
    const attempts = this.positiveIntegerEnv(
      'HYPERVIBE_ELASTICACHE_NETWORK_DELETE_ATTEMPTS',
      30
    );
    const delayMs = this.nonNegativeIntegerEnv(
      'HYPERVIBE_ELASTICACHE_NETWORK_DELETE_DELAY_MS',
      DEFAULT_DELAY_MS
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.ec2.send(new DeleteSecurityGroupCommand({
          GroupId: groupId,
        }));
        return;
      } catch (error) {
        const name = (error as { name?: string }).name;
        const code = (error as { code?: string }).code;
        if (name === 'InvalidGroup.NotFound' || code === 'InvalidGroup.NotFound') {
          return;
        }
        if (
          (name === 'DependencyViolation' || code === 'DependencyViolation')
          && attempt < attempts - 1
        ) {
          await this.delay(delayMs);
          continue;
        }
        throw error;
      }
    }
  }

  private component(
    environment: Environment,
    cache: ServerlessCache,
    securityGroupId: string,
    connectionUrl: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: cache.ARN!,
      bindings: {
        provider: 'elasticache',
        instanceId: cache.ARN!,
        providerScope: this.providerScope(cache),
        cacheName: cache.ServerlessCacheName,
        connectionString: connectionUrl,
        connectionUrl,
        host: cache.Endpoint?.Address,
        port: cache.Endpoint?.Port,
        securityGroupId,
        securityGroupManagedByHypervibe: true,
        subnetIds: cache.SubnetIds ?? this.credentials?.subnetIds,
        tls: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private partialComponent(
    environment: Environment,
    cache: ServerlessCache,
    securityGroupId?: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: cache.ARN ?? null,
      bindings: {
        provider: 'elasticache',
        instanceId: cache.ARN,
        ...(cache.ARN ? { providerScope: this.providerScope(cache) } : {}),
        cacheName: cache.ServerlessCacheName,
        securityGroupId,
        securityGroupManagedByHypervibe: Boolean(securityGroupId),
        tls: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private uncertainComponent(
    environment: Environment,
    cacheName: string,
    securityGroupId?: string
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: 'redis',
      externalId: null,
      bindings: {
        provider: 'elasticache',
        cacheName,
        securityGroupId,
        securityGroupManagedByHypervibe: Boolean(securityGroupId),
        mutationAttempted: true,
        tls: true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private emptyComponent(
    environment: Environment,
    engine: CacheEngine
  ): Component {
    return {
      id: '',
      environmentId: environment.id,
      type: engine,
      externalId: null,
      bindings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private failedProvision(
    environment: Environment,
    engine: CacheEngine,
    error: string
  ): CacheProvisionResult {
    return {
      component: this.emptyComponent(environment, engine),
      receipt: {
        success: false,
        message: 'Failed to provision Amazon ElastiCache serverless cache',
        error,
      },
    };
  }

  private connectionUrl(host: string, port: number): string {
    return `rediss://${host}:${port}`;
  }

  private providerScope(cache: ServerlessCache): Record<string, string> {
    const parts = cache.ARN?.split(':') ?? [];
    const region = parts[3] || this.credentials?.region;
    const accountId = parts[4];
    if (!region || !accountId) {
      throw new Error(
        `Amazon ElastiCache cache ${cache.ServerlessCacheName ?? '(unnamed)'} returned an invalid durable ARN.`
      );
    }
    return { accountId, region };
  }

  private sanitizeName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[^a-z]+/, '')
      .replace(/-+$/g, '')
      .slice(0, 40) || 'hypervibe-cache';
  }

  private normalizedStatus(
    status?: string
  ): 'running' | 'stopped' | 'provisioning' | 'error' | 'unknown' {
    const normalized = status?.toLowerCase();
    if (normalized === 'available') return 'running';
    if (normalized === 'deleting') return 'stopped';
    if (['creating', 'modifying'].includes(normalized ?? '')) return 'provisioning';
    if (normalized?.includes('failed')) return 'error';
    return 'unknown';
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private nonNegativeIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}

providerRegistry.register({
  metadata: {
    name: 'elasticache',
    displayName: 'Amazon ElastiCache',
    category: 'cache',
    credentialsSchema: ElastiCacheCredentialsSchema,
    setupHelpUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    lifecycle: {
      cacheEngines: ['redis'],
    },
  },
  factory: (credentials) => {
    const adapter = new ElastiCacheAdapter();
    void adapter.connect(credentials);
    return adapter;
  },
  inspection: {
    resources: ['cache'],
    defaultResource: 'cache',
    selectors: {
      cache: { mode: 'provider-resource', optional: ['id', 'name', 'limit'], mutuallyExclusive: [['id', 'name']], list: true, scopeKeys: ['accountId', 'region'] },
    },
    inspect: (adapter, request) => (
      adapter as ElastiCacheAdapter
    ).inspectCacheResources(request),
  },
});
