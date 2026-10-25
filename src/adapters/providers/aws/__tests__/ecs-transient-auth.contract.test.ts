import { describe, expect, it, vi } from 'vitest';
import { EcsExpressAdapter } from '../ecs-express.adapter.js';
import { createAwsDeploymentCredentialProvider } from '../aws-deployment-auth.js';
import type { CloudDeploymentAdapterInputV1, CloudDeploymentConnectionV1 } from '../../../../domain/ports/cloud-deployment.port.js';
import { observeRuntimeAccess, planRuntimeAccess } from '../../../../domain/services/runtime-access.service.js';
import { awsDeploymentNames } from '../aws-cloud-deployment.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';

// Reconstructed official STS Query transport. No real Google/AWS trust or cloud writes.
// https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html
const accountId = '123456789012', region = 'us-west-2';
const principal = (name: string, id: string) => ({ kind: 'aws-role' as const, accountId, roleArn: `arn:aws:iam::${accountId}:role/${name}`, roleId: id,
  audience: `https://hypervibe.dev/deployment/${name}` });
const provision = principal('provision', 'AROA1111111111111111'), release = principal('release', 'AROA2222222222222222');
const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connection: CloudDeploymentConnectionV1 = { schemaVersion: 1, purpose: 'deployment', installationId, planDigest: 'a'.repeat(64),
  customerId: 'customer', appId: 'app', environment: 'production', provider: 'aws', hostingProvider: 'ecs', nativeScope: { accountId, region },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'b'.repeat(40), specDigest: 'c'.repeat(64) },
  deployment: { hostingProvider: 'ecs', region, workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789', serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com',
    subject: '123456789012345678901', issuer: 'https://accounts.google.com' }, principals: { provision, release },
  runtimeIdentities: (['task', 'execution', 'infrastructure'] as const).map((purpose, index) => ({ workload: 'web', installationId, owner: 'd'.repeat(64),
    principal: { kind: 'aws-role', purpose, accountId, roleArn: `arn:aws:iam::${accountId}:role/${purpose}`, roleId: `AROA333333333333333${index}` } })) };
function fixture(replacement = false, deployment = false) {
  const approved = structuredClone(connection);
  const reference = { destination: { provider: 'aws-secrets' as const, accountId, region, secretArn: `arn:aws:secretsmanager:${region}:${accountId}:secret:runtime-api-AbCdEf` }, version: 'a'.repeat(32) };
  if (deployment) approved.deployment.workloads[0].runtimeSecrets = [{ key: 'API_KEY', reference }];
  const names = awsDeploymentNames(approved), clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/${names.clusterName}`, serviceArn = clusterArn.replace(':cluster/', ':service/') + '/web';
  const environment: Environment = { id: 'local-environment-id', projectId: 'local-project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: clusterArn, environmentId: clusterArn, services: {} } };
  if (deployment) environment.platformBindings.awsNetwork = { accountId, region, vpcId: 'vpc-1', subnetIds: ['subnet-1', 'subnet-2'], workloadSecurityGroupId: 'sg-1' };
  const tags = [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: environment.id }];
  const state: { created?: any; replacedRuntime: boolean } = { replacedRuntime: false };
  const json = (body: unknown) => ({ response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(body)) } });
  const xml = (body: string) => ({ response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(body) } });
  const requests: Array<{ operation: string; token: string | undefined }> = [];
  const handler = { handle: async (request: any) => {
    const query = new URLSearchParams(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8')), operation = query.get('Action') ?? request.headers['x-amz-target']?.split('.').at(-1);
    const raw = typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8');
    const body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(query);
    requests.push({ operation, token: request.headers['x-amz-security-token'] });
    const roleId = replacement ? 'AROA9999999999999999' : provision.roleId;
    const roleName = query.get('RoleName');
    const runtime = approved.runtimeIdentities.find(item => item.principal.kind === 'aws-role' && item.principal.roleArn.endsWith('/' + roleName));
    if (operation === 'GetRole' && runtime?.principal.kind === 'aws-role') return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(`<GetRoleResponse><GetRoleResult><Role><RoleName>${roleName}</RoleName><Arn>${runtime.principal.roleArn}</Arn><RoleId>${state.replacedRuntime ? 'AROA9999999999999999' : runtime.principal.roleId}</RoleId><Tags><member><Key>hypervibe-owner</Key><Value>${runtime.owner}</Value></member><member><Key>hypervibe-installation</Key><Value>${installationId}</Value></member></Tags><AssumeRolePolicyDocument>${encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: roleName === 'infrastructure' ? 'ecs.amazonaws.com' : 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] }))}</AssumeRolePolicyDocument></Role></GetRoleResult></GetRoleResponse>`) } };
    if (operation === 'ListRolePolicies' || operation === 'ListAttachedRolePolicies') { const managed = roleName === 'execution' ? 'AmazonECSTaskExecutionRolePolicy' : roleName === 'infrastructure' ? 'AmazonECSInfrastructureRoleforExpressGatewayServices' : undefined;
      const body = operation === 'ListRolePolicies' ? `<PolicyNames>${deployment && roleName === 'execution' ? '<member>hypervibe-deployment-access</member>' : ''}</PolicyNames>` : `<AttachedPolicies>${managed ? `<member><PolicyArn>arn:aws:iam::aws:policy/service-role/${managed}</PolicyArn></member>` : ''}</AttachedPolicies>`;
      return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(`<${operation}Response><${operation}Result>${body}<IsTruncated>false</IsTruncated></${operation}Result></${operation}Response>`) } }; }
    if (deployment) {
      if (operation === 'GetRolePolicy') return xml(`<GetRolePolicyResponse><GetRolePolicyResult><RoleName>execution</RoleName><PolicyName>hypervibe-deployment-access</PolicyName><PolicyDocument>${encodeURIComponent(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [reference.destination.secretArn] }] }))}</PolicyDocument></GetRolePolicyResult></GetRolePolicyResponse>`);
      if (operation === 'DescribeSecret') return json({ ARN: reference.destination.secretArn, CreatedDate: 1_700_000_000 });
      if (operation === 'ListSecretVersionIds') return json({ ARN: reference.destination.secretArn, Versions: [{ VersionId: reference.version }] });
      if (operation === 'DescribeVpcs') return xml('<DescribeVpcsResponse><vpcSet><item><vpcId>vpc-1</vpcId><isDefault>true</isDefault></item></vpcSet></DescribeVpcsResponse>');
      if (operation === 'DescribeSubnets') return xml('<DescribeSubnetsResponse><subnetSet>' + [1, 2].map(n => `<item><subnetId>subnet-${n}</subnetId><vpcId>vpc-1</vpcId><defaultForAz>true</defaultForAz><availabilityZone>${region}${n === 1 ? 'a' : 'b'}</availabilityZone></item>`).join('') + '</subnetSet></DescribeSubnetsResponse>');
      if (operation === 'DescribeSecurityGroups') return xml(`<DescribeSecurityGroupsResponse><securityGroupInfo><item><groupId>sg-1</groupId><groupName>${names.clusterName}-hypervibe-workloads</groupName><vpcId>vpc-1</vpcId><tagSet>${[...tags, { key: 'hypervibe-ecs-cluster-arn', value: clusterArn }].map(t => `<item><key>${t.key}</key><value>${t.value}</value></item>`).join('')}</tagSet></item></securityGroupInfo></DescribeSecurityGroupsResponse>`);
      if (operation === 'DescribeRepositories') return json({ repositories: [{ repositoryName: `hypervibe/${names.clusterName}`, repositoryArn: `arn:aws:ecr:${region}:${accountId}:repository/hypervibe/${names.clusterName}`, repositoryUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/hypervibe/${names.clusterName}` }] });
      if (operation === 'ListTagsForResource') return json({ tags: tags.map(t => ({ Key: t.key, Value: t.value })) });
      if (operation === 'ListServices') return json({ serviceArns: state.created ? [serviceArn] : [] });
      if (operation === 'CreateExpressGatewayService') { state.created = body; return json({ service: { serviceArn, serviceName: 'web' } }); }
      if (operation === 'DescribeExpressGatewayService') return json({ service: { serviceArn, cluster: clusterArn, createdAt: 1_700_000_000, tags, currentDeployment: 'revision-1', status: { statusCode: 'ACTIVE' },
        activeConfigurations: [{ serviceRevisionArn: 'revision-1', executionRoleArn: `arn:aws:iam::${accountId}:role/execution`, taskRoleArn: `arn:aws:iam::${accountId}:role/task`, taskDefinitionArn: `arn:aws:ecs:${region}:${accountId}:task-definition/fixture:1`,
          primaryContainer: state.created?.primaryContainer, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'https://app.example.test' }] }] } });
      if (operation === 'DescribeTaskDefinition') return json({ taskDefinition: { taskDefinitionArn: `arn:aws:ecs:${region}:${accountId}:task-definition/fixture:1`, family: 'fixture', revision: 1, status: 'ACTIVE', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512',
        executionRoleArn: `arn:aws:iam::${accountId}:role/execution`, taskRoleArn: `arn:aws:iam::${accountId}:role/task`, containerDefinitions: [{ name: 'Main', ...state.created?.primaryContainer, portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp' }] }] } });
    }
    const responseBody = operation === 'GetCallerIdentity' ? `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${accountId}</Account><UserId>${roleId}:session</UserId><Arn>arn:aws:sts::${accountId}:assumed-role/provision/session</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`
      : JSON.stringify(operation === 'ListClusters' ? { clusterArns: [] } : { repositories: [] });
    return { response: { statusCode: 200, headers: { 'content-type': operation === 'GetCallerIdentity' ? 'text/xml' : 'application/x-amz-json-1.1' }, body: Buffer.from(responseBody) } };
  } };
  const getCredentials = vi.fn(async () => ({ accessKeyId: 'ASIA1111111111111111', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session', expiresAt: new Date(Date.now() + 900_000).toISOString() }));
  const input: CloudDeploymentAdapterInputV1 = { connection: approved, capability: 'provision', authentication: { kind: 'aws-sts', principal: provision, getCredentials } };
  return { input, handler, requests, getCredentials, environment, reference, state };
}
describe('ECS transient access real SDK boundary', () => {
  it('does not remove an approved secret reference through the retired-variable path', async () => {
    const f = fixture(false, true), adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const service: Service = { id: 'local-service', projectId: f.environment.projectId, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const cluster = f.environment.platformBindings.projectId as string;
    f.environment.platformBindings.services = { web: { serviceId: cluster.replace(':cluster/', ':service/') + '/web' } };
    f.state.created = { primaryContainer: { image: 'example.invalid/image:bootstrap', secrets: [{ name: 'API_KEY', valueFrom: f.reference.destination.secretArn + ':::' + f.reference.version }] } };
    const result = await adapter.deleteEnvVars(f.environment, service, ['API_KEY']);
    expect(result.success).toBe(false);
    expect(f.requests.filter(item => /^(Create|Put|Attach|Tag|Delete|Update|Register)/.test(item.operation))).toEqual([]);
    await adapter.disconnect();
  });
  it.each(['version', 'omitted'] as const)('rejects a changed %s reference after reviewed runtime binding and before workload mutation', async change => {
    const f = fixture(false, true), adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const environmentSpec = { hosting: { provider: 'ecs', region }, services: { web: { workloadKind: 'web' } }, secretDestinations: { API_KEY: f.reference } } as any;
    const service: Service = { id: 'local-service', projectId: f.environment.projectId, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const request = { environment: f.environment, environmentSpec, service, mode: 'ensure' as const };
    const observed = await adapter.runtimeIdentities.inspect(request); if (observed.state !== 'action') throw new Error('Missing runtime binding');
    const bound = await adapter.runtimeIdentities.apply({ ...request, step: observed.step, attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    f.environment.platformBindings.runtimeIdentities = { web: bound.binding! };
    const result = await adapter.deploy(service, f.environment, {}, { requireNewWorkload: true, deferDeployment: true,
      secretVersionRefs: change === 'version' ? { API_KEY: { ...f.reference, version: 'b'.repeat(32) } } : {} });
    expect(result.receipt.success).toBe(false);
    expect(f.requests.filter(item => /^(Create|Put|Attach|Tag|Delete|Update|Register)/.test(item.operation))).toEqual([]);
    await adapter.disconnect();
  });
  it('creates the first workload with immutable references and preinstalled task/execution roles, without IAM writes', async () => {
    const f = fixture(false, true); const adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const environmentSpec = { hosting: { provider: 'ecs', region }, services: { web: { workloadKind: 'web' } }, secretDestinations: { API_KEY: f.reference } } as any;
    const service: Service = { id: 'local-service', projectId: f.environment.projectId, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const request = { environment: f.environment, environmentSpec, service, mode: 'ensure' as const };
    const observed = await adapter.runtimeIdentities.inspect(request); expect(observed.state).toBe('action'); if (observed.state !== 'action') return;
    const bound = await adapter.runtimeIdentities.apply({ ...request, step: observed.step, attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }); expect(bound.receipt.success).toBe(true);
    f.environment.platformBindings.runtimeIdentities = { web: bound.binding! };
    const result = await adapter.deploy(service, f.environment, {}, { requireNewWorkload: true, deferDeployment: true, secretVersionRefs: { API_KEY: f.reference } });
    expect(result.receipt.success, JSON.stringify(result.receipt)).toBe(true);
    expect(result.receipt.data?.resourceUid).toBe('2023-11-14T22:13:20.000Z');
    expect(f.state.created).toMatchObject({ taskRoleArn: `arn:aws:iam::${accountId}:role/task`, executionRoleArn: `arn:aws:iam::${accountId}:role/execution`,
      primaryContainer: { secrets: [{ name: 'API_KEY', valueFrom: f.reference.destination.secretArn + ':::' + f.reference.version }] } });
    expect(f.requests.filter(item => /^(Create|Put|Attach|Tag|Delete)/.test(item.operation)).map(item => item.operation)).toEqual(['CreateExpressGatewayService']);
    f.state.replacedRuntime = true; expect((await adapter.runtimeIdentities.inspect({ ...request, binding: bound.binding })).state).toBe('unknown'); await adapter.disconnect();
  });
  it('plans an explicit read-only first-runtime binding from installer lifetime evidence without IAM mutation', async () => {
    const f = fixture(); const adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const names = awsDeploymentNames(connection), clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/${names.clusterName}`;
    const environment: Environment = { id: 'local-environment-id', projectId: 'local-project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: clusterArn, environmentId: clusterArn, services: {} } };
    const environmentSpec = { hosting: { provider: 'ecs', region }, services: { web: { workloadKind: 'web' } } } as any;
    const observed = await observeRuntimeAccess({ environment, environmentSpec, hosting: adapter, storageAdapters: {} });
    const actions = planRuntimeAccess(observed);
    expect(actions).toHaveLength(1);
    expect(observed.identities[0].observation.state).toBe('action');
    if (observed.identities[0].observation.state !== 'action') throw new Error('Missing explicit binding step');
    const result = await adapter.runtimeIdentities.apply({ environment, environmentSpec, service: { name: 'web', buildConfig: { workloadKind: 'web' } }, mode: 'ensure',
      step: observed.identities[0].observation.step, attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(result.receipt.success).toBe(true); expect(result.binding?.evidence.roleId).toBe(connection.runtimeIdentities[0].principal.kind === 'aws-role' ? connection.runtimeIdentities[0].principal.roleId : '');
    const again = await adapter.runtimeIdentities.inspect({ environment, environmentSpec, service: { name: 'web', buildConfig: { workloadKind: 'web' } }, mode: 'ensure', binding: result.binding });
    expect(again.state).toBe('ready'); expect(f.requests.some(item => /^(Create|Put|Attach|Tag|Delete)/.test(item.operation))).toBe(false); await adapter.disconnect();
  });
  it('uses refresh callbacks and includes STS session token on independently verified native requests', async () => {
    const f = fixture(); const provider = createAwsDeploymentCredentialProvider(f.input, { requestHandler: f.handler });
    await provider(AbortSignal.timeout(1000)); await provider(AbortSignal.timeout(1000));
    expect(f.getCredentials).toHaveBeenCalledTimes(2); expect(f.requests.map(item => item.operation)).toEqual(['GetCallerIdentity', 'GetCallerIdentity']);
    expect(f.requests.every(item => item.token === 'synthetic-session')).toBe(true);
    const adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const verified = await adapter.verify(); expect(verified, JSON.stringify({ verified, requests: f.requests })).toMatchObject({ success: true });
    expect(f.requests.filter(item => item.operation !== 'GetCallerIdentity').every(item => item.token === 'synthetic-session')).toBe(true);
    expect(() => adapter.configureTarget({ region: 'us-east-1' })).toThrow(); await adapter.disconnect();
  });
  it('rejects same-name replacement role before any ECS/ECR call and never returns raw credentials', async () => {
    const f = fixture(true); const adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const result = await adapter.verify(); expect(result.success).toBe(false);
    expect(f.requests.every(item => item.operation === 'GetCallerIdentity')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|synthetic-session/); await adapter.disconnect();
  });
});
