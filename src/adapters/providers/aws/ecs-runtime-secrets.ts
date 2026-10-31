import { z } from 'zod';
import { DeleteRolePolicyCommand, GetRoleCommand, GetRolePolicyCommand, IAMClient, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import { DescribeExpressGatewayServiceCommand, DescribeTaskDefinitionCommand, ListTasksCommand, DescribeTasksCommand, type ECSClient } from '@aws-sdk/client-ecs';
import { GetCallerIdentityCommand, type STSClient } from '@aws-sdk/client-sts';
import { DescribeSecretCommand, ListSecretVersionIdsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { RuntimeIdentityBinding, RuntimeIdentityObservation, RuntimeIdentityRequest, RuntimeIdentityStep } from '../../../domain/ports/runtime-identity.port.js';
import { parseHostingBindings } from '../../../domain/ports/hosting.port.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { ecsCurrentConfiguration } from './ecs-volume-runtime.js';
const phase = 'execution-secrets';
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const missing = (error: unknown, names: string[]) => names.includes((error as {
  name?: string;
})?.name ?? '');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const targetSchema = z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), arn: z.string().regex(/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/), version: z.string().regex(/^[A-Za-z0-9-]{32,64}$/), createdAt: z.string().datetime().optional(), keyArns: z.array(z.string()).max(10).optional() }).strict();
type Target = z.infer<typeof targetSchema>;
type Clients = {
  ecs: ECSClient;
  iam: IAMClient;
  sts: STSClient;
};
function encode(targets: Target[]): string {
  const value = JSON.stringify(targets);
  if (value.length > 8192) throw new Error();
  return value;
}
function parse(value?: string): Target[] {
  if (value === undefined) return [];
  if (value.length > 8192) throw new Error();
  const result = z.array(targetSchema).max(50).parse(JSON.parse(value));
  if (new Set(result.map(t => t.key)).size !== result.length || new Set(result.map(t => t.arn)).size !== result.length) throw new Error();
  return result;
}
function desired(request: RuntimeIdentityRequest): Target[] {
  if (request.mode === 'destroy')
    return [];
  if (!request.environmentSpec)
    return parse(request.binding?.evidence.executionReaderTargets);
  return parse(encode(Object.entries(request.environmentSpec.secretDestinations ?? {}).flatMap(([key, input]) => {
    if (!input.version)
      return [];
    const ref = runtimeSecretReferenceSchema.parse(input);
    if (ref.destination.provider !== 'aws-secrets')
      throw new Error();
    return [{ key, arn: ref.destination.secretArn, version: ref.version }];
  }).sort((a, b) => a.key.localeCompare(b.key))));
}
function policy(targets: Target[], attemptId: string, region: string) {
  const statements: unknown[] = [{ Sid: 'Hypervibe' + attemptId.replace(/-/g, ''), Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: targets.map(t => t.arn).sort() }];
  for (const target of targets)
    if (target.keyArns?.length)
      statements.push({ Effect: 'Allow', Action: ['kms:Decrypt'], Resource: [...target.keyArns].sort(), Condition: { StringEquals: { 'kms:ViaService': `secretsmanager.${region}.amazonaws.com`, 'kms:EncryptionContext:SecretARN': target.arn } } });
  return { Version: '2012-10-17', Statement: statements };
}
/** Execution-agent secret access is independent from the application task role used by S3. */
export class EcsRuntimeSecrets {
  constructor(private readonly connected: () => {
    clients: Clients;
    region: string;
  }, private readonly firstExecutionRole: (clusterArn: string) => string) { }
  relevant(request: RuntimeIdentityRequest) { return Boolean(request.binding?.evidence.executionReaderTargets || request.binding?.pending?.step.target.phase === phase || Object.values(request.environmentSpec?.secretDestinations ?? {}).some(value => value.version)); }
  private async scope(request: RuntimeIdentityRequest) {
    const { clients, region } = this.connected();
    const bindings = parseHostingBindings(request.environment);
    const saved = request.binding?.evidence;
    const clusterArn = bindings.projectId ?? saved?.executionReaderCluster;
    const match = clusterArn?.match(/^arn:aws:ecs:([^:]+):(\d{12}):cluster\/([A-Za-z0-9_-]+)$/);
    if (!match || match[1] !== region || bindings.environmentId && bindings.environmentId !== clusterArn)
      throw new Error();
    const caller = await clients.sts.send(new GetCallerIdentityCommand({}));
    if (caller.Account !== match[2] || !caller.Arn || !caller.UserId)
      throw new Error();
    const bound = bindings.services?.[request.service.name]?.serviceId;
    const serviceArn = bound ?? clusterArn!.replace(':cluster/', ':service/') + '/' + resourceName(request.service.name, { maxLength: 255 });
    if (!serviceArn.startsWith(clusterArn!.replace(':cluster/', ':service/') + '/'))
      throw new Error();
    let service;
    try {
      service = (await clients.ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn, include: ['TAGS'] }))).service;
      if (!service || service.serviceArn !== serviceArn || service.cluster !== clusterArn || !service.tags?.some(t => t.key === 'managed-by' && t.value === 'hypervibe') || !service.tags.some(t => t.key === 'hypervibe-environment-id' && t.value === request.environment.id))
        throw new Error();
    }
    catch (error) {
      if (!missing(error, ['ServiceNotFoundException', 'ResourceNotFoundException', 'ClusterNotFoundException']))
        throw error;
    }
    if (service && !bound || !service && bound && request.mode !== 'destroy')
      throw new Error();
    let roleArn: string;
    let activeSecrets: string[] = [];
    if (service) {
      const config = ecsCurrentConfiguration(service);
      const task = (await clients.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: config.taskDefinitionArn }))).taskDefinition;
      if (!config.taskDefinitionArn?.startsWith(serviceArn.split(':service/')[0] + ':task-definition/') || !task || task.taskDefinitionArn !== config.taskDefinitionArn || task.status !== 'ACTIVE' || !task.executionRoleArn || config.executionRoleArn && config.executionRoleArn !== task.executionRoleArn || !Array.isArray(task.containerDefinitions))
        throw new Error();
      roleArn = task.executionRoleArn;
      activeSecrets = task.containerDefinitions.flatMap(c => (c.secrets ?? []).map(s => s.valueFrom ?? ''));
    }
    else
      roleArn = saved?.executionReaderRoleArn ?? this.firstExecutionRole(clusterArn!);
    const roleName = roleArn.split('/').at(-1)!;
    if (!roleArn.startsWith(`arn:aws:iam::${match[2]}:role/`) || !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(roleName))
      throw new Error();
    const role = (await clients.iam.send(new GetRoleCommand({ RoleName: roleName }))).Role;
    if (role?.Arn !== roleArn || role.RoleName !== roleName || !/^AROA[A-Z0-9]{12,124}$/.test(role.RoleId ?? '') || !role.Tags?.some(t => t.Key === 'managed-by' && t.Value === 'hypervibe') || !role.Tags.some(t => t.Key === 'hypervibe-environment-id' && t.Value === request.environment.id))
      throw new Error();
    const trust = JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument ?? ''));
    if (!Array.isArray(trust.Statement) || !trust.Statement.some((s: any) => s.Effect === 'Allow' && s.Principal?.Service === 'ecs-tasks.amazonaws.com' && (s.Action === 'sts:AssumeRole' || Array.isArray(s.Action) && s.Action.includes('sts:AssumeRole'))))
      throw new Error();
    const result = { executionReaderCluster: clusterArn!, executionReaderService: serviceArn, executionReaderEnvironment: request.environment.id, executionReaderRoleArn: roleArn, executionReaderRoleId: role.RoleId!, executionReaderPolicyName: resourceName('secret-reader', { scope: [clusterArn!, serviceArn, request.environment.id], maxLength: 128 }) };
    if (saved?.executionReaderRoleArn && Object.entries(result).some(([key, value]) => saved[key] !== value))
      throw new Error();
    return { ...result, roleName, region, accountId: match[2]!, servicePresent: Boolean(service), activeSecrets, activeConfigurations: service?.activeConfigurations };
  }
  /** Old blue/green configurations and desired-RUNNING tasks can still start with
   * the removed reference. A current revision alone does not prove retirement. */
  private async consumed(scope: Awaited<ReturnType<EcsRuntimeSecrets['scope']>>, removed: Target[]): Promise<boolean> {
    if (!removed.length) return false;
    const references = [...scope.activeSecrets];
    const definitions = new Set<string>();
    if (scope.servicePresent && (!Array.isArray(scope.activeConfigurations) || !scope.activeConfigurations.length || scope.activeConfigurations.length > 10)) throw new Error();
    for (const config of scope.activeConfigurations ?? []) {
      if (config.taskDefinitionArn) definitions.add(config.taskDefinitionArn);
      else if (config.primaryContainer?.image) references.push(...(config.primaryContainer.secrets ?? []).map(value => value.valueFrom ?? ''));
      else throw new Error();
    }
    const { ecs } = this.connected().clients;
    const serviceName = scope.executionReaderService.split('/').at(-1)!;
    const taskArns: string[] = []; const cursors = new Set<string>(); let nextToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const pageResult = await ecs.send(new ListTasksCommand({ cluster: scope.executionReaderCluster, ...(scope.servicePresent ? { serviceName } : {}), desiredStatus: 'RUNNING', maxResults: 100, nextToken }));
      if (!Array.isArray(pageResult.taskArns) || taskArns.length + pageResult.taskArns.length > 100) throw new Error();
      for (const arn of pageResult.taskArns) {
        if (!arn.startsWith(`arn:aws:ecs:${scope.region}:${scope.accountId}:task/`) || taskArns.includes(arn)) throw new Error();
        taskArns.push(arn);
      }
      if (!pageResult.nextToken) break;
      if (cursors.has(pageResult.nextToken) || page === 9) throw new Error();
      cursors.add(pageResult.nextToken); nextToken = pageResult.nextToken;
    }
    if (taskArns.length) {
      const result = await ecs.send(new DescribeTasksCommand({ cluster: scope.executionReaderCluster, tasks: taskArns }));
      if (!Array.isArray(result.tasks) || result.tasks.length !== taskArns.length || result.failures?.length) throw new Error();
      const seen = new Set<string>();
      for (const task of result.tasks) {
        if (!task.taskArn || !taskArns.includes(task.taskArn) || seen.has(task.taskArn) || task.clusterArn !== scope.executionReaderCluster
          || typeof task.group !== 'string' || !task.taskDefinitionArn) throw new Error();
        seen.add(task.taskArn);
        if (task.group === `service:${serviceName}`) definitions.add(task.taskDefinitionArn);
        else if (scope.servicePresent) throw new Error();
      }
    }
    if (definitions.size > 100) throw new Error();
    for (const arn of definitions) {
      if (!arn.startsWith(`arn:aws:ecs:${scope.region}:${scope.accountId}:task-definition/`) || !/:\d+$/.test(arn)) throw new Error();
      const task = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }))).taskDefinition;
      if (task?.taskDefinitionArn !== arn || !Array.isArray(task.containerDefinitions)) throw new Error();
      references.push(...task.containerDefinitions.flatMap(container => (container.secrets ?? []).map(value => value.valueFrom ?? '')));
    }
    return removed.some(target => references.some(reference => reference === target.arn || reference.startsWith(target.arn + ':')));
  }
  private async metadata(targets: Target[], scope: Awaited<ReturnType<EcsRuntimeSecrets['scope']>>) {
    const source = this.connected().clients.iam;
    const client = new SecretsManagerClient({ credentials: source.config.credentials, requestHandler: source.config.requestHandler, region: scope.region, maxAttempts: 1 });
    try {
      return await Promise.all(targets.map(async (target) => {
        if (!target.arn.startsWith(`arn:aws:secretsmanager:${scope.region}:${scope.accountId}:secret:`))
          throw new Error();
        const secret = await client.send(new DescribeSecretCommand({ SecretId: target.arn }));
        if (secret.ARN !== target.arn || secret.DeletedDate || !(secret.CreatedDate instanceof Date) || !Number.isFinite(secret.CreatedDate.getTime()) || target.createdAt && secret.CreatedDate.toISOString() !== target.createdAt)
          throw new Error();
        let next: string | undefined;
        let found;
        const seen = new Set<string>();
        for (let page = 0; page < 10; page++) {
          const versions = await client.send(new ListSecretVersionIdsCommand({ SecretId: target.arn, IncludeDeprecated: true, MaxResults: 100, NextToken: next }));
          if (versions.ARN !== target.arn || !Array.isArray(versions.Versions))
            throw new Error();
          for (const version of versions.Versions)
            if (version.VersionId === target.version) {
              if (found)
                throw new Error();
              found = version;
            }
          if (!versions.NextToken)
            break;
          if (seen.has(versions.NextToken) || page === 9)
            throw new Error();
          seen.add(versions.NextToken);
          next = versions.NextToken;
        }
        if (!found)
          throw new Error();
        const keyArns = [...new Set(found.KmsKeyIds ?? [])];
        if (secret.KmsKeyId && secret.KmsKeyId !== 'alias/aws/secretsmanager' && !keyArns.length)
          throw new Error();
        if (keyArns.some(key => !new RegExp(`^arn:aws:kms:${scope.region}:${scope.accountId}:key/[a-f0-9-]{36}$`).test(key)))
          throw new Error();
        return { ...target, createdAt: secret.CreatedDate.toISOString(), ...(keyArns.length ? { keyArns } : {}) };
      }));
    }
    finally { /* The client's shared request handler belongs to the connected adapter. */ }
  }
  private async readPolicy(scope: Awaited<ReturnType<EcsRuntimeSecrets['scope']>>) {
    try {
      const result = await this.connected().clients.iam.send(new GetRolePolicyCommand({ RoleName: scope.roleName, PolicyName: scope.executionReaderPolicyName }));
      if (result.RoleName !== scope.roleName || result.PolicyName !== scope.executionReaderPolicyName || !result.PolicyDocument)
        throw new Error();
      return JSON.parse(decodeURIComponent(result.PolicyDocument));
    }
    catch (error) {
      if (missing(error, ['NoSuchEntity', 'NoSuchEntityException']))
        return undefined;
      throw error;
    }
  }
  private coordinates(scope: Awaited<ReturnType<EcsRuntimeSecrets['scope']>>) { const { roleName: _r, region: _g, accountId: _a, servicePresent: _s, activeSecrets: _v, activeConfigurations: _c, ...coordinates } = scope; return coordinates; }
  private recovery(pending: NonNullable<RuntimeIdentityBinding['pending']>): RuntimeIdentityStep { return { operation: 'recover', target: { ...pending.step.target, recoverAttemptId: pending.attemptId }, description: 'Verify the exact recorded execution-role secret policy without resubmission.', requiresConfirm: false }; }
  async inspect(request: RuntimeIdentityRequest): Promise<RuntimeIdentityObservation | undefined> {
    if (!this.relevant(request))
      return undefined;
    try {
      const scope = await this.scope(request);
      const pending = request.binding?.pending;
      if (pending) {
        if (pending.step.target.phase !== phase)
          return undefined;
        const step = pending.step.operation === 'recover' ? pending.step : this.recovery(pending);
        return await this.recover(request, scope, step) ? { state: 'action', step } : { state: 'waiting', reason: 'The recorded execution-role secret policy is not yet independently verified; do not repeat it.' };
      }
      const previous = parse(request.binding?.evidence.executionReaderTargets);
      const wanted = desired(request);
      const targets = await this.metadata(wanted, scope);
      const current = await this.readPolicy(scope);
      const retained = request.binding?.evidence.executionReaderPolicy;
      if (retained && (!request.binding?.evidence.executionReaderAttemptId || retained !== canonical(policy(previous, request.binding.evidence.executionReaderAttemptId, scope.region))))
        throw new Error();
      if (current && (!retained || canonical(current) !== retained) || retained && !current)
        throw new Error();
      const removed = previous.filter(old => !targets.some(target => target.arn === old.arn));
      if (await this.consumed(scope, removed))
        return { state: 'waiting', reason: 'Remove the exact secret references from the consuming task before retiring their reader permissions.' };
      if (request.mode === 'destroy' && scope.servicePresent)
        return { state: 'waiting', reason: 'Remove the consuming service before its secret reader policy.' };
      if (same(previous, targets) && Boolean(current) === Boolean(targets.length))
        return undefined;
      const target = { phase, ...this.coordinates(scope), executionReaderTargets: encode(targets), previousPolicy: retained ?? 'absent' };
      return { state: 'action', step: { operation: 'attach', target, description: targets.length ? 'Give this ECS execution role access to the reviewed immutable secret references; preserve the application role and other policies.' : 'Remove only the recorded service secret-reader policy after its consumers are gone.', requiresConfirm: true } };
    }
    catch {
      return { state: 'unknown', reason: 'The exact execution role, immutable secret version or owned reader policy could not be verified.' };
    }
  }
  private async recover(request: RuntimeIdentityRequest, scope: Awaited<ReturnType<EcsRuntimeSecrets['scope']>>, step: RuntimeIdentityStep): Promise<RuntimeIdentityBinding | undefined> {
    const observedScope = await this.scope(request);
    if (!same(this.coordinates(scope), this.coordinates(observedScope)) || Object.entries(this.coordinates(observedScope)).some(([key, value]) => step.target[key] !== value) || !step.target.recoverAttemptId)
      throw new Error();
    const targets = parse(step.target.executionReaderTargets);
    const current = await this.readPolicy(scope);
    const expected = targets.length ? policy(targets, step.target.recoverAttemptId, scope.region) : undefined;
    if (canonical(current) !== canonical(expected))
      return undefined;
    const evidence: Record<string, string> = { ...request.binding?.evidence, ...this.coordinates(scope), executionReaderTargets: encode(targets) };
    if (expected) {
      evidence.executionReaderPolicy = canonical(expected);
      evidence.executionReaderAttemptId = step.target.recoverAttemptId;
    }
    else
      for (const key of Object.keys(evidence))
        if (key.startsWith('executionReader'))
          delete evidence[key];
    return { provider: 'ecs', evidence };
  }
  async apply(request: RuntimeIdentityRequest & {
    step: RuntimeIdentityStep;
    attemptId: string;
  }) {
    let mutationAttempted = false;
    try {
      const pending = request.binding?.pending;
      if (pending?.attemptId !== request.attemptId || !same(pending.step, request.step) || request.step.target.phase !== phase)
        throw new Error();
      const scope = await this.scope(request);
      if (request.step.operation === 'recover') {
        const binding = await this.recover(request, scope, request.step);
        if (!binding)
          throw new Error();
        return { receipt: { success: true, message: 'Verified the recorded execution-role reader policy.' }, binding: Object.keys(binding.evidence).length ? binding : undefined };
      }
      const fresh = await this.inspect({ ...request, binding: { provider: 'ecs', evidence: request.binding!.evidence } });
      if (fresh?.state !== 'action' || !same(fresh.step, request.step))
        throw new Error();
      const targets = parse(request.step.target.executionReaderTargets);
      const doc = targets.length ? canonical(policy(targets, request.attemptId, scope.region)) : undefined;
      if (doc && doc.length > 8192)
        throw new Error();
      // IAM has no etag/If-Match. A dedicated owned policy is reread immediately before
      // the single write, and exact attempt-tagged content is required for recovery.
      const recheck = await this.scope(request);
      const removed = parse(request.binding?.evidence.executionReaderTargets).filter(previous => !targets.some(target => target.arn === previous.arn));
      if (!same(this.coordinates(scope), this.coordinates(recheck)) || canonical(await this.readPolicy(scope)) !== (request.step.target.previousPolicy === 'absent' ? undefined : request.step.target.previousPolicy))
        throw new Error();
      if (await this.consumed(recheck, removed)) throw new Error();
      const client = new IAMClient({ credentials: this.connected().clients.iam.config.credentials, requestHandler: this.connected().clients.iam.config.requestHandler, region: scope.region, maxAttempts: 1 });
      mutationAttempted = true;
      if (doc)
        await client.send(new PutRolePolicyCommand({ RoleName: scope.roleName, PolicyName: scope.executionReaderPolicyName, PolicyDocument: doc }));
      else
        await client.send(new DeleteRolePolicyCommand({ RoleName: scope.roleName, PolicyName: scope.executionReaderPolicyName }));
      const binding = await this.recover(request, scope, { ...request.step, operation: 'recover', target: { ...request.step.target, recoverAttemptId: request.attemptId } });
      if (!binding)
        throw new Error();
      return { receipt: { success: true, message: 'Verified the exact execution-role secret reader policy.' }, binding: Object.keys(binding.evidence).length ? binding : undefined };
    }
    catch {
      return { receipt: { success: false, message: mutationAttempted ? 'Execution-role secret access remains pending for read-only recovery.' : 'Execution-role secret access preconditions changed; no write was attempted.', data: { mutationAttempted } } };
    }
  }
}
