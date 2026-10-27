import { ECS_BOOTSTRAP_COMMAND, ECS_BOOTSTRAP_IMAGE } from '../ecs-installed-configuration.js';
import { describe, expect, it, vi } from 'vitest';
import { createAwsCloudInstallationDriver } from '../aws-cloud-installation.js';
import { createAwsCloudDeploymentTemplateV1 } from '../aws-cloud-deployment.js';
import { planCloudInstallationV1, applyCloudInstallationV1, reconcileCloudInstallationV1, cloudInstallationDeploymentConnectionV1, cloudInstallationDisconnectionIntentV1 } from '../../../../application/hosted/cloud-installation.js';
import { issueCloudDeploymentSessionV1, verifyCloudDeploymentReleaseTargetsV1 } from '../../../../application/hosted/cloud-deployment-session.js';
import type { CloudInstallationIntent, CloudInstallationRecord } from '../../../../domain/ports/cloud-installation.port.js';

function publishedTemplate(body: string): Response {
  const response = new Response(body, { headers: { 'x-amz-version-id': 'v1' } });
  Object.defineProperty(response, 'url', { value: `https://templates.s3.us-west-2.amazonaws.com/${createAwsCloudDeploymentTemplateV1().sha256}.json?versionId=v1` });
  return response;
}

// Provider-native IAM security properties derive from the official ECS action/role contract.
// https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html
// https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html
const intent: CloudInstallationIntent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer', appId: 'app', environment: 'production',
  provider: 'aws', purpose: 'deployment', stage: 'deployment', mode: 'connect', keys: [], nativeScope: { accountId: '123456789012', region: 'us-west-2' },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  deployment: { hostingProvider: 'ecs', region: 'us-west-2', workloads: [{ name: 'web', kind: 'web', runtimeSecrets: [] }] },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789', serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com',
    subject: '123456789012345678901', issuer: 'https://accounts.google.com' } };

// Reconstructed CloudFormation/IAM Query envelopes. Policies are a synthetic
// installed-template model, checked separately against the security properties below.
async function nativeFixture() {
  const artifact = createAwsCloudDeploymentTemplateV1(), template = JSON.parse(artifact.body), parameters: Record<string, string> = {};
  const records = new Map<string, CloudInstallationRecord>(), requests: string[] = [];
  const state = { bootstrap: false, unsafeBootstrap: false, replaced: false, replacedRuntime: false, replacedService: false, alteredTemplate: false, extraPolicy: false, loseCleanup: false, error: '', trust: {} as Record<string, any> };
  const kinds = ['provision', 'release', 'disconnector', 'task', 'execution', 'infrastructure'];
  const kindFor = (name: string) => kinds.find(kind => parameters[`${kind}RoleName`] === name)!;
  const roleId = (kind: string) => 'AROA' + String(kinds.indexOf(kind) + 1).repeat(17);
  const keyId = (kind: string) => 'ASIA' + String(kinds.indexOf(kind) + 1).repeat(17);
  let stackId = '';
  const resolve = (value: any): any => {
    if (Array.isArray(value)) return value.map(resolve).filter(item => item !== undefined);
    if (value && typeof value === 'object') {
      if (value.Ref) return ({ 'AWS::StackId': stackId, 'AWS::AccountId': '123456789012', 'AWS::Region': 'us-west-2', ...parameters } as Record<string, string>)[value.Ref];
      if (value['Fn::Sub']) return value['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (_: string, key: string) => ({ 'AWS::AccountId': '123456789012', 'AWS::Region': 'us-west-2', ...parameters })[key]);
      if (value['Fn::If']) { const [condition, yes, no] = value['Fn::If']; return resolve(parameters[condition.slice(3)] ? yes : no); }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    }
    return value;
  };
  const xml = (operation: string, body: string) => ({ response: { statusCode: 200, headers: { 'content-type': 'text/xml' },
    body: Buffer.from(`<${operation}Response><${operation}Result>${body}</${operation}Result></${operation}Response>`) } });
  const handler = { handle: async (request: any) => {
    const raw = typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString();
    const query = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); const operation = request.headers['x-amz-target']?.split('.').at(-1) ?? query.Action; requests.push(operation);
    if (operation === 'GetRole' && state.error) return { response: { statusCode: state.error === 'AccessDenied' ? 403 : 500, headers: { 'content-type': 'text/xml' },
      body: Buffer.from(`<ErrorResponse><Error><Type>Sender</Type><Code>${state.error}</Code><Message>synthetic-private-echo</Message></Error><RequestId>synthetic</RequestId></ErrorResponse>`) } };
    const json = (body: unknown) => ({ response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify(body)) } });
    if (operation === 'DescribeExpressGatewayService') return json({ service: { serviceArn: query.serviceArn, serviceName: 'web', cluster: `arn:aws:ecs:us-west-2:123456789012:cluster/${parameters.ClusterName}`,
      createdAt: state.replacedService ? 1_700_000_001 : 1_700_000_000, status: { statusCode: 'ACTIVE' }, currentDeployment: 'revision-1',
      tags: [{ key: 'hypervibe-owner', value: parameters.OwnerDigest }, { key: 'hypervibe-installation', value: parameters.InstallationId }],
      activeConfigurations: [{ serviceRevisionArn: 'revision-1', taskDefinitionArn: 'arn:aws:ecs:us-west-2:123456789012:task-definition/native:1' }] } });
    if (operation === 'DescribeTaskDefinition') return json({ taskDefinition: { taskDefinitionArn: query.taskDefinition,
      status: 'ACTIVE', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'],
      ...(state.bootstrap ? {} : { taskRoleArn: `arn:aws:iam::123456789012:role/${parameters.taskRoleName}` }),
      executionRoleArn: `arn:aws:iam::123456789012:role/${parameters.executionRoleName}`,
      containerDefinitions: [{ name: 'Main', image: state.bootstrap ? ECS_BOOTSTRAP_IMAGE : 'example/application@sha256:' + 'a'.repeat(64),
        ...(state.bootstrap ? { command: ECS_BOOTSTRAP_COMMAND } : {}), portMappings: [{ name: 'http', containerPort: 8080, protocol: 'tcp' }],
        environment: state.unsafeBootstrap ? [{ name: 'UNREVIEWED', value: 'unsafe' }] : [], secrets: [] }] } });
    if (operation === 'DescribeRepositories') return json({ repositories: [{ repositoryArn: `arn:aws:ecr:us-west-2:123456789012:repository/hypervibe/${parameters.ClusterName}`, repositoryName: `hypervibe/${parameters.ClusterName}`, createdAt: 1_700_000_000 }] });
    if (operation === 'ListTagsForResource') return json({ tags: [{ Key: 'hypervibe-owner', Value: parameters.OwnerDigest }, { Key: 'hypervibe-installation', Value: parameters.InstallationId }] });
    if (operation === 'AssumeRoleWithWebIdentity') {
      const kind = kindFor(query.RoleArn.split('/').at(-1)!); const claims = JSON.parse(Buffer.from(query.WebIdentityToken.split('.')[1], 'base64url').toString());
      return xml(operation, `<Credentials><AccessKeyId>${keyId(kind)}</AccessKeyId><SecretAccessKey>synthetic-secret</SecretAccessKey><SessionToken>synthetic-session</SessionToken><Expiration>${new Date(Date.now() + 900_000).toISOString()}</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/${parameters[`${kind}RoleName`]}/hypervibe-cloud</Arn><AssumedRoleId>${roleId(kind)}:hypervibe-cloud</AssumedRoleId></AssumedRoleUser><Audience>${claims.aud}</Audience><SubjectFromWebIdentityToken>${claims.sub}</SubjectFromWebIdentityToken>`);
    }
    if (operation === 'GetCallerIdentity') { const kind = kinds.find(kind => request.headers.authorization.includes(keyId(kind)))!;
      return xml(operation, `<Account>123456789012</Account><UserId>${roleId(kind)}:hypervibe-cloud</UserId><Arn>arn:aws:sts::123456789012:assumed-role/${parameters[`${kind}RoleName`]}/hypervibe-cloud</Arn>`); }
    if (operation === 'DescribeStacks') return xml(operation, `<Stacks><member><StackId>${stackId}</StackId><StackName>${parameters.StackName}</StackName><CreationTime>2026-10-24T00:00:00Z</CreationTime><StackStatus>CREATE_COMPLETE</StackStatus><Parameters>${Object.entries(parameters).filter(([key]) => key !== 'StackName').map(([key, value]) => `<member><ParameterKey>${key}</ParameterKey><ParameterValue>${value}</ParameterValue></member>`).join('')}</Parameters></member></Stacks>`);
    if (operation === 'GetTemplate') return xml(operation, `<TemplateBody>${(state.alteredTemplate ? '{}' : artifact.body).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</TemplateBody>`);
    if (operation === 'ListStackResources') return xml(operation, `<StackResourceSummaries>${kinds.map(kind => `<member><LogicalResourceId>${kind[0].toUpperCase() + kind.slice(1)}Role</LogicalResourceId><PhysicalResourceId>${parameters[`${kind}RoleName`]}</PhysicalResourceId><ResourceType>AWS::IAM::Role</ResourceType><ResourceStatus>CREATE_COMPLETE</ResourceStatus></member>`).join('')}</StackResourceSummaries>`);
    const kind = kindFor(query.RoleName), properties = resolve(template.Resources[kind[0].toUpperCase() + kind.slice(1) + 'Role'].Properties);
    if (operation === 'GetRole') return xml(operation, `<Role><RoleName>${query.RoleName}</RoleName><Arn>arn:aws:iam::123456789012:role/${query.RoleName}</Arn><RoleId>${state.replaced || state.replacedRuntime && kind === 'execution' ? 'AROA99999999999999999' : roleId(kind)}</RoleId><Tags>${properties.Tags.map((tag: any) => `<member><Key>${tag.Key}</Key><Value>${tag.Value}</Value></member>`).join('')}</Tags><AssumeRolePolicyDocument>${encodeURIComponent(JSON.stringify(state.trust[kind] ?? properties.AssumeRolePolicyDocument))}</AssumeRolePolicyDocument></Role>`);
    if (operation === 'ListRolePolicies') return xml(operation, `<PolicyNames>${(properties.Policies ?? []).map((policy: any) => `<member>${policy.PolicyName}</member>`).join('')}${state.extraPolicy ? '<member>unexpected-broader-permissions</member>' : ''}</PolicyNames><IsTruncated>false</IsTruncated>`);
    if (operation === 'ListAttachedRolePolicies') return xml(operation, `<AttachedPolicies>${(properties.ManagedPolicyArns ?? []).map((arn: string) => `<member><PolicyArn>${arn}</PolicyArn></member>`).join('')}</AttachedPolicies><IsTruncated>false</IsTruncated>`);
    if (operation === 'GetRolePolicy') return xml(operation, `<RoleName>${query.RoleName}</RoleName><PolicyName>${query.PolicyName}</PolicyName><PolicyDocument>${encodeURIComponent(JSON.stringify(properties.Policies[0].PolicyDocument))}</PolicyDocument>`);
    if (operation === 'UpdateAssumeRolePolicy') { state.trust[kind] = JSON.parse(query.PolicyDocument); if (state.loseCleanup) { state.loseCleanup = false; throw new Error('Synthetic lost acknowledgment'); } return xml(operation, ''); }
    throw new Error('Unimplemented reconstructed transport operation');
  } };
  const driver = createAwsCloudInstallationDriver({ deploymentTemplateUrl: `https://templates.s3.us-west-2.amazonaws.com/${artifact.sha256}.json?versionId=v1`, requestHandler: handler, fetch: async () => publishedTemplate(artifact.body) });
  const host = { verifyIdentity: async () => intent.hostIdentity, getAccessToken: async () => '', getIdToken: async (audience: string) => ['e30', Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', sub: intent.hostIdentity.subject,
    azp: intent.hostIdentity.subject, aud: audience, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'synthetic'].join('.') };
  const context = { driver, authentication: { host }, authorize: async () => true, store: {
    read: async (id: string) => records.has(id) ? structuredClone(records.get(id)!) : null,
    compareAndSwap: async (id: string, revision: number | null, next: CloudInstallationRecord) => { if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, structuredClone(next)); return true; } } };
  const plan = await planCloudInstallationV1({ ...context, intent });
  const applied = await applyCloudInstallationV1({ ...context, installationId: intent.installationId, planDigest: plan.plan.digest, confirmActions: plan.plan.actions.map(action => action.id) });
  const query = new URLSearchParams(new URL(applied.attempts[0].externalUrl!).hash.split('?')[1]);
  for (const key of Object.keys(template.Parameters)) parameters[key] = query.get(`param_${key}`) ?? '';
  parameters.StackName = query.get('stackName')!; stackId = `arn:aws:cloudformation:us-west-2:123456789012:stack/${parameters.StackName}/cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
  return { context, state, requests, records, driver, parameters };
}
describe('AWS reviewed deployment installation', () => {
  // Explicit names can equal another logical name's deterministic SHA256 suffix.
  it.each([['Web', 'web-29751047'], ['web_api', 'web-api-70f1e97b']])('rejects two logical workloads sharing one native service name (%s, %s)', async (first, second) => {
    const artifact = createAwsCloudDeploymentTemplateV1(), fetch = vi.fn(async () => publishedTemplate(artifact.body));
    const driver = createAwsCloudInstallationDriver({ deploymentTemplateUrl: `https://templates.s3.us-west-2.amazonaws.com/${artifact.sha256}.json?versionId=v1`, fetch });
    await expect(driver.plan({ intent: { ...intent, deployment: { ...intent.deployment!, workloads: [first, second].map(name => ({ name, kind: 'web', runtimeSecrets: [] })) } },
      authentication: { host: { verifyIdentity: async () => intent.hostIdentity, getIdToken: async () => '', getAccessToken: async () => '' } }, signal: AbortSignal.timeout(5000), completed: {}, beforeMutation: async () => {} })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([['AccessDenied', 'insufficient_permissions'], ['ServiceFailure', 'provider_error']])('preserves the closed %s failure category without forwarding native echoes', async (code, reason) => {
    const f = await nativeFixture(); f.state.error = code;
    const observed = await reconcileCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: f.records.get(intent.installationId)!.plan.digest });
    expect(observed.reason).toBe(reason); expect(JSON.stringify(observed)).not.toContain('synthetic-private-echo');
    expect(f.requests.some(operation => /^(Create|Update|Delete|Put|Tag|Attach)/.test(operation))).toBe(false);
  });
  it('verifies applied release targets against retained lifetime pins and rejects same-name service replacement', async () => {
    const f = await nativeFixture(); const ready = await reconcileCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: f.records.get(intent.installationId)!.plan.digest });
    const connection = cloudInstallationDeploymentConnectionV1(ready, f.driver), clusterArn = `arn:aws:ecs:us-west-2:123456789012:cluster/${f.parameters.ClusterName}`;
    const input = { connection, driver: f.driver, authentication: f.context.authentication, authorize: async () => true, signal: AbortSignal.timeout(5000), source: intent.source,
      spec: { environments: { production: { hosting: { provider: 'ecs', region: 'us-west-2' }, services: { web: { workloadKind: 'web' } } } } } as any,
      bindings: { provider: 'ecs', projectId: clusterArn, environmentId: clusterArn, services: { web: { serviceId: clusterArn.replace(':cluster/', ':service/') + '/web', resourceUid: '2023-11-14T22:13:20.000Z' } },
        awsDeploymentRegistry: { id: `arn:aws:ecr:us-west-2:123456789012:repository/hypervibe/${f.parameters.ClusterName}`, createdAt: '2023-11-14T22:13:20.000Z' } } };
    expect((await verifyCloudDeploymentReleaseTargetsV1(input)).targets).toHaveLength(1);
    f.state.bootstrap = true; expect((await verifyCloudDeploymentReleaseTargetsV1(input)).targets).toHaveLength(1);
    f.state.unsafeBootstrap = true; await expect(verifyCloudDeploymentReleaseTargetsV1(input)).rejects.toThrow(); f.state.unsafeBootstrap = false;
    f.state.bootstrap = false;
    f.state.replacedRuntime = true; await expect(verifyCloudDeploymentReleaseTargetsV1(input)).rejects.toThrow(); f.state.replacedRuntime = false;
    f.state.replacedService = true; await expect(verifyCloudDeploymentReleaseTargetsV1(input)).rejects.toThrow();
    expect(f.requests.some(operation => /^(Create|Update|Delete|Put|Tag|Attach)/.test(operation))).toBe(false);
  });
  it('rejects declared inline runtime secret slots before hosted source admission', async () => {
    const f = await nativeFixture();
    const ready = await reconcileCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: f.records.get(intent.installationId)!.plan.digest });
    const connection = cloudInstallationDeploymentConnectionV1(ready, f.driver);
    const spec = { secrets: { INLINE_KEY: { ownership: 'delegated', environments: ['production'] } },
      environments: { production: { hosting: { provider: 'ecs', region: 'us-west-2' }, services: { web: { workloadKind: 'web' } } } } } as any;
    expect(() => f.driver.deployment!.assertSourcePlacement!(spec, connection)).toThrow();
    expect(f.requests.some(operation => /^(Create|Update|Delete|Put|Tag|Attach)/.test(operation))).toBe(false);
  });
  it('verifies native stack, distinct roles and final session purpose through serialized transports', async () => {
    const f = await nativeFixture(); const ready = await reconcileCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: f.records.get(intent.installationId)!.plan.digest });
    expect(ready.status).toBe('ready'); const connection = cloudInstallationDeploymentConnectionV1(ready, f.driver);
    expect(connection.principals.provision).not.toEqual(connection.principals.release); expect(connection.runtimeIdentities).toHaveLength(3);
    const issued = await issueCloudDeploymentSessionV1({ connection, capability: 'release', driver: f.driver, authentication: f.context.authentication, authorize: async () => true, signal: AbortSignal.timeout(5000) });
    expect(issued.principal).toEqual(connection.principals.release);
    f.state.replaced = true;
    await expect(issueCloudDeploymentSessionV1({ connection, capability: 'release', driver: f.driver, authentication: f.context.authentication, authorize: async () => true, signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    expect(f.requests.some(operation => /CreateRole|PutRolePolicy|GetSecretValue/.test(operation))).toBe(false);
  });
  it.each(['replaced', 'alteredTemplate', 'extraPolicy'] as const)('blocks native %s after external installation and never retries creation', async field => {
    const f = await nativeFixture(); f.state[field] = true;
    expect((await reconcileCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: f.records.get(intent.installationId)!.plan.digest })).status).toBe('pending');
    expect(f.requests.some(operation => /CreateRole|CreateStack/.test(operation))).toBe(false);
  });
  it('read-only reconciles a lost cleanup acknowledgment before continuing and preserves runtime roles', async () => {
    const f = await nativeFixture(); const ready = await reconcileCloudInstallationV1({ ...f.context, installationId: intent.installationId, planDigest: f.records.get(intent.installationId)!.plan.digest });
    const cleanup = cloudInstallationDisconnectionIntentV1(ready, f.driver, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')!;
    const plan = await planCloudInstallationV1({ ...f.context, intent: cleanup }); f.state.loseCleanup = true;
    const result = await applyCloudInstallationV1({ ...f.context, installationId: cleanup.installationId, planDigest: plan.plan.digest, confirmActions: plan.plan.actions.map(action => action.id) });
    const recovered = result.status === 'disconnected' ? result : await reconcileCloudInstallationV1({ ...f.context, installationId: cleanup.installationId, planDigest: plan.plan.digest });
    const finished = recovered.status === 'disconnected' ? recovered : await applyCloudInstallationV1({ ...f.context, installationId: cleanup.installationId, planDigest: plan.plan.digest, confirmActions: plan.plan.actions.map(action => action.id) });
    expect(finished.status).toBe('disconnected'); expect(f.requests.filter(operation => operation === 'UpdateAssumeRolePolicy')).toHaveLength(3);
    expect(Object.keys(f.state.trust).sort()).toEqual(['disconnector', 'provision', 'release']);
    expect(f.requests.some(operation => /DeleteRole|DeleteSecret|DeleteCluster/.test(operation))).toBe(false);
  });
  it('separates provision/release/runtime/disconnection and never grants deployment IAM writes or secret reads', () => {
    const template = JSON.parse(createAwsCloudDeploymentTemplateV1().body);
    expect(Object.values(template.Resources).map((resource: any) => resource.Type)).toEqual(Array(6).fill('AWS::IAM::Role'));
    for (const name of ['Provision', 'Release']) {
      const policies = template.Resources[`${name}Role`].Properties.Policies;
      const actions = policies.flatMap((policy: any) => policy.PolicyDocument.Statement.flatMap((statement: any) => statement.Action));
      expect(actions).toContain('iam:PassRole'); expect(actions).not.toContain('iam:CreateRole'); expect(actions).not.toContain('iam:AttachRolePolicy');
      expect(actions).not.toContain('iam:UpdateAssumeRolePolicy'); expect(actions).not.toContain('secretsmanager:GetSecretValue');
      if (name === 'Release') { expect(actions).not.toContain('ecs:CreateCluster'); expect(actions).not.toContain('ecr:CreateRepository'); }
    }
    expect(JSON.stringify(template.Resources.ExecutionRole)).toContain('secretsmanager:GetSecretValue');
    expect(JSON.stringify(template.Resources.TaskRole)).not.toContain('secretsmanager:GetSecretValue');
    expect(JSON.stringify(template.Resources.DisconnectorRole)).toContain('iam:UpdateAssumeRolePolicy');
  });
  it('uses the real shared review/apply journal for a value-free create-only console handoff', async () => {
    const artifact = createAwsCloudDeploymentTemplateV1(); let saved: CloudInstallationRecord | null = null;
    const getIdToken = vi.fn(async () => { throw new Error('No account credentials before browser installation'); });
    const driver = createAwsCloudInstallationDriver({ deploymentTemplateUrl: `https://templates.s3.us-west-2.amazonaws.com/${artifact.sha256}.json?versionId=v1`, fetch: async () => publishedTemplate(artifact.body) });
    const context = { driver, authorize: async () => true, authentication: { host: { verifyIdentity: async () => intent.hostIdentity, getIdToken, getAccessToken: async () => '' } },
      store: { read: async () => saved, compareAndSwap: async (_id: string, version: number | null, next: CloudInstallationRecord) => { if ((saved?.revision ?? null) !== version) return false; saved = structuredClone(next); return true; } } };
    const plan = await planCloudInstallationV1({ ...context, intent });
    expect(plan.plan.review.permissions.map(permission => permission.purpose)).toEqual(expect.arrayContaining(['deployment-provision', 'deployment-release', 'runtime-reader', 'hosted-trust-removal']));
    const result = await applyCloudInstallationV1({ ...context, installationId: intent.installationId, planDigest: plan.plan.digest, confirmActions: plan.plan.actions.map(action => action.id) });
    expect(result.status).toBe('pending'); expect(result.attempts).toHaveLength(1);
    const url = new URL(result.attempts[0].externalUrl!); expect(url.hostname).toBe('us-west-2.console.aws.amazon.com');
    expect(JSON.stringify(result)).not.toMatch(/accessKeyId|secretAccessKey|sessionToken/);
    expect(getIdToken).not.toHaveBeenCalled();
  });
});
