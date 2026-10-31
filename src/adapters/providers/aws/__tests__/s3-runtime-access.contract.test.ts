import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { S3StorageAdapter } from '../s3.adapter.js';
import type { StorageRuntimeAccessTarget } from '../../../../domain/ports/storage-runtime-access.port.js';

// Official IAM Query/S3 XML response reconstructions; actual AWS SDK transport.
// https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRolePolicy.html
// https://docs.aws.amazon.com/IAM/latest/APIReference/API_PutRolePolicy.html
// https://docs.aws.amazon.com/IAM/latest/APIReference/API_DeleteRolePolicy.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-policies-s3.html
const accountId = '123456789012';
const region = 'us-west-2';
const clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/production`;
const serviceArn = clusterArn.replace(':cluster/', ':service/') + '/web';
const roleArn = `arn:aws:iam::${accountId}:role/runtime-app`;
const roleId = 'AROARUNTIME1234567890';
const attemptId = '00000000-0000-4000-8000-000000000001';
const secret = 'synthetic-deploy-secret-never-application-runtime';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1');
  const environment = { id: 'production-id', projectId: 'project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: clusterArn, environmentId: clusterArn, services: { web: { serviceId: serviceArn } } } };
  const context = { accountId, region, environmentId: environment.id, projectName: 'sequence', environmentName: environment.name };
  const target: StorageRuntimeAccessTarget = { environment, serviceName: 'web', storageName: 'documents', externalId: 'sequence-documents-prod', context, identity: { provider: 'aws', source: 'observed', principal: roleArn, scope: { accountId, region, roleId, clusterArn, serviceArn, environmentId: environment.id } } };
  const state = { roleId, policy: undefined as any, policyName: '', fail: '', lostPut: false, lostDelete: false, bucketEnvironment: environment.id, bucketRegion: region };
  const calls: Array<{ operation: string; body: any; headers: any }> = [];
  vi.spyOn(NodeHttpHandler.prototype, 'handle').mockImplementation(async wire => {
    const serialized = typeof wire.body === 'string' ? wire.body : wire.body ? new TextDecoder().decode(wire.body as Uint8Array) : '';
    const body = Object.fromEntries(new URLSearchParams(serialized));
    const operation = body.Action ?? (wire.method === 'HEAD' ? 'HeadBucket' : wire.query?.tagging !== undefined ? 'GetBucketTagging' : 'unexpected');
    calls.push({ operation, body, headers: wire.headers });
    const xml = (value: string, statusCode = 200, headers = {}) => ({ response: { statusCode, headers: { 'content-type': 'text/xml', ...headers }, body: Buffer.from(value) } });
    if (state.fail === operation) return xml('<ErrorResponse><Error><Code>AccessDenied</Code><Message>denied</Message></Error></ErrorResponse>', 403);
    if (operation === 'GetCallerIdentity') return xml(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${accountId}:user/deploy</Arn><Account>${accountId}</Account><UserId>AIDADEPLOY1234567890</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`);
    if (operation === 'HeadBucket') return xml('', 200, { 'x-amz-bucket-region': state.bucketRegion });
    if (operation === 'GetBucketTagging') return xml(`<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>hypervibe-environment-id</Key><Value>${state.bucketEnvironment}</Value></Tag><Tag><Key>hypervibe-storage-name</Key><Value>documents</Value></Tag><Tag><Key>hypervibe-project</Key><Value>sequence</Value></Tag></TagSet></Tagging>`);
    if (operation === 'GetRole') return xml(`<GetRoleResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetRoleResult><Role><Arn>${roleArn}</Arn><RoleName>runtime-app</RoleName><RoleId>${state.roleId}</RoleId><Path>/</Path><CreateDate>2026-09-01T00:00:00Z</CreateDate></Role></GetRoleResult></GetRoleResponse>`);
    if (operation === 'GetRolePolicy') return state.policy ? xml(`<GetRolePolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetRolePolicyResult><RoleName>runtime-app</RoleName><PolicyName>${state.policyName}</PolicyName><PolicyDocument>${encodeURIComponent(JSON.stringify(state.policy))}</PolicyDocument></GetRolePolicyResult></GetRolePolicyResponse>`) : xml('<ErrorResponse><Error><Code>NoSuchEntity</Code><Message>missing</Message></Error></ErrorResponse>', 404);
    if (operation === 'PutRolePolicy') {
      state.policyName = body.PolicyName!; state.policy = JSON.parse(body.PolicyDocument!);
      if (state.lostPut) return xml('<ErrorResponse><Error><Code>ServiceFailure</Code><Message>lost response</Message></Error></ErrorResponse>', 500);
      return xml('<PutRolePolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"/>');
    }
    if (operation === 'DeleteRolePolicy') {
      state.policy = undefined;
      if (state.lostDelete) return xml('<ErrorResponse><Error><Code>ServiceFailure</Code><Message>lost response</Message></Error></ErrorResponse>', 500);
      return xml('<DeleteRolePolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"/>');
    }
    throw new Error('Unexpected operation: ' + operation);
  });
  const adapter = new S3StorageAdapter();
  await adapter.connect({ accessKeyId: 'AKIACONTRACT123456789', secretAccessKey: secret });
  const access = (adapter as any).runtimeAccess;
  return { adapter, access, target, state, calls };
}

describe('S3 explicit workload bucket access', () => {
  it('grants only exact bucket/object operations to the immutable task role and projects no credentials', async () => {
    const f = await fixture();
    expect(await f.access.observe(f.target)).toEqual({ state: 'absent' });
    expect(f.calls.every(call => /^(Get|Head)/.test(call.operation))).toBe(true);
    const granted = await f.access.grant(f.target, attemptId);
    expect(granted.receipt.success).toBe(true);
    expect(f.state.policy.Statement).toEqual(expect.arrayContaining([
      expect.objectContaining({ Resource: `arn:aws:s3:::${f.target.externalId}`, Action: expect.arrayContaining(['s3:ListBucket']), Condition: { StringEquals: { 's3:ResourceAccount': accountId } } }),
      expect.objectContaining({ Resource: `arn:aws:s3:::${f.target.externalId}/*`, Action: expect.arrayContaining(['s3:GetObject', 's3:PutObject', 's3:DeleteObject']) }),
    ]));
    expect(JSON.stringify(f.state.policy)).not.toMatch(/s3:\*|ListAllMyBuckets|iam:/);
    expect(f.calls.filter(call => call.operation === 'HeadBucket').every(call => call.headers['x-amz-expected-bucket-owner'] === accountId)).toBe(true);
    const before = f.calls.length;
    expect(await f.access.observe(f.target, granted.binding)).toMatchObject({ state: 'present' });
    const env = await f.adapter.getRuntimeEnv(f.target.environment, f.target.context, f.target.externalId, f.target.storageName, { hostingProvider: 'ecs', connectionProvider: 'ecs', serviceName: 'web', identity: f.target.identity, runtimeAccessBinding: granted.binding });
    expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '', AWS_S3_BUCKET_NAME: f.target.externalId, AWS_DEFAULT_REGION: region });
    expect(JSON.stringify(env)).not.toContain(secret);
    expect(f.calls.slice(before).every(call => /^(Get|Head)/.test(call.operation))).toBe(true);
    await f.adapter.disconnect();
  });

  it('recovers a lost grant receipt using the exact recorded attempt without another write', async () => {
    const f = await fixture(); f.state.lostPut = true;
    const first = await f.access.grant(f.target, attemptId);
    expect(first.receipt.success).toBe(false);
    expect(first.binding?.attemptId).toBe(attemptId);
    expect((await f.access.grant(f.target, attemptId)).receipt.success).toBe(true);
    expect(f.calls.filter(call => call.operation === 'PutRolePolicy')).toHaveLength(1);
    await f.adapter.disconnect();
  });

  it.each(['GetRole', 'GetRolePolicy', 'GetBucketTagging', 'HeadBucket'])('preserves unknown %s reads before any grant', async operation => {
    const f = await fixture(); f.state.fail = operation;
    expect((await f.access.observe(f.target)).state).toBe('unknown');
    expect((await f.access.grant(f.target, attemptId)).receipt.success).toBe(false);
    expect(f.calls.some(call => call.operation === 'PutRolePolicy')).toBe(false);
    await f.adapter.disconnect();
  });

  it.each(['role', 'environment', 'region', 'principal'] as const)('rejects changed %s before granting access', async change => {
    const f = await fixture();
    if (change === 'role') f.state.roleId = 'AROAREPLACEMENT123456';
    if (change === 'environment') f.state.bucketEnvironment = 'staging-id';
    if (change === 'region') f.state.bucketRegion = 'us-east-1';
    if (change === 'principal') f.target.identity.scope.serviceArn = serviceArn + '-other';
    expect((await f.access.grant(f.target, attemptId)).receipt.success).toBe(false);
    expect(f.calls.some(call => call.operation === 'PutRolePolicy')).toBe(false);
    await f.adapter.disconnect();
  });

  it('does not adopt or overwrite an existing unowned policy slot', async () => {
    const f = await fixture();
    await f.access.grant(f.target, attemptId);
    expect((await f.access.observe(f.target)).state).toBe('unknown');
    expect((await f.access.grant(f.target, attemptId + '-other')).receipt.success).toBe(false);
    expect(f.calls.filter(call => call.operation === 'PutRolePolicy')).toHaveLength(1);
    await f.adapter.disconnect();
  });

  it('removes only the exact owned policy and verifies absence on a lost delete receipt retry', async () => {
    const f = await fixture(); const granted = await f.access.grant(f.target, attemptId);
    f.state.lostDelete = true;
    expect((await f.access.revoke(f.target, granted.binding)).success).toBe(false);
    expect((await f.access.revoke(f.target, granted.binding)).success).toBe(true);
    expect(f.calls.filter(call => call.operation === 'DeleteRolePolicy')).toHaveLength(1);
    await f.adapter.disconnect();
  });

  it('refuses changed policies and runtime projection without a verified grant', async () => {
    const f = await fixture(); const granted = await f.access.grant(f.target, attemptId);
    f.state.policy.Statement[0].Resource = '*';
    expect((await f.access.revoke(f.target, granted.binding)).success).toBe(false);
    await expect(f.adapter.getRuntimeEnv(f.target.environment, f.target.context, f.target.externalId, f.target.storageName, { hostingProvider: 'ecs', connectionProvider: 'ecs', serviceName: 'web', identity: f.target.identity, runtimeAccessBinding: granted.binding })).rejects.toThrow();
    expect(f.calls.some(call => call.operation === 'DeleteRolePolicy')).toBe(false);
    await f.adapter.disconnect();
  });
});
