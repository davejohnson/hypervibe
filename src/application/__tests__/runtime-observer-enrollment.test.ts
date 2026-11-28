import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { azureKey } from '../../adapters/providers/azure/tofu/azure-engine.config.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { admitRuntimeObserver, runtimeObservationIntent } from '../../domain/spec/runtime-observation.js';
import { writeRepoBindingsForEnvironment } from '../../domain/spec/repo-bindings-file.js';
import { renderRuntimeObservationWorkflow } from '../../domain/services/runtime-observation-workflow.js';
import { azureObserverLogCondition, addAzureObserverConfiguration } from '../../adapters/providers/azure/tofu/azure-observer.config.js';
import { addAwsObserverConfiguration, awsObserverPolicies } from '../../adapters/providers/aws/tofu/aws-observer.config.js';
import { appBoundaryDocument } from '../../adapters/providers/aws/aws-setup.client.js';
import { appRoleAssignmentCondition } from '../../adapters/providers/azure/azure-setup.client.js';
import { projectRuntimeObserverState } from '../runtime-observer-bindings.js';
import { engineCiCommitInputs } from '../engine-ci-execution.js';
import { awsKey } from '../../adapters/providers/aws/tofu/aws-engine.config.js';
import { runtimeObserverAccess } from '../../adapters/runtime-observer-auth.js';

const temp: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); temp.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const rawSpec = { version: 1, project: 'app', gitRemoteUrl: 'https://github.com/owner/app', environments: {
  prod: { hosting: { provider: 'aws', region: 'us-west-2' }, runtimeObservation: { branch: 'main' }, services: { api: { workloadKind: 'web' } } },
} };
const spec = projectSpecSchema.parse(rawSpec);
const intent = runtimeObservationIntent(spec, 'prod')!;
const federation = { ...intent, ownerId: '12', repositoryId: '34' };
const accountId = '111122223333'; const region = 'us-west-2'; const prefix = 'hv-app-prod';
const envId = 'env1'; const arn = 'arn:aws:ecs:' + region + ':' + accountId;
const roleArn = 'arn:aws:iam::' + accountId + ':role/hypervibe/app/' + prefix + '-observer';
const policies = awsObserverPolicies({ accountId, region, prefix }, federation);
const tags = { 'managed-by': 'hypervibe', 'hv-environment': envId };
const resource = (address: string, values: Record<string, unknown>) => ({ type: address.split('.')[0], mode: 'managed', address, values });
const native = () => ({ format_version: '1.0', values: { root_module: { resources: [
  resource('aws_iam_role.observer', { id: prefix + '-observer', tags_all: tags, arn: roleArn,
    permissions_boundary: 'arn:aws:iam::' + accountId + ':policy/hypervibe/hypervibe-app-boundary', assume_role_policy: JSON.stringify(policies.trust) }),
  resource('aws_iam_role_policy.observer', { role: prefix + '-observer', name: 'observe', policy: JSON.stringify(policies.policy) }),
  resource('aws_ecs_express_gateway_service.' + awsKey('api'), { tags_all: tags, service_arn: arn + ':service/' + prefix + '/' + prefix + '-api',
    primary_container: [{ aws_logs_configuration: [{ log_group: '/hypervibe/' + prefix + '/tasks', log_stream_prefix: prefix + '-api' }] }] }),
] } } });
const input = { spec, environmentName: 'prod', provider: 'aws' as const, context: { prefix, connection: { accountId, region }, environment: { id: envId },
  observerRepository: { ownerId: federation.ownerId, repositoryId: federation.repositoryId } } } as Parameters<typeof projectRuntimeObserverState>[1];

describe('scheduled runtime observer enrollment', () => {
  it('publishes the workflow from the committed opt-in and applied state without enabling branch deployment', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hv-observer-')); temp.push(dir);
    vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', '0');
    execFileSync('git', ['init', '-q', dir]); execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', rawSpec.gitRemoteUrl]);
    mkdirSync(path.join(dir, '.hypervibe')); const specPath = path.join(dir, '.hypervibe/spec.json');
    writeFileSync(specPath, JSON.stringify(rawSpec));
    const now = new Date(); const project = { id: 'project', name: 'app', gitRemoteUrl: rawSpec.gitRemoteUrl, defaultPlatform: 'aws', policies: {}, createdAt: now, updatedAt: now };
    const saved = projectRuntimeObserverState(native(), input);
    const environment = { id: envId, name: 'prod', projectId: project.id, createdAt: now, updatedAt: now,
      platformBindings: { provider: 'aws', projectId: accountId, environmentId: region, runtimeObserver: saved, services: saved.services } };
    writeRepoBindingsForEnvironment(project, environment, dir);
    const workflowPath = path.join(dir, '.github/workflows/hypervibe-observe-prod.yml');
    const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));
    expect(workflow.on).toEqual({ schedule: [{ cron: '*/5 * * * *' }], workflow_dispatch: {} });
    expect(workflow.jobs.observe).toMatchObject({ 'runs-on': 'ubuntu-latest', permissions: { actions: 'read', contents: 'read', 'id-token': 'write' } });
    expect(workflow.jobs.observe.if).toContain("github.event.repository.default_branch == 'main'");
    expect(existsSync(path.join(dir, '.github/workflows/hypervibe-release-prod.yml'))).toBe(false);
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'enrolled']);
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const files = await engineCiCommitInputs(dir, sha);
    expect(admitRuntimeObserver({ ...files, environmentName: 'prod', repository: 'owner/app', ref: 'refs/heads/main', sha })).toEqual(saved);
    expect(() => admitRuntimeObserver({ ...files, environmentName: 'prod', repository: 'fork/app', ref: 'refs/heads/main', sha })).toThrow();
    const runner = path.join(dir, 'hv-observer-cli/node_modules/.bin');
    mkdirSync(runner, { recursive: true });
    writeFileSync(path.join(runner, 'hypervibe'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const collect = workflow.jobs.observe.steps.find((s: { name: string }) => s.name === 'Collect bounded runtime evidence');
    expect(execFileSync('bash', ['-euc', collect.run], { cwd: dir, env: { ...process.env, RUNNER_TEMP: dir, HV_ENVIRONMENT: collect.env.HV_ENVIRONMENT }, encoding: 'utf8' })).toBe('ci\nobserve\n--env\nprod\n');
    const artifacts = workflow.jobs.observe.steps.filter((s: { uses?: string }) => s.uses?.startsWith('actions/upload-artifact'));
    expect(artifacts.map((s: { with: { name: string } }) => s.with.name)).toEqual(['hypervibe-runtime-observation', 'hypervibe-runtime-cursor']);
    const { runtimeObservation: _removed, ...disabled } = rawSpec.environments.prod;
    writeFileSync(specPath, JSON.stringify({ ...rawSpec, environments: { prod: disabled } }));
    writeRepoBindingsForEnvironment(project, { ...environment, platformBindings: { ...environment.platformBindings, runtimeObserver: null } }, dir);
    expect(existsSync(workflowPath)).toBe(false);
    writeFileSync(workflowPath, 'name: Hand-written workflow\n');
    writeRepoBindingsForEnvironment(project, { ...environment, platformBindings: { ...environment.platformBindings, runtimeObserver: null } }, dir);
    expect(readFileSync(workflowPath, 'utf8')).toContain('Hand-written');
  });

  it('rejects unverified permissions, tainted resources and missing workloads', () => {
    for (const change of ['write', 'tainted', 'missing']) {
      const state = native(); const rows = state.values.root_module.resources;
      if (change === 'write') rows[1]!.values.policy = JSON.stringify({ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] });
      if (change === 'tainted') Object.assign(rows[0]!, { tainted: true });
      if (change === 'missing') rows.pop();
      expect(() => projectRuntimeObserverState(state, input)).toThrow();
    }
  });

  it('limits AWS access to the selected log group and cluster and separates the account ceiling upgrade', () => {
    const files = {}; const resources = {};
    const base = { accountId, region, prefix, environmentId: envId, parameterPath: '/hypervibe/env1/' };
    addAwsObserverConfiguration(base, files, resources); expect(files).toEqual({});
    addAwsObserverConfiguration({ ...base, observation: federation }, files, resources);
    expect(resources).toHaveProperty(['aws_iam_role.observer', 'requiresConfirm'], true);
    expect(policies.policy.Statement.map(s => s.Action)).toEqual(['logs:FilterLogEvents', 'ecs:ListTasks', 'ecs:DescribeTasks']);
    expect(policies.trust.Statement[0]!.Condition.StringEquals['token.actions.githubusercontent.com:sub']).toEqual(['repo:owner/app:ref:refs/heads/main', 'repo:owner@12/app@34:ref:refs/heads/main']);
    expect(JSON.stringify(appBoundaryDocument())).not.toContain('logs:FilterLogEvents');
    expect(JSON.stringify(appBoundaryDocument(true))).toContain('logs:FilterLogEvents');
    expect(() => renderRuntimeObservationWorkflow(intent, 'latest')).toThrow();
  });

  it('limits Azure query permissions to the selected workspace, table and workload rows', () => {
    const azure = { observation: { ...federation, workspaceResourceId: '/subscriptions/id/resourceGroups/hv-app/providers/Microsoft.OperationalInsights/workspaces/hv-logs' },
      shared: { appsEnvironmentId: '/subscriptions/id/resourceGroups/hv-app/providers/Microsoft.App/managedEnvironments/hv-apps' },
      subscriptionId: 'id', resourceGroup: 'hv-app', location: 'eastus', prefix, environmentId: envId,
      services: [{ logicalName: 'api', resourceName: 'hv-api' }], jobs: [{ logicalName: 'cleanup', resourceName: 'hv-cleanup' }] };
    const files: Record<string, unknown> = {};
    addAzureObserverConfiguration(azure as Parameters<typeof addAzureObserverConfiguration>[0], files, {});
    const cloud = (files['observer.tf.json'] as { resource: Record<string, Record<string, Record<string, unknown>>> }).resource;
    expect(cloud.azurerm_federated_identity_credential!.observer_immutable!.subject).toBe('repo:owner@12/app@34:ref:refs/heads/main');
    const logs = cloud.azurerm_role_assignment!.observer_logs!;
    expect(logs.scope).toBe(azure.observation.workspaceResourceId);
    expect(logs.condition).toBe(azureObserverLogCondition(['hv-api'], ['hv-cleanup']));
    expect(logs.condition).toContain('ContainerAppConsoleLogs_CL');
    expect(appRoleAssignmentCondition()).not.toContain('3b03c2da');
    expect(appRoleAssignmentCondition([], false, true)).toContain('3b03c2da');
  });

  it('projects the exact Azure identity, assignments and native job from retained state', () => {
    const subscriptionId = '11111111-1111-4111-8111-111111111111';
    const tenantId = '22222222-2222-4222-8222-222222222222';
    const clientId = '33333333-3333-4333-8333-333333333333';
    const principal = '44444444-4444-4444-8444-444444444444';
    const workspaceId = '55555555-5555-4555-8555-555555555555';
    const group = '/subscriptions/' + subscriptionId + '/resourceGroups/hv-app'; const sharedPrefix = 'hv-app-shared';
    const identity = group + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + prefix + '-observer';
    const managedEnvironmentId = group + '/providers/Microsoft.App/managedEnvironments/' + sharedPrefix + '-apps';
    const job = group + '/providers/Microsoft.App/jobs/hv-app-job';
    const azureSpec = projectSpecSchema.parse({ ...rawSpec, environments: { prod: { runtimeObservation: { branch: 'main' }, hosting: { provider: 'azure' },
      services: { cleanup: { workloadKind: 'cron', cronSchedule: '0 * * * *', startCommand: 'node cleanup.js' } } } } });
    const params = { spec: azureSpec, environmentName: 'prod', provider: 'azure' as const, region: 'eastus',
      context: { ...input.context, connection: { subscriptionId, tenantId, resourceGroup: 'hv-app' }, shared: { prefix: sharedPrefix, appsEnvironmentId: managedEnvironmentId } } } as Parameters<typeof projectRuntimeObserverState>[1];
    const fid = (name: string, subject: string) => ({ name, issuer: 'https://token.actions.githubusercontent.com', audience: ['api://AzureADTokenExchange'], subject, user_assigned_identity_id: identity });
    const assignment = (scope: string, role: string) => ({ scope, role_definition_id: '/subscriptions/' + subscriptionId + '/providers/Microsoft.Authorization/roleDefinitions/' + role, principal_id: principal });
    const rows = [
      resource('azurerm_user_assigned_identity.observer', { id: identity, tenant_id: tenantId, client_id: clientId, principal_id: principal, tags }),
      resource('azurerm_federated_identity_credential.observer', fid('github-observe', 'repo:owner/app:ref:refs/heads/main')),
      resource('azurerm_federated_identity_credential.observer_immutable', fid('github-observe-immutable', 'repo:owner@12/app@34:ref:refs/heads/main')),
      resource('azurerm_role_assignment.observer_environment', assignment(managedEnvironmentId, 'acdd72a7-3385-48ef-bd42-f606fba81ae7')),
      resource('azurerm_container_app_job.' + azureKey('cleanup'), { id: job, tags, container_app_environment_id: managedEnvironmentId }),
      resource('azurerm_role_assignment.observer_app_' + azureKey('cleanup'), assignment(job, 'acdd72a7-3385-48ef-bd42-f606fba81ae7')),
      resource('azurerm_role_assignment.observer_logs', { ...assignment(group + '/providers/Microsoft.OperationalInsights/workspaces/' + sharedPrefix + '-logs', '3b03c2da-16b3-4a49-8834-0f8130efdd3b'), condition_version: '2.0', condition: azureObserverLogCondition([], ['hv-app-job']) }),
    ];
    const state = { format_version: '1.0', values: { root_module: { resources: rows } } };
    const saved = projectRuntimeObserverState(state, params, { managedEnvironmentId, workspaceId });
    expect(saved).toMatchObject({ provider: 'azure', azure: { clientId }, services: { cleanup: { serviceId: job, workspaceId } } });
    rows.at(-1)!.values.condition = '';
    expect(() => projectRuntimeObserverState(state, params, { managedEnvironmentId, workspaceId })).toThrow(/scope differs/);
  });

  it('requires a GitHub-hosted job in the admitted workflow before exposing a cloud assertion', async () => {
    const binding = projectRuntimeObserverState(native(), input);
    const context = { repository: 'owner/app', ref: 'refs/heads/main', sha: 'a'.repeat(40), eventName: 'schedule',
      runId: '10', runAttempt: '1', requestUrl: 'https://example.actions.githubusercontent.com/oidc', requestToken: 'runner-request' };
    for (const override of [{ runner_environment: 'self-hosted' }, { workflow_ref: 'owner/app/.github/workflows/elsewhere.yml@refs/heads/main' }]) {
      const claims = { iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: context.repository,
        ref: context.ref, sha: context.sha, run_id: '10', run_attempt: '1', event_name: 'schedule', exp: Date.now() / 1000 + 120,
        workflow_ref: 'owner/app/.github/workflows/hypervibe-observe-prod.yml@refs/heads/main', runner_environment: 'github-hosted', ...override };
      const request = vi.fn(async () => Response.json({ value: 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.sig' }));
      vi.stubGlobal('fetch', request);
      await expect(runtimeObserverAccess(binding, context)).rejects.toThrow(/assertion does not match/);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
