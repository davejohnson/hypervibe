import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { GetRoleCommand, GetRolePolicyCommand, IAMClient, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand, UpdateAssumeRolePolicyCommand } from '@aws-sdk/client-iam';
import { DescribeSecretCommand, ListSecretVersionIdsCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DescribeExpressGatewayServiceCommand, DescribeTaskDefinitionCommand, ECSClient } from '@aws-sdk/client-ecs';
import { DescribeRepositoriesCommand, ECRClient, ListTagsForResourceCommand } from '@aws-sdk/client-ecr';
import type { STSClientConfig } from '@aws-sdk/client-sts';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationDriver, type CloudInstallationEvidence, type CloudInstallationIntent,
  type CloudInstallationProviderContext, type CloudInstallationAttempt, type CloudInstallationObservation, type CloudInstallationReason } from '../../../domain/ports/cloud-installation.port.js';
import type { CloudDeploymentConnectionV1, CloudDeploymentTopologyV1 } from '../../../domain/ports/cloud-deployment.port.js';
import { ecsCurrentConfiguration } from './ecs-volume-runtime.js';
import { CloudDeploymentAccessError, parseCloudDeploymentConnectionV1, parseCloudDeploymentTopologyV1 } from '../../../domain/services/cloud-deployment-authentication.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { runtimeSecretReferenceSchema } from '../../../domain/ports/secret-destination.port.js';
import { resourceName } from '../../../domain/services/resource-names.js';
import { DestinationBoundaryError } from '../secret-destination-http.js';
import { verifyAwsCloudFormationPublication } from './aws-cloudformation-publication.js';
import { boundAwsSdkResponses } from './aws-secret-destination.js';
import { createAwsFederatedCredentialProvider, type AwsFederatedCredentials } from './aws-federated-auth.js';
import { awsDeploymentScopeSchema } from './aws-deployment-auth.js';

const MAX_TARGETS = 50, POLICY = 'hypervibe-deployment-access';
const kinds = ['provision', 'release', 'disconnector', 'task', 'execution', 'infrastructure'] as const;
type Kind = typeof kinds[number];
type Policy = { Version: string; Statement: Array<Record<string, any>> };
type Context = CloudInstallationProviderContext & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
const executionPolicy = 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy';
const infrastructurePolicy = 'arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices';
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (name: string) => ({ Ref: name });
const sub = (value: string) => ({ 'Fn::Sub': value });
function fail(): never { throw new CloudInstallationBoundaryError('identity_mismatch'); }
function failure(error: unknown): CloudInstallationReason {
  if (error instanceof CloudInstallationBoundaryError) return error.reason;
  if (error instanceof DestinationBoundaryError) return error.code === 'access_denied' ? 'insufficient_permissions'
    : error.code === 'scope_mismatch' ? 'identity_mismatch' : error.code === 'deadline_exceeded' ? 'timeout' : 'provider_error';
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation'].includes(String(name))) return 'insufficient_permissions';
  if (['ExpiredToken', 'ExpiredTokenException', 'InvalidClientTokenId'].includes(String(name))) return 'authorization_expired';
  if (['AbortError', 'TimeoutError'].includes(String(name))) return 'timeout';
  return 'provider_error';
}
function hostedTrust(subject: unknown, audience: unknown, kind: string, effect = 'Allow'): Policy {
  return { Version: '2012-10-17', Statement: [{ Sid: `Hypervibe${kind}`, Effect: effect, Principal: { Federated: 'accounts.google.com' }, Action: 'sts:AssumeRoleWithWebIdentity',
    Condition: { StringEquals: { 'accounts.google.com:aud': subject, 'accounts.google.com:oaud': audience, 'accounts.google.com:sub': subject } } }] };
}
const runtimeTrust = (service: string): Policy => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole' }] });
function policy(kind: Kind, s: { accountId: unknown; region: unknown; owner: unknown; vpcArns: unknown; groupArns: unknown; clusterArn: unknown; repositoryArn: unknown; serviceArns: unknown[]; secretArns: unknown[]; roleArns: unknown[]; controlArns: unknown[]; runtimeArns: unknown[]; stackId: unknown }): Policy {
  const Statement: Policy['Statement'] = [];
  if (kind === 'disconnector') return { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['iam:GetRole', 'iam:UpdateAssumeRolePolicy'], Resource: s.controlArns }] };
  if (kind === 'execution') return { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: s.secretArns }] };
  if (kind === 'task' || kind === 'infrastructure') return { Version: '2012-10-17', Statement };
  Statement.push(
    { Effect: 'Allow', Action: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'], Resource: s.roleArns },
    { Effect: 'Allow', Action: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:ListStackResources'], Resource: s.stackId },
    { Effect: 'Allow', Action: ['ecs:DescribeClusters'], Resource: s.clusterArn },
    { Effect: 'Allow', Action: ['ecs:DescribeExpressGatewayService', 'ecs:DescribeServices', 'ecs:UpdateExpressGatewayService'], Resource: s.serviceArns },
    { Effect: 'Allow', Action: ['ecs:ListServices'], Resource: '*', Condition: { ArnEquals: { 'ecs:cluster': s.clusterArn } } },
    { Effect: 'Allow', Action: ['ecs:DescribeTaskDefinition', 'ecs:RegisterTaskDefinition', 'ecr:GetAuthorizationToken'], Resource: '*' },
    { Effect: 'Allow', Action: ['ecr:DescribeRepositories', 'ecr:ListTagsForResource', 'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
      'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage'], Resource: s.repositoryArn },
    { Effect: 'Allow', Action: ['iam:PassRole'], Resource: s.runtimeArns, Condition: { StringEquals: { 'iam:PassedToService': ['ecs-tasks.amazonaws.com', 'ecs.amazonaws.com'] } } },
  );
  if (s.secretArns.length) Statement.push({ Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:ListSecretVersionIds'], Resource: s.secretArns });
  if (kind === 'provision') Statement.push(
    { Effect: 'Allow', Action: ['ecs:CreateCluster', 'ecs:DeleteCluster', 'ecs:TagResource'], Resource: s.clusterArn },
    { Effect: 'Allow', Action: ['ecs:CreateExpressGatewayService', 'ecs:DeleteExpressGatewayService', 'ecs:TagResource'], Resource: s.serviceArns },
    { Effect: 'Allow', Action: ['ecs:ListClusters', 'ec2:DescribeVpcs', 'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups'], Resource: '*' },
    { Effect: 'Allow', Action: ['ecr:CreateRepository', 'ecr:DeleteRepository', 'ecr:TagResource'], Resource: s.repositoryArn },
    { Effect: 'Allow', Action: ['ec2:CreateSecurityGroup'], Resource: s.vpcArns },
    { Effect: 'Allow', Action: ['ec2:CreateSecurityGroup'], Resource: s.groupArns, Condition: { StringEquals: { 'aws:RequestTag/hypervibe-owner': s.owner } } },
    { Effect: 'Allow', Action: ['ec2:CreateTags'], Resource: s.groupArns, Condition: { StringEquals: { 'ec2:CreateAction': 'CreateSecurityGroup', 'aws:RequestTag/hypervibe-owner': s.owner } } },
    { Effect: 'Allow', Action: ['ec2:DeleteSecurityGroup'], Resource: s.groupArns, Condition: { StringEquals: { 'aws:ResourceTag/hypervibe-owner': s.owner } } },
  );
  return { Version: '2012-10-17', Statement };
}
/** Public template is immutable and contains no customer values. Publish only with owner approval. */
export function createAwsCloudDeploymentTemplateV1(): { body: string; sha256: string } {
  const Parameters: Record<string, any> = { CustomerAccountId: { Type: 'String', AllowedPattern: '^\\d{12}$' }, HostSubject: { Type: 'String', AllowedPattern: '^[1-9]\\d{5,29}$' },
    OwnerDigest: { Type: 'String', AllowedPattern: '^[a-f0-9]{64}$' }, InstallationId: { Type: 'String' }, AttemptId: { Type: 'String' }, ClusterName: { Type: 'String' } };
  const Conditions: Record<string, any> = { ApprovedAccount: { 'Fn::Equals': [ref('AWS::AccountId'), ref('CustomerAccountId')] } };
  const serviceArns: unknown[] = [], secretArns: unknown[] = [];
  for (let i = 0; i < MAX_TARGETS; i++) {
    const suffix = String(i).padStart(3, '0');
    for (const type of ['ServiceName', 'SecretArn']) { const name = `${type}${suffix}`;
      Parameters[name] = { Type: 'String', Default: '' };
      Conditions[`Has${name}`] = { 'Fn::Not': [{ 'Fn::Equals': [ref(name), ''] }] };
    }
    serviceArns.push({ 'Fn::If': [`HasServiceName${suffix}`, sub(`arn:aws:ecs:\${AWS::Region}:\${AWS::AccountId}:service/\${ClusterName}/\${ServiceName${suffix}}`), ref('AWS::NoValue')] });
    secretArns.push({ 'Fn::If': [`HasSecretArn${suffix}`, ref(`SecretArn${suffix}`), ref('AWS::NoValue')] });
  }
  for (const kind of kinds) { Parameters[`${kind}RoleName`] = { Type: 'String' }; if (['provision', 'release', 'disconnector'].includes(kind)) Parameters[`${kind}Audience`] = { Type: 'String' }; }
  const roleArns = kinds.map(kind => sub(`arn:aws:iam::\${AWS::AccountId}:role/\${${kind}RoleName}`));
  const scope = { accountId: ref('AWS::AccountId'), region: ref('AWS::Region'), owner: ref('OwnerDigest'), vpcArns: sub('arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:vpc/*'), groupArns: sub('arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:security-group/*'), clusterArn: sub('arn:aws:ecs:${AWS::Region}:${AWS::AccountId}:cluster/${ClusterName}'),
    repositoryArn: sub('arn:aws:ecr:${AWS::Region}:${AWS::AccountId}:repository/hypervibe/${ClusterName}'), serviceArns, secretArns, roleArns,
    controlArns: roleArns.slice(0, 3), runtimeArns: roleArns.slice(3), stackId: ref('AWS::StackId') };
  const Resources: Record<string, unknown> = {};
  for (const kind of kinds) {
    const title = kind[0].toUpperCase() + kind.slice(1), runtime = !['provision', 'release', 'disconnector'].includes(kind);
    const policyDocument = policy(kind, scope);
    // Empty resource lists must remove the whole policy statement, not make invalid IAM JSON.
    if (kind === 'provision' || kind === 'release') policyDocument.Statement[policyDocument.Statement.findIndex(item => item.Action.includes('secretsmanager:DescribeSecret'))] = {
      'Fn::If': ['HasSecretArn000', { Effect: 'Allow', Action: ['secretsmanager:DescribeSecret', 'secretsmanager:ListSecretVersionIds'], Resource: secretArns }, ref('AWS::NoValue')] };
    const policies = kind === 'task' || kind === 'infrastructure' ? [] : [{ PolicyName: POLICY, PolicyDocument: policyDocument }];
    Resources[`${title}Role`] = { Type: 'AWS::IAM::Role', Condition: 'ApprovedAccount', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      RoleName: ref(`${kind}RoleName`), MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: runtime ? runtimeTrust(kind === 'infrastructure' ? 'ecs.amazonaws.com' : 'ecs-tasks.amazonaws.com') : hostedTrust(ref('HostSubject'), ref(`${kind}Audience`), kind),
      Tags: [{ Key: 'hypervibe-owner', Value: ref('OwnerDigest') }, { Key: 'hypervibe-installation', Value: ref('InstallationId') }, { Key: 'hypervibe-attempt', Value: ref('AttemptId') }],
      ...(kind === 'execution' ? { ManagedPolicyArns: [executionPolicy], Policies: [{ 'Fn::If': ['HasSecretArn000', policies[0], ref('AWS::NoValue')] }] }
        : kind === 'infrastructure' ? { ManagedPolicyArns: [infrastructurePolicy] } : policies.length ? { Policies: policies } : {}),
    } };
  }
  const body = JSON.stringify({ AWSTemplateFormatVersion: '2010-09-09', Description: 'Hypervibe reviewed deployment roles: separate provision, release, runtime and hosted-trust removal; no secret values.', Parameters, Conditions, Resources });
  return { body, sha256: createHash('sha256').update(body).digest('hex') };
}
const nativeSchema = z.object({ operation: z.enum(['install', 'revoke-provision', 'revoke-release', 'revoke-disconnector']), installationId: z.string().guid(), owner: z.string().regex(/^[a-f0-9]{64}$/),
  stackName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/), templateDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['stack', ...kinds, 'secret']), id: z.string().min(1).max(2048),
  identity: z.object({ roleId: z.string().regex(/^AROA[A-Z0-9]{12,124}$/).optional(), createTime: z.string().datetime().optional(), version: z.string().min(32).max(64).optional() }).strict() }).strict()).min(1).max(57),
  native: nativeSchema.extend({ attemptId: z.string().guid(), stackId: z.string().regex(/^arn:aws:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z0-9-]+\/[a-f0-9-]+$/) }).strict() }).strict();
export function awsDeploymentNames(input: Pick<CloudInstallationIntent, 'installationId' | 'customerId' | 'appId' | 'environment' | 'hostIdentity' | 'nativeScope'>) {
  const scope = awsDeploymentScopeSchema.parse(input.nativeScope), parts = [input.customerId, input.appId, input.environment, input.installationId];
  const owner = sha({ parts, scope, host: input.hostIdentity });
  const clusterName = resourceName(input.environment, { scope: parts, maxLength: 42 });
  return { ...scope, owner, clusterName, stackName: resourceName('hypervibe-deploy', { scope: parts, maxLength: 100 }),
    roles: Object.fromEntries(kinds.map(kind => [kind, resourceName(kind, { scope: parts, maxLength: 64 })])) as Record<Kind, string> };
}
function settings(intent: CloudInstallationIntent) {
  if (intent.provider !== 'aws' || intent.purpose !== 'deployment' || intent.stage !== 'deployment' || intent.mode === 'migrate' || intent.keys.length) fail();
  const deployment = parseCloudDeploymentTopologyV1(intent.deployment);
  const ids = intent.mode === 'disconnect' ? (intent.installed ?? []).map(item => evidenceSchema.parse(item).native.installationId) : [intent.installationId];
  if (!ids.length || new Set(ids).size !== 1) fail();
  const installationId = ids[0], names = awsDeploymentNames({ ...intent, installationId });
  if (deployment.hostingProvider !== 'ecs' || deployment.region !== names.region || deployment.workloads.some(item => item.kind !== 'web')) fail();
  if (new Set(deployment.workloads.map(item => resourceName(item.name, { maxLength: 255 }))).size !== deployment.workloads.length) fail();
  const refs = new Map<string, string>();
  for (const workload of deployment.workloads) for (const item of workload.runtimeSecrets) {
    const d = item.reference.destination;
    if (d.provider !== 'aws-secrets' || d.accountId !== names.accountId || d.region !== names.region || refs.has(d.secretArn) && refs.get(d.secretArn) !== item.reference.version) fail();
    refs.set(d.secretArn, item.reference.version);
  }
  if (refs.size > MAX_TARGETS || deployment.workloads.length > MAX_TARGETS) fail();
  const roleArns = Object.fromEntries(kinds.map(kind => [kind, `arn:aws:iam::${names.accountId}:role/${names.roles[kind]}`])) as Record<Kind, string>;
  return { ...names, installationId, deployment, refs: [...refs].sort(([a], [b]) => a.localeCompare(b)), roleArns,
    audience: (kind: Kind) => `https://hypervibe.dev/cloud-deployments/${names.owner}/${kind}` };
}
function native(intent: CloudInstallationIntent, operation: z.infer<typeof nativeSchema>['operation']) {
  const s = settings(intent); return { operation, installationId: s.installationId, owner: s.owner, stackName: s.stackName, templateDigest: createAwsCloudDeploymentTemplateV1().sha256 };
}
function parameters(intent: CloudInstallationIntent, attemptId: string) {
  const s = settings(intent), result: Record<string, string> = { CustomerAccountId: s.accountId, HostSubject: intent.hostIdentity.subject, OwnerDigest: s.owner,
    InstallationId: s.installationId, AttemptId: attemptId, ClusterName: s.clusterName };
  for (const kind of kinds) { result[`${kind}RoleName`] = s.roles[kind]; if (['provision', 'release', 'disconnector'].includes(kind)) result[`${kind}Audience`] = s.audience(kind); }
  for (let i = 0; i < MAX_TARGETS; i++) { const suffix = String(i).padStart(3, '0'); result[`SecretArn${suffix}`] = s.refs[i]?.[0] ?? ''; result[`ServiceName${suffix}`] = [...s.deployment.workloads].sort((a, b) => a.name.localeCompare(b.name))[i] ? resourceName([...s.deployment.workloads].sort((a, b) => a.name.localeCompare(b.name))[i].name, { maxLength: 255 }) : ''; }
  return result;
}
function nativePolicy(kind: Kind, intent: CloudInstallationIntent, stackId: string): Policy {
  const s = settings(intent); return policy(kind, { ...s, stackId, vpcArns: `arn:aws:ec2:${s.region}:${s.accountId}:vpc/*`, groupArns: `arn:aws:ec2:${s.region}:${s.accountId}:security-group/*`, clusterArn: `arn:aws:ecs:${s.region}:${s.accountId}:cluster/${s.clusterName}`,
    repositoryArn: `arn:aws:ecr:${s.region}:${s.accountId}:repository/hypervibe/${s.clusterName}`, serviceArns: [...s.deployment.workloads].sort((a, b) => a.name.localeCompare(b.name)).map(item => `arn:aws:ecs:${s.region}:${s.accountId}:service/${s.clusterName}/${resourceName(item.name, { maxLength: 255 })}`),
    secretArns: s.refs.map(([arn]) => arn), roleArns: kinds.map(kind => s.roleArns[kind]), controlArns: kinds.slice(0, 3).map(kind => s.roleArns[kind]), runtimeArns: kinds.slice(3).map(kind => s.roleArns[kind]) });
}
function parsedPolicy(value: unknown): Policy { try { const parsed = typeof value === 'string' ? JSON.parse(decodeURIComponent(value)) : value; if (!parsed || !Array.isArray(parsed.Statement) || parsed.Version !== '2012-10-17') fail(); return parsed; } catch { return fail(); } }
function topology(spec: ProjectSpec, intent: CloudInstallationIntent): CloudDeploymentTopologyV1 {
  const env = spec.environments[intent.environment];
  if (!env || env.hosting.provider !== 'ecs' || env.database || env.cache || Object.keys(env.storage ?? {}).length || Object.values(env.services).some(service => service.volume || service.workloadKind !== 'web' || service.releaseCommand) || env.domain || env.loadBalancer) throw new CloudDeploymentAccessError('unsupported');
  const references = Object.entries(env.secretDestinations ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, reference]) => ({ key, reference: runtimeSecretReferenceSchema.parse(reference) }));
  return parseCloudDeploymentTopologyV1({ hostingProvider: 'ecs', region: env.hosting.region ?? 'us-west-2', workloads: Object.entries(env.services).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, service]) => ({ name, kind: service.workloadKind, runtimeSecrets: references })) });
}
export function createAwsCloudDeploymentDriver(options: { templateUrl?: string; requestHandler?: STSClientConfig['requestHandler']; fetch?: typeof fetch } = {}): CloudInstallationDriver {
  const sessions = new Map<string, AwsFederatedCredentials>();
  const artifact = createAwsCloudDeploymentTemplateV1();
  const publication = (signal: AbortSignal) => verifyAwsCloudFormationPublication({
    templateUrl: options.templateUrl, sha256: artifact.sha256, signal, fetch: options.fetch,
  });
  const parseEvidence = (value: unknown, intent: CloudInstallationIntent): CloudInstallationEvidence => {
    const evidence = evidenceSchema.parse(value), s = settings(intent), { attemptId: _attempt, stackId, ...base } = evidence.native;
    if (!isDeepStrictEqual(base, native(intent, base.operation)) || !stackId.startsWith(`arn:aws:cloudformation:${s.region}:${s.accountId}:stack/${s.stackName}/`)) fail();
    for (const resource of evidence.resources) {
      if (resource.kind === 'stack') { if (resource.id !== stackId || !resource.identity.createTime) fail(); }
      else if (resource.kind === 'secret') { const ref = s.refs.find(([arn]) => arn === resource.id); if (!ref || !resource.identity.createTime || resource.identity.version !== ref[1]) fail(); }
      else if (resource.id !== s.roleArns[resource.kind] || !resource.identity.roleId) fail();
    }
    const expected = base.operation === 'install' ? ['stack', ...kinds, ...s.refs.map(() => 'secret')] : [base.operation.slice(7)];
    if (expected.length !== evidence.resources.length || new Set(evidence.resources.map(item => item.id)).size !== evidence.resources.length
      || kinds.some(kind => evidence.resources.filter(item => item.kind === kind).length !== expected.filter(item => item === kind).length)) fail();
    return evidence;
  };
  const original = (intent: CloudInstallationIntent) => { const item = intent.installed?.find(item => item.native.operation === 'install'); if (!item) return fail(); return parseEvidence(item, intent); };
  const assume = async (intent: CloudInstallationIntent, kind: 'provision' | 'release' | 'disconnector', host: CloudInstallationProviderContext['authentication']['host'], signal: AbortSignal, roleId?: string) => {
    const s = settings(intent); return createAwsFederatedCredentialProvider({ accountId: s.accountId, region: s.region, roleArn: s.roleArns[kind], roleId,
      audience: s.audience(kind), hostSubject: intent.hostIdentity.subject, getGoogleIdToken: host.getIdToken.bind(host) }, { requestHandler: options.requestHandler })(signal);
  };
  const iam = (s: ReturnType<typeof settings>, credentials: AwsFederatedCredentials) => { const client = new IAMClient({ region: s.region, credentials, maxAttempts: 1, requestHandler: options.requestHandler }); boundAwsSdkResponses(client); return client; };
  const verifyRole = async (intent: CloudInstallationIntent, client: IAMClient, kind: Kind, stackId: string, attemptId: string, signal: AbortSignal, roleId?: string) => {
    const s = settings(intent), role = (await client.send(new GetRoleCommand({ RoleName: s.roles[kind] }), { abortSignal: signal })).Role;
    const tags = Object.fromEntries((role?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    if (!role?.RoleId || role.RoleId === undefined || roleId && role.RoleId !== roleId || role.Arn !== s.roleArns[kind] || role.RoleName !== s.roles[kind]
      || tags['hypervibe-owner'] !== s.owner || tags['hypervibe-installation'] !== s.installationId || tags['hypervibe-attempt'] !== attemptId) fail();
    const trust = ['provision', 'release', 'disconnector'].includes(kind) ? hostedTrust(intent.hostIdentity.subject, s.audience(kind), kind) : runtimeTrust(kind === 'infrastructure' ? 'ecs.amazonaws.com' : 'ecs-tasks.amazonaws.com');
    if (!isDeepStrictEqual(parsedPolicy(role.AssumeRolePolicyDocument), trust)) fail();
    const inline = await client.send(new ListRolePoliciesCommand({ RoleName: s.roles[kind] }), { abortSignal: signal });
    const attached = await client.send(new ListAttachedRolePoliciesCommand({ RoleName: s.roles[kind] }), { abortSignal: signal });
    const inlineNames = kind === 'task' || kind === 'infrastructure' || kind === 'execution' && !s.refs.length ? [] : [POLICY];
    const attachedArns = kind === 'execution' ? [executionPolicy] : kind === 'infrastructure' ? [infrastructurePolicy] : [];
    if (inline.IsTruncated || attached.IsTruncated || !isDeepStrictEqual(inline.PolicyNames, inlineNames) || !Array.isArray(attached.AttachedPolicies)
      || !isDeepStrictEqual(attached.AttachedPolicies.map(item => item.PolicyArn).sort(), attachedArns)) fail();
    if (inlineNames.length) { const response = await client.send(new GetRolePolicyCommand({ RoleName: s.roles[kind], PolicyName: POLICY }), { abortSignal: signal });
      if (response.RoleName !== s.roles[kind] || response.PolicyName !== POLICY || !isDeepStrictEqual(parsedPolicy(response.PolicyDocument), nativePolicy(kind, intent, stackId))) fail(); }
    return { kind, id: role.Arn, identity: { roleId: role.RoleId } };
  };
  const observe = async (context: Context): Promise<CloudInstallationObservation> => {
    if (!context.attempt) return fail(); const s = settings(context.intent);
    const credentials = await assume(context.intent, 'provision', context.authentication.host, context.signal);
    const config = { region: s.region, credentials, maxAttempts: 1, requestHandler: options.requestHandler }, cfn = new CloudFormationClient(config), roles = iam(s, credentials), secrets = new SecretsManagerClient(config);
    boundAwsSdkResponses(cfn); boundAwsSdkResponses(secrets);
    try {
      const retained = context.attempt.evidence && parseEvidence(context.attempt.evidence, context.intent);
      const response = await cfn.send(new DescribeStacksCommand({ StackName: retained?.native.stackId as string ?? s.stackName }), { abortSignal: context.signal });
      const stack = response.Stacks?.length === 1 ? response.Stacks[0] : undefined;
      if (!stack?.StackId || !stack.CreationTime || stack.StackName !== s.stackName || !stack.StackId.startsWith(`arn:aws:cloudformation:${s.region}:${s.accountId}:stack/${s.stackName}/`)) fail();
      if (stack.StackStatus !== 'CREATE_COMPLETE') return { state: 'pending', reason: 'not_converged' };
      if (!isDeepStrictEqual(Object.fromEntries((stack.Parameters ?? []).map(item => [item.ParameterKey, item.ParameterValue])), parameters(context.intent, context.attempt.id))) fail();
      const actual = await cfn.send(new GetTemplateCommand({ StackName: stack.StackId, TemplateStage: 'Original' }), { abortSignal: context.signal });
      if (typeof actual.TemplateBody !== 'string' || !isDeepStrictEqual(JSON.parse(actual.TemplateBody), JSON.parse(artifact.body))) fail();
      const inventory = await cfn.send(new ListStackResourcesCommand({ StackName: stack.StackId }), { abortSignal: context.signal });
      if (inventory.NextToken || inventory.StackResourceSummaries?.length !== 6) fail();
      const resources: CloudInstallationEvidence['resources'] = [{ kind: 'stack', id: stack.StackId, identity: { createTime: stack.CreationTime.toISOString() } }];
      for (const kind of kinds) {
        const entry = inventory.StackResourceSummaries.find(item => item.LogicalResourceId === kind[0].toUpperCase() + kind.slice(1) + 'Role');
        if (entry?.ResourceType !== 'AWS::IAM::Role' || entry.ResourceStatus !== 'CREATE_COMPLETE' || entry.PhysicalResourceId !== s.roles[kind]) fail();
        resources.push(await verifyRole(context.intent, roles, kind, stack.StackId, context.attempt.id, context.signal, kind === 'provision' ? credentials.roleId : undefined));
      }
      for (const [arn, version] of s.refs) {
        const secret = await secrets.send(new DescribeSecretCommand({ SecretId: arn }), { abortSignal: context.signal });
        if (secret.ARN !== arn || !secret.CreatedDate || secret.DeletedDate || secret.KmsKeyId && !secret.KmsKeyId.endsWith(':alias/aws/secretsmanager')) fail();
        const versions = await secrets.send(new ListSecretVersionIdsCommand({ SecretId: arn, IncludeDeprecated: true, MaxResults: 100 }), { abortSignal: context.signal });
        if (versions.ARN !== arn || versions.NextToken || !versions.Versions?.some(item => item.VersionId === version)) fail();
        resources.push({ kind: 'secret', id: arn, identity: { createTime: secret.CreatedDate.toISOString(), version } });
      }
      const evidence = parseEvidence({ resources, native: { ...native(context.intent, 'install'), attemptId: context.attempt.id, stackId: stack.StackId } }, context.intent);
      if (retained && !isDeepStrictEqual(evidence, retained)) fail(); return { state: 'satisfied', evidence };
    } finally { cfn.destroy(); roles.destroy(); secrets.destroy(); }
  };
  const trustState = async (context: Context) => {
    const s = settings(context.intent), old = original(context.intent), kind = nativeSchema.parse(context.action.metadata.native).operation.slice(7) as 'provision' | 'release' | 'disconnector';
    const role = old.resources.find(item => item.kind === kind)!, disconnector = old.resources.find(item => item.kind === 'disconnector')!;
    let credentials = sessions.get(s.owner);
    if (!credentials || credentials.expiration.getTime() <= Date.now() + 5000) {
      credentials = await assume(context.intent, 'disconnector', context.authentication.host, context.signal, disconnector.identity.roleId);
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!); sessions.set(s.owner, credentials);
    }
    const client = iam(s, credentials);
    try {
      const actual = (await client.send(new GetRoleCommand({ RoleName: s.roles[kind] }), { abortSignal: context.signal })).Role;
      const tags = Object.fromEntries((actual?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
      if (actual?.RoleId !== role.identity.roleId || actual.Arn !== role.id || tags['hypervibe-owner'] !== s.owner || tags['hypervibe-installation'] !== s.installationId) fail();
      const current = parsedPolicy(actual.AssumeRolePolicyDocument), owned = hostedTrust(context.intent.hostIdentity.subject, s.audience(kind), kind).Statement[0], removed = hostedTrust(context.intent.hostIdentity.subject, s.audience(kind), `Disconnected${kind}`, 'Deny').Statement[0];
      const ours = current.Statement.filter(item => item.Sid === owned.Sid);
      if (ours.length > 1 || ours.length && !isDeepStrictEqual(ours[0], owned)) fail();
      const removedAlready = !ours.length && current.Statement.some(item => isDeepStrictEqual(item, removed));
      if (!ours.length && !removedAlready) fail();
      return { client, kind, current, owned, removed, removedAlready, evidence: parseEvidence({ resources: [role], native: { ...native(context.intent, `revoke-${kind}`),
        attemptId: context.attempt?.id ?? old.native.attemptId, stackId: old.native.stackId } }, context.intent) };
    } catch (error) { client.destroy(); throw error; }
  };
  const driver: CloudInstallationDriver = {
    provider: 'aws', parseScope: value => awsDeploymentScopeSchema.parse(value), parseEvidence,
    parseAction(value, intent) { const parsed = z.object({ id: z.string(), type: z.enum(['create', 'update']), resource: z.object({ provider: z.literal('aws'), kind: z.literal('project'), name: z.string() }).strict(),
      verified: z.literal(true), requiresConfirm: z.literal(true), billable: z.literal(false), reason: z.string(), dependsOn: z.array(z.string()).optional(),
      metadata: z.object({ operation: z.literal('awsCloudDeployment'), category: z.enum(['identity', 'trust']), execution: z.enum(['external', 'api']), native: nativeSchema }).strict() }).strict().parse(value);
      const operation = parsed.metadata.native.operation, s = settings(intent), expected = action(intent, operation);
      if (!isDeepStrictEqual({ ...parsed, reason: expected.reason }, expected) || !isDeepStrictEqual(parsed.metadata.native, native(intent, operation)) || intent.mode !== 'disconnect' && operation !== 'install'
        || intent.mode === 'disconnect' && operation === 'install' || parsed.resource.name !== s.stackName) fail(); return parsed; },
    plan: async context => { const s = settings(context.intent); if (context.intent.mode !== 'disconnect') await publication(context.signal); else original(context.intent);
      const stack = `arn:aws:cloudformation:${s.region}:${s.accountId}:stack/${s.stackName}/${'a'.repeat(36)}`;
      if (['provision', 'release', 'execution'].some(kind => JSON.stringify(nativePolicy(kind as Kind, context.intent, stack)).length > 10240)) fail();
      const operations = context.intent.mode === 'disconnect' ? ['revoke-provision', 'revoke-release', 'revoke-disconnector'] as const : ['install'] as const;
      return { actions: operations.map(operation => action(context.intent, operation)), review: {
        resources: kinds.map(kind => ({ kind: `${kind} IAM role`, name: s.roleArns[kind], scope: s.accountId })),
        permissions: [
          ...(['provision', 'release'] as const).map(kind => ({ principal: s.roleArns[kind], scope: `${s.accountId}/${s.region}/${s.clusterName}`, actions: nativePolicy(kind, context.intent, stack).Statement.flatMap(item => item.Action as string[]), purpose: `deployment-${kind}` as 'deployment-provision' | 'deployment-release' })),
          { principal: s.roleArns.execution, scope: s.refs.map(([arn]) => arn).join(',') || 'No application secrets', actions: ['secretsmanager:GetSecretValue', executionPolicy], purpose: 'runtime-reader' as const },
          { principal: s.roleArns.disconnector, scope: kinds.slice(0, 3).map(kind => s.roleArns[kind]).join(','), actions: ['iam:GetRole', 'iam:UpdateAssumeRolePolicy'], purpose: 'hosted-trust-removal' as const },
        ], costs: [{ resource: 'Future ECS Express application', description: 'IAM installation has no direct charge. Separately reviewed apply creates billable Fargate, load balancing, image storage and logging resources; disconnected workloads keep running.', pricingUrl: 'https://aws.amazon.com/ecs/pricing/' }],
        warnings: ['The AWS account number is unverified until native role and CloudFormation evidence is read. Console parameters and template are independently rechecked.',
          'ECS task-definition registration/description and ECR authorization require wildcard resources. Registration alone cannot run code outside the exact reviewed services and PassRole targets.',
          'Deployment can run code under the reviewed runtime identity. Runtime execution IAM reads the selected secret containers; versions are pinned in workload references.',
          'Existing default VPC/subnets are required. Reviewed project apply can create only a security group bearing this installation owner digest; the grant does not authorize creation of a default VPC.',
          'Trust updates have no etag precondition. Concurrent out-of-band trust changes cannot be atomically protected. Previously issued STS sessions last up to 15 minutes; lost final cleanup acknowledgment may require renewed administrator verification.'] } }; },
    inspect: async context => { if (context.intent.mode !== 'disconnect') return { state: 'action-required' }; try { const result = await trustState(context); result.client.destroy(); return result.removedAlready ? { state: 'satisfied', evidence: result.evidence } : { state: 'action-required' }; } catch (error) { return { state: 'unknown', reason: failure(error) }; } },
    mutate: async context => {
      driver.parseAction(context.action, context.intent);
      if (context.intent.mode !== 'disconnect') { const s = settings(context.intent), url = await publication(context.signal); await context.beforeMutation();
        const query = new URLSearchParams({ templateURL: url, stackName: s.stackName }); for (const [key, value] of Object.entries(parameters(context.intent, context.attempt.id))) if (value) query.set(`param_${key}`, value);
        return { state: 'external', url: `https://${s.region}.console.aws.amazon.com/cloudformation/home?region=${s.region}#/stacks/create/review?${query}` }; }
      let client: IAMClient | undefined, started = false;
      try { const result = await trustState(context); client = result.client; if (result.removedAlready) return { state: 'rejected', reason: 'not_converged' };
        const policy = { ...result.current, Statement: [...result.current.Statement.filter(item => item.Sid !== result.owned.Sid), result.removed] };
        await context.beforeMutation(); started = true; await client.send(new UpdateAssumeRolePolicyCommand({ RoleName: settings(context.intent).roles[result.kind], PolicyDocument: JSON.stringify(policy) }), { abortSignal: context.signal });
        return { state: 'acknowledged' };
      } catch (error) { return { state: started ? 'uncertain' : 'rejected', reason: failure(error) }; } finally { client?.destroy(); }
    },
    recover: async context => { try { if (context.intent.mode !== 'disconnect') return await observe(context); const result = await trustState(context); result.client.destroy();
      return result.removedAlready ? { state: 'satisfied', evidence: result.evidence } : { state: 'unknown', reason: 'not_converged' }; } catch (error) { return { state: 'unknown', reason: failure(error) }; } },
    connections: () => { throw new CloudInstallationBoundaryError('identity_mismatch'); },
    deployment: { hostingProvider: 'ecs', prepareIntent: topology,
      assertSourcePlacement(spec, connection) { if (!isDeepStrictEqual(topology(spec, { ...connection, mode: 'connect', stage: 'deployment', keys: [] }), connection.deployment)) throw new CloudDeploymentAccessError('scope_mismatch'); },
      parseReleaseTargets(value, connection) {
        const result = z.array(z.object({ workload: z.string(), kind: z.literal('service'), service: z.object({ id: z.string(), lifetimeId: z.string().datetime() }).strict(),
          registry: z.object({ id: z.string(), lifetimeId: z.string().datetime() }).strict() }).strict()).max(MAX_TARGETS).parse(value);
        const s = awsDeploymentNames(connection), repositoryArn = `arn:aws:ecr:${s.region}:${s.accountId}:repository/hypervibe/${s.clusterName}`;
        for (const target of result) if (!connection.deployment.workloads.some(item => item.name === target.workload)
          || target.service.id !== `arn:aws:ecs:${s.region}:${s.accountId}:service/${s.clusterName}/${resourceName(target.workload, { maxLength: 255 })}` || target.registry.id !== repositoryArn) fail();
        return result;
      },
      async verifyReleaseTargets(input) {
        driver.deployment!.assertSourcePlacement!(input.spec, input.connection);
        const binding = z.object({ provider: z.literal('ecs'), projectId: z.string(), environmentId: z.string(),
          services: z.record(z.string(), z.object({ serviceId: z.string(), resourceUid: z.string().datetime() }).passthrough()),
          awsDeploymentRegistry: z.object({ id: z.string(), createdAt: z.string().datetime() }).strict() }).passthrough().parse(input.bindings);
        const s = awsDeploymentNames(input.connection), clusterArn = `arn:aws:ecs:${s.region}:${s.accountId}:cluster/${s.clusterName}`, repositoryArn = `arn:aws:ecr:${s.region}:${s.accountId}:repository/hypervibe/${s.clusterName}`;
        if (binding.projectId !== clusterArn || binding.environmentId !== clusterArn || binding.awsDeploymentRegistry.id !== repositoryArn) fail();
        const issued = await driver.deployment!.issueSession!({ connection: input.connection, capability: 'release', host: input.host, signal: input.signal, beforeIssue: input.beforeIssue });
        if (issued.kind !== 'aws-sts') fail();
        const config = { region: s.region, credentials: { accessKeyId: issued.accessKeyId, secretAccessKey: issued.secretAccessKey, sessionToken: issued.sessionToken }, requestHandler: options.requestHandler, maxAttempts: 1 };
        const ecs = new ECSClient(config), ecr = new ECRClient(config); boundAwsSdkResponses(ecs); boundAwsSdkResponses(ecr);
        try {
          const repositories = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [`hypervibe/${s.clusterName}`] }), { abortSignal: input.signal });
          const repository = repositories.repositories?.length === 1 ? repositories.repositories[0] : undefined;
          if (repository?.repositoryArn !== repositoryArn || repository.repositoryName !== `hypervibe/${s.clusterName}` || repository.createdAt?.toISOString() !== binding.awsDeploymentRegistry.createdAt) fail();
          const tags = await ecr.send(new ListTagsForResourceCommand({ resourceArn: repositoryArn }), { abortSignal: input.signal });
          const owner = Object.fromEntries((tags.tags ?? []).map(item => [item.Key, item.Value]));
          if (owner['hypervibe-owner'] !== s.owner || owner['hypervibe-installation'] !== input.connection.installationId) fail();
          const targets = [];
          for (const workload of input.connection.deployment.workloads) {
            const declared = binding.services[workload.name], arn = `arn:aws:ecs:${s.region}:${s.accountId}:service/${s.clusterName}/${resourceName(workload.name, { maxLength: 255 })}`;
            if (!declared || declared.serviceId !== arn) fail();
            const service = (await ecs.send(new DescribeExpressGatewayServiceCommand({ serviceArn: arn, include: ['TAGS'] }), { abortSignal: input.signal })).service;
            const serviceTags = Object.fromEntries((service?.tags ?? []).map(item => [item.key, item.value]));
            if (service?.serviceArn !== arn || service.cluster !== clusterArn || service.createdAt?.toISOString() !== declared.resourceUid || service.status?.statusCode !== 'ACTIVE'
              || serviceTags['hypervibe-owner'] !== s.owner || serviceTags['hypervibe-installation'] !== input.connection.installationId) fail();
            const config = ecsCurrentConfiguration(service);
            if (typeof config.taskDefinitionArn !== 'string' || !config.taskDefinitionArn.startsWith(`arn:aws:ecs:${s.region}:${s.accountId}:task-definition/`)) fail();
            const task = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: config.taskDefinitionArn }), { abortSignal: input.signal })).taskDefinition;
            const runtime = input.connection.runtimeIdentities.filter(item => item.workload === workload.name && item.principal.kind === 'aws-role');
            const expected = (purpose: string) => { const principal = runtime.find(item => item.principal.kind === 'aws-role' && item.principal.purpose === purpose)?.principal; return principal?.kind === 'aws-role' ? principal.roleArn : undefined; };
            if (!task || task.taskDefinitionArn !== config.taskDefinitionArn || task.taskRoleArn !== expected('task') || task.executionRoleArn !== expected('execution')) fail();
            targets.push({ workload: workload.name, kind: 'service' as const, service: { id: arn, lifetimeId: service.createdAt!.toISOString() }, registry: { id: repositoryArn, lifetimeId: repository.createdAt!.toISOString() } });
          }
          await input.beforeIssue(); return driver.deployment!.parseReleaseTargets!(targets, input.connection);
        } finally { ecs.destroy(); ecr.destroy(); }
      },
      connection(record) {
        if (record.status !== 'ready' || record.intent.mode !== 'connect') fail(); const s = settings(record.intent), evidence = parseEvidence(record.completed['aws-deployment:install'], record.intent);
        const principals = Object.fromEntries((['provision', 'release'] as const).map(kind => [kind, { kind: 'aws-role', accountId: s.accountId, roleArn: s.roleArns[kind],
          roleId: evidence.resources.find(item => item.kind === kind)!.identity.roleId, audience: s.audience(kind) }])) as CloudDeploymentConnectionV1['principals'];
        const { schemaVersion, customerId, appId, environment, source, provider, nativeScope, hostIdentity } = record.intent;
        return parseCloudDeploymentConnectionV1({ schemaVersion, purpose: 'deployment', installationId: s.installationId, planDigest: record.plan.digest, customerId, appId, environment, source,
          provider, hostingProvider: 'ecs', deployment: s.deployment, nativeScope, hostIdentity, principals,
          runtimeIdentities: s.deployment.workloads.flatMap(workload => (['task', 'execution', 'infrastructure'] as const).map(kind => ({ workload: workload.name, installationId: s.installationId,
            owner: s.owner, principal: { kind: 'aws-role', purpose: kind, accountId: s.accountId, roleArn: s.roleArns[kind], roleId: evidence.resources.find(item => item.kind === kind)!.identity.roleId } }))) },
        { provider: 'aws', hostingProvider: 'ecs', parseScope: value => awsDeploymentScopeSchema.parse(value) });
      },
      async issueSession(input) {
        const connection = parseCloudDeploymentConnectionV1(input.connection, { provider: 'aws', hostingProvider: 'ecs', parseScope: value => awsDeploymentScopeSchema.parse(value) });
        const intent: CloudInstallationIntent = { ...connection, mode: 'connect', stage: 'deployment', keys: [] };
        const s = settings(intent), principal = connection.principals[input.capability]; if (principal.kind !== 'aws-role' || principal.roleArn !== s.roleArns[input.capability] || principal.audience !== s.audience(input.capability)) fail();
        await input.beforeIssue(); const credentials = await assume(intent, input.capability, input.host, input.signal, principal.roleId);
        const client = iam(s, credentials);
        try {
          const role = (await client.send(new GetRoleCommand({ RoleName: s.roles[input.capability] }), { abortSignal: input.signal })).Role;
          const tags = Object.fromEntries((role?.Tags ?? []).map(item => [item.Key, item.Value]));
          if (role?.RoleId !== principal.roleId || !tags['hypervibe-attempt']) fail();
          const cfn = new CloudFormationClient({ region: s.region, credentials, maxAttempts: 1, requestHandler: options.requestHandler }); boundAwsSdkResponses(cfn);
          let stackId: string;
          try { const response = await cfn.send(new DescribeStacksCommand({ StackName: s.stackName }), { abortSignal: input.signal }); const stack = response.Stacks?.length === 1 ? response.Stacks[0] : undefined;
            if (!stack?.StackId || stack.StackStatus !== 'CREATE_COMPLETE' || !stack.StackId.startsWith(`arn:aws:cloudformation:${s.region}:${s.accountId}:stack/${s.stackName}/`)
              || !isDeepStrictEqual(Object.fromEntries((stack.Parameters ?? []).map(item => [item.ParameterKey, item.ParameterValue])), parameters(intent, tags['hypervibe-attempt']))) fail(); stackId = stack.StackId;
          } finally { cfn.destroy(); }
          await verifyRole(intent, client, input.capability, stackId, tags['hypervibe-attempt'], input.signal, principal.roleId);
          // A retained role ARN can name a replacement principal. The same
          // immutable runtime IDs must still exist before issuing either capability.
          for (const kind of ['task', 'execution', 'infrastructure'] as const) {
            const runtime = connection.runtimeIdentities.filter(item => item.principal.kind === 'aws-role' && item.principal.purpose === kind);
            const ids = runtime.map(item => item.principal.kind === 'aws-role' ? item.principal.roleId : '');
            if (!ids.length || new Set(ids).size !== 1) fail();
            await verifyRole(intent, client, kind, stackId, tags['hypervibe-attempt'], input.signal, ids[0]);
          }
          await input.beforeIssue(); return { kind: 'aws-sts', principal, accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, expiresAt: credentials.expiration.toISOString() };
        } finally { client.destroy(); }
      },
    },
  };
  function action(intent: CloudInstallationIntent, operation: z.infer<typeof nativeSchema>['operation']): CloudInstallationAction {
    const index = ['revoke-provision', 'revoke-release', 'revoke-disconnector'].indexOf(operation);
    return { id: `aws-deployment:${operation}`, type: operation === 'install' ? 'create' : 'update', resource: { provider: 'aws', kind: 'project', name: settings(intent).stackName }, verified: true,
      requiresConfirm: true, billable: false, reason: operation === 'install' ? 'Install separately authorized provision, release and runtime identities through reviewed AWS CloudFormation.' : 'Remove only hosted deployment trust; preserve workloads, runtime identities and stored secrets.',
      ...(index > 0 ? { dependsOn: [`aws-deployment:${index === 1 ? 'revoke-provision' : 'revoke-release'}`] } : {}),
      metadata: { operation: 'awsCloudDeployment', category: operation === 'install' ? 'identity' : 'trust', execution: operation === 'install' ? 'external' : 'api', native: native(intent, operation) } };
  }
  return driver;
}
