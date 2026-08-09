import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
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

function environment(platformBindings: Record<string, unknown> = {
  provider: 'ecs',
  projectId: CLUSTER_ARN,
  environmentId: CLUSTER_ARN,
  services: {},
}): Environment {
  return {
    id: 'environment-local',
    projectId: 'project-local',
    name: 'production',
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

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

function service(): Service {
  return {
    id: 'service-local',
    projectId: 'project-local',
    name: 'web',
    buildConfig: {
      builder: 'dockerfile',
      workloadKind: 'web',
      startCommand: 'node server.mjs',
      healthCheckPath: '/health',
      public: true,
    },
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('EcsExpressAdapter lifecycle boundaries', () => {
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

  it('does not create a replacement for a missing bound cluster', async () => {
    const calls: string[] = [];
    const adapter = await adapterWithSend(async (command) => {
      const name = commandName(command);
      calls.push(name);
      if (name === 'DescribeClustersCommand') {
        return { failures: [{ arn: CLUSTER_ARN, reason: 'MISSING' }], clusters: [] };
      }
      throw new Error(`Unexpected ${name}`);
    });

    const receipt = await adapter.ensureProject('app', environment());

    expect(receipt).toMatchObject({ success: false });
    expect(receipt.error).toContain('will not create a replacement');
    expect(calls).toEqual(['DescribeClustersCommand']);
  });

  it('preserves unknown observation failures and performs no mutations', async () => {
    const calls: string[] = [];
    const adapter = await adapterWithSend(async (command) => {
      const name = commandName(command);
      calls.push(name);
      if (name === 'DescribeClustersCommand') {
        const error = new Error('AWS throttled cluster observation');
        error.name = 'ThrottlingException';
        throw error;
      }
      throw new Error(`Unexpected ${name}`);
    });

    const receipt = await adapter.ensureProject('app', environment());

    expect(receipt).toMatchObject({ success: false });
    expect(receipt.error).toContain('throttled cluster observation');
    expect(calls.some((name) => /^(Create|Update|Delete|Attach|Detach|Tag|Modify|Add|Remove)/.test(name))).toBe(false);
  });

  it('refuses to delete an exact but unowned service binding', async () => {
    const calls: string[] = [];
    const adapter = await adapterWithSend(async (command) => {
      const name = commandName(command);
      calls.push(name);
      if (name === 'DescribeExpressGatewayServiceCommand') {
        return {
          service: {
            cluster: CLUSTER_ARN,
            serviceArn: SERVICE_ARN,
            tags: [{ key: 'managed-by', value: 'someone-else' }],
          },
        };
      }
      throw new Error(`Unexpected ${name}`);
    });

    const result = await adapter.deleteService(SERVICE_ARN);

    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('not Hypervibe-managed');
    expect(calls).toEqual(['DescribeExpressGatewayServiceCommand']);
  });

  it('creates, observes without mutation, and dependency-orders exact project teardown', async () => {
    const tags = [
      { key: 'managed-by', value: 'hypervibe' },
      { key: 'hypervibe-environment-id', value: 'environment-local' },
    ];
    const iamTags = tags.map(({ key, value }) => ({ Key: key, Value: value }));
    const calls: string[] = [];
    let clusterArn: string | null = null;
    let repository: { name: string; arn: string; uri: string } | null = null;
    let expressService: Record<string, any> | null = null;
    const roles = new Map<string, { arn: string; policies: Set<string> }>();
    const adapter = await adapterWithSend(async (command) => {
      const name = commandName(command);
      const input = (command as { input: Record<string, any> }).input;
      calls.push(name);
      switch (name) {
        case 'ListClustersCommand':
          return { clusterArns: clusterArn ? [clusterArn] : [] };
        case 'DescribeClustersCommand':
          return clusterArn
            ? { clusters: [{ clusterArn, status: 'ACTIVE', tags }] }
            : { clusters: [], failures: [{ arn: input.clusters[0], reason: 'MISSING' }] };
        case 'DescribeVpcsCommand':
          return { Vpcs: [{ VpcId: 'vpc-default', IsDefault: true }] };
        case 'DescribeRepositoriesCommand': {
          if (!repository) {
            const error = new Error('absent');
            error.name = 'RepositoryNotFoundException';
            throw error;
          }
          return { repositories: [{ repositoryName: repository.name, repositoryArn: repository.arn, repositoryUri: repository.uri }] };
        }
        case 'CreateRepositoryCommand': {
          const nameValue = String(input.repositoryName);
          repository = {
            name: nameValue,
            arn: `arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/${nameValue}`,
            uri: `${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${nameValue}`,
          };
          return { repository: { repositoryName: repository.name, repositoryArn: repository.arn, repositoryUri: repository.uri } };
        }
        case 'ListTagsForResourceCommand':
          return { tags: iamTags };
        case 'GetRoleCommand': {
          const role = roles.get(String(input.RoleName));
          if (!role) {
            const error = new Error('absent');
            error.name = 'NoSuchEntity';
            throw error;
          }
          return { Role: { RoleName: input.RoleName, Arn: role.arn, Tags: iamTags } };
        }
        case 'CreateRoleCommand': {
          const roleName = String(input.RoleName);
          const arn = `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`;
          roles.set(roleName, { arn, policies: new Set() });
          return { Role: { RoleName: roleName, Arn: arn, Tags: iamTags } };
        }
        case 'ListAttachedRolePoliciesCommand':
          return { AttachedPolicies: [...(roles.get(String(input.RoleName))?.policies ?? [])].map((PolicyArn) => ({ PolicyArn })) };
        case 'AttachRolePolicyCommand':
          roles.get(String(input.RoleName))!.policies.add(String(input.PolicyArn));
          return {};
        case 'TagRoleCommand':
          return {};
        case 'CreateClusterCommand':
          clusterArn = `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${input.clusterName}`;
          return { cluster: { clusterArn, clusterName: input.clusterName, status: 'ACTIVE', tags } };
        case 'ListServicesCommand':
          return { serviceArns: expressService ? [expressService.serviceArn] : [] };
        case 'CreateExpressGatewayServiceCommand': {
          const serviceArn = String(input.cluster).replace(':cluster/', ':service/') + `/${input.serviceName}`;
          const revisionArn = `${serviceArn}:revision/1`;
          expressService = {
            cluster: input.cluster,
            serviceArn,
            serviceName: input.serviceName,
            status: { statusCode: 'ACTIVE' },
            currentDeployment: revisionArn,
            activeConfigurations: [{
              serviceRevisionArn: revisionArn,
              executionRoleArn: input.executionRoleArn,
              cpu: input.cpu,
              memory: input.memory,
              healthCheckPath: input.healthCheckPath,
              primaryContainer: input.primaryContainer,
              scalingTarget: input.scalingTarget,
              ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'https://web.ecs.us-west-2.on.aws' }],
              createdAt: new Date(),
            }],
            tags: input.tags,
          };
          return { service: expressService };
        }
        case 'DescribeExpressGatewayServiceCommand': {
          if (!expressService) {
            const error = new Error('absent');
            error.name = 'ResourceNotFoundException';
            throw error;
          }
          return { service: expressService };
        }
        case 'DeleteExpressGatewayServiceCommand':
          expressService = null;
          return {};
        case 'DeleteClusterCommand':
          clusterArn = null;
          return {};
        case 'DeleteRepositoryCommand':
          repository = null;
          return {};
        case 'DetachRolePolicyCommand':
          roles.get(String(input.RoleName))?.policies.delete(String(input.PolicyArn));
          return {};
        case 'DeleteRoleCommand':
          roles.delete(String(input.RoleName));
          return {};
        default:
          throw new Error(`Unexpected ${name}`);
      }
    });

    const created = await adapter.ensureProject('app', environment({}));
    expect(created).toMatchObject({ success: true, data: { created: true } });
    const projectId = String(created.data?.projectId);
    expect(projectId).toBe(clusterArn);
    expect(repository).not.toBeNull();
    expect(roles.size).toBe(2);
    expect(calls.indexOf('CreateClusterCommand')).toBeGreaterThan(calls.indexOf('CreateRepositoryCommand'));
    expect(calls.indexOf('CreateClusterCommand')).toBeGreaterThan(calls.lastIndexOf('CreateRoleCommand'));

    const bound = environment({
      provider: 'ecs',
      projectId,
      environmentId: projectId,
      services: {},
    });
    const deployed = await adapter.deploy(service(), bound, { APP_MODE: 'test' }, { deferDeployment: true });
    expect(deployed).toMatchObject({
      status: 'configured',
      receipt: { success: true, data: { createdService: true } },
    });
    const serviceId = String(deployed.externalId);
    const mutationCount = calls.filter((name) => /^(Create|Update|Delete|Attach|Detach|Tag|Modify|Add|Remove)/.test(name)).length;
    await expect(adapter.observe(environment({
      provider: 'ecs',
      projectId,
      environmentId: projectId,
      services: { web: { serviceId } },
    }))).resolves.toMatchObject({
      projectExists: true,
      services: [{ name: 'web', externalId: serviceId, status: 'empty' }],
    });
    expect(calls.filter((name) => /^(Create|Update|Delete|Attach|Detach|Tag|Modify|Add|Remove)/.test(name))).toHaveLength(mutationCount);

    await expect(adapter.deleteService(serviceId)).resolves.toEqual({ success: true });
    expect(expressService).toBeNull();
    const destroyed = await adapter.deleteProject(projectId);
    expect(destroyed).toEqual({ success: true });
    expect(clusterArn).toBeNull();
    expect(repository).toBeNull();
    expect(roles.size).toBe(0);
    expect(calls.indexOf('DeleteClusterCommand')).toBeLessThan(calls.indexOf('DeleteRepositoryCommand'));
    expect(calls.indexOf('DeleteClusterCommand')).toBeLessThan(calls.indexOf('DeleteRoleCommand'));
  });
});
