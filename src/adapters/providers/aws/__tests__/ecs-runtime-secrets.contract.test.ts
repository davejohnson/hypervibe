import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { EcsExpressAdapter } from '../ecs-express.adapter.js';
import { observeRuntimeAccess, planRuntimeAccess, applyRuntimeAccessAction, runtimeAccessBindings } from '../../../../domain/services/runtime-access.service.js';
import type { RuntimeIdentityBinding, RuntimeIdentityRequest, RuntimeIdentityStep } from '../../../../domain/ports/runtime-identity.port.js';
// Reconstructed official SDK wire responses; synthetic state, no live compatibility claim.
// AWS task_execution_IAM_role.html assigns SecretsManager retrieval to executionRoleArn.
// IAM API_GetRolePolicy/API_PutRolePolicy expose no conditional-write precondition.
const accountId = '123456789012', region = 'us-west-2';
const cluster = `arn:aws:ecs:${region}:${accountId}:cluster/production`;
const service = cluster.replace(':cluster/', ':service/') + '/web';
const secretArn = `arn:aws:secretsmanager:${region}:${accountId}:secret:api-AbCdEf`;
const version = 'a'.repeat(32);
const taskArn = `arn:aws:ecs:${region}:${accountId}:task-definition/web:1`;
const execRoleId = 'AROAEXECUTION123456789';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(bound = false) {
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1');
  const request: RuntimeIdentityRequest = { environment: { id: 'env-id', projectId: 'project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: cluster, environmentId: cluster, services: bound ? { web: { serviceId: service } } : {} } },
    environmentSpec: { hosting: { provider: 'ecs' }, services: { web: { builder: 'dockerfile' } }, secretDestinations: { API_KEY: { destination: { provider: 'aws-secrets', accountId, region, secretArn }, version } } } as any, service: { name: 'web', buildConfig: {} }, mode: 'ensure' };
  const state = { bound, roleId: execRoleId, policy: undefined as any, lost: false, fail: '', versionPresent: true, secretArn, roleName: bound ? 'existing-execution' : 'production-task-execution', otherPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'logs:CreateLogStream', Resource: '*' }] }, activeSecrets: [] as any[], oldConfiguration: false, oldTask: false, incompleteTasks: false, oldSecrets: [] as any[], keyIds: [] as string[] };
  const calls: Array<{
    operation: string;
    body: any;
  }> = [];
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async (wire) => {
    const target = wire.headers['x-amz-target']?.split('.').at(-1);
    const raw = typeof wire.body === 'string' ? wire.body : new TextDecoder().decode(wire.body as Uint8Array);
    const body = target ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const operation = target ?? body.Action;
    calls.push({ operation, body });
    const xml = (value: string, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'text/xml' }, body: Buffer.from(value) } });
    const json = (value: unknown, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(value)) } });
    const missing = () => xml('<ErrorResponse><Error><Code>NoSuchEntity</Code><Message>absent</Message></Error></ErrorResponse>', 404);
    if (operation === state.fail)
      return target ? json({ __type: 'AccessDeniedException' }, 403) : xml('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>', 403);
    if (operation === 'GetCallerIdentity')
      return xml(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${accountId}</Account><Arn>arn:aws:iam::${accountId}:user/admin</Arn><UserId>AIDAEXAMPLE123456789</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`);
    if (operation === 'DescribeExpressGatewayService')
      return state.bound ? json({ service: { serviceArn: service, cluster, currentDeployment: 'revision-1', tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: 'env-id' }], activeConfigurations: [{ serviceRevisionArn: 'revision-1', taskDefinitionArn: taskArn }, ...(state.oldConfiguration ? [{ serviceRevisionArn: 'revision-0', taskDefinitionArn: taskArn.replace(/:1$/, ':2') }] : [])] } }) : json({ __type: 'ServiceNotFoundException' }, 400);
    if (operation === 'DescribeTaskDefinition')
      return json({ taskDefinition: { taskDefinitionArn: body.taskDefinition, family: 'web', revision: body.taskDefinition === taskArn ? 1 : 2, status: 'ACTIVE', networkMode: 'awsvpc', cpu: '256', memory: '512', requiresCompatibilities: ['FARGATE'], executionRoleArn: `arn:aws:iam::${accountId}:role/${state.roleName}`, taskRoleArn: `arn:aws:iam::${accountId}:role/application`, containerDefinitions: [{ name: 'Main', image: 'image', secrets: body.taskDefinition === taskArn ? state.activeSecrets : state.oldSecrets }], volumes: [] } });
    if (operation === 'ListTasks' && !state.bound && body.serviceName) return json({ __type: 'ServiceNotFoundException' }, 400);
    if (operation === 'ListTasks') return json(state.incompleteTasks ? {} : { taskArns: state.oldTask ? [`arn:aws:ecs:${region}:${accountId}:task/production/1234567890abcdef`] : [] });
    if (operation === 'DescribeTasks') return json({ tasks: [{ taskArn: body.tasks[0], clusterArn: cluster, group: 'service:web', desiredStatus: 'RUNNING', lastStatus: 'PENDING', taskDefinitionArn: taskArn.replace(/:1$/, ':2') }] });
    if (operation === 'GetRole')
      return xml(`<GetRoleResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetRoleResult><Role><Arn>arn:aws:iam::${accountId}:role/${state.roleName}</Arn><RoleName>${state.roleName}</RoleName><RoleId>${state.roleId}</RoleId><AssumeRolePolicyDocument>${encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] }))}</AssumeRolePolicyDocument><Tags><member><Key>managed-by</Key><Value>hypervibe</Value></member><member><Key>hypervibe-environment-id</Key><Value>env-id</Value></member></Tags></Role></GetRoleResult></GetRoleResponse>`);
    if (operation === 'DescribeSecret')
      return json({ ARN: state.secretArn, Name: 'api', CreatedDate: 1700000000 });
    if (operation === 'ListSecretVersionIds')
      return json({ ARN: secretArn, Name: 'api', Versions: state.versionPresent ? [{ VersionId: version, CreatedDate: 1700000001, ...(state.keyIds.length ? { KmsKeyIds: state.keyIds } : {}) }] : [] });
    if (operation === 'GetRolePolicy')
      return state.policy ? xml(`<GetRolePolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetRolePolicyResult><RoleName>${state.roleName}</RoleName><PolicyName>${body.PolicyName}</PolicyName><PolicyDocument>${encodeURIComponent(JSON.stringify(state.policy))}</PolicyDocument></GetRolePolicyResult></GetRolePolicyResponse>`) : missing();
    if (operation === 'PutRolePolicy') {
      state.policy = JSON.parse(body.PolicyDocument);
      if (state.lost)
        return xml('<ErrorResponse><Error><Code>ServiceFailure</Code></Error></ErrorResponse>', 500);
      return xml('<PutRolePolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"/>');
    }
    if (operation === 'DeleteRolePolicy') {
      state.policy = undefined;
      return xml('<DeleteRolePolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"/>');
    }
    throw new Error('Unexpected ' + operation);
  });
  const adapter = new EcsExpressAdapter();
  await adapter.connect({ region, accessKeyId: 'AKIACONTRACT123456789', secretAccessKey: 'synthetic-secret-long-enough-for-validation' });
  let binding: RuntimeIdentityBinding | undefined;
  let attempt = 0;
  const inspect = () => adapter.runtimeIdentities.inspect({ ...request, binding });
  const apply = async (step: RuntimeIdentityStep) => { const attemptId = `00000000-0000-4000-8000-${String(++attempt).padStart(12, '0')}`; binding = { provider: 'ecs', evidence: binding?.evidence ?? {}, pending: { attemptId, step } }; const result = await adapter.runtimeIdentities.apply({ ...request, binding, step, attemptId }); if (result.receipt.success)
    binding = result.binding; return result; };
  const next = async () => { const seen = await inspect(); expect(seen.state).toBe('action'); return apply((seen as any).step); };
  return { adapter, request, state, calls, inspect, apply, next, get binding() { return binding; } };
}
describe('ECS immutable secret execution-reader lifecycle', () => {
  it('plans and verifies exact execution-role access before the first workload, without an application task role or payload read', async () => {
    const f = await fixture();
    const preview = await f.inspect();
    expect(preview).toMatchObject({ state: 'action', step: { operation: 'attach', target: { phase: 'execution-secrets' } } });
    expect((await f.next()).receipt.success).toBe(true);
    expect(await f.inspect()).toMatchObject({ state: 'ready' });
    const write = f.calls.find(c => c.operation === 'PutRolePolicy')!;
    expect(write.body.RoleName).toBe('production-task-execution');
    expect(JSON.parse(write.body.PolicyDocument).Statement).toContainEqual(expect.objectContaining({ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [secretArn] }));
    expect(f.calls.some(c => /GetSecretValue|CreateRole|CreateExpress|RegisterTask/.test(c.operation))).toBe(false);
    await f.adapter.disconnect();
  });
  it('preserves an existing execution role and unrelated policy, and recovers a lost grant response without resubmission', async () => {
    const f = await fixture(true);
    f.state.lost = true;
    expect((await f.next()).receipt.success).toBe(false);
    expect(await f.inspect()).toMatchObject({ state: 'action', step: { operation: 'recover' } });
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.calls.filter(c => c.operation === 'PutRolePolicy')).toHaveLength(1);
    expect(f.calls.find(c => c.operation === 'PutRolePolicy')!.body.RoleName).toBe('existing-execution');
    expect(f.state.otherPolicy.Statement[0].Action).toBe('logs:CreateLogStream');
    await f.adapter.disconnect();
  });
  it.each(['permission', 'replacement', 'version'])('blocks %s uncertainty without IAM mutation', async (failure) => {
    const f = await fixture();
    if (failure === 'permission')
      f.state.fail = 'DescribeSecret';
    if (failure === 'replacement')
      f.state.secretArn = secretArn.replace('AbCdEf', 'GhIjKl');
    if (failure === 'version')
      f.state.versionPresent = false;
    expect((await f.inspect()).state).toBe('unknown');
    expect(f.calls.some(c => c.operation === 'PutRolePolicy')).toBe(false);
    await f.adapter.disconnect();
  });
  it('fences replacement execution identity after review', async () => { const f = await fixture(); const preview = await f.inspect(); expect(preview.state).toBe('action'); f.state.roleId = 'AROAREPLACED123456789'; expect((await f.apply((preview as any).step)).receipt.success).toBe(false); expect(f.calls.some(c => c.operation === 'PutRolePolicy')).toBe(false); await f.adapter.disconnect(); });
  it('lets first deployment stage secret access while bucket access waits for its separate application role', async () => {
    const f = await fixture();
    f.request.environmentSpec!.storage = { files: { provider: 's3', injectInto: ['web'] } } as any;
    const observed = await observeRuntimeAccess({ environment: f.request.environment, environmentSpec: f.request.environmentSpec!, hosting: f.adapter, storageAdapters: {} });
    expect(planRuntimeAccess(observed)).toMatchObject([{ metadata: { operation: 'runtimeIdentity', step: { target: { phase: 'execution-secrets' } } } }]);
    expect(observed.grants.every(grant => grant.waiting)).toBe(true);
    await f.adapter.disconnect();
  });
  it('retains unknown lost writes without replay and rejects a foreign policy', async () => {
    const f = await fixture();
    f.state.lost = true;
    expect((await f.next()).receipt.success).toBe(false);
    f.state.policy = undefined;
    expect((await f.inspect()).state).toBe('waiting');
    expect(f.calls.filter(c => c.operation === 'PutRolePolicy')).toHaveLength(1);
    await f.adapter.disconnect();
    const foreign = await fixture();
    foreign.state.policy = foreign.state.otherPolicy;
    expect((await foreign.inspect()).state).toBe('unknown');
    expect(foreign.calls.some(c => c.operation === 'PutRolePolicy')).toBe(false);
    await foreign.adapter.disconnect();
  });
  it('removes only its recorded policy after consuming references disappear and preserves stored values', async () => {
    const f = await fixture(true);
    expect((await f.next()).receipt.success).toBe(true);
    f.request.environmentSpec!.secretDestinations = {};
    f.state.activeSecrets = [{ name: 'API_KEY', valueFrom: secretArn + ':::' + version }];
    expect((await f.inspect()).state).toBe('waiting');
    f.state.activeSecrets = [];
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.binding).toBeUndefined();
    expect(f.calls.filter(c => c.operation === 'DeleteRolePolicy')).toHaveLength(1);
    expect(f.calls.some(c => /DeleteSecret|PutSecretValue|GetSecretValue/.test(c.operation))).toBe(false);
    await f.adapter.disconnect();
  });
  it('reviews narrowly conditioned decrypt access for independently observed immutable version key ARNs', async () => {
    const f = await fixture();
    const keyArn = `arn:aws:kms:${region}:${accountId}:key/12345678-1234-1234-1234-123456789012`;
    f.state.keyIds = [keyArn];
    expect((await f.next()).receipt.success).toBe(true);
    expect(f.state.policy.Statement).toContainEqual({ Effect: 'Allow', Action: ['kms:Decrypt'], Resource: [keyArn], Condition: { StringEquals: { 'kms:ViaService': `secretsmanager.${region}.amazonaws.com`, 'kms:EncryptionContext:SecretARN': secretArn } } });
    await f.adapter.disconnect();
  });
  it('persists the first reader frontier through the shared reviewed plan/apply boundary and then observes a mutation-free noop', async () => {
    const f = await fixture();
    const input = { environment: f.request.environment, environmentSpec: f.request.environmentSpec!, hosting: f.adapter, storageAdapters: {} };
    const actions = planRuntimeAccess(await observeRuntimeAccess(input));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.verified).toBe(true);
    const result = await applyRuntimeAccessAction({ ...input, action: actions[0]!, confirmedActionIds: new Set([actions[0]!.id]), save: async (next) => { Object.assign(f.request.environment.platformBindings, next); } });
    expect(result.success).toBe(true);
    expect(runtimeAccessBindings(f.request.environment)?.runtimeIdentities.web?.evidence.executionReaderRoleId).toBe(execRoleId);
    const before = f.calls.length;
    expect(planRuntimeAccess(await observeRuntimeAccess(input))).toEqual([]);
    expect(f.calls.slice(before).every(call => /^(Get|Describe|List)/.test(call.operation))).toBe(true);
    await f.adapter.disconnect();
  });
  it.each(['configuration', 'pending-task', 'inventory'] as const)('retains reader access while an old %s is still consuming or unknown', async scenario => {
    const f = await fixture(true); expect((await f.next()).receipt.success).toBe(true); f.request.environmentSpec!.secretDestinations = {};
    f.state.oldSecrets = [{ name: 'API_KEY', valueFrom: secretArn + ':::' + version }];
    if (scenario === 'configuration') f.state.oldConfiguration = true;
    if (scenario === 'pending-task') f.state.oldTask = true;
    if (scenario === 'inventory') f.state.incompleteTasks = true;
    expect((await f.inspect()).state).toBe(scenario === 'inventory' ? 'unknown' : 'waiting');
    expect(f.calls.some(call => call.operation === 'DeleteRolePolicy')).toBe(false);
    f.state.oldConfiguration = false; f.state.oldTask = false; f.state.incompleteTasks = false;
    expect((await f.next()).receipt.success).toBe(true); await f.adapter.disconnect();
  });

  it('verifies remaining cluster tasks after the consuming service is deleted before retiring the policy', async () => {
    const f = await fixture(true); expect((await f.next()).receipt.success).toBe(true); f.state.bound = false; f.request.mode = 'destroy';
    f.state.oldTask = true; f.state.oldSecrets = [{ name: 'API_KEY', valueFrom: secretArn + ':::' + version }];
    expect((await f.inspect()).state).toBe('waiting'); f.state.oldTask = false;
    expect((await f.next()).receipt.success).toBe(true); expect(f.calls.filter(call => call.operation === 'ListTasks').every(call => call.body.serviceName === undefined)).toBe(true);
    await f.adapter.disconnect();
  });

});
