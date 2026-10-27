import { vi } from 'vitest';
import type { CloudDeploymentAdapterInputV1, CloudDeploymentConnectionV1 } from '../../../../domain/ports/cloud-deployment.port.js';
import { awsDeploymentNames } from '../aws-cloud-deployment.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';

// Reconstructed official STS Query transport. No real Google/AWS trust or cloud writes.
// https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html
export const accountId = '123456789012', region = 'us-west-2';
const principal = (name: string, id: string) => ({ kind: 'aws-role' as const, accountId, roleArn: `arn:aws:iam::${accountId}:role/${name}`, roleId: id,
  audience: `https://hypervibe.dev/deployment/${name}` });
export const provision = principal('provision', 'AROA1111111111111111'), release = principal('release', 'AROA2222222222222222');
export const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const connection: CloudDeploymentConnectionV1 = { schemaVersion: 1, purpose: 'deployment', installationId, planDigest: 'a'.repeat(64),
  customerId: 'customer', appId: 'app', environment: 'production', provider: 'aws', hostingProvider: 'ecs', nativeScope: { accountId, region },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'b'.repeat(40), specDigest: 'c'.repeat(64) },
  deployment: { hostingProvider: 'ecs', region, workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789', serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com',
    subject: '123456789012345678901', issuer: 'https://accounts.google.com' }, principals: { provision, release },
  runtimeIdentities: (['task', 'execution', 'infrastructure'] as const).map((purpose, index) => ({ workload: 'web', installationId, owner: 'd'.repeat(64),
    principal: { kind: 'aws-role', purpose, accountId, roleArn: `arn:aws:iam::${accountId}:role/${purpose}`, roleId: `AROA333333333333333${index}` } })) };
export function ecsTransientFixture(replacement = false, deployment = false) {
  const approved = structuredClone(connection);
  const reference = { destination: { provider: 'aws-secrets' as const, accountId, region, secretArn: `arn:aws:secretsmanager:${region}:${accountId}:secret:runtime-api-AbCdEf` }, version: 'a'.repeat(32) };
  if (deployment) approved.deployment.workloads[0].runtimeSecrets = [{ key: 'API_KEY', reference }];
  const names = awsDeploymentNames(approved), clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/${names.clusterName}`, serviceArn = clusterArn.replace(':cluster/', ':service/') + '/web';
  const environment: Environment = { id: 'local-environment-id', projectId: 'local-project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: clusterArn, environmentId: clusterArn, services: {} } };
  if (deployment) environment.platformBindings.awsNetwork = { accountId, region, vpcId: 'vpc-1', subnetIds: ['subnet-1', 'subnet-2'], workloadSecurityGroupId: 'sg-1' };
  const tags = [{ key: 'hypervibe-owner', value: 'd'.repeat(64) }, { key: 'hypervibe-installation', value: installationId }, { key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: environment.id }];
  const state: { created?: any; replacedRuntime: boolean; nativeTaskRole?: string; loseCreate?: boolean } = { replacedRuntime: false };
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
      if (operation === 'CreateExpressGatewayService') { state.created = body; if (state.loseCreate) throw new Error('Synthetic lost create acknowledgment'); return json({ service: { serviceArn, serviceName: 'web' } }); }
      if (operation === 'DescribeExpressGatewayService') return json({ service: { serviceArn, cluster: clusterArn, createdAt: 1_700_000_000, tags, currentDeployment: 'revision-1', status: { statusCode: 'ACTIVE' },
        activeConfigurations: [{ serviceRevisionArn: 'revision-1', executionRoleArn: `arn:aws:iam::${accountId}:role/execution`, taskRoleArn: state.nativeTaskRole, taskDefinitionArn: `arn:aws:ecs:${region}:${accountId}:task-definition/fixture:1`,
          primaryContainer: state.created?.primaryContainer, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'https://app.example.test' }] }] } });
      if (operation === 'DescribeTaskDefinition') return json({ taskDefinition: { taskDefinitionArn: `arn:aws:ecs:${region}:${accountId}:task-definition/fixture:1`, family: 'fixture', revision: 1, status: 'ACTIVE', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512',
        executionRoleArn: `arn:aws:iam::${accountId}:role/execution`, taskRoleArn: state.nativeTaskRole, containerDefinitions: [{ name: 'Main', ...state.created?.primaryContainer, portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp' }] }] } });
    }
    const responseBody = operation === 'GetCallerIdentity' ? `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${accountId}</Account><UserId>${roleId}:session</UserId><Arn>arn:aws:sts::${accountId}:assumed-role/provision/session</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`
      : JSON.stringify(operation === 'ListClusters' ? { clusterArns: [] } : { repositories: [] });
    return { response: { statusCode: 200, headers: { 'content-type': operation === 'GetCallerIdentity' ? 'text/xml' : 'application/x-amz-json-1.1' }, body: Buffer.from(responseBody) } };
  } };
  const getCredentials = vi.fn(async () => ({ accessKeyId: 'ASIA1111111111111111', secretAccessKey: 'synthetic-secret', sessionToken: 'synthetic-session', expiresAt: new Date(Date.now() + 900_000).toISOString() }));
  const input: CloudDeploymentAdapterInputV1 = { connection: approved, capability: 'provision', authentication: { kind: 'aws-sts', principal: provision, getCredentials } };
  return { input, handler, requests, getCredentials, environment, reference, state };
}
