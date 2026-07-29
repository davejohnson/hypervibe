import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteServiceCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ListAccountSettingsCommand,
  ListClustersCommand,
} from '@aws-sdk/client-ecs';
import { DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';
import {
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
} from '@aws-sdk/client-ec2';
import {
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import {
  AwsEcsApiError,
  EcsFargateClient,
} from '../ecs.client.js';
import {
  EcsCredentialsSchema,
  type EcsCredentials,
} from '../ecs.credentials.js';

const ACCOUNT_ID = '123456789012';
const REGION = 'us-west-2';
const CLUSTER_ARN =
  `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/hv-production`;
const SERVICE_ARN =
  `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/hv-production/hv-web`;
const REPOSITORY_ARN =
  `arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/hypervibe/app`;
const REPOSITORY_URI =
  `${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/hypervibe/app`;
const TARGET_GROUP_ARN =
  `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:targetgroup/hv-web/abcdef0123456789`;
const LOAD_BALANCER_ARN =
  `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:loadbalancer/app/hv/abcdef0123456789`;
const EXECUTION_ROLE_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:role/hypervibe-ecs-execution`;
const ECS_TASK_TRUST = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Principal: { Service: 'ecs-tasks.amazonaws.com' },
    Action: 'sts:AssumeRole',
  }],
});

const credentials: EcsCredentials = {
  accessKeyId: 'AKIAEXAMPLE12345678',
  secretAccessKey: 'aws-secret',
  region: REGION,
  ecrRepositoryArn: REPOSITORY_ARN,
  ecrRepositoryUri: REPOSITORY_URI,
  subnetIds: ['subnet-aabbcc11', 'subnet-aabbcc22'],
  securityGroupIds: ['sg-aabbcc11'],
  assignPublicIp: false,
  executionRoleArn: EXECUTION_ROLE_ARN,
  targetGroupArn: TARGET_GROUP_ARN,
  publicUrl: 'https://app.example.com',
  containerPort: 8080,
  cpu: '256',
  memory: '512',
};

function mockedClient(params: {
  ecs?: (command: unknown) => Promise<unknown>;
  ecr?: (command: unknown) => Promise<unknown>;
  ec2?: (command: unknown) => Promise<unknown>;
  elbv2?: (command: unknown) => Promise<unknown>;
  iam?: (command: unknown) => Promise<unknown>;
}, clientCredentials: EcsCredentials = credentials): EcsFargateClient {
  const client = new EcsFargateClient(clientCredentials);
  const unexpected = (label: string) => async (command: unknown) => {
    throw new Error(
      `Unexpected ${label} command ${(command as { constructor?: { name?: string } }).constructor?.name}`
    );
  };
  const mutable = client as unknown as Record<
    'ecs' | 'ecr' | 'ec2' | 'elbv2' | 'iam',
    { send: (command: unknown) => Promise<unknown>; destroy: () => void }
  >;
  mutable.ecs = {
    send: params.ecs ?? unexpected('ECS'),
    destroy: vi.fn(),
  };
  mutable.ecr = {
    send: params.ecr ?? unexpected('ECR'),
    destroy: vi.fn(),
  };
  mutable.ec2 = {
    send: params.ec2 ?? unexpected('EC2'),
    destroy: vi.fn(),
  };
  mutable.elbv2 = {
    send: params.elbv2 ?? unexpected('ELBv2'),
    destroy: vi.fn(),
  };
  mutable.iam = {
    send: params.iam ?? unexpected('IAM'),
    destroy: vi.fn(),
  };
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EcsFargateClient', () => {
  it('rejects duplicate network identities and an unbound public URL', () => {
    expect(EcsCredentialsSchema.safeParse({
      ...credentials,
      subnetIds: [credentials.subnetIds[0], credentials.subnetIds[0]],
    }).success).toBe(false);
    expect(EcsCredentialsSchema.safeParse({
      ...credentials,
      targetGroupArn: undefined,
    }).success).toBe(false);
  });

  it('follows every ECS nextToken and validates unique durable cluster identities', async () => {
    const ecsSend = vi.fn(async (command: unknown) => {
      if (command instanceof ListClustersCommand) {
        return command.input.nextToken
          ? { clusterArns: [`${CLUSTER_ARN}-two`] }
          : { clusterArns: [CLUSTER_ARN], nextToken: 'next-page' };
      }
      if (command instanceof DescribeClustersCommand) {
        return {
          clusters: command.input.clusters?.map((clusterArn) => ({
            clusterArn,
            clusterName: clusterArn?.split('/').at(-1),
            status: 'ACTIVE',
          })),
          failures: [],
        };
      }
      throw new Error('unexpected');
    });
    const client = mockedClient({ ecs: ecsSend });

    await expect(client.listClusters()).resolves.toHaveLength(2);
    expect(ecsSend.mock.calls.filter(
      ([command]) => command instanceof ListClustersCommand
    )).toHaveLength(2);
  });

  it('blocks an incomplete paginated describe response instead of erasing a listed cluster', async () => {
    const client = mockedClient({
      ecs: async (command: unknown) => {
        if (command instanceof ListClustersCommand) {
          return { clusterArns: [CLUSTER_ARN] };
        }
        if (command instanceof DescribeClustersCommand) {
          return { clusters: [], failures: [] };
        }
        throw new Error('unexpected');
      },
    });

    await expect(client.listClusters()).rejects.toMatchObject({
      code: 'INCOMPLETE_RESPONSE',
    });
  });

  it('treats only a documented MISSING service failure as absence', async () => {
    const missing = mockedClient({
      ecs: async (command) => {
        if (command instanceof DescribeServicesCommand) {
          return {
            services: [],
            failures: [{ arn: SERVICE_ARN, reason: 'MISSING' }],
          };
        }
        throw new Error('unexpected');
      },
    });
    await expect(
      missing.getService(CLUSTER_ARN, SERVICE_ARN)
    ).resolves.toBeNull();

    const unknown = mockedClient({
      ecs: async (command) => {
        if (command instanceof DescribeServicesCommand) {
          return {
            services: [],
            failures: [{ arn: SERVICE_ARN, reason: 'ACCESS_DENIED' }],
          };
        }
        throw new Error('unexpected');
      },
    });
    await expect(
      unknown.getService(CLUSTER_ARN, SERVICE_ARN)
    ).rejects.toMatchObject({
      name: 'AwsEcsApiError',
      code: 'ACCESS_DENIED',
    });
  });

  it('accepts only the exact revisioned task-definition ARN returned by AWS', async () => {
    const taskDefinitionArn =
      `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/hv-web:42`;
    const client = mockedClient({
      ecs: async (command: unknown) => {
        expect(command).toBeInstanceOf(DescribeTaskDefinitionCommand);
        return {
          taskDefinition: {
            taskDefinitionArn,
            family: 'hv-web',
            revision: 42,
            status: 'ACTIVE',
          },
        };
      },
    });

    await expect(
      client.getTaskDefinition(taskDefinitionArn)
    ).resolves.toMatchObject({
      taskDefinitionArn,
      family: 'hv-web',
      revision: 42,
    });
  });

  it('blocks duplicate durable identities instead of choosing one', async () => {
    const client = mockedClient({
      ecs: async (command) => {
        if (command instanceof ListClustersCommand) {
          return { clusterArns: [CLUSTER_ARN, CLUSTER_ARN] };
        }
        if (command instanceof DescribeClustersCommand) {
          return {
            clusters: [
              {
                clusterArn: CLUSTER_ARN,
                clusterName: 'hv-production',
                status: 'ACTIVE',
              },
              {
                clusterArn: CLUSTER_ARN,
                clusterName: 'hv-production',
                status: 'ACTIVE',
              },
            ],
          };
        }
        throw new Error('unexpected');
      },
    });

    await expect(client.listClusters()).rejects.toMatchObject({
      code: 'DUPLICATE_IDENTITY',
    });
  });

  it('verifies ECR, network, IAM, target-group, and ALB scope without creating them', async () => {
    const ecsSend = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(ListAccountSettingsCommand);
      return {
        settings: [{
          name: 'serviceLongArnFormat',
          value: 'enabled',
        }],
      };
    });
    const ecrSend = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(DescribeRepositoriesCommand);
      return {
        repositories: [{
          repositoryArn: REPOSITORY_ARN,
          repositoryUri: REPOSITORY_URI,
          repositoryName: 'hypervibe/app',
          registryId: ACCOUNT_ID,
        }],
      };
    });
    const ec2Send = vi.fn(async (command: unknown) => {
      if (command instanceof DescribeSubnetsCommand) {
        return {
          Subnets: credentials.subnetIds.map((SubnetId) => ({
            SubnetId,
            VpcId: 'vpc-aabbcc11',
          })),
        };
      }
      if (command instanceof DescribeSecurityGroupsCommand) {
        return {
          SecurityGroups: [{
            GroupId: 'sg-aabbcc11',
            VpcId: 'vpc-aabbcc11',
          }],
        };
      }
      throw new Error('unexpected');
    });
    const iamSend = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetRoleCommand);
      return {
        Role: {
          Arn: EXECUTION_ROLE_ARN,
          AssumeRolePolicyDocument: ECS_TASK_TRUST,
        },
      };
    });
    const elbv2Send = vi.fn(async (command: unknown) => {
      if (command instanceof DescribeTargetGroupsCommand) {
        return {
          TargetGroups: [{
            TargetGroupArn: TARGET_GROUP_ARN,
            TargetType: 'ip',
            VpcId: 'vpc-aabbcc11',
            Protocol: 'HTTP',
            HealthCheckPath: '/health',
            LoadBalancerArns: [LOAD_BALANCER_ARN],
          }],
        };
      }
      if (command instanceof DescribeLoadBalancersCommand) {
        return {
          LoadBalancers: [{
            LoadBalancerArn: LOAD_BALANCER_ARN,
            VpcId: 'vpc-aabbcc11',
            DNSName: 'hv.example.elb.amazonaws.com',
            State: { Code: 'active' },
            Type: 'application',
            Scheme: 'internet-facing',
          }],
        };
      }
      if (command instanceof DescribeListenersCommand) {
        return command.input.Marker
          ? {
              Listeners: [{
                ListenerArn:
                  `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:listener/app/hv/abcdef0123456789/https`,
                Protocol: 'HTTPS',
                Port: 443,
              }],
            }
          : {
              Listeners: [{
                ListenerArn:
                  `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:listener/app/hv/abcdef0123456789/http`,
                Protocol: 'HTTP',
                Port: 80,
              }],
              NextMarker: 'next-listener-page',
            };
      }
      if (command instanceof DescribeRulesCommand) {
        return {
          Rules: [{
            Actions: [{
              Type: 'forward',
              TargetGroupArn: command.input.ListenerArn?.endsWith('/https')
                ? TARGET_GROUP_ARN
                : `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:targetgroup/other/abcdef0123456789`,
            }],
          }],
        };
      }
      throw new Error('unexpected');
    });
    const client = mockedClient({
      ecs: ecsSend,
      ecr: ecrSend,
      ec2: ec2Send,
      elbv2: elbv2Send,
      iam: iamSend,
    });

    await expect(client.verifyPrerequisites()).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      vpcId: 'vpc-aabbcc11',
      loadBalancerProtocol: 'https',
      publicUrl: 'https://app.example.com',
      loadBalancer: { DNSName: 'hv.example.elb.amazonaws.com' },
    });
    expect(ecsSend).toHaveBeenCalledTimes(1);
    expect(elbv2Send.mock.calls.filter(
      ([command]) => command instanceof DescribeListenersCommand
    )).toHaveLength(2);
  });

  it('passes only the final IAM role name while preserving exact path-scoped ARN validation', async () => {
    const pathRoleArn =
      `arn:aws:iam::${ACCOUNT_ID}:role/hypervibe/ecs-execution`;
    const pathCredentials: EcsCredentials = {
      ...credentials,
      executionRoleArn: pathRoleArn,
      targetGroupArn: undefined,
    };
    const iamSend = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetRoleCommand);
      expect((command as GetRoleCommand).input.RoleName).toBe(
        'ecs-execution'
      );
      return {
        Role: {
          Arn: pathRoleArn,
          AssumeRolePolicyDocument: encodeURIComponent(ECS_TASK_TRUST),
        },
      };
    });
    const client = mockedClient({
      ecs: async () => ({
        settings: [{ name: 'serviceLongArnFormat', value: 'enabled' }],
      }),
      ecr: async () => ({
        repositories: [{
          repositoryArn: REPOSITORY_ARN,
          repositoryUri: REPOSITORY_URI,
          repositoryName: 'hypervibe/app',
          registryId: ACCOUNT_ID,
        }],
      }),
      ec2: async (command: unknown) => (
        command instanceof DescribeSubnetsCommand
          ? {
              Subnets: credentials.subnetIds.map((SubnetId) => ({
                SubnetId,
                VpcId: 'vpc-aabbcc11',
              })),
            }
          : {
              SecurityGroups: [{
                GroupId: 'sg-aabbcc11',
                VpcId: 'vpc-aabbcc11',
              }],
            }
      ),
      iam: iamSend,
    }, pathCredentials);

    await expect(client.verifyPrerequisites()).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      vpcId: 'vpc-aabbcc11',
    });
    expect(iamSend).toHaveBeenCalledTimes(1);
  });

  it('keeps SDK response details out of safe errors', async () => {
    const client = mockedClient({
      ecs: async () => {
        const error = new Error('provider response contains secret-value');
        error.name = 'AccessDeniedException';
        throw error;
      },
    });

    const error = await client.listClusters().catch((value) => value);
    expect(error).toBeInstanceOf(AwsEcsApiError);
    expect(String(error)).not.toContain('secret-value');
  });

  it('issues only the exact reviewed service deletion command', async () => {
    const ecsSend = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(DeleteServiceCommand);
      return {};
    });
    const client = mockedClient({ ecs: ecsSend });

    await client.deleteService(CLUSTER_ARN, SERVICE_ARN);
    const command = ecsSend.mock.calls[0]![0] as DeleteServiceCommand;
    expect(command.input).toEqual({
      cluster: CLUSTER_ARN,
      service: SERVICE_ARN,
      force: false,
    });
  });
});
