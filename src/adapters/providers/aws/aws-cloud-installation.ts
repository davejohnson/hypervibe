import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { GetRoleCommand, GetRolePolicyCommand, IAMClient, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand, UpdateAssumeRolePolicyCommand } from '@aws-sdk/client-iam';
import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { STSClientConfig } from '@aws-sdk/client-sts';
import type { CloudInstallationAction, CloudInstallationAttempt, CloudInstallationDriver, CloudInstallationEvidence, CloudInstallationIntent,
  CloudInstallationObservation, CloudInstallationProviderContext, CloudInstallationReason } from '../../../domain/ports/cloud-installation.port.js';
import { CloudInstallationBoundaryError } from '../../../domain/ports/cloud-installation.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { boundAwsSdkResponses } from './aws-secret-destination.js';
import { createAwsFederatedCredentialProvider, type AwsFederatedCredentials } from './aws-federated-auth.js';

const MAX_SECRETS = 50; // Keeps aggregate inline IAM policy below its native 10,240-character limit.
const policyName = 'hypervibe-scoped-access';
const uuid = z.string().uuid();
const scopeSchema = z.object({ accountId: z.string().regex(/^\d{12}$/), region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/) }).strict();
const roleArnSchema = z.string().regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_-]+$/);
const nativeSchema = z.object({ operation: z.enum(['install', 'revoke-writer', 'revoke-disconnector']), installationId: uuid,
  owner: z.string().regex(/^[a-f0-9]{64}$/), stackName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,127}$/),
  writerRoleArn: roleArnSchema, disconnectorRoleArn: roleArnSchema, templateDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['stack', 'writer', 'disconnector', 'secret']), id: z.string().min(1).max(2048),
  identity: z.object({ roleId: z.string().regex(/^[A-Z0-9]{16,128}$/).optional(), createTime: z.string().datetime().optional(),
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional() }).strict() }).strict()).min(1).max(MAX_SECRETS + 3),
  native: nativeSchema.extend({ attemptId: uuid, stackId: z.string().regex(/^arn:aws:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z0-9-]+\/[a-f0-9-]+$/) }).strict(),
}).strict();
type Context = CloudInstallationProviderContext & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
type Policy = { Version: string; Statement: Array<Record<string, any>> };
class InstallationError extends CloudInstallationBoundaryError {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function equal(a: unknown, b: unknown) { return canonical(a) === canonical(b); }
function ref(name: string) { return { Ref: name }; }
function sub(value: string) { return { 'Fn::Sub': value }; }
function trust(subject: unknown, audience: unknown, sid: string, effect = 'Allow'): Policy {
  return { Version: '2012-10-17', Statement: [{ Sid: sid, Effect: effect, Principal: { Federated: 'accounts.google.com' },
    Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: { 'accounts.google.com:aud': subject,
      'accounts.google.com:oaud': audience, 'accounts.google.com:sub': subject } } }] };
}
function writerPolicy(secretArns: unknown[], stackId: unknown, roles: unknown[]): Policy {
  return { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:ListSecretVersionIds', 'secretsmanager:PutSecretValue'], Resource: secretArns },
    { Effect: 'Allow', Action: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:ListStackResources'], Resource: stackId },
    { Effect: 'Allow', Action: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'], Resource: roles },
  ] };
}
function disconnectorPolicy(roles: unknown[]): Policy {
  return { Version: '2012-10-17', Statement: [{ Effect: 'Allow',
    Action: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:UpdateAssumeRolePolicy'], Resource: roles }] };
}
/** Publish these exact bytes under an immutable S3 object version in an approved operator release. */
export function createAwsCloudInstallationTemplateV1(): { body: string; sha256: string } {
  const parameters: Record<string, any> = {
    CustomerAccountId: { Type: 'String', AllowedPattern: '^\\d{12}$' }, HostSubject: { Type: 'String', AllowedPattern: '^[1-9]\\d{5,29}$' },
    OwnerDigest: { Type: 'String', AllowedPattern: '^[a-f0-9]{64}$' }, InstallationId: { Type: 'String' }, AttemptId: { Type: 'String' },
    WriterRoleName: { Type: 'String' }, DisconnectorRoleName: { Type: 'String' }, WriterAudience: { Type: 'String' }, DisconnectorAudience: { Type: 'String' },
  };
  const conditions: Record<string, any> = { ApprovedAccount: { 'Fn::Equals': [ref('AWS::AccountId'), ref('CustomerAccountId')] } };
  const resources: Record<string, any> = {};
  const tags = [{ Key: 'hypervibe-owner', Value: ref('OwnerDigest') }, { Key: 'hypervibe-installation', Value: ref('InstallationId') }, { Key: 'hypervibe-attempt', Value: ref('AttemptId') }];
  const secretArns: unknown[] = [];
  for (let slot = 0; slot < MAX_SECRETS; slot++) {
    const suffix = String(slot).padStart(3, '0'), parameter = `SecretName${suffix}`, logicalId = `Secret${suffix}`, condition = `HasSecret${suffix}`;
    parameters[parameter] = { Type: 'String', Default: '', AllowedPattern: '^[A-Za-z0-9/_+=.@-]{0,48}$' };
    const existing = `ExistingSecretArn${suffix}`, hasExisting = `HasExistingSecret${suffix}`;
    parameters[existing] = { Type: 'String', Default: '', AllowedPattern: '^(?:|arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6})$' };
    conditions[condition] = { 'Fn::And': [{ Condition: 'ApprovedAccount' }, { 'Fn::Not': [{ 'Fn::Equals': [ref(parameter), ''] }] }] };
    conditions[hasExisting] = { 'Fn::And': [{ Condition: 'ApprovedAccount' }, { 'Fn::Not': [{ 'Fn::Equals': [ref(existing), ''] }] }] };
    resources[logicalId] = { Type: 'AWS::SecretsManager::Secret', Condition: condition, DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: { Name: ref(parameter), Description: 'Hypervibe application environment secret', Tags: tags } };
    secretArns.push({ 'Fn::If': [hasExisting, ref(existing), { 'Fn::If': [condition, ref(logicalId), ref('AWS::NoValue')] }] });
  }
  const roles = [sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${WriterRoleName}'), sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${DisconnectorRoleName}')];
  for (const role of ['Writer', 'Disconnector']) resources[`${role}Role`] = { Type: 'AWS::IAM::Role', Condition: 'ApprovedAccount', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
    Properties: { RoleName: ref(`${role}RoleName`), MaxSessionDuration: 3600, Tags: tags,
      AssumeRolePolicyDocument: trust(ref('HostSubject'), ref(`${role}Audience`), `Hypervibe${role}`),
      Policies: [{ PolicyName: policyName, PolicyDocument: role === 'Writer' ? writerPolicy(secretArns, ref('AWS::StackId'), roles) : disconnectorPolicy(roles) }] } };
  const body = JSON.stringify({ AWSTemplateFormatVersion: '2010-09-09', Description: 'Hypervibe reviewed secret collection: isolated writer and trust-removal identities; secrets retained.',
    Parameters: parameters, Conditions: conditions, Resources: resources });
  return { body, sha256: createHash('sha256').update(body).digest('hex') };
}
function settings(intent: CloudInstallationIntent) {
  if (intent.provider !== 'aws' || intent.keys.length > MAX_SECRETS) throw new InstallationError('identity_mismatch');
  const scope = scopeSchema.parse(intent.nativeScope);
  const installationIds = intent.mode === 'disconnect' ? (intent.installed ?? []).map(item => evidenceSchema.parse(item).native.installationId) : [intent.installationId];
  if (!installationIds.length || new Set(installationIds).size !== 1) throw new InstallationError('ownership_mismatch');
  const installationId = installationIds[0];
  const parts = [intent.customerId, intent.appId, intent.environment, installationId];
  const owner = hash({ parts, scope, host: intent.hostIdentity });
  const stackName = resourceName('hypervibe-secrets', { scope: parts, maxLength: 100 });
  const writerName = resourceName('writer', { scope: parts, maxLength: 64 });
  const disconnectorName = resourceName('disconnect', { scope: parts, maxLength: 64 });
  if (intent.mode === 'migrate' && !intent.migrationTargets?.length) throw new InstallationError('ownership_mismatch');
  const secrets = [...intent.keys].sort().map(key => {
    const target = intent.migrationTargets?.find(item => item.key === key)?.destination;
    if (intent.migrationTargets && (!target || target.provider !== 'aws-secrets' || target.accountId !== scope.accountId || target.region !== scope.region))
      throw new InstallationError('identity_mismatch');
    const arn = target?.provider === 'aws-secrets' ? target.secretArn : undefined;
    return { key, name: arn ? arn.split(':secret:')[1].slice(0, -7) : resourceName(key, { scope: parts, maxLength: 48 }), ...(arn ? { arn } : {}) };
  });
  if (new Set(secrets.map(item => item.name)).size !== secrets.length) throw new InstallationError('identity_mismatch');
  return { ...scope, installationId, owner, stackName, writerName, disconnectorName, secrets,
    writerRoleArn: `arn:aws:iam::${scope.accountId}:role/${writerName}`, disconnectorRoleArn: `arn:aws:iam::${scope.accountId}:role/${disconnectorName}`,
    writerAudience: `https://hypervibe.dev/cloud-installations/${owner}/writer`, disconnectorAudience: `https://hypervibe.dev/cloud-installations/${owner}/disconnect` };
}
function native(intent: CloudInstallationIntent, operation: 'install' | 'revoke-writer' | 'revoke-disconnector') {
  const s = settings(intent);
  return { operation, installationId: s.installationId, owner: s.owner, stackName: s.stackName, writerRoleArn: s.writerRoleArn,
    disconnectorRoleArn: s.disconnectorRoleArn, templateDigest: createAwsCloudInstallationTemplateV1().sha256 };
}
function parameters(intent: CloudInstallationIntent, attemptId: string): Record<string, string> {
  const s = settings(intent);
  const result: Record<string, string> = { CustomerAccountId: s.accountId, HostSubject: intent.hostIdentity.subject, OwnerDigest: s.owner,
    InstallationId: s.installationId, AttemptId: attemptId, WriterRoleName: s.writerName, DisconnectorRoleName: s.disconnectorName,
    WriterAudience: s.writerAudience, DisconnectorAudience: s.disconnectorAudience };
  for (let slot = 0; slot < MAX_SECRETS; slot++) {
    const suffix = String(slot).padStart(3, '0'), secret = s.secrets[slot];
    result[`SecretName${suffix}`] = secret?.arn ? '' : secret?.name ?? '';
    result[`ExistingSecretArn${suffix}`] = secret?.arn ?? '';
  }
  return result;
}
function parsedPolicy(value: unknown): Policy {
  try {
    const policy = typeof value === 'string' ? JSON.parse(decodeURIComponent(value)) : value;
    if (!policy || policy.Version !== '2012-10-17' || !Array.isArray(policy.Statement)) throw new Error();
    return policy;
  } catch { throw new InstallationError('identity_mismatch'); }
}
function failure(error: unknown): CloudInstallationReason {
  if (error instanceof InstallationError) return error.reason;
  if (error instanceof DestinationBoundaryError) return error.code === 'access_denied' ? 'insufficient_permissions'
    : error.code === 'scope_mismatch' ? 'identity_mismatch' : error.code === 'deadline_exceeded' ? 'timeout' : 'provider_error';
  return 'provider_error';
}
export function createAwsCloudInstallationDriver(options: { templateUrl?: string; requestHandler?: STSClientConfig['requestHandler']; fetch?: typeof fetch } = {}): CloudInstallationDriver {
  const retainedSessions = new Map<string, AwsFederatedCredentials>(); // Process-local only; never serialized for recovery.
  const publication = () => {
    try {
      const url = new URL(options.templateUrl ?? '');
      if (url.protocol !== 'https:' || !/^[a-z0-9.-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
        || url.username || url.password || url.port || url.hash || !url.searchParams.get('versionId')
        || [...url.searchParams.keys()].some(key => key !== 'versionId') || !url.pathname.endsWith(`/${createAwsCloudInstallationTemplateV1().sha256}.json`)) throw new Error();
      return url.toString();
    } catch { throw new InstallationError('not_installed'); }
  };
  const verifyPublication = async (signal: AbortSignal) => {
    const url = publication(), budget = new DestinationBudget({ signal });
    try {
      const response = await budget.wait((options.fetch ?? fetch)(url, { redirect: 'error', signal: budget.signal }));
      if (!response.ok || response.redirected || !response.body) { void response.body?.cancel().catch(() => {}); throw new InstallationError('not_installed'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const item = await budget.wait(reader.read()); if (item.done) break;
          bytes += item.value.byteLength; if (bytes > 1_048_576) throw new InstallationError('identity_mismatch');
          chunks.push(item.value);
        }
        if (createHash('sha256').update(Buffer.concat(chunks)).digest('hex') !== createAwsCloudInstallationTemplateV1().sha256)
          throw new InstallationError('identity_mismatch');
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      return url;
    } finally { budget.close(); }
  };
  const parseEvidence = (value: unknown, intent: CloudInstallationIntent): CloudInstallationEvidence => {
    const parsed = evidenceSchema.parse(value), s = settings(intent);
    const { attemptId: _attemptId, stackId: _stackId, ...base } = parsed.native;
    if (!equal(native(intent, parsed.native.operation), base)
      || !parsed.native.stackId.startsWith(`arn:aws:cloudformation:${s.region}:${s.accountId}:stack/${s.stackName}/`)) throw new InstallationError('ownership_mismatch');
    for (const resource of parsed.resources) {
      if (resource.kind === 'stack' && resource.id !== parsed.native.stackId) throw new InstallationError('identity_mismatch');
      if (resource.kind === 'writer' && (resource.id !== s.writerRoleArn || !resource.identity.roleId)) throw new InstallationError('identity_mismatch');
      if (resource.kind === 'disconnector' && (resource.id !== s.disconnectorRoleArn || !resource.identity.roleId)) throw new InstallationError('identity_mismatch');
      if (resource.kind === 'secret') {
        const secret = s.secrets.find(item => item.key === resource.identity.key);
        if (!secret || !resource.identity.createTime || (secret.arn ? resource.id !== secret.arn
          : !new RegExp(`^arn:aws:secretsmanager:${s.region}:${s.accountId}:secret:${secret.name}-[A-Za-z0-9]{6}$`).test(resource.id))) throw new InstallationError('identity_mismatch');
      }
    }
    if (new Set(parsed.resources.map(resource => resource.id)).size !== parsed.resources.length) throw new InstallationError('identity_mismatch');
    if (parsed.native.operation === 'install') {
      if (parsed.resources.length !== s.secrets.length + 3 || ['stack', 'writer', 'disconnector'].some(kind => parsed.resources.filter(resource => resource.kind === kind).length !== 1)
        || s.secrets.some(secret => parsed.resources.filter(resource => resource.kind === 'secret' && resource.identity.key === secret.key).length !== 1))
        throw new InstallationError('identity_mismatch');
    } else if (parsed.resources.length !== 1 || parsed.resources[0].kind !== (parsed.native.operation === 'revoke-writer' ? 'writer' : 'disconnector'))
      throw new InstallationError('identity_mismatch');
    return parsed;
  };
  const oldEvidence = (intent: CloudInstallationIntent) => {
    const evidence = (intent.installed ?? []).map(item => parseEvidence(item, intent));
    const found = evidence.find(item => item.native.operation === 'install');
    if (!found || found.resources.length !== settings(intent).secrets.length + 3) throw new InstallationError('ownership_mismatch');
    return found;
  };
  const credentials = async (context: CloudInstallationProviderContext, purpose: 'writer' | 'disconnector') => {
    const s = settings(context.intent), previous = context.intent.mode === 'disconnect' ? oldEvidence(context.intent) : undefined;
    const roleArn = purpose === 'writer' ? s.writerRoleArn : s.disconnectorRoleArn;
    const roleId = previous?.resources.find(item => item.kind === purpose)?.identity.roleId;
    const key = `${s.owner}:${purpose}`;
    const cached = retainedSessions.get(key);
    if (cached && cached.expiration.getTime() > Date.now() + 5000 && (!roleId || roleId === cached.roleId)) return cached;
    const result = await createAwsFederatedCredentialProvider({ accountId: s.accountId, region: s.region, roleArn, roleId,
      audience: purpose === 'writer' ? s.writerAudience : s.disconnectorAudience, hostSubject: context.intent.hostIdentity.subject,
      getGoogleIdToken: context.authentication.host.getIdToken.bind(context.authentication.host) }, { requestHandler: options.requestHandler })(context.signal);
    // Bound memory and expiry; expired credentials never become a durable connection.
    for (const [id, session] of retainedSessions) if (session.expiration.getTime() <= Date.now()) retainedSessions.delete(id);
    if (retainedSessions.size >= 100) retainedSessions.delete(retainedSessions.keys().next().value!);
    retainedSessions.set(key, result); return result;
  };
  const iam = (context: CloudInstallationProviderContext, session: AwsFederatedCredentials) => {
    const client = new IAMClient({ region: settings(context.intent).region, credentials: session, requestHandler: options.requestHandler, maxAttempts: 1 });
    boundAwsSdkResponses(client); return client;
  };
  const observeInstallation = async (context: Context): Promise<CloudInstallationObservation> => {
    if (!context.attempt) throw new InstallationError('ownership_mismatch');
    const s = settings(context.intent), session = await credentials(context, 'writer');
    const config = { region: s.region, credentials: session, requestHandler: options.requestHandler, maxAttempts: 1 };
    const cfn = new CloudFormationClient(config), iamClient = iam(context, session), secrets = new SecretsManagerClient(config);
    boundAwsSdkResponses(cfn); boundAwsSdkResponses(secrets);
    try {
      const retained = context.attempt.evidence ? parseEvidence(context.attempt.evidence, context.intent) : undefined;
      const stack = await cfn.send(new DescribeStacksCommand({ StackName: retained?.native.stackId as string ?? s.stackName }), { abortSignal: context.signal });
      const item = stack.Stacks?.length === 1 ? stack.Stacks[0] : undefined;
      if (!item?.StackId || !item.CreationTime || item.StackName !== s.stackName || !item.StackId.startsWith(`arn:aws:cloudformation:${s.region}:${s.accountId}:stack/${s.stackName}/`)
        || (retained && retained.native.stackId !== item.StackId)) throw new InstallationError('identity_mismatch');
      if (item.StackStatus !== 'CREATE_COMPLETE') return { state: 'pending', reason: 'not_converged' };
      const actualParameters = Object.fromEntries((item.Parameters ?? []).map(parameter => [parameter.ParameterKey, parameter.ParameterValue]));
      if (!equal(actualParameters, parameters(context.intent, context.attempt.id))) throw new InstallationError('ownership_mismatch');
      const template = await cfn.send(new GetTemplateCommand({ StackName: item.StackId, TemplateStage: 'Original' }), { abortSignal: context.signal });
      if (typeof template.TemplateBody !== 'string' || !equal(JSON.parse(template.TemplateBody), JSON.parse(createAwsCloudInstallationTemplateV1().body)))
        throw new InstallationError('identity_mismatch');
      const inventory = await cfn.send(new ListStackResourcesCommand({ StackName: item.StackId }), { abortSignal: context.signal });
      if (inventory.NextToken || !inventory.StackResourceSummaries || inventory.StackResourceSummaries.length !== s.secrets.filter(secret => !secret.arn).length + 2) throw new InstallationError('identity_mismatch');
      const byLogical = new Map(inventory.StackResourceSummaries.map(resource => [resource.LogicalResourceId, resource]));
      const resources: CloudInstallationEvidence['resources'] = [{ kind: 'stack', id: item.StackId, identity: { createTime: item.CreationTime.toISOString() } }];
      const secretArns: string[] = [];
      for (let slot = 0; slot < s.secrets.length; slot++) {
        const expected = s.secrets[slot], entry = byLogical.get(`Secret${String(slot).padStart(3, '0')}`);
        if (expected.arn ? Boolean(entry) : entry?.ResourceType !== 'AWS::SecretsManager::Secret' || entry.ResourceStatus !== 'CREATE_COMPLETE' || !entry.PhysicalResourceId)
          throw new InstallationError('identity_mismatch');
        const expectedArn = expected.arn ?? entry!.PhysicalResourceId!;
        const observed = await secrets.send(new DescribeSecretCommand({ SecretId: expectedArn }), { abortSignal: context.signal });
        const tags = Object.fromEntries((observed.Tags ?? []).map(tag => [tag.Key, tag.Value]));
        if (observed.ARN !== expectedArn || observed.Name !== expected.name || !observed.CreatedDate || observed.DeletedDate
          || !expected.arn && (tags['hypervibe-owner'] !== s.owner || tags['hypervibe-installation'] !== s.installationId || tags['hypervibe-attempt'] !== context.attempt.id))
          throw new InstallationError('ownership_mismatch');
        resources.push({ kind: 'secret', id: observed.ARN, identity: { key: expected.key, createTime: observed.CreatedDate.toISOString() } });
        secretArns.push(observed.ARN);
      }
      const roleArns = [s.writerRoleArn, s.disconnectorRoleArn];
      for (const kind of ['writer', 'disconnector'] as const) {
        const name = kind === 'writer' ? s.writerName : s.disconnectorName, arn = kind === 'writer' ? s.writerRoleArn : s.disconnectorRoleArn;
        const entry = byLogical.get(kind === 'writer' ? 'WriterRole' : 'DisconnectorRole');
        if (entry?.ResourceType !== 'AWS::IAM::Role' || entry.PhysicalResourceId !== name || entry.ResourceStatus !== 'CREATE_COMPLETE') throw new InstallationError('identity_mismatch');
        const result = await iamClient.send(new GetRoleCommand({ RoleName: name }), { abortSignal: context.signal });
        const role = result.Role, tags = Object.fromEntries((role?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
        const expectedTrust = trust(context.intent.hostIdentity.subject, kind === 'writer' ? s.writerAudience : s.disconnectorAudience, kind === 'writer' ? 'HypervibeWriter' : 'HypervibeDisconnector');
        if (!role?.RoleId || role.RoleName !== name || role.Arn !== arn || tags['hypervibe-owner'] !== s.owner || tags['hypervibe-attempt'] !== context.attempt.id
          || tags['hypervibe-installation'] !== s.installationId || !equal(parsedPolicy(role.AssumeRolePolicyDocument), expectedTrust)
          || (kind === 'writer' && session.roleId !== role.RoleId)) throw new InstallationError('ownership_mismatch');
        const inline = await iamClient.send(new ListRolePoliciesCommand({ RoleName: name }), { abortSignal: context.signal });
        const attached = await iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: name }), { abortSignal: context.signal });
        if (inline.IsTruncated || attached.IsTruncated || !equal(inline.PolicyNames, [policyName]) || !Array.isArray(attached.AttachedPolicies) || attached.AttachedPolicies.length)
          throw new InstallationError('identity_mismatch');
        const policy = await iamClient.send(new GetRolePolicyCommand({ RoleName: name, PolicyName: policyName }), { abortSignal: context.signal });
        if (policy.RoleName !== name || policy.PolicyName !== policyName
          || !equal(parsedPolicy(policy.PolicyDocument), kind === 'writer' ? writerPolicy(secretArns, item.StackId, roleArns) : disconnectorPolicy(roleArns)))
          throw new InstallationError('identity_mismatch');
        resources.push({ kind, id: arn, identity: { roleId: role.RoleId } });
      }
      const evidence = parseEvidence({ resources, native: { ...native(context.intent, 'install'), attemptId: context.attempt.id, stackId: item.StackId } }, context.intent);
      if (retained && !equal(retained, evidence)) throw new InstallationError('identity_mismatch');
      return { state: 'satisfied', evidence };
    } finally { cfn.destroy(); iamClient.destroy(); secrets.destroy(); }
  };
  const observeTrust = async (context: Context): Promise<{ observation: CloudInstallationObservation; policy: Policy; client: IAMClient; roleName: string }> => {
    const s = settings(context.intent), original = oldEvidence(context.intent), operation = nativeSchema.parse(context.action.metadata.native).operation;
    const kind = operation === 'revoke-writer' ? 'writer' : 'disconnector';
    const expected = original.resources.find(resource => resource.kind === kind)!;
    const client = iam(context, await credentials(context, 'disconnector'));
    try {
      const roleName = kind === 'writer' ? s.writerName : s.disconnectorName;
      const role = (await client.send(new GetRoleCommand({ RoleName: roleName }), { abortSignal: context.signal })).Role;
      const tags = Object.fromEntries((role?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
      if (!role || role.RoleId !== expected.identity.roleId || role.Arn !== expected.id || tags['hypervibe-owner'] !== s.owner
        || tags['hypervibe-installation'] !== s.installationId) throw new InstallationError('ownership_mismatch');
      const policy = parsedPolicy(role.AssumeRolePolicyDocument);
      const audience = kind === 'writer' ? s.writerAudience : s.disconnectorAudience;
      const owned = trust(context.intent.hostIdentity.subject, audience, kind === 'writer' ? 'HypervibeWriter' : 'HypervibeDisconnector').Statement[0];
      const removed = trust(context.intent.hostIdentity.subject, audience, 'HypervibeDisconnected', 'Deny').Statement[0];
      const ownedStatements = policy.Statement.filter(statement => statement.Sid === owned.Sid);
      if (ownedStatements.length > 1 || (ownedStatements.length && !equal(ownedStatements[0], owned))) throw new InstallationError('ownership_mismatch');
      let observation: CloudInstallationObservation;
      if (!ownedStatements.length && policy.Statement.some(statement => equal(statement, removed))) {
        observation = { state: 'satisfied', evidence: parseEvidence({ resources: [expected], native: { ...native(context.intent, operation),
          attemptId: context.attempt?.id ?? original.native.attemptId, stackId: original.native.stackId } }, context.intent) };
      } else if (ownedStatements.length === 1) observation = { state: 'action-required' };
      else throw new InstallationError('ownership_mismatch');
      return { observation, policy, client, roleName };
    } catch (error) { client.destroy(); throw error; }
  };
  return {
    provider: 'aws', parseScope: value => scopeSchema.parse(value), parseEvidence,
    discoverScopes: async () => ({ state: 'unknown', scopes: [], authority: 'not-verified' }),
    parseAction(value, intent) {
      const parsed = z.object({ id: z.string(), type: z.enum(['create', 'update']), resource: z.object({ kind: z.literal('secret'), name: z.string(), provider: z.literal('aws') }).strict(),
        verified: z.literal(true), reason: z.string(), billable: z.boolean(), requiresConfirm: z.literal(true), dependsOn: z.array(z.string()).optional(),
        metadata: z.object({ operation: z.literal('awsCloudInstallation'), category: z.enum(['scope', 'trust']), execution: z.enum(['api', 'external']), native: nativeSchema }).strict() }).strict().parse(value);
      const operation = parsed.metadata.native.operation;
      const s = settings(intent);
      if (!equal(parsed.metadata.native, native(intent, operation)) || (intent.mode !== 'disconnect') !== (operation === 'install')
        || parsed.id !== `aws:${operation}` || parsed.type !== (operation === 'install' ? 'create' : 'update')
        || parsed.resource.name !== (operation === 'install' ? s.stackName : operation === 'revoke-writer' ? s.writerName : s.disconnectorName)
        || parsed.metadata.category !== (operation === 'install' ? 'scope' : 'trust') || parsed.billable !== (operation === 'install')
        || !equal(parsed.dependsOn ?? [], operation === 'revoke-disconnector' ? ['aws:revoke-writer'] : [])
        || parsed.metadata.execution !== (operation === 'install' ? 'external' : 'api')) throw new InstallationError('identity_mismatch');
      return parsed;
    },
    async plan(context) {
      const s = settings(context.intent);
      if (context.intent.mode !== 'disconnect') await verifyPublication(context.signal); else oldEvidence(context.intent);
      if (JSON.stringify(writerPolicy(s.secrets.map(secret => secret.arn ?? `arn:aws:secretsmanager:${s.region}:${s.accountId}:secret:${secret.name}-ABC123`),
        `arn:aws:cloudformation:${s.region}:${s.accountId}:stack/${s.stackName}/${'a'.repeat(36)}`, [s.writerRoleArn, s.disconnectorRoleArn])).length > 10240)
        throw new InstallationError('identity_mismatch');
      const operations = context.intent.mode !== 'disconnect' ? ['install'] as const : ['revoke-writer', 'revoke-disconnector'] as const;
      return { actions: operations.map((operation, index): CloudInstallationAction => ({ id: `aws:${operation}`, type: operation === 'install' ? 'create' : 'update',
        resource: { kind: 'secret', name: operation === 'install' ? s.stackName : operation === 'revoke-writer' ? s.writerName : s.disconnectorName, provider: 'aws' },
        verified: true, requiresConfirm: true, billable: operation === 'install', reason: operation === 'install' ? 'Review AWS console installation of retained secret containers and scoped identities.' : 'Remove only the reviewed hosted cloud trust; preserve secrets and runtime readers.',
        ...(index ? { dependsOn: ['aws:revoke-writer'] } : {}),
        metadata: { operation: 'awsCloudInstallation', category: operation === 'install' ? 'scope' : 'trust', execution: operation === 'install' ? 'external' : 'api', native: native(context.intent, operation) } })),
        review: { resources: [{ kind: 'CloudFormation stack', name: s.stackName, scope: `${s.accountId}/${s.region}` },
          { kind: 'writer IAM role', name: s.writerRoleArn, scope: s.accountId }, { kind: 'disconnection IAM role', name: s.disconnectorRoleArn, scope: s.accountId },
          ...s.secrets.map(secret => ({ kind: secret.arn ? 'existing secret container (presence verified after installation)' : 'retained secret container', name: secret.arn ?? secret.name, scope: `${s.accountId}/${s.region}` }))], permissions: [
          { principal: s.writerRoleArn, scope: `${s.accountId}/${s.region}/${s.stackName}`, actions: ['secretsmanager:PutSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:ListSecretVersionIds'], purpose: 'writer' },
          { principal: s.writerRoleArn, scope: s.stackName, actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:ListStackResources', 'iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'], purpose: 'installation-verification' },
          { principal: s.disconnectorRoleArn, scope: `${s.writerRoleArn},${s.disconnectorRoleArn}`, actions: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:UpdateAssumeRolePolicy'], purpose: 'hosted-trust-removal' },
        ], costs: [{ resource: `${s.secrets.length} Secrets Manager containers`, description: 'AWS secret and API-request charges apply. Secrets and their charges remain after disconnect.', pricingUrl: 'https://aws.amazon.com/secrets-manager/pricing/' }],
        warnings: ['The supplied AWS account number is unverified until the installed role proves its native account. Review the signed-in account in the AWS console.',
          'IAM trust updates have no etag precondition. Hypervibe preserves observed unrelated statements and blocks observed ownership changes; concurrent out-of-band trust edits cannot be atomically protected.',
          'Disconnect removes hosted trust but issued STS sessions can remain valid for up to 15 minutes. If the final acknowledgment is lost and the process restarts, cleanup verification can remain pending.'] } };
    },
    async inspect(context) {
      if (context.intent.mode !== 'disconnect') return { state: 'action-required' }; // External create-only console review, never a claim of native absence.
      try { const result = await observeTrust(context); result.client.destroy(); return result.observation; }
      catch (error) { return { state: 'unknown', reason: failure(error) }; }
    },
    async mutate(context) {
      if (context.intent.mode !== 'disconnect') {
        const s = settings(context.intent), templateUrl = await verifyPublication(context.signal);
        await context.beforeMutation();
        const query = new URLSearchParams({ templateURL: templateUrl, stackName: s.stackName });
        for (const [name, value] of Object.entries(parameters(context.intent, context.attempt.id))) if (value) query.set(`param_${name}`, value);
        return { state: 'external', url: `https://${s.region}.console.aws.amazon.com/cloudformation/home?region=${s.region}#/stacks/create/review?${query}` };
      }
      let client: IAMClient | undefined, started = false;
      try {
        const observed = await observeTrust(context); client = observed.client;
        if (observed.observation.state !== 'action-required') return { state: 'rejected', reason: 'not_converged' };
        const s = settings(context.intent), writer = nativeSchema.parse(context.action.metadata.native).operation === 'revoke-writer';
        const sid = writer ? 'HypervibeWriter' : 'HypervibeDisconnector';
        const policy = { ...observed.policy, Statement: [...observed.policy.Statement.filter(statement => statement.Sid !== sid),
          ...trust(context.intent.hostIdentity.subject, writer ? s.writerAudience : s.disconnectorAudience, 'HypervibeDisconnected', 'Deny').Statement] };
        await context.beforeMutation(); started = true;
        await client.send(new UpdateAssumeRolePolicyCommand({ RoleName: observed.roleName, PolicyDocument: JSON.stringify(policy) }), { abortSignal: context.signal });
        return { state: 'acknowledged' };
      } catch (error) { return { state: started ? 'uncertain' : 'rejected', reason: failure(error) }; }
      finally { client?.destroy(); }
    },
    async recover(context) {
      try {
        if (context.intent.mode !== 'disconnect') return await observeInstallation(context);
        const result = await observeTrust(context); result.client.destroy();
        return result.observation.state === 'action-required' ? { state: 'unknown', reason: 'not_converged' } : result.observation;
      } catch (error) { return { state: 'unknown', reason: failure(error) }; }
    },
    connections(record) {
      if (record.status !== 'ready' || record.intent.mode === 'disconnect') throw new InstallationError('not_installed');
      const s = settings(record.intent), evidence = parseEvidence(record.completed['aws:install'], record.intent);
      const roleId = evidence.resources.find(item => item.kind === 'writer')?.identity.roleId;
      if (!roleId) throw new InstallationError('identity_mismatch');
      return s.secrets.map(secret => {
        const target = evidence.resources.find(item => item.kind === 'secret' && item.identity.key === secret.key);
        if (!target) throw new InstallationError('identity_mismatch');
        return { key: secret.key, destination: { provider: 'aws-secrets', accountId: s.accountId, region: s.region, secretArn: target.id },
          writerAuthorization: { roleArn: s.writerRoleArn, roleId, audience: s.writerAudience, hostSubject: record.intent.hostIdentity.subject,
            hostServiceAccountEmail: record.intent.hostIdentity.serviceAccountEmail, installationId: s.installationId } };
      });
    },
  };
}
