import { describe, expect, it, vi } from 'vitest';
import { createAwsCloudInstallationDriver, createAwsCloudInstallationTemplateV1 } from '../aws-cloud-installation.js';
import type { CloudInstallationIntent, CloudInstallationProviderContext } from '../../../../domain/ports/cloud-installation.port.js';
import { parseCloudInstallationIntentV1 } from '../../../../application/hosted/cloud-installation.js';

// Reconstructed CloudFormation/IAM contracts. Template assertions check independent
// required security properties; serialized native verification fixtures follow below.
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-secretsmanager-secret.html
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stacks-quick-create-links.html
const intent: CloudInstallationIntent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer-a', appId: 'app-a',
  environment: 'production', provider: 'aws', mode: 'connect', keys: ['API_KEY'], nativeScope: { accountId: '123456789012', region: 'us-west-2' },
  source: { repository: 'github.com/example/app', branch: 'main', revision: 'a'.repeat(40), specDigest: 'b'.repeat(64) },
  hostIdentity: { kind: 'gcp-service-account', projectId: 'hosting-project', projectNumber: '123456789',
    serviceAccountEmail: 'delivery@hosting-project.iam.gserviceaccount.com', subject: '123456789012345678901', issuer: 'https://accounts.google.com' } };
const context = (): CloudInstallationProviderContext => ({ intent, signal: AbortSignal.timeout(5000), completed: {}, beforeMutation: vi.fn(async () => {}),
  authentication: { host: { verifyIdentity: async () => intent.hostIdentity, getAccessToken: async () => { throw new Error('No Google OAuth needed'); },
    getIdToken: async () => { throw new Error('No customer AWS credentials before console install'); } } } });
function publishedTemplate(body: string): Response {
  const response = new Response(body, { headers: { 'x-amz-version-id': 'immutable-v1' } });
  Object.defineProperty(response, 'url', { value: `https://hypervibe-templates.s3.us-west-2.amazonaws.com/${createAwsCloudInstallationTemplateV1().sha256}.json?versionId=immutable-v1` });
  return response;
}
function driver() {
  const artifact = createAwsCloudInstallationTemplateV1();
  return createAwsCloudInstallationDriver({ templateUrl: `https://hypervibe-templates.s3.us-west-2.amazonaws.com/${artifact.sha256}.json?versionId=immutable-v1`,
    fetch: async () => publishedTemplate(artifact.body) });
}
async function nativeFixture(migrate = false, mode: 'migrate' | 'connect-existing' = 'migrate') {
  const ctx = context(), artifact = createAwsCloudInstallationTemplateV1(), template = JSON.parse(artifact.body);
  if (migrate) ctx.intent = parseCloudInstallationIntentV1({ ...intent, mode, migrationTargets: [{ key: 'API_KEY', destination: { provider: 'aws-secrets',
    accountId: '123456789012', region: 'us-west-2', secretArn: 'arn:aws:secretsmanager:us-west-2:123456789012:secret:legacy-api-key-AbCdEf' } }] }, driver());
  const requests: string[] = [], nativeParameters: Record<string, string> = {};
  const createdAt = '2026-10-24T00:00:00Z';
  const attempt = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', actionId: 'aws:install', status: 'pending' as const,
    startedAt: createdAt, updatedAt: createdAt };
  const state: { alteredTemplate: boolean; roleReplaced: boolean; policyChanged: boolean; account: string; trust: Record<string, any>; rejected: boolean } = {
    alteredTemplate: false, roleReplaced: false, policyChanged: false, account: '123456789012', trust: {}, rejected: false };
  const roleId = (name: string) => name === nativeParameters.WriterRoleName ? 'AROATESTWRITER123456789' : 'AROATESTDISCONNECT12345';
  const roleArn = (name: string) => `arn:aws:iam::123456789012:role/${name}`;
  let stackId = '';
  const secretArn = (slot: number) => nativeParameters[`ExistingSecretArn${String(slot).padStart(3, '0')}`] || `arn:aws:secretsmanager:us-west-2:123456789012:secret:${nativeParameters[`SecretName${String(slot).padStart(3, '0')}`]}-AbCdEf`;
  const resolve = (value: any): any => {
    if (Array.isArray(value)) return value.map(resolve).filter(item => item !== undefined);
    if (value && typeof value === 'object') {
      if (value.Ref) {
        if (value.Ref === 'AWS::StackId') return stackId;
        if (value.Ref === 'AWS::NoValue') return undefined;
        if (/^Secret\d{3}$/.test(value.Ref)) return secretArn(Number(value.Ref.slice(6)));
        return nativeParameters[value.Ref];
      }
      if (value['Fn::Sub']) return value['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (_: string, key: string) => ({ 'AWS::Partition': 'aws', 'AWS::AccountId': '123456789012', ...nativeParameters })[key as keyof typeof nativeParameters]);
      if (value['Fn::If']) { const [condition, yes, no] = value['Fn::If']; return resolve(nativeParameters[`${condition.startsWith('HasExisting') ? 'ExistingSecretArn' : 'SecretName'}${condition.slice(-3)}`] ? yes : no); }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    }
    return value;
  };
  const xml = (operation: string, body: string) => ({ response: { statusCode: 200, headers: { 'content-type': 'text/xml' },
    body: Buffer.from(`<${operation}Response><${operation}Result>${body}</${operation}Result><ResponseMetadata><RequestId>contract-fixture</RequestId></ResponseMetadata></${operation}Response>`) } });
  const tagXml = () => ['OwnerDigest', 'InstallationId', 'AttemptId'].map((key, index) => `<member><Key>${['hypervibe-owner', 'hypervibe-installation', 'hypervibe-attempt'][index]}</Key><Value>${nativeParameters[key]}</Value></member>`).join('');
  const handler = { handle: async (request: any) => {
    const raw = typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8');
    const body: Record<string, string> = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const operation = request.headers['x-amz-target']?.split('.').at(-1) ?? body.Action;
    requests.push(operation);
    if (operation === 'AssumeRoleWithWebIdentity') {
      const name = body.RoleArn.split('/').at(-1)!;
      if (state.trust[name]?.Statement.some((statement: any) => statement.Sid === 'HypervibeDisconnected')) {
        return { response: { statusCode: 403, headers: { 'content-type': 'text/xml' }, body: Buffer.from('<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>denied</Message></Error></ErrorResponse>') } };
      }
      const claims = JSON.parse(Buffer.from(body.WebIdentityToken.split('.')[1], 'base64url').toString());
      return xml(operation, `<Credentials><AccessKeyId>ASIA${name === nativeParameters.WriterRoleName ? 'WRITER' : 'DISCONNECT'}</AccessKeyId><SecretAccessKey>synthetic</SecretAccessKey><SessionToken>synthetic</SessionToken><Expiration>${new Date(Date.now() + 900000).toISOString()}</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::${state.account}:assumed-role/${name}/hypervibe-cloud</Arn><AssumedRoleId>${roleId(name)}:hypervibe-cloud</AssumedRoleId></AssumedRoleUser><Audience>${claims.aud}</Audience><SubjectFromWebIdentityToken>${claims.sub}</SubjectFromWebIdentityToken>`);
    }
    if (operation === 'GetCallerIdentity') {
      const name = request.headers.authorization.includes('ASIADISCONNECT') ? nativeParameters.DisconnectorRoleName : nativeParameters.WriterRoleName;
      return xml(operation, `<Account>${state.account}</Account><Arn>arn:aws:sts::${state.account}:assumed-role/${name}/hypervibe-cloud</Arn><UserId>${roleId(name)}:hypervibe-cloud</UserId>`);
    }
    if (operation === 'DescribeStacks') return xml(operation, `<Stacks><member><StackId>${stackId}</StackId><StackName>${nativeParameters.StackName}</StackName><CreationTime>${createdAt}</CreationTime><StackStatus>CREATE_COMPLETE</StackStatus><Parameters>${Object.entries(nativeParameters).filter(([key]) => key !== 'StackName').map(([key, value]) => `<member><ParameterKey>${key}</ParameterKey><ParameterValue>${value}</ParameterValue></member>`).join('')}</Parameters></member></Stacks>`);
    if (operation === 'GetTemplate') return xml(operation, `<TemplateBody>${JSON.stringify(state.alteredTemplate ? { ...template, Description: 'edited after review' } : template).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</TemplateBody>`);
    if (operation === 'ListStackResources') return xml(operation, `<StackResourceSummaries>${[['WriterRole', nativeParameters.WriterRoleName, 'AWS::IAM::Role'], ['DisconnectorRole', nativeParameters.DisconnectorRoleName, 'AWS::IAM::Role'], ...(migrate ? [] : [['Secret000', secretArn(0), 'AWS::SecretsManager::Secret']])].map(([logical, id, type]) => `<member><LogicalResourceId>${logical}</LogicalResourceId><PhysicalResourceId>${id}</PhysicalResourceId><ResourceType>${type}</ResourceType><ResourceStatus>CREATE_COMPLETE</ResourceStatus><LastUpdatedTimestamp>${createdAt}</LastUpdatedTimestamp></member>`).join('')}</StackResourceSummaries>`);
    if (operation === 'DescribeSecret') return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Buffer.from(JSON.stringify({ ARN: secretArn(0), Name: migrate ? 'legacy-api-key' : nativeParameters.SecretName000, CreatedDate: new Date(createdAt).getTime() / 1000,
      Tags: [{ Key: 'hypervibe-owner', Value: nativeParameters.OwnerDigest }, { Key: 'hypervibe-installation', Value: nativeParameters.InstallationId }, { Key: 'hypervibe-attempt', Value: nativeParameters.AttemptId }] })) } };
    const name = body.RoleName;
    const resource = name === nativeParameters.WriterRoleName ? template.Resources.WriterRole : template.Resources.DisconnectorRole;
    if (operation === 'GetRole') return xml(operation, `<Role><RoleName>${name}</RoleName><Arn>${roleArn(name)}</Arn><RoleId>${state.roleReplaced ? 'AROAREPLACED1234567890' : roleId(name)}</RoleId><CreateDate>${createdAt}</CreateDate><Tags>${tagXml()}</Tags><AssumeRolePolicyDocument>${encodeURIComponent(JSON.stringify(state.trust[name] ?? resolve(resource.Properties.AssumeRolePolicyDocument)))}</AssumeRolePolicyDocument></Role>`);
    if (operation === 'ListRolePolicies') return xml(operation, '<PolicyNames><member>hypervibe-scoped-access</member></PolicyNames><IsTruncated>false</IsTruncated>');
    if (operation === 'ListAttachedRolePolicies') return xml(operation, '<AttachedPolicies></AttachedPolicies><IsTruncated>false</IsTruncated>');
    if (operation === 'GetRolePolicy') {
      const policy = resolve(resource.Properties.Policies[0].PolicyDocument);
      if (state.policyChanged) policy.Statement[0].Action.push('secretsmanager:GetSecretValue');
      return xml(operation, `<RoleName>${name}</RoleName><PolicyName>hypervibe-scoped-access</PolicyName><PolicyDocument>${encodeURIComponent(JSON.stringify(policy))}</PolicyDocument>`);
    }
    if (operation === 'UpdateAssumeRolePolicy') { state.trust[name] = JSON.parse(body.PolicyDocument); return xml(operation, ''); }
    throw new Error(`Unimplemented synthetic transport operation ${operation}`);
  } };
  const d = createAwsCloudInstallationDriver({ templateUrl: `https://hypervibe-templates.s3.us-west-2.amazonaws.com/${artifact.sha256}.json?versionId=immutable-v1`, requestHandler: handler,
    fetch: async () => publishedTemplate(artifact.body) });
  const proposal = await d.plan(ctx), action = proposal.actions[0];
  const handoff = await d.mutate({ ...ctx, action, attempt });
  if (handoff.state !== 'external') throw new Error('Missing console link');
  const query = new URLSearchParams(new URL(handoff.url).hash.split('?')[1]);
  for (const key of Object.keys(template.Parameters)) nativeParameters[key] = query.get(`param_${key}`) ?? '';
  nativeParameters.StackName = query.get('stackName')!;
  stackId = `arn:aws:cloudformation:us-west-2:123456789012:stack/${nativeParameters.StackName}/cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
  ctx.authentication.host.getIdToken = async audience => ['e30', Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: audience,
    azp: intent.hostIdentity.subject, sub: intent.hostIdentity.subject, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'synthetic'].join('.');
  return { d, ctx, action, attempt, state, requests, nativeParameters, handler };
}
describe('AWS reviewed console installation', () => {
  it('retains all secret containers and creates no placeholder values or runtime reader privileges', () => {
    const artifact = createAwsCloudInstallationTemplateV1();
    const template = JSON.parse(artifact.body);
    const secrets = Object.values(template.Resources).filter((resource: any) => resource.Type === 'AWS::SecretsManager::Secret') as any[];
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(secret).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
      expect(secret.Properties.SecretString).toBeUndefined(); expect(secret.Properties.GenerateSecretString).toBeUndefined();
    }
    expect(artifact.body).not.toContain('GetSecretValue');
    expect(template.Resources.WriterRole.Properties.Policies[0].PolicyDocument.Statement.flatMap((item: any) => item.Action)).not.toContain('iam:UpdateAssumeRolePolicy');
    expect(template.Resources.DisconnectorRole.Properties.Policies[0].PolicyDocument.Statement.flatMap((item: any) => item.Action)).toContain('iam:UpdateAssumeRolePolicy');
  });
  it('prepares reviewed native account/resources/costs and passes only documented nonsecret console parameters', async () => {
    const d = driver(); const ctx = context(); const proposal = await d.plan(ctx);
    expect(proposal.review.permissions.some(item => item.purpose === 'hosted-trust-removal')).toBe(true);
    expect(proposal.review.costs.length).toBeGreaterThan(0);
    const action = proposal.actions[0];
    const result = await d.mutate({ ...ctx, action, attempt: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', actionId: action.id,
      status: 'attempted', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    expect(result.state).toBe('external');
    if (result.state !== 'external') throw new Error('Expected reviewed external handoff');
    const query = new URLSearchParams(new URL(result.url).hash.split('?')[1]);
    expect([...query.keys()].every(key => key === 'templateURL' || key === 'stackName' || key.startsWith('param_'))).toBe(true);
    expect(query.get('param_CustomerAccountId')).toBe('123456789012');
    expect(query.has('callback')).toBe(false); expect(ctx.beforeMutation).toHaveBeenCalledOnce();
  });
  it('does not mistake access denial for absence or successful installation after the handoff', async () => {
    const d = driver(); const ctx = context(); const proposal = await d.plan(ctx);
    const result = await d.recover({ ...ctx, action: proposal.actions[0], attempt: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', actionId: proposal.actions[0].id,
      status: 'pending', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
    expect(result.state).toBe('unknown');
  });
  it('rejects customer credentials in native scope and unversioned or non-S3 template URLs', async () => {
    const d = driver(); expect(() => d.parseScope({ ...intent.nativeScope, accessKeyId: 'forbidden' })).toThrow();
    for (const templateUrl of ['https://untrusted.example/template.json?versionId=v1', 'https://bucket.s3.us-west-2.amazonaws.com/template.json']) {
      await expect(createAwsCloudInstallationDriver({ templateUrl }).plan(context())).rejects.toThrow();
    }
  });
  it('verifies exact stack/template/role lifetime identities and preserved secret metadata through serialized SDK transport', async () => {
    const f = await nativeFixture(); const result = await f.d.recover({ ...f.ctx, action: f.action, attempt: f.attempt });
    expect(result.state).toBe('satisfied');
    if (result.state !== 'satisfied') throw new Error(JSON.stringify(result));
    expect(result.evidence.resources.map(resource => resource.kind)).toEqual(['stack', 'secret', 'writer', 'disconnector']);
    expect(f.requests).not.toContain('PutSecretValue'); expect(f.requests).not.toContain('CreateStack');
  });
  it.each(['alteredTemplate', 'roleReplaced', 'policyChanged'] as const)('blocks native %s even after console reports CREATE_COMPLETE', async field => {
    const f = await nativeFixture(); f.state[field] = true;
    expect((await f.d.recover({ ...f.ctx, action: f.action, attempt: f.attempt })).state).toBe('unknown');
  });
  it.each([false, true])('disconnects separate writer and self trust while preserving existing targets (%s) and lost-session recovery', async existing => {
    const f = await nativeFixture(existing, 'connect-existing'); const installed = await f.d.recover({ ...f.ctx, action: f.action, attempt: f.attempt });
    expect(installed.state).toBe('satisfied'); if (installed.state !== 'satisfied') return;
    const disconnect = { ...f.ctx, intent: { ...f.ctx.intent, installationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', mode: 'disconnect' as const, installed: [installed.evidence] } };
    const plan = await f.d.plan(disconnect);
    for (const action of plan.actions) {
      const attempt = { ...f.attempt, actionId: action.id };
      expect((await f.d.mutate({ ...disconnect, action, attempt })).state).toBe('acknowledged');
      expect((await f.d.recover({ ...disconnect, action, attempt })).state).toBe('satisfied');
    }
    expect(f.requests.filter(name => name === 'UpdateAssumeRolePolicy')).toHaveLength(2);
    expect(f.requests.filter(name => /Delete|PutSecret/.test(name))).toEqual([]);
    const restarted = createAwsCloudInstallationDriver({ requestHandler: f.handler });
    expect((await restarted.recover({ ...disconnect, action: plan.actions[1], attempt: { ...f.attempt, actionId: plan.actions[1].id } })).state).toBe('unknown');
  });
  it.each(['migrate', 'connect-existing'] as const)('%s installs only writer authority for the exact native ARN without an old writer or secret mutation', async mode => {
    const f = await nativeFixture(true, mode);
    expect(f.nativeParameters.SecretName000).toBe('');
    expect(f.nativeParameters.ExistingSecretArn000).toBe('arn:aws:secretsmanager:us-west-2:123456789012:secret:legacy-api-key-AbCdEf');
    const result = await f.d.recover({ ...f.ctx, action: f.action, attempt: f.attempt });
    expect(result.state).toBe('satisfied');
    expect(f.requests.filter(operation => /CreateSecret|PutSecret|Delete|Update/.test(operation))).toEqual([]);
    if (result.state === 'satisfied') expect(result.evidence.resources.find(resource => resource.kind === 'secret')?.id).toBe(f.nativeParameters.ExistingSecretArn000);
  });
});
