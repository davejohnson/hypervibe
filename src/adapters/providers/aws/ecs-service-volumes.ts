import { EFSClient, CreateAccessPointCommand, CreateFileSystemCommand, CreateMountTargetCommand, DescribeAccessPointsCommand, DescribeFileSystemsCommand, DescribeFileSystemPolicyCommand, DescribeMountTargetsCommand, DescribeMountTargetSecurityGroupsCommand, PutFileSystemPolicyCommand } from '@aws-sdk/client-efs';
import { EC2Client, AuthorizeSecurityGroupIngressCommand, CreateSecurityGroupCommand, DescribeSecurityGroupsCommand, DescribeSecurityGroupRulesCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import { ECSClient, DescribeExpressGatewayServiceCommand, DescribeTaskDefinitionCommand, ListTaskDefinitionsCommand, RegisterTaskDefinitionCommand, UpdateExpressGatewayServiceCommand, type ECSExpressGatewayService, type TaskDefinition } from '@aws-sdk/client-ecs';
import { IAMClient, CreateRoleCommand, GetRoleCommand } from '@aws-sdk/client-iam';
import type { IServiceVolumes, ServiceVolumeComponent, ServiceVolumeComponentBinding, ServiceVolumeMutationReceipt, ServiceVolumeObservation, ServiceVolumeTarget } from '../../../domain/ports/service-volume.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { resourceName, resourceScopeSuffix } from '../../../domain/services/resource-names.js';
import { parseAwsWorkloadNetworkBinding, parseEcsClusterArn } from './aws-workload-network.js';
import { ecsTaskDefinitionInput } from './ecs-volume-runtime.js';
import { ecsTaskDefinitionWriter } from './ecs-task-definition-writer.js';

type Clients = { efs: EFSClient; ec2: EC2Client; ecs: ECSClient; iam: IAMClient };
type Bindings = Record<string, ServiceVolumeComponentBinding>;
type Subnet = { subnetId: string; availabilityZoneId: string };
const VOLUME = 'hypervibe-data';
const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
const canonical = (value: unknown): string => JSON.stringify(value, function (_key, item) {
  return item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item;
});

export class EcsServiceVolumes implements IServiceVolumes {
  constructor(private readonly connection: () => { clients: Clients; region: string }, private readonly accountId: () => Promise<string>) {}

  readonly staged: NonNullable<IServiceVolumes['staged']> = {
    resolveTarget: async ({ environment, serviceName, mountPath }) => {
      if (!environment) return undefined;
      const hosting = parseHostingBindings(environment);
      const network = parseAwsWorkloadNetworkBinding(environment);
      const serviceId = hosting.services?.[serviceName]?.serviceId;
      if (!hosting.projectId || !serviceId || !network) return undefined;
      const service = await this.express(serviceId, hosting.projectId);
      const configuration = this.config(service);
      const task = await this.task(configuration.taskDefinitionArn!);
      const output = await this.connection().clients.ec2.send(new DescribeSubnetsCommand({ SubnetIds: network.subnetIds }));
      if (!Array.isArray(output.Subnets) || output.Subnets.length !== network.subnetIds.length) throw new Error('Incomplete ECS network inventory.');
      const subnets = output.Subnets.map((subnet) => {
        if (!subnet.SubnetId || !subnet.AvailabilityZoneId || subnet.VpcId !== network.vpcId || subnet.OwnerId !== network.accountId) throw new Error('ECS subnet scope differs from its binding.');
        return { subnetId: subnet.SubnetId, availabilityZoneId: subnet.AvailabilityZoneId };
      }).sort((a, b) => a.subnetId.localeCompare(b.subnetId));
      const previous = (environment.platformBindings.serviceVolumes as any)?.[serviceName]?.target?.instanceScope;
      const generatedRole = `arn:aws:iam::${network.accountId}:role/${this.roleName(serviceId)}`;
      const taskRoleArn = previous?.taskRoleArn ?? task.taskRoleArn ?? generatedRole;
      const taskRoleOwned = previous?.taskRoleOwned ?? (task.taskRoleArn ? 'false' : 'true');
      const target: ServiceVolumeTarget = { projectId: hosting.projectId, environmentId: hosting.environmentId ?? hosting.projectId, serviceId, mountPath,
        instanceScope: { accountId: network.accountId, region: network.region, vpcId: network.vpcId, workloadSecurityGroupId: network.workloadSecurityGroupId, subnets: JSON.stringify(subnets), taskRoleArn, taskRoleOwned } };
      await this.scope(target);
      return target;
    },
    components: (target) => this.components(target),
    observeComponent: (target, key, bindings) => this.observeComponent(target, key, bindings),
    applyComponent: (target, key, bindings) => this.applyComponent(target, key, bindings),
  };

  async observe(): Promise<ServiceVolumeObservation> { return { state: 'unknown', reason: 'EFS requires component-scoped observation.' }; }
  async create(): Promise<ServiceVolumeMutationReceipt> { return { success: false, mutationAttempted: false, error: 'EFS requires separately reviewed filesystem, network, policy and attachment actions.' }; }

  private names(target: ServiceVolumeTarget) {
    const scope = [target.projectId, target.serviceId];
    return { token: `hv-efs-${resourceScopeSuffix(scope)}`, securityGroup: resourceName('files', { scope, maxLength: 255 }), family: resourceName('files', { scope, maxLength: 255 }), ownership: resourceScopeSuffix(scope) };
  }
  private roleName(serviceId: string) { return resourceName('files', { scope: [serviceId], maxLength: 64 }); }
  private coordinates(target: ServiceVolumeTarget) {
    const cluster = parseEcsClusterArn(target.projectId);
    const scope = target.instanceScope;
    if (!scope || scope.accountId !== cluster.accountId || scope.region !== cluster.region || target.environmentId !== target.projectId
      || !target.serviceId.startsWith(target.projectId.replace(':cluster/', ':service/') + '/')
      || !/^vpc-[0-9a-f]+$/.test(scope.vpcId ?? '') || !/^sg-[0-9a-f]+$/.test(scope.workloadSecurityGroupId ?? '')
      || !new RegExp(`^arn:aws:iam::${cluster.accountId}:role/[A-Za-z0-9_+=,.@/-]+$`).test(scope.taskRoleArn ?? '')
      || !['true', 'false'].includes(scope.taskRoleOwned ?? '')
      || !target.mountPath.startsWith('/') || target.mountPath === '/' || /[\s\\]/.test(target.mountPath)
      || target.mountPath.split('/').some((segment) => segment === '..' || segment === '.')) throw new Error('Invalid retained EFS scope.');
    if (scope.taskRoleOwned === 'true' && scope.taskRoleArn !== `arn:aws:iam::${cluster.accountId}:role/${this.roleName(target.serviceId)}`) throw new Error('EFS runtime role differs from its owned identity.');
    const subnets: Subnet[] = JSON.parse(scope.subnets!);
    if (!Array.isArray(subnets) || subnets.length < 2 || subnets.length > 32 || subnets.some((s) => !/^subnet-[0-9a-f]+$/.test(s.subnetId) || !/^[a-z0-9-]+$/.test(s.availabilityZoneId))
      || new Set(subnets.map((s) => s.subnetId)).size !== subnets.length) throw new Error('Invalid EFS subnet scope.');
    return { accountId: scope.accountId!, region: scope.region!, vpcId: scope.vpcId!, workloadSecurityGroupId: scope.workloadSecurityGroupId!, taskRoleArn: scope.taskRoleArn!, taskRoleOwned: scope.taskRoleOwned!, subnets, zones: [...new Map([...subnets].sort((a, b) => a.subnetId.localeCompare(b.subnetId)).map((s) => [s.availabilityZoneId, s])).values()].sort((a, b) => a.availabilityZoneId.localeCompare(b.availabilityZoneId)) };
  }
  private components(target: ServiceVolumeTarget): ServiceVolumeComponent[] {
    const scope = this.coordinates(target);
    const component = (key: string, dependsOn: string[], description: string, operation: 'create' | 'update' = 'create', billable = false): ServiceVolumeComponent => ({ key, dependsOn, description, operation, billable });
    const mounts = scope.zones.map((zone) => `mount-target-${zone.availabilityZoneId}`);
    return [
      component('filesystem', [], 'Create a retained encrypted regional EFS filesystem; used storage, elastic throughput and transfers are billed.', 'create', true),
      component('security-group', [], 'Create a dedicated EFS security group in the bound workload VPC.'),
      component('nfs-ingress', ['security-group'], 'Allow NFS only from the bound workload security group.', 'update'),
      component('access-point', ['filesystem'], 'Create an isolated EFS access point with an unprivileged POSIX identity.'),
      ...(scope.taskRoleOwned === 'true' ? [component('runtime-role', [], 'Create a workload-only ECS task role; never reuse deploy credentials.')] : []),
      component('filesystem-policy', ['filesystem', 'access-point', ...(scope.taskRoleOwned === 'true' ? ['runtime-role'] : [])], 'Grant the workload role access and deny mounts without TLS or the exact access point.', 'update'),
      ...scope.zones.map((zone) => component(`mount-target-${zone.availabilityZoneId}`, ['filesystem', 'security-group', 'nfs-ingress'], `Create the EFS mount target in exact subnet ${zone.subnetId}.`)),
      component('task-definition', ['access-point', 'filesystem-policy', ...mounts], 'Register one task-definition revision mounting the exact existing EFS access point.'),
      component('attachment', ['task-definition'], 'Attach the reviewed task definition to the existing ECS Express service.', 'update'),
    ];
  }
  private config(service: ECSExpressGatewayService) {
    const matches = service.activeConfigurations?.filter((configuration) => configuration.serviceRevisionArn === service.currentDeployment);
    if (matches?.length !== 1 || !matches[0]?.taskDefinitionArn) throw new Error('ECS active task definition is not exact.');
    return matches[0];
  }
  private async express(serviceId: string, cluster: string) {
    const service = (await this.connection().clients.ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn: serviceId }))).service;
    if (!service || service.serviceArn !== serviceId || service.cluster !== cluster) throw new Error('ECS service scope is not observable.');
    return service;
  }
  private async task(arn: string): Promise<TaskDefinition> {
    const task = (await this.connection().clients.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }))).taskDefinition;
    if (!task || task.taskDefinitionArn !== arn || task.status !== 'ACTIVE') throw new Error('ECS task definition identity is not active.');
    ecsTaskDefinitionInput(task, {});
    return task;
  }
  private async scope(target: ServiceVolumeTarget) {
    const scope = this.coordinates(target);
    if (this.connection().region !== scope.region || await this.accountId() !== scope.accountId) throw new Error('AWS connection scope differs from retained volume.');
    const service = await this.express(target.serviceId, target.projectId);
    const configuration = this.config(service);
    if (canonical([...(configuration.networkConfiguration?.subnets ?? [])].sort()) !== canonical(scope.subnets.map((subnet) => subnet.subnetId).sort())
      || canonical(configuration.networkConfiguration?.securityGroups) !== canonical([scope.workloadSecurityGroupId])) throw new Error('EFS workload network changed.');
    const observedSubnets = (await this.connection().clients.ec2.send(new DescribeSubnetsCommand({ SubnetIds: scope.subnets.map((subnet) => subnet.subnetId) }))).Subnets;
    if (!Array.isArray(observedSubnets) || observedSubnets.length !== scope.subnets.length || observedSubnets.some((subnet) => subnet.OwnerId !== scope.accountId || subnet.VpcId !== scope.vpcId
      || !scope.subnets.some((expected) => expected.subnetId === subnet.SubnetId && expected.availabilityZoneId === subnet.AvailabilityZoneId))) throw new Error('EFS subnet scope is unknown or changed.');
    const task = await this.task(configuration.taskDefinitionArn!);
    if (task.taskRoleArn && task.taskRoleArn !== scope.taskRoleArn) throw new Error('EFS would replace the current workload principal.');
    if (!task.taskRoleArn && scope.taskRoleOwned !== 'true') throw new Error('Existing EFS workload principal disappeared.');
    return { scope, service, configuration, task };
  }
  private bound(bindings: Bindings, key: string) {
    const value = bindings[key];
    if (!value?.externalId || value.state !== 'bound') throw new Error(`EFS ${key} prerequisite is not bound.`);
    return value.externalId;
  }
  private policy(target: ServiceVolumeTarget, bindings: Bindings) {
    const scope = this.coordinates(target);
    const filesystem = `arn:aws:elasticfilesystem:${scope.region}:${scope.accountId}:file-system/${this.bound(bindings, 'filesystem')}`;
    const accessPoint = `arn:aws:elasticfilesystem:${scope.region}:${scope.accountId}:access-point/${this.bound(bindings, 'access-point')}`;
    // EFS documents these NFS condition keys. Allow alone cannot override a
    // same-account identity allow, so require TLS/access-point using explicit denies.
    // Do not claim exclusive-principal isolation: other account IAM grants are
    // administered by the account owner, and EFS does not document PrincipalArn here.
    return { Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Principal: { AWS: scope.taskRoleArn }, Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'], Resource: filesystem,
        Condition: { StringEquals: { 'elasticfilesystem:AccessPointArn': accessPoint }, Bool: { 'aws:SecureTransport': 'true', 'elasticfilesystem:AccessedViaMountTarget': 'true' } } },
      { Effect: 'Deny', Principal: '*', Action: 'elasticfilesystem:Client*', Resource: filesystem, Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
      { Effect: 'Deny', Principal: '*', Action: 'elasticfilesystem:Client*', Resource: filesystem, Condition: { StringNotEquals: { 'elasticfilesystem:AccessPointArn': accessPoint } } },
      { Effect: 'Deny', Principal: '*', Action: 'elasticfilesystem:Client*', Resource: filesystem, Condition: { BoolIfExists: { 'elasticfilesystem:AccessedViaMountTarget': 'false' } } },
      { Effect: 'Deny', Principal: '*', Action: 'elasticfilesystem:ClientRootAccess', Resource: filesystem },
    ] };
  }
  private async pages(fetchPage: (token?: string) => Promise<any>, field: string, tokenKey = 'NextMarker') {
    const result: any[] = []; const seen = new Set<string>(); let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const value = await fetchPage(token);
      if (!Array.isArray(value[field])) throw new Error('Incomplete EFS inventory.');
      result.push(...value[field]);
      const next = value[tokenKey];
      if (next === undefined || next === null || next === '') return result;
      if (typeof next !== 'string' || seen.has(next)) throw new Error('Repeated EFS inventory cursor.');
      seen.add(next); token = next;
    }
    throw new Error('EFS inventory pagination exceeded its safety bound.');
  }
  private one(values: any[]) { if (values.length > 1) throw new Error('Ambiguous EFS resource identity.'); return values[0]; }
  private async observeComponent(target: ServiceVolumeTarget, key: string, bindings: Bindings): Promise<ServiceVolumeObservation> {
    try {
      const { scope, service, task } = await this.scope(target);
      const { clients } = this.connection(); const names = this.names(target);
      const expected = bindings[key]?.externalId;
      const present = (externalId: string | undefined, ready = true, pendingDeletion = false): ServiceVolumeObservation => {
        if (!externalId || (expected && externalId !== expected)) throw new Error('EFS returned a different resource identity.');
        return { state: 'present', externalId, ready, pendingDeletion };
      };
      if (key === 'filesystem') {
        const filesystem = this.one(await this.pages((Marker) => clients.efs.send(new DescribeFileSystemsCommand({ ...(expected ? { FileSystemId: expected } : { CreationToken: names.token }), Marker })), 'FileSystems'));
        if (!filesystem) return { state: 'absent' };
        if (filesystem.OwnerId !== scope.accountId || filesystem.CreationToken !== names.token || !filesystem.Encrypted || filesystem.PerformanceMode !== 'generalPurpose' || filesystem.ThroughputMode !== 'elastic') throw new Error('EFS filesystem scope/configuration drift.');
        return present(filesystem.FileSystemId, filesystem.LifeCycleState === 'available', ['deleting', 'deleted'].includes(filesystem.LifeCycleState));
      }
      if (key === 'security-group') {
        const group = this.one(await this.pages((NextToken) => clients.ec2.send(new DescribeSecurityGroupsCommand({ ...(expected ? { GroupIds: [expected] } : { Filters: [{ Name: 'group-name', Values: [names.securityGroup] }, { Name: 'vpc-id', Values: [scope.vpcId] }] }), NextToken })), 'SecurityGroups', 'NextToken'));
        if (!group) return { state: 'absent' };
        if (group.OwnerId !== scope.accountId || group.VpcId !== scope.vpcId || group.GroupName !== names.securityGroup || !group.Tags?.some((tag: any) => tag.Key === 'hypervibe-volume-service' && tag.Value === names.ownership)) throw new Error('EFS security group scope mismatch.');
        return present(group.GroupId);
      }
      if (key === 'nfs-ingress') {
        const rules = await this.pages((NextToken) => clients.ec2.send(new DescribeSecurityGroupRulesCommand({ Filters: [{ Name: 'group-id', Values: [this.bound(bindings, 'security-group')] }], NextToken })), 'SecurityGroupRules', 'NextToken');
        const ingress = rules.filter((rule) => !rule.IsEgress);
        const rule = this.one(ingress);
        if (!rule) return { state: 'absent' };
        if (rule.GroupId !== this.bound(bindings, 'security-group') || rule.IpProtocol !== 'tcp' || rule.FromPort !== 2049 || rule.ToPort !== 2049 || rule.ReferencedGroupInfo?.GroupId !== scope.workloadSecurityGroupId || rule.CidrIpv4 || rule.CidrIpv6 || rule.PrefixListId) throw new Error('EFS ingress is broader than the reviewed workload.');
        return present(rule.SecurityGroupRuleId);
      }
      if (key === 'access-point') {
        const access = this.one((await this.pages((NextToken) => clients.efs.send(new DescribeAccessPointsCommand({ ...(expected ? { AccessPointId: expected } : { FileSystemId: this.bound(bindings, 'filesystem') }), NextToken })), 'AccessPoints', 'NextToken')).filter((value) => expected || value.ClientToken === names.token));
        if (!access) return { state: 'absent' };
        if (access.OwnerId !== scope.accountId || access.FileSystemId !== this.bound(bindings, 'filesystem') || access.PosixUser?.Uid !== 1000 || access.PosixUser?.Gid !== 1000 || access.RootDirectory?.Path !== '/data') throw new Error('EFS access point scope/configuration differs.');
        return present(access.AccessPointId, access.LifeCycleState === 'available', access.LifeCycleState === 'deleting');
      }
      if (key === 'runtime-role') {
        const role = (await clients.iam.send(new GetRoleCommand({ RoleName: this.roleName(target.serviceId) }))).Role;
        if (!role || role.Arn !== scope.taskRoleArn || !role.Tags?.some((tag) => tag.Key === 'hypervibe-volume-service' && tag.Value === names.ownership)
          || canonical(JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument ?? ''))) !== canonical(trust)) throw new Error('EFS task role identity or trust differs.');
        return present(role.Arn);
      }
      if (key === 'filesystem-policy') {
        const policy = await clients.efs.send(new DescribeFileSystemPolicyCommand({ FileSystemId: this.bound(bindings, 'filesystem') }));
        if (policy.FileSystemId !== this.bound(bindings, 'filesystem') || canonical(JSON.parse(policy.Policy ?? '')) !== canonical(this.policy(target, bindings))) throw new Error('EFS access policy differs from the reviewed workload scope.');
        return present(policy.FileSystemId);
      }
      if (key.startsWith('mount-target-')) {
        const zone = scope.zones.find((value) => key === `mount-target-${value.availabilityZoneId}`);
        if (!zone) throw new Error('Unknown EFS mount-target zone.');
        const mount = this.one((await this.pages((Marker) => clients.efs.send(new DescribeMountTargetsCommand({ FileSystemId: this.bound(bindings, 'filesystem'), Marker })), 'MountTargets')).filter((value) => expected ? value.MountTargetId === expected : value.AvailabilityZoneId === zone.availabilityZoneId));
        if (!mount) return { state: 'absent' };
        if (mount.FileSystemId !== this.bound(bindings, 'filesystem') || mount.OwnerId !== scope.accountId || mount.VpcId !== scope.vpcId || mount.SubnetId !== zone.subnetId || mount.AvailabilityZoneId !== zone.availabilityZoneId) throw new Error('EFS mount target belongs to another network.');
        const groups = await clients.efs.send(new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: mount.MountTargetId }));
        if (canonical(groups.SecurityGroups) !== canonical([this.bound(bindings, 'security-group')])) throw new Error('EFS mount-target security scope differs.');
        return present(mount.MountTargetId, mount.LifeCycleState === 'available', mount.LifeCycleState === 'deleting');
      }
      if (key === 'task-definition') {
        let arn = expected;
        if (!arn) arn = this.one((await this.pages((nextToken) => clients.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: names.family, status: 'ACTIVE', nextToken })), 'taskDefinitionArns', 'nextToken')).filter((value) => value.includes(`:task-definition/${names.family}:`)));
        if (!arn) return { state: 'absent' };
        this.assertMountedTask(await this.task(arn), target, bindings);
        return present(arn);
      }
      if (key === 'attachment') {
        if (task.family !== names.family) {
          if (task.volumes?.some((volume) => volume.name === VOLUME) || task.containerDefinitions?.some((container) => container.mountPoints?.some((mount) => mount.containerPath === target.mountPath || mount.sourceVolume === VOLUME))) throw new Error('ECS already has a conflicting mount.');
          return { state: 'absent' };
        }
        this.assertMountedTask(task, target, bindings);
        return present(target.serviceId, service.status?.statusCode === 'ACTIVE');
      }
      throw new Error('Unknown EFS lifecycle component.');
    } catch (error) {
      const name = (error as { name?: string }).name;
      if ((key === 'filesystem' && name === 'FileSystemNotFound') || (key === 'filesystem-policy' && name === 'PolicyNotFound')
        || (key === 'runtime-role' && name === 'NoSuchEntityException') || (key === 'access-point' && name === 'AccessPointNotFound')) return { state: 'absent' };
      return { state: 'unknown', reason: `EFS ${key} scope, identity or configuration could not be verified.` };
    }
  }
  private assertMountedTask(task: TaskDefinition, target: ServiceVolumeTarget, bindings: Bindings) {
    const scope = this.coordinates(target);
    if (task.family !== this.names(target).family || task.taskRoleArn !== scope.taskRoleArn) throw new Error('EFS workload role/family changed.');
    const volumes = task.volumes?.filter((volume) => volume.name === VOLUME);
    const mounts = task.containerDefinitions?.find((container) => container.name === 'Main')?.mountPoints?.filter((mount) => mount.sourceVolume === VOLUME || mount.containerPath === target.mountPath);
    const efs = volumes?.[0]?.efsVolumeConfiguration;
    if (volumes?.length !== 1 || mounts?.length !== 1 || mounts[0]?.containerPath !== target.mountPath || mounts[0]?.readOnly === true
      || efs?.fileSystemId !== this.bound(bindings, 'filesystem') || efs.transitEncryption !== 'ENABLED' || efs.authorizationConfig?.iam !== 'ENABLED'
      || efs.authorizationConfig.accessPointId !== this.bound(bindings, 'access-point') || (efs.rootDirectory && efs.rootDirectory !== '/')) throw new Error('EFS task mount differs from its bound filesystem/access point.');
  }
  private mountedDefinition(task: TaskDefinition, target: ServiceVolumeTarget, bindings: Bindings) {
    const main = task.containerDefinitions!.find((container) => container.name === 'Main')!;
    if (task.volumes?.some((volume) => volume.name === VOLUME) || main.mountPoints?.some((mount) => mount.sourceVolume === VOLUME || mount.containerPath === target.mountPath)) throw new Error('ECS task already contains conflicting mounts.');
    const input = ecsTaskDefinitionInput(task, { mountPoints: [...(main.mountPoints ?? []), { sourceVolume: VOLUME, containerPath: target.mountPath, readOnly: false }] }, this.names(target).family);
    input.taskRoleArn = this.coordinates(target).taskRoleArn;
    input.volumes = [...(task.volumes ?? []), { name: VOLUME, efsVolumeConfiguration: { fileSystemId: this.bound(bindings, 'filesystem'), rootDirectory: '/', transitEncryption: 'ENABLED', authorizationConfig: { accessPointId: this.bound(bindings, 'access-point'), iam: 'ENABLED' } } }];
    return input;
  }
  private async applyComponent(target: ServiceVolumeTarget, key: string, bindings: Bindings): Promise<ServiceVolumeMutationReceipt> {
    let mutationAttempted = false; let externalId: string | undefined;
    try {
      const { scope } = await this.scope(target);
      const component = this.components(target).find((value) => value.key === key);
      if (!component) throw new Error('Unknown EFS component.');
      for (const dependency of component.dependsOn) {
        this.bound(bindings, dependency);
        const observed = await this.observeComponent(target, dependency, bindings);
        if (observed.state !== 'present' || observed.ready === false || observed.pendingDeletion) throw new Error('EFS prerequisite is not ready.');
      }
      if (bindings[key]?.externalId || (await this.observeComponent(target, key, bindings)).state !== 'absent') throw new Error('EFS mutation requires verified absence with no retained identity.');
      const { clients } = this.connection(); const names = this.names(target);
      const Tags = [{ Key: 'managed-by', Value: 'hypervibe' }, { Key: 'hypervibe-volume-service', Value: names.ownership }];
      // Inputs are completely prepared before this single-resource mutation boundary.
      let mutate: () => Promise<string | undefined>;
      if (key === 'filesystem') mutate = async () => (await clients.efs.send(new CreateFileSystemCommand({ CreationToken: names.token, Encrypted: true, PerformanceMode: 'generalPurpose', ThroughputMode: 'elastic', Tags }))).FileSystemId;
      else if (key === 'security-group') mutate = async () => (await clients.ec2.send(new CreateSecurityGroupCommand({ GroupName: names.securityGroup, Description: 'Hypervibe retained EFS mount targets', VpcId: scope.vpcId, TagSpecifications: [{ ResourceType: 'security-group', Tags }] }))).GroupId;
      else if (key === 'nfs-ingress') {
        const GroupId = this.bound(bindings, 'security-group');
        mutate = async () => this.one((await clients.ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 2049, ToPort: 2049, UserIdGroupPairs: [{ GroupId: scope.workloadSecurityGroupId, UserId: scope.accountId }] }] }))).SecurityGroupRules ?? [])?.SecurityGroupRuleId;
      } else if (key === 'access-point') {
        const FileSystemId = this.bound(bindings, 'filesystem');
        mutate = async () => (await clients.efs.send(new CreateAccessPointCommand({ FileSystemId, ClientToken: names.token, Tags, PosixUser: { Uid: 1000, Gid: 1000 }, RootDirectory: { Path: '/data', CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '0700' } } }))).AccessPointId;
      } else if (key === 'runtime-role') mutate = async () => (await clients.iam.send(new CreateRoleCommand({ RoleName: this.roleName(target.serviceId), AssumeRolePolicyDocument: JSON.stringify(trust), Tags }))).Role?.Arn;
      else if (key === 'filesystem-policy') {
        const FileSystemId = this.bound(bindings, 'filesystem'); const Policy = JSON.stringify(this.policy(target, bindings));
        mutate = async () => (await clients.efs.send(new PutFileSystemPolicyCommand({ FileSystemId, Policy, BypassPolicyLockoutSafetyCheck: false }))).FileSystemId;
      } else if (key.startsWith('mount-target-')) {
        const zone = scope.zones.find((value) => key === `mount-target-${value.availabilityZoneId}`)!;
        const FileSystemId = this.bound(bindings, 'filesystem'); const SecurityGroups = [this.bound(bindings, 'security-group')];
        mutate = async () => (await clients.efs.send(new CreateMountTargetCommand({ FileSystemId, SubnetId: zone.subnetId, SecurityGroups }))).MountTargetId;
      } else if (key === 'task-definition') {
        const input = this.mountedDefinition((await this.scope(target)).task, target, bindings);
        input.tags = Tags.map(({ Key, Value }) => ({ key: Key, value: Value }));
        mutate = async () => (await ecsTaskDefinitionWriter(clients.ecs).send(new RegisterTaskDefinitionCommand(input))).taskDefinition?.taskDefinitionArn;
      } else {
        const taskDefinitionArn = this.bound(bindings, 'task-definition');
        const prepared = await this.task(taskDefinitionArn);
        const { task, configuration } = await this.scope(target);
        if (canonical(ecsTaskDefinitionInput(prepared, {})) !== canonical(this.mountedDefinition(task, target, bindings))) throw new Error('ECS runtime changed after the mounted task definition was prepared; attachment would roll it back.');
        mutate = async () => (await clients.ecs.send(new UpdateExpressGatewayServiceCommand({ serviceArn: target.serviceId, taskDefinitionArn, healthCheckPath: configuration.healthCheckPath, networkConfiguration: configuration.networkConfiguration, scalingTarget: configuration.scalingTarget }))).service?.serviceArn;
      }
      mutationAttempted = true;
      externalId = await mutate();
      if (!externalId) throw new Error('EFS write did not acknowledge its resource identity.');
      const observed = await this.observeComponent(target, key, { ...bindings, [key]: { state: 'identified', externalId } });
      return { success: observed.state === 'present' && observed.ready !== false && !observed.pendingDeletion, externalId, mutationAttempted: true };
    } catch {
      return { success: false, mutationAttempted, ...(externalId ? { externalId } : {}), error: `EFS ${key} is not verified; retain its intent and re-plan without automatic recreation.` };
    }
  }
}
