import { azureBuildTaskContent } from '../adapters/providers/azure/azure-build-task.js';
import { azureCiRoleDefinitions } from '../adapters/providers/azure/azure-ci-roles.js';
import { projectAzureCiRegistry } from '../adapters/providers/azure/azure-ci-registry.js';
import type { CommandContext } from './context.js';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import type { OpenTofuEngine } from '../adapters/engine/opentofu/engine.js';
import type { AwsEngineContext } from './infrastructure-engine-aws.js';
import type { AzureEngineContext } from './infrastructure-engine-azure.js';
import { awsEngineBackend } from '../adapters/providers/aws/tofu/aws-engine.backend.js';
import { azureEngineBackend } from '../adapters/providers/azure/tofu/azure-engine.backend.js';
import { projectAwsWorkloadBindings } from '../adapters/providers/aws/aws-diagnostics.client.js';
import { projectAzureWorkloadBindings } from '../adapters/providers/azure/azure-diagnostics.client.js';
import { addAwsCiConfiguration } from '../adapters/providers/aws/tofu/aws-engine-ci.config.js';
import type { EngineConfiguration } from '../domain/ports/infrastructure-engine.port.js';
import { awsKey } from '../adapters/providers/aws/tofu/aws-engine.config.js';
import { azureKey, azureVaultSecretName } from '../adapters/providers/azure/tofu/azure-engine.config.js';
import { engineCiIntent, type EngineCiIntent } from '../domain/spec/engine-ci.js';
import { parseEngineCiBinding, type EngineCiBinding } from '../domain/spec/engine-ci-binding.js';
import { environmentDeploymentContractHashForApply } from '../domain/services/deployment-contract.service.js';
import { engineOutsideKeys, isBuildTokenKey, optionalOutsideKeys } from './engine-secrets.js';
import type { EngineWorkloadBinding } from '../domain/ports/workload-diagnostics.port.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => { if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) throw new Error('Incomplete native CI identity.'); return value; };
const match = (actual: unknown, expected: string): string => { if (actual !== expected) throw new Error('Native CI target differs from its reviewed scope.'); return expected; };

/** Only a single, managed, untainted resource at each exact engine address establishes ownership. */
function resources(state: unknown): (address: string) => Record<string, unknown> {
  const document = record(state); const root = record(record(document.values).root_module);
  if (typeof document.format_version !== 'string' || !Array.isArray(root.resources)) throw new Error('CI state is unavailable.');
  const rows = root.resources.map(record);
  return address => {
    const matches = rows.filter(row => row.address === address);
    if (matches.length !== 1 || matches[0]!.mode !== 'managed' || matches[0]!.type !== address.split('.')[0] || matches[0]!.tainted === true) throw new Error('CI resource ownership is missing or ambiguous.');
    return record(matches[0]!.values);
  };
}
function owned(value: Record<string, unknown>, environmentId: string, aws = false): void {
  const tags = record(aws ? value.tags_all : value.tags);
  match(tags['managed-by'], 'hypervibe'); match(tags['hv-environment'], environmentId.toLowerCase());
}
function complete(services: Record<string, EngineWorkloadBinding>, spec: ProjectSpec, name: string): void {
  const desired = Object.entries(spec.environments[name]!.services);
  if (!desired.length || Object.keys(services).length !== desired.length || new Set(Object.values(services).map(service => service.serviceId)).size !== desired.length
    || desired.some(([name, service]) => services[name]?.workloadKind !== (service.workloadKind ?? 'web'))) throw new Error('Not every declared workload has an exact native target yet.');
}

/** Clear before executing an admitted apply, including failures that produce no apply run. */
export function clearEngineCiBinding(ctx: CommandContext, environment: Environment): void {
  const current = ctx.repos.environments.findById(environment.id) ?? environment;
  if (current.platformBindings.engineCi !== null) ctx.repos.environments.updatePlatformBindings(current.id, { engineCi: null });
}

/** IAM treats statement order, action/resource order and singleton arrays equivalently. */
function normalizedPolicy(value: unknown, key = ''): string {
  if (['Action', 'NotAction', 'Resource', 'NotResource'].includes(key) && typeof value === 'string') value = [value];
  if (Array.isArray(value)) return `[${value.map(item => normalizedPolicy(item)).sort().join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => `${JSON.stringify(name)}:${normalizedPolicy(child, name)}`).join(',')}}`;
  return JSON.stringify(value);
}

type Params = { spec: ProjectSpec; environmentName: string; succeeded: boolean } & (
  { provider: 'aws'; context: AwsEngineContext } | { provider: 'azure'; context: AzureEngineContext; location: string }
);

function awsEnvironment(state: unknown, params: Extract<Params, { provider: 'aws' }>, intent: EngineCiIntent) {
  const { context, spec, environmentName } = params; const get = resources(state);
  const role = get('aws_iam_role.ci'); owned(role, context.environment.id, true);
  const roleName = `${context.prefix}-ci`;
  const roleArn = match(role.arn, `arn:aws:iam::${context.connection.accountId}:role/hypervibe/app/${roleName}`);
  match(role.id, roleName);
  match(role.permissions_boundary, `arn:aws:iam::${context.connection.accountId}:policy/hypervibe/hypervibe-app-boundary`);
  const trust = record(JSON.parse(text(role.assume_role_policy))); const statements = trust.Statement;
  if (!Array.isArray(statements) || statements.length !== 1) throw new Error('CI federation is ambiguous.');
  const statement = record(statements[0]); match(statement.Effect, 'Allow'); match(statement.Action, 'sts:AssumeRoleWithWebIdentity');
  match(record(statement.Principal).Federated, `arn:aws:iam::${context.connection.accountId}:oidc-provider/token.actions.githubusercontent.com`);
  const condition = record(record(statement.Condition).StringEquals);
  match(condition['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
  match(condition['token.actions.githubusercontent.com:sub'], `repo:${intent.repository}:ref:refs/heads/${intent.branch}`);
  const policy = get('aws_iam_role_policy.ci'); match(policy.role, roleName); text(policy.id); JSON.parse(text(policy.policy));
  for (const [name, service] of Object.entries(spec.environments[environmentName]!.services)) {
    const kind = service.workloadKind ?? 'web';
    owned(get(`${kind === 'web' ? 'aws_lambda_function' : kind === 'worker' ? 'aws_ecs_service' : 'aws_ecs_task_definition'}.${awsKey(name)}`), context.environment.id, true);
    if (kind !== 'web') { owned(get(`aws_ecs_task_definition.${awsKey(name)}`), context.environment.id, true); owned(get('aws_ecs_cluster.main'), context.environment.id, true); }
  }
  const services = projectAwsWorkloadBindings(state, spec.environments[environmentName]!.services, context.connection);
  complete(services, spec, environmentName);
  const files: EngineConfiguration['files'] = {};
  const workloads = Object.entries(services).map(([name, service]) => ({ logicalName: name,
    resourceName: service.workloadKind === 'web' ? service.serviceId.split(':').at(-1)! : text(service.taskDefinitionArn).split('/').at(-1)!.split(':')[0]!, initialImageUri: '', public: spec.environments[environmentName]!.services[name]!.public ?? false, workloadKind: service.workloadKind }));
  addAwsCiConfiguration({ ci: intent, accountId: context.connection.accountId, region: context.connection.region, prefix: context.prefix,
    environmentId: context.environment.id, parameterPath: context.parameterPath,
    services: workloads.filter(service => service.workloadKind === 'web'), workers: workloads.filter(service => service.workloadKind === 'worker'),
    jobs: workloads.filter(service => service.workloadKind === 'cron').map(service => ({ ...service, schedule: '' })) }, files, {});
  const expected = record(record(record(record(files['ci.tf.json']).resource).aws_iam_role_policy).ci).policy;
  match(normalizedPolicy(JSON.parse(text(policy.policy))), normalizedPolicy(JSON.parse(text(expected))));
  return { services, roleArn };
}
function awsBuild(state: unknown, params: Extract<Params, { provider: 'aws' }>) {
  const { context, spec, environmentName } = params; const get = resources(state); const { accountId, region } = context.connection;
  const repository = get('aws_ecr_repository.images'); const project = get('aws_codebuild_project.images'); const bucket = get('aws_s3_bucket.build_source'); const role = get('aws_iam_role.build');
  for (const resource of [repository, project, bucket, role]) owned(resource, context.environment.id, true);
  match(repository.arn, `arn:aws:ecr:${region}:${accountId}:repository/${context.prefix}`);
  const repositoryUrl = match(repository.repository_url, `${accountId}.dkr.ecr.${region}.amazonaws.com/${context.prefix}`);
  const buildProjectArn = match(project.arn, `arn:aws:codebuild:${region}:${accountId}:project/${context.prefix}-images`);
  const sourceBucket = text(bucket.id); match(bucket.arn, `arn:aws:s3:::${sourceBucket}`); match(sourceBucket, `${context.prefix}-build-${accountId}`);
  match(role.id, `${context.prefix}-build`); const buildRole = match(role.arn, `arn:aws:iam::${accountId}:role/hypervibe/app/${context.prefix}-build`); match(project.service_role, buildRole);
  const policy = get('aws_iam_role_policy.build'); match(policy.role, role.id as string); text(policy.id);
  const statements = record(JSON.parse(text(policy.policy))).Statement;
  if (!Array.isArray(statements)) throw new Error('Build permissions are unknown.');
  const tokens = statements.map(record).filter(statement => statement.Sid === 'PackageToken');
  if (tokens.length > 1) throw new Error('Package credential scope is ambiguous.');
  let packageParameter: string | undefined;
  if (tokens[0]) {
    match(tokens[0].Effect, 'Allow'); match(tokens[0].Action, 'ssm:GetParameters');
    const arn = text(tokens[0].Resource); const prefix = `arn:aws:ssm:${region}:${accountId}:parameter/hypervibe/${context.environment.id.toLowerCase()}/`;
    if (!arn.startsWith(prefix) || !isBuildTokenKey(arn.slice(prefix.length)) || !engineOutsideKeys(spec, environmentName).includes(arn.slice(prefix.length))) throw new Error('Package credential does not belong to this environment intent.');
    packageParameter = arn.slice(`arn:aws:ssm:${region}:${accountId}:parameter`.length);
  }
  if (!packageParameter && engineOutsideKeys(spec, environmentName).some(key => isBuildTokenKey(key) && !optionalOutsideKeys(spec, environmentName).includes(key))) throw new Error('Required package access is not applied.');
  return { accountId, buildProjectArn, sourceBucket, repositoryUrl, ...(packageParameter ? { packageParameter } : {}) };
}
function azureEnvironment(state: unknown, params: Extract<Params, { provider: 'azure' }>, intent: EngineCiIntent) {
  const { context, spec, environmentName } = params; const get = resources(state); const { subscriptionId, resourceGroup, tenantId } = context.connection;
  const group = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  const identity = get('azurerm_user_assigned_identity.ci'); owned(identity, context.environment.id);
  const identityId = match(identity.id, `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${context.prefix}-ci`);
  match(identity.tenant_id, tenantId); match(identity.location, params.location);
  const clientId = text(identity.client_id); const principalId = text(identity.principal_id);
  const federation = get('azurerm_federated_identity_credential.ci');
  match(federation.id, `${identityId}/federatedIdentityCredentials/github-release`); match(federation.user_assigned_identity_id, identityId);
  match(federation.issuer, 'https://token.actions.githubusercontent.com'); match(federation.subject, `repo:${intent.repository}:ref:refs/heads/${intent.branch}`);
  if (!Array.isArray(federation.audience) || federation.audience.length !== 1 || federation.audience[0] !== 'api://AzureADTokenExchange') throw new Error('Azure CI audience is not exact.');
  const roles = azureCiRoleDefinitions(subscriptionId, resourceGroup); const roleId = roles.release.id;
  const managedEnvironment = get('azurerm_container_app_environment.main'); owned(managedEnvironment, context.environment.id); match(managedEnvironment.location, params.location);
  match(managedEnvironment.id, `${group}/providers/Microsoft.App/managedEnvironments/${context.prefix}-apps`);
  for (const [name, service] of Object.entries(spec.environments[environmentName]!.services)) {
    const job = service.workloadKind === 'cron'; const workload = get(`${job ? 'azurerm_container_app_job' : 'azurerm_container_app'}.${azureKey(name)}`); owned(workload, context.environment.id);
    match(workload.container_app_environment_id, text(managedEnvironment.id));
    const grant = get(`azurerm_role_assignment.ci_${job ? 'job_' : ''}${azureKey(name)}`);
    text(grant.id); match(grant.scope, text(workload.id)); match(grant.principal_id, principalId); match(grant.role_definition_id, roleId);
  }
  const buildGrant = get('azurerm_role_assignment.ci_build'); text(buildGrant.id); match(buildGrant.principal_id, principalId); match(buildGrant.role_definition_id, roles.build.id);
  const services = projectAzureWorkloadBindings(state, spec.environments[environmentName]!.services, { subscriptionId, resourceGroup, location: params.location });
  complete(services, spec, environmentName);
  return { services, tenantId, clientId, subscriptionId, resourceGroup, buildScope: text(buildGrant.scope) };
}
function azureBuild(state: unknown, params: Extract<Params, { provider: 'azure' }>) {
  const { context, spec, environmentName } = params; const get = resources(state);
  const registry = get('azurerm_container_registry.ci_images'); owned(registry, context.environment.id); match(registry.location, params.location);
  const projected = projectAzureCiRegistry(state, { subscriptionId: context.connection.subscriptionId, resourceGroup: context.connection.resourceGroup, environmentId: context.environment.id });
  const registryId = projected.id; const name = text(registry.name);
  match(registryId, `/subscriptions/${context.connection.subscriptionId}/resourceGroups/${context.connection.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${name}`);
  const registryLoginServer = match(registry.login_server, `${name}.azurecr.io`);
  const task = get('azurerm_container_registry_task.images'); owned(task, context.environment.id); match(task.container_registry_id, registryId);
  const buildTaskId = match(task.id, `${registryId}/tasks/${context.prefix}-images`);
  const principal = Array.isArray(task.identity) && task.identity.length === 1 && record(task.identity[0]).type === 'SystemAssigned' ? text(record(task.identity[0]).principal_id) : undefined;
  if (!principal) throw new Error('The build task identity is unknown.');
  const tokenKeys = engineOutsideKeys(spec, environmentName).filter(isBuildTokenKey);
  const rows = record(record(record(state).values).root_module).resources as unknown[];
  const hasGrant = rows.some(row => record(row).address === 'azurerm_role_assignment.build_token');
  let secretUrl: string | undefined;
  if (hasGrant) {
    const grant = get('azurerm_role_assignment.build_token'); text(grant.id); match(grant.principal_id, principal);
    const scope = text(grant.scope);
    const key = tokenKeys.find(key => scope === `${context.vault.id}/secrets/${azureVaultSecretName(environmentName, key)}`);
    if (!key) throw new Error('The build task credential scope is not an environment-owned declared package token.');
    match(grant.role_definition_id, `/subscriptions/${context.connection.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`);
    secretUrl = `${context.vault.uri}secrets/${azureVaultSecretName(environmentName, key)}`;
  } else if (tokenKeys.some(key => !optionalOutsideKeys(spec, environmentName).includes(key))) throw new Error('The required package build credential is absent.');
  if (!Array.isArray(task.encoded_step) || task.encoded_step.length !== 1) throw new Error('The native build task is ambiguous.');
  const encoded = text(record(task.encoded_step[0]).task_content);
  match(Buffer.from(encoded, 'base64').toString('utf8'), azureBuildTaskContent(secretUrl));
  return { registryId, registryLoginServer, buildTaskId };
}

/** A complete reviewed apply (including noop) grants CI readiness only from exact private-state evidence. */
export async function recordEngineCiBindings(ctx: CommandContext, engine: Pick<OpenTofuEngine, 'inspectState'>, params: Params): Promise<{ ready: boolean }> {
  const { context, spec, environmentName } = params;
  clearEngineCiBinding(ctx, context.environment);
  if (!params.succeeded) return { ready: false };
  try {
    const intent = engineCiIntent(spec, environmentName); if (!intent) return { ready: false };
    const common = { version: 1, provider: params.provider, repository: intent.repository, branch: intent.branch, environmentName,
      environmentId: context.environment.id, appliedContractHash: environmentDeploymentContractHashForApply(spec, environmentName), prefix: context.prefix };
    let binding: EngineCiBinding;
    if (params.provider === 'aws') {
      const observed = await engine.inspectState({ backend: awsEngineBackend, auth: context.auth, state: context.state, configuration: { files: {}, resources: {} }, project: state => awsEnvironment(state, params, intent) });
      if (!observed.ok || !observed.present) return { ready: false };
      const build = await engine.inspectState({ backend: awsEngineBackend, auth: context.auth, state: context.buildState, configuration: { files: {}, resources: {} }, project: state => awsBuild(state, params) });
      if (!build.ok || !build.present) return { ready: false };
      binding = parseEngineCiBinding({ ...common, region: params.context.connection.region, services: observed.value.services, aws: { ...build.value, roleArn: observed.value.roleArn } });
    } else {
      const observed = await engine.inspectState({ backend: azureEngineBackend, auth: context.auth, state: context.state, configuration: { files: {}, resources: {} }, project: state => azureEnvironment(state, params, intent) });
      if (!observed.ok || !observed.present) return { ready: false };
      const build = await engine.inspectState({ backend: azureEngineBackend, auth: context.auth, state: context.buildState, configuration: { files: {}, resources: {} }, project: state => azureBuild(state, params) });
      if (!build.ok || !build.present || observed.value.buildScope !== build.value.registryId) return { ready: false };
      binding = parseEngineCiBinding({ ...common, region: params.location, services: observed.value.services, azure: { tenantId: observed.value.tenantId,
        clientId: observed.value.clientId, subscriptionId: observed.value.subscriptionId, resourceGroup: observed.value.resourceGroup, ...build.value } });
    }
    ctx.repos.environments.updatePlatformBindings(context.environment.id, { engineCi: binding });
    return { ready: true };
  } catch { return { ready: false }; } // Raw state/provider errors may contain secrets; an unknown marker stays cleared.
}
