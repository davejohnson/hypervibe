import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { STSClient, GetCallerIdentityCommand, type STSClientConfig } from '@aws-sdk/client-sts';
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand, ListStackResourcesCommand, DescribeStackEventsCommand, DeleteStackCommand } from '@aws-sdk/client-cloudformation';
import { S3Client, ListBucketsCommand, GetBucketVersioningCommand, GetBucketOwnershipControlsCommand, GetBucketTaggingCommand,
  ListObjectVersionsCommand, ListMultipartUploadsCommand, HeadObjectCommand, GetBucketPolicyCommand, PutBucketPolicyCommand,
  DeleteBucketPolicyCommand, DeleteObjectCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationEvidence, type CloudInstallationProviderContext,
  type CloudInstallationRecord, type CloudInstallationDriver, type OperatorArtifactIntent } from '../../../domain/ports/cloud-installation.port.js';
import { historicalInstallationEvidence, parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { operatorRetirementOutcomeSchema } from '../../../domain/ports/operator-retirement.port.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import { DestinationBudget } from '../secret-destination-http.js';
import { boundAwsSdkResponses } from './aws-secret-destination.js';
import { awsOperatorArtifactNames, awsOperatorArtifactScopeSchema, awsOperatorArtifactTargetTemplate, createAwsOperatorArtifactDriver, parseAwsOperatorArtifactEvidence } from './aws-operator-artifacts.js';

type Intent = OperatorArtifactIntent;
type RecordV1 = CloudInstallationRecord<Intent>;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & {action: CloudInstallationAction};
const hash = (value:string)=>createHash('sha256').update(value).digest('hex');
const digest=z.string().regex(/^[a-f0-9]{64}$/), uuid=z.string().guid(), coordinate=z.string().min(1).max(2048).refine(s=>!/[\u0000-\u0020\u007f]/.test(s));
const reference=z.object({installationId:uuid,planDigest:digest,evidenceDigest:digest}).strict();
const stackSchema=z.object({id:coordinate,owner:digest,installationId:uuid,attemptId:uuid,createTime:z.string().datetime(),bucket:coordinate}).strict();
const objectSchema=z.object({id:coordinate,key:z.string().regex(/^cloudformation\/[a-f0-9]{64}\.json$/),versionId:coordinate.refine(s=>s!=='null'),sha256:digest,owner:digest,installationId:uuid,attemptId:uuid}).strict();
const targetSchema=z.object({references:z.array(reference).min(1).max(20),from:z.object({installationId:uuid,planDigest:digest}).strict(),
  ownerScopeDigest:digest,scope:z.lazy(()=>awsOperatorArtifactScopeSchema),stack:stackSchema,objects:z.array(objectSchema).min(1).max(40)}).strict();
type Target=z.infer<typeof targetSchema>;
const nativeSchema=z.object({target:targetSchema,operation:z.enum(['remove-public-access','remove-stack','remove-version','remove-bucket']),
  versionId:coordinate.optional(),key:coordinate.optional(),policyBeforeDigest:digest,policyAfterDigest:digest}).strict();
type Native=z.infer<typeof nativeSchema>;
type Policy={Version:string;Statement:Array<Record<string,unknown>>;[key:string]:unknown};
const emptyPolicy=():Policy=>({Version:'2012-10-17',Statement:[]});
function fail(reason:ConstructorParameters<typeof CloudInstallationBoundaryError>[0]='ownership_mismatch'):never{throw new CloudInstallationBoundaryError(reason);}
const status=(error:unknown)=>error&&typeof error==='object'&&'$metadata'in error?(error.$metadata as {httpStatusCode?:number})?.httpStatusCode:undefined;
const errorName=(error:unknown)=>error&&typeof error==='object'&&'name'in error?String(error.name):'';
const reason=(error:unknown)=>error instanceof CloudInstallationBoundaryError?error.reason:status(error)===403?'insufficient_permissions' as const:status(error)===401?'authorization_expired' as const:'provider_error' as const;
function origin(intent:Intent,target:Target):Intent{return {...intent,installationId:target.from.installationId,mode:'connect',nativeScope:target.scope};}
function ownerScope(intent:Intent){return canonicalJsonSha256([intent.customerId,intent.appId,intent.environment,intent.source.repository]);}
function statements(target:Target){return target.objects.map(item=>({Sid:`HypervibeVersion${hash(item.id+item.versionId).slice(0,32)}`,Effect:'Allow',Principal:'*',Action:'s3:GetObjectVersion',Resource:item.id,Condition:{StringEquals:{'s3:VersionId':item.versionId}}}));}
function removeOwned(policy:Policy,target:Target){
  const owned=statements(target);
  for(const statement of owned){const matches=policy.Statement.filter(item=>item.Sid===statement.Sid);if(matches.length>1||matches.some(item=>!isDeepStrictEqual(item,statement)))fail();}
  const remaining=policy.Statement.filter(item=>!owned.some(statement=>isDeepStrictEqual(item,statement)));
  // DeleteBucketPolicy removes the entire document, including optional Id.
  // When other statements remain, their document metadata is preserved.
  return remaining.length?{...policy,Statement:remaining}:emptyPolicy();
}
function actionFor(native:Native,intent:Intent):CloudInstallationAction{
  const target=native.target,version=target.objects.find(item=>item.key===native.key&&item.versionId===native.versionId);
  if((native.operation==='remove-version')!==Boolean(version)||native.operation!=='remove-version'&&(native.key!==undefined||native.versionId!==undefined))fail();
  const prefix='aws:operator-artifacts:retire:',versionId=(item:Target['objects'][number])=>prefix+'version:'+hash(item.key+'\0'+item.versionId).slice(0,32);
  const index=version?target.objects.indexOf(version):-1;
  const id=native.operation==='remove-version'?versionId(version!):prefix+native.operation;
  const parent=native.operation==='remove-stack'?prefix+'remove-public-access':native.operation==='remove-version'?(index?versionId(target.objects[index-1]):prefix+'remove-stack'):
    native.operation==='remove-bucket'?versionId(target.objects.at(-1)!):undefined;
  if(intent.retirement?.data==='retain'&&['remove-version','remove-bucket'].includes(native.operation))fail();
  const reasons={
    'remove-public-access':'Remove only the owned public-read statements for the exact reviewed template versions; preserve unrelated policy statements.',
    'remove-stack':'Delete the exact original CloudFormation stack. Its Retain policy leaves the bucket and object versions in place.',
    'remove-version':'Permanently delete this exact reviewed object version, without a latest-version delete or retention bypass.',
    'remove-bucket':'Delete the owned bucket only after complete version, delete-marker and multipart-upload inventories are empty.',
  };
  return{id,type:native.operation==='remove-public-access'?'update':'destroy',resource:{kind:native.operation==='remove-stack'?'project':'storage',provider:'aws',name:version?`${version.id}?versionId=${encodeURIComponent(version.versionId)}`:native.operation==='remove-stack'?target.stack.id:target.stack.bucket},
    verified:true,requiresConfirm:true,dataBearing:native.operation!=='remove-public-access',...(parent?{dependsOn:[parent]}:{}),reason:reasons[native.operation],
    metadata:{operation:'artifact-retirement',category:'scope',execution:'api',native}};
}

export function createAwsOperatorArtifactRetirementDriver(records?:RecordV1[],options:{requestHandler?:STSClientConfig['requestHandler']}={}):CloudInstallationDriver<Intent>{
  const setup=createAwsOperatorArtifactDriver();
  const originals=records?.map(item=>parseCloudInstallationRecordV1(item,setup));
  function compile(intent:Intent):Target{
    if(!originals?.length||originals.length!==intent.retirement?.targets.length)fail();
    const parent=originals.find(item=>item.installationId===intent.retirement!.from.installationId&&item.plan.digest===intent.retirement!.from.planDigest);if(!parent)fail();
    const objects=new Map<string,Target['objects'][number]>();let stack:Target['stack']|undefined;
    const references=originals.map(record=>{
      const proof=historicalInstallationEvidence(record);if(record.intent.mode!=='connect'||!proof||ownerScope(record.intent)!==ownerScope(intent))fail();
      const publication=parseAwsOperatorArtifactEvidence(proof['aws:operator-artifacts:public'],record.intent);
      const attempt=record.attempts.filter(item=>item.actionId==='aws:operator-artifacts:public').at(-1);
      if(attempt?.status!=='succeeded'||attempt.id!==publication.native.attemptId||!isDeepStrictEqual(attempt.evidence,publication))fail();
      const first=publication.resources[0], current=stackSchema.parse({id:first.id,...first.identity});
      if(stack&&!isDeepStrictEqual(stack,current))fail();stack=current;
      for(const resource of publication.resources.slice(1)){
        const object=objectSchema.parse({id:resource.id,...resource.identity}),key=object.key+'\0'+object.versionId,existing=objects.get(key);
        if(existing&&!isDeepStrictEqual(existing,object))fail();objects.set(key,object);
      }
      return{installationId:record.installationId,planDigest:record.plan.digest,evidenceDigest:canonicalJsonSha256(proof)};
    });
    return targetSchema.parse({references,from:intent.retirement!.from,ownerScopeDigest:ownerScope(intent),scope:parent.intent.nativeScope,stack,objects:[...objects.values()].sort((a,b)=>(a.key+'\0'+a.versionId).localeCompare(b.key+'\0'+b.versionId))});
  }
  function targetFor(value:unknown,intent:Intent):Target{
    const target=targetSchema.parse(value), n=awsOperatorArtifactNames(origin(intent,target));
    if(intent.mode!=='retire'||intent.provider!=='aws'||intent.artifactProvider!=='s3'||!intent.retirement||intent.retirement.resources!=='delete-owned'
      ||intent.retirement.continueFrom||intent.retirement.outputTargets||!isDeepStrictEqual(intent.retirement.targets,target.references)
      ||!isDeepStrictEqual(intent.retirement.from,target.from)||!isDeepStrictEqual(intent.predecessor,target.from)||!isDeepStrictEqual(intent.nativeScope,target.scope)
      ||target.ownerScopeDigest!==ownerScope(intent)||target.stack.bucket!==n.bucket||target.stack.owner!==n.owner||target.stack.installationId!==n.targetInstallationId
      ||!target.stack.id.startsWith(`arn:aws:cloudformation:${n.region}:${n.accountId}:stack/${n.stackName}/`)
      ||target.objects.some(item=>item.owner!==n.owner||item.id!==`arn:aws:s3:::${n.bucket}/${item.key}`||item.key!==`cloudformation/${item.sha256}.json`)
      ||new Set(target.objects.map(item=>item.key+'\0'+item.versionId)).size!==target.objects.length
      ||originals&&!isDeepStrictEqual(compile(intent),target))fail();
    return target;
  }
  function nativeFor(value:unknown,intent:Intent){const native=nativeSchema.parse(value);targetFor(native.target,intent);return native;}
  function parseAction(value:unknown,intent:Intent){const native=nativeFor((value as CloudInstallationAction)?.metadata?.native,intent),expected=actionFor(native,intent);if(!isDeepStrictEqual(value,expected))fail();return expected;}
  function evidence(context:Pick<ActionContext,'intent'|'action'|'attempts'>,acknowledged=false,retainedToken?:string):CloudInstallationEvidence{
    const native=nativeFor(context.action.metadata.native,context.intent),target=native.target;
    const retained=context.intent.retirement!.data==='retain'&&native.operation==='remove-stack'?[{kind:'artifact-bucket',id:target.stack.bucket,identity:{accountId:target.scope.accountId,region:target.scope.region,originalStackId:target.stack.id,originalStackCreateTime:target.stack.createTime,owner:target.stack.owner},reason:'data-retention' as const},
      ...target.objects.map(item=>({kind:'artifact-object-version',id:item.id,identity:{accountId:target.scope.accountId,versionId:item.versionId,sha256:item.sha256,installationId:item.installationId,attemptId:item.attemptId},reason:'data-retention' as const}))]:[];
    const attempt=context.attempts?.filter(item=>item.actionId===context.action.id).at(-1);
    return{resources:acknowledged?[]:[{kind:native.operation,id:context.action.resource.name,identity:{accountId:target.scope.accountId,originalStackId:target.stack.id,originalStackCreateTime:target.stack.createTime}}],
      native:{...native,...(native.operation==='remove-stack'&&(retainedToken??attempt?.id)?{clientRequestToken:retainedToken??attempt!.id}:{}),...(!acknowledged?{retirement:operatorRetirementOutcomeSchema.parse({outcome:retained.length?'retained-by-choice':'removed',retained})}:{})}};
  }
  type Clients={cfn:CloudFormationClient;s3:S3Client;signal:AbortSignal};
  async function clients<T>(context:Context,target:Target,work:(client:Clients)=>Promise<T>):Promise<T>{
    const budget=new DestinationBudget({signal:context.signal,deadlineMs:30000});let sts:STSClient|undefined,cfn:CloudFormationClient|undefined,s3:S3Client|undefined;
    try{
      if(!context.authentication.awsSession)fail('authorization_expired');
      const credentials=await budget.wait(context.authentication.awsSession.getCredentials(budget.signal));
      if(!credentials.accessKeyId||!credentials.secretAccessKey||!credentials.sessionToken||!(credentials.expiration instanceof Date)||credentials.expiration.getTime()<=Date.now()+30000)fail('authorization_expired');
      const config={region:target.scope.region,credentials,maxAttempts:1,requestHandler:options.requestHandler};sts=new STSClient(config);cfn=new CloudFormationClient(config);s3=new S3Client(config);
      for(const client of [sts,cfn,s3])boundAwsSdkResponses(client);
      const identity=await sts.send(new GetCallerIdentityCommand({}),{abortSignal:budget.signal}),caller=identity.Arn?.match(/^arn:aws:(iam|sts)::(\d{12}):([^\s]+)$/);
      if(identity.Account!==target.scope.accountId||caller?.[2]!==target.scope.accountId||!identity.UserId
        ||!(caller[1]==='iam'?/^(?:root|user\/.+)$/.test(caller[3]):/^(?:assumed-role\/[^/]+\/[^/]+|federated-user\/[^/]+)$/.test(caller[3])))fail('identity_mismatch');
      return await work({cfn,s3,signal:budget.signal});
    }finally{sts?.destroy();cfn?.destroy();s3?.destroy();budget.close();}
  }
  async function stack(client:Clients,context:Context,target:Target){
    const result=await client.cfn.send(new DescribeStacksCommand({StackName:target.stack.id}),{abortSignal:client.signal});
    const value=result.Stacks?.length===1?result.Stacks[0]:undefined,n=awsOperatorArtifactNames(origin(context.intent,target));
    const tags=Object.fromEntries((value?.Tags??[]).map(item=>[item.Key,item.Value]));
    if(!value||value.StackId!==target.stack.id||value.StackName!==n.stackName||!(value.CreationTime instanceof Date)||value.CreationTime.toISOString()!==target.stack.createTime
      ||new Set(value.Tags?.map(item=>item.Key)).size!==value.Tags?.length||tags['hypervibe-owner']!==target.stack.owner||tags['hypervibe-installation']!==target.stack.installationId||tags['hypervibe-attempt']!==target.stack.attemptId)fail();
    if(value.StackStatus==='CREATE_COMPLETE'){
      const template=await client.cfn.send(new GetTemplateCommand({StackName:target.stack.id,TemplateStage:'Original'}),{abortSignal:client.signal});
      if(typeof template.TemplateBody!=='string'||!isDeepStrictEqual(JSON.parse(template.TemplateBody),awsOperatorArtifactTargetTemplate(origin(context.intent,target),target.stack.attemptId)))fail();
      const resource=await client.cfn.send(new ListStackResourcesCommand({StackName:target.stack.id}),{abortSignal:client.signal});
      if(resource.NextToken||resource.StackResourceSummaries?.length!==1||resource.StackResourceSummaries[0].LogicalResourceId!=='Artifacts'||resource.StackResourceSummaries[0].PhysicalResourceId!==target.stack.bucket||resource.StackResourceSummaries[0].ResourceType!=='AWS::S3::Bucket'||resource.StackResourceSummaries[0].ResourceStatus!=='CREATE_COMPLETE')fail();
    }else if(!['DELETE_IN_PROGRESS','DELETE_COMPLETE'].includes(value.StackStatus??''))fail('not_converged');
    const attempt=context.attempts?.filter(item=>item.actionId==='aws:operator-artifacts:retire:remove-stack').at(-1);
    if(value.StackStatus==='CREATE_COMPLETE'||attempt){
      const token=value.StackStatus==='CREATE_COMPLETE'?target.stack.attemptId:attempt!.id;
      let next:string|undefined;const seen=new Set<string>();let matched=false;
      for(let page=0;page<20;page++){
        const events=await client.cfn.send(new DescribeStackEventsCommand({StackName:target.stack.id,...(next?{NextToken:next}:{})}),{abortSignal:client.signal});
        if(!Array.isArray(events.StackEvents))fail();
        matched ||=events.StackEvents.some(item=>item.StackId===target.stack.id&&item.PhysicalResourceId===target.stack.id&&item.ResourceType==='AWS::CloudFormation::Stack'&&item.ClientRequestToken===token
          &&(value.StackStatus==='CREATE_COMPLETE'?item.ResourceStatus?.startsWith('CREATE_'):item.ResourceStatus===value.StackStatus));
        if(matched)break;if(!events.NextToken)break;if(seen.has(events.NextToken))fail();seen.add(events.NextToken);next=events.NextToken;if(page===19)fail();
      }
      if(!matched)fail('not_converged');
    }
    return value.StackStatus!;
  }
  async function bucketPresent(client:Clients,target:Target){
    let token:string|undefined,owner:string|undefined;const seen=new Set<string>(),names=new Set<string>();let present=false;
    for(let page=0;page<20;page++){
      const result=await client.s3.send(new ListBucketsCommand({Prefix:target.stack.bucket,MaxBuckets:1000,...(token?{ContinuationToken:token}:{})}),{abortSignal:client.signal});
      if(!result.Owner?.ID||!Array.isArray(result.Buckets)||owner&&owner!==result.Owner.ID)fail();owner=result.Owner.ID;
      for(const item of result.Buckets){if(!item.Name||names.has(item.Name)||!(item.CreationDate instanceof Date))fail();names.add(item.Name);if(item.Name===target.stack.bucket)present=true;}
      if(!result.ContinuationToken)return present;if(seen.has(result.ContinuationToken))fail();seen.add(result.ContinuationToken);token=result.ContinuationToken;
    }return fail();
  }
  async function bucket(client:Clients,context:Context,target:Target){
    const config={Bucket:target.stack.bucket,ExpectedBucketOwner:target.scope.accountId},options={abortSignal:client.signal};
    const versioning=await client.s3.send(new GetBucketVersioningCommand(config),options),ownership=await client.s3.send(new GetBucketOwnershipControlsCommand(config),options),tags=await client.s3.send(new GetBucketTaggingCommand(config),options);
    const map=Object.fromEntries((tags.TagSet??[]).map(item=>[item.Key,item.Value]));
    if(versioning.Status!=='Enabled'||versioning.MFADelete==='Enabled'||ownership.OwnershipControls?.Rules?.length!==1||ownership.OwnershipControls.Rules[0].ObjectOwnership!=='BucketOwnerEnforced'
      ||new Set(tags.TagSet?.map(item=>item.Key)).size!==tags.TagSet?.length||map['hypervibe-owner']!==target.stack.owner||map['hypervibe-installation']!==target.stack.installationId||map['hypervibe-attempt']!==target.stack.attemptId)fail();
    const present=new Set<string>(),markers=new Set<string>();let key:string|undefined,version:string|undefined;const pages=new Set<string>();
    for(let page=0;page<20;page++){
      const result=await client.s3.send(new ListObjectVersionsCommand({...config,MaxKeys:1000,...(key?{KeyMarker:key,VersionIdMarker:version}:{})}),options);
      if(result.Name!==target.stack.bucket||typeof result.IsTruncated!=='boolean'||result.CommonPrefixes?.length)fail();
      for(const item of result.Versions??[]){const original=target.objects.find(v=>v.key===item.Key&&v.versionId===item.VersionId),id=String(item.Key)+'\0'+String(item.VersionId);
        if(!original||present.has(id)||!Number.isSafeInteger(item.Size)||item.Size!<=0||item.Size!>1048576)fail();present.add(id);
        const head=await client.s3.send(new HeadObjectCommand({...config,Key:original.key,VersionId:original.versionId,ChecksumMode:'ENABLED'}),options);
        if(head.VersionId!==original.versionId||head.ContentLength!==item.Size||head.ContentType!=='application/json'||head.ChecksumSHA256!==Buffer.from(original.sha256,'hex').toString('base64')
          ||head.Metadata?.['hv-owner']!==original.owner||head.Metadata?.['hv-installation']!==original.installationId||head.Metadata?.['hv-attempt']!==original.attemptId||head.Metadata?.['hv-sha256']!==original.sha256
          ||context.intent.retirement!.data==='delete-owned'&&(head.ObjectLockMode!==undefined||head.ObjectLockLegalHoldStatus==='ON'||head.ObjectLockRetainUntilDate!==undefined))fail();
      }
      for(const item of result.DeleteMarkers??[])markers.add(String(item.Key)+'\0'+String(item.VersionId));if(markers.size)fail();
      if(!result.IsTruncated)break;
      if(!result.NextKeyMarker||!result.NextVersionIdMarker)fail();const marker=result.NextKeyMarker+'\0'+result.NextVersionIdMarker;if(pages.has(marker)||page===19)fail();pages.add(marker);key=result.NextKeyMarker;version=result.NextVersionIdMarker;
    }
    const uploads=await client.s3.send(new ListMultipartUploadsCommand({...config,MaxUploads:1000}),options);
    if(uploads.Bucket!==target.stack.bucket||uploads.IsTruncated!==false||uploads.Uploads?.length||uploads.CommonPrefixes?.length)fail();
    return present;
  }
  async function policy(client:Clients,target:Target):Promise<Policy>{
    let value;try{value=await client.s3.send(new GetBucketPolicyCommand({Bucket:target.stack.bucket,ExpectedBucketOwner:target.scope.accountId}),{abortSignal:client.signal});}
    catch(error){if(errorName(error)==='NoSuchBucketPolicy'&&status(error)===404)return emptyPolicy();throw error;}
    if(typeof value.Policy!=='string'||Buffer.byteLength(value.Policy)>20480)fail();const result=JSON.parse(value.Policy);
    if(!result||result.Version!=='2012-10-17'||!Array.isArray(result.Statement)||result.Statement.some((item:unknown)=>!item||typeof item!=='object'||Array.isArray(item)))fail();return result;
  }
  async function read(client:Clients,context:Context,target:Target){
    const stackStatus=await stack(client,context,target),present=await bucketPresent(client,target);
    if(!present)return{stackStatus,present,versions:new Set<string>(),policy:emptyPolicy()};
    const versions=await bucket(client,context,target),current=await policy(client,target),remaining=removeOwned(current,target);
    if(context.intent.retirement!.data==='delete-owned'&&remaining.Statement.length)fail();
    return{stackStatus,present,versions,policy:current};
  }
  async function observation(client:Clients,context:ActionContext){
    const native=nativeFor(context.action.metadata.native,context.intent),state=await read(client,context,native.target),policyDigest=canonicalJsonSha256(state.policy);
    if(native.operation==='remove-public-access'){
      if(policyDigest===native.policyAfterDigest)return{state:'satisfied' as const,evidence:evidence(context)};
      if(policyDigest!==native.policyBeforeDigest)fail('not_converged');return{state:'action-required' as const};
    }
    if(policyDigest!==native.policyAfterDigest)fail('not_converged');
    if(native.operation==='remove-stack')return state.stackStatus==='DELETE_COMPLETE'?{state:'satisfied' as const,evidence:evidence(context)}:state.stackStatus==='DELETE_IN_PROGRESS'?{state:'pending' as const,reason:'not_converged' as const}:{state:'action-required' as const};
    if(state.stackStatus!=='DELETE_COMPLETE')fail('not_converged');
    if(native.operation==='remove-version')return !state.versions.has(native.key+'\0'+native.versionId)?{state:'satisfied' as const,evidence:evidence(context)}:{state:'action-required' as const};
    if(!state.present)return{state:'satisfied' as const,evidence:evidence(context)};
    if(state.versions.size)fail('not_converged');return{state:'action-required' as const};
  }
  async function inspect(context:ActionContext){try{parseAction(context.action,context.intent);const target=targetFor(context.action.metadata.native.target,context.intent);return await clients(context,target,client=>observation(client,context));}catch(error){return{state:'unknown' as const,reason:reason(error)};}}
  return{provider:'aws',artifactPublication:{providerName:'s3',authentication:'aws-session'},operatorRetirement:{schemaVersion:1},scopePreparation:setup.scopePreparation,parseScope:setup.parseScope,
    parseAction:(value,intent)=>intent.mode==='connect'?setup.parseAction(value,intent):parseAction(value,intent),
    parseEvidence(value,intent){if(intent.mode==='connect')return setup.parseEvidence(value,intent);
      const parsed=z.object({resources:z.array(z.object({kind:coordinate,id:coordinate,identity:z.record(coordinate,coordinate)}).strict()),native:nativeSchema.safeExtend({clientRequestToken:uuid.optional(),retirement:operatorRetirementOutcomeSchema.optional()}).strict()}).strict().parse(value);
      const {clientRequestToken:_token,retirement:_outcome,...native}=parsed.native;nativeFor(native,intent);const action=actionFor(native,intent);
      const expected=evidence({intent,action},!parsed.native.retirement,parsed.native.clientRequestToken);
      if(!isDeepStrictEqual(parsed,expected))fail();return parsed;
    },
    async plan(context){const target=targetFor(compile(context.intent),context.intent),state=await clients(context,target,client=>read(client,context,target));
      const before=canonicalJsonSha256(state.policy),after=canonicalJsonSha256(removeOwned(state.policy,target));
      const make=(operation:Native['operation'],object?:Target['objects'][number])=>actionFor({target,operation,policyBeforeDigest:before,policyAfterDigest:after,...(object?{key:object.key,versionId:object.versionId}:{})},context.intent);
      const actions=[make('remove-public-access'),make('remove-stack'),...(context.intent.retirement!.data==='delete-owned'?[...target.objects.map(item=>make('remove-version',item)),make('remove-bucket')]:[])];
      return{actions,review:{resources:[{kind:'CloudFormation stack',name:target.stack.id,scope:`Created ${target.stack.createTime}; Retain leaves bucket ${target.stack.bucket}`},...target.objects.map(item=>({kind:'S3 object version',name:`${item.key} version ${item.versionId}`,scope:target.stack.bucket}))],permissions:[],costs:[{resource:target.stack.bucket,description:'Retained bucket data and access may continue to incur storage and request charges.',pricingUrl:'https://aws.amazon.com/s3/pricing/'}],warnings:[
        'Only the exact owned public statements, original stack and selected object versions are reviewed. Shared accounts, unrelated buckets and registrations are preserved.',
        'Stack deletion uses STANDARD with the original full ARN and a durable request token. The template Retain policy leaves bucket data until separately reviewed delete-owned steps finish.',
        'Version-specific deletion is permanent. No versionless delete, bulk sweep, retention bypass or cancellation is authorized. Foreign versions, delete markers and multipart uploads block removal.',
        'Bucket policy changes and bucket deletion have no native lifetime or policy compare-and-swap. Exact reads cannot exclude external same-account changes or same-name bucket replacement after the final read. Historical version identity is Bucket + Key + VersionId; no historical-version ETag condition is claimed.',
        context.intent.retirement!.data==='retain'?'The bucket and exact versions remain by choice with continuing costs. This does not implement a later retain-to-delete continuation.':'The bucket is deleted only after complete current inventories prove it empty; external concurrent changes may still cause deletion to stop.',
        'Customer stacks already created from these templates and downloaded copies are not removed. External consumers cannot be discovered by this operation.',
      ]}};
    },inspect,
    async recover(context){const result=await inspect(context);return result.state==='action-required'?{state:'pending',reason:'not_converged'}:result;},
    async mutate(context){let dispatched=false;try{const native=nativeFor(context.action.metadata.native,context.intent),target=native.target;return await clients(context,target,async client=>{
      const observed=await observation(client,context);if(observed.state==='satisfied')return{state:'acknowledged' as const,evidence:observed.evidence};if(observed.state!=='action-required')fail('not_converged');
      const config={Bucket:target.stack.bucket,ExpectedBucketOwner:target.scope.accountId},options={abortSignal:client.signal};
      if(native.operation==='remove-public-access'){
        const current=await policy(client,target);if(canonicalJsonSha256(current)!==native.policyBeforeDigest)fail('not_converged');const next=removeOwned(current,target);if(canonicalJsonSha256(next)!==native.policyAfterDigest)fail();
        await context.beforeMutation();dispatched=true;
        if(next.Statement.length)await client.s3.send(new PutBucketPolicyCommand({...config,Policy:JSON.stringify(next)}),options);else await client.s3.send(new DeleteBucketPolicyCommand(config),options);
      }else{
        await context.beforeMutation();dispatched=true;
        if(native.operation==='remove-stack')await client.cfn.send(new DeleteStackCommand({StackName:target.stack.id,DeletionMode:'STANDARD',ClientRequestToken:context.attempt.id}),options);
        else if(native.operation==='remove-version')await client.s3.send(new DeleteObjectCommand({...config,Key:native.key!,VersionId:native.versionId!}),options);
        else await client.s3.send(new DeleteBucketCommand(config),options);
      }
      return{state:'acknowledged' as const,evidence:evidence({...context,attempts:[...(context.attempts??[]).filter(item=>item.id!==context.attempt.id),context.attempt]},true)};
    });}catch(error){return{state:!dispatched||status(error)===403?'rejected':'uncertain',reason:reason(error)};}},connections:()=>[]};
}
