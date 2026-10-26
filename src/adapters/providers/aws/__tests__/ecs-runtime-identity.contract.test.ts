import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { EcsExpressAdapter } from '../ecs-express.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { IProviderAdapter } from '../../../../domain/ports/provider.port.js';

// Reconstructed official responses, actual AWS SDK protocol and signing. Only
// the transport is synthetic; this is not live IAM or ECS acceptance evidence.
// https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ExpressGatewayServiceConfiguration.html
// https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeTaskDefinition.html
// https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRole.html
// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html
const accountId = '123456789012';
const region = 'us-west-2';
const clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/production`;
const serviceArn = clusterArn.replace(':cluster/', ':service/') + '/web';
const taskArn = `arn:aws:ecs:${region}:${accountId}:task-definition/web:7`;
const roleArn = `arn:aws:iam::${accountId}:role/app/web-runtime`;
const roleId = 'AROARUNTIME1234567890';
const executionRoleArn = `arn:aws:iam::${accountId}:role/execution`;
const infrastructureRoleArn = `arn:aws:iam::${accountId}:role/infrastructure`;
const service = { name: 'web', buildConfig: { builder: 'dockerfile' as const } };
let environment: Environment;
let express: any;
let task: any;
let observedRoleArn: string;
let observedRoleId: string;
let callerUserId: string;
let failOperation: string | undefined;
let calls: Array<{ operation: string; body: any }>;
let registered: any;

beforeEach(() => {
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1');
  environment = { id: 'production-id', projectId: 'project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: clusterArn, environmentId: clusterArn, region, services: { web: { serviceId: serviceArn } } } };
  express = { serviceArn, cluster: clusterArn, currentDeployment: 'revision-7', infrastructureRoleArn, status: { statusCode: 'ACTIVE' }, tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: environment.id }], activeConfigurations: [{ serviceRevisionArn: 'revision-7', taskDefinitionArn: taskArn, taskRoleArn: roleArn, executionRoleArn }] };
  task = { taskDefinitionArn: taskArn, family: 'web', revision: 7, status: 'ACTIVE', taskRoleArn: roleArn, executionRoleArn, networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512', containerDefinitions: [{ name: 'Main', image: 'example@sha256:' + 'a'.repeat(64), portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp' }] }] };
  observedRoleArn = roleArn;
  observedRoleId = roleId;
  callerUserId = 'AIDADEPLOY1234567890';
  failOperation = undefined;
  registered = undefined;
  calls = [];
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async request => {
    const target = request.headers['x-amz-target']?.split('.').at(-1);
    const body = target ? JSON.parse(String(request.body)) : Object.fromEntries(new URLSearchParams(String(request.body)));
    const operation = target ?? body.Action;
    calls.push({ operation, body });
    const xml = (value: string, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'text/xml' }, body: Buffer.from(value) } });
    const json = (value: unknown, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(value)) } });
    if (operation === failOperation) return target ? json({ __type: 'AccessDeniedException', message: 'unknown access' }, 403) : xml('<ErrorResponse><Error><Code>AccessDenied</Code><Message>unknown access</Message></Error></ErrorResponse>', 403);
    if (operation === 'GetCallerIdentity') return xml(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${accountId}:user/deploy</Arn><Account>${accountId}</Account><UserId>${callerUserId}</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`);
    if (operation === 'DescribeExpressGatewayService') return express ? json({ service: express }) : json({ __type: 'ServiceNotFoundException', message: 'missing' }, 400);
    if (operation === 'DescribeTaskDefinition') return json({ taskDefinition: body.taskDefinition === registered?.taskDefinitionArn ? registered : task });
    if (operation === 'RegisterTaskDefinition') {
      registered = { ...body, taskDefinitionArn: taskArn.replace(':7', ':8'), revision: 8, status: 'ACTIVE' };
      return json({ taskDefinition: registered });
    }
    if (operation === 'UpdateExpressGatewayService') return json({ service: { serviceArn } });
    if (operation === 'GetRole') return xml(`<GetRoleResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetRoleResult><Role><Arn>${observedRoleArn}</Arn><RoleName>web-runtime</RoleName><RoleId>${observedRoleId}</RoleId><Path>/app/</Path><CreateDate>2026-09-01T00:00:00Z</CreateDate><AssumeRolePolicyDocument>${encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ecs-tasks.amazonaws.com' } }] }))}</AssumeRolePolicyDocument></Role></GetRoleResult></GetRoleResponse>`);
    throw new Error('Unexpected operation: ' + operation);
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function resolve() {
  const adapter: IProviderAdapter = new EcsExpressAdapter();
  await adapter.connect({ region, accessKeyId: 'AKIACONTRACT123456789', secretAccessKey: 'synthetic-secret-long-enough-for-validation' });
  try { return await adapter.resolveRuntimeIdentity!(environment, service); }
  finally { await adapter.disconnect?.(); }
}

describe('ECS workload principal observation', () => {
  it('returns the exact bound task role and immutable IAM role ID without writes', async () => {
    expect(await resolve()).toEqual({ provider: 'aws', principal: roleArn, source: 'observed', scope: { accountId, region, roleId, serviceArn, clusterArn, environmentId: environment.id } });
    expect(calls.find(call => call.operation === 'GetRole')?.body.RoleName).toBe('web-runtime');
    expect(calls.every(call => ['GetCallerIdentity', 'DescribeExpressGatewayService', 'DescribeTaskDefinition', 'GetRole'].includes(call.operation))).toBe(true);
  });

  it('uses the authoritative task role when the optional Express summary omits it', async () => {
    delete express.activeConfigurations[0].taskRoleArn;
    expect((await resolve()).principal).toBe(roleArn);
  });

  it.each(['DescribeExpressGatewayService', 'DescribeTaskDefinition', 'GetRole'])('preserves unknown %s reads', async operation => {
    failOperation = operation;
    await expect(resolve()).rejects.toThrow(/runtime identity|access/i);
    expect(calls.some(call => call.operation === operation)).toBe(true);
  });

  it.each([
    ['another environment', () => { express.tags[1].value = 'staging-id'; }],
    ['another cluster', () => { express.cluster = clusterArn + '-staging'; }],
    ['missing current deployment', () => { delete express.currentDeployment; }],
    ['unmatched current deployment', () => { express.currentDeployment = 'revision-new'; }],
    ['duplicate current revision', () => { express.activeConfigurations.push({ ...express.activeConfigurations[0] }); }],
    ['missing task definition identity', () => { delete express.activeConfigurations[0].taskDefinitionArn; }],
    ['different task definition family', () => { task.family = 'another-service'; }],
    ['different task role', () => { express.activeConfigurations[0].taskRoleArn = infrastructureRoleArn; }],
    ['missing task role', () => { delete task.taskRoleArn; }],
    ['replacement role identity', () => { observedRoleArn = roleArn + '-replacement'; }],
    ['missing immutable role identity', () => { observedRoleId = ''; }],
    ['task execution role', () => { task.taskRoleArn = executionRoleArn; express.activeConfigurations[0].taskRoleArn = executionRoleArn; observedRoleArn = executionRoleArn; }],
    ['infrastructure role', () => { task.taskRoleArn = infrastructureRoleArn; express.activeConfigurations[0].taskRoleArn = infrastructureRoleArn; observedRoleArn = infrastructureRoleArn; }],
    ['deployment principal', () => { callerUserId = roleId + ':session'; }],
    ['missing bound service', () => { express = undefined; }],
    ['unbound service', () => { environment.platformBindings.services = {}; }],
  ] as const)('blocks %s without a mutation', async (_label, corrupt) => {
    corrupt();
    await expect(resolve()).rejects.toThrow(/runtime identity|bound|scope|configuration|task|role|deployment|environment|service/i);
    expect(calls.every(call => /^(Get|Describe)/.test(call.operation))).toBe(true);
  });
});

describe('direct ECS runtime updates preserve the workload principal', () => {
  async function connected() {
    const adapter = new EcsExpressAdapter();
    await adapter.connect({ region, accessKeyId: 'AKIACONTRACT123456789', secretAccessKey: 'synthetic-secret-long-enough-for-validation' });
    return adapter;
  }

  it('keeps the exact role during an inline configuration update', async () => {
    const adapter = await connected();
    try {
      const config = { taskRoleArn: roleArn, executionRoleArn, primaryContainer: task.containerDefinitions[0] };
      await (adapter as any).updateRuntimeConfiguration(serviceArn, config, { environment: [{ name: 'BUCKET', value: 'app-bucket' }] }, { serviceArn, executionRoleArn });
      expect(calls.find(call => call.operation === 'UpdateExpressGatewayService')?.body.taskRoleArn).toBe(roleArn);
    } finally { await adapter.disconnect(); }
  });

  it('rejects contradictory role summaries before registering or updating a task', async () => {
    const adapter = await connected();
    try {
      const config = { ...express.activeConfigurations[0], taskRoleArn: infrastructureRoleArn };
      await expect((adapter as any).updateRuntimeConfiguration(serviceArn, config, {}, { serviceArn })).rejects.toThrow(/role/i);
      expect(calls.some(call => ['RegisterTaskDefinition', 'UpdateExpressGatewayService'].includes(call.operation))).toBe(false);
    } finally { await adapter.disconnect(); }
  });

  it('rejects a stale current revision instead of selecting an unrelated active configuration', async () => {
    const adapter = await connected();
    try {
      express.currentDeployment = 'different-revision';
      expect(() => (adapter as any).currentConfiguration(express)).toThrow(/current/i);
    } finally { await adapter.disconnect(); }
  });

  it('does not report convergence when the runtime principal changed', async () => {
    const adapter = await connected();
    vi.stubEnv('HYPERVIBE_ECS_EXPRESS_WAIT_ATTEMPTS', '1');
    try {
      express.activeConfigurations[0].ingressPaths = [{ accessType: 'PUBLIC', endpoint: 'web.example.test' }];
      await expect((adapter as any).waitForExpress(serviceArn, task.containerDefinitions[0].image, undefined, taskArn, roleArn + '-reviewed')).rejects.toThrow(/active|role|identity/i);
      expect(calls.some(call => call.operation === 'DescribeTaskDefinition')).toBe(true);
    } finally { await adapter.disconnect(); }
  });
});
