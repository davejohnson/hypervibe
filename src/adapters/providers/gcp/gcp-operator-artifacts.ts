import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CloudInstallationBoundaryError, type CloudInstallationAction, type CloudInstallationAttempt, type CloudInstallationDriver,
  type CloudInstallationEvidence, type CloudInstallationProviderContext, type OperatorArtifactCapability, type OperatorArtifactIntent } from '../../../domain/ports/cloud-installation.port.js';
import { parseCloudInstallationRecordV1 } from '../../../domain/services/cloud-installation-runtime.js';
import { DestinationBoundaryError, DestinationBudget } from '../secret-destination-http.js';
import { GcpSecretWriterClient } from './gcp-secret-writer.client.js';
import { GcpLocalDefaultAuthentication } from './gcp-local-default-authentication.js';
import { gcpLocalPublicArtifactProofShape } from './gcp-local-artifact-registry.js';
import { applicationCandidateDeclarationShape, applicationCandidatePreparedShape, inspectApplicationCandidate } from './application-candidate-build.js';
import { inspectOperatorImage, isolatedDockerEnvironment, packageProvenance, prepareOperatorImages, runOperatorCommand, type OperatorCommand } from './operator-image-build.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/), imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/), uuid = z.string().guid();
const declarationSchema = z.object({ scopeKind: z.literal('gar-image-publication-v1'), projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  region: z.string().regex(/^[a-z]+(?:-[a-z0-9]+)+$/), packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict();
const baseSchema = declarationSchema.extend({ projectNumber: z.string().regex(/^[1-9]\d*$/), projectCreateTime: z.string().datetime(),
  projectParent: z.string().regex(/^(none|organizations\/[1-9]\d*|folders\/[1-9]\d*)$/), projectInstallationId: uuid, projectAttemptId: uuid,
  ...gcpLocalPublicArtifactProofShape, packageLockSha256: sha }).strict();
const publicScopeSchema = baseSchema.extend({ packageArchiveSha256: sha, holdingImageId: imageId.optional(), backupImageId: imageId.optional() }).strict();
const candidateDeclarationSchema = declarationSchema.omit({ packageVersion: true }).extend({ scopeKind: z.literal('gar-private-candidate-publication-v1'), ...applicationCandidateDeclarationShape }).strict();
const candidateProofShape = { artifactRepository: z.literal('hypervibe'), artifactRepositoryName: z.string().min(1), artifactRepositoryCreateTime: z.string().datetime(), artifactInstallationId: uuid, artifactAttemptId: uuid };
const projectProofKeys = ['projectNumber','projectCreateTime','projectParent','projectInstallationId','projectAttemptId'] as const;
const candidateBaseSchema = candidateDeclarationSchema.extend({ ...Object.fromEntries(projectProofKeys.map(key=>[key,baseSchema.shape[key]])) as Pick<typeof baseSchema.shape,typeof projectProofKeys[number]>, ...candidateProofShape }).strict();
const candidateScopeSchema = candidateBaseSchema.extend(applicationCandidatePreparedShape).strict();
export const gcpOperatorArtifactScopeSchema = z.discriminatedUnion('scopeKind',[publicScopeSchema,candidateScopeSchema]);
type Intent = OperatorArtifactIntent;
type Context = CloudInstallationProviderContext<Intent>;
type ActionContext = Context & { action: CloudInstallationAction; attempt?: CloudInstallationAttempt };
const kinds = ['holding-v1', 'backup-runner-v1'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(reason: ConstructorParameters<typeof CloudInstallationBoundaryError>[0] = 'identity_mismatch'): never { throw new CloudInstallationBoundaryError(reason); }
function names(intent: Intent): Record<string,string> & {candidate:boolean} {
  const n = gcpOperatorArtifactScopeSchema.parse(intent.nativeScope) as Record<string,string>;
  const candidate=n.scopeKind==='gar-private-candidate-publication-v1';
  if (intent.provider !== 'gcp' || intent.artifactProvider !== 'cloudrun' || intent.execution.authentication !== 'google-user-adc'
    || !intent.artifacts.length || new Set(intent.artifacts).size !== intent.artifacts.length) fail();
  if(candidate ? intent.artifacts.length!==1||intent.artifacts[0]!=='application-candidate-v1'||n.sourceRepository!==intent.source.repository
    : intent.artifacts.some(value=>!kinds.includes(value))||Boolean(n.holdingImageId)!==intent.artifacts.includes(kinds[0])||Boolean(n.backupImageId)!==intent.artifacts.includes(kinds[1]))fail();
  const prefix=candidate?'artifact':'publicArtifact', repository=candidate?'hypervibe':'operator-public';
  if(n[prefix+'RepositoryName']!==`projects/${n.projectId}/locations/${n.region}/repositories/${repository}`)fail();
  return {...n,candidate,repository,repositoryName:n[prefix+'RepositoryName'],repositoryCreateTime:n[prefix+'RepositoryCreateTime'],host:`${n.region}-docker.pkg.dev`,
    projectOwner:hash([intent.customerId,intent.appId,intent.environment,n.projectInstallationId]),
    registryOwner:hash([intent.customerId,intent.appId,intent.environment,n[prefix+'InstallationId']]),registryAttemptId:n[prefix+'AttemptId']} as unknown as Record<string,string> & {candidate:boolean};
}
function artifact(intent: Intent, kind: string) {
  const n=names(intent);if(!intent.artifacts.includes(kind))fail();const name=n.candidate?n.imageName:kind;
  return {kind,name,imageId:n.candidate?n.candidateImageId:kind===kinds[0]?n.holdingImageId:n.backupImageId,package:`${n.repositoryName}/packages/${name}`,
    image:`${n.host}/${n.projectId}/${n.repository}/${name}`,id:`gcp:operator-artifacts:publish:${kind}`};
}
async function inspectImage(image:string,kind:string,scope:Record<string,string>,command:OperatorCommand,options:Parameters<typeof inspectOperatorImage>[4]) {
  return kind==='application-candidate-v1'?inspectApplicationCandidate(image,scope,command,options):inspectOperatorImage(image,kind,scope,command,options);
}
function contentIdentity(intent:Intent): Record<string,string> {
  const n=names(intent);
  return n.candidate?{candidateBuildId:n.candidateBuildId,builderCleanup:'verified',sourceRepository:n.sourceRepository,sourceCommit:n.sourceCommit,sourceManifestSha256:n.sourceManifestSha256,
    dockerfileSha256:n.dockerfileSha256,dependencyLockSha256:n.dependencyLockSha256,credentialScan:'verified',authenticatedPull:'verified'}
    :{packageVersion:n.packageVersion,packageArchiveSha256:n.packageArchiveSha256,packageLockSha256:n.packageLockSha256,anonymousPull:'verified'};
}
function actions(intent: Intent): CloudInstallationAction[] {
  return intent.artifacts.map(kind => { const a = artifact(intent,kind); return { id: a.id, type: 'create', resource: { kind: 'storage', name: a.image, provider: 'gcp' },
    verified: true, requiresConfirm: true, billable: true, dataBearing: true,
    reason: names(intent).candidate ? `Publish only the reviewed application commit ${intent.nativeScope.sourceCommit} and image ${a.imageId} to the private repository; verify authenticated immutable content.` : `Publish only the reviewed, locally tested packaged ${kind} image ${a.imageId}; verify anonymous access to its immutable registry digest.`,
    metadata: { operation: kind, category: 'scope', execution: 'api', native: {} } }; });
}
const publicIdentity = z.object({ imageId,digest:imageId,packageVersion:z.string(),packageArchiveSha256:sha,packageLockSha256:sha,uploadTime:z.string().datetime(),anonymousPull:z.literal('verified') }).strict();
const candidateIdentity = z.object({imageId,digest:imageId,candidateBuildId:uuid,builderCleanup:z.literal('verified'),sourceRepository:applicationCandidatePreparedShape.sourceRepository,
  sourceCommit:applicationCandidateDeclarationShape.sourceCommit,sourceManifestSha256:sha,dockerfileSha256:sha,dependencyLockSha256:sha,
  credentialScan:z.literal('verified'),uploadTime:z.string().datetime(),authenticatedPull:z.literal('verified')}).strict();
const evidenceSchema = z.object({resources:z.array(z.object({kind:z.literal('image'),id:z.string().max(2048),identity:z.union([publicIdentity,candidateIdentity])}).strict()).max(1),
  native:z.object({operation:z.enum(['holding-v1','backup-runner-v1','application-candidate-v1']),installationId:uuid,attemptId:uuid,
    tag:z.string().regex(/^hv-[a-f0-9-]{36}$/),repository:z.string(),repositoryCreateTime:z.string().datetime()}).strict()}).strict();
function parseEvidence(value: unknown, intent: Intent): CloudInstallationEvidence {
  const e = evidenceSchema.parse(value), n = names(intent), a = artifact(intent,e.native.operation);
  if (e.native.installationId !== intent.installationId || e.native.tag !== `hv-${e.native.attemptId}` || e.native.repository !== n.repositoryName
    || e.native.repositoryCreateTime !== n.repositoryCreateTime || e.resources.some(r => r.id !== `${a.image}@${r.identity.digest}`
      || r.identity.imageId !== a.imageId || Object.entries(contentIdentity(intent)).some(([key,value])=>(r.identity as Record<string,string>)[key]!==value))) fail();
  return e;
}
function proof(context: ActionContext, attemptId: string, resources: CloudInstallationEvidence['resources'] = []): CloudInstallationEvidence {
  const n = names(context.intent);
  return parseEvidence({ resources, native: { operation: context.action.metadata.operation, installationId: context.intent.installationId, attemptId,
    tag: `hv-${attemptId}`, repository: n.repositoryName, repositoryCreateTime: n.repositoryCreateTime } },context.intent);
}
function reason(error: unknown) { return error instanceof CloudInstallationBoundaryError ? error.reason : error instanceof DestinationBoundaryError
  ? error.status === 403 ? 'insufficient_permissions' as const : error.status === 401 ? 'authorization_expired' as const : 'provider_error' as const : 'provider_error' as const; }
export function createGcpOperatorArtifactDriver(options: { fetch?: typeof fetch; command?: OperatorCommand } = {}): CloudInstallationDriver<Intent> {
  const command = options.command ?? runOperatorCommand;
  async function withClient<T>(context: Context, work: (client: GcpSecretWriterClient, token: string) => Promise<T>): Promise<T> {
    const budget = new DestinationBudget({ signal: context.signal, deadlineMs: 30_000 });
    try {
      if (!context.authentication.administrator) fail('authorization_expired');
      const token = await budget.wait(context.authentication.administrator.getAccessToken('https://www.googleapis.com/auth/cloud-platform', budget.signal));
      const client = new GcpSecretWriterClient({ token, budget, request: options.fetch ?? fetch, beforeWrite: context.beforeMutation, sleep: async () => {} });
      const n = names(context.intent);
      const p = await client.json(`https://cloudresourcemanager.googleapis.com/v3/projects/${n.projectNumber}`);
      const labels = p.labels as Record<string,string> | undefined;
      if (p.name !== `projects/${n.projectNumber}` || p.projectId !== n.projectId || p.state !== 'ACTIVE' || p.createTime !== n.projectCreateTime
        || (p.parent ?? 'none') !== n.projectParent || labels?.['hv-installation'] !== n.projectOwner.slice(0,63) || labels?.['hv-attempt'] !== n.projectAttemptId) fail('ownership_mismatch');
      const r = await client.json(`https://artifactregistry.googleapis.com/v1/${n.repositoryName}`);
      if (r.name !== n.repositoryName || r.createTime !== n.repositoryCreateTime || r.format !== 'DOCKER'
        || r.mode !== 'STANDARD_REPOSITORY' || r.description !== `hypervibe:operator-registry:${n.registryOwner}:${n.registryAttemptId}`) fail('ownership_mismatch');
      const policy = await client.policy('registry',n.repositoryName);
      if(n.candidate) {
        if(n.projectParent!=='none')fail('insufficient_permissions');
        const projectPolicy=await client.policy('project',`projects/${n.projectNumber}`);
        if([policy,projectPolicy].some(value=>value.bindings.some(binding=>binding.members.some(member=>['allUsers','allAuthenticatedUsers'].includes(member)))))fail('authorization_revoked');
      } else if (!policy.bindings.some(binding => binding.role === 'roles/artifactregistry.reader' && !binding.condition && binding.members.includes('allUsers'))) fail('authorization_revoked');
      return await work(client,token);
    } finally { budget.close(); }
  }
  async function tag(client: GcpSecretWriterClient, context: Context, kind: string, attemptId: string) {
    const a = artifact(context.intent,kind), name = `${a.package}/tags/hv-${attemptId}`;
    try {
      const value = await client.json(`https://artifactregistry.googleapis.com/v1/${name}`);
      if (value.name !== name || typeof value.version !== 'string' || !value.version.startsWith(`${a.package}/versions/`)) fail();
      const digest = imageId.parse(value.version.slice(`${a.package}/versions/`.length)); return digest;
    } catch (error) { if (error instanceof DestinationBoundaryError && error.status === 404) return null; throw error; }
  }
  async function observe(context: ActionContext) {
    const n = names(context.intent), a = artifact(context.intent,context.action.metadata.operation);
    const retained = context.attempt?.evidence ?? context.completed[context.action.id];
    const attemptId = context.attempt?.id ?? (typeof retained?.native.attemptId === 'string' ? retained.native.attemptId : undefined);
    const native = await withClient(context,async (client,token) => {
      if (!attemptId) return null;
      const retainedDigest = retained?.resources[0]?.identity.digest;
      const digest = retainedDigest ?? await tag(client,context,a.kind,attemptId);
      if (!digest) return null;
      const name = `${n.repositoryName}/dockerImages/${a.name}@${digest}`;
      const value = await client.json(`https://artifactregistry.googleapis.com/v1/${n.repositoryName}/dockerImages/${encodeURIComponent(a.name + '@' + digest)}`);
      if (value.name !== name || value.uri !== `${a.image}@${digest}` || typeof value.uploadTime !== 'string') fail();
      return { digest, uploadTime: z.string().datetime().parse(value.uploadTime), token:n.candidate?token:undefined };
    });
    if (!native) return attemptId ? { state: 'pending' as const, reason: 'not_converged' as const } : { state: 'action-required' as const };
    const directory = mkdtempSync(path.join(tmpdir(),'hypervibe-artifact-pull-'));
    try {
      const env = isolatedDockerEnvironment(directory), image = `${a.image}@${native.digest}`;
      if(native.token)await command('docker',['login','--username','oauth2accesstoken','--password-stdin',n.host],{env,signal:context.signal,input:native.token});
      await command('docker',['pull','--platform','linux/amd64',image],{ env,signal:context.signal });
      if (await inspectImage(image,a.kind,context.intent.nativeScope,command,{env,signal:context.signal}) !== a.imageId) fail();
      const resource = { kind:'image',id:image,identity:{ imageId:a.imageId,digest:native.digest,...contentIdentity(context.intent),uploadTime:native.uploadTime } };
      if (retained?.resources[0] && !isDeepStrictEqual(retained.resources[0],resource)) fail();
      return { state:'satisfied' as const,evidence:proof(context,attemptId!,[resource]) };
    } finally { rmSync(directory,{recursive:true,force:true}); }
  }
  const driver: CloudInstallationDriver<Intent> = {
    provider:'gcp', artifactPublication:{providerName:'cloudrun',authentication:'google-user-adc'}, parseScope:value=>gcpOperatorArtifactScopeSchema.parse(value), parseEvidence,
    parseAction(value,intent) { const expected=actions(intent).find(action=>isDeepStrictEqual(action,value)); if(!expected) fail(); return expected; },
    async plan(context) {
      const n=names(context.intent);
      await withClient(context,async client=>{
        const permissions=['artifactregistry.repositories.uploadArtifacts','artifactregistry.repositories.downloadArtifacts'];
        const response=await client.json(`https://artifactregistry.googleapis.com/v1/${n.repositoryName}:testIamPermissions`,{method:'POST',body:JSON.stringify({permissions})});
        if(!Array.isArray(response.permissions)||!permissions.every(permission=>(response.permissions as unknown[]).includes(permission))) fail('insufficient_permissions');
      });
      for(const kind of context.intent.artifacts) if(await inspectImage(artifact(context.intent,kind).imageId,kind,context.intent.nativeScope,command,{signal:context.signal})!==artifact(context.intent,kind).imageId) fail();
      return {actions:actions(context.intent),review:{ resources:context.intent.artifacts.map(kind=>({kind:'image',name:artifact(context.intent,kind).image,scope:n.repositoryName})),
        permissions:[{principal:'Local browser-authorized operator',scope:n.repositoryName,actions:['artifactregistry.repositories.uploadArtifacts','artifactregistry.repositories.downloadArtifacts',
          ...(n.candidate?['artifactregistry.repositories.get','artifactregistry.repositories.getIamPolicy','artifactregistry.dockerImages.get','artifactregistry.tags.get']:[])],purpose:'installation-verification'},
          ...(n.candidate?[{principal:'Local browser-authorized operator',scope:`projects/${n.projectNumber}`,actions:['resourcemanager.projects.get','resourcemanager.projects.getIamPolicy'],purpose:'installation-verification' as const}]:[])],
        costs:[{resource:n.repositoryName,description:'Published image storage and download egress can incur charges. This plan creates no repository, IAM binding or application workload.',pricingUrl:'https://cloud.google.com/artifact-registry/pricing'}],
        warnings:[...(n.candidate?[`Publish exact ${n.sourceRepository} commit ${n.sourceCommit}, source manifest ${n.sourceManifestSha256}, Dockerfile ${n.dockerfileSha256} and dependency lock ${n.dependencyLockSha256}.`, 'The package-read credential is transient in a BuildKit secret mount. The prepared image passed exact-credential layer, configuration and filesystem scans. This is a private application candidate, not a running deployment.']:[`Publish exact Hypervibe ${n.packageVersion} archive ${n.packageArchiveSha256} with dependency lock ${n.packageLockSha256}.`, 'This repository was separately reviewed for anonymous reads. Every published image is public.']),
          'Docker pushes have no native conditional tag create. A fresh per-attempt tag is checked before push; the final receipt verifies immutable digest and the exact tested image configuration. Uncertain results are read back without resubmission.']}};
    },
    async inspect(context){try{driver.parseAction(context.action,context.intent);return await observe(context);}catch(error){return {state:'unknown',reason:reason(error)};}},
    async mutate(context){
      let dispatched=false;const directory=mkdtempSync(path.join(tmpdir(),'hypervibe-artifact-push-'));
      try{
        driver.parseAction(context.action,context.intent);const n=names(context.intent),a=artifact(context.intent,context.action.metadata.operation),env=isolatedDockerEnvironment(directory);
        if(await inspectImage(a.imageId,a.kind,context.intent.nativeScope,command,{env,signal:context.signal})!==a.imageId)fail();
        const token=await withClient(context,async(client,token)=>{if(await tag(client,context,a.kind,context.attempt.id))fail('ownership_mismatch');return token;});
        await command('docker',['login','--username','oauth2accesstoken','--password-stdin',n.host],{env,signal:context.signal,input:token});
        const target=`${a.image}:hv-${context.attempt.id}`;
        await command('docker',['tag',a.imageId,target],{env,signal:context.signal});
        await context.beforeMutation();dispatched=true;
        await command('docker',['push',target],{env,signal:context.signal});
        return {state:'acknowledged',evidence:proof(context,context.attempt.id)};
      }catch(error){return {state:dispatched?'uncertain':'rejected',reason:reason(error)};}finally{rmSync(directory,{recursive:true,force:true});}
    },
    async recover(context){try{driver.parseAction(context.action,context.intent);return await observe(context);}catch(error){return {state:'unknown',reason:reason(error)};}},
    connections:()=>[],scopePreparation:{resolvedScope:record=>{if(record.status!=='scope-ready')fail('not_converged');return gcpOperatorArtifactScopeSchema.parse(record.intent.nativeScope);},
      reviewResources:record=>[{kind:'registry',name:names(record.intent).repositoryName,scope:`projects/${record.intent.nativeScope.projectNumber}`} ]},
  };return driver;
}
export function createGcpOperatorArtifactCapability(): OperatorArtifactCapability {
  return {schemaVersion:1,
    parseDeclaration(value,artifacts,bindings){
      if(value && typeof value==='object' && (value as Record<string,unknown>).scopeKind==='gar-private-candidate-publication-v1') {
        const declaration=candidateDeclarationSchema.parse(value);
        if(artifacts.length!==1||artifacts[0]!=='application-candidate-v1')fail();
        const selected=z.record(z.string(),z.unknown()).parse(bindings.providerScope);
        if(selected.projectId!==declaration.projectId||selected.artifactRepositoryName!==`projects/${declaration.projectId}/locations/${declaration.region}/repositories/hypervibe`)fail();
        return candidateBaseSchema.parse({...declaration,...Object.fromEntries([...projectProofKeys,...Object.keys(candidateProofShape)].map(key=>[key,selected[key]]))});
      }
      const declaration=declarationSchema.parse(value),provenance=packageProvenance();
      if(declaration.packageVersion!==provenance.packageVersion||!artifacts.length||artifacts.some(kind=>!kinds.includes(kind)))fail();
      const binding=bindings.providerScope;if(!binding||typeof binding!=='object'||Array.isArray(binding))fail();
      const selected=binding as Record<string,unknown>;
      if(selected.projectId!==declaration.projectId||selected.publicArtifactRepositoryName!==`projects/${declaration.projectId}/locations/${declaration.region}/repositories/operator-public`)fail();
      const inherited=Object.fromEntries(['projectNumber','projectCreateTime','projectParent','projectInstallationId','projectAttemptId',...Object.keys(gcpLocalPublicArtifactProofShape)].map(key=>[key,selected[key]]));
      return baseSchema.parse({...declaration,...provenance,...inherited});
    },
    parseRecord:value=>parseCloudInstallationRecordV1(value,createGcpOperatorArtifactDriver()),
    prepare:(scope,artifacts,source)=>prepareOperatorImages(scope.scopeKind==='gar-private-candidate-publication-v1'?{...scope,sourceRepository:source.repository}:scope,artifacts),
    async create(scope){const n=gcpOperatorArtifactScopeSchema.parse(scope),auth=new GcpLocalDefaultAuthentication(n.projectId);await auth.initialize();
      return {driver:createGcpOperatorArtifactDriver({fetch:auth.request.bind(auth)}),authentication:{kind:'operator-artifact-publisher',administrator:{getAccessToken:async()=>auth.token()}}};},
    nextScope:()=>null,
    refreshScope(record,declaration,artifacts){
      const n=names(record.intent),next=(n.candidate?candidateBaseSchema:baseSchema).parse(declaration);
      if(n.candidate){for(const key of ['projectId',...projectProofKeys,...Object.keys(candidateProofShape)])if(n[key]!==((next as unknown) as Record<string,string>)[key])fail('ownership_mismatch');if(artifacts.length!==1||artifacts[0]!=='application-candidate-v1')fail();return next;}
      for(const key of ['projectId','projectNumber','projectCreateTime','projectParent','projectInstallationId','projectAttemptId',...Object.keys(gcpLocalPublicArtifactProofShape)])
        if(n[key as keyof typeof n]!==next[key as keyof typeof next])fail('ownership_mismatch');
      if(!artifacts.length||artifacts.some(kind=>!kinds.includes(kind)))fail();return next;
    },
    receipts(record){if(record.status!=='scope-ready')fail('not_converged');return record.intent.artifacts.map(kind=>{
      const e=record.completed[artifact(record.intent,kind).id];if(!e)fail('not_converged');const proof=parseEvidence(e,record.intent),r=proof.resources[0];if(!r)fail('not_converged');
      return {kind,image:r.id,...r.identity,repository:names(record.intent).repositoryName,repositoryCreateTime:names(record.intent).repositoryCreateTime};
    });},
  };
}
