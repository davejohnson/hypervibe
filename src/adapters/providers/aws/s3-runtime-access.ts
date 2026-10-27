import { createHash } from 'node:crypto';
import { DeleteRolePolicyCommand, GetRoleCommand, GetRolePolicyCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { GetBucketTaggingCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type { IStorageRuntimeAccess, StorageRuntimeAccessBinding, StorageRuntimeAccessObservation, StorageRuntimeAccessTarget } from '../../../domain/ports/storage-runtime-access.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';

type Client = { send(command: any): Promise<any> };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const missing = (error: unknown): boolean => ['NoSuchEntity', 'NoSuchEntityException'].includes((error as { name?: string })?.name ?? '');

/** An exact-role inline policy slot is an explicit lifecycle resource. */
export class S3RuntimeAccess implements IStorageRuntimeAccess {
  readonly hostingProviders = ['ecs'];
  constructor(private readonly connected: (target: StorageRuntimeAccessTarget) => { iam: Client; s3: Client; sts: Client }) {}

  private coordinates(target: StorageRuntimeAccessTarget) {
    const { identity, context, environment } = target;
    const hosting = parseHostingBindings(environment);
    const role = identity.principal.match(/^arn:(aws(?:-[a-z]+)?):iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]{1,64})$/);
    const serviceArn = hosting.services?.[target.serviceName]?.serviceId;
    if (identity.provider !== 'aws' || identity.source !== 'observed' || !role || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(target.externalId)
      || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(context.region ?? '') || !context.projectName
      || identity.scope.accountId !== role[2] || context.accountId !== role[2] || context.environmentId !== environment.id
      || identity.scope.environmentId !== environment.id || identity.scope.clusterArn !== hosting.projectId
      || !serviceArn || identity.scope.serviceArn !== serviceArn || hosting.environmentId !== hosting.projectId
      || !/^AROA[A-Z0-9]{12,124}$/.test(identity.scope.roleId ?? '')
      || !serviceArn.startsWith(`arn:${role[1]}:ecs:${identity.scope.region}:${role[2]}:service/`)
      || !serviceArn.startsWith(hosting.projectId!.replace(':cluster/', ':service/') + '/')) throw new Error('Workload bucket scope is unavailable.');
    return { accountId: role[2]!, roleName: role[3]!, roleArn: identity.principal, roleId: identity.scope.roleId!, bucket: target.externalId,
      region: context.region!, environmentId: environment.id, clusterArn: hosting.projectId!, serviceArn, storageName: target.storageName,
      bucketArn: `arn:${role[1]}:s3:::${target.externalId}` };
  }

  private policy(target: StorageRuntimeAccessTarget, attemptId: string) {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(attemptId)) throw new Error('Storage access attempt identity is invalid.');
    const scope = this.coordinates(target);
    const Condition = { StringEquals: { 's3:ResourceAccount': scope.accountId } };
    const sid = 'Hypervibe' + hash({ scope, attemptId });
    return { Version: '2012-10-17', Statement: [
      { Sid: sid + 'Bucket', Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:ListBucket', 's3:ListBucketMultipartUploads'], Resource: scope.bucketArn, Condition },
      { Sid: sid + 'Objects', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'], Resource: `${scope.bucketArn}/*`, Condition },
    ] };
  }

  private binding(target: StorageRuntimeAccessTarget, attemptId: string): StorageRuntimeAccessBinding {
    const scope = this.coordinates(target);
    return { id: resourceName('storage', { scope: [scope.environmentId, scope.serviceArn, scope.bucket], maxLength: 128 }), attemptId,
      evidence: { ...scope, policyHash: hash(this.policy(target, attemptId)) } };
  }

  private validateBinding(target: StorageRuntimeAccessTarget, binding: StorageRuntimeAccessBinding): void {
    if (canonical(binding) !== canonical(this.binding(target, binding.attemptId))) throw new Error('The storage access binding does not match the exact selected scope.');
  }

  private async verify(target: StorageRuntimeAccessTarget) {
    const scope = this.coordinates(target);
    const clients = this.connected(target);
    const caller = await clients.sts.send(new GetCallerIdentityCommand({}));
    if (caller.Account !== scope.accountId || !caller.UserId || caller.UserId.split(':')[0] === scope.roleId || caller.Arn === scope.roleArn) throw new Error('Storage access cannot use the deployment principal.');
    const role = (await clients.iam.send(new GetRoleCommand({ RoleName: scope.roleName }))).Role;
    if (role?.Arn !== scope.roleArn || role.RoleId !== scope.roleId || role.RoleName !== scope.roleName) throw new Error('The selected runtime role has changed.');
    const bucket = await clients.s3.send(new HeadBucketCommand({ Bucket: scope.bucket, ExpectedBucketOwner: scope.accountId }));
    if (bucket.BucketRegion !== scope.region) throw new Error('The selected bucket region is unknown.');
    const tags = (await clients.s3.send(new GetBucketTaggingCommand({ Bucket: scope.bucket, ExpectedBucketOwner: scope.accountId }))).TagSet;
    if (!Array.isArray(tags) || new Set(tags.map(tag => tag.Key)).size !== tags.length
      || !tags.some(tag => tag.Key === 'hypervibe-environment-id' && tag.Value === scope.environmentId)
      || !tags.some(tag => tag.Key === 'hypervibe-storage-name' && tag.Value === scope.storageName)
      || !tags.some(tag => tag.Key === 'hypervibe-project' && tag.Value === target.context.projectName)) throw new Error('The exact application bucket ownership is unknown.');
    return { scope, clients };
  }

  private async read(target: StorageRuntimeAccessTarget, binding: StorageRuntimeAccessBinding) {
    const { scope, clients } = await this.verify(target);
    try {
      const output = await clients.iam.send(new GetRolePolicyCommand({ RoleName: scope.roleName, PolicyName: binding.id }));
      if (output.RoleName !== scope.roleName || output.PolicyName !== binding.id || typeof output.PolicyDocument !== 'string') throw new Error('Inline role policy identity is incomplete.');
      return JSON.parse(decodeURIComponent(output.PolicyDocument));
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }

  async observe(target: StorageRuntimeAccessTarget, binding?: StorageRuntimeAccessBinding): Promise<StorageRuntimeAccessObservation> {
    try {
      if (binding) this.validateBinding(target, binding);
      // The policy slot is deterministic; ownership still requires the exact
      // independently retained attempt, never a same-named policy alone.
      const selected = binding ?? this.binding(target, 'observation-only');
      const policy = await this.read(target, selected);
      if (!policy) return { state: 'absent' };
      if (!binding || hash(policy) !== binding.evidence.policyHash || canonical(policy) !== canonical(this.policy(target, binding.attemptId))) throw new Error('Inline policy ownership changed.');
      return { state: 'present', binding };
    } catch {
      return { state: 'unknown', reason: 'The exact AWS task role, bucket ownership or retained bucket-access policy could not be verified.' };
    }
  }

  async grant(target: StorageRuntimeAccessTarget, attemptId: string, binding?: StorageRuntimeAccessBinding) {
    let selected: StorageRuntimeAccessBinding | undefined;
    let mutationAttempted = false;
    try {
      selected = binding ?? this.binding(target, attemptId);
      this.validateBinding(target, selected);
      if (selected.attemptId !== attemptId) throw new Error('Bucket access attempt changed.');
      const observed = await this.observe(target, selected);
      if (observed.state === 'unknown') throw new Error('Bucket access is unknown.');
      if (observed.state === 'present') return { receipt: { success: true, message: 'Verified the exact existing application bucket grant.' }, binding: selected };
      const { scope, clients } = await this.verify(target);
      // Recheck the exact slot immediately before the idempotent write.
      if (await this.read(target, selected)) throw new Error('The bucket access slot changed before mutation.');
      mutationAttempted = true;
      await clients.iam.send(new PutRolePolicyCommand({ RoleName: scope.roleName, PolicyName: selected.id, PolicyDocument: JSON.stringify(this.policy(target, attemptId)) }));
      if ((await this.observe(target, selected)).state !== 'present') throw new Error('The bucket grant has not converged.');
      return { receipt: { success: true, message: 'Verified application object access to only the selected S3 bucket.' }, binding: selected };
    } catch {
      return { receipt: { success: false, message: mutationAttempted ? 'The S3 bucket grant is pending exact-policy verification.' : 'The S3 bucket grant was blocked before mutation.', data: { mutationAttempted } }, ...(mutationAttempted && selected ? { binding: selected } : {}) };
    }
  }

  async revoke(target: StorageRuntimeAccessTarget, binding: StorageRuntimeAccessBinding) {
    let mutationAttempted = false;
    try {
      this.validateBinding(target, binding);
      const observed = await this.observe(target, binding);
      if (observed.state === 'unknown') throw new Error('Bucket access ownership is unknown.');
      if (observed.state === 'absent') return { success: true, message: 'The exact application bucket grant is already absent.' };
      const { scope, clients } = await this.verify(target);
      const latest = await this.read(target, binding);
      if (!latest || hash(latest) !== binding.evidence.policyHash) throw new Error('The exact owned policy changed before removal.');
      mutationAttempted = true;
      await clients.iam.send(new DeleteRolePolicyCommand({ RoleName: scope.roleName, PolicyName: binding.id }));
      if ((await this.observe(target, binding)).state !== 'absent') throw new Error('The bucket grant remains observable.');
      return { success: true, message: 'Verified removal of only the selected application bucket grant.' };
    } catch {
      return { success: false, message: 'S3 bucket grant removal could not be verified; retain its exact binding for recovery.', data: { mutationAttempted } };
    }
  }
}
