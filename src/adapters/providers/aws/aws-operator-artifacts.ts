import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, DescribeStackEventsCommand, GetTemplateCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { S3Client, GetBucketVersioningCommand, GetBucketOwnershipControlsCommand, GetPublicAccessBlockCommand, GetBucketTaggingCommand,
  HeadObjectCommand, PutObjectCommand, GetBucketPolicyCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
import { S3ControlClient, GetPublicAccessBlockCommand as GetAccountPublicAccessBlockCommand } from '@aws-sdk/client-s3-control';
import { STSClient, GetCallerIdentityCommand, type STSClientConfig } from '@aws-sdk/client-sts';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type CloudInstallationRecord, type OperatorArtifactCapability, type OperatorArtifactIntent } from '../../../domain/ports/cloud-installation.port.js';
import { parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { DestinationBudget } from '../secret-destination-http.js';
import { boundAwsSdkResponses } from './aws-secret-destination.js';
import { createAwsCloudInstallationTemplateV1 } from './aws-cloud-installation.js';
import { createAwsCloudDeploymentTemplateV1 } from './aws-cloud-deployment.js';
import { verifyAwsCloudFormationPublication } from './aws-cloudformation-publication.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().guid();
const kinds = ['aws-collection-template-v1', 'aws-deployment-template-v1'] as const;
type Kind = typeof kinds[number];
const versionId = z.string().min(1).max(1024).refine(value => value !== 'null' && !/[\u0000-\u0020\u007f]/.test(value));
const declarationSchema = z.object({ scopeKind: z.literal('s3-cloudformation-publication-v1'), accountId: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/) }).strict();
export const awsOperatorArtifactScopeSchema = declarationSchema.extend({
  collectionTemplateSha256: digest.optional(), deploymentTemplateSha256: digest.optional(),
  collectionVersionId: versionId.optional(), collectionAttemptId: uuid.optional(), collectionInstallationId: uuid.optional(),
  deploymentVersionId: versionId.optional(), deploymentAttemptId: uuid.optional(), deploymentInstallationId: uuid.optional(),
  targetInstallationId: uuid.optional(), targetAttemptId: uuid.optional(),
  targetStackId: z.string().regex(/^arn:aws:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z0-9-]+\/[a-f0-9-]+$/).optional(),
  targetCreateTime: z.string().datetime().optional(),
}).strict().superRefine((value, ctx) => {
  const count = [value.targetInstallationId, value.targetAttemptId, value.targetStackId, value.targetCreateTime].filter(value => value !== undefined).length;
  if (count !== 0 && count !== 4 || !value.collectionTemplateSha256 && !value.deploymentTemplateSha256)
    ctx.addIssue({ code: 'custom', message: 'Publication requires exact artifact digests and complete target ownership proof.' });
  for (const prefix of ['collection', 'deployment'] as const) {
    const count = [value[`${prefix}VersionId`], value[`${prefix}AttemptId`], value[`${prefix}InstallationId`]].filter(value => value !== undefined).length;
    if (count !== 0 && (count !== 3 || !value[`${prefix}TemplateSha256`] || !value.targetStackId))
      ctx.addIssue({ code: 'custom', message: 'Reused immutable versions require complete prior ownership proof.' });
  }
});
type Intent = OperatorArtifactIntent;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
type RecordV1 = CloudInstallationRecord<Intent>;
type Policy = { Version: string; Statement: Array<Record<string, unknown>>; [key: string]: unknown };
const TARGET = 'aws:operator-artifacts:target', PUBLIC = 'aws:operator-artifacts:public';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => JSON.stringify(key) + ':' + canonical(value)).join(',') + '}';
  return JSON.stringify(value);
}
const policyHash = (value: Policy) => hash(canonical(value));
const emptyPolicy = (): Policy => ({ Version: '2012-10-17', Statement: [] });
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'ownership_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function template(kind: Kind) { return kind === 'aws-collection-template-v1' ? createAwsCloudInstallationTemplateV1() : createAwsCloudDeploymentTemplateV1(); }
function names(intent: Intent) {
  const scope = awsOperatorArtifactScopeSchema.parse(intent.nativeScope);
  if (intent.provider !== 'aws' || intent.artifactProvider !== 's3' || intent.execution.authentication !== 'aws-session'
    || !intent.artifacts.length || intent.artifacts.some(value => !kinds.includes(value as Kind)) || new Set(intent.artifacts).size !== intent.artifacts.length) fail('identity_mismatch');
  if (Boolean(scope.collectionTemplateSha256) !== intent.artifacts.includes(kinds[0]) || Boolean(scope.deploymentTemplateSha256) !== intent.artifacts.includes(kinds[1])) fail('identity_mismatch');
  const targetInstallationId = scope.targetInstallationId ?? intent.installationId;
  const owner = hash(JSON.stringify([intent.customerId, intent.appId, intent.environment, targetInstallationId, scope.accountId, scope.region]));
  const stackName = `hypervibe-artifacts-${owner.slice(0, 20)}`, bucket = `hv-artifacts-${scope.accountId}-${owner.slice(0, 20)}`;
  if (scope.targetStackId && !scope.targetStackId.startsWith(`arn:aws:cloudformation:${scope.region}:${scope.accountId}:stack/${stackName}/`)) fail('identity_mismatch');
  return { ...scope, targetInstallationId, owner, stackName, bucket };
}
function artifact(intent: Intent, kind: string) {
  if (!kinds.includes(kind as Kind) || !intent.artifacts.includes(kind)) fail('identity_mismatch');
  const n = names(intent), sha256 = kind === kinds[0] ? n.collectionTemplateSha256! : n.deploymentTemplateSha256!;
  const prefix = kind === kinds[0] ? 'collection' : 'deployment';
  const retained = n[`${prefix}VersionId`] ? { versionId: n[`${prefix}VersionId`]!, attemptId: n[`${prefix}AttemptId`]!, installationId: n[`${prefix}InstallationId`]! } : undefined;
  return { kind: kind as Kind, sha256, retained, key: `cloudformation/${sha256}.json`, id: `aws:operator-artifacts:upload:${kind}` };
}
function targetTemplate(intent: Intent, attemptId: string) {
  const n = names(intent), tags = [{ Key: 'hypervibe-owner', Value: n.owner }, { Key: 'hypervibe-installation', Value: n.targetInstallationId }, { Key: 'hypervibe-attempt', Value: attemptId }];
  return { AWSTemplateFormatVersion: '2010-09-09', Description: 'Hypervibe operator template publication target; object versions retained.', Resources: {
    Artifacts: { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: { BucketName: n.bucket,
      VersioningConfiguration: { Status: 'Enabled' }, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false }, Tags: tags } },
  } };
}
function actions(intent: Intent, priorPolicyDigest = policyHash(emptyPolicy())): CloudInstallationAction[] {
  const n = names(intent);
  return [{ id: TARGET, type: n.targetStackId ? 'noop' : 'create', resource: { kind: 'project', name: n.stackName, provider: 'aws' }, verified: true,
    requiresConfirm: !n.targetStackId, billable: !n.targetStackId, dataBearing: !n.targetStackId,
    reason: 'Create and verify one owned CloudFormation stack containing a versioned operator template bucket; preserve account-wide public-access settings.',
    metadata: { operation: 'target', category: 'scope', execution: 'api', native: {} } },
  ...intent.artifacts.map((kind): CloudInstallationAction => { const a = artifact(intent, kind); return { id: a.id, type: a.retained ? 'noop' : 'create',
    resource: { kind: 'storage' as const, name: `${n.bucket}/${a.key}`, provider: 'aws' }, verified: true, requiresConfirm: !a.retained, billable: !a.retained, dataBearing: !a.retained,
    dependsOn: [TARGET], reason: `Upload only the reviewed packaged ${kind} bytes with a conditional create and retain the returned immutable object version.`,
    metadata: { operation: kind, category: 'scope' as const, execution: 'api' as const, native: {} } }; }),
  { id: PUBLIC, type: 'update', resource: { kind: 'storage', name: n.bucket, provider: 'aws' }, verified: true, requiresConfirm: true,
    dependsOn: intent.artifacts.map(kind => artifact(intent, kind).id), reason: 'Permit anonymous GetObjectVersion only for the exact reviewed template versions; grant no list, latest-version read or write.',
    metadata: { operation: 'public', category: 'trust', execution: 'api', native: { priorPolicyDigest } } }];
}
const evidenceSchema = z.object({ resources: z.array(z.object({ kind: z.enum(['stack', 'object']), id: z.string().max(2048), identity: z.object({
  owner: digest, installationId: uuid, attemptId: uuid, createTime: z.string().datetime().optional(), bucket: z.string().optional(),
  versionId: z.string().min(1).max(1024).refine(value => value !== 'null' && !/[\u0000-\u0020\u007f]/.test(value)).optional(),
  sha256: digest.optional(), key: z.string().max(1024).optional(),
}).strict() }).strict()).max(3), native: z.object({ operation: z.string(), actionId: z.string(), installationId: uuid,
  attemptId: uuid.optional(), stackId: z.string().max(2048).optional(), policyDigest: digest.optional(), policyConcurrency: z.literal('no-native-cas').optional(),
}).strict() }).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const parsed = evidenceSchema.parse(value), n = names(intent);
  if (parsed.native.installationId !== intent.installationId || !actions(intent).some(action => action.id === parsed.native.actionId && action.metadata.operation === parsed.native.operation)) fail();
  if (parsed.native.stackId && !parsed.native.stackId.startsWith(`arn:aws:cloudformation:${n.region}:${n.accountId}:stack/${n.stackName}/`)) fail('identity_mismatch');
  if (!parsed.resources.length) {
    if (parsed.native.operation !== 'target' || !parsed.native.stackId || !parsed.native.attemptId) fail('identity_mismatch');
    return parsed;
  }
  const stack = parsed.resources[0];
  if (parsed.native.stackId && stack.id !== parsed.native.stackId || stack.kind !== 'stack' || !stack.id.startsWith(`arn:aws:cloudformation:${n.region}:${n.accountId}:stack/${n.stackName}/`)
    || stack.identity.owner !== n.owner || stack.identity.installationId !== n.targetInstallationId || stack.identity.bucket !== n.bucket) fail();
  if (n.targetStackId && (stack.id !== n.targetStackId || stack.identity.createTime !== n.targetCreateTime || stack.identity.attemptId !== n.targetAttemptId)) fail('identity_mismatch');
  for (const object of parsed.resources.slice(1)) {
    const a = intent.artifacts.map(kind => artifact(intent, kind)).find(a => a.key === object.identity.key);
    if (object.kind !== 'object' || !a || object.id !== `arn:aws:s3:::${n.bucket}/${a.key}` || object.identity.owner !== n.owner
      || object.identity.installationId !== (a.retained?.installationId ?? intent.installationId) || !object.identity.versionId || object.identity.sha256 !== a.sha256
      || a.retained && (object.identity.versionId !== a.retained.versionId || object.identity.attemptId !== a.retained.attemptId)) fail();
  }
  if (parsed.native.operation === 'target' && parsed.resources.length !== 1 || kinds.includes(parsed.native.operation as Kind)
    && (parsed.resources.length !== 2 || parsed.resources[1].identity.key !== artifact(intent, parsed.native.operation).key)) fail('identity_mismatch');
  if (new Set(parsed.resources.slice(1).map(value => value.identity.key)).size !== parsed.resources.length - 1) fail('identity_mismatch');
  if (parsed.native.operation === 'public' && (parsed.resources.length !== intent.artifacts.length + 1 || !parsed.native.policyDigest || parsed.native.policyConcurrency !== 'no-native-cas')) fail();
  return parsed;
}
function proof(context: ActionContext, resources: CloudInstallationEvidence['resources'], extra: { policyDigest?: string; stackId?: string } = {}): CloudInstallationEvidence {
  const retainedDigest = context.attempt?.evidence?.native.policyDigest;
  if (typeof retainedDigest === 'string' && extra.policyDigest) extra = { ...extra, policyDigest: retainedDigest };
  if (typeof context.attempt?.evidence?.native.stackId === 'string') extra = { ...extra, stackId: context.attempt.evidence.native.stackId };
  return parseEvidence({ resources, native: { operation: context.action.metadata.operation, actionId: context.action.id,
    installationId: context.intent.installationId, ...(context.attempt ? { attemptId: context.attempt.id } : {}), ...extra,
    ...(extra.policyDigest ? { policyConcurrency: 'no-native-cas' } : {}) } }, context.intent);
}
function status(error: unknown) { return error && typeof error === 'object' && '$metadata' in error ? (error.$metadata as { httpStatusCode?: number })?.httpStatusCode : undefined; }
function reason(error: unknown) { return error instanceof CloudInstallationBoundaryError ? error.reason : status(error) === 403 ? 'insufficient_permissions' as const
  : status(error) === 401 ? 'authorization_expired' as const : 'provider_error' as const; }
function errorName(error: unknown) { return error && typeof error === 'object' && 'name' in error ? String(error.name) : ''; }

export function createAwsOperatorArtifactDriver(options: { requestHandler?: STSClientConfig['requestHandler']; fetch?: typeof fetch } = {}): CloudInstallationDriver<Intent> {
  async function clients<T>(context: Context, work: (clients: { cfn: CloudFormationClient; s3: S3Client; signal: AbortSignal }) => Promise<T>) {
    const n = names(context.intent), budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    if (!context.authentication.awsSession) { budget.close(); fail('authorization_expired'); }
    let credentials;
    try { credentials = await budget.wait(context.authentication.awsSession.getCredentials(budget.signal)); } catch (error) { budget.close(); throw error; }
    if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken || !(credentials.expiration instanceof Date)
      || credentials.expiration.getTime() <= Date.now() + 30_000) { budget.close(); fail('authorization_expired'); }
    const config = { region: n.region, credentials, maxAttempts: 1, requestHandler: options.requestHandler };
    const sts = new STSClient(config), control = new S3ControlClient(config), cfn = new CloudFormationClient(config), s3 = new S3Client(config);
    for (const client of [sts, control, cfn, s3]) boundAwsSdkResponses(client);
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: budget.signal });
      // Console login issues temporary credentials for IAM users and root too.
      // Session token/expiry above establish the temporary boundary; the caller
      // ARN identifies the principal, not whether its credentials are long-lived.
      const caller = identity.Arn?.match(/^arn:aws:(iam|sts)::(\d{12}):([^\s]+)$/);
      const principal = caller?.[1] === 'iam' ? /^(?:root|user\/.+)$/.test(caller[3])
        : caller?.[1] === 'sts' && /^(?:assumed-role\/[^/]+\/[^/]+|federated-user\/[^/]+)$/.test(caller[3]);
      if (identity.Account !== n.accountId || caller?.[2] !== n.accountId || !principal || !identity.UserId) fail('identity_mismatch');
      try {
        const result = await control.send(new GetAccountPublicAccessBlockCommand({ AccountId: n.accountId }), { abortSignal: budget.signal });
        if (!result.PublicAccessBlockConfiguration || result.PublicAccessBlockConfiguration.BlockPublicPolicy !== false
          || result.PublicAccessBlockConfiguration.RestrictPublicBuckets !== false) fail('insufficient_permissions');
      } catch (error) { if (errorName(error) !== 'NoSuchPublicAccessBlockConfiguration' || status(error) !== 404) throw error; }
      return await work({ cfn, s3, signal: budget.signal });
    } finally { sts.destroy(); control.destroy(); cfn.destroy(); s3.destroy(); budget.close(); }
  }
  type Clients = Parameters<Parameters<typeof clients>[1]>[0];
  async function target(client: Clients, context: Context, attempt?: CloudInstallationAttempt): Promise<CloudInstallationEvidence['resources'][number] | null> {
    const n = names(context.intent), retained = context.completed[TARGET]?.resources[0] ?? attempt?.evidence?.resources[0];
    const requested = retained?.id ?? String(attempt?.evidence?.native.stackId ?? n.targetStackId ?? n.stackName);
    let result;
    try { result = await client.cfn.send(new DescribeStacksCommand({ StackName: requested }), { abortSignal: client.signal }); }
    catch (error) {
      if (errorName(error) === 'ValidationError' && status(error) === 400 && error instanceof Error
        && error.message === `Stack with id ${requested} does not exist`) return null;
      throw error;
    }
    const stack = result.Stacks?.length === 1 ? result.Stacks[0] : undefined;
    const expectedAttempt = retained?.identity.attemptId ?? n.targetAttemptId ?? attempt?.id;
    const tags = Object.fromEntries((stack?.Tags ?? []).map(tag => [tag.Key, tag.Value]));
    if (!stack?.StackId || !(stack.CreationTime instanceof Date) || stack.StackName !== n.stackName || !expectedAttempt
      || !stack.StackId.startsWith(`arn:aws:cloudformation:${n.region}:${n.accountId}:stack/${n.stackName}/`)
      || tags['hypervibe-owner'] !== n.owner || tags['hypervibe-installation'] !== n.targetInstallationId || tags['hypervibe-attempt'] !== expectedAttempt) fail();
    const item = { kind: 'stack', id: stack.StackId, identity: { owner: n.owner, installationId: n.targetInstallationId,
      attemptId: expectedAttempt, createTime: stack.CreationTime.toISOString(), bucket: n.bucket } };
    if (retained && (retained.id !== item.id || retained.identity.createTime && retained.identity.createTime !== item.identity.createTime)
      || n.targetStackId && (n.targetStackId !== item.id || n.targetCreateTime !== item.identity.createTime)) fail('identity_mismatch');
    if (stack.StackStatus === 'CREATE_IN_PROGRESS') return null;
    if (stack.StackStatus !== 'CREATE_COMPLETE') fail('not_converged');
    const observed = await client.cfn.send(new GetTemplateCommand({ StackName: stack.StackId, TemplateStage: 'Original' }), { abortSignal: client.signal });
    if (typeof observed.TemplateBody !== 'string' || !isDeepStrictEqual(JSON.parse(observed.TemplateBody), targetTemplate(context.intent, expectedAttempt))) fail();
    const resources = await client.cfn.send(new ListStackResourcesCommand({ StackName: stack.StackId }), { abortSignal: client.signal });
    if (resources.NextToken || resources.StackResourceSummaries?.length !== 1 || resources.StackResourceSummaries[0].LogicalResourceId !== 'Artifacts'
      || resources.StackResourceSummaries[0].PhysicalResourceId !== n.bucket || resources.StackResourceSummaries[0].ResourceType !== 'AWS::S3::Bucket'
      || resources.StackResourceSummaries[0].ResourceStatus !== 'CREATE_COMPLETE') fail();
    const events = await client.cfn.send(new DescribeStackEventsCommand({ StackName: stack.StackId }), { abortSignal: client.signal });
    if (!events.StackEvents?.some(event => event.StackId === stack.StackId && event.PhysicalResourceId === stack.StackId
      && event.ResourceType === 'AWS::CloudFormation::Stack' && event.ClientRequestToken === expectedAttempt)) fail('ownership_mismatch');
    const config = { Bucket: n.bucket, ExpectedBucketOwner: n.accountId };
    const versioning = await client.s3.send(new GetBucketVersioningCommand(config), { abortSignal: client.signal });
    const ownership = await client.s3.send(new GetBucketOwnershipControlsCommand(config), { abortSignal: client.signal });
    const block = await client.s3.send(new GetPublicAccessBlockCommand(config), { abortSignal: client.signal });
    const tagging = await client.s3.send(new GetBucketTaggingCommand(config), { abortSignal: client.signal });
    const bucketTags = Object.fromEntries((tagging.TagSet ?? []).map(tag => [tag.Key,tag.Value]));
    if (versioning.Status !== 'Enabled' || ownership.OwnershipControls?.Rules?.length !== 1 || ownership.OwnershipControls.Rules[0].ObjectOwnership !== 'BucketOwnerEnforced'
      || !isDeepStrictEqual(block.PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false })
      || ['hypervibe-owner','hypervibe-installation','hypervibe-attempt'].some(key => bucketTags[key] !== tags[key])) fail('identity_mismatch');
    return item;
  }
  async function ownedTarget(client: Clients, context: Context) {
    const observed = await target(client, context);
    if (!observed) fail('not_converged'); return observed;
  }
  async function object(client: Clients, context: Context, kind: string, attempt?: CloudInstallationAttempt) {
    const n = names(context.intent), a = artifact(context.intent, kind);
    const retained = context.completed[a.id]?.resources[1] ?? attempt?.evidence?.resources[1] ?? (a.retained ? {
      kind: 'object', id: `arn:aws:s3:::${n.bucket}/${a.key}`, identity: { owner: n.owner, ...a.retained, key: a.key, sha256: a.sha256 } } : undefined);
    let result;
    try { result = await client.s3.send(new HeadObjectCommand({ Bucket: n.bucket, Key: a.key, ExpectedBucketOwner: n.accountId,
      ChecksumMode: 'ENABLED', ...(retained ? { VersionId: retained.identity.versionId } : {}) }), { abortSignal: client.signal }); }
    catch (error) { if (status(error) === 404 && ['NotFound', 'NoSuchKey'].includes(errorName(error))) return null; throw error; }
    const expectedAttempt = retained?.identity.attemptId ?? attempt?.id;
    if (!expectedAttempt || !Number.isSafeInteger(result.ContentLength) || result.ContentLength! <= 0 || result.ContentLength! > 1_048_576 || !result.VersionId || result.VersionId === 'null' || /[\u0000-\u0020\u007f]/.test(result.VersionId)
      || result.ChecksumSHA256 !== Buffer.from(a.sha256, 'hex').toString('base64') || result.ContentType !== 'application/json'
      || result.Metadata?.['hv-owner'] !== n.owner || result.Metadata?.['hv-installation'] !== (a.retained?.installationId ?? context.intent.installationId)
      || result.Metadata?.['hv-attempt'] !== expectedAttempt || result.Metadata?.['hv-sha256'] !== a.sha256) fail('ownership_mismatch');
    const item = { kind: 'object', id: `arn:aws:s3:::${n.bucket}/${a.key}`, identity: { owner: n.owner, installationId: a.retained?.installationId ?? context.intent.installationId,
      attemptId: expectedAttempt, versionId: result.VersionId, key: a.key, sha256: a.sha256 } };
    if (retained && !isDeepStrictEqual(retained, item)) fail('identity_mismatch'); return item;
  }
  async function policy(client: Clients, intent: Intent): Promise<Policy> {
    const n = names(intent); let result;
    try { result = await client.s3.send(new GetBucketPolicyCommand({ Bucket: n.bucket, ExpectedBucketOwner: n.accountId }), { abortSignal: client.signal }); }
    catch (error) { if (status(error) === 404 && errorName(error) === 'NoSuchBucketPolicy') return emptyPolicy(); throw error; }
    if (typeof result.Policy !== 'string' || Buffer.byteLength(result.Policy) > 20480) fail('identity_mismatch');
    const parsed = JSON.parse(result.Policy);
    if (!parsed || parsed.Version !== '2012-10-17' || !Array.isArray(parsed.Statement) || parsed.Statement.some((value: unknown) => !value || typeof value !== 'object' || Array.isArray(value))) fail('identity_mismatch');
    return parsed;
  }
  async function publication(client: Clients, context: Context) {
    const stack = await ownedTarget(client, context), objects = [];
    for (const kind of context.intent.artifacts) { const value = await object(client, context, kind); if (!value) fail('not_converged');
      if (url(context.intent, value).length > 1024) fail('identity_mismatch'); objects.push(value); }
    const statements = objects.map(value => ({ Sid: `HypervibeVersion${hash(value.id + value.identity.versionId).slice(0,32)}`,
      Effect: 'Allow', Principal: '*', Action: 's3:GetObjectVersion', Resource: value.id,
      Condition: { StringEquals: { 's3:VersionId': value.identity.versionId } } }));
    const current = await policy(client, context.intent);
    for (const statement of statements) if (current.Statement.some(value => value.Sid === statement.Sid && !isDeepStrictEqual(value, statement))) fail('ownership_mismatch');
    return { resources: [stack, ...objects], statements, current, present: statements.every(statement => current.Statement.some(value => isDeepStrictEqual(value, statement))) };
  }
  async function observe(client: Clients, context: ActionContext) {
    if (context.action.id === TARGET) {
      const value = await target(client, context, context.attempt);
      if (!value) return context.attempt ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
      return { state: 'satisfied' as const, evidence: proof(context, [value]) };
    }
    if (context.action.id === PUBLIC) {
      const value = await publication(client, context);
      if (!value.present) return context.attempt ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
      for (const item of value.resources.slice(1)) await verifyAwsCloudFormationPublication({ templateUrl: url(context.intent, item), sha256: item.identity.sha256,
        signal: client.signal, fetch: options.fetch });
      return { state: 'satisfied' as const, evidence: proof(context, value.resources, { policyDigest: policyHash(value.current) }) };
    }
    const stack = await ownedTarget(client, context), value = await object(client, context, context.action.metadata.operation, context.attempt);
    if (!value) return context.attempt ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
    return { state: 'satisfied' as const, evidence: proof(context, [stack,value]) };
  }
  const driver: CloudInstallationDriver<Intent> = {
    provider: 'aws', artifactPublication: { providerName: 's3', authentication: 'aws-session' }, parseScope: value => awsOperatorArtifactScopeSchema.parse(value), parseEvidence,
    parseAction(value, intent) {
      const supplied = value as CloudInstallationAction;
      const prior = supplied?.id === PUBLIC ? digest.parse(supplied.metadata?.native.priorPolicyDigest) : undefined;
      const expected = actions(intent, prior).find(action => isDeepStrictEqual(action, value)); if (!expected) fail('identity_mismatch'); return expected;
    },
    scopePreparation: { resolvedScope: record => { receipts(record); return awsOperatorArtifactScopeSchema.parse(record.intent.nativeScope); },
      reviewResources: record => [{ kind: 'operator-template-bucket', name: names(record.intent).bucket, scope: names(record.intent).accountId }] },
    async plan(context) {
      const n = names(context.intent);
      for (const kind of context.intent.artifacts) if (artifact(context.intent,kind).sha256 !== template(kind as Kind).sha256) fail('identity_mismatch');
      const prior = await clients(context, async client => {
        const existing = await target(client, context);
        if (n.targetStackId) { if (!existing) fail('not_converged'); return policyHash(await policy(client, context.intent)); }
        if (existing) fail('ownership_mismatch'); return policyHash(emptyPolicy());
      });
      return { actions: actions(context.intent,prior), review: { resources: [{ kind: 'CloudFormation stack', name: n.stackName, scope: `${n.accountId}/${n.region}` },
        { kind: 'versioned operator-template bucket', name: n.bucket, scope: `${n.accountId}/${n.region}` },
        ...context.intent.artifacts.map(kind => ({ kind, name: `${n.bucket}/${artifact(context.intent,kind).key}`, scope: `${n.accountId}/${n.region}` }))],
        permissions: [{ principal: 'Current verified temporary AWS operator session', scope: n.bucket,
          actions: ['cloudformation:CreateStack', 's3:PutObject with If-None-Match:*', 's3:PutBucketPolicy'], purpose: 'installation-verification' },
        { principal: '*', scope: n.bucket, actions: ['s3:GetObjectVersion for exact reviewed versions'], purpose: 'installation-verification' }],
        costs: [{ resource: n.bucket, description: 'S3 storage and requests are billed; only the two selected nonsecret JSON templates are uploaded.', pricingUrl: 'https://aws.amazon.com/s3/pricing/' }],
        warnings: ['Account public-access controls are read and never changed. Account policy restrictions stop publication.',
          'CloudFormation acceptance establishes create authority; AWS sign-in and account identity alone do not establish write permission.',
          'S3 bucket policy has no native compare-and-swap. The exact reviewed policy digest is re-read immediately before replacement and unrelated statements are preserved, but a concurrent external policy writer cannot be excluded atomically.',
          'Uncertain writes retain their attempts and are only observed. Public reads use immutable nonnull object versions; latest-version reads and listing are not granted.'] } };
    },
    async inspect(context) { try { driver.parseAction(context.action,context.intent); return await clients(context,client => observe(client,context)); }
      catch (error) { return { state: 'unknown', reason: reason(error) }; } },
    async mutate(context) {
      let dispatched = false;
      try { driver.parseAction(context.action,context.intent); return await clients(context,async client => {
        const n = names(context.intent);
        if ((await observe(client,{...context,attempt:undefined})).state !== 'action-required') fail('not_converged');
        if (context.action.id === TARGET) {
          await context.beforeMutation(); dispatched = true;
          const body = targetTemplate(context.intent,context.attempt.id);
          const result = await client.cfn.send(new CreateStackCommand({ StackName:n.stackName, TemplateBody:JSON.stringify(body), ClientRequestToken:context.attempt.id,
            OnFailure:'DO_NOTHING', Tags:body.Resources.Artifacts.Properties.Tags }),{abortSignal:client.signal});
          if (!result.StackId?.startsWith(`arn:aws:cloudformation:${n.region}:${n.accountId}:stack/${n.stackName}/`)) fail('identity_mismatch');
          return {state:'acknowledged' as const,evidence:proof(context,[],{stackId:result.StackId})};
        }
        if (context.action.id === PUBLIC) {
          const value = await publication(client,context);
          if (policyHash(value.current) !== context.action.metadata.native.priorPolicyDigest) fail('identity_mismatch');
          const next = {...value.current,Statement:[...value.current.Statement,...value.statements.filter(statement=>!value.current.Statement.some(item=>isDeepStrictEqual(item,statement)))]};
          if (Buffer.byteLength(JSON.stringify(next))>20480) fail('identity_mismatch');
          await context.beforeMutation();
          if (policyHash(await policy(client,context.intent)) !== context.action.metadata.native.priorPolicyDigest) fail('identity_mismatch');
          dispatched=true;
          await client.s3.send(new PutBucketPolicyCommand({Bucket:n.bucket,ExpectedBucketOwner:n.accountId,Policy:JSON.stringify(next)}),{abortSignal:client.signal});
          return {state:'acknowledged' as const,evidence:proof(context,value.resources,{policyDigest:policyHash(next)})};
        }
        const a=artifact(context.intent,context.action.metadata.operation), bytes=template(a.kind);
        if (bytes.sha256!==a.sha256) fail('identity_mismatch');
        const stack=await ownedTarget(client,context); await context.beforeMutation(); dispatched=true;
        const result=await client.s3.send(new PutObjectCommand({Bucket:n.bucket,ExpectedBucketOwner:n.accountId,Key:a.key,Body:bytes.body,
          ContentType:'application/json',IfNoneMatch:'*',ChecksumSHA256:Buffer.from(a.sha256,'hex').toString('base64'),ServerSideEncryption:'AES256',
          Metadata:{'hv-owner':n.owner,'hv-installation':context.intent.installationId,'hv-attempt':context.attempt.id,'hv-sha256':a.sha256}}),{abortSignal:client.signal});
        if (!result.VersionId || result.VersionId==='null') fail('identity_mismatch');
        return {state:'acknowledged' as const,evidence:proof(context,[stack,{kind:'object',id:`arn:aws:s3:::${n.bucket}/${a.key}`,identity:{owner:n.owner,
          installationId:context.intent.installationId,attemptId:context.attempt.id,versionId:result.VersionId,key:a.key,sha256:a.sha256}}])};
      }); } catch(error) { return {state:!dispatched||[400,401,403,404,409,412].includes(status(error)??0)?'rejected':'uncertain',reason:reason(error)}; }
    },
    async recover(context) { try { driver.parseAction(context.action,context.intent); return await clients(context,client=>observe(client,context)); }
      catch(error) {return {state:'unknown',reason:reason(error)};} }, connections:()=>[],
  }; return driver;
}
function url(intent:Intent, object:CloudInstallationEvidence['resources'][number]) {
  const n=names(intent);return `https://${n.bucket}.s3.${n.region}.amazonaws.com/${object.identity.key}?versionId=${encodeURIComponent(object.identity.versionId)}`;
}
function receipts(record:RecordV1):Array<Record<string,string>> {
  if(record.status!=='scope-ready') fail('not_converged');
  const value=parseEvidence(record.completed[PUBLIC],record.intent),n=names(record.intent);
  return value.resources.slice(1).map(object=>({kind:artifact(record.intent,record.intent.artifacts.find(kind=>artifact(record.intent,kind).key===object.identity.key)!).kind,
    accountId:n.accountId,region:n.region,bucket:n.bucket,key:object.identity.key,versionId:object.identity.versionId,sha256:object.identity.sha256,
    url:url(record.intent,object),stackId:value.resources[0].id,policyConcurrency:'no-native-cas'}));
}
export function createAwsOperatorArtifactCapability():OperatorArtifactCapability {
  return {schemaVersion:1,
    parseDeclaration(value,artifacts) {
      const scope=declarationSchema.parse(value);
      if(!artifacts.length||new Set(artifacts).size!==artifacts.length||artifacts.some(kind=>!kinds.includes(kind as Kind)))fail('identity_mismatch');
      return awsOperatorArtifactScopeSchema.parse({...scope,...(artifacts.includes(kinds[0])?{collectionTemplateSha256:template(kinds[0]).sha256}:{}),
        ...(artifacts.includes(kinds[1])?{deploymentTemplateSha256:template(kinds[1]).sha256}:{})});
    },
    parseRecord:value=>parseCloudInstallationRecordV1(value,createAwsOperatorArtifactDriver()),
    async create(scope,signal) {
      const { region } = awsOperatorArtifactScopeSchema.parse(scope);if(signal?.aborted)fail('cancelled');
      const read=defaultProvider();
      return {driver:createAwsOperatorArtifactDriver(),authentication:{kind:'operator-artifact-publisher',awsSession:{async getCredentials(signal){
        const budget=new DestinationBudget({signal,deadlineMs:15000});try{const credentials=await budget.wait(read({callerClientConfig:{region:async()=>region}}));
          if(!credentials.sessionToken||!(credentials.expiration instanceof Date)||credentials.expiration.getTime()<=Date.now()+30000)fail('authorization_expired');
          return {accessKeyId:credentials.accessKeyId,secretAccessKey:credentials.secretAccessKey,sessionToken:credentials.sessionToken,expiration:credentials.expiration};
        }catch{fail('authorization_expired');}finally{budget.close();}
      }}}};
    },
    nextScope:record=>{receipts(record);return null;},receipts,
    refreshScope(record,declaration,artifacts) {
      receipts(record);const previous=names(record.intent),next=awsOperatorArtifactScopeSchema.parse(declaration);
      if(previous.accountId!==next.accountId||previous.region!==next.region||artifacts.some(kind=>!kinds.includes(kind as Kind)))fail('identity_mismatch');
      const stack=parseEvidence(record.completed[TARGET],record.intent).resources[0];
      const reused: Record<string,string> = {};
      for (const kind of artifacts) {
        const previousObject = parseEvidence(record.completed[PUBLIC], record.intent).resources.slice(1).find(value => value.identity.sha256 === (kind === kinds[0] ? next.collectionTemplateSha256 : next.deploymentTemplateSha256));
        if (previousObject) { const prefix = kind === kinds[0] ? 'collection' : 'deployment';
          Object.assign(reused, { [`${prefix}VersionId`]: previousObject.identity.versionId, [`${prefix}AttemptId`]: previousObject.identity.attemptId, [`${prefix}InstallationId`]: previousObject.identity.installationId }); }
      }
      return awsOperatorArtifactScopeSchema.parse({...next,...reused,targetInstallationId:previous.targetInstallationId,targetAttemptId:stack.identity.attemptId,
        targetStackId:stack.id,targetCreateTime:stack.identity.createTime});
    },
  };
}
