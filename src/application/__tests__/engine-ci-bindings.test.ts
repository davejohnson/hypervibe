import { azureBuildTaskContent } from '../../adapters/providers/azure/azure-build-task.js';
import { azureVaultSecretName } from '../../adapters/providers/azure/tofu/azure-engine.config.js';
import { azureCiRegistry } from '../../adapters/providers/azure/azure-ci-registry.js';
import { azureCiRoleDefinitions } from '../../adapters/providers/azure/azure-ci-roles.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import { createCommandContext } from '../context.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { ConvergeExecutor } from '../../domain/plan/converge.executor.js';
import { applyAwsInfrastructureEngine, resolveAwsEngineContext } from '../infrastructure-engine-aws.js';
import { applyAzureInfrastructureEngine, resolveAzureEngineContext } from '../infrastructure-engine-azure.js';
import * as shared from '../engine-shared.js';
import * as awsBackend from '../../adapters/providers/aws/tofu/aws-engine.backend.js';
import { environmentDeploymentContractHashForApply } from '../../domain/services/deployment-contract.service.js';
import { parseEngineCiBinding } from '../../domain/spec/engine-ci-binding.js';

const accountId = '111122223333'; const region = 'us-west-2';
const subscriptionId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const resource = (address: string, values: Record<string, unknown>) => ({ address, mode: 'managed', type: address.split('.')[0], values });
const state = (resources: ReturnType<typeof resource>[]) => ({ format_version: '1.0', values: { root_module: { resources } } });
let directory: string;
beforeEach(() => {
  SqliteAdapter.resetInstance(); directory = mkdtempSync(path.join(tmpdir(), 'hv-engine-ci-binding-'));
  SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '1');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No live cloud calls in CI binding tests.'); }));
  vi.spyOn(awsBackend, 'awsEngineAuthentication').mockResolvedValue({ env: { AWS_ACCESS_KEY_ID: 'private-key', AWS_SECRET_ACCESS_KEY: 'private-secret', AWS_SESSION_TOKEN: 'private-session' }, redact: ['private-secret'] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
async function fixture(provider: 'aws' | 'azure') {
  const ctx = createCommandContext(); const project = ctx.repos.projects.create({ name: 'ci-app', gitRemoteUrl: 'https://github.com/owner/app.git', defaultPlatform: provider });
  const env = ctx.repos.environments.create({ projectId: project.id, name: 'test', platformBindings: { engineCi: { stale: 'private-old-marker' } } });
  const credentials = provider === 'aws' ? { accountId, region, accessKeyId: 'LOCALACCESSKEY1234', secretAccessKey: 'private-local-secret-value-32-characters', roleArn: `arn:aws:iam::${accountId}:role/hypervibe/hypervibe-deploy` }
    : { tenantId: subscriptionId, subscriptionId, clientId, deployPrincipalId: principalId, clientSecret: 'private-client-secret-32-characters', clientSecretExpiresAt: '2099-01-01T00:00:00Z', resourceGroup: 'hv-ci-app', location: 'westus2' };
  const connection = ctx.repos.connections.create({ provider, credentialsEncrypted: getSecretStore().encryptObject(credentials), scope: 'owner/app' }); ctx.repos.connections.updateStatus(connection.id, 'verified');
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl, environments: { test: { hosting: { provider, engine: 'opentofu' }, services: { web: { public: true } }, deploy: { strategy: 'branch', branch: 'main' } } } });
  const context = await (provider === 'aws' ? resolveAwsEngineContext : resolveAzureEngineContext)(ctx, project, env.name);
  if ('blocked' in context) throw new Error(context.blocked);
  const prefix = context.prefix; const tags = { 'managed-by': 'hypervibe', 'hv-environment': env.id.toLowerCase() };
  const group = `/subscriptions/${subscriptionId}/resourceGroups/hv-ci-app`;
  const roleArn = `arn:aws:iam::${accountId}:role/hypervibe/app/${prefix}-ci`;
  const registry = azureCiRegistry({ subscriptionId, resourceGroup: 'hv-ci-app', environmentId: env.id }); const registryId = registry.id;
  const roleDefinition = azureCiRoleDefinitions(subscriptionId, 'hv-ci-app').release.id;
  let environmentState = provider === 'aws' ? state([
    resource('aws_iam_role.ci', { id: `${prefix}-ci`, arn: roleArn, permissions_boundary: `arn:aws:iam::${accountId}:policy/hypervibe/hypervibe-app-boundary`, tags_all: tags, assume_role_policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity', Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com` }, Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:owner/app:ref:refs/heads/main' } } }] }) }),
    resource('aws_iam_role_policy.ci', { id: `${prefix}-ci:release`, role: `${prefix}-ci`, policy: JSON.stringify({ Version: '2012-10-17', Statement: [
      { Sid: 'BuildImage', Effect: 'Allow', Action: ['codebuild:BatchGetProjects', 'codebuild:StartBuild', 'codebuild:BatchGetBuilds'], Resource: [`arn:aws:codebuild:${region}:${accountId}:project/${prefix}-images`] },
      { Sid: 'UploadSource', Effect: 'Allow', Action: ['s3:PutObject'], Resource: `arn:aws:s3:::${prefix}-build-${accountId}/sources/*` },
      { Sid: 'ReadImages', Effect: 'Allow', Action: ['ecr:DescribeImages'], Resource: `arn:aws:ecr:${region}:${accountId}:repository/${prefix}` },
      { Sid: 'ReleaseWeb', Effect: 'Allow', Action: ['ecs:DescribeExpressGatewayService', 'ecs:UpdateExpressGatewayService'], Resource: [`arn:aws:ecs:${region}:${accountId}:service/${prefix}/${prefix}-web`] },
      { Sid: 'ReadWebRollout', Effect: 'Allow', Action: ['ecs:DescribeServiceDeployments'], Resource: [`arn:aws:ecs:${region}:${accountId}:service-deployment/${prefix}/${prefix}-web/*`] },
      { Sid: 'PassRuntimeRole', Effect: 'Allow', Action: ['iam:PassRole'], Resource: `arn:aws:iam::${accountId}:role/hypervibe/app/${prefix}-runtime`, Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } },
    ] }) }),
    resource('aws_ecs_express_gateway_service.web', { service_arn: `arn:aws:ecs:${region}:${accountId}:service/${prefix}/${prefix}-web`, tags_all: tags,
      primary_container: [{ aws_logs_configuration: [{ log_group: `/hypervibe/${prefix}/tasks`, log_stream_prefix: `${prefix}-web` }] }], ingress_paths: [{ access_type: 'PUBLIC', endpoint: `${prefix}-web.ecs.${region}.on.aws` }] }),
  ]) : state([
    resource('azurerm_user_assigned_identity.ci', { id: `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${prefix}-ci`, client_id: clientId, principal_id: principalId, tenant_id: subscriptionId, location: 'westus2', tags }),
    resource('azurerm_federated_identity_credential.ci', { id: `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${prefix}-ci/federatedIdentityCredentials/github-release`, user_assigned_identity_id: `${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${prefix}-ci`, issuer: 'https://token.actions.githubusercontent.com', audience: ['api://AzureADTokenExchange'], subject: 'repo:owner/app:ref:refs/heads/main' }),
    resource('azurerm_container_app.web', { id: `${group}/providers/Microsoft.App/containerApps/${prefix}-web`, tags, location: 'westus2', container_app_environment_id: `${group}/providers/Microsoft.App/managedEnvironments/${prefix}-apps` }),
    resource('azurerm_container_app_environment.main', { id: `${group}/providers/Microsoft.App/managedEnvironments/${prefix}-apps`, location: 'westus2', tags }),
    resource('azurerm_role_assignment.ci_web', { id: `${group}/providers/Microsoft.Authorization/roleAssignments/ci-web`, scope: `${group}/providers/Microsoft.App/containerApps/${prefix}-web`, principal_id: principalId, role_definition_id: roleDefinition }),
    resource('azurerm_role_assignment.ci_build', { id: `${group}/providers/Microsoft.Authorization/roleAssignments/ci-build`, scope: registryId, principal_id: principalId, role_definition_id: azureCiRoleDefinitions(subscriptionId, 'hv-ci-app').build.id }),
  ]);
  let buildState = provider === 'aws' ? state([
    resource('aws_ecr_repository.images', { arn: `arn:aws:ecr:${region}:${accountId}:repository/${prefix}`, repository_url: `${accountId}.dkr.ecr.${region}.amazonaws.com/${prefix}`, tags_all: tags }),
    resource('aws_codebuild_project.images', { arn: `arn:aws:codebuild:${region}:${accountId}:project/${prefix}-images`, service_role: `arn:aws:iam::${accountId}:role/hypervibe/app/${prefix}-build`, tags_all: tags }),
    resource('aws_s3_bucket.build_source', { id: `${prefix}-build-${accountId}`, arn: `arn:aws:s3:::${prefix}-build-${accountId}`, tags_all: tags }),
    resource('aws_iam_role.build', { arn: `arn:aws:iam::${accountId}:role/hypervibe/app/${prefix}-build`, id: `${prefix}-build`, tags_all: tags }),
    resource('aws_iam_role_policy.build', { id: `${prefix}-build:build`, role: `${prefix}-build`, policy: JSON.stringify({ Statement: [] }) }),
  ]) : state([resource('azurerm_container_registry.ci_images', { id: registryId, name: registry.name, login_server: registry.loginServer, location: 'westus2', tags }),
    resource('azurerm_container_registry_task.images', { id: `${registryId}/tasks/${prefix}-images`, container_registry_id: registryId, tags, identity: [{ type: 'SystemAssigned', principal_id: principalId }], encoded_step: [{ task_content: Buffer.from(azureBuildTaskContent()).toString('base64') }] }),
  ]);
  let nativeMissing = false;
  const inspectState = vi.fn(async (request: any) => nativeMissing ? { ok: true, present: false } : { ok: true, present: true, value: request.project(request.state.environmentId === `${env.id}-build` ? buildState : environmentState) });
  vi.spyOn(shared, 'openTofuEngine').mockResolvedValue({ inspectState } as never);
  const document = { environmentName: env.name, specRevision: 1, engine: { planId: 'native-plan', state: context.state, build: { planId: 'native-build', state: context.buildState }, [provider]: provider === 'aws' ? { accountId, region, prefix } : { subscriptionId, resourceGroup: 'hv-ci-app', prefix } } };
  vi.spyOn(ConvergeExecutor.prototype, 'loadPlan').mockReturnValue({ run: {}, document } as never);
  const execute = vi.spyOn(ConvergeExecutor.prototype, 'execute').mockResolvedValue({ success: true, applyRunId: 'accepted-apply', receipts: [] });
  const apply = () => (provider === 'aws' ? applyAwsInfrastructureEngine : applyAzureInfrastructureEngine)(ctx, { project, spec, specRevision: 1, planId: 'plan', confirmActions: [] });
  return { ctx, project, env, spec, prefix, context, execute, document, inspectState, apply,
    binding: () => ctx.repos.environments.findById(env.id)!.platformBindings.engineCi,
    missing: () => { nativeMissing = true; },
    environmentState, buildState,
  };
}
describe.each(['aws', 'azure'] as const)('%s CI binding publication through reviewed apply', provider => {
  it('publishes only exact native public identities after complete apply and successful noop', async () => {
    const f = await fixture(provider); await f.apply();
    const binding = parseEngineCiBinding(f.binding());
    expect(binding).toMatchObject({ provider, environmentId: f.env.id, environmentName: 'test', repository: 'owner/app', branch: 'main', appliedContractHash: environmentDeploymentContractHashForApply(f.spec, 'test') });
    expect(binding.services.web?.serviceId).toContain(`${f.prefix}-web`);
    expect(JSON.stringify(binding)).not.toContain('private-');
    f.execute.mockResolvedValue({ success: true, applyRunId: 'noop-apply', receipts: [{ actionId: 'native', status: 'skipped_noop' }] });
    await f.apply(); expect(f.binding()).toEqual(binding);
  });
  it.each(['partial', 'pending', 'no-run', 'missing-state', 'missing-workload', 'no-intent', 'scope', 'duplicate', 'stale-branch', 'missing-identity'])('clears stale readiness for %s', async failure => {
    const f = await fixture(provider);
    if (failure === 'partial' || failure === 'pending') f.execute.mockResolvedValue({ success: false, applyRunId: 'partial-apply', receipts: [{ actionId: 'native', status: failure === 'pending' ? 'pending' : 'failed' }] });
    if (failure === 'no-run') f.execute.mockResolvedValue({ success: false, receipts: [] });
    if (failure === 'missing-state') f.missing();
    if (failure === 'stale-branch') f.spec.environments.test!.deploy!.branch = 'release';
    if (failure === 'missing-identity') f.environmentState.values.root_module.resources.splice(0, 1);
    if (failure === 'no-intent') f.spec.environments.test!.deploy = { strategy: 'manual', autoDeploy: false, trigger: 'ci' };
    if (failure === 'missing-workload') f.environmentState.values.root_module.resources.splice(f.environmentState.values.root_module.resources.findIndex((r: any) => r.address.endsWith('.web')), 1);
    if (failure === 'scope') (f.buildState.values.root_module.resources[0] as any).values.tags_all = { 'managed-by': 'hypervibe', 'hv-environment': 'another' }, (f.buildState.values.root_module.resources[0] as any).values.tags = { 'managed-by': 'hypervibe', 'hv-environment': 'another' };
    if (failure === 'duplicate') f.buildState.values.root_module.resources.push(f.buildState.values.root_module.resources[0]);
    await f.apply(); expect(f.binding()).toBeNull();
  });
  it('does not mutate marker for a foreign plan rejected before target admission', async () => {
    const f = await fixture(provider); (f.document.engine[provider] as any).prefix = 'foreign';
    await f.apply(); expect(f.binding()).toEqual({ stale: 'private-old-marker' }); expect(f.execute).not.toHaveBeenCalled();
  });
});


it.each(['valid', 'foreign-url', 'broad-grant'] as const)('Azure package task publishes only applied scoped metadata: %s', async scenario => {
  const f = await fixture('azure');
  if (!('vault' in f.context)) throw new Error('Expected Azure context.');
  f.spec.secrets = projectSpecSchema.parse({ ...f.spec, secrets: { NPM_TOKEN: { ownership: 'delegated', principal: 'user:owner', environments: ['test'] } } }).secrets;
  const registry = azureCiRegistry({ subscriptionId, resourceGroup: 'hv-ci-app', environmentId: f.env.id });
  const secretName = azureVaultSecretName('test', 'NPM_TOKEN');
  const taskId = `${registry.id}/tasks/${f.prefix}-images`;
  const url = scenario === 'foreign-url' ? 'https://foreign.vault.azure.net/secrets/other' : `${f.context.vault.uri}secrets/${secretName}`;
  f.buildState.values.root_module.resources.splice(1, 1,
    resource('azurerm_container_registry_task.images', { id: taskId, container_registry_id: registry.id, tags: { 'managed-by': 'hypervibe', 'hv-environment': f.env.id.toLowerCase() },
      identity: [{ type: 'SystemAssigned', principal_id: principalId }], encoded_step: [{ task_content: Buffer.from(azureBuildTaskContent(url)).toString('base64') }] }),
    resource('azurerm_role_assignment.build_token', { id: `${registry.id}/providers/Microsoft.Authorization/roleAssignments/package-token`, principal_id: principalId,
      scope: `${f.context.vault.id}/secrets/${secretName}`, role_definition_id: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${scenario === 'broad-grant' ? '8e3af657-a8ff-443c-a75c-2fe8c4bcb635' : '4633458b-17de-408a-b874-0445c86b69e6'}` }),
  );
  await f.apply();
  if (scenario !== 'valid') expect(f.binding()).toBeNull();
  else {
    expect(parseEngineCiBinding(f.binding()).azure?.buildTaskId).toBe(taskId);
    expect(JSON.stringify(f.binding())).not.toContain(secretName);
    expect(JSON.stringify(f.binding())).not.toContain('private-');
  }
});

it('AWS package parameter preserves the selected present alias without credential values', async () => {
  const f = await fixture('aws');
  f.spec.secrets = projectSpecSchema.parse({ ...f.spec, secrets: {
    NODE_AUTH_TOKEN: { ownership: 'delegated', principal: 'user:owner', environments: ['test'], required: false },
    NPM_TOKEN: { ownership: 'delegated', principal: 'user:owner', environments: ['test'] },
  } }).secrets;
  const parameter = `/hypervibe/${f.env.id.toLowerCase()}/NPM_TOKEN`;
  const policy = f.buildState.values.root_module.resources.find((r: any) => r.address === 'aws_iam_role_policy.build')!;
  policy.values.policy = JSON.stringify({ Statement: [{ Sid: 'PackageToken', Effect: 'Allow', Action: 'ssm:GetParameters', Resource: `arn:aws:ssm:${region}:${accountId}:parameter${parameter}` }] });
  await f.apply();
  expect(parseEngineCiBinding(f.binding()).aws?.packageParameter).toBe(parameter);
  expect(JSON.stringify(f.binding())).not.toContain('private-');
  policy.values.policy = JSON.stringify({ Statement: [{ Sid: 'PackageToken', Effect: 'Allow', Action: 'ssm:GetParameters', Resource: `arn:aws:ssm:${region}:${accountId}:parameter/hypervibe/foreign/NPM_TOKEN` }] });
  await f.apply(); expect(f.binding()).toBeNull();
});


it.each(['missing', 'broad', 'reordered'] as const)('AWS proves applied CI policy semantics: %s', async scenario => {
  const f = await fixture('aws');
  const policy = f.environmentState.values.root_module.resources.find((r: any) => r.address === 'aws_iam_role_policy.ci')!;
  const value = JSON.parse(policy.values.policy as string);
  if (scenario === 'missing') value.Statement = [];
  else if (scenario === 'broad') value.Statement[0].Resource = '*';
  else {
    value.Statement.reverse();
    for (const statement of value.Statement) { statement.Action.reverse(); if (statement.Action.length === 1) statement.Action = statement.Action[0]; if (typeof statement.Resource === 'string') statement.Resource = [statement.Resource]; }
  }
  policy.values.policy = JSON.stringify(value);
  await f.apply();
  if (scenario === 'reordered') expect(parseEngineCiBinding(f.binding()).aws?.accountId).toBe(accountId);
  else expect(f.binding()).toBeNull();
});


it.each(['public', 'optional-absent', 'required-absent', 'missing-task'] as const)('Azure always needs its managed build task: %s', async scenario => {
  const f = await fixture('azure');
  if (scenario === 'optional-absent' || scenario === 'required-absent') f.spec.secrets = projectSpecSchema.parse({ ...f.spec, secrets: {
    NPM_TOKEN: { ownership: 'delegated', principal: 'user:owner', environments: ['test'], required: scenario === 'required-absent' },
  } }).secrets;
  if (scenario === 'missing-task') f.buildState.values.root_module.resources.splice(1, 1);
  await f.apply();
  if (scenario === 'public' || scenario === 'optional-absent') expect(parseEngineCiBinding(f.binding()).azure?.buildTaskId).toContain(`/tasks/${f.prefix}-images`);
  else expect(f.binding()).toBeNull();
});
