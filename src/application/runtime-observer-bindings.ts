import type { CommandContext } from './context.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import { observerSubjects, runtimeObservationIntent, runtimeObserverSchema } from '../domain/spec/runtime-observation.js';
import { managedCiResources, normalizedPolicy } from './engine-ci-bindings.js';
import { awsObserverPolicies } from '../adapters/providers/aws/tofu/aws-observer.config.js';
import { azureObserverLogCondition, OBSERVER_ARM_READER, OBSERVER_LOG_READER } from '../adapters/providers/azure/tofu/azure-observer.config.js';
import { azureKey } from '../adapters/providers/azure/tofu/azure-engine.config.js';
import { awsKey } from '../adapters/providers/aws/tofu/aws-engine.config.js';
import { awsEngineBackend } from '../adapters/providers/aws/tofu/aws-engine.backend.js';
import { azureEngineBackend } from '../adapters/providers/azure/tofu/azure-engine.backend.js';
import type { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import type { AwsEngineContext } from './infrastructure-engine-aws.js';
import type { AzureEngineContext } from './infrastructure-engine-azure.js';
import { projectAwsWorkloadBindings } from '../adapters/providers/aws/aws-diagnostics.client.js';
import { projectAzureWorkloadBindings, projectAzureSharedApps } from '../adapters/providers/azure/azure-diagnostics.client.js';

function requireEqual(value: unknown, expected: unknown) {
  if (value !== expected || expected === undefined) throw new Error('Observer state differs from its reviewed cloud scope.');
}
function tagged(resource: Record<string, unknown>, id: string, key: string) {
  const tags = resource[key] as Record<string, unknown> | undefined;
  requireEqual(tags?.['managed-by'], 'hypervibe'); requireEqual(tags?.['hv-environment'], id.toLowerCase());
}
type Scope = { provider: 'aws'; context: AwsEngineContext } | { provider: 'azure'; context: AzureEngineContext; region: string };
type Inputs = { spec: ProjectSpec; environmentName: string } & Scope;

export function projectRuntimeObserverState(state: unknown, input: Inputs, shared?: { managedEnvironmentId?: string; workspaceId?: string }) {
  const intent = runtimeObservationIntent(input.spec, input.environmentName);
  if (!intent) throw new Error('Scheduled runtime observation was not requested.');
  if (!input.context.observerRepository) throw new Error('The reviewed observer repository identity is missing.');
  const federation = { ...intent, ...input.context.observerRepository };
  const env = input.spec.environments[input.environmentName]!;
  const common = { version: 1, environmentId: input.context.environment.id, environmentName: intent.environmentName, repository: intent.repository, branch: intent.branch };
  const get = managedCiResources(state);
  if (input.provider === 'aws') {
    const { prefix, connection } = input.context;
    const { region, accountId } = connection;
    const policies = awsObserverPolicies({ prefix, region, accountId }, federation);
    const role = get('aws_iam_role.observer');
    const roleName = prefix + '-observer';
    const roleArn = 'arn:aws:iam::' + accountId + ':role/hypervibe/app/' + roleName;
    tagged(role, common.environmentId, 'tags_all'); requireEqual(role.arn, roleArn); requireEqual(role.id, roleName);
    requireEqual(role.permissions_boundary, 'arn:aws:iam::' + accountId + ':policy/hypervibe/hypervibe-app-boundary');
    requireEqual(normalizedPolicy(JSON.parse(String(role.assume_role_policy))), normalizedPolicy(policies.trust));
    const policy = get('aws_iam_role_policy.observer');
    requireEqual(policy.role, roleName); requireEqual(policy.name, 'observe');
    requireEqual(normalizedPolicy(JSON.parse(String(policy.policy))), normalizedPolicy(policies.policy));
    const services = projectAwsWorkloadBindings(state, env.services, { accountId, region });
    for (const name of Object.keys(env.services)) {
      const w = services[name];
      if (!w?.logStreamPrefix || !w.logGroup || !w.clusterArn) throw new Error('Incomplete ECS observer binding.');
      const address = w.resourceType === 'ecs-express' ? 'aws_ecs_express_gateway_service' : w.resourceType === 'ecs-task' ? 'aws_ecs_task_definition' : 'aws_ecs_service';
      tagged(get(address + '.' + awsKey(name)), common.environmentId, 'tags_all');
    }
    return runtimeObserverSchema.parse({ ...common, provider: 'aws', aws: { prefix, accountId, region, roleArn }, services });
  }
  const { connection, prefix } = input.context;
  const { tenantId, subscriptionId, resourceGroup } = connection;
  const group = '/subscriptions/' + subscriptionId + '/resourceGroups/' + resourceGroup;
  const identity = get('azurerm_user_assigned_identity.observer');
  const identityId = group + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + prefix + '-observer';
  tagged(identity, common.environmentId, 'tags'); requireEqual(identity.id, identityId); requireEqual(identity.tenant_id, tenantId);
  if (typeof identity.principal_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(identity.principal_id)) throw new Error('Missing observer principal.');
  for (const [kind, subject] of Object.entries(observerSubjects(federation))) {
    const fed = get('azurerm_federated_identity_credential.' + (kind === 'legacy' ? 'observer' : 'observer_immutable'));
    requireEqual(fed.user_assigned_identity_id, identityId); requireEqual(fed.name, kind === 'legacy' ? 'github-observe' : 'github-observe-immutable');
    requireEqual(fed.issuer, 'https://token.actions.githubusercontent.com'); requireEqual(JSON.stringify(fed.audience), '["api://AzureADTokenExchange"]');
    requireEqual(fed.subject, subject);
  }
  requireEqual(shared?.managedEnvironmentId, input.context.shared.appsEnvironmentId);
  if (!shared?.workspaceId) throw new Error('Missing applied observer workspace.');
  const services = projectAzureWorkloadBindings(state, env.services, { subscriptionId, resourceGroup, location: input.region }, shared);
  const verify = (name: string, scope: string, role: string, condition?: string) => {
    const assignment = get('azurerm_role_assignment.observer_' + name);
    requireEqual(assignment.scope, scope); requireEqual(assignment.principal_id, identity.principal_id);
    requireEqual(assignment.role_definition_id, '/subscriptions/' + subscriptionId + '/providers/Microsoft.Authorization/roleDefinitions/' + role);
    if ((assignment.condition || undefined) !== condition || condition && assignment.condition_version !== '2.0') throw new Error('Azure observer role scope differs.');
  };
  verify('environment', shared.managedEnvironmentId!, OBSERVER_ARM_READER);
  const apps: string[] = []; const jobs: string[] = [];
  for (const name of Object.keys(env.services)) {
    const service = services[name]; if (!service?.workspaceId || !service.managedEnvironmentId) throw new Error('Missing applied Azure workload.');
    const job = service.workloadKind === 'cron';
    tagged(get((job ? 'azurerm_container_app_job.' : 'azurerm_container_app.') + azureKey(name)), common.environmentId, 'tags');
    verify('app_' + azureKey(name), service.serviceId, OBSERVER_ARM_READER);
    (job ? jobs : apps).push(service.serviceId.split('/').at(-1)!);
  }
  verify('logs', group + '/providers/Microsoft.OperationalInsights/workspaces/' + input.context.shared.prefix + '-logs', OBSERVER_LOG_READER,
    azureObserverLogCondition(apps, jobs));
  return runtimeObserverSchema.parse({ ...common, provider: 'azure', azure: { tenantId, subscriptionId, resourceGroup, clientId: identity.client_id }, services });
}

type ObserverProvider = 'aws' | 'azure';

export function previousRuntimeObserverServices(platform: Environment['platformBindings'] | undefined, provider: ObserverProvider): string[] | undefined {
  const binding = runtimeObserverSchema.safeParse(platform?.runtimeObserver);
  const applied = binding.success && binding.data.provider === provider ? Object.keys(binding.data.services) : undefined;
  const pending = platform?.runtimeObserverCleanup as { provider?: unknown; services?: unknown } | undefined;
  const attempted = pending?.provider === provider && Array.isArray(pending.services) && pending.services.every(name => typeof name === 'string')
    ? pending.services as string[] : undefined;
  return applied || attempted ? [...new Set([...(applied ?? []), ...(attempted ?? [])])] : undefined;
}

/** Preserve removal mappings before a managed apply can leave partially created resources. */
export function beginRuntimeObserverApply(ctx: CommandContext, environment: Environment, provider: ObserverProvider, services?: string[]): void {
  const previous = previousRuntimeObserverServices(environment.platformBindings, provider);
  if (!services && !previous) return;
  ctx.repos.environments.updatePlatformBindings(environment.id, { runtimeObserver: null,
    runtimeObserverCleanup: { provider, services: [...new Set([...(previous ?? []), ...(services ?? [])])] } });
}

export function clearRuntimeObserver(ctx: CommandContext, environment: Environment) {
  const current = ctx.repos.environments.findById(environment.id) ?? environment;
  if (current.platformBindings.runtimeObserver || current.platformBindings.runtimeObserverCleanup) {
    ctx.repos.environments.updatePlatformBindings(current.id, { runtimeObserver: null, runtimeObserverCleanup: null });
  }
}

export async function recordRuntimeObserver(ctx: CommandContext, engine: Pick<OpenTofuEngine, 'inspectState'>, input: Inputs) {
  if (!runtimeObservationIntent(input.spec, input.environmentName)) return;
  const common = { auth: input.context.auth, configuration: { files: {}, resources: {} } };
  let shared: ReturnType<typeof projectAzureSharedApps> | undefined;
  if (input.provider === 'azure') {
    const { shared: placement, connection } = input.context;
    const workspaceResourceId = `/subscriptions/${connection.subscriptionId}/resourceGroups/${connection.resourceGroup}/providers/Microsoft.OperationalInsights/workspaces/${placement.prefix}-logs`;
    const read = await engine.inspectState({ ...common, backend: azureEngineBackend, state: placement.state, project: state => {
      const get = managedCiResources(state);
      const env = get('azurerm_container_app_environment.main'); const workspace = get('azurerm_log_analytics_workspace.logs');
      for (const resource of [env, workspace]) {
        const tags = resource.tags as Record<string, unknown> | undefined;
        requireEqual(tags?.['managed-by'], 'hypervibe'); requireEqual(tags?.['hv-shared'], placement.label);
      }
      requireEqual(workspace.id, workspaceResourceId); requireEqual(env.log_analytics_workspace_id, workspaceResourceId);
      requireEqual(env.id, placement.appsEnvironmentId);
      return projectAzureSharedApps(state);
    } });
    if (read.ok && read.present) shared = read.value;
  }
  const observed = await engine.inspectState({ ...common, backend: input.provider === 'aws' ? awsEngineBackend : azureEngineBackend,
    state: input.context.state, project: state => projectRuntimeObserverState(state, input, shared) });
  if (!observed.ok || !observed.present) throw new Error('The applied observer access and workload identities could not be verified. Reconcile the environment with hv_plan and hv_apply before enabling its scheduled workflow.');
  ctx.repos.environments.updatePlatformBindings(input.context.environment.id, { runtimeObserver: observed.value, runtimeObserverCleanup: null });
}
