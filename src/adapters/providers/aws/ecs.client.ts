import {
  CreateClusterCommand,
  CreateServiceCommand,
  DeleteClusterCommand,
  DeleteServiceCommand,
  DeleteTaskDefinitionsCommand,
  DeregisterTaskDefinitionCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListClustersCommand,
  ListAccountSettingsCommand,
  ListServicesCommand,
  ListTaskDefinitionsCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  type Cluster,
  type CreateServiceCommandInput,
  type RegisterTaskDefinitionCommandInput,
  type Service,
  type Task,
  type TaskDefinition,
} from '@aws-sdk/client-ecs';
import {
  DescribeRepositoriesCommand,
  ECRClient,
  type Repository,
} from '@aws-sdk/client-ecr';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
  type LoadBalancer,
  type TargetGroup,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  GetRoleCommand,
  IAMClient,
  type Role,
} from '@aws-sdk/client-iam';
import type { EcsCredentials } from './ecs.credentials.js';

const PAGE_CAP = 1000;

export class AwsEcsApiError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string
  ) {
    super(`AWS API ${code} during ${operation}`);
    this.name = 'AwsEcsApiError';
  }
}

export interface AwsEcsPrerequisites {
  accountId: string;
  repository: Repository;
  vpcId: string;
  targetGroup?: TargetGroup;
  loadBalancer?: LoadBalancer;
  loadBalancerProtocol?: 'http' | 'https';
  publicUrl?: string;
}

export class EcsFargateClient {
  private readonly ecs: ECSClient;
  private readonly ecr: ECRClient;
  private readonly ec2: EC2Client;
  private readonly elbv2: ElasticLoadBalancingV2Client;
  private readonly iam: IAMClient;

  constructor(private readonly credentials: EcsCredentials) {
    const awsCredentials = {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    };
    const config = {
      region: credentials.region,
      credentials: awsCredentials,
    };
    this.ecs = new ECSClient(config);
    this.ecr = new ECRClient(config);
    this.ec2 = new EC2Client(config);
    this.elbv2 = new ElasticLoadBalancingV2Client(config);
    this.iam = new IAMClient(config);
  }

  async disconnect(): Promise<void> {
    this.ecs.destroy();
    this.ecr.destroy();
    this.ec2.destroy();
    this.elbv2.destroy();
    this.iam.destroy();
  }

  async verifyPrerequisites(): Promise<AwsEcsPrerequisites> {
    try {
      const repositoryName = this.repositoryName();
      const [
        repositoryResult,
        subnetResult,
        securityGroupResult,
        executionRoleResult,
        taskRoleResult,
        accountSettingsResult,
      ] = await Promise.all([
        this.ecr.send(new DescribeRepositoriesCommand({
          repositoryNames: [repositoryName],
        })),
        this.ec2.send(new DescribeSubnetsCommand({
          SubnetIds: this.credentials.subnetIds,
        })),
        this.ec2.send(new DescribeSecurityGroupsCommand({
          GroupIds: this.credentials.securityGroupIds,
        })),
        this.iam.send(new GetRoleCommand({
          RoleName: roleName(this.credentials.executionRoleArn),
        })),
        this.credentials.taskRoleArn
          ? this.iam.send(new GetRoleCommand({
              RoleName: roleName(this.credentials.taskRoleArn),
            }))
          : Promise.resolve(undefined),
        this.ecs.send(new ListAccountSettingsCommand({
          name: 'serviceLongArnFormat',
          effectiveSettings: true,
        })),
      ]);
      const repositories = repositoryResult.repositories ?? [];
      if (repositories.length !== 1) {
        throw new AwsEcsApiError(
          'ECR repository verification',
          'INCOMPLETE_RESPONSE'
        );
      }
      const repository = repositories[0]!;
      this.assertRepository(repository);
      const accountId = repository.registryId!;

      const subnets = subnetResult.Subnets ?? [];
      const returnedSubnetIds = new Set(
        subnets.flatMap((subnet) => subnet.SubnetId ? [subnet.SubnetId] : [])
      );
      if (
        subnets.length !== this.credentials.subnetIds.length
        || this.credentials.subnetIds.some((id) => !returnedSubnetIds.has(id))
      ) {
        throw new AwsEcsApiError(
          'subnet verification',
          'INCOMPLETE_RESPONSE'
        );
      }
      const subnetVpcIds = new Set(
        subnets.flatMap((subnet) => subnet.VpcId ? [subnet.VpcId] : [])
      );
      if (subnetVpcIds.size !== 1) {
        throw new AwsEcsApiError(
          'subnet VPC verification',
          'SCOPE_MISMATCH'
        );
      }
      const vpcId = Array.from(subnetVpcIds)[0]!;

      const securityGroups = securityGroupResult.SecurityGroups ?? [];
      const returnedGroupIds = new Set(
        securityGroups.flatMap((group) => group.GroupId ? [group.GroupId] : [])
      );
      if (
        securityGroups.length !== this.credentials.securityGroupIds.length
        || this.credentials.securityGroupIds.some(
          (id) => !returnedGroupIds.has(id)
        )
        || securityGroups.some((group) => group.VpcId !== vpcId)
      ) {
        throw new AwsEcsApiError(
          'security-group verification',
          'SCOPE_MISMATCH'
        );
      }
      this.assertRole(
        executionRoleResult.Role,
        this.credentials.executionRoleArn,
        'execution role verification'
      );
      if (this.credentials.taskRoleArn) {
        this.assertRole(
          taskRoleResult?.Role,
          this.credentials.taskRoleArn,
          'task role verification'
        );
      }
      const longArnSetting = accountSettingsResult.settings?.find(
        (setting) => setting.name === 'serviceLongArnFormat'
      );
      if (longArnSetting?.value !== 'enabled') {
        throw new AwsEcsApiError(
          'ECS long service ARN verification',
          'REQUIRED_ACCOUNT_SETTING_DISABLED'
        );
      }

      if (!this.credentials.targetGroupArn) {
        return { accountId, repository, vpcId };
      }
      const targetGroups = (
        await this.elbv2.send(new DescribeTargetGroupsCommand({
          TargetGroupArns: [this.credentials.targetGroupArn],
        }))
      ).TargetGroups ?? [];
      if (targetGroups.length !== 1) {
        throw new AwsEcsApiError(
          'target-group verification',
          'INCOMPLETE_RESPONSE'
        );
      }
      const targetGroup = targetGroups[0]!;
      if (
        targetGroup.TargetGroupArn !== this.credentials.targetGroupArn
        || targetGroup.TargetType !== 'ip'
        || targetGroup.VpcId !== vpcId
        || !['HTTP', 'HTTPS'].includes(targetGroup.Protocol ?? '')
      ) {
        throw new AwsEcsApiError(
          'target-group verification',
          'SCOPE_MISMATCH'
        );
      }
      const loadBalancerArns = targetGroup.LoadBalancerArns ?? [];
      if (loadBalancerArns.length !== 1) {
        throw new AwsEcsApiError(
          'target-group load-balancer verification',
          loadBalancerArns.length === 0
            ? 'NOT_ATTACHED'
            : 'AMBIGUOUS_IDENTITY'
        );
      }
      const loadBalancers = (
        await this.elbv2.send(new DescribeLoadBalancersCommand({
          LoadBalancerArns: loadBalancerArns,
        }))
      ).LoadBalancers ?? [];
      if (loadBalancers.length !== 1) {
        throw new AwsEcsApiError(
          'load-balancer verification',
          'INCOMPLETE_RESPONSE'
        );
      }
      const loadBalancer = loadBalancers[0]!;
      if (
        loadBalancer.LoadBalancerArn !== loadBalancerArns[0]
        || loadBalancer.VpcId !== vpcId
        || !loadBalancer.DNSName
        || loadBalancer.State?.Code !== 'active'
        || loadBalancer.Type !== 'application'
        || loadBalancer.Scheme !== 'internet-facing'
      ) {
        throw new AwsEcsApiError(
          'load-balancer verification',
          'SCOPE_MISMATCH'
        );
      }
      const listeners = await this.listAll(async (marker) => {
        const result = await this.elbv2.send(
          new DescribeListenersCommand({
            LoadBalancerArn: loadBalancer.LoadBalancerArn,
            Marker: marker,
            PageSize: 100,
          })
        );
        return {
          values: result.Listeners ?? [],
          nextToken: result.NextMarker,
        };
      }, 'load-balancer listener observation');
      const routedProtocols: string[] = [];
      const defaultRoutedProtocols: string[] = [];
      for (const listener of listeners) {
        if (!listener.ListenerArn) {
          throw new AwsEcsApiError(
            'load-balancer listener verification',
            'INCOMPLETE_RESPONSE'
          );
        }
        const rules = await this.listAll(async (marker) => {
          const result = await this.elbv2.send(new DescribeRulesCommand({
            ListenerArn: listener.ListenerArn,
            Marker: marker,
            PageSize: 100,
          }));
          return {
            values: result.Rules ?? [],
            nextToken: result.NextMarker,
          };
        }, 'load-balancer rule observation');
        const routedRules = rules.filter((rule) =>
          (rule.Actions ?? []).some((action) =>
            action.TargetGroupArn === targetGroup.TargetGroupArn
            || (action.ForwardConfig?.TargetGroups ?? []).some(
              (candidate) =>
                candidate.TargetGroupArn === targetGroup.TargetGroupArn
            )
          )
        );
        if (routedRules.length > 0) {
          routedProtocols.push(listener.Protocol ?? '');
          if (routedRules.some((rule) => rule.IsDefault === true)) {
            defaultRoutedProtocols.push(listener.Protocol ?? '');
          }
        }
      }
      const publicUrlProtocol = this.credentials.publicUrl
        ? new URL(this.credentials.publicUrl).protocol
        : undefined;
      const configuredProtocol: 'http' | 'https' | undefined =
        publicUrlProtocol === 'http:'
          ? 'http'
          : publicUrlProtocol === 'https:'
            ? 'https'
            : undefined;
      if (
        configuredProtocol
        && !routedProtocols.includes(configuredProtocol.toUpperCase())
      ) {
        throw new AwsEcsApiError(
          'load-balancer public URL verification',
          'PROTOCOL_NOT_ROUTED'
        );
      }
      const loadBalancerProtocol = configuredProtocol
        ?? (defaultRoutedProtocols.includes('HTTP') ? 'http' : undefined);
      if (!loadBalancerProtocol) {
        throw new AwsEcsApiError(
          'load-balancer listener verification',
          routedProtocols.length > 0
            ? 'PUBLIC_URL_REQUIRED'
            : 'NOT_ATTACHED'
        );
      }
      const publicUrl = this.credentials.publicUrl
        ?? `${loadBalancerProtocol}://${loadBalancer.DNSName}`;
      return {
        accountId,
        repository,
        vpcId,
        targetGroup,
        loadBalancer,
        loadBalancerProtocol,
        publicUrl,
      };
    } catch (error) {
      throw safeAwsError(error, 'AWS ECS prerequisite verification');
    }
  }

  async listClusters(): Promise<Cluster[]> {
    const arns = await this.listAll(async (nextToken) => {
      const result = await this.ecsRequest(
        'ECS cluster listing',
        () => this.ecs.send(new ListClustersCommand({
          nextToken,
          maxResults: 100,
        }))
      );
      return {
        values: result.clusterArns ?? [],
        nextToken: result.nextToken,
      };
    }, 'ECS cluster listing');
    if (arns.length === 0) return [];
    const clusters: Cluster[] = [];
    for (const batch of chunks(arns, 100)) {
      const result = await this.ecsRequest(
        'ECS cluster observation',
        () => this.ecs.send(new DescribeClustersCommand({
          clusters: batch,
          include: ['TAGS'],
        }))
      );
      this.assertNoUnknownFailures(
        result.failures,
        'ECS cluster observation'
      );
      const batchClusters = result.clusters ?? [];
      this.assertExactBatch(
        batch,
        batchClusters.map((cluster) => cluster.clusterArn),
        'ECS cluster observation'
      );
      clusters.push(...batchClusters);
    }
    this.assertUniqueArns(
      clusters.map((cluster) => cluster.clusterArn),
      'ECS clusters'
    );
    for (const cluster of clusters) {
      if (
        !cluster.clusterArn
        || !cluster.clusterName
        || cluster.clusterArn.split(':cluster/')[1] !== cluster.clusterName
      ) {
        throw new AwsEcsApiError(
          'ECS cluster observation',
          'INCOMPLETE_RESPONSE'
        );
      }
      this.assertEcsArn(cluster.clusterArn, 'cluster');
    }
    return clusters;
  }

  async getCluster(clusterArn: string): Promise<Cluster | null> {
    this.assertEcsArn(clusterArn, 'cluster');
    const result = await this.ecsRequest(
      'ECS cluster observation',
      () => this.ecs.send(new DescribeClustersCommand({
        clusters: [clusterArn],
        include: ['TAGS'],
      }))
    );
    if (
      this.onlyMissing(result.failures)
      && (result.clusters ?? []).length === 0
    ) return null;
    this.assertNoUnknownFailures(result.failures, 'ECS cluster observation');
    const clusters = result.clusters ?? [];
    if (clusters.length !== 1 || clusters[0]?.clusterArn !== clusterArn) {
      throw new AwsEcsApiError(
        'ECS cluster observation',
        'INCOMPLETE_RESPONSE'
      );
    }
    return clusters[0]!;
  }

  async createCluster(
    name: string,
    tags: Array<{ key: string; value: string }>
  ): Promise<Cluster> {
    const result = await this.ecsRequest(
      'ECS cluster creation',
      () => this.ecs.send(new CreateClusterCommand({
        clusterName: name,
        capacityProviders: ['FARGATE', 'FARGATE_SPOT'],
        defaultCapacityProviderStrategy: [{
          capacityProvider: 'FARGATE',
          weight: 1,
          base: 0,
        }],
        tags,
      }))
    );
    const cluster = result.cluster;
    if (!cluster?.clusterArn || cluster.clusterName !== name) {
      throw new AwsEcsApiError(
        'ECS cluster creation',
        'INCOMPLETE_RESPONSE'
      );
    }
    this.assertEcsArn(cluster.clusterArn, 'cluster');
    return cluster;
  }

  async deleteCluster(clusterArn: string): Promise<void> {
    this.assertEcsArn(clusterArn, 'cluster');
    await this.ecsRequest(
      'ECS cluster deletion',
      () => this.ecs.send(new DeleteClusterCommand({ cluster: clusterArn }))
    );
  }

  async listServices(clusterArn: string): Promise<Service[]> {
    this.assertEcsArn(clusterArn, 'cluster');
    const arns = await this.listAll(async (nextToken) => {
      const result = await this.ecsRequest(
        'ECS service listing',
        () => this.ecs.send(new ListServicesCommand({
          cluster: clusterArn,
          nextToken,
          maxResults: 100,
        }))
      );
      return {
        values: result.serviceArns ?? [],
        nextToken: result.nextToken,
      };
    }, 'ECS service listing');
    const services: Service[] = [];
    for (const batch of chunks(arns, 10)) {
      const result = await this.ecsRequest(
        'ECS service observation',
        () => this.ecs.send(new DescribeServicesCommand({
          cluster: clusterArn,
          services: batch,
          include: ['TAGS'],
        }))
      );
      this.assertNoUnknownFailures(
        result.failures,
        'ECS service observation'
      );
      const batchServices = result.services ?? [];
      this.assertExactBatch(
        batch,
        batchServices.map((service) => service.serviceArn),
        'ECS service observation'
      );
      services.push(...batchServices);
    }
    this.assertUniqueArns(
      services.map((service) => service.serviceArn),
      'ECS services'
    );
    for (const service of services) {
      if (
        !service.serviceArn
        || service.clusterArn !== clusterArn
        || !service.serviceName
        || service.serviceArn.split('/').at(-1) !== service.serviceName
        || service.serviceArn.split(':service/')[1]?.split('/')[0]
          !== clusterArn.split(':cluster/')[1]
      ) {
        throw new AwsEcsApiError(
          'ECS service observation',
          'INCOMPLETE_RESPONSE'
        );
      }
      this.assertEcsArn(service.serviceArn, 'service');
    }
    return services;
  }

  async getService(
    clusterArn: string,
    serviceArn: string
  ): Promise<Service | null> {
    this.assertEcsArn(clusterArn, 'cluster');
    this.assertEcsArn(serviceArn, 'service');
    const result = await this.ecsRequest(
      'ECS service observation',
      () => this.ecs.send(new DescribeServicesCommand({
        cluster: clusterArn,
        services: [serviceArn],
        include: ['TAGS'],
      }))
    );
    if (
      this.onlyMissing(result.failures)
      && (result.services ?? []).length === 0
    ) return null;
    this.assertNoUnknownFailures(result.failures, 'ECS service observation');
    const services = result.services ?? [];
    if (
      services.length !== 1
      || services[0]?.serviceArn !== serviceArn
      || services[0]?.clusterArn !== clusterArn
      || serviceArn.split(':service/')[1]?.split('/')[0]
        !== clusterArn.split(':cluster/')[1]
    ) {
      throw new AwsEcsApiError(
        'ECS service observation',
        'INCOMPLETE_RESPONSE'
      );
    }
    return services[0]!;
  }

  async createService(
    input: CreateServiceCommandInput
  ): Promise<Service> {
    const result = await this.ecsRequest(
      'ECS service creation',
      () => this.ecs.send(new CreateServiceCommand(input))
    );
    const service = result.service;
    if (
      !service?.serviceArn
      || service.clusterArn !== input.cluster
      || service.serviceName !== input.serviceName
    ) {
      throw new AwsEcsApiError(
        'ECS service creation',
        'INCOMPLETE_RESPONSE'
      );
    }
    this.assertEcsArn(service.serviceArn, 'service');
    return service;
  }

  async updateService(params: {
    clusterArn: string;
    serviceArn: string;
    taskDefinitionArn?: string;
    desiredCount?: number;
  }): Promise<Service> {
    const result = await this.ecsRequest(
      'ECS service update',
      () => this.ecs.send(new UpdateServiceCommand({
        cluster: params.clusterArn,
        service: params.serviceArn,
        ...(params.taskDefinitionArn
          ? { taskDefinition: params.taskDefinitionArn }
          : {}),
        ...(params.desiredCount === undefined
          ? {}
          : { desiredCount: params.desiredCount }),
        forceNewDeployment: false,
      }))
    );
    const service = result.service;
    if (
      !service?.serviceArn
      || service.serviceArn !== params.serviceArn
      || service.clusterArn !== params.clusterArn
    ) {
      throw new AwsEcsApiError(
        'ECS service update',
        'INCOMPLETE_RESPONSE'
      );
    }
    return service;
  }

  async deleteService(
    clusterArn: string,
    serviceArn: string
  ): Promise<void> {
    await this.ecsRequest(
      'ECS service deletion',
      () => this.ecs.send(new DeleteServiceCommand({
        cluster: clusterArn,
        service: serviceArn,
        force: false,
      }))
    );
  }

  async registerTaskDefinition(
    input: RegisterTaskDefinitionCommandInput
  ): Promise<TaskDefinition> {
    const result = await this.ecsRequest(
      'ECS task-definition registration',
      () => this.ecs.send(new RegisterTaskDefinitionCommand(input))
    );
    const definition = result.taskDefinition;
    if (
      !definition?.taskDefinitionArn
      || definition.family !== input.family
      || definition.status !== 'ACTIVE'
    ) {
      throw new AwsEcsApiError(
        'ECS task-definition registration',
        'INCOMPLETE_RESPONSE'
      );
    }
    this.assertEcsArn(definition.taskDefinitionArn, 'task-definition');
    return definition;
  }

  async getTaskDefinition(
    taskDefinitionArn: string
  ): Promise<TaskDefinition> {
    this.assertEcsArn(taskDefinitionArn, 'task-definition');
    try {
      const result = await this.ecsRequest(
        'ECS task-definition observation',
        () => this.ecs.send(new DescribeTaskDefinitionCommand({
          taskDefinition: taskDefinitionArn,
          include: ['TAGS'],
        }))
      );
      if (
        !result.taskDefinition?.taskDefinitionArn
        || result.taskDefinition.taskDefinitionArn !== taskDefinitionArn
      ) {
        throw new AwsEcsApiError(
          'ECS task-definition observation',
          'INCOMPLETE_RESPONSE'
        );
      }
      return result.taskDefinition;
    } catch (error) {
      throw safeAwsError(error, 'ECS task-definition observation');
    }
  }

  async listTaskDefinitionArns(
    family: string,
    status: 'ACTIVE' | 'INACTIVE' | 'DELETE_IN_PROGRESS'
  ): Promise<string[]> {
    const arns = await this.listAll(async (nextToken) => {
      const result = await this.ecsRequest(
        `ECS ${status.toLowerCase()} task-definition listing`,
        () => this.ecs.send(new ListTaskDefinitionsCommand({
          familyPrefix: family,
          status,
          sort: 'DESC',
          maxResults: 100,
          nextToken,
        }))
      );
      return {
        values: (result.taskDefinitionArns ?? []).filter(
          (arn) => taskFamilyFromArn(arn) === family
        ),
        nextToken: result.nextToken,
      };
    }, `ECS ${status.toLowerCase()} task-definition listing`);
    this.assertUniqueArns(arns, 'ECS task definitions');
    for (const arn of arns) {
      this.assertEcsArn(arn, 'task-definition');
    }
    return arns;
  }

  async deregisterTaskDefinition(taskDefinitionArn: string): Promise<void> {
    const result = await this.ecsRequest(
      'ECS task-definition deregistration',
      () => this.ecs.send(new DeregisterTaskDefinitionCommand({
        taskDefinition: taskDefinitionArn,
      }))
    );
    if (
      result.taskDefinition?.taskDefinitionArn !== taskDefinitionArn
      || result.taskDefinition.status !== 'INACTIVE'
    ) {
      throw new AwsEcsApiError(
        'ECS task-definition deregistration',
        'INCOMPLETE_RESPONSE'
      );
    }
  }

  async deleteTaskDefinitions(taskDefinitionArns: string[]): Promise<void> {
    for (const batch of chunks(taskDefinitionArns, 10)) {
      const result = await this.ecsRequest(
        'ECS task-definition deletion',
        () => this.ecs.send(new DeleteTaskDefinitionsCommand({
          taskDefinitions: batch,
        }))
      );
      if ((result.failures ?? []).length > 0) {
        throw new AwsEcsApiError(
          'ECS task-definition deletion',
          'PARTIAL_FAILURE'
        );
      }
      const deleted = new Set(
        (result.taskDefinitions ?? []).flatMap((definition) =>
          definition.taskDefinitionArn
            ? [definition.taskDefinitionArn]
            : []
        )
      );
      if (batch.some((arn) => !deleted.has(arn))) {
        throw new AwsEcsApiError(
          'ECS task-definition deletion',
          'INCOMPLETE_RESPONSE'
        );
      }
    }
  }

  async listRunningTasks(
    clusterArn: string,
    serviceName: string
  ): Promise<Task[]> {
    const arns = await this.listAll(async (nextToken) => {
      const result = await this.ecsRequest(
        'ECS running-task listing',
        () => this.ecs.send(new ListTasksCommand({
          cluster: clusterArn,
          serviceName,
          desiredStatus: 'RUNNING',
          maxResults: 100,
          nextToken,
        }))
      );
      return {
        values: result.taskArns ?? [],
        nextToken: result.nextToken,
      };
    }, 'ECS running-task listing');
    const tasks: Task[] = [];
    for (const batch of chunks(arns, 100)) {
      const result = await this.ecsRequest(
        'ECS task observation',
        () => this.ecs.send(new DescribeTasksCommand({
          cluster: clusterArn,
          tasks: batch,
          include: ['TAGS'],
        }))
      );
      this.assertNoUnknownFailures(result.failures, 'ECS task observation');
      const batchTasks = result.tasks ?? [];
      this.assertExactBatch(
        batch,
        batchTasks.map((task) => task.taskArn),
        'ECS task observation'
      );
      tasks.push(...batchTasks);
    }
    this.assertUniqueArns(
      tasks.map((task) => task.taskArn),
      'ECS tasks'
    );
    if (tasks.some((task) => task.clusterArn !== clusterArn)) {
      throw new AwsEcsApiError(
        'ECS task observation',
        'SCOPE_MISMATCH'
      );
    }
    for (const task of tasks) {
      this.assertEcsArn(task.taskArn!, 'task');
      const taskResource = task.taskArn!.split(':task/')[1];
      const taskSegments = taskResource?.split('/') ?? [];
      const clusterName = clusterArn.split(':cluster/')[1];
      if (
        taskSegments.length > 1
        && taskSegments[0] !== clusterName
      ) {
        throw new AwsEcsApiError(
          'ECS task observation',
          'SCOPE_MISMATCH'
        );
      }
    }
    return tasks;
  }

  repositoryUri(): string {
    return this.credentials.ecrRepositoryUri;
  }

  accountId(): string {
    return this.credentials.ecrRepositoryArn.split(':')[4]!;
  }

  private repositoryName(): string {
    return this.credentials.ecrRepositoryArn.split(':repository/')[1]!;
  }

  private assertRepository(repository: Repository): void {
    if (
      repository.repositoryArn !== this.credentials.ecrRepositoryArn
      || repository.repositoryUri !== this.credentials.ecrRepositoryUri
      || repository.registryId !== this.accountId()
      || repository.repositoryName !== this.repositoryName()
    ) {
      throw new AwsEcsApiError(
        'ECR repository verification',
        'SCOPE_MISMATCH'
      );
    }
  }

  private assertRole(
    role: Role | undefined,
    expectedArn: string,
    operation: string
  ): void {
    if (role?.Arn !== expectedArn) {
      throw new AwsEcsApiError(operation, 'SCOPE_MISMATCH');
    }
    const document = parseIamPolicyDocument(
      role.AssumeRolePolicyDocument
    );
    const statements = Array.isArray(document?.Statement)
      ? document.Statement
      : document?.Statement
        ? [document.Statement]
        : [];
    const allowsEcsTasks = statements.some((statement) => {
      if (
        !statement
        || typeof statement !== 'object'
        || statement.Effect !== 'Allow'
      ) return false;
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      const services = Array.isArray(statement.Principal?.Service)
        ? statement.Principal.Service
        : [statement.Principal?.Service];
      return (
        actions.includes('sts:AssumeRole')
        && services.includes('ecs-tasks.amazonaws.com')
      );
    });
    if (!allowsEcsTasks) {
      throw new AwsEcsApiError(
        operation,
        'ECS_TASK_TRUST_REQUIRED'
      );
    }
  }

  private assertEcsArn(
    arn: string,
    resourceType: 'cluster' | 'service' | 'task-definition' | 'task'
  ): void {
    const match = arn.match(
      /^arn:aws:ecs:([a-z0-9-]+):(\d{12}):(.+)$/
    );
    const resource = match?.[3] ?? '';
    const resourceMatches = resourceType === 'cluster'
      ? /^cluster\/[^/]+$/.test(resource)
      : resourceType === 'service'
        ? /^service\/[^/]+\/[^/]+$/.test(resource)
        : resourceType === 'task-definition'
          ? /^task-definition\/[^/:]+:\d+$/.test(resource)
          : /^task\/(?:[^/]+\/)?[^/]+$/.test(resource);
    if (
      !match
      || match[1] !== this.credentials.region
      || match[2] !== this.accountId()
      || !resourceMatches
    ) {
      throw new AwsEcsApiError(
        `ECS ${resourceType} identity validation`,
        'SCOPE_MISMATCH'
      );
    }
  }

  private assertNoUnknownFailures(
    failures: Array<{ reason?: string } | undefined> | undefined,
    operation: string
  ): void {
    if ((failures ?? []).length > 0) {
      const reasons = Array.from(new Set(
        (failures ?? []).map((failure) => failure?.reason ?? 'UNKNOWN')
      )).sort();
      throw new AwsEcsApiError(operation, reasons.join(','));
    }
  }

  private onlyMissing(
    failures: Array<{ reason?: string } | undefined> | undefined
  ): boolean {
    return (
      (failures ?? []).length === 1
      && failures?.[0]?.reason === 'MISSING'
    );
  }

  private assertUniqueArns(
    arns: Array<string | undefined>,
    description: string
  ): void {
    if (arns.some((arn) => !arn)) {
      throw new AwsEcsApiError(
        `${description} observation`,
        'INCOMPLETE_RESPONSE'
      );
    }
    const normalized = arns.map((arn) => arn!.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      throw new AwsEcsApiError(
        `${description} observation`,
        'DUPLICATE_IDENTITY'
      );
    }
  }

  private assertExactBatch(
    requested: string[],
    returned: Array<string | undefined>,
    operation: string
  ): void {
    if (
      returned.length !== requested.length
      || returned.some((value) => !value)
      || requested.some((value) => !returned.includes(value))
    ) {
      throw new AwsEcsApiError(operation, 'INCOMPLETE_RESPONSE');
    }
  }

  private async ecsRequest<T>(
    operation: string,
    request: () => Promise<T>
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw safeAwsError(error, operation);
    }
  }

  private async listAll<T>(
    page: (
      nextToken: string | undefined
    ) => Promise<{ values: T[]; nextToken?: string }>,
    operation: string
  ): Promise<T[]> {
    const values: T[] = [];
    const seen = new Set<string>();
    let nextToken: string | undefined;
    for (let index = 1; index <= PAGE_CAP; index += 1) {
      if (nextToken && seen.has(nextToken)) {
        throw new AwsEcsApiError(operation, 'REPEATED_NEXT_TOKEN');
      }
      if (nextToken) seen.add(nextToken);
      const result = await page(nextToken);
      if (!Array.isArray(result.values)) {
        throw new AwsEcsApiError(operation, 'INCOMPLETE_RESPONSE');
      }
      values.push(...result.values);
      nextToken = result.nextToken;
      if (!nextToken) return values;
    }
    throw new AwsEcsApiError(operation, 'PAGE_CAP_EXCEEDED');
  }
}

function safeAwsError(error: unknown, operation: string): Error {
  if (error instanceof AwsEcsApiError) return error;
  const code = (
    error
    && typeof error === 'object'
    && typeof (error as { name?: unknown }).name === 'string'
  )
    ? (error as { name: string }).name
    : 'UNKNOWN';
  return new AwsEcsApiError(operation, code);
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function roleName(roleArn: string): string {
  return roleArn.split('/').at(-1)!;
}

function taskFamilyFromArn(taskDefinitionArn: string): string {
  return taskDefinitionArn.split(':task-definition/')[1]?.split(':')[0] ?? '';
}

interface IamTrustStatement {
  Effect?: unknown;
  Action?: unknown;
  Principal?: {
    Service?: unknown;
  };
}

function parseIamPolicyDocument(
  value: string | undefined
): {
  Statement?: IamTrustStatement[] | IamTrustStatement;
} | null {
  if (!value) return null;
  for (const candidate of [value, safeDecodeURIComponent(value)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Try the URL-decoded IAM document before treating it as incomplete.
    }
  }
  return null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
