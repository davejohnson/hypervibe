import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {railwayHttpFixture,projectId,productionId,stagingId} from './railway-http.fixture.js';
const recorded=JSON.parse(readFileSync('test/provider-contracts/railway/service-instance/empty-defaults-observation.json','utf8'));
const target={projectId,environmentId:stagingId,sourceEnvironmentId:productionId,serviceId:'production-web'};
afterEach(()=>vi.restoreAllMocks());
async function observe(config:unknown,scalar:number|null=1){
  const f=await railwayHttpFixture();
  const before=await f.adapter.serviceInstances.observe(target);
  const original=f.services.get(target.serviceId)!.instances.get(productionId)!;
  f.services.get(target.serviceId)!.instances.set(stagingId,{...structuredClone(original),id:'empty-target',environmentId:stagingId,numReplicas:scalar});
  f.environments.get(stagingId)!.config.services={[target.serviceId]:config as any};
  const after=await f.adapter.serviceInstances.observe(target);
  expect(f.mutations).toEqual([]);expect(f.contractErrors).toEqual([]);
  return {before,after};
}
describe('recorded native empty Railway instance defaults',()=>{
  it('accepts only the known inactive defaults without changing the reviewed parent fingerprint',async()=>{
    const {before,after}=await observe(recorded.instanceConfig,null);
    expect(before.state).toBe('absent');expect(after).toEqual({...before,state:'empty'});
  });
  it('accepts explicit nulls only for independently documented optional fields',async()=>{
    const config=structuredClone(recorded.instanceConfig);
    config.build.buildCommand=null;config.build.dockerfilePath=null;
    config.deploy.startCommand=null;config.deploy.preDeployCommand=null;config.deploy.registryCredentials=null;
    config.source=null;config.configFile=null;config.networking=null;
    expect((await observe(config)).after.state).toBe('empty');
  });
  it.each([
    ['build command',{build:{...recorded.instanceConfig.build,buildCommand:'synthetic-private-command'}}],
    ['start command',{deploy:{...recorded.instanceConfig.deploy,startCommand:'synthetic-private-command'}}],
    ['predeploy command',{deploy:{...recorded.instanceConfig.deploy,preDeployCommand:['synthetic-private-command']}}],
    ['registry credentials',{deploy:{...recorded.instanceConfig.deploy,registryCredentials:{username:'synthetic-private',password:'synthetic-private'}}}],
    ['replicas',{deploy:{...recorded.instanceConfig.deploy,multiRegionConfig:{'us-west2':{numReplicas:2}}}}],
    ['second region',{deploy:{...recorded.instanceConfig.deploy,multiRegionConfig:{'us-west2':{numReplicas:1},'us-east4':{numReplicas:1}}}}],
    ['unknown region',{deploy:{...recorded.instanceConfig.deploy,multiRegionConfig:{'us-east4':{numReplicas:1}}}}],
    ['missing regional count',{deploy:{...recorded.instanceConfig.deploy,multiRegionConfig:{'us-west2':{}}}}],
    ['malformed regional count',{deploy:{...recorded.instanceConfig.deploy,multiRegionConfig:{'us-west2':{numReplicas:'1'}}}}],
    ['alternate builder',{build:{...recorded.instanceConfig.build,builder:'DOCKERFILE'}}],
    ['alternate build environment',{build:{...recorded.instanceConfig.build,buildEnvironment:'V2'}}],
    ['alternate runtime',{deploy:{...recorded.instanceConfig.deploy,runtime:'V3'}}],
    ['legacy stacker',{deploy:{...recorded.instanceConfig.deploy,useLegacyStacker:true}}],
    ['egress setting',{deploy:{...recorded.instanceConfig.deploy,ipv6EgressEnabled:true}}],
    ['variables',{variables:{PRIVATE:{value:'synthetic-private'}}}],
    ['mounts',{volumeMounts:{volume:{mountPath:'/data'}}}],
    ['source',{source:{repo:'owner/private'}}],
    ['config file',{configFile:'synthetic-private'}],
    ['unknown build field',{build:{...recorded.instanceConfig.build,futureFlag:null}}],
    ['unknown deploy field',{deploy:{...recorded.instanceConfig.deploy,futureFlag:null}}],
    ['unknown top-level field',{futureFlag:null}],
  ])('blocks %s and exposes only a bounded phase code',async(_name,change)=>{
    const result=(await observe({...recorded.instanceConfig,...change})).after;
    expect(result).toEqual({state:'unknown',code:'instance_target_configuration_unverified'});
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });
  it('never treats an unknown null top-level field as proved empty',async()=>{
    expect((await observe({futureFlag:null})).after.state).toBe('unknown');
  });
  it('rejects a conflicting native scalar replica count',async()=>{
    expect((await observe(recorded.instanceConfig,2)).after.state).toBe('unknown');
  });
});
