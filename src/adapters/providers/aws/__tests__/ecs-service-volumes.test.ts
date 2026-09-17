import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFSClient } from '@aws-sdk/client-efs';
import { ECSClient } from '@aws-sdk/client-ecs';
import { EC2Client } from '@aws-sdk/client-ec2';
import { IAMClient } from '@aws-sdk/client-iam';
import { EcsExpressAdapter } from '../ecs-express.adapter.js';
import { resourceName, resourceScopeSuffix } from '../../../../domain/services/resource-names.js';
import { observeServiceVolumes, planServiceVolumes, applyServiceVolumeAction, parseServiceVolumeBindings } from '../../../../domain/services/service-volume.service.js';
import { environmentSpecSchema } from '../../../../domain/spec/spec.schema.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { ObservedState } from '../../../../domain/ports/observe.port.js';

// SDK HTTP serialization/deserialization over synthetic official-API-shaped state.
// Sources: ECS Express BYO task-definition guide, EFS CreateFileSystem /
// DescribeFileSystems APIs, EC2 DescribeSubnets. No live compatibility claim.
const account = '123456789012';
const region = 'us-west-2';
const cluster = `arn:aws:ecs:${region}:${account}:cluster/staging`;
const service = `arn:aws:ecs:${region}:${account}:service/staging/web`;
const role = `arn:aws:iam::${account}:role/existing-runtime`;
const taskDefinitionArn = `arn:aws:ecs:${region}:${account}:task-definition/existing:1`;
const target = { projectId: cluster, environmentId: cluster, serviceId: service, mountPath: '/data', instanceScope: { accountId: account, region, vpcId: 'vpc-12345678', workloadSecurityGroupId: 'sg-12345678', subnets: JSON.stringify([{ subnetId: 'subnet-11111111', availabilityZoneId: 'usw2-az1' }, { subnetId: 'subnet-22222222', availabilityZoneId: 'usw2-az2' }]), taskRoleArn: role, taskRoleOwned: 'false' } };

async function fixture(mounted = false, withoutRole = false, registrationFailure = false) {
  let filesystem: any;
  let denied = false;
  let lost = false;
  const requests: Array<{ method: string; path: string; body: any }> = [];
  let activeArn = taskDefinitionArn;
  let deployment = 'revision-1';
  const task: any = { taskDefinitionArn, family: 'existing', revision: 1, status: 'ACTIVE', requiresCompatibilities: ['FARGATE'], networkMode: 'awsvpc', taskRoleArn: role, executionRoleArn: `arn:aws:iam::${account}:role/execution`, cpu: '256', memory: '512', containerDefinitions: [{ name: 'Main', image: 'image@sha256:' + 'a'.repeat(64), environment: [{ name: 'EXISTING', value: 'remove' }, { name: 'KEEP', value: 'retain' }], portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp' }], ...(mounted ? { mountPoints: [{ sourceVolume: 'hypervibe-data', containerPath: '/data', readOnly: false }] } : {}) }], ...(mounted ? { volumes: [{ name: 'hypervibe-data', efsVolumeConfiguration: { fileSystemId: 'fs-0123456789abcdef0', transitEncryption: 'ENABLED', authorizationConfig: { accessPointId: 'fsap-0123456789abcdef0', iam: 'ENABLED' } } }] } : {}) };
  let registered: any;
  let externalTask: any;
  const runtimeRoleName = resourceName('files', { scope: [service], maxLength: 64 });
  const expectedRole = withoutRole ? `arn:aws:iam::${account}:role/${runtimeRoleName}` : role;
  if (withoutRole) delete task.taskRoleArn;
  let runtimeRole = false;
  const trustPolicy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
  let group: any;
  let ingress = false;
  let accessPoint: any;
  let policy: any;
  const mounts: any[] = [];
  const ownership = resourceScopeSuffix([cluster, service]);
  const family = resourceName('files', { scope: [cluster, service], maxLength: 255 });
  const groupXml = () => group ? `<item><groupId>sg-eeeeeeee</groupId><groupName>${family}</groupName><ownerId>${account}</ownerId><vpcId>vpc-12345678</vpcId><tagSet><item><key>hypervibe-volume-service</key><value>${ownership}</value></item></tagSet></item>` : '';
  const ruleXml = () => ingress ? `<item><securityGroupRuleId>sgr-eeeeeeee</securityGroupRuleId><groupId>sg-eeeeeeee</groupId><groupOwnerId>${account}</groupOwnerId><isEgress>false</isEgress><ipProtocol>tcp</ipProtocol><fromPort>2049</fromPort><toPort>2049</toPort><referencedGroupInfo><groupId>sg-12345678</groupId><userId>${account}</userId></referencedGroupInfo></item>` : '';
  const handler = { handle: async (request: any) => {
    let body: any;
    try { body = JSON.parse(String(request.body ?? '{}')); } catch { body = Object.fromEntries(new URLSearchParams(String(request.body))); }
    requests.push({ method: request.method, path: request.path, body });
    const output = (value: unknown, statusCode = 200, headers = { 'content-type': 'application/json' }) => ({ response: { statusCode, headers, body: new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)) } });
    const operation = request.headers['x-amz-target']?.split('.').at(-1);
    if (operation === 'DescribeExpressGatewayService') return output({ service: { serviceArn: service, cluster, currentDeployment: deployment, tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hypervibe-environment-id', value: 'local-env' }], status: { statusCode: 'ACTIVE' }, activeConfigurations: [{ serviceRevisionArn: deployment, taskDefinitionArn: activeArn, taskRoleArn: role, primaryContainer: { image: task.containerDefinitions[0].image, environment: task.containerDefinitions[0].environment }, ingressPaths: [{ accessType: 'PUBLIC', endpoint: 'web.example.test' }], networkConfiguration: { subnets: ['subnet-11111111', 'subnet-22222222'], securityGroups: ['sg-12345678'] } }] } });
    if (operation === 'DescribeTaskDefinition') return output({ taskDefinition: body.taskDefinition === taskDefinitionArn ? task : body.taskDefinition === externalTask?.taskDefinitionArn ? externalTask : registered, tags: [{ key: 'managed-by', value: 'hypervibe' }] });
    if (operation === 'RegisterTaskDefinition') {
      if (registrationFailure) return output({ __type: 'ServerException', message: 'ambiguous registration' }, 500);
      if (mounted) {
        expect(body).toMatchObject({ family: 'existing', volumes: task.volumes, taskRoleArn: role });
        expect(body.containerDefinitions[0].mountPoints).toEqual(task.containerDefinitions[0].mountPoints);
        expect(body.containerDefinitions[0].environment).toEqual([{ name: 'KEEP', value: 'retain' }]);
      } else {
        expect(body).toMatchObject({ family, taskRoleArn: expectedRole, volumes: [{ name: 'hypervibe-data', efsVolumeConfiguration: { fileSystemId: 'fs-0123456789abcdef0', rootDirectory: '/', transitEncryption: 'ENABLED', authorizationConfig: { accessPointId: 'fsap-0123456789abcdef0', iam: 'ENABLED' } } }] });
      }
      registered = { ...body, taskDefinitionArn: `arn:aws:ecs:${region}:${account}:task-definition/${body.family}:2`, revision: 2, status: 'ACTIVE' };
      return output({ taskDefinition: registered });
    }
    if (operation === 'ListTaskDefinitions') return output({ taskDefinitionArns: registered ? [registered.taskDefinitionArn] : [] });
    if (operation === 'UpdateExpressGatewayService') {
      expect(body.taskDefinitionArn).toBe(registered?.taskDefinitionArn);
      expect(body.primaryContainer).toBeUndefined();
      activeArn = body.taskDefinitionArn; deployment = 'revision-2';
      return output({ service: { serviceArn: service, cluster } });
    }
    if (body.Action === 'DescribeSubnets') return output(`<DescribeSubnetsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><subnetSet>${['1', '2'].map((id) => `<item><subnetId>subnet-${id.repeat(8)}</subnetId><vpcId>vpc-12345678</vpcId><availabilityZoneId>usw2-az${id}</availabilityZoneId><ownerId>${account}</ownerId><state>available</state></item>`).join('')}</subnetSet></DescribeSubnetsResponse>`, 200, { 'content-type': 'text/xml' });
    if (body.Action === 'DescribeSecurityGroups') return output(`<DescribeSecurityGroupsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><securityGroupInfo>${groupXml()}</securityGroupInfo></DescribeSecurityGroupsResponse>`, 200, { 'content-type': 'text/xml' });
    if (body.Action === 'CreateSecurityGroup') {
      expect(body.VpcId).toBe('vpc-12345678'); group = true;
      return output('<CreateSecurityGroupResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><groupId>sg-eeeeeeee</groupId></CreateSecurityGroupResponse>', 200, { 'content-type': 'text/xml' });
    }
    if (body.Action === 'DescribeSecurityGroupRules') return output(`<DescribeSecurityGroupRulesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><securityGroupRuleSet>${ruleXml()}</securityGroupRuleSet></DescribeSecurityGroupRulesResponse>`, 200, { 'content-type': 'text/xml' });
    if (body.Action === 'AuthorizeSecurityGroupIngress') {
      expect(body['IpPermissions.1.FromPort']).toBe('2049');
      expect(body['IpPermissions.1.Groups.1.GroupId']).toBe('sg-12345678');
      ingress = true;
      return output(`<AuthorizeSecurityGroupIngressResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><return>true</return><securityGroupRuleSet>${ruleXml()}</securityGroupRuleSet></AuthorizeSecurityGroupIngressResponse>`, 200, { 'content-type': 'text/xml' });
    }
    if (body.Action === 'GetRole' || body.Action === 'CreateRole') {
      expect(body.RoleName).toBe(runtimeRoleName);
      if (body.Action === 'CreateRole') {
        expect(JSON.parse(body.AssumeRolePolicyDocument)).toEqual(trustPolicy);
        runtimeRole = true;
      }
      if (!runtimeRole) return output('<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>NoSuchEntity</Code><Message>No role</Message></Error></ErrorResponse>', 404, { 'content-type': 'text/xml' });
      return output(`<${body.Action}Response xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><${body.Action}Result><Role><Path>/</Path><RoleName>${runtimeRoleName}</RoleName><RoleId>AROATESTROLE000000</RoleId><Arn>${expectedRole}</Arn><CreateDate>2026-09-16T00:00:00Z</CreateDate><AssumeRolePolicyDocument>${encodeURIComponent(JSON.stringify(trustPolicy))}</AssumeRolePolicyDocument><Tags><member><Key>hypervibe-volume-service</Key><Value>${ownership}</Value></member></Tags></Role></${body.Action}Result></${body.Action}Response>`, 200, { 'content-type': 'text/xml' });
    }
    if (request.path === '/2015-02-01/access-points' && request.method === 'GET') return output({ AccessPoints: accessPoint ? [accessPoint] : [] });
    if (request.path === '/2015-02-01/access-points' && request.method === 'POST') {
      expect(body).toMatchObject({ FileSystemId: 'fs-0123456789abcdef0', PosixUser: { Uid: 1000, Gid: 1000 }, RootDirectory: { Path: '/data', CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '0700' } } });
      accessPoint = { AccessPointId: 'fsap-0123456789abcdef0', FileSystemId: 'fs-0123456789abcdef0', ClientToken: body.ClientToken, OwnerId: account, LifeCycleState: 'available', PosixUser: { Uid: 1000, Gid: 1000 }, RootDirectory: { Path: '/data' } };
      return output(accessPoint, 201);
    }
    if (request.path.endsWith('/policy')) {
      if (request.method === 'GET') return policy ? output({ FileSystemId: 'fs-0123456789abcdef0', Policy: JSON.stringify(policy) }) : output({ ErrorCode: 'PolicyNotFound', Message: 'No policy' }, 404, { 'content-type': 'application/json', 'x-amzn-errortype': 'PolicyNotFound' } as any);
      expect(request.method).toBe('PUT');
      policy = JSON.parse(body.Policy);
      expect(policy.Statement).toContainEqual(expect.objectContaining({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }));
      expect(policy.Statement).toContainEqual(expect.objectContaining({ Effect: 'Deny', Condition: { StringNotEquals: { 'elasticfilesystem:AccessPointArn': `arn:aws:elasticfilesystem:${region}:${account}:access-point/fsap-0123456789abcdef0` } } }));
      return output({ FileSystemId: 'fs-0123456789abcdef0', Policy: body.Policy });
    }
    if (request.path.endsWith('/security-groups') && request.method === 'GET') return output({ SecurityGroups: ['sg-eeeeeeee'] });
    if (request.path === '/2015-02-01/mount-targets' && request.method === 'GET') return output({ MountTargets: mounts });
    if (request.path === '/2015-02-01/mount-targets' && request.method === 'POST') {
      expect(body).toMatchObject({ FileSystemId: 'fs-0123456789abcdef0', SecurityGroups: ['sg-eeeeeeee'] });
      const index = body.SubnetId === 'subnet-11111111' ? '1' : '2';
      const mount = { MountTargetId: `fsmt-${index.repeat(17)}`, FileSystemId: 'fs-0123456789abcdef0', OwnerId: account, VpcId: 'vpc-12345678', SubnetId: body.SubnetId, AvailabilityZoneId: `usw2-az${index}`, LifeCycleState: 'available', IpAddress: `10.0.${index}.20`, NetworkInterfaceId: `eni-${index.repeat(8)}` };
      mounts.push(mount); return output(mount, 201);
    }
    if (request.path === '/2015-02-01/file-systems' && request.method === 'GET') {
      if (denied) return output({ ErrorCode: 'AccessDeniedException', Message: 'private-secret' }, 403);
      return output({ FileSystems: filesystem ? [filesystem] : [] });
    }
    if (request.path.startsWith('/2015-02-01/file-systems/fs-') && request.method === 'GET') return output({ FileSystems: filesystem ? [filesystem] : [] });
    if (request.path === '/2015-02-01/file-systems' && request.method === 'POST') {
      expect(body).toMatchObject({ Encrypted: true, PerformanceMode: 'generalPurpose', ThroughputMode: 'elastic' });
      filesystem = { FileSystemId: 'fs-0123456789abcdef0', FileSystemArn: `arn:aws:elasticfilesystem:${region}:${account}:file-system/fs-0123456789abcdef0`, CreationToken: body.CreationToken, OwnerId: account, CreationTime: 1700000000, LifeCycleState: 'available', Encrypted: true, PerformanceMode: 'generalPurpose', ThroughputMode: 'elastic', NumberOfMountTargets: 0, SizeInBytes: { Value: 0 }, Tags: body.Tags };
      if (lost) throw new Error('Lost acknowledgement private-secret');
      return output(filesystem, 201);
    }
    throw new Error(`Unexpected request ${request.method} ${request.path} ${operation ?? body.Action}`);
  } };
  const config = { region, credentials: { accessKeyId: 'AKIAEXAMPLE12345678', secretAccessKey: 'private-secret-value-long-enough-for-validation' }, requestHandler: handler, maxAttempts: registrationFailure ? 3 : 1 };
  const adapter = new EcsExpressAdapter();
  await adapter.connect(config.credentials);
  const internals = adapter as any;
  internals.accountId = account;
  internals.clients = { ...internals.clients, efs: new EFSClient(config), ecs: new ECSClient(config), ec2: new EC2Client(config), iam: new IAMClient(config) };
  return { adapter, requests, deny: () => { denied = true; }, lose: () => { lost = true; }, advanceRuntime: () => {
    externalTask = { ...task, taskDefinitionArn: taskDefinitionArn.replace(/:1$/, ':3'), containerDefinitions: task.containerDefinitions.map((container: any) => ({ ...container, image: 'new-image@sha256:' + 'c'.repeat(64) })) };
    activeArn = externalTask.taskDefinitionArn;
  } };
}

afterEach(() => vi.restoreAllMocks());

describe('ECS Express retained EFS lifecycle', () => {
  it('declares backing data, network, IAM policy, task-definition and attachment separately', async () => {
    const { adapter } = await fixture();
    const volumes = (adapter as any).serviceVolumes;
    expect(volumes?.staged).toBeDefined();
    expect(volumes.staged.components(target).map((entry: any) => entry.key)).toEqual(expect.arrayContaining(['filesystem', 'security-group', 'nfs-ingress', 'access-point', 'filesystem-policy', 'mount-target-usw2-az1', 'mount-target-usw2-az2', 'task-definition', 'attachment']));
    expect(volumes.staged.components(target).some((entry: any) => entry.key === 'runtime-role')).toBe(false);
    expect(await volumes.create(target)).toMatchObject({ success: false, mutationAttempted: false });
  });
  it('creates only an encrypted EFS filesystem for the filesystem action and returns provider identity', async () => {
    const live = await fixture();
    const staged = (live.adapter as any).serviceVolumes?.staged;
    expect(staged).toBeDefined();
    expect(await staged.observeComponent(target, 'filesystem', {})).toEqual({ state: 'absent' });
    expect(await staged.applyComponent(target, 'filesystem', {})).toMatchObject({ success: true, mutationAttempted: true, externalId: 'fs-0123456789abcdef0' });
    expect(live.requests.filter((request) => request.path === '/2015-02-01/file-systems' && request.method === 'POST')).toHaveLength(1);
    expect(live.requests.some((request) => request.body.Action?.startsWith('Create'))).toBe(false);
  });
  it('preserves forbidden reads and ambiguous creates without retrying or adopting by token', async () => {
    const denied = await fixture();
    const staged = (denied.adapter as any).serviceVolumes?.staged;
    expect(staged).toBeDefined();
    denied.deny();
    expect(await staged.observeComponent(target, 'filesystem', {})).toMatchObject({ state: 'unknown' });
    expect(await staged.applyComponent(target, 'filesystem', {})).toMatchObject({ success: false, mutationAttempted: false });
    const lost = await fixture();
    lost.lose();
    const driver = (lost.adapter as any).serviceVolumes.staged;
    const receipt = await driver.applyComponent(target, 'filesystem', {});
    expect(receipt).toMatchObject({ success: false, mutationAttempted: true });
    expect(receipt.externalId).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('private-secret');
    expect(await driver.applyComponent(target, 'filesystem', {})).toMatchObject({ success: false, mutationAttempted: false });
  });
  it('keeps the exact EFS mount and runtime role while removing an env var through direct reconciliation', async () => {
    const { adapter, requests } = await fixture(true);
    vi.spyOn(adapter as any, 'assertProjectResources').mockResolvedValue({ accountId: account, region, vpcId: 'vpc-12345678', subnetIds: ['subnet-11111111', 'subnet-22222222'], workloadSecurityGroupId: 'sg-12345678' });
    const receipt = await adapter.deleteEnvVars({ id: 'local-env', platformBindings: { projectId: cluster, environmentId: cluster, services: { web: { serviceId: service } } } } as any, { name: 'web' } as any, ['EXISTING']);
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ success: true });
    expect(requests.filter((request) => request.body.family === 'existing')).toHaveLength(1);
  });
  it('does not implicitly retry ambiguous non-idempotent task-definition registration during direct env reconciliation', async () => {
    const { adapter, requests } = await fixture(true, false, true);
    vi.spyOn(adapter as any, 'assertProjectResources').mockResolvedValue({ accountId: account, region, vpcId: 'vpc-12345678', subnetIds: ['subnet-11111111', 'subnet-22222222'], workloadSecurityGroupId: 'sg-12345678' });
    const receipt = await adapter.deleteEnvVars({ id: 'local-env', platformBindings: { projectId: cluster, environmentId: cluster, services: { web: { serviceId: service } } } } as any, { name: 'web' } as any, ['EXISTING']);
    expect(receipt).toMatchObject({ success: false });
    expect(requests.filter((request) => request.body.family === 'existing')).toHaveLength(1);
    expect(requests.some((request) => request.body.serviceArn && request.body.taskDefinitionArn)).toBe(false);
  });
  it.each([{ advanceRuntime: false, withoutRole: false, registrationFailure: false }, { advanceRuntime: true, withoutRole: false, registrationFailure: false }, { advanceRuntime: false, withoutRole: true, registrationFailure: false }, { advanceRuntime: false, withoutRole: false, registrationFailure: true }])('converges individual EFS resources and guards runtime drift $advanceRuntime / new role $withoutRole / registration failure $registrationFailure', async ({ advanceRuntime, withoutRole, registrationFailure }) => {
    const live = await fixture(false, withoutRole, registrationFailure);
    const volumes = live.adapter.serviceVolumes;
    let environment: Environment = { id: 'local-env', projectId: 'local-project', name: 'staging', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: cluster, environmentId: cluster, services: { web: { serviceId: service } }, awsNetwork: { accountId: account, region, vpcId: 'vpc-12345678', subnetIds: ['subnet-11111111', 'subnet-22222222'], workloadSecurityGroupId: 'sg-12345678' } } };
    const spec = environmentSpecSchema.parse({ hosting: { provider: 'ecs' }, services: { web: { volume: { mountPath: '/data' } } } });
    const plan = async () => planServiceVolumes({ environment, environmentSpec: spec, observed: { serviceVolumes: await observeServiceVolumes({ environment, environmentSpec: spec, volumes }) } as ObservedState }).actions;
    const save = (serviceVolumes: any) => { environment = { ...environment, platformBindings: { ...environment.platformBindings, serviceVolumes } }; };
    const created: string[] = [];
    for (let step = 0; step < 15; step++) {
      const actions = await plan();
      expect(actions.length).toBeGreaterThan(0);
      const action = actions.find((entry) => entry.type !== 'noop');
      if (!action) break;
      expect(action.metadata?.blockedReason, JSON.stringify(action)).toBeUndefined();
      if (advanceRuntime && action.metadata?.component === 'attachment') live.advanceRuntime();
      const receipt = await applyServiceVolumeAction({ environment, environmentSpec: spec, action, volumes, confirmedActionIds: new Set([action.id]), save });
      if (registrationFailure && action.metadata?.component === 'task-definition') {
        expect(receipt).toMatchObject({ success: false });
        expect(live.requests.filter((request) => request.body.family)).toHaveLength(1);
        expect(live.requests.some((request) => request.body.serviceArn && request.body.taskDefinitionArn)).toBe(false);
        return;
      }
      if (advanceRuntime && action.metadata?.component === 'attachment') {
        expect(receipt).toMatchObject({ success: false });
        expect(live.requests.some((request) => request.body.serviceArn && request.body.taskDefinitionArn)).toBe(false);
        return;
      }
      expect(receipt, JSON.stringify({ action, receipt })).toMatchObject({ success: true });
      created.push(action.metadata?.component as string);
    }
    expect(created).toHaveLength(withoutRole ? 10 : 9);
    expect(created.at(-1)).toBe('attachment');
    expect((await plan()).every((entry) => entry.type === 'noop')).toBe(true);
    expect(parseServiceVolumeBindings(environment)?.web?.state).toBe('staged');
    expect(JSON.stringify(environment.platformBindings)).not.toContain('private-');
  });
});
