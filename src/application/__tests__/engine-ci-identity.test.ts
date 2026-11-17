import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { appBoundaryDocument } from '../../adapters/providers/aws/aws-setup.client.js';
import { buildAwsConfiguration } from '../../adapters/providers/aws/tofu/aws-engine.config.js';
import { buildAzureBuildConfiguration, buildAzureEnvironmentConfiguration } from '../../adapters/providers/azure/tofu/azure-engine.config.js';
import { azureCiRoleDefinitions } from '../../adapters/providers/azure/azure-ci-roles.js';
import { azureCiRegistry, azureSelectedBuildRegistry, projectAzureCiRegistry } from '../../adapters/providers/azure/azure-ci-registry.js';
import { fullEnvironmentInput } from '../../adapters/providers/azure/tofu/__tests__/azure-fixtures.js';

// User issue #681 and CI DG-056: a CI release gets one repository/ref and one
// environment's existing targets, with no stored key or infrastructure authority.
// Provider JSON is reconstructed from the documented IAM/FederatedIdentityCredential
// contracts; the corresponding real-provider validation is a separate check.
const ecsTransport = vi.hoisted(() => ({ requests: [] as Array<{ action: string; body: Record<string, unknown> }> }));
// Only the HTTP transport is substituted; the inherited real ECS client still
// serializes/signs commands and decodes reconstructed native API responses.
vi.mock('@aws-sdk/client-ecs', async (load) => {
  const actual = await load<typeof import('@aws-sdk/client-ecs')>();
  return { ...actual, ECSClient: class extends actual.ECSClient {
    constructor(config: ConstructorParameters<typeof actual.ECSClient>[0]) {
      super({ ...config, requestHandler: { handle: async (request: { body?: unknown; headers: Record<string, string> }) => {
        const action = request.headers['x-amz-target']!.split('.').pop()!;
        const body = JSON.parse(typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString());
        ecsTransport.requests.push({ action, body });
        const arn = 'arn:aws:ecs:us-west-2:111122223333:task-definition/hv-app-test-worker:6';
        const payload = action === 'DescribeTaskDefinition' ? { taskDefinition: { family: 'hv-app-test-worker', containerDefinitions: [{ name: 'app', image: 'old-image' }], taskRoleArn: 'arn:aws:iam::111122223333:role/hypervibe/app/hv-app-test-runtime', executionRoleArn: 'arn:aws:iam::111122223333:role/hypervibe/app/hv-app-test-runtime' }, tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hv-environment', value: 'env1' }] }
          : action === 'RegisterTaskDefinition' ? { taskDefinition: { taskDefinitionArn: arn } }
          : action === 'DescribeServices' ? { services: [{ taskDefinition: arn, desiredCount: 1 }] } : {};
        return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify(payload)]) } };
      } } });
    }
  } };
});

const ci = { repository: 'owner/app', branch: 'main', environmentName: 'test' };
const aws = { accountId: '111122223333', region: 'us-west-2', prefix: 'hv-app-test', environmentId: 'ENV1', parameterPath: '/hypervibe/env1/',
  services: [{ logicalName: 'web', resourceName: 'hv-app-test-web', initialImageUri: 'image@sha256:abc', public: true }] };

describe('engine-managed release identities', () => {
  it('plans AWS CI trust for the exact repository and branch, with environment-scoped release access', () => {
    const config = buildAwsConfiguration({ ...aws, ci } as typeof aws);
    const file = config.files['ci.tf.json'] as any;
    expect(file).toBeDefined();
    const role = file.resource.aws_iam_role.ci;
    const trust = JSON.parse(role.assume_role_policy);
    expect(trust.Statement[0]).toMatchObject({ Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:owner/app:ref:refs/heads/main',
    } } });
    const statements = JSON.parse(file.resource.aws_iam_role_policy.ci.policy).Statement;
    expect(statements.find((statement: any) => statement.Sid === 'ReleaseWeb')).toMatchObject({ Resource: ['arn:aws:lambda:us-west-2:111122223333:function:hv-app-test-web'] });
    expect(JSON.stringify(statements)).not.toMatch(/CreateFunction|DeleteFunction|iam:\*|ssm:/);
    expect(config.resources['aws_iam_role.ci']).toMatchObject({ requiresConfirm: true });
  });

  it('plans a separate Azure CI identity and exact-ref federation with target-scoped roles', () => {
    const config = buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, ci } as typeof fullEnvironmentInput);
    const file = config.files['ci.tf.json'] as any;
    expect(file).toBeDefined();
    expect(file.resource.azurerm_federated_identity_credential.ci).toMatchObject({
      issuer: 'https://token.actions.githubusercontent.com', audience: ['api://AzureADTokenExchange'], subject: 'repo:owner/app:ref:refs/heads/main',
      user_assigned_identity_id: '${azurerm_user_assigned_identity.ci.id}',
    });
    const roles = Object.values(file.resource.azurerm_role_assignment) as any[];
    expect(roles.every((role) => role.scope !== `/subscriptions/${fullEnvironmentInput.subscriptionId}/resourceGroups/${fullEnvironmentInput.resourceGroup}`)).toBe(true);
    expect(roles.map((role) => role.scope)).toContain('${azurerm_container_app.web.id}');
    expect(roles.map((role) => role.scope)).toContain('${azurerm_container_app_job.nightly.id}');
    expect(JSON.stringify(file)).not.toMatch(/client_secret|Microsoft\.Authorization\/roleAssignments\/write/);
    expect(config.resources['azurerm_federated_identity_credential.ci']).toMatchObject({ requiresConfirm: true });
  });

  it('keeps manual environments free of CI identities', () => {
    expect(buildAwsConfiguration(aws).files['ci.tf.json']).toBeUndefined();
    expect(buildAzureEnvironmentConfiguration(fullEnvironmentInput).files['ci.tf.json']).toBeUndefined();
  });
});


// Primary IAM contract checked 2026-11-16:
// https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html
// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/supported-iam-actions-tagging.html
// DescribeTaskDefinition is unscoped; RegisterTaskDefinition supports task-definition;
// tags carried by releaseTask require TagResource with CreateAction=RegisterTaskDefinition.
describe('native CI permission boundaries', () => {
  const tasks = { workers: [{ logicalName: 'worker', resourceName: 'hv-app-test-worker', initialImageUri: 'image' }],
    jobs: [{ logicalName: 'cron', resourceName: 'hv-app-test-cron', initialImageUri: 'image', schedule: '0 1 * * *' }] };
  const familyArns = ['arn:aws:ecs:us-west-2:111122223333:task-definition/hv-app-test-worker:*', 'arn:aws:ecs:us-west-2:111122223333:task-definition/hv-app-test-cron:*'];
  it('permits reads, revision registration and tag preservation only at supported scopes', () => {
    const file = buildAwsConfiguration({ ...aws, ...tasks, ci }).files['ci.tf.json'] as any;
    const statements = JSON.parse(file.resource.aws_iam_role_policy.ci.policy).Statement;
    expect(statements.find((s: any) => s.Sid === 'ReadTasks')).toMatchObject({ Action: ['ecs:DescribeTaskDefinition'], Resource: '*' });
    expect(statements.find((s: any) => s.Sid === 'RegisterTaskRevision')).toMatchObject({ Action: ['ecs:RegisterTaskDefinition'], Resource: familyArns });
    expect(statements.find((s: any) => s.Sid === 'TagTaskRevision')).toMatchObject({ Action: ['ecs:TagResource'], Resource: familyArns, Condition: { StringEquals: { 'ecs:CreateAction': 'RegisterTaskDefinition' } } });
    expect(statements.find((s: any) => s.Sid === 'BuildImage').Resource).toEqual(['arn:aws:codebuild:us-west-2:111122223333:project/hv-app-test-images']);
    expect(statements.find((s: any) => s.Sid === 'BuildImage').Action).toContain('codebuild:BatchGetProjects');
    const boundary = appBoundaryDocument() as any;
    expect(boundary.Statement.some((s: any) => s.Action.includes('codebuild:BatchGetProjects'))).toBe(true);
    expect(boundary.Statement.some((s: any) => s.Action.includes('ecs:TagResource') && s.Condition?.StringEquals?.['ecs:CreateAction'] === 'RegisterTaskDefinition')).toBe(true);
  });
  it('grants only the Azure actions used by the build and release clients', () => {
    const file = buildAzureEnvironmentConfiguration({ ...fullEnvironmentInput, ci }).files['ci.tf.json'] as any;
    expect(file.resource.azurerm_role_definition).toBeUndefined();
    const roles = azureCiRoleDefinitions(fullEnvironmentInput.subscriptionId, fullEnvironmentInput.resourceGroup);
    expect(file.resource.azurerm_role_assignment.ci_build.role_definition_id).toBe(roles.build.id);
    expect(roles.build.properties.permissions[0]!.actions).toEqual([
      'Microsoft.ContainerRegistry/registries/read', 'Microsoft.ContainerRegistry/registries/tasks/read', 'Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action',
      'Microsoft.ContainerRegistry/registries/scheduleRun/action', 'Microsoft.ContainerRegistry/registries/runs/read',
    ]);
  });
});


it('isolates Azure CI build authority in its environment registry and preserves it after disabling CI', () => {
  const input = { ...fullEnvironmentInput, ci };
  const build = buildAzureBuildConfiguration(input);
  const file = build.files['builds.tf.json'] as any;
  expect(file?.resource.azurerm_container_registry?.ci_images).toMatchObject({ sku: 'Basic', admin_enabled: false, anonymous_pull_enabled: false, role_assignment_mode: 'LegacyRegistryPermissions' });
  expect(build.resources['azurerm_container_registry.ci_images']).toMatchObject({ billable: true, requiresConfirm: true });
  const registryName = file.resource.azurerm_container_registry.ci_images.name;
  const registryId = `/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${registryName}`;
  const environment = buildAzureEnvironmentConfiguration(input).files as any;
  expect(environment['ci.tf.json'].resource.azurerm_role_assignment.ci_build.scope).toBe(registryId);
  expect(environment['base.tf.json'].resource.azurerm_role_assignment.runtime_pull.scope).toBe(input.shared.registryId);
  expect(environment['base.tf.json'].resource.azurerm_role_assignment.runtime_ci_pull.scope).toBe(registryId);
  const retained = buildAzureBuildConfiguration({ ...fullEnvironmentInput, buildRegistry: { id: registryId, loginServer: `${registryName}.azurecr.io` } } as any);
  expect(retained.resources['azurerm_container_registry.ci_images']).toBeDefined();
});

it('provisions a retained native CI task even when the app has no package token', () => {
  const build = buildAzureBuildConfiguration({ ...fullEnvironmentInput, ci });
  const native = (build.files['builds.tf.json'] as any).resource;
  expect(native.azurerm_container_registry_task?.images).toBeDefined();
  const task = native.azurerm_container_registry_task.images;
  expect(task.container_registry_id).toBe('${azurerm_container_registry.ci_images.id}');
  const content = JSON.parse(Buffer.from(task.encoded_step[0].task_content, 'base64').toString());
  expect(content.secrets).toBeUndefined();
  expect(content.steps[0].build).not.toContain('--secret');
  expect(native.azurerm_role_assignment?.build_token).toBeUndefined();
  expect(build.resources['azurerm_container_registry_task.images']).toBeDefined();
  const retained = buildAzureBuildConfiguration({ ...fullEnvironmentInput, buildRegistry: azureCiRegistry(fullEnvironmentInput) });
  expect(retained.resources['azurerm_container_registry_task.images']).toBeDefined();
});


it('keeps registry names stable and refuses cross-environment or unowned state bindings', () => {
  const expected = azureCiRegistry(fullEnvironmentInput);
  expect(azureCiRegistry({ ...fullEnvironmentInput, environmentId: 'different' }).id).not.toBe(expected.id);
  expect(() => azureSelectedBuildRegistry({ ...fullEnvironmentInput, ci, buildRegistry: { id: fullEnvironmentInput.shared.registryId, loginServer: fullEnvironmentInput.shared.registryLoginServer } })).toThrow(/different environment/);
  const state = { values: { root_module: { resources: [{ address: 'azurerm_container_registry.ci_images', values: { id: expected.id, name: expected.name, login_server: expected.loginServer, tags: { 'managed-by': 'hypervibe', 'hv-environment': 'env1' } } }] } } };
  expect(projectAzureCiRegistry(state, fullEnvironmentInput)).toEqual({ id: expected.id, loginServer: expected.loginServer });
  state.values.root_module.resources[0]!.values.tags['hv-environment'] = 'other';
  expect(() => projectAzureCiRegistry(state, fullEnvironmentInput)).toThrow(/ownership/);
});


it('preserves native task tags on the real serialized ECS release request', async () => {
  const { releaseTask } = await import('../../adapters/providers/aws/aws-release.client.js');
  ecsTransport.requests.length = 0;
  const result = await releaseTask({ ...aws, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture', sessionToken: 'fixture' } }, 'worker', 'hv-app-test-worker', 'registry/app@sha256:new', true);
  expect(result.status).toBe('released');
  expect(ecsTransport.requests.find((request) => request.action === 'DescribeTaskDefinition')!.body).toEqual({ taskDefinition: 'hv-app-test-worker', include: ['TAGS'] });
  expect(ecsTransport.requests.find((request) => request.action === 'RegisterTaskDefinition')!.body).toMatchObject({ family: 'hv-app-test-worker',
    tags: [{ key: 'managed-by', value: 'hypervibe' }, { key: 'hv-environment', value: 'env1' }], containerDefinitions: [{ name: 'app', image: 'registry/app@sha256:new' }],
  });
});


it.each(['missing', 'unreadable'] as const)('blocks Azure CI before engine planning when setup is %s', async (readiness) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { SqliteAdapter } = await import('../../adapters/db/sqlite.adapter.js');
  const { ConnectionRepository } = await import('../../adapters/db/repositories/connection.repository.js');
  const { getSecretStore } = await import('../../adapters/secrets/secret-store.js');
  const { createCommandContext } = await import('../context.js');
  const { projectSpecSchema } = await import('../../domain/spec/spec.schema.js');
  const setup = await import('../../adapters/providers/azure/azure-setup.client.js');
  const shared = await import('../engine-shared.js');
  const { planAzureInfrastructureEngine } = await import('../infrastructure-engine-azure.js');
  const directory = mkdtempSync(path.join(tmpdir(), 'hv-ci-plan-guard-'));
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(path.join(directory, 'db')).migrate();
  try {
    const ctx = createCommandContext();
    const project = ctx.repos.projects.create({ name: 'ci-guard', defaultPlatform: 'azure' });
    const connections = new ConnectionRepository();
    const connection = connections.create({ provider: 'azure', scope: project.name, credentialsEncrypted: getSecretStore().encryptObject({
      tenantId: fullEnvironmentInput.tenantId, subscriptionId: fullEnvironmentInput.subscriptionId, resourceGroup: fullEnvironmentInput.resourceGroup, location: fullEnvironmentInput.location,
      clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', deployPrincipalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', clientSecret: 'fixture-secret-for-ci-guard', clientSecretExpiresAt: '2099-01-01T00:00:00Z',
    }) });
    connections.updateStatus(connection.id, 'verified');
    const desired = projectSpecSchema.parse({ version: 1, project: 'ci-guard', gitRemoteUrl: 'https://github.com/owner/app.git', environments: { test: { hosting: { provider: 'azure', engine: 'opentofu' }, services: { web: {} }, deploy: { strategy: 'branch', branch: 'main' } } } });
    const ready = vi.spyOn(setup, 'azureCiSetupReady');
    if (readiness === 'unreadable') ready.mockRejectedValue(new Error('denied'));
    else ready.mockResolvedValue(false);
    const engine = vi.spyOn(shared, 'openTofuEngine').mockResolvedValue({ blocked: 'test engine must not start' });
    expect(await planAzureInfrastructureEngine(ctx, { project, spec: desired, environmentName: 'test', specRevision: 1 })).toMatchObject({ blocked: [expect.stringContaining('Azure CI access needs reviewed setup')] });
    expect(engine).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); }
});
