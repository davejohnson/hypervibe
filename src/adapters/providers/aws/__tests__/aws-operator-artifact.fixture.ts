import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { CloudInstallationRecord, OperatorArtifactIntent } from '../../../../domain/ports/cloud-installation.port.js';
import { createAwsOperatorArtifactCapability, createAwsOperatorArtifactDriver } from '../aws-operator-artifacts.js';

// Reconstructed AWS Query/XML and S3 REST headers through the actual SDK.
// Independent native contracts: CreateStack ClientRequestToken + stack lifetime;
// PutObject If-None-Match:* / 412; nonnull S3 VersionId; version-only bucket policy.
export const AWS_OPERATOR_ARTIFACT_KINDS = ['aws-collection-template-v1', 'aws-deployment-template-v1'];
const artifacts = AWS_OPERATOR_ARTIFACT_KINDS;
type Caller = { account?: string; arn?: string; userId?: string };
export function awsOperatorArtifactBoundary(options: { lost?: 'stack' | 'object' | 'policy'; blockedPublic?: boolean; wrongAccount?: boolean; conflict?: boolean; caller?: Caller } = {}) {
  const capability = createAwsOperatorArtifactCapability();
  const scope = capability.parseDeclaration({ scopeKind: 's3-cloudformation-publication-v1', accountId: '123456789012', region: 'us-west-2' }, artifacts, {});
  const intent: OperatorArtifactIntent = { schemaVersion: 1, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', customerId: 'customer', appId: 'app', environment: 'staging',
    provider: 'aws', artifactProvider: 's3', execution: { kind: 'operator-artifact-publisher', authentication: 'aws-session' }, mode: 'connect', stage: 'scope-preparation', keys: [],
    artifacts, nativeScope: scope, source: { kind: 'local-spec', repository: 'github.com/acme/operator', specRevision: 1, specDigest: 'a'.repeat(64) } };
  let saved: CloudInstallationRecord<OperatorArtifactIntent> | null = null;
  let stack: any, template: any, policy: any, lost = false, readsDenied = false;
  const objects = new Map<string, { body: string; version: string; metadata: Record<string, string>; digest: string }>();
  const writes: string[] = [], requests: any[] = [];
  const xml = (body: string, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/xml' }, body: Buffer.from(body) } });
  const query = (name: string, body: string) => xml(`<${name}Response><${name}Result>${body}</${name}Result><ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></${name}Response>`);
  const error = (code: string, status = 404, message = 'synthetic') => xml(`<ErrorResponse><Error><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`, status);
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let caller: Caller = options.caller ?? { account: options.wrongAccount ? '999999999999' : '123456789012',
    arn: 'arn:aws:sts::123456789012:assumed-role/operator/synthetic', userId: 'AROASYNTHETIC123456789:synthetic' };
  const handler = { handle: async (request: any) => {
    requests.push(request);
    expect(request.headers.authorization).toContain('ASIASYNTHETICPUBLISHER');
    expect(request.headers['x-amz-security-token']).toBe('synthetic-session-token');
    const raw = request.body ? String(request.body) : '', body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const operation = body.Action ?? request.headers['x-amz-target']?.split('.').at(-1);
    if (operation === 'GetCallerIdentity') return query(operation, Object.entries({ Account: caller.account, Arn: caller.arn, UserId: caller.userId })
      .filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `<${key}>${escape(value)}</${key}>`).join(''));
    if (request.hostname.includes('s3-control')) return options.blockedPublic
      ? xml('<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>')
      : error('NoSuchPublicAccessBlockConfiguration');
    if (operation === 'CreateStack') {
      writes.push('stack'); template = JSON.parse(body.TemplateBody);
      const bucket = template.Resources.Artifacts.Properties.BucketName;
      const tags: Record<string, string> = {};
      for (let i = 1; body[`Tags.member.${i}.Key`]; i++) tags[body[`Tags.member.${i}.Key`]] = body[`Tags.member.${i}.Value`];
      stack = { name: body.StackName, id: `arn:aws:cloudformation:us-west-2:123456789012:stack/${body.StackName}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
        created: '2026-10-25T00:00:00Z', token: body.ClientRequestToken, bucket, tags };
      if (options.lost === 'stack' && !lost) { lost = true; throw new Error('lost stack acknowledgment'); }
      return query(operation, `<StackId>${stack.id}</StackId>`);
    }
    if (readsDenied && (operation === 'DescribeStacks' || request.method === 'HEAD')) return error('AccessDenied', 403);
    if (operation === 'DescribeStacks') return !stack ? error('ValidationError', 400, `Stack with id ${body.StackName} does not exist`)
      : query(operation, `<Stacks><member><StackId>${stack.id}</StackId><StackName>${stack.name}</StackName><CreationTime>${stack.created}</CreationTime><StackStatus>CREATE_COMPLETE</StackStatus><Tags>${Object.entries(stack.tags).map(([key,value]) => `<member><Key>${key}</Key><Value>${value}</Value></member>`).join('')}</Tags></member></Stacks>`);
    if (operation === 'GetTemplate') return query(operation, `<TemplateBody>${escape(JSON.stringify(template))}</TemplateBody>`);
    if (operation === 'ListStackResources') return query(operation, `<StackResourceSummaries><member><LogicalResourceId>Artifacts</LogicalResourceId><PhysicalResourceId>${stack.bucket}</PhysicalResourceId><ResourceType>AWS::S3::Bucket</ResourceType><ResourceStatus>CREATE_COMPLETE</ResourceStatus><LastUpdatedTimestamp>${stack.created}</LastUpdatedTimestamp></member></StackResourceSummaries>`);
    if (operation === 'DescribeStackEvents') return query(operation, `<StackEvents><member><EventId>synthetic-create-event</EventId><StackId>${stack.id}</StackId><StackName>${stack.name}</StackName><PhysicalResourceId>${stack.id}</PhysicalResourceId><ResourceType>AWS::CloudFormation::Stack</ResourceType><ResourceStatus>CREATE_IN_PROGRESS</ResourceStatus><Timestamp>${stack.created}</Timestamp><ClientRequestToken>${stack.token}</ClientRequestToken></member></StackEvents>`);
    expect(request.headers['x-amz-expected-bucket-owner']).toBe('123456789012');
    if ('versioning' in request.query) return xml('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>');
    if ('ownershipControls' in request.query) return xml('<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>');
    if ('publicAccessBlock' in request.query) return xml('<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>false</BlockPublicPolicy><RestrictPublicBuckets>false</RestrictPublicBuckets></PublicAccessBlockConfiguration>');
    if ('tagging' in request.query) return xml(`<Tagging><TagSet>${Object.entries(stack.tags).map(([key,value]) => `<Tag><Key>${key}</Key><Value>${value}</Value></Tag>`).join('')}</TagSet></Tagging>`);
    if ('policy' in request.query) {
      if (request.method === 'GET') return policy ? { response: { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(policy)) } } : error('NoSuchBucketPolicy');
      writes.push('policy'); policy = JSON.parse(raw);
      if (options.lost === 'policy' && !lost) { lost = true; throw new Error('lost policy acknowledgment'); }
      return { response: { statusCode: 204, headers: {}, body: Buffer.alloc(0) } };
    }
    const key = decodeURIComponent(request.path.replace(/^\//, ''));
    if (request.method === 'PUT') {
      expect(request.headers['if-none-match']).toBe('*');
      writes.push('object');
      if (options.conflict) return error('PreconditionFailed', 412);
      const metadata = Object.fromEntries(Object.entries(request.headers).filter(([key]) => key.startsWith('x-amz-meta-')).map(([key,value]) => [key.slice(11), String(value)]));
      const object = { body: raw, version: `version-${objects.size + 1}`, metadata, digest: createHash('sha256').update(raw).digest('base64') }; objects.set(key, object);
      if (options.lost === 'object' && !lost) { lost = true; throw new Error('lost object acknowledgment'); }
      return { response: { statusCode: 200, headers: { 'x-amz-version-id': object.version, etag: '"synthetic-etag"', 'x-amz-checksum-sha256': object.digest }, body: Buffer.alloc(0) } };
    }
    if (request.method === 'HEAD') {
      const object = objects.get(key); if (!object) return error('NotFound');
      return { response: { statusCode: 200, headers: { 'x-amz-version-id': object.version, etag: '"synthetic-etag"', 'x-amz-checksum-sha256': object.digest,
        'content-length': String(Buffer.byteLength(object.body)), 'content-type': 'application/json', ...Object.fromEntries(Object.entries(object.metadata).map(([key,value]) => [`x-amz-meta-${key}`,value])) }, body: Buffer.alloc(0) } };
    }
    throw new Error('Unexpected serialized AWS publisher request');
  } };
  const anonymous: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), key = decodeURIComponent(url.pathname.slice(1)), object = objects.get(key);
    expect(new Headers(init?.headers).has('authorization')).toBe(false); expect(init?.redirect).toBe('error');
    const permitted = object && policy?.Statement.some((statement: any) => statement.Action === 's3:GetObjectVersion'
      && statement.Resource === `arn:aws:s3:::${stack.bucket}/${key}` && statement.Condition.StringEquals['s3:VersionId'] === object.version);
    const response = new Response(permitted ? object!.body : '', { status: permitted ? 200 : 403, headers: permitted ? { 'x-amz-version-id': object!.version } : {} });
    Object.defineProperty(response, 'url', { value: String(input) }); return response;
  };
  const driver = createAwsOperatorArtifactDriver({ requestHandler: handler, fetch: anonymous });
  const input = { driver, authentication: { kind: 'operator-artifact-publisher' as const, awsSession: { getCredentials: async () => ({ accessKeyId: 'ASIASYNTHETICPUBLISHER',
    secretAccessKey: 'synthetic-session-secret', sessionToken: 'synthetic-session-token', expiration: new Date(Date.now() + 900000) }) } }, authorize: async () => true,
    store: { read: async () => structuredClone(saved), compareAndSwap: async (_id: string, revision: number | null, next: CloudInstallationRecord<OperatorArtifactIntent>) => {
      if (revision !== (saved?.revision ?? null)) return false;
      for (const previous of saved?.attempts ?? []) {
        if (!previous.evidence) continue;
        const current = next.attempts.find(attempt => attempt.id === previous.id)?.evidence;
        expect(current).toBeDefined();
        for (const [key,value] of Object.entries(previous.evidence.native)) expect(current!.native[key]).toEqual(value);
        for (const [index,value] of previous.evidence.resources.entries()) expect(current!.resources[index]).toEqual(value);
      }
      saved = structuredClone(next); return true;
    } } };
  return { intent, input, setCaller: (value: Caller) => { caller = value; }, setReadsDenied: (value: boolean) => { readsDenied = value; }, writes, objects, requests, capability, policy: () => policy, setPolicy: (value: any) => { policy = value; }, resetRecord: () => { saved = null; }, stack: () => stack };
}

