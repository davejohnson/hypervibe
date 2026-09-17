import { describe, expect, it, vi } from 'vitest';
import * as ecsSdk from '@aws-sdk/client-ecs';
import * as ecrSdk from '@aws-sdk/client-ecr';
import { buildEcsExpressGitHubActionsSteps } from '../ecs-express-ci.workflow.js';
import { buildEcsExpressPortableRuntime } from '../ecs-express-ci.recipe.js';
import { extractGitHubScript } from '../../../../domain/services/__tests__/managed-ci-workflow.test-utils.js';

// Executes generated JavaScript with actual SDK command serialization. Only
// HTTP transport, runner files, Docker execution and public health are synthetic.
// Official contract: https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateExpressGatewayService.html
// BYO taskDefinitionArn excludes primaryContainer/executionRoleArn/taskRoleArn/cpu/memory.
const cluster = 'arn:aws:ecs:us-west-2:123456789012:cluster/staging';
const serviceArn = cluster.replace(':cluster/', ':service/') + '/web';
const taskPrefix = 'arn:aws:ecs:us-west-2:123456789012:task-definition/web:';
const image = '123456789012.dkr.ecr.us-west-2.amazonaws.com/hypervibe/staging@sha256:' + 'b'.repeat(64);
const sha = 'a'.repeat(40);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

function fixture(kind: 'github' | 'portable', options: { denyTask?: boolean; missingMain?: boolean; wrongFamily?: boolean; corruptRegisteredVolume?: boolean; rollback?: boolean; lostRegistration?: boolean } = {}) {
  const releaseSha = options.rollback ? 'e'.repeat(40) : sha;
  const releaseImage = options.rollback ? image.replace('b'.repeat(64), 'f'.repeat(64)) : image;
  const releaseDigest = releaseImage.split('@')[1];
  const requests: Array<{ operation: string; body: any }> = [];
  const original = {
    taskDefinitionArn: taskPrefix + '1', family: options.wrongFamily ? 'another-family' : 'web', revision: 1, status: 'ACTIVE', registeredAt: 1700000000,
    taskRoleArn: 'arn:aws:iam::123456789012:role/runtime-efs', executionRoleArn: 'arn:aws:iam::123456789012:role/execution',
    requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', cpu: '256', memory: '512',
    volumes: [{ name: 'data', efsVolumeConfiguration: { fileSystemId: 'fs-12345678', transitEncryption: 'ENABLED', authorizationConfig: { accessPointId: 'fsap-12345678', iam: 'ENABLED' } } }],
    containerDefinitions: [
      { name: options.missingMain ? 'other' : 'Main', image: 'registry/original@sha256:' + 'c'.repeat(64), essential: true, portMappings: [{ containerPort: 8080, name: 'http', protocol: 'tcp' }], mountPoints: [{ sourceVolume: 'data', containerPath: '/data', readOnly: false }], environment: [{ name: 'EXISTING', value: 'retained' }], command: ['node', 'server.mjs'] },
      { name: 'sidecar', image: 'registry/sidecar@sha256:' + 'd'.repeat(64), essential: false },
    ],
  };
  let registered: any;
  let selectedArn = original.taskDefinitionArn;
  const response = (body: unknown, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: new TextEncoder().encode(JSON.stringify(body)) } });
  const handler = { handle: async (request: any) => {
    const operation = request.headers['x-amz-target'].split('.').at(-1);
    const body = JSON.parse(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
    requests.push({ operation, body });
    if (operation === 'DescribeExpressGatewayService') return response({ service: { serviceArn, cluster, currentDeployment: 'revision', status: { statusCode: 'ACTIVE' }, activeConfigurations: [{
      serviceRevisionArn: 'revision', taskDefinitionArn: selectedArn,
      networkConfiguration: { subnets: ['subnet-1', 'subnet-2'], securityGroups: ['sg-1'] }, scalingTarget: { minTaskCount: 1, maxTaskCount: 1 },
      ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'https://app.example.test' }],
    }] } });
    if (operation === 'DescribeTaskDefinition') {
      if (options.denyTask) return response({ __type: 'AccessDeniedException', message: 'denied' }, 400);
      if (body.taskDefinition === original.taskDefinitionArn) return response({ taskDefinition: original, tags: [{ key: 'owned', value: 'preserve' }] });
      if (body.taskDefinition === registered?.taskDefinitionArn) return response({ taskDefinition: registered, tags: [{ key: 'owned', value: 'preserve' }] });
      throw new Error('Unexpected task definition read');
    }
    if (operation === 'RegisterTaskDefinition') {
      if (options.lostRegistration) return response({ __type: 'ServerException', message: 'response lost after possible registration' }, 500);
      registered = { ...body, taskDefinitionArn: taskPrefix + '2', revision: 2, status: 'ACTIVE' };
      if (options.corruptRegisteredVolume) registered.volumes = [];
      return response({ taskDefinition: registered });
    }
    if (operation === 'UpdateExpressGatewayService') {
      expect(body.taskDefinitionArn).toBe(taskPrefix + '2');
      for (const key of ['primaryContainer', 'taskRoleArn', 'executionRoleArn', 'cpu', 'memory']) expect(body).not.toHaveProperty(key);
      selectedArn = body.taskDefinitionArn;
      return response({ service: { serviceArn } });
    }
    if (operation === 'DescribeRepositories') return response({ repositories: [{ repositoryName: 'hypervibe/staging', registryId: '123456789012' }] });
    if (operation === 'GetAuthorizationToken') return response({ authorizationData: [{ authorizationToken: Buffer.from('AWS:synthetic-password').toString('base64'), proxyEndpoint: 'https://123456789012.dkr.ecr.us-west-2.amazonaws.com' }] });
    if (operation === 'DescribeImages') return response({ imageDetails: [{ imageDigest: releaseDigest, imageTags: [releaseSha] }] });
    throw new Error('Unexpected SDK operation ' + operation);
  } };
  const clientOptions = { region: 'us-west-2', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 3, requestHandler: handler };
  const clients = {
    '@aws-sdk/client-ecs': { ...ecsSdk, ECSClient: class extends ecsSdk.ECSClient { constructor(config: any = {}) { super({ ...clientOptions, ...config }); } } },
    '@aws-sdk/client-ecr': { ...ecrSdk, ECRClient: class extends ecrSdk.ECRClient { constructor() { super(clientOptions); } } },
  };
  const files = new Map([['.hypervibe-deploy-sha', releaseSha], ['.hypervibe-image-uri', 'gitlab.example.test/app:' + releaseSha]]);
  const requireFixture = (module: string) => {
    if (module === 'node:fs') return { readFileSync: (file: string) => files.get(file), writeFileSync: (file: string, body: string) => files.set(file, body) };
    if (module === 'node:child_process') return { execFileSync: vi.fn() };
    if (module in clients) return clients[module as keyof typeof clients];
    throw new Error('Unexpected module ' + module);
  };
  const env = {
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_ECS_CLUSTER_ARN: cluster, AWS_ECS_EXPRESS_SERVICE_ARNS_JSON: JSON.stringify([serviceArn]), IMAGE_URI: releaseImage, DEPLOY_SHA: releaseSha,
    CI_REGISTRY: 'gitlab.example.test', CI_REGISTRY_USER: 'ci', CI_REGISTRY_PASSWORD: 'synthetic', CI_PROJECT_PATH: 'owner/app', HYPERVIBE_REPOSITORY: 'owner/app', HYPERVIBE_ENVIRONMENT: 'staging', HYPERVIBE_PROGRAM_FINGERPRINT: 'fingerprint',
  };
  const script = kind === 'portable' ? buildEcsExpressPortableRuntime() : extractGitHubScript('jobs:\n  deploy:\n    steps:\n' + buildEcsExpressGitHubActionsSteps({ environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: true, serviceNames: ['web'], providerProjectId: cluster, providerServiceIds: [serviceArn] }).steps, 'Release exact digest to bound ECS Express services');
  const run = () => new AsyncFunction('require', 'process', 'fetch', 'Buffer', 'setTimeout', script)(requireFixture, { env }, async () => ({ ok: true }), Buffer, () => { throw new Error('Unexpected polling delay'); });
  return { run, requests, original, files, releaseImage, releaseSha };
}

describe.each(['github', 'portable'] as const)('%s ECS task-definition release', (kind) => {
  it.each([false, true])('preserves EFS mounts, access point, runtime role and sidecars through serialized release requests (rollback=%s)', async (rollback) => {
    const f = fixture(kind, { rollback });
    await f.run();
    const registered = f.requests.find(r => r.operation === 'RegisterTaskDefinition')!.body;
    expect(registered.volumes).toEqual(f.original.volumes);
    expect(registered.taskRoleArn).toBe(f.original.taskRoleArn);
    expect(registered.executionRoleArn).toBe(f.original.executionRoleArn);
    expect(registered.containerDefinitions[1]).toEqual(f.original.containerDefinitions[1]);
    expect(registered.containerDefinitions[0]).toMatchObject({ image: f.releaseImage, mountPoints: f.original.containerDefinitions[0].mountPoints, command: ['node', 'server.mjs'] });
    expect(registered.containerDefinitions[0].environment).toEqual(expect.arrayContaining([{ name: 'EXISTING', value: 'retained' }, { name: 'HYPERVIBE_DEPLOY_SHA', value: f.releaseSha }]));
    expect(f.requests.filter(r => r.operation === 'UpdateExpressGatewayService')).toHaveLength(1);
  });

  it.each([{ denyTask: true }, { missingMain: true }, { wrongFamily: true }])('fails before mutation when the existing definition cannot be safely resolved: %j', async (options) => {
    const f = fixture(kind, options);
    await expect(f.run()).rejects.toThrow();
    expect(f.requests.some(r => r.operation === 'DescribeTaskDefinition')).toBe(true);
    expect(f.requests.filter(r => ['RegisterTaskDefinition', 'UpdateExpressGatewayService'].includes(r.operation))).toEqual([]);
  });

  it('does not update the service when the registered revision loses retained storage', async () => {
    const f = fixture(kind, { corruptRegisteredVolume: true });
    await expect(f.run()).rejects.toThrow();
    expect(f.requests.filter(r => r.operation === 'RegisterTaskDefinition')).toHaveLength(1);
    expect(f.requests.filter(r => r.operation === 'UpdateExpressGatewayService')).toEqual([]);
  });

  it('does not retry non-idempotent registration after a retryable lost response', async () => {
    const f = fixture(kind, { lostRegistration: true });
    await expect(f.run()).rejects.toThrow();
    expect(f.requests.filter(r => r.operation === 'RegisterTaskDefinition')).toHaveLength(1);
    expect(f.requests.filter(r => r.operation === 'UpdateExpressGatewayService')).toEqual([]);
  });
});
