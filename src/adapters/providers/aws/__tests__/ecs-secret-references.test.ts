import { describe, expect, it } from 'vitest';
import { ECSClient } from '@aws-sdk/client-ecs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECRClient } from '@aws-sdk/client-ecr';
import { IAMClient } from '@aws-sdk/client-iam';
import { EcsExpressAdapter } from '../ecs-express.adapter.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

// Real SDK serialization and deserialization, synthetic HTTP responses. Native contract:
// https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ExpressGatewayContainer.html
// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html
const accountId = '123456789012', region = 'us-west-2';
const cluster = `arn:aws:ecs:${region}:${accountId}:cluster/staging`;
const serviceArn = `arn:aws:ecs:${region}:${accountId}:service/staging/web`;
const reference = { destination: { provider: 'aws-secrets', accountId, region, secretArn: `arn:aws:secretsmanager:${region}:${accountId}:secret:api-token-AbCdEf` }, version: 'a'.repeat(32) };
const native = { name: 'API_TOKEN', valueFrom: reference.destination.secretArn + ':::' + reference.version };
const now = new Date();
const service: Service = { id: 'service', projectId: 'project', name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: now, updatedAt: now };
const environment: Environment = { id: 'environment', projectId: 'project', name: 'staging', createdAt: now, updatedAt: now, platformBindings: { provider: 'ecs', projectId: cluster, environmentId: cluster, services: { web: { serviceId: serviceArn } }, awsNetwork: { accountId, region, vpcId: 'vpc-1', subnetIds: ['subnet-1', 'subnet-2'], workloadSecurityGroupId: 'sg-1' } } };
async function fixture(corrupt = false, unbound?: 'absent' | 'lookalike') {
  const requests: Array<{ operation: string; body: any }> = [];
  let revision = 1;
  let container: any = { image: 'registry/app@sha256:' + 'b'.repeat(64), environment: [{ name: 'EXISTING', value: 'retained' }], secrets: [{ name: 'RETAINED', valueFrom: `arn:aws:secretsmanager:${region}:${accountId}:secret:retained-AbCdEf:::` + 'c'.repeat(32) }] };
  const originalSecrets = structuredClone(container.secrets);
  const tags = [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: environment.id }];
  const tagXml = tags.map(t => `<member><Key>${t.key}</Key><Value>${t.value}</Value></member>`).join('');
  const reply = (body: unknown, xml = false) => ({ response: { statusCode: 200, headers: { 'content-type': xml ? 'text/xml' : 'application/x-amz-json-1.1' }, body: new TextEncoder().encode(xml ? String(body) : JSON.stringify(body)) } });
  const handler = { handle: async (request: any) => {
    const text = typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body);
    const query = new URLSearchParams(text);
    const operation = request.headers['x-amz-target']?.split('.').at(-1) ?? query.get('Action');
    const body = text.startsWith('{') ? JSON.parse(text) : Object.fromEntries(query);
    requests.push({ operation, body });
    if (operation === 'DescribeVpcs') return reply('<DescribeVpcsResponse><vpcSet><item><vpcId>vpc-1</vpcId><isDefault>true</isDefault></item></vpcSet></DescribeVpcsResponse>', true);
    if (operation === 'DescribeSubnets') return reply('<DescribeSubnetsResponse><subnetSet>' + [1, 2].map(n => `<item><subnetId>subnet-${n}</subnetId><vpcId>vpc-1</vpcId><defaultForAz>true</defaultForAz><availabilityZone>${region}${n === 1 ? 'a' : 'b'}</availabilityZone></item>`).join('') + '</subnetSet></DescribeSubnetsResponse>', true);
    if (operation === 'DescribeSecurityGroups') return reply('<DescribeSecurityGroupsResponse><securityGroupInfo><item><groupId>sg-1</groupId><groupName>staging-hypervibe-workloads</groupName><vpcId>vpc-1</vpcId><tagSet>' + [...tags, { key: 'hypervibe-ecs-cluster-arn', value: cluster }].map(t => `<item><key>${t.key}</key><value>${t.value}</value></item>`).join('') + '</tagSet></item></securityGroupInfo></DescribeSecurityGroupsResponse>', true);
    if (operation === 'GetRole') return reply(`<GetRoleResponse><GetRoleResult><Role><RoleName>${body.RoleName}</RoleName><Arn>arn:aws:iam::${accountId}:role/${body.RoleName}</Arn><Tags>${tagXml}</Tags></Role></GetRoleResult></GetRoleResponse>`, true);
    if (operation === 'ListAttachedRolePolicies') return reply(`<ListAttachedRolePoliciesResponse><ListAttachedRolePoliciesResult><AttachedPolicies><member><PolicyArn>arn:aws:iam::aws:policy/service-role/${body.RoleName.endsWith('task-execution') ? 'AmazonECSTaskExecutionRolePolicy' : 'AmazonECSInfrastructureRoleforExpressGatewayServices'}</PolicyArn></member></AttachedPolicies></ListAttachedRolePoliciesResult></ListAttachedRolePoliciesResponse>`, true);
    if (operation === 'DescribeRepositories') return reply({ repositories: [{ repositoryName: 'hypervibe/staging', repositoryArn: `arn:aws:ecr:${region}:${accountId}:repository/hypervibe/staging`, repositoryUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/hypervibe/staging` }] });
    if (operation === 'DescribeClusters') return reply({ clusters: [{ clusterArn: cluster, status: 'ACTIVE', tags }] });
    if (operation === 'ListTagsForResource') return reply({ tags: tags.map(t => ({ Key: t.key, Value: t.value })) });
    if (operation === 'ListServices') return reply({ serviceArns: unbound === 'absent' ? [] : [serviceArn] });
    if (operation === 'CreateExpressGatewayService') { container = body.primaryContainer; revision += 1; return reply({ service: { serviceArn, serviceName: 'web' } }); }
    if (operation === 'DescribeExpressGatewayService') return reply({ service: { serviceArn, cluster, tags, currentDeployment: 'revision-' + revision, status: { statusCode: 'ACTIVE' }, activeConfigurations: [{ serviceRevisionArn: 'revision-' + revision, executionRoleArn: `arn:aws:iam::${accountId}:role/observed-execution`, primaryContainer: container, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'https://app.example.test' }] }] } });
    if (operation === 'UpdateExpressGatewayService') { container = body.primaryContainer; revision += 1; if (corrupt) container.secrets = originalSecrets; return reply({ service: { serviceArn } }); }
    throw new Error('Unexpected SDK operation ' + operation);
  } };
  const config = { region, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, requestHandler: handler, maxAttempts: 1 };
  const adapter = new EcsExpressAdapter();
  await adapter.connect({ accessKeyId: 'SYNTHETICACCESSKEY', secretAccessKey: 'synthetic-test-only-not-a-real-secret-key', region });
  Object.assign(adapter, { clients: { ecs: new ECSClient(config), ec2: new EC2Client(config), ecr: new ECRClient(config), iam: new IAMClient(config) }, accountId });
  return { adapter, requests, originalSecrets };
}
describe('ECS immutable secret references', () => {
  it.each(['absent', 'lookalike'] as const)('conditions first workload reference installation on exact service absence: %s', async state => {
    const f = await fixture(false, state);
    const unbound = { ...environment, platformBindings: { ...environment.platformBindings, services: {} } };
    const result = await f.adapter.deploy(service, unbound, {}, { deferDeployment: true, requireNewWorkload: true, secretVersionRefs: { API_TOKEN: reference } } as any);
    expect(result.receipt.success).toBe(state === 'absent');
    const creates = f.requests.filter(request => request.operation === 'CreateExpressGatewayService');
    expect(creates).toHaveLength(state === 'absent' ? 1 : 0);
    if (state === 'absent') expect(creates[0]!.body.primaryContainer.secrets).toEqual([native]);
    expect(f.requests.filter(request => request.operation === 'UpdateExpressGatewayService')).toEqual([]);
  });
  it('enforces creation-only authority before touching an already bound workload', async () => {
    const f = await fixture();
    expect(await f.adapter.deploy(service, environment, {}, { deferDeployment: true, requireNewWorkload: true, secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ receipt: { success: false } });
    expect(f.requests).toEqual([]);
  });
  it('serializes immutable secret ARN version selectors and preserves prior literals and references on another update', async () => {
    const f = await fixture();
    const result = await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any);
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });
    const first = f.requests.find(r => r.operation === 'UpdateExpressGatewayService')!.body.primaryContainer;
    expect(first.secrets).toEqual(expect.arrayContaining([native, ...f.originalSecrets]));
    expect(first.environment).toContainEqual({ name: 'EXISTING', value: 'retained' });
    expect(first.environment.some((entry: any) => entry.name === 'API_TOKEN')).toBe(false);
    expect(await f.adapter.deploy(service, environment, { MODE: 'test' })).toMatchObject({ receipt: { success: true } });
    expect(f.requests.filter(r => r.operation === 'UpdateExpressGatewayService')[1]!.body.primaryContainer.secrets).toContainEqual(native);
    expect(f.requests.filter(r => r.operation === 'UpdateExpressGatewayService')[1]!.body.executionRoleArn).toBe(`arn:aws:iam::${accountId}:role/observed-execution`);
    const observed = await f.adapter.observe(environment);
    expect(observed.services[0]?.envVarSecretRefs?.API_TOKEN).toEqual({ provider: 'aws-secrets', resource: reference.destination.secretArn, version: reference.version });
    expect(observed.services[0]?.envVarHashes).not.toHaveProperty('API_TOKEN');
    expect(observed.services[0]?.envVarKeys).toContain('API_TOKEN');
  });
  it('rejects a literal overwrite of an existing secret reference', async () => {
    const f = await fixture();
    expect(await f.adapter.setEnvVars(environment, service, { RETAINED: 'unexpected-literal' })).toMatchObject({ success: false });
    expect(f.requests.filter(r => r.operation === 'UpdateExpressGatewayService')).toEqual([]);
  });
  it('rejects success when ready service drops the requested reference', async () => {
    const f = await fixture(true);
    expect(await f.adapter.setEnvVars(environment, service, {}, { secretVersionRefs: { API_TOKEN: reference } } as any)).toMatchObject({ success: false });
  });
  it.each(['conflict', 'scope', 'provider'])('rejects %s before any provider call', async (reason) => {
    const f = await fixture();
    const ref = reason === 'scope' ? { ...reference, destination: { ...reference.destination, accountId: '999999999999', secretArn: reference.destination.secretArn.replace(accountId, '999999999999') } }
      : reason === 'provider' ? { destination: { provider: 'gcp-secret-manager', projectId: 'cloud-project', projectNumber: '123456789012', secretId: 'token' }, version: '7' } : reference;
    expect(await f.adapter.setEnvVars(environment, service, reason === 'conflict' ? { API_TOKEN: 'must-not-send' } : {}, { secretVersionRefs: { API_TOKEN: ref } } as any)).toMatchObject({ success: false });
    expect(f.requests).toHaveLength(0);
  });
});
