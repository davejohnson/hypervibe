import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { EcsExpressAdapter } from '../ecs-express.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { RuntimeIdentityBinding, RuntimeIdentityRequest, RuntimeIdentityStep } from '../../../../domain/ports/runtime-identity.port.js';

// Reconstructed official IAM Query/ECS JSON responses, real SDK serialization.
// https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateRole.html
// https://docs.aws.amazon.com/IAM/latest/APIReference/API_DeleteRole.html
// https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RegisterTaskDefinition.html
// https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateExpressGatewayService.html
// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html
const accountId = '123456789012';
const region = 'us-west-2';
const clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/production`;
const serviceArn = clusterArn.replace(':cluster/', ':service/') + '/web';
const taskArn = `arn:aws:ecs:${region}:${accountId}:task-definition/web:1`;
const roleId = 'AROARUNTIME1234567890';
const encode = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1');
  const environment: Environment = { id: 'production-id', projectId: 'project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: clusterArn, environmentId: clusterArn, region, services: { web: { serviceId: serviceArn } } } };
  const request: RuntimeIdentityRequest = { environment, service: { name: 'web', buildConfig: { builder: 'dockerfile' } }, mode: 'ensure' };
  const task: any = { taskDefinitionArn: taskArn, family: 'web', revision: 1, status: 'ACTIVE', executionRoleArn: `arn:aws:iam::${accountId}:role/execution`, networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512', containerDefinitions: [{ name: 'Main', image: 'example@sha256:' + 'a'.repeat(64), environment: [{ name: 'KEEP', value: 'preserve' }], portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp' }] }, { name: 'sidecar', image: 'sidecar' }], volumes: [] };
  const tasks = new Map<string, any>([[taskArn, { task, tags: [{ key: 'original-tag', value: 'retained' }] }]]);
  const state = { activeArn: taskArn, deployment: 'revision-1', servicePresent: true, role: undefined as any, policies: [] as string[], attached: [] as string[], roleCreateLost: false, registrationLost: false, attachmentLost: false, failRead: '', environmentId: environment.id };
  const calls: Array<{ operation: string; body: any }> = [];
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async wire => {
    const target = wire.headers['x-amz-target']?.split('.').at(-1);
    const serialized = typeof wire.body === 'string' ? wire.body : new TextDecoder().decode(wire.body as Uint8Array);
    const body = target ? JSON.parse(serialized) : Object.fromEntries(new URLSearchParams(serialized));
    const operation = target ?? body.Action;
    calls.push({ operation, body });
    const xml = (value: string, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'text/xml' }, body: Buffer.from(value) } });
    const json = (value: unknown, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(value)) } });
    if (operation === state.failRead) return target ? json({ __type: 'AccessDeniedException', message: 'read denied' }, 403) : xml('<ErrorResponse><Error><Code>AccessDenied</Code><Message>read denied</Message></Error></ErrorResponse>', 403);
    const roleResponse = () => xml(`<${operation}Response xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><${operation}Result><Role><Arn>${state.role.arn}</Arn><RoleName>${state.role.name}</RoleName><RoleId>${state.role.id}</RoleId><Path>/</Path><CreateDate>2026-09-01T00:00:00Z</CreateDate><AssumeRolePolicyDocument>${encodeURIComponent(JSON.stringify(state.role.trust))}</AssumeRolePolicyDocument><Tags>${state.role.tags.map((tag: any) => `<member><Key>${tag.Key}</Key><Value>${encode(tag.Value)}</Value></member>`).join('')}</Tags></Role></${operation}Result></${operation}Response>`);
    if (operation === 'GetCallerIdentity') return xml(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${accountId}:user/deploy</Arn><Account>${accountId}</Account><UserId>AIDADEPLOY1234567890</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`);
    if (operation === 'DescribeExpressGatewayService') return state.servicePresent ? json({ service: { serviceArn, cluster: clusterArn, currentDeployment: state.deployment, infrastructureRoleArn: `arn:aws:iam::${accountId}:role/infrastructure`, status: { statusCode: 'ACTIVE' }, tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: state.environmentId }], activeConfigurations: [{ serviceRevisionArn: state.deployment, taskDefinitionArn: state.activeArn, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'web.example.test' }] }] } }) : json({ __type: 'ServiceNotFoundException', message: 'missing' }, 400);
    if (operation === 'DescribeTaskDefinition') {
      const found = tasks.get(body.taskDefinition);
      return json({ taskDefinition: found?.task, tags: found?.tags });
    }
    if (operation === 'ListTaskDefinitions') return json({ taskDefinitionArns: [...tasks.keys()] });
    if (operation === 'RegisterTaskDefinition') {
      const arn = taskArn.replace(/:\d+$/, ':' + (tasks.size + 1));
      const { tags, ...input } = body;
      tasks.set(arn, { task: { ...input, taskDefinitionArn: arn, revision: tasks.size + 1, status: 'ACTIVE' }, tags });
      if (state.registrationLost) return json({ __type: 'ServerException', message: 'lost response' }, 500);
      return json({ taskDefinition: tasks.get(arn)!.task, tags });
    }
    if (operation === 'UpdateExpressGatewayService') {
      expect(Object.keys(body).sort()).toEqual(['serviceArn', 'taskDefinitionArn']);
      state.activeArn = body.taskDefinitionArn; state.deployment = 'revision-2';
      if (state.attachmentLost) return json({ __type: 'ServerException', message: 'lost response' }, 500);
      return json({ service: { serviceArn } });
    }
    if (operation === 'GetRole') return state.role ? roleResponse() : xml('<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Code>NoSuchEntity</Code><Message>missing role</Message></Error></ErrorResponse>', 404);
    if (operation === 'CreateRole') {
      const tags = Object.keys(body).filter(key => /^Tags\.member\.\d+\.Key$/.test(key)).map(key => ({ Key: body[key], Value: body[key.replace(/Key$/, 'Value')] }));
      state.role = { arn: `arn:aws:iam::${accountId}:role/${body.RoleName}`, name: body.RoleName, id: roleId, trust: JSON.parse(body.AssumeRolePolicyDocument), tags };
      if (state.roleCreateLost) return xml('<ErrorResponse><Error><Code>ServiceFailure</Code><Message>lost response</Message></Error></ErrorResponse>', 500);
      return roleResponse();
    }
    if (operation === 'ListRolePolicies') return xml(`<ListRolePoliciesResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><ListRolePoliciesResult><PolicyNames>${state.policies.map(name => `<member>${name}</member>`).join('')}</PolicyNames><IsTruncated>false</IsTruncated></ListRolePoliciesResult></ListRolePoliciesResponse>`);
    if (operation === 'ListAttachedRolePolicies') return xml(`<ListAttachedRolePoliciesResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><ListAttachedRolePoliciesResult><AttachedPolicies>${state.attached.map(arn => `<member><PolicyArn>${arn}</PolicyArn><PolicyName>attached</PolicyName></member>`).join('')}</AttachedPolicies><IsTruncated>false</IsTruncated></ListAttachedRolePoliciesResult></ListAttachedRolePoliciesResponse>`);
    if (operation === 'DeleteRole') { state.role = undefined; return xml('<DeleteRoleResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"/>'); }
    throw new Error('Unexpected operation: ' + operation);
  });
  const adapter = new EcsExpressAdapter();
  await adapter.connect({ region, accessKeyId: 'AKIACONTRACT123456789', secretAccessKey: 'synthetic-secret-long-enough-for-validation' });
  const runtime = (adapter as any).runtimeIdentities;
  let binding: RuntimeIdentityBinding | undefined;
  let attempt = 0;
  const inspect = () => runtime.inspect({ ...request, binding });
  const apply = async (step: RuntimeIdentityStep) => {
    const attemptId = `00000000-0000-4000-8000-${String(++attempt).padStart(12, '0')}`;
    binding = { provider: 'ecs', evidence: binding?.evidence ?? {}, pending: { attemptId, step } };
    const result = await runtime.apply({ ...request, binding, step, attemptId });
    if (result.receipt.success) binding = result.binding;
    return result;
  };
  const next = async () => {
    const observed = await inspect(); expect(observed.state).toBe('action');
    return apply(observed.step);
  };
  return { adapter, runtime, request, state, tasks, calls, inspect, apply, next, get binding() { return binding; }, set binding(value) { binding = value; } };
}

describe('explicit ECS runtime identity lifecycle', () => {
  it('creates a service-specific empty role, registers then attaches in separate reviewed stages, and becomes mutation-free ready', async () => {
    const f = await fixture();
    const preview = await f.inspect();
    expect(preview).toMatchObject({ state: 'action', step: { operation: 'create' } });
    expect(f.calls.every(call => /^(Get|Describe)/.test(call.operation))).toBe(true);
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.binding?.evidence.roleId).toBe(roleId);
    expect(f.state.role.trust.Statement[0]).toMatchObject({ Principal: { Service: 'ecs-tasks.amazonaws.com' }, Condition: { StringEquals: { 'aws:SourceAccount': accountId }, ArnLike: { 'aws:SourceArn': `arn:aws:ecs:${region}:${accountId}:*` } } });
    expect(f.calls.some(call => /PutRolePolicy|AttachRolePolicy/.test(call.operation))).toBe(false);
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.calls.some(call => call.operation === 'UpdateExpressGatewayService')).toBe(false);
    expect(await f.inspect()).toMatchObject({ state: 'action', step: { restartsWorkload: true } });
    expect((await f.next()).receipt.success).toBe(true);
    const registered = f.calls.find(call => call.operation === 'RegisterTaskDefinition')!.body;
    expect(registered.containerDefinitions).toEqual(f.tasks.get(taskArn).task.containerDefinitions);
    expect(registered.executionRoleArn).toBe(f.tasks.get(taskArn).task.executionRoleArn);
    expect(registered.taskRoleArn).toBe(f.state.role.arn);
    const before = f.calls.length;
    expect(await f.inspect()).toMatchObject({ state: 'ready', identity: { principal: f.state.role.arn, scope: { roleId, environmentId: f.request.environment.id } } });
    expect(f.calls.slice(before).every(call => /^(Get|Describe)/.test(call.operation))).toBe(true);
    await f.adapter.disconnect();
  });

  it('isolates another environment and rejects a changed source before creating', async () => {
    const f = await fixture();
    const preview = await f.inspect();
    f.state.environmentId = 'staging-id';
    expect((await f.apply(preview.step)).receipt.success).toBe(false);
    expect(f.calls.some(call => call.operation === 'CreateRole')).toBe(false);
    await f.adapter.disconnect();
  });

  it('recovers a lost CreateRole receipt only by exact attempt tags and immutable identity, without another create', async () => {
    const f = await fixture(); f.state.roleCreateLost = true;
    expect((await f.next()).receipt.success).toBe(false);
    expect(await f.inspect()).toMatchObject({ state: 'action', step: { operation: 'recover' } });
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.binding?.evidence.roleId).toBe(roleId);
    expect(f.calls.filter(call => call.operation === 'CreateRole')).toHaveLength(1);
    await f.adapter.disconnect();
  });

  it('does not repeat an uncertain create after a missing or foreign role read', async () => {
    const f = await fixture(); f.state.roleCreateLost = true; await f.next();
    f.state.role.tags = [];
    expect((await f.inspect()).state).toBe('unknown');
    f.state.role = undefined;
    expect((await f.inspect()).state).toBe('waiting');
    expect(f.calls.filter(call => call.operation === 'CreateRole')).toHaveLength(1);
    await f.adapter.disconnect();
  });

  it('recovers an uncertain registration by independent exact task tags without repeating registration', async () => {
    const f = await fixture(); await f.next(); f.state.registrationLost = true;
    expect((await f.next()).receipt.success).toBe(false);
    expect(await f.inspect()).toMatchObject({ state: 'action', step: { operation: 'recover' } });
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.calls.filter(call => call.operation === 'RegisterTaskDefinition')).toHaveLength(1);
    expect((await f.next()).receipt.success).toBe(true);
    await f.adapter.disconnect();
  });

  it('recovers a lost attachment receipt only after observing the exact prepared revision', async () => {
    const f = await fixture(); await f.next(); await f.next(); f.state.attachmentLost = true;
    expect((await f.next()).receipt.success).toBe(false);
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.calls.filter(call => call.operation === 'UpdateExpressGatewayService')).toHaveLength(1);
    expect((await f.inspect()).state).toBe('ready');
    await f.adapter.disconnect();
  });

  it('preserves IAM read uncertainty before mutation', async () => {
    const f = await fixture(); f.state.failRead = 'GetRole';
    expect((await f.inspect()).state).toBe('unknown');
    expect(f.calls.some(call => call.operation === 'CreateRole')).toBe(false);
    await f.adapter.disconnect();
  });

  it('blocks role deletion until the service is confirmed absent and all policies are removed', async () => {
    const f = await fixture(); await f.next(); await f.next(); await f.next();
    f.request.mode = 'destroy';
    expect((await f.inspect()).state).toBe('waiting');
    f.state.servicePresent = false; f.state.policies = ['owned-bucket-access'];
    expect((await f.inspect()).state).toBe('waiting');
    f.state.policies = []; f.state.attached = ['arn:aws:iam::aws:policy/ReadOnlyAccess'];
    expect((await f.inspect()).state).toBe('waiting');
    f.state.attached = [];
    expect(await f.inspect()).toMatchObject({ state: 'action', step: { operation: 'destroy' } });
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.binding).toBeUndefined();
    expect(f.calls.filter(call => call.operation === 'DeleteRole')).toHaveLength(1);
    await f.adapter.disconnect();
  });
});
