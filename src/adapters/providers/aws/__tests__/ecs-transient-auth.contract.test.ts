import { describe, expect, it, vi } from 'vitest';
import { EcsExpressAdapter } from '../ecs-express.adapter.js';
import { createAwsDeploymentCredentialProvider } from '../aws-deployment-auth.js';
import { observeRuntimeAccess, planRuntimeAccess } from '../../../../domain/services/runtime-access.service.js';
import { awsDeploymentNames } from '../aws-cloud-deployment.js';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import type { Service } from '../../../../domain/entities/service.entity.js';
import { AwsSecretsAdapter } from '../../secretmanagers/aws-secrets.adapter.js';

import { ecsTransientFixture as fixture, accountId, region, connection } from './ecs-transient.fixture.js';

describe('ECS transient access real SDK boundary', () => {
  it.each(['root', 'user/Alice'])('does not accept an operator %s session as the installed deployment role', async principal => {
    const f = fixture(); let identityReads = 0;
    const handler = { handle: async (request: any) => {
      expect(new URLSearchParams(request.body).get('Action')).toBe('GetCallerIdentity'); identityReads++;
      return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Buffer.from(
        `<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${accountId}</Account><Arn>arn:aws:iam::${accountId}:${principal}</Arn><UserId>${principal === 'root' ? accountId : 'AIDACKCEVSQ6C2EXAMPLE'}</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`) } };
    } };
    const provider = createAwsDeploymentCredentialProvider(f.input, { requestHandler: handler });
    await expect(provider(AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'scope_mismatch' });
    expect(identityReads).toBe(1); expect(f.requests).toEqual([]);
  });
  it('never falls back to machine credentials for registry rotation through hosted deployment authority', async () => {
    const f = fixture(false, true), adapter = new EcsExpressAdapter();
    await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const cluster = f.environment.platformBindings.projectId as string, serviceId = cluster.replace(':cluster/', ':service/') + '/web';
    const credentialReference = `arn:aws:secretsmanager:${region}:${accountId}:secret:registry-AbCdEf`;
    f.environment.platformBindings.services = { web: { serviceId } };
    f.state.created = { primaryContainer: { image: 'registry.example.test/app:existing', repositoryCredentials: { credentialsParameter: credentialReference } } };
    // Observe the real adapter boundary without permitting the SDK default chain
    // to read this developer machine. Release federation is not secret-store authority.
    const connect = vi.spyOn(AwsSecretsAdapter.prototype, 'connect').mockRejectedValue(new Error('Machine credential fallback was attempted'));
    try {
      const expected = { provider: 'ecs', projectId: cluster, environmentId: cluster, serviceId, instanceId: serviceId,
        image: 'registry.example.test/app:existing', credentialReference, registry: 'registry.example.test', activation: 'deferred' as const };
      for (const action of ['update', 'reconcile'] as const) {
        const result = await adapter.registryCredentialLifecycle[action]!(f.environment, 'web', expected,
          { username: 'synthetic-user', token: 'synthetic-value' }, { operationId: 'a'.repeat(32) });
        expect(result.success).toBe(false);
        expect(result.data?.mutationAttempted).toBe(false);
      }
      expect(connect).not.toHaveBeenCalled();
      expect(f.requests.filter(item => /^(Create|Put|Attach|Tag|Delete|Update|Register)/.test(item.operation))).toEqual([]);
    } finally { connect.mockRestore(); await adapter.disconnect(); }
  });
  it('does not remove an approved secret reference through the retired-variable path', async () => {
    const f = fixture(false, true), adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const service: Service = { id: 'local-service', projectId: f.environment.projectId, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const cluster = f.environment.platformBindings.projectId as string;
    f.environment.platformBindings.services = { web: { serviceId: cluster.replace(':cluster/', ':service/') + '/web' } };
    f.state.created = { primaryContainer: { image: 'example.invalid/image:bootstrap', secrets: [{ name: 'API_KEY', valueFrom: f.reference.destination.secretArn + ':::' + f.reference.version }] } };
    const result = await adapter.deleteEnvVars(f.environment, service, ['API_KEY']);
    expect(result.success).toBe(false);
    expect(f.requests.filter(item => /^(Create|Put|Attach|Tag|Delete|Update|Register)/.test(item.operation))).toEqual([]);
    await adapter.disconnect();
  });
  it.each(['version', 'omitted'] as const)('rejects a changed %s reference after reviewed runtime binding and before workload mutation', async change => {
    const f = fixture(false, true), adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const environmentSpec = { hosting: { provider: 'ecs', region }, services: { web: { workloadKind: 'web' } }, secretDestinations: { API_KEY: f.reference } } as any;
    const service: Service = { id: 'local-service', projectId: f.environment.projectId, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const request = { environment: f.environment, environmentSpec, service, mode: 'ensure' as const };
    const observed = await adapter.runtimeIdentities.inspect(request); if (observed.state !== 'action') throw new Error('Missing runtime binding');
    const bound = await adapter.runtimeIdentities.apply({ ...request, step: observed.step, attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    f.environment.platformBindings.runtimeIdentities = { web: bound.binding! };
    const result = await adapter.deploy(service, f.environment, {}, { requireNewWorkload: true, deferDeployment: true,
      secretVersionRefs: change === 'version' ? { API_KEY: { ...f.reference, version: 'b'.repeat(32) } } : {} });
    expect(result.receipt.success).toBe(false);
    expect(f.requests.filter(item => /^(Create|Put|Attach|Tag|Delete|Update|Register)/.test(item.operation))).toEqual([]);
    await adapter.disconnect();
  });
  it('creates an inert first workload while retaining reviewed immutable references and preinstalled roles for CI', async () => {
    const f = fixture(false, true); const adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const environmentSpec = { hosting: { provider: 'ecs', region }, services: { web: { workloadKind: 'web' } }, secretDestinations: { API_KEY: f.reference } } as any;
    const service: Service = { id: 'local-service', projectId: f.environment.projectId, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const request = { environment: f.environment, environmentSpec, service, mode: 'ensure' as const };
    const observed = await adapter.runtimeIdentities.inspect(request); expect(observed.state).toBe('action'); if (observed.state !== 'action') return;
    const bound = await adapter.runtimeIdentities.apply({ ...request, step: observed.step, attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }); expect(bound.receipt.success).toBe(true);
    f.environment.platformBindings.runtimeIdentities = { web: bound.binding! };
    const result = await adapter.deploy(service, f.environment, {}, { requireNewWorkload: true, deferDeployment: true, secretVersionRefs: { API_KEY: f.reference } });
    expect(result.receipt.success, JSON.stringify(result.receipt)).toBe(true);
    expect(result.receipt.data?.resourceUid).toBe('2023-11-14T22:13:20.000Z');
    expect(f.state.created).toMatchObject({ executionRoleArn: `arn:aws:iam::${accountId}:role/execution`, primaryContainer: { secrets: [], environment: [] } });
    expect(f.state.created.taskRoleArn).toBeUndefined();
    expect(result.receipt.data).toMatchObject({ pendingImage: true, runtimeRolloutRequired: true });
    expect(f.requests.filter(item => /^(Create|Put|Attach|Tag|Delete)/.test(item.operation)).map(item => item.operation)).toEqual(['CreateExpressGatewayService']);
    f.environment.platformBindings.services = { web: { serviceId: result.externalId, resourceUid: result.receipt.data?.resourceUid } };
    expect((await adapter.runtimeIdentities.inspect({ ...request, binding: bound.binding })).state).toBe('ready');
    const before = f.requests.length;
    expect((await adapter.deploy(service, f.environment, {}, { deferDeployment: true, secretVersionRefs: { API_KEY: f.reference } })).receipt).toMatchObject({ success: true, data: { pendingImage: true } });
    expect(f.requests.slice(before).some(item => /^(Create|Put|Attach|Tag|Delete|Update|Register)/.test(item.operation))).toBe(false);
    f.state.nativeTaskRole = `arn:aws:iam::${accountId}:role/task`;
    expect((await adapter.runtimeIdentities.inspect({ ...request, binding: bound.binding })).state).toBe('unknown');
    delete f.state.nativeTaskRole;
    (f.environment.platformBindings.services as any).web.resourceUid = '2023-11-14T22:13:21.000Z';
    expect((await adapter.runtimeIdentities.inspect({ ...request, binding: bound.binding })).state).toBe('unknown');
    f.state.replacedRuntime = true; expect((await adapter.runtimeIdentities.inspect({ ...request, binding: bound.binding })).state).toBe('unknown'); await adapter.disconnect();
  });
  it('keeps application secrets and final task authority away from the non-application bootstrap image', async () => {
    // AWS injects native `secrets` when this container starts, before a later
    // exact-image CI release. Immutable references do not prevent early access:
    // https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html
    const f = fixture(false, true), adapter = new EcsExpressAdapter();
    await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const service: Service = { id: 'local-service', projectId: f.environment.projectId, name: 'web',
      buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const request = { environment: f.environment,
      environmentSpec: { hosting: { provider: 'ecs', region }, services: { web: { workloadKind: 'web' } }, secretDestinations: { API_KEY: f.reference } } as any,
      service, mode: 'ensure' as const };
    try {
      const observed = await adapter.runtimeIdentities.inspect(request);
      expect(observed.state).toBe('action'); if (observed.state !== 'action') return;
      const bound = await adapter.runtimeIdentities.apply({ ...request, step: observed.step, attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      f.environment.platformBindings.runtimeIdentities = { web: bound.binding! };
      await adapter.deploy(service, f.environment, { APPLICATION_SECRET: 'synthetic-application-secret' }, {
        requireNewWorkload: true, deferDeployment: true, secretVersionRefs: { API_KEY: f.reference },
      });
      expect(f.state.created).toBeDefined();
      expect.soft(f.state.created.primaryContainer.secrets ?? []).toEqual([]);
      expect.soft(f.state.created.primaryContainer.environment ?? []).not.toContainEqual({ name: 'APPLICATION_SECRET', value: 'synthetic-application-secret' });
      expect.soft(f.state.created.taskRoleArn).toBeUndefined();
    } finally { await adapter.disconnect(); }
  });
  it('does not replay an uncertain bootstrap create or accept inline hosted credential updates', async () => {
    const f = fixture(false, true), adapter = new EcsExpressAdapter();
    await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const service: Service = { id: 'local-service', projectId: f.environment.projectId, name: 'web', buildConfig: { workloadKind: 'web' }, envVarSpec: {}, createdAt: new Date(), updatedAt: new Date() };
    const request = { environment: f.environment, environmentSpec: { hosting: { provider: 'ecs', region }, services: { web: { workloadKind: 'web' } }, secretDestinations: { API_KEY: f.reference } } as any, service, mode: 'ensure' as const };
    try {
      const observed = await adapter.runtimeIdentities.inspect(request); if (observed.state !== 'action') throw new Error('Missing binding action');
      const bound = await adapter.runtimeIdentities.apply({ ...request, step: observed.step, attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      f.environment.platformBindings.runtimeIdentities = { web: bound.binding! };
      f.state.loseCreate = true;
      const options = { requireNewWorkload: true, deferDeployment: true, secretVersionRefs: { API_KEY: f.reference } };
      expect((await adapter.deploy(service, f.environment, {}, options)).receipt).toMatchObject({ success: false, data: { phase: 'serviceCreate', mutationAttempted: true } });
      expect((await adapter.deploy(service, f.environment, {}, options)).receipt.success).toBe(false);
      expect(f.requests.filter(item => item.operation === 'CreateExpressGatewayService')).toHaveLength(1);
      const before = f.requests.length;
      expect((await adapter.setEnvVars(f.environment, service, { API_KEY: 'synthetic-inline-key' }, { requireCredentialUpdate: true })).success).toBe(false);
      expect(f.requests).toHaveLength(before);
    } finally { await adapter.disconnect(); }
  });
  it('plans an explicit read-only first-runtime binding from installer lifetime evidence without IAM mutation', async () => {
    const f = fixture(); const adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const names = awsDeploymentNames(connection), clusterArn = `arn:aws:ecs:${region}:${accountId}:cluster/${names.clusterName}`;
    const environment: Environment = { id: 'local-environment-id', projectId: 'local-project-id', name: 'production', createdAt: new Date(), updatedAt: new Date(), platformBindings: { provider: 'ecs', projectId: clusterArn, environmentId: clusterArn, services: {} } };
    const environmentSpec = { hosting: { provider: 'ecs', region }, services: { web: { workloadKind: 'web' } } } as any;
    const observed = await observeRuntimeAccess({ environment, environmentSpec, hosting: adapter, storageAdapters: {} });
    const actions = planRuntimeAccess(observed);
    expect(actions).toHaveLength(1);
    expect(observed.identities[0].observation.state).toBe('action');
    if (observed.identities[0].observation.state !== 'action') throw new Error('Missing explicit binding step');
    const result = await adapter.runtimeIdentities.apply({ environment, environmentSpec, service: { name: 'web', buildConfig: { workloadKind: 'web' } }, mode: 'ensure',
      step: observed.identities[0].observation.step, attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect(result.receipt.success).toBe(true); expect(result.binding?.evidence.roleId).toBe(connection.runtimeIdentities[0].principal.kind === 'aws-role' ? connection.runtimeIdentities[0].principal.roleId : '');
    const again = await adapter.runtimeIdentities.inspect({ environment, environmentSpec, service: { name: 'web', buildConfig: { workloadKind: 'web' } }, mode: 'ensure', binding: result.binding });
    expect(again.state).toBe('ready'); expect(f.requests.some(item => /^(Create|Put|Attach|Tag|Delete)/.test(item.operation))).toBe(false); await adapter.disconnect();
  });
  it('uses refresh callbacks and includes STS session token on independently verified native requests', async () => {
    const f = fixture(); const provider = createAwsDeploymentCredentialProvider(f.input, { requestHandler: f.handler });
    await provider(AbortSignal.timeout(1000)); await provider(AbortSignal.timeout(1000));
    expect(f.getCredentials).toHaveBeenCalledTimes(2); expect(f.requests.map(item => item.operation)).toEqual(['GetCallerIdentity', 'GetCallerIdentity']);
    expect(f.requests.every(item => item.token === 'synthetic-session')).toBe(true);
    const adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const verified = await adapter.verify(); expect(verified, JSON.stringify({ verified, requests: f.requests })).toMatchObject({ success: true });
    expect(f.requests.filter(item => item.operation !== 'GetCallerIdentity').every(item => item.token === 'synthetic-session')).toBe(true);
    expect(() => adapter.configureTarget({ region: 'us-east-1' })).toThrow(); await adapter.disconnect();
  });
  it('rejects same-name replacement role before any ECS/ECR call and never returns raw credentials', async () => {
    const f = fixture(true); const adapter = new EcsExpressAdapter(); await adapter.connectTransient(f.input, { requestHandler: f.handler });
    const result = await adapter.verify(); expect(result.success).toBe(false);
    expect(f.requests.every(item => item.operation === 'GetCallerIdentity')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|synthetic-session/); await adapter.disconnect();
  });
});
