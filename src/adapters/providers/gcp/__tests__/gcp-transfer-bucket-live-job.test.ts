import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareTransferBucketJob } from '../gcp-transfer-bucket-setup.js';
import { transferBucketJob } from '../tofu/transfer-bucket-job.js';
import { BUCKET_COPY_IMAGE, BUCKET_COPY_SCRIPT } from '../gcp-transfer-bucket-workload.js';
import { engineBucketName } from '../../../../application/infrastructure-engine.js';

const stubs = vi.hoisted(() => ({ find: vi.fn(), spec: vi.fn(), railway: vi.fn(), cloudJob: vi.fn(), setup: vi.fn(), inspect: vi.fn() }));
vi.mock('../../../db/repositories/environment.repository.js', () => ({ EnvironmentRepository: class { findByProjectAndName = stubs.find } }));
vi.mock('../../../../domain/spec/spec.store.js', () => ({ SpecStore: class { getForInspection = stubs.spec } }));
vi.mock('../../../../domain/services/adapter.factory.js', () => ({adapterFactory:{getStorageOperations:stubs.railway}}));
vi.mock('../../../../application/gcp-transfer-access-readiness.js', () => ({inspectTransferIsolation:async () => ({scope:{projectNumber:'123',copyUniqueId:'456'}}), ProbeProblem:class extends Error {}}));
vi.mock('../../../engine/opentofu/install.js', () => ({ensureEngineBinary:async () => ({ok:true,binary:'fixture'}),enginePluginCacheDir:()=>''}));
vi.mock('../../../engine/opentofu/engine.js', () => ({OpenTofuEngine:class { inspectState = async () => ({ok:true,present:true,value:true}) }}));
vi.mock('../../../secrets/secret-store.js', () => ({getSecretStore:()=>({})}));
vi.mock('../gcp-cloud-run.client.js', () => ({cloudRunJobRequest: stubs.cloudJob}));
vi.mock('../../../../domain/services/gcp-project-setup.service.js', () => ({runGcpProjectSetup:stubs.setup}));

const target = {projectId:'fixture-cloud',targetRegion:'us-central1',targetEnvironmentId:'dst',sourceEnvironmentId:'src',
  sourceRailwayProjectId:'rp',sourceRailwayEnvironmentId:'re'};
const bucket = engineBucketName(target.projectId,'new','assets');
const scope = {target,storageName:'assets',sourceBucketId:'bucket-1',sourceBucketName:'native-assets',targetBucket:bucket};
const job = transferBucketJob(scope), uid='af4647e6-4052-45fb-b225-af51358051ab';
const input={project:{id:'project',name:'test'},storageName:'assets',sourceEnvironment:'old',targetEnvironment:'new',token:async ()=>'test'} as Parameters<typeof prepareTransferBucketJob>[0];
function native() {
  return { name:'projects/123/locations/us-central1/jobs/'+job.jobId,uid,labels:job.spec.labels,generation:'1',observedGeneration:'1',terminalCondition:{type:'Ready',state:'CONDITION_SUCCEEDED'},
    template:{taskCount:1,parallelism:1,template:{executionEnvironment:'EXECUTION_ENVIRONMENT_GEN2',serviceAccount:job.accountEmail,maxRetries:0,timeout:'3600s',
      containers:[{name:'copy',image:BUCKET_COPY_IMAGE,command:['/bin/sh'],args:['-c',BUCKET_COPY_SCRIPT],resources:{limits:{cpu:'1',memory:'512Mi'}},
        env:[{name:'HV_SOURCE_BUCKET',value:'native-assets'},{name:'HV_TARGET_BUCKET',value:bucket}]}]}}};
}
const json = (value: unknown) => new Response(JSON.stringify(value));
describe('Google Cloud job readback for the initial preview and after applying its saved setup', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    const railwayScope={projectId:'rp',environmentId:'re'};
    stubs.find.mockImplementation((_:string,name:string) => name==='old'?{id:'src',name,projectId:'project',platformBindings:{provider:'railway',...railwayScope,
      storage:{assets:{provider:'railway',externalId:'bucket-1',instanceScope:railwayScope}}}}:{id:'dst',name,projectId:'project',platformBindings:{provider:'cloudrun',projectId:target.projectId,environmentId:target.targetRegion,engine:{kind:'opentofu',storage:['assets']}}});
    stubs.spec.mockReturnValue({spec:{environments:{old:{hosting:{provider:'railway'},storage:{assets:{provider:'railway'}}},new:{hosting:{provider:'cloudrun'},storage:{assets:{provider:'gcs',region:'us-central1'}}}}}});
    stubs.railway.mockResolvedValue({ success:true, adapter:{ getMigrationBucketName:async ()=>'native-assets' } });
    vi.stubGlobal('fetch',async (url:string)=>{
      if(url.includes(':getIamPolicy')) return json({etag:'project'});
      if(url.includes('/iam?')) return json({etag:'bucket',kind:'storage#policy',resourceId:'projects/_/buckets/'+bucket});
      return json({name:bucket,id:bucket,location:'US-CENTRAL1',labels:{'managed-by':'hypervibe','hv-storage':'assets','hv-environment':'dst'},projectNumber:'123',timeCreated:'2026-11-20T12:34:56Z',iamConfiguration:{publicAccessPrevention:'enforced',uniformBucketLevelAccess:{enabled:true}}});
    });
    stubs.setup.mockImplementation(async p => { if(p.confirm) await p.observeBucketJobAfterApply(); return {success:true}; });
  });
  it('accepts the idle approved worker with the current successful generation',async()=>{
    stubs.cloudJob.mockImplementation(async()=>json(native()));
    expect((await prepareTransferBucketJob(input,target)).success).toBe(true);
    const path = new URL(stubs.cloudJob.mock.calls[0]![2], 'https://run.googleapis.com');
    expect(path.pathname).toBe('/'+job.jobId);
    expect(path.searchParams.get('fields')?.split(',')).toEqual(expect.arrayContaining(['template','generation','observedGeneration','executionCount','latestCreatedExecution']));
  });
  it.each(['service account','script','credentials','extra container','parallelism','job executed','latest execution','stale generation','failed reconciliation','retry policy','execution token','binary authorization'])('blocks %s drift on the same UID before saving a preview',async change=>{
    const raw=native(), task=raw.template.template, container=task.containers[0]!;
    if(change==='service account') task.serviceAccount='different';
    if(change==='script') container.args=['-c','other'];
    if(change==='credentials') container.env.push({name:'SOURCE_KEY',value:'synthetic-value'});
    if(change==='extra container') task.containers.push({...container,name:'another'});
    if(change==='parallelism') raw.template.parallelism=2;
    if(change==='job executed') Object.assign(raw,{executionCount:1});
    if(change==='latest execution') Object.assign(raw,{latestCreatedExecution:{name:raw.name+'/executions/previous'}});
    if(change==='stale generation') raw.generation='2';
    if(change==='failed reconciliation') raw.terminalCondition.state='CONDITION_FAILED';
    if(change==='retry policy') task.maxRetries=3;
    if(change==='execution token') Object.assign(raw,{runExecutionToken:'scheduled'});
    if(change==='binary authorization') Object.assign(raw,{binaryAuthorization:{breakglassJustification:'unexpected'}});
    stubs.cloudJob.mockImplementation(async()=>json(raw));
    expect((await prepareTransferBucketJob(input,target)).success).toBe(false);
    expect(stubs.setup).not.toHaveBeenCalled();
  });
  it('accepts the empty execution reference returned by Google after creating a ready job with no executions', async () => {
    stubs.cloudJob.mockImplementationOnce(async () => json(native()))
      .mockImplementationOnce(async () => json({ ...native(), latestCreatedExecution: {} }));
    expect((await prepareTransferBucketJob({ ...input, planId: 'saved' }, target)).success).toBe(true);
    expect(stubs.cloudJob).toHaveBeenCalledTimes(2);
  });
  it.each([
    { latestCreatedExecution: null }, { latestCreatedExecution: [] }, { latestCreatedExecution: { name: '' } },
    { latestCreatedExecution: { completionStatus: 'PENDING' } }, { latestCreatedExecution: {}, executionCount: 1 },
  ])('rejects a malformed reference or evidence of an execution despite a ready job', async fields => {
    stubs.cloudJob.mockImplementation(async () => json({ ...native(), ...fields }));
    expect((await prepareTransferBucketJob(input, target)).success).toBe(false);
    expect(stubs.setup).not.toHaveBeenCalled();
  });
  it('does not certify an equivalent UID when the live post-apply task has different resources',async()=>{
    const changed=native(); changed.template.template.containers[0]!.resources.limits.cpu='4';
    stubs.cloudJob.mockImplementationOnce(async()=>json(native())).mockImplementationOnce(async()=>json(changed));
    expect((await prepareTransferBucketJob({...input,planId:'saved'},target)).success).toBe(false);
    expect(stubs.cloudJob).toHaveBeenCalledTimes(2);
  });
});
