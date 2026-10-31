import { EcsRuntimeSecrets } from './ecs-runtime-secrets.js';
import { createHash } from 'node:crypto';
import { CreateRoleCommand, DeleteRoleCommand, GetRoleCommand, IAMClient, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand, type Role } from '@aws-sdk/client-iam';
import { DescribeExpressGatewayServiceCommand, DescribeTaskDefinitionCommand, ECSClient, ListTaskDefinitionsCommand, RegisterTaskDefinitionCommand, UpdateExpressGatewayServiceCommand, type ECSExpressGatewayService, type TaskDefinition } from '@aws-sdk/client-ecs';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { IRuntimeIdentities, RuntimeIdentityBinding, RuntimeIdentityObservation, RuntimeIdentityRequest, RuntimeIdentityStep } from '../../../domain/ports/runtime-identity.port.js';
import type { ProviderRuntimeIdentity } from '../../../domain/ports/provider.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { resourceName, resourceScopeSuffix } from '../../../domain/services/resource-names.js';
import { ecsCurrentConfiguration, ecsTaskDefinitionInput } from './ecs-volume-runtime.js';
import { ecsTaskDefinitionWriter } from './ecs-task-definition-writer.js';

type Clients = { ecs: ECSClient; iam: IAMClient; sts: STSClient };
type Scope = { accountId: string; region: string; clusterArn: string; serviceArn: string; environmentId: string; roleName: string; roleArn: string };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const missing = (error: unknown, ...names: string[]): boolean => names.includes((error as { name?: string })?.name ?? '');
const ready = (): RuntimeIdentityObservation => ({ state: 'ready' });
const waiting = (reason: string): RuntimeIdentityObservation => ({ state: 'waiting', reason });

/** Roles, registration and attachment are separate, explicit plan frontiers. */
export class EcsRuntimeIdentities implements IRuntimeIdentities {
  private readonly secrets: EcsRuntimeSecrets;
  constructor(
    private readonly connected: () => { clients: Clients; region: string },
    private readonly resolveIdentity: (request: RuntimeIdentityRequest) => Promise<ProviderRuntimeIdentity>,
    firstExecutionRole: (clusterArn: string) => string,
  ) { this.secrets = new EcsRuntimeSecrets(connected, firstExecutionRole); }

  private async scope(request: RuntimeIdentityRequest): Promise<Scope> {
    const bindings = parseHostingBindings(request.environment);
    const retained = request.binding?.evidence;
    const clusterArn = bindings.projectId ?? (request.mode === 'destroy' ? retained?.clusterArn : undefined);
    const serviceArn = bindings.services?.[request.service.name]?.serviceId ?? (request.mode === 'destroy' ? retained?.serviceArn : undefined);
    const { region, clients } = this.connected();
    const match = clusterArn?.match(/^arn:(aws(?:-[a-z]+)?):ecs:([^:]+):(\d{12}):cluster\/([A-Za-z0-9_-]+)$/);
    if (!match || match[2] !== region || !serviceArn?.startsWith(clusterArn!.replace(':cluster/', ':service/') + '/')
      || (bindings.environmentId && bindings.environmentId !== clusterArn)) throw new Error('Exact ECS scope is unavailable.');
    const caller = await clients.sts.send(new GetCallerIdentityCommand({}));
    if (caller.Account !== match[3] || !caller.Arn || !caller.UserId) throw new Error('Selected AWS account could not be verified.');
    const roleName = resourceName('runtime', { scope: [clusterArn!, serviceArn], maxLength: 64 });
    const scope = { accountId: match[3]!, region, clusterArn: clusterArn!, serviceArn, environmentId: request.environment.id, roleName, roleArn: `arn:${match[1]}:iam::${match[3]}:role/${roleName}` };
    if (retained?.roleId && (request.binding?.provider !== 'ecs'
      || Object.entries(scope).some(([key, value]) => retained[key] !== value))) throw new Error('Retained ECS runtime identity scope changed.');
    return scope;
  }

  private async workload(scope: Scope): Promise<ECSExpressGatewayService | undefined> {
    try {
      const service = (await this.connected().clients.ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn: scope.serviceArn, include: ['TAGS'] }))).service;
      if (service?.serviceArn !== scope.serviceArn || service.cluster !== scope.clusterArn
        || !service.tags?.some(tag => tag.key === 'managed-by' && tag.value === 'hypervibe')
        || !service.tags.some(tag => tag.key === 'hypervibe-environment-id' && tag.value === scope.environmentId)) throw new Error('ECS service ownership is unknown.');
      return service;
    } catch (error) {
      if (missing(error, 'ServiceNotFoundException', 'ResourceNotFoundException', 'ClusterNotFoundException')) return undefined;
      throw error;
    }
  }

  private async task(scope: Scope, arn: string): Promise<{ task: TaskDefinition; tags: Array<{ key?: string; value?: string }> }> {
    if (!arn.startsWith(scope.serviceArn.split(':service/')[0] + ':task-definition/') || !/:\d+$/.test(arn)) throw new Error('Task definition is outside the exact AWS scope.');
    const result = await this.connected().clients.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn, include: ['TAGS'] }));
    const task = result.taskDefinition;
    if (task?.taskDefinitionArn !== arn || task.status !== 'ACTIVE' || arn !== `${scope.serviceArn.split(':service/')[0]}:task-definition/${task.family}:${task.revision}`) throw new Error('Exact task definition is unknown.');
    ecsTaskDefinitionInput(task, {});
    return { task, tags: result.tags ?? [] };
  }

  private async current(scope: Scope, service: ECSExpressGatewayService) {
    const config = ecsCurrentConfiguration(service);
    if (!config.taskDefinitionArn) throw new Error('The current ECS task definition is unavailable.');
    const result = await this.task(scope, config.taskDefinitionArn);
    if (config.taskRoleArn !== undefined && config.taskRoleArn !== result.task.taskRoleArn) throw new Error('Task role summaries disagree.');
    return { ...result, config };
  }

  private trust(scope: Scope) {
    return { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': scope.accountId }, ArnLike: { 'aws:SourceArn': `${scope.serviceArn.split(':service/')[0]}:*` } } }] };
  }

  private async role(scope: Scope): Promise<Role | undefined> {
    try {
      const role = (await this.connected().clients.iam.send(new GetRoleCommand({ RoleName: scope.roleName }))).Role;
      if (role?.Arn !== scope.roleArn || role.RoleName !== scope.roleName || !/^AROA[A-Z0-9]{12,124}$/.test(role.RoleId ?? '')) throw new Error('Exact runtime role identity is unavailable.');
      return role;
    } catch (error) { if (missing(error, 'NoSuchEntity', 'NoSuchEntityException')) return undefined; throw error; }
  }

  private tags(scope: Scope, attemptId: string) {
    return [{ Key: 'managed-by', Value: 'hypervibe' }, { Key: 'hypervibe-environment-id', Value: scope.environmentId }, { Key: 'hypervibe-runtime-service', Value: resourceScopeSuffix([scope.clusterArn, scope.serviceArn]) }, { Key: 'hypervibe-runtime-attempt', Value: attemptId }];
  }

  private ownedRole(scope: Scope, role: Role | undefined, attemptId: string, roleId?: string): Role {
    if (!role || !attemptId || (roleId && role.RoleId !== roleId)
      || this.tags(scope, attemptId).some(expected => !role.Tags?.some(tag => tag.Key === expected.Key && tag.Value === expected.Value))) throw new Error('Runtime role creation ownership is unknown.');
    const document = JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument ?? ''));
    if (!same(document, this.trust(scope))) throw new Error('Runtime role trust changed.');
    return role;
  }

  private evidence(scope: Scope, role: Role, attemptId: string, previous?: RuntimeIdentityBinding): RuntimeIdentityBinding {
    return { provider: 'ecs', evidence: { ...previous?.evidence, ...scope, roleId: role.RoleId!, createAttemptId: attemptId } };
  }

  private step(operation: RuntimeIdentityStep['operation'], target: Record<string, string>, description: string): RuntimeIdentityObservation {
    return { state: 'action', step: { operation, target, description, requiresConfirm: operation !== 'recover', ...(operation === 'attach' && target.phase === 'activate' ? { restartsWorkload: true } : {}) } };
  }

  private baseline(scope: Scope, service: ECSExpressGatewayService, task: TaskDefinition): Record<string, string> {
    return { ...scope, taskDefinitionArn: task.taskDefinitionArn!, serviceRevisionArn: service.currentDeployment!, taskFingerprint: hash(ecsTaskDefinitionInput(task, {})) };
  }

  private registrationTags(scope: Scope, attemptId: string, tags: Array<{ key?: string; value?: string }>) {
    const owned = this.tags(scope, attemptId).map(tag => ({ key: tag.Key, value: tag.Value }));
    return [...tags.filter(tag => !owned.some(expected => expected.key === tag.key)), ...owned];
  }

  private async prepared(scope: Scope, target: Record<string, string>, arn: string, attemptId: string) {
    const source = await this.task(scope, target.taskDefinitionArn!);
    if (hash(ecsTaskDefinitionInput(source.task, {})) !== target.taskFingerprint || source.task.taskRoleArn) throw new Error('Source task definition changed.');
    const result = await this.task(scope, arn);
    const expected = { ...ecsTaskDefinitionInput(source.task, {}), taskRoleArn: scope.roleArn };
    if (!same(ecsTaskDefinitionInput(result.task, {}), expected)
      || this.registrationTags(scope, attemptId, source.tags).some(tag => !result.tags.some(observed => observed.key === tag.key && observed.value === tag.value))) throw new Error('Prepared runtime task definition could not be verified.');
    return result;
  }

  private async unusedRole(scope: Scope): Promise<boolean> {
    const { iam } = this.connected().clients;
    const inline = await iam.send(new ListRolePoliciesCommand({ RoleName: scope.roleName }));
    const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: scope.roleName }));
    if (!Array.isArray(inline.PolicyNames) || !Array.isArray(attached.AttachedPolicies)
      || inline.IsTruncated === undefined || attached.IsTruncated === undefined) throw new Error('Runtime role policy inventory is incomplete.');
    // A truncated inventory already proves the role is not empty; never delete
    // any policy here, including unfamiliar or externally added policies.
    return !inline.IsTruncated && !attached.IsTruncated && !inline.PolicyNames.length && !attached.AttachedPolicies.length;
  }

  private recoveryStep(pending: NonNullable<RuntimeIdentityBinding['pending']>): RuntimeIdentityStep {
    return { operation: 'recover', target: { ...pending.step.target, recoverOperation: pending.step.operation, recoverAttemptId: pending.attemptId }, description: 'Verify the exact recorded AWS runtime identity operation without repeating its creation.', requiresConfirm: false };
  }

  private async recover(request: RuntimeIdentityRequest, scope: Scope, step: RuntimeIdentityStep): Promise<RuntimeIdentityBinding | undefined | 'waiting'> {
    const target = step.target;
    const operation = target.recoverOperation;
    const attemptId = target.recoverAttemptId!;
    if (!attemptId || Object.entries(scope).some(([key, value]) => target[key] !== value)) throw new Error('Recovery scope is invalid.');
    if (operation === 'create') {
      const role = await this.role(scope);
      if (!role) return 'waiting';
      this.ownedRole(scope, role, attemptId);
      return this.evidence(scope, role, attemptId, request.binding);
    }
    const evidence = request.binding?.evidence;
    if (!evidence) throw new Error('Runtime identity recovery has no retained identity.');
    if (operation === 'destroy') {
      if (await this.workload(scope)) return 'waiting';
      const role = await this.role(scope);
      if (role) { this.ownedRole(scope, role, evidence.createAttemptId!, evidence.roleId); return 'waiting'; }
      return undefined;
    }
    this.ownedRole(scope, await this.role(scope), evidence.createAttemptId!, evidence.roleId);
    if (operation !== 'attach') throw new Error('Runtime identity recovery operation is invalid.');
    if (target.phase === 'register') {
      const source = await this.task(scope, target.taskDefinitionArn!);
      const matches: string[] = [];
      const seen = new Set<string>();
      let nextToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await this.connected().clients.ecs.send(new ListTaskDefinitionsCommand({ familyPrefix: source.task.family, status: 'ACTIVE', maxResults: 100, nextToken }));
        if (!Array.isArray(result.taskDefinitionArns) || result.taskDefinitionArns.length + seen.size > 100) throw new Error('Runtime identity recovery inventory is incomplete.');
        for (const arn of result.taskDefinitionArns) {
          if (seen.has(arn)) throw new Error('Runtime identity recovery inventory is ambiguous.');
          seen.add(arn);
          const found = await this.task(scope, arn);
          if (found.tags.some(tag => tag.key === 'hypervibe-runtime-attempt' && tag.value === attemptId)) {
            await this.prepared(scope, target, arn, attemptId); matches.push(arn);
          }
        }
        if (!result.nextToken) break;
        if (result.nextToken === nextToken || page === 9) throw new Error('Runtime identity recovery inventory is incomplete.');
        nextToken = result.nextToken;
      }
      if (!matches.length) return 'waiting';
      if (matches.length !== 1) throw new Error('Runtime identity recovery found multiple task definitions.');
      return { provider: 'ecs', evidence: { ...evidence, preparedTaskDefinitionArn: matches[0]!, registerAttemptId: attemptId, sourceTaskDefinitionArn: target.taskDefinitionArn!, sourceTaskFingerprint: target.taskFingerprint! } };
    }
    if (target.phase !== 'activate' || !evidence.preparedTaskDefinitionArn) throw new Error('Attachment recovery is incomplete.');
    await this.prepared(scope, { ...target, taskDefinitionArn: evidence.sourceTaskDefinitionArn!, taskFingerprint: evidence.sourceTaskFingerprint! }, evidence.preparedTaskDefinitionArn, evidence.registerAttemptId!);
    const service = await this.workload(scope);
    if (!service) throw new Error('Bound ECS service is missing.');
    const current = await this.current(scope, service);
    if (current.task.taskDefinitionArn !== evidence.preparedTaskDefinitionArn || current.task.taskRoleArn !== scope.roleArn) return 'waiting';
    return { provider: 'ecs', evidence: { ...evidence } };
  }

  async inspect(request: RuntimeIdentityRequest): Promise<RuntimeIdentityObservation> {
    try {
      const secretStep = await this.secrets.inspect(request);
      if (secretStep) return secretStep;
      if (request.mode === 'ensure' && !parseHostingBindings(request.environment).services?.[request.service.name]?.serviceId) return ready();
      const scope = await this.scope(request);
      const pending = request.binding?.pending;
      if (pending) {
        const step = pending.step.operation === 'recover' ? pending.step : this.recoveryStep(pending);
        const result = await this.recover(request, scope, step);
        return result === 'waiting' ? waiting('The recorded AWS runtime identity operation is not yet independently observable; do not repeat it.') : { state: 'action', step };
      }
      const service = await this.workload(scope);
      const evidence = request.binding?.evidence;
      if (request.mode === 'destroy') {
        if (!evidence?.roleId) return ready();
        if (service) return waiting('Delete the exact consuming ECS service before its owned runtime role.');
        const role = await this.role(scope);
        if (!role) return this.step('destroy', { ...scope, roleId: evidence.roleId!, createAttemptId: evidence.createAttemptId! }, 'Finalize removal of the confirmed absent application runtime role.');
        this.ownedRole(scope, role, evidence.createAttemptId!, evidence.roleId);
        if (!await this.unusedRole(scope)) return waiting('Remove the application bucket grants and any other policies before deleting its runtime role.');
        return this.step('destroy', { ...scope, roleId: evidence.roleId!, createAttemptId: evidence.createAttemptId! }, 'Delete only this application service’s unused runtime role.');
      }
      if (!service) return waiting('Create and bind the ECS service before preparing its application runtime role.');
      const current = await this.current(scope, service);
      if (current.task.taskRoleArn) {
        if (evidence?.roleId) {
          this.ownedRole(scope, await this.role(scope), evidence.createAttemptId!, evidence.roleId);
          if (current.task.taskRoleArn !== scope.roleArn) throw new Error('Existing task identity changed.');
        }
        return { state: 'ready', identity: await this.resolveIdentity(request) };
      }
      const target = this.baseline(scope, service, current.task);
      const role = await this.role(scope);
      if (!evidence?.roleId) {
        if (role) throw new Error('An unbound runtime role already exists.');
        return this.step('create', target, 'Create a separate application service role with no permissions; bucket access is reviewed separately.');
      }
      this.ownedRole(scope, role, evidence.createAttemptId!, evidence.roleId);
      if (evidence.preparedTaskDefinitionArn) {
        if (target.taskDefinitionArn !== evidence.sourceTaskDefinitionArn || target.taskFingerprint !== evidence.sourceTaskFingerprint) throw new Error('Prepared runtime attachment has a stale source.');
        await this.prepared(scope, target, evidence.preparedTaskDefinitionArn, evidence.registerAttemptId!);
        return this.step('attach', { ...target, phase: 'activate', preparedTaskDefinitionArn: evidence.preparedTaskDefinitionArn }, 'Attach the reviewed application role without changing the image, environment, storage mounts or execution role.');
      }
      return this.step('attach', { ...target, phase: 'register' }, 'Prepare an exact copy of the service task definition with its separate application role.');
    } catch {
      return { state: 'unknown', reason: 'The exact AWS runtime identity, current service revision or ownership could not be verified.' };
    }
  }

  async apply(request: RuntimeIdentityRequest & { step: RuntimeIdentityStep; attemptId: string }) {
    if (request.step.target.phase === 'execution-secrets') return this.secrets.apply(request);
    let mutationAttempted = false;
    try {
      const pending = request.binding?.pending;
      if (pending?.attemptId !== request.attemptId || !same(pending.step, request.step)) throw new Error('Persisted runtime identity intent is missing.');
      const scope = await this.scope(request);
      if (request.step.operation === 'recover') {
        const recovered = await this.recover(request, scope, request.step);
        if (recovered === 'waiting') throw new Error('Runtime identity recovery is not yet observable.');
        return { receipt: { success: true, message: 'Verified the exact recorded AWS runtime identity operation.' }, binding: recovered };
      }
      const current = await this.inspect({ ...request, binding: request.binding ? { provider: request.binding.provider, evidence: request.binding.evidence } : undefined });
      if (current.state !== 'action' || !same(current.step, request.step)) throw new Error('Reviewed runtime identity preconditions changed.');
      const { clients } = this.connected();
      const target = request.step.target;
      if (request.step.operation === 'create') {
        // IAM CreateRole has no client token. Never retry an ambiguous create.
        const { serviceConfiguredEndpoint: _resolvedEndpoint, ...configuration } = clients.iam.config;
        const writer = new IAMClient({ ...configuration, retryStrategy: undefined, maxAttempts: 1 });
        mutationAttempted = true;
        const result = await writer.send(new CreateRoleCommand({ RoleName: scope.roleName, AssumeRolePolicyDocument: JSON.stringify(this.trust(scope)), Tags: this.tags(scope, request.attemptId) }));
        if (result.Role?.Arn !== scope.roleArn || !result.Role.RoleId) throw new Error('Runtime role creation identity is incomplete.');
        const observed = this.ownedRole(scope, await this.role(scope), request.attemptId, result.Role.RoleId);
        return { receipt: { success: true, message: 'Created the application service’s separate runtime role without granting storage access.' }, binding: this.evidence(scope, observed, request.attemptId, request.binding) };
      }
      const evidence = request.binding!.evidence;
      if (request.step.operation === 'destroy') {
        const observed = await this.role(scope);
        if (observed) {
          this.ownedRole(scope, observed, evidence.createAttemptId!, evidence.roleId);
          if (!await this.unusedRole(scope) || await this.workload(scope)) throw new Error('Runtime role is still in use.');
          mutationAttempted = true;
          await clients.iam.send(new DeleteRoleCommand({ RoleName: scope.roleName }));
        }
        if (await this.role(scope)) throw new Error('Runtime role deletion has not converged.');
        return { receipt: { success: true, message: 'Verified removal of the exact unused application runtime role.' }, binding: undefined };
      }
      if (target.phase === 'register') {
        const source = await this.task(scope, target.taskDefinitionArn!);
        const input = { ...ecsTaskDefinitionInput(source.task, {}), taskRoleArn: scope.roleArn, tags: this.registrationTags(scope, request.attemptId, source.tags) };
        mutationAttempted = true;
        const registered = await ecsTaskDefinitionWriter(clients.ecs).send(new RegisterTaskDefinitionCommand(input));
        const arn = registered.taskDefinition?.taskDefinitionArn;
        if (!arn || arn === source.task.taskDefinitionArn) throw new Error('Task registration identity is incomplete.');
        await this.prepared(scope, target, arn, request.attemptId);
        return { receipt: { success: true, message: 'Prepared the exact application runtime role task definition; attachment is a separate plan step.' }, binding: { provider: 'ecs', evidence: { ...evidence, preparedTaskDefinitionArn: arn, registerAttemptId: request.attemptId, sourceTaskDefinitionArn: target.taskDefinitionArn!, sourceTaskFingerprint: target.taskFingerprint! } } };
      }
      if (target.phase !== 'activate' || target.preparedTaskDefinitionArn !== evidence.preparedTaskDefinitionArn) throw new Error('Attachment target changed.');
      await this.prepared(scope, target, evidence.preparedTaskDefinitionArn!, evidence.registerAttemptId!);
      mutationAttempted = true;
      const updated = await clients.ecs.send(new UpdateExpressGatewayServiceCommand({ serviceArn: scope.serviceArn, taskDefinitionArn: evidence.preparedTaskDefinitionArn }));
      if (updated.service?.serviceArn !== scope.serviceArn) throw new Error('Attachment returned no exact service identity.');
      const recovery = await this.recover(request, scope, { ...request.step, operation: 'recover', target: { ...target, recoverOperation: 'attach', recoverAttemptId: request.attemptId } });
      if (recovery === 'waiting') throw new Error('Attachment is not yet independently observable.');
      return { receipt: { success: true, message: 'Verified the exact application role is attached to the service.' }, binding: recovery };
    } catch {
      return { receipt: { success: false, message: mutationAttempted ? 'AWS runtime identity operation could not be verified. Its recorded attempt remains pending for exact-identity recovery.' : 'AWS runtime identity preconditions could not be verified; no mutation was attempted.', data: { mutationAttempted } } };
    }
  }
}
