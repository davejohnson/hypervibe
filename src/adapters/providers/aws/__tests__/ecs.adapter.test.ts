import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisterTaskDefinitionCommandInput } from '@aws-sdk/client-ecs';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
import { EcsFargateAdapter } from '../ecs.adapter.js';

const ACCOUNT_ID = '123456789012';
const REGION = 'us-west-2';
const PROJECT_ID = 'project-local';
const ENVIRONMENT_NAME = 'production';
const PROJECT_HASH =
  createHash('sha256').update(PROJECT_ID).digest('hex').slice(0, 8);
const ENVIRONMENT_HASH =
  createHash('sha256').update(ENVIRONMENT_NAME).digest('hex').slice(0, 8);
const CLUSTER_NAME = `hv-${PROJECT_HASH}-${ENVIRONMENT_HASH}`;
const CLUSTER_ARN =
  `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}`;
const SERVICE_NAME =
  `hv-${createHash('sha256').update(PROJECT_ID).digest('hex').slice(0, 7)}`
  + `-${createHash('sha256').update(ENVIRONMENT_NAME).digest('hex').slice(0, 6)}`
  + `-${createHash('sha256').update('web').digest('hex').slice(0, 8)}`;
const SERVICE_ARN =
  `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/${CLUSTER_NAME}/${SERVICE_NAME}`;
const FAMILY = SERVICE_NAME;
const TASK_ARN =
  `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${FAMILY}:1`;
const NEXT_TASK_ARN =
  `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${FAMILY}:2`;
const REPOSITORY_ARN =
  `arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/hypervibe/app`;
const REPOSITORY_URI =
  `${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/hypervibe/app`;
const TARGET_GROUP_ARN =
  `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:targetgroup/hv-web/abcdef0123456789`;
const LOAD_BALANCER_URL = 'https://app.example.com';
const CLIENT_SECRET = 'aws-client-secret-never-output';
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const DEPLOY_SHA = 'b'.repeat(40);

const credentials = {
  accessKeyId: 'AKIAEXAMPLE12345678',
  secretAccessKey: CLIENT_SECRET,
  region: REGION,
  ecrRepositoryArn: REPOSITORY_ARN,
  ecrRepositoryUri: REPOSITORY_URI,
  subnetIds: ['subnet-aabbcc11', 'subnet-aabbcc22'],
  securityGroupIds: ['sg-aabbcc11'],
  assignPublicIp: false,
  executionRoleArn:
    `arn:aws:iam::${ACCOUNT_ID}:role/hypervibe-ecs-execution`,
  targetGroupArn: TARGET_GROUP_ARN,
  publicUrl: LOAD_BALANCER_URL,
  containerPort: 8080,
  cpu: '256',
  memory: '512',
};

function environment(
  platformBindings: Record<string, unknown> = {}
): Environment {
  return {
    id: 'env-local',
    projectId: PROJECT_ID,
    name: ENVIRONMENT_NAME,
    platformBindings,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function service(
  overrides: Partial<Service['buildConfig']> = {}
): Service {
  return {
    id: 'service-local',
    projectId: PROJECT_ID,
    name: 'web',
    buildConfig: {
      builder: 'dockerfile',
      workloadKind: 'web',
      startCommand: 'npm start',
      healthCheckPath: '/health',
      public: true,
      ...overrides,
    },
    envVarSpec: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function binding(overrides: Record<string, unknown> = {}): string {
  return `ecs1.${Buffer.from(JSON.stringify({
    version: 1,
    serviceArn: SERVICE_ARN,
    taskFamily: FAMILY,
    containerName: 'web',
    workloadKind: 'web',
    executionRoleArn: credentials.executionRoleArn,
    cpu: credentials.cpu,
    memory: credentials.memory,
    containerPort: credentials.containerPort,
    subnetIds: credentials.subnetIds,
    securityGroupIds: credentials.securityGroupIds,
    assignPublicIp: credentials.assignPublicIp,
    targetGroupArn: TARGET_GROUP_ARN,
    url: LOAD_BALANCER_URL,
    ...overrides,
  })).toString('base64url')}`;
}

function platformBindings(
  serviceBinding = binding()
): Record<string, unknown> {
  return {
    provider: 'ecs',
    projectId: CLUSTER_ARN,
    services: {
      web: { serviceId: serviceBinding },
    },
  };
}

function taskDefinition(params: {
  arn?: string;
  family?: string;
  image?: string;
  environment?: Array<{ name: string; value: string }>;
} = {}): Record<string, unknown> {
  return {
    taskDefinitionArn: params.arn ?? TASK_ARN,
    family: params.family ?? FAMILY,
    status: 'ACTIVE',
    revision: params.arn === NEXT_TASK_ARN ? 2 : 1,
    taskRoleArn: undefined,
    executionRoleArn: credentials.executionRoleArn,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '256',
    memory: '512',
    runtimePlatform: {
      cpuArchitecture: 'X86_64',
      operatingSystemFamily: 'LINUX',
    },
    containerDefinitions: [{
      name: 'web',
      image:
        params.image
        ?? `${REPOSITORY_URI}@${IMAGE_DIGEST}`,
      essential: true,
      entryPoint: ['/bin/sh', '-lc'],
      command: ['exec sh -lc "$HYPERVIBE_START_COMMAND"'],
      environment: params.environment ?? [
        { name: 'HYPERVIBE_START_COMMAND', value: 'npm start' },
        { name: 'HYPERVIBE_HEALTH_CHECK_PATH', value: '/health' },
        { name: 'HYPERVIBE_DEPLOY_SHA', value: DEPLOY_SHA },
        { name: 'HYPERVIBE_IMAGE_DIGEST', value: IMAGE_DIGEST },
        { name: 'OLD_KEY', value: 'preserved-secret-value' },
        { name: 'PORT', value: '8080' },
      ],
      portMappings: [{
        name: 'http',
        containerPort: 8080,
        hostPort: 8080,
        protocol: 'tcp',
        appProtocol: 'http',
      }],
    }],
  };
}

function ecsService(params: {
  taskArn?: string;
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  status?: string;
  rolloutState?: string;
} = {}): Record<string, unknown> {
  const desiredCount = params.desiredCount ?? 1;
  const taskArn = params.taskArn ?? TASK_ARN;
  return {
    clusterArn: CLUSTER_ARN,
    serviceArn: SERVICE_ARN,
    serviceName: SERVICE_NAME,
    status: params.status ?? 'ACTIVE',
    taskDefinition: taskArn,
    desiredCount,
    runningCount: params.runningCount ?? desiredCount,
    pendingCount: params.pendingCount ?? 0,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: credentials.subnetIds,
        securityGroups: credentials.securityGroupIds,
        assignPublicIp: 'DISABLED',
      },
    },
    loadBalancers: [{
      targetGroupArn: TARGET_GROUP_ARN,
      containerName: 'web',
      containerPort: 8080,
    }],
    deployments: [{
      status: 'PRIMARY',
      taskDefinition: taskArn,
      rolloutState: params.rolloutState ?? 'COMPLETED',
      desiredCount,
      runningCount: params.runningCount ?? desiredCount,
      pendingCount: params.pendingCount ?? 0,
    }],
  };
}

function prerequisites(): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    repository: {
      repositoryArn: REPOSITORY_ARN,
      repositoryUri: REPOSITORY_URI,
      registryId: ACCOUNT_ID,
    },
    vpcId: 'vpc-aabbcc11',
    targetGroup: {
      TargetGroupArn: TARGET_GROUP_ARN,
      TargetType: 'ip',
      VpcId: 'vpc-aabbcc11',
      Protocol: 'HTTP',
      HealthCheckPath: '/health',
    },
    loadBalancer: {
      DNSName: 'hv.example.elb.amazonaws.com',
    },
    loadBalancerProtocol: 'https',
    publicUrl: LOAD_BALANCER_URL,
  };
}

async function connectedAdapter(
  client: Record<string, unknown>
): Promise<EcsFargateAdapter> {
  const adapter = new EcsFargateAdapter();
  await adapter.connect(credentials);
  (adapter as unknown as { client: Record<string, unknown> }).client = {
    accountId: () => ACCOUNT_ID,
    repositoryUri: () => REPOSITORY_URI,
    listClusters: async () => [{
      clusterArn: CLUSTER_ARN,
      clusterName: CLUSTER_NAME,
      status: 'ACTIVE',
    }],
    listServices: async () => [],
    ...client,
  };
  return adapter;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('EcsFargateAdapter', () => {
  it('creates and binds only the deterministic ECS cluster for the project action', async () => {
    const createCluster = vi.fn(async () => ({
      clusterArn: CLUSTER_ARN,
      clusterName: CLUSTER_NAME,
      status: 'ACTIVE',
    }));
    const adapter = await connectedAdapter({
      listClusters: vi.fn(async () => []),
      createCluster,
      getCluster: vi.fn(async () => ({
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      })),
    });

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      environment()
    );

    expect(receipt.success).toBe(true);
    expect(receipt.data).toMatchObject({
      projectId: CLUSTER_ARN,
      created: true,
    });
    expect(createCluster).toHaveBeenCalledWith(
      CLUSTER_NAME,
      expect.arrayContaining([
        { key: 'hypervibe-managed', value: 'true' },
      ])
    );
  });

  it('preserves the anticipated cluster identity when create outcome is unknown', async () => {
    const adapter = await connectedAdapter({
      listClusters: vi.fn(async () => []),
      createCluster: vi.fn(async () => {
        throw new Error('connection closed after request transmission');
      }),
    });

    const receipt = await adapter.ensureProject(
      'invoice-perfect',
      environment()
    );

    expect(receipt.success).toBe(false);
    expect(receipt.data).toMatchObject({
      projectId: CLUSTER_ARN,
      mutationAttempted: true,
    });
  });

  it('creates a zero-task bootstrap service without deploying application code', async () => {
    let registeredInput: RegisterTaskDefinitionCommandInput | undefined;
    const zeroService = ecsService({
      desiredCount: 0,
      runningCount: 0,
    });
    const createService = vi.fn(async () => zeroService);
    const bootstrapTask = taskDefinition({
      image: 'public.ecr.aws/docker/library/alpine:3.20',
    });
    const adapter = await connectedAdapter({
      getCluster: vi.fn(async () => ({
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      })),
      verifyPrerequisites: vi.fn(async () => prerequisites()),
      listServices: vi.fn(async () => []),
      registerTaskDefinition: vi.fn(async (
        input: RegisterTaskDefinitionCommandInput
      ) => {
        registeredInput = input;
        return bootstrapTask;
      }),
      createService,
      getService: vi.fn(async () => zeroService),
      getTaskDefinition: vi.fn(async () => bootstrapTask),
    });

    const result = await adapter.deploy(
      service(),
      environment({
        provider: 'ecs',
        projectId: CLUSTER_ARN,
        services: {},
      }),
      { DATABASE_URL: 'postgres://secret', PORT: '8080' },
      { deferDeployment: true }
    );

    expect(result.status).toBe('configured');
    expect(result.externalId).toMatch(/^ecs1\./);
    expect(result.url).toBe(LOAD_BALANCER_URL);
    expect(result.receipt.data).toMatchObject({
      ecsServiceArn: SERVICE_ARN,
      createdService: true,
      deploymentDeferred: true,
      pendingImage: true,
    });
    expect(registeredInput).toMatchObject({
      family: FAMILY,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      containerDefinitions: [{
        name: 'web',
        image: 'public.ecr.aws/docker/library/alpine:3.20',
        entryPoint: ['/bin/sh', '-lc'],
        command: ['while true; do sleep 3600; done'],
      }],
    });
    expect(JSON.stringify(registeredInput)).toContain('postgres://secret');
    expect(createService).toHaveBeenCalledWith(expect.objectContaining({
      clientToken: expect.stringMatching(/^[a-f0-9]{32}$/),
      desiredCount: 0,
      taskDefinition: TASK_ARN,
    }));
    expect(JSON.stringify(result)).not.toContain('postgres://secret');
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });

  it('preserves the deterministic service binding when create outcome is unknown', async () => {
    const bootstrapTask = taskDefinition({
      image: 'public.ecr.aws/docker/library/alpine:3.20',
    });
    const adapter = await connectedAdapter({
      getCluster: vi.fn(async () => ({
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      })),
      verifyPrerequisites: vi.fn(async () => prerequisites()),
      listServices: vi.fn(async () => []),
      registerTaskDefinition: vi.fn(async () => bootstrapTask),
      createService: vi.fn(async () => {
        throw new Error('connection closed after request transmission');
      }),
    });

    const result = await adapter.deploy(
      service(),
      environment({
        provider: 'ecs',
        projectId: CLUSTER_ARN,
        services: {},
      }),
      {}
    );

    expect(result.status).toBe('failed');
    expect(result.externalId).toMatch(/^ecs1\./);
    expect(result.receipt.data).toMatchObject({
      ecsServiceArn: SERVICE_ARN,
      taskDefinitionArn: TASK_ARN,
      createdService: true,
      mutationAttempted: true,
    });
  });

  it('blocks target-group reuse by a service in another ECS cluster', async () => {
    const otherClusterArn =
      `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/other-cluster`;
    const registerTaskDefinition = vi.fn();
    const adapter = await connectedAdapter({
      getCluster: vi.fn(async () => ({
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      })),
      verifyPrerequisites: vi.fn(async () => prerequisites()),
      listClusters: vi.fn(async () => [
        {
          clusterArn: CLUSTER_ARN,
          clusterName: CLUSTER_NAME,
          status: 'ACTIVE',
        },
        {
          clusterArn: otherClusterArn,
          clusterName: 'other-cluster',
          status: 'ACTIVE',
        },
      ]),
      listServices: vi.fn(async (clusterArn: string) =>
        clusterArn === otherClusterArn
          ? [{
              ...ecsService(),
              clusterArn: otherClusterArn,
              serviceArn:
                `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/other-cluster/existing`,
              serviceName: 'existing',
            }]
          : []),
      registerTaskDefinition,
    });

    const result = await adapter.deploy(
      service(),
      environment({
        provider: 'ecs',
        projectId: CLUSTER_ARN,
        services: {},
      }),
      {}
    );

    expect(result.status).toBe('failed');
    expect(result.receipt.error).toContain(
      'already attached to ECS services'
    );
    expect(registerTaskDefinition).not.toHaveBeenCalled();
  });

  it('updates config by immutable task revision while preserving image and omitted variables', async () => {
    let registeredInput: RegisterTaskDefinitionCommandInput | undefined;
    const currentService = ecsService();
    const nextService = ecsService({ taskArn: NEXT_TASK_ARN });
    const currentTask = taskDefinition();
    const nextTask = taskDefinition({ arn: NEXT_TASK_ARN });
    const adapter = await connectedAdapter({
      getCluster: vi.fn(async () => ({
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      })),
      verifyPrerequisites: vi.fn(async () => prerequisites()),
      getService: vi.fn(async () => currentService),
      getTaskDefinition: vi.fn(async (arn: string) =>
        arn === NEXT_TASK_ARN ? nextTask : currentTask
      ),
      registerTaskDefinition: vi.fn(async (
        input: RegisterTaskDefinitionCommandInput
      ) => {
        registeredInput = input;
        return nextTask;
      }),
      updateService: vi.fn(async () => nextService),
    });
    (adapter as unknown as { client: { getService: ReturnType<typeof vi.fn> } })
      .client.getService
      .mockResolvedValueOnce(currentService)
      .mockResolvedValue(nextService);

    const result = await adapter.deploy(
      service({ startCommand: 'node server.js' }),
      environment(platformBindings()),
      { NEW_KEY: 'new-value' },
      { deferDeployment: true }
    );

    expect(result.status).toBe('configured');
    const container = registeredInput?.containerDefinitions?.[0];
    expect(container?.image).toContain('@sha256:');
    expect(container?.environment).toEqual(expect.arrayContaining([
      { name: 'OLD_KEY', value: 'preserved-secret-value' },
      { name: 'NEW_KEY', value: 'new-value' },
      { name: 'HYPERVIBE_START_COMMAND', value: 'node server.js' },
    ]));
  });

  it('honors explicit env deletion without touching internal release markers', async () => {
    let registeredInput: RegisterTaskDefinitionCommandInput | undefined;
    const currentService = ecsService();
    const nextService = ecsService({ taskArn: NEXT_TASK_ARN });
    const nextTask = taskDefinition({ arn: NEXT_TASK_ARN });
    const adapter = await connectedAdapter({
      getService: vi.fn()
        .mockResolvedValueOnce(currentService)
        .mockResolvedValue(nextService),
      getTaskDefinition: vi.fn(async () => taskDefinition()),
      registerTaskDefinition: vi.fn(async (
        input: RegisterTaskDefinitionCommandInput
      ) => {
        registeredInput = input;
        return nextTask;
      }),
      updateService: vi.fn(async () => nextService),
    });

    const receipt = await adapter.deleteEnvVars(
      environment(platformBindings()),
      service(),
      ['OLD_KEY', 'PORT', 'HYPERVIBE_DEPLOY_SHA']
    );

    expect(receipt.success).toBe(true);
    expect(receipt.data?.deletedKeys).toEqual(['OLD_KEY', 'PORT']);
    expect(registeredInput?.containerDefinitions?.[0]?.environment)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'OLD_KEY' }),
        expect.objectContaining({ name: 'PORT' }),
      ]));
  });

  it('observes safe hashes and exact durable bindings without mutation', async () => {
    const adapter = await connectedAdapter({
      listClusters: vi.fn(async () => [{
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      }]),
      listServices: vi.fn(async () => [ecsService()]),
      verifyPrerequisites: vi.fn(async () => prerequisites()),
      getTaskDefinition: vi.fn(async () => taskDefinition()),
    });

    const observed = await adapter.observe(
      environment(platformBindings())
    );

    expect(observed.projectId).toBe(CLUSTER_ARN);
    expect(observed.services).toEqual([
      expect.objectContaining({
        name: 'web',
        externalId: binding(),
        workloadKind: 'web',
        url: LOAD_BALANCER_URL,
        envVarKeys: ['OLD_KEY', 'PORT'],
        envVarHashes: {
          OLD_KEY: hashEnvValue('preserved-secret-value'),
          PORT: hashEnvValue('8080'),
        },
        status: 'running',
      }),
    ]);
    expect(JSON.stringify(observed)).not.toContain('preserved-secret-value');
    expect(JSON.stringify(observed)).not.toContain(CLIENT_SECRET);
  });

  it.each([
    [
      'an image outside the bound ECR repository',
      taskDefinition({ image: 'docker.io/example/unreviewed:latest' }),
      /exact managed image digest/,
    ],
    [
      'duplicate environment names',
      taskDefinition({
        environment: [
          { name: 'PORT', value: '8080' },
          { name: 'PORT', value: '9090' },
        ],
      }),
      /duplicate ECS task environment names/,
    ],
  ])('blocks observation with %s', async (
    _description,
    observedTask,
    expected
  ) => {
    const adapter = await connectedAdapter({
      listClusters: vi.fn(async () => [{
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      }]),
      listServices: vi.fn(async () => [ecsService()]),
      verifyPrerequisites: vi.fn(async () => prerequisites()),
      getTaskDefinition: vi.fn(async () => observedTask),
    });

    await expect(
      adapter.observe(environment(platformBindings()))
    ).rejects.toThrow(expected);
  });

  it('blocks unbound services in the owned cluster instead of adopting them', async () => {
    const adapter = await connectedAdapter({
      listClusters: vi.fn(async () => [{
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      }]),
      listServices: vi.fn(async () => [ecsService()]),
      verifyPrerequisites: vi.fn(async () => prerequisites()),
    });

    await expect(adapter.observe(environment({
      provider: 'ecs',
      projectId: CLUSTER_ARN,
      services: {},
    }))).rejects.toThrow(/without durable local bindings/);
  });

  it('does not clean task definitions until service deletion is terminal', async () => {
    vi.stubEnv('HYPERVIBE_AWS_ECS_SERVICE_DELETE_ATTEMPTS', '1');
    const listTaskDefinitionArns = vi.fn();
    const deleteService = vi.fn();
    const adapter = await connectedAdapter({
      getService: vi.fn(async () => ecsService({
        desiredCount: 1,
        runningCount: 1,
      })),
      updateService: vi.fn(async () => ecsService({
        desiredCount: 0,
        runningCount: 1,
      })),
      deleteService,
      listTaskDefinitionArns,
    });

    const result = await adapter.deleteService(binding());

    expect(result.success).toBe(false);
    expect(result.error).toContain('cleanup was skipped');
    expect(deleteService).not.toHaveBeenCalled();
    expect(listTaskDefinitionArns).not.toHaveBeenCalled();
  });

  it('deletes service before deregistering and deleting its task family', async () => {
    const calls: string[] = [];
    const getService = vi.fn()
      .mockResolvedValueOnce(ecsService())
      .mockResolvedValueOnce(ecsService({
        desiredCount: 0,
        runningCount: 0,
      }))
      .mockResolvedValueOnce(null);
    let activeCalls = 0;
    let inactiveCalls = 0;
    const adapter = await connectedAdapter({
      getService,
      updateService: vi.fn(async () => {
        calls.push('drain');
        return ecsService({ desiredCount: 0, runningCount: 0 });
      }),
      deleteService: vi.fn(async () => {
        calls.push('delete-service');
      }),
      listTaskDefinitionArns: vi.fn(async (
        _family: string,
        status: 'ACTIVE' | 'INACTIVE' | 'DELETE_IN_PROGRESS'
      ) => {
        if (status === 'ACTIVE') {
          activeCalls += 1;
          return activeCalls === 1 ? [TASK_ARN] : [];
        }
        inactiveCalls += 1;
        return inactiveCalls === 1 ? [TASK_ARN] : [];
      }),
      deregisterTaskDefinition: vi.fn(async () => {
        calls.push('deregister-task');
      }),
      deleteTaskDefinitions: vi.fn(async () => {
        calls.push('delete-task');
      }),
    });

    const result = await adapter.deleteService(binding());

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      'drain',
      'delete-service',
      'deregister-task',
      'delete-task',
    ]);
  });

  it('treats an already-absent service and task family as idempotent deletion', async () => {
    const deleteService = vi.fn();
    const deleteTaskDefinitions = vi.fn();
    const adapter = await connectedAdapter({
      getService: vi.fn(async () => null),
      listTaskDefinitionArns: vi.fn(async () => []),
      deregisterTaskDefinition: vi.fn(),
      deleteTaskDefinitions,
      deleteService,
    });

    await expect(adapter.deleteService(binding())).resolves.toEqual({
      success: true,
    });
    expect(deleteService).not.toHaveBeenCalled();
    expect(deleteTaskDefinitions).toHaveBeenCalledWith([]);
  });

  it('does not report success while task definitions remain DELETE_IN_PROGRESS', async () => {
    vi.stubEnv(
      'HYPERVIBE_AWS_ECS_TASK_DEFINITION_DELETE_ATTEMPTS',
      '1'
    );
    const adapter = await connectedAdapter({
      getService: vi.fn(async () => null),
      listTaskDefinitionArns: vi.fn(async (
        _family: string,
        status: 'ACTIVE' | 'INACTIVE' | 'DELETE_IN_PROGRESS'
      ) => status === 'DELETE_IN_PROGRESS' ? [TASK_ARN] : []),
      deregisterTaskDefinition: vi.fn(),
      deleteTaskDefinitions: vi.fn(),
    });

    const result = await adapter.deleteService(binding());

    expect(result.success).toBe(false);
    expect(result.error).toContain('terminal deletion checks');
  });

  it('blocks cluster deletion while any dependent service remains', async () => {
    const deleteCluster = vi.fn();
    const adapter = await connectedAdapter({
      getCluster: vi.fn(async () => ({
        clusterArn: CLUSTER_ARN,
        clusterName: CLUSTER_NAME,
        status: 'ACTIVE',
      })),
      listServices: vi.fn(async () => [ecsService()]),
      deleteCluster,
    });

    const result = await adapter.deleteProject(CLUSTER_ARN);

    expect(result.success).toBe(false);
    expect(result.error).toContain(SERVICE_ARN);
    expect(deleteCluster).not.toHaveBeenCalled();
  });

  it('blocks cron and missing start commands before any AWS request', async () => {
    const client = { getCluster: vi.fn() };
    const adapter = await connectedAdapter(client);

    const cron = await adapter.deploy(
      service({ workloadKind: 'cron', cronSchedule: '0 * * * *' }),
      environment(platformBindings()),
      {}
    );
    const missing = await adapter.deploy(
      service({ startCommand: undefined }),
      environment(platformBindings()),
      {}
    );

    expect(cron.receipt.error).toContain('EventBridge lifecycle');
    expect(missing.receipt.error).toContain('require startCommand');
    expect(client.getCluster).not.toHaveBeenCalled();
  });
});
