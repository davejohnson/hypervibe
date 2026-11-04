import { expect } from 'vitest';
import type { awsOperatorArtifactBoundary } from './aws-operator-artifact.fixture.js';

/** Reconstructed official AWS Query/XML and S3 REST responses. This wraps the
 * real publication producer and SDK; no live deletion has been performed. */
export function awsArtifactRetirementBoundary(original: ReturnType<typeof awsOperatorArtifactBoundary>) {
  const state = { bucket: true, stackStatus: 'CREATE_COMPLETE', deleteToken: '', denied: false,
    lost: '' as '' | 'policy' | 'stack' | 'version' | 'bucket', stackPending: false, bucketReplacement: false,
    foreignVersion: false, deleteMarker: false, multipart: false, partialVersions: false, partialBuckets: false,
    paginateVersions:false,paginateBuckets:false,lostBefore:false,denyWrites:false,pageOwnerMismatch:false };
  const writes: string[] = [], reads: string[] = [];
  const xml = (body: string, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/xml' }, body: Buffer.from(body) } });
  const query = (name: string, body: string) => xml(`<${name}Response><${name}Result>${body}</${name}Result><ResponseMetadata><RequestId>synthetic</RequestId></ResponseMetadata></${name}Response>`);
  const error = (code: string, status = 404) => xml(`<ErrorResponse><Error><Code>${code}</Code><Message>synthetic private error</Message></Error></ErrorResponse>`, status);
  const empty = () => ({ response: { statusCode: 204, headers: {}, body: Buffer.alloc(0) } });
  function ack(kind: typeof state.lost) { if (state.lost === kind) { state.lost = ''; throw new Error('synthetic lost acknowledgment'); } }
  const handler = { handle: async (request: any) => {
    const raw=request.body?String(request.body):'';
    const body = raw.startsWith('{')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));
    const operation = body.Action??request.headers['x-amz-target']?.split('.').at(-1), stack = original.stack();
    const isWrite = operation === 'DeleteStack' || !operation && ['DELETE','PUT'].includes(request.method);
    if (isWrite) writes.push(operation ?? `${request.method}:${request.path}:${Object.keys(request.query).sort().join(',')}`);
    else reads.push(operation ?? `${request.method}:${request.path}:${Object.keys(request.query).sort().join(',')}`);
    if (state.denied && operation !== 'GetCallerIdentity') return error('AccessDenied',403);
    if(isWrite&&state.denyWrites)return error('AccessDenied',403);
    if(isWrite&&state.lostBefore){state.lostBefore=false;throw new Error('Synthetic unknown pre-acknowledgment outcome');}
    if (operation === 'GetCallerIdentity') return original.handler.handle(request);
    if (operation === 'DescribeStacks') {
      expect(body.StackName).toBe(stack.id);
      return query(operation, `<Stacks><member><StackId>${stack.id}</StackId><StackName>${stack.name}</StackName><CreationTime>${stack.created}</CreationTime><StackStatus>${state.stackStatus}</StackStatus><Tags>${Object.entries(stack.tags).map(([key,value])=>`<member><Key>${key}</Key><Value>${value}</Value></member>`).join('')}</Tags></member></Stacks>`);
    }
    if (operation === 'DeleteStack') {
      expect(body.StackName).toBe(stack.id); expect(body.DeletionMode).toBe('STANDARD'); expect(body.ClientRequestToken).toMatch(/^[a-f0-9-]{36}$/);
      expect(body.RoleARN).toBeUndefined(); expect(body['RetainResources.member.1']).toBeUndefined();
      state.deleteToken=body.ClientRequestToken; state.stackStatus=state.stackPending?'DELETE_IN_PROGRESS':'DELETE_COMPLETE'; ack('stack'); return query(operation,'');
    }
    if (operation === 'DescribeStackEvents' && state.deleteToken) return query(operation, `<StackEvents><member><EventId>synthetic-delete-event</EventId><StackId>${stack.id}</StackId><StackName>${stack.name}</StackName><PhysicalResourceId>${stack.id}</PhysicalResourceId><ResourceType>AWS::CloudFormation::Stack</ResourceType><ResourceStatus>${state.stackStatus}</ResourceStatus><Timestamp>2026-11-04T00:00:00Z</Timestamp><ClientRequestToken>${state.deleteToken}</ClientRequestToken></member></StackEvents>`);
    if (operation) return original.handler.handle(request);
    if (request.hostname.startsWith('s3.') && request.path==='/') {
      expect(request.method).toBe('GET'); expect(request.query['max-buckets']).toBeDefined();
      const more=state.paginateBuckets&&!request.query['continuation-token'];
      const own=state.bucket&&!more?`<Bucket><Name>${stack.bucket}</Name><CreationDate>${stack.created}</CreationDate></Bucket>`:'';
      const unrelated=!request.query['continuation-token']?`<Bucket><Name>${stack.bucket}-other</Name><CreationDate>2020-01-01T00:00:00Z</CreationDate></Bucket>`:'';
      return xml(`<ListAllMyBucketsResult><Owner><ID>${state.pageOwnerMismatch&&request.query['continuation-token']?'different-owner':'synthetic-owning-account'}</ID></Owner><Buckets>${own}${unrelated}</Buckets>${state.partialBuckets?'<ContinuationToken>same</ContinuationToken>':more?'<ContinuationToken>second</ContinuationToken>':''}</ListAllMyBucketsResult>`);
    }
    expect(request.hostname.startsWith(`${stack.bucket}.s3.`)).toBe(true);
    expect(request.headers['x-amz-expected-bucket-owner']).toBe('123456789012');
    if (!state.bucket) return error('NoSuchBucket');
    if ('versions' in request.query) {
      expect(request.method).toBe('GET'); expect(request.query.prefix).toBeUndefined(); expect(request.query.delimiter).toBeUndefined();
      const entries=[...original.objects],more=state.paginateVersions&&entries.length>1&&!request.query['key-marker'];
      if(request.query['key-marker']){expect(request.query['key-marker']).toBe(entries[0][0]);expect(request.query['version-id-marker']).toBe(entries[0][1].version);}
      const selected=more?entries.slice(0,1):request.query['key-marker']?entries.slice(1):entries;
      const versions=selected.map(([key,item])=>`<Version><Key>${key}</Key><VersionId>${item.version}</VersionId><IsLatest>true</IsLatest><LastModified>2026-10-25T00:00:00Z</LastModified><ETag>"synthetic"</ETag><Size>${Buffer.byteLength(item.body)}</Size></Version>`).join('');
      return xml(`<ListVersionsResult><Name>${stack.bucket}</Name><IsTruncated>${state.partialVersions||more}</IsTruncated>${versions}${state.foreignVersion&&!more?'<Version><Key>foreign</Key><VersionId>foreign-version</VersionId><IsLatest>true</IsLatest><Size>1</Size></Version>':''}${state.deleteMarker?'<DeleteMarker><Key>foreign</Key><VersionId>marker-version</VersionId><IsLatest>true</IsLatest></DeleteMarker>':''}${state.partialVersions?'<NextKeyMarker>same</NextKeyMarker><NextVersionIdMarker>same</NextVersionIdMarker>':more?`<NextKeyMarker>${entries[0][0]}</NextKeyMarker><NextVersionIdMarker>${entries[0][1].version}</NextVersionIdMarker>`:''}</ListVersionsResult>`);
    }
    if ('uploads' in request.query) return xml(`<ListMultipartUploadsResult><Bucket>${stack.bucket}</Bucket><IsTruncated>false</IsTruncated>${state.multipart?'<Upload><Key>foreign</Key><UploadId>unrelated-upload</UploadId></Upload>':''}</ListMultipartUploadsResult>`);
    if ('policy' in request.query && request.method!=='GET') {
      if(request.method==='DELETE') original.setPolicy(undefined); else original.setPolicy(JSON.parse(String(request.body)));
      ack('policy'); return empty();
    }
    if (request.method==='DELETE' && request.path==='/') {
      expect(original.objects.size).toBe(0); expect(state.deleteMarker||state.foreignVersion||state.multipart).toBe(false);
      state.bucket=false; ack('bucket'); return empty();
    }
    if (request.method==='DELETE') {
      const key=decodeURIComponent(request.path.slice(1)), item=original.objects.get(key);
      expect(item).toBeDefined();expect(request.query.versionId).toBe(item!.version);
      expect(request.query['x-id']).toBe('DeleteObject');expect(Object.keys(request.query).sort()).toEqual(['versionId','x-id']);
      expect(request.headers['if-match']).toBeUndefined();expect(request.headers['x-amz-bypass-governance-retention']).toBeUndefined();
      original.objects.delete(key);ack('version');return {response:{statusCode:204,headers:{'x-amz-version-id':item!.version},body:Buffer.alloc(0)}};
    }
    if (state.bucketReplacement && 'tagging' in request.query) return xml('<Tagging><TagSet><Tag><Key>hypervibe-owner</Key><Value>different-lifetime</Value></Tag></TagSet></Tagging>');
    return original.handler.handle(request);
  }};
  return {handler,state,writes,reads};
}
