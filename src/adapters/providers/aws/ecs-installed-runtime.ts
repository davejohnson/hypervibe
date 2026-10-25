import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { GetRoleCommand, GetRolePolicyCommand, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand, type IAMClient } from '@aws-sdk/client-iam';
import { DescribeExpressGatewayServiceCommand, DescribeTaskDefinitionCommand, type ECSClient } from '@aws-sdk/client-ecs';
import { DescribeSecretCommand, ListSecretVersionIdsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudDeploymentConnectionV1 } from '../../../domain/ports/cloud-deployment.port.js';
import type { IRuntimeIdentities, RuntimeIdentityRequest, RuntimeIdentityStep } from '../../../domain/ports/runtime-identity.port.js';
import type { ProviderRuntimeIdentity } from '../../../domain/ports/provider.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { awsDeploymentNames } from './aws-cloud-deployment.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { ecsCurrentConfiguration } from './ecs-volume-runtime.js';

type Clients = { iam: IAMClient; ecs: ECSClient };
const phase = 'installed-runtime-binding';
const policyName = 'hypervibe-deployment-access';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parsePolicy = (value: string | undefined) => JSON.parse(decodeURIComponent(value ?? ''));
/** Verify the exact administrator-installed roles. Never create, retag, grant or delete them. */
export async function verifyAwsInstalledRoles(connection: CloudDeploymentConnectionV1, clients: Clients, workload: string) {
  const selected = connection.runtimeIdentities.filter(item => item.workload === workload);
  const result: Record<string, { arn: string; id: string; owner: string }> = {};
  const allArns = [...new Set(connection.deployment.workloads.flatMap(item => item.runtimeSecrets.map(value => {
    if (value.reference.destination.provider !== 'aws-secrets') throw new Error(); return value.reference.destination.secretArn;
  })))].sort();
  for (const item of selected) {
    const native = item.principal; if (native.kind !== 'aws-role') throw new Error(); const name = native.roleArn.split('/').at(-1)!;
    const role = (await clients.iam.send(new GetRoleCommand({ RoleName: name }))).Role;
    const tags = Object.fromEntries((role?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    if (role?.Arn !== native.roleArn || role.RoleId !== native.roleId || role.RoleName !== name || tags['hypervibe-owner'] !== item.owner || tags['hypervibe-installation'] !== item.installationId) throw new Error();
    const expectedTrust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: native.purpose === 'infrastructure' ? 'ecs.amazonaws.com' : 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
    if (!isDeepStrictEqual(parsePolicy(role.AssumeRolePolicyDocument), expectedTrust)) throw new Error();
    const attached = await clients.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: name }));
    const inline = await clients.iam.send(new ListRolePoliciesCommand({ RoleName: name }));
    const expectedAttached = native.purpose === 'task' ? [] : [`arn:aws:iam::aws:policy/service-role/${native.purpose === 'execution' ? 'AmazonECSTaskExecutionRolePolicy' : 'AmazonECSInfrastructureRoleforExpressGatewayServices'}`];
    const expectedInline = native.purpose === 'execution' && allArns.length ? [policyName] : [];
    if (attached.IsTruncated || inline.IsTruncated || !Array.isArray(attached.AttachedPolicies) || !Array.isArray(inline.PolicyNames)
      || !isDeepStrictEqual(attached.AttachedPolicies.map(item => item.PolicyArn).sort(), expectedAttached) || !isDeepStrictEqual(inline.PolicyNames, expectedInline)) throw new Error();
    if (expectedInline.length) {
      const policy = await clients.iam.send(new GetRolePolicyCommand({ RoleName: name, PolicyName: policyName }));
      if (policy.RoleName !== name || policy.PolicyName !== policyName || !isDeepStrictEqual(parsePolicy(policy.PolicyDocument), {
        Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: allArns }],
      })) throw new Error();
    }
    result[native.purpose] = { arn: native.roleArn, id: native.roleId, owner: item.owner };
  }
  if (!result.task || !result.execution || !result.infrastructure) throw new Error(); return result;
}

export class EcsInstalledRuntimeIdentities implements IRuntimeIdentities {
  constructor(private readonly connection: () => CloudDeploymentConnectionV1, private readonly clients: () => Clients) {}
  private async proof(request: RuntimeIdentityRequest) {
    const connection = this.connection(), names = awsDeploymentNames(connection), workload = connection.deployment.workloads.find(item => item.name === request.service.name);
    if (!workload || request.environment.name !== connection.environment || request.environmentSpec?.hosting.provider !== 'ecs'
      || request.environmentSpec.hosting.region && request.environmentSpec.hosting.region !== names.region || Object.keys(request.environmentSpec.storage ?? {}).length) throw new Error();
    const bindings = parseHostingBindings(request.environment), clusterArn = `arn:aws:ecs:${names.region}:${names.accountId}:cluster/${names.clusterName}`;
    if (bindings.projectId !== clusterArn || bindings.environmentId !== clusterArn) throw new Error();
    const desired = Object.entries(request.environmentSpec.secretDestinations ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, reference: runtimeSecretReferenceSchema.parse(value) }));
    if (request.mode !== 'destroy' && !isDeepStrictEqual(desired, workload.runtimeSecrets)) throw new Error();
    const clients = this.clients(), roles = await verifyAwsInstalledRoles(connection, clients, workload.name);
    const serviceArn = bindings.services?.[workload.name]?.serviceId;
    if (serviceArn) {
      if (serviceArn !== clusterArn.replace(':cluster/', ':service/') + '/' + resourceName(workload.name, { maxLength: 255 })) throw new Error();
      const service = (await clients.ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn, include: ['TAGS'] }))).service;
      if (service?.serviceArn !== serviceArn || service.cluster !== clusterArn || !service.tags?.some(tag => tag.key === 'hypervibe-environment-id' && tag.value === request.environment.id)) throw new Error();
      const config = ecsCurrentConfiguration(service);
      if (!config.taskDefinitionArn) throw new Error();
      const task = (await clients.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: config.taskDefinitionArn }))).taskDefinition;
      if (!task || task.taskDefinitionArn !== config.taskDefinitionArn || task.executionRoleArn !== roles.execution.arn || task.taskRoleArn !== roles.task.arn) throw new Error();
    }
    const refs = new SecretsManagerClient({ region: names.region, credentials: clients.iam.config.credentials, requestHandler: clients.iam.config.requestHandler, maxAttempts: 1 });
    // The request handler belongs to the adapter, so this short-lived wrapper does not destroy it.
    for (const item of workload.runtimeSecrets) {
      const destination = item.reference.destination; if (destination.provider !== 'aws-secrets') throw new Error();
      const metadata = await refs.send(new DescribeSecretCommand({ SecretId: destination.secretArn }));
      if (metadata.ARN !== destination.secretArn || !metadata.CreatedDate || metadata.DeletedDate || metadata.KmsKeyId && metadata.KmsKeyId !== 'alias/aws/secretsmanager') throw new Error();
      const versions = await refs.send(new ListSecretVersionIdsCommand({ SecretId: destination.secretArn, IncludeDeprecated: true, MaxResults: 100 }));
      if (versions.ARN !== destination.secretArn || versions.NextToken || !versions.Versions?.some(version => version.VersionId === item.reference.version)) throw new Error();
    }
    const target = { phase, runtimeInstallationId: connection.installationId, runtimePlanDigest: connection.planDigest, runtimeOwner: roles.task.owner,
      clusterArn, environmentId: request.environment.id, serviceName: workload.name, roleArn: roles.task.arn, roleId: roles.task.id,
      executionRoleArn: roles.execution.arn, executionRoleId: roles.execution.id, infrastructureRoleArn: roles.infrastructure.arn, infrastructureRoleId: roles.infrastructure.id,
      readerFingerprint: hash(workload.runtimeSecrets) };
    const identity: ProviderRuntimeIdentity = { provider: 'aws', principal: roles.task.arn, source: 'configured', scope: { accountId: names.accountId, region: names.region, roleId: roles.task.id,
      clusterArn, environmentId: request.environment.id, ...(serviceArn ? { serviceArn } : {}) } };
    return { target, identity };
  }
  async inspect(request: RuntimeIdentityRequest): Promise<Awaited<ReturnType<IRuntimeIdentities['inspect']>>> {
    try {
      const proof = await this.proof(request);
      if (request.mode === 'destroy') return { state: 'ready', warnings: ['Administrator-installed runtime identities and their grants are retained.'] };
      const pending = request.binding?.pending;
      if (pending) {
        const target = { ...pending.step.target };
        delete target.recoverAttemptId;
        if (!isDeepStrictEqual(target, proof.target)) throw new Error();
        return { state: 'action', step: { operation: 'recover', target: { ...proof.target, recoverAttemptId: pending.attemptId }, description: 'Verify the recorded installed runtime binding without changing IAM.', requiresConfirm: false } };
      }
      if (request.binding && !isDeepStrictEqual(request.binding.evidence, proof.target)) throw new Error();
      if (request.binding) return { state: 'ready', identity: proof.identity };
      return { state: 'action', step: { operation: 'attach', target: proof.target, description: 'Bind the independently verified administrator-installed AWS runtime roles and reader permissions.', requiresConfirm: true } };
    } catch { return { state: 'unknown', reason: 'Administrator-installed AWS runtime identity or reader permissions changed; a new setup review may be required.' }; }
  }
  async apply(request: RuntimeIdentityRequest & { step: RuntimeIdentityStep; attemptId: string }): Promise<Awaited<ReturnType<IRuntimeIdentities['apply']>>> {
    try {
      const proof = await this.proof(request), target = { ...request.step.target }; delete target.recoverAttemptId;
      if (request.mode !== 'ensure' || !['attach', 'recover'].includes(request.step.operation) || !isDeepStrictEqual(target, proof.target)
        || request.binding?.pending && request.binding.pending.attemptId !== (request.step.target.recoverAttemptId ?? request.attemptId)) throw new Error();
      return { receipt: { success: true, message: 'Verified and bound installed runtime roles; no cloud permission changes were made.' }, binding: { provider: 'ecs', evidence: proof.target } };
    } catch { return { receipt: { success: false, message: 'Installed runtime binding could not be verified; no cloud permission changes were made.' } }; }
  }
}
