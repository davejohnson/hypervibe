import { createHash } from 'node:crypto';
import { gzipSync, zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as packageCredentials from '../../github/package-pull.js';
import { prepareOperatorImages, runOperatorCommand, type OperatorCommand } from '../operator-image-build.js';

const temporary: string[] = [];
afterEach(() => { vi.restoreAllMocks(); temporary.splice(0).forEach(p => rmSync(p,{recursive:true,force:true})); });
const token = 'synthetic-private-package-read-token';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function candidate(options: { dirty?: boolean; wrongOrigin?: boolean; leak?: 'layer'|'filesystem'|'output'; lostBuildAck?: boolean; cleanupFailure?: boolean; cleanupAckLost?: boolean; cleanupRemaining?: 'builder'|'container'|'volume'|'malformed-list'; runtimeUser?: string; imageSize?: number; compression?: 'zstd'|'zstd-skippable' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(),'hv-candidate-source-')); temporary.push(root);
  writeFileSync(path.join(root,'Dockerfile'),`FROM node:24\nRUN --mount=type=secret,id=npm_token ${options.leak==='layer'?'cp /run/secrets/npm_token /tmp/package-token':'test -s /run/secrets/npm_token'}\nUSER node\n`);
  writeFileSync(path.join(root,'package-lock.json'),'{"lockfileVersion":3}\n');
  writeFileSync(path.join(root,'server.js'),'console.log("candidate")\n');
  await runOperatorCommand('git',['init','-q'],{cwd:root});
  await runOperatorCommand('git',['remote','add','origin',options.wrongOrigin ? 'https://github.com/other/app.git' : 'https://github.com/acme/operator.git'],{cwd:root});
  await runOperatorCommand('git',['add','.'],{cwd:root});
  await runOperatorCommand('git',['-c','user.name=Contract','-c','user.email=contract@example.test','commit','-qm','synthetic reviewed candidate'],{cwd:root});
  const commit = (await runOperatorCommand('git',['rev-parse','HEAD'],{cwd:root})).trim();
  if(options.dirty) writeFileSync(path.join(root,'server.js'),'changed after review');
  // An ignored dotenv file must never enter the archive/build context.
  writeFileSync(path.join(root,'.git/info/exclude'),'.env\n'); writeFileSync(path.join(root,'.env'),token);
  vi.spyOn(packageCredentials,'githubPackagePullSource').mockImplementation(({githubRepo} = {}) => {
    expect(githubRepo).toBe('acme/operator'); return {connectionId:'verified-test-connection',credentialKey:'packageReadToken',username:'operator',token};
  });
  let labels: Record<string,string> = {}, secretFile = '', context = '', preparedArchive=false; const commands: string[][] = [];
  const command: OperatorCommand = async (program,args,opts) => {
    if(program !== 'docker') return runOperatorCommand(program,args,opts);
    commands.push(args); expect(JSON.stringify({args,env:opts?.env})).not.toContain(token);
    if(args[0] === 'buildx' && args[1] === 'create') return args[args.indexOf('--name')+1];
    if(args[0] === 'buildx' && args[1] === 'rm') {if(options.cleanupFailure||options.cleanupAckLost)throw new Error('synthetic lost cleanup acknowledgment');return '';}
    if(args[0] === 'buildx' && args[1] === 'ls') {
      if(options.cleanupFailure)throw new Error('synthetic unavailable builder inventory');
      if(options.cleanupRemaining==='malformed-list')return '';
      const created=commands.find(a=>a[0]==='buildx'&&a[1]==='create')!;
      return 'default\n'+(options.cleanupRemaining==='builder'?created[created.indexOf('--name')+1]+'\n':'');
    }
    if(args[0] === 'container' || args[0] === 'volume')return options.cleanupRemaining===args[0]?'retained-owned-resource\n':'';
    if(args[0] === 'image' && args[1] === 'rm')return '';
    if(args[0] === 'buildx' && args[1] === 'build') {
      context = args.at(-1)!; secretFile = args[args.indexOf('--secret')+1].split(',src=')[1];
      expect(args).toEqual(expect.arrayContaining(['build','--load','--platform','linux/amd64']));
      expect(readFileSync(secretFile,'utf8')).toBe(token); expect(statSync(secretFile).mode & 0o777).toBe(0o600);
      expect(secretFile.startsWith(context + path.sep)).toBe(false); expect(existsSync(path.join(context,'.env'))).toBe(false);
      expect(existsSync(path.join(context,'.git'))).toBe(false); expect(readFileSync(path.join(context,'server.js'),'utf8')).toBe('console.log("candidate")\n');
      labels = Object.fromEntries(args.flatMap((v,i)=>v==='--label'?[args[i+1].split(/=(.*)/s).slice(0,2)]:[]));
      if(options.lostBuildAck)throw new Error('synthetic lost local build acknowledgment');
      return options.leak === 'output' ? token : '';
    }
    if(args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{Id:'sha256:'+'a'.repeat(64),Os:'linux',Architecture:'amd64',Size:options.imageSize??1024,Config:{User:options.runtimeUser??'node',Labels:labels,Env:[]}}]);
    if(args[0] === 'image' && args[1] === 'save') {
      const archiveRoot = mkdtempSync(path.join(tmpdir(),'hv-candidate-layer-')); temporary.push(archiveRoot);
      if(options.compression) {
        // OCI specifies tar+zstd layers and whiteouts. Build actual tar bytes and
        // use Node's independent libzstd codec; the later layer removes the file.
        const first=path.join(archiveRoot,'first'),later=path.join(archiveRoot,'later');mkdirSync(first);mkdirSync(later);
        writeFileSync(path.join(first,'package-token'),JSON.stringify({payload:'',token,text:''}));
        writeFileSync(path.join(later,'.wh.package-token'),'');
        await runOperatorCommand('tar',['-cf',path.join(archiveRoot,'first.tar'),'-C',first,'package-token']);
        await runOperatorCommand('tar',['-cf',path.join(archiveRoot,'later.tar'),'-C',later,'.wh.package-token']);
        const tar=readFileSync(path.join(archiveRoot,'first.tar'));
        const compressed=zstdCompressSync(tar,{params:{[constants.ZSTD_c_compressionLevel]:19}});
        expect(compressed.includes(token)).toBe(false);expect(zstdDecompressSync(compressed).equals(tar)).toBe(true);
        const framed=options.compression==='zstd-skippable'?Buffer.concat([Buffer.from([0x50,0x2a,0x4d,0x18,0,0,0,0]),compressed]):compressed;
        expect(zstdDecompressSync(options.compression==='zstd-skippable'?framed.subarray(8):framed).equals(tar)).toBe(true);
        writeFileSync(path.join(archiveRoot,'layer.zst'),framed);
        writeFileSync(path.join(archiveRoot,'manifest.json'),JSON.stringify([{Layers:['layer.zst','later.tar']}]));
        await runOperatorCommand('tar',['-cf',args[args.indexOf('--output')+1],'-C',archiveRoot,'manifest.json','layer.zst','later.tar']);preparedArchive=true;return '';
      }
      writeFileSync(path.join(archiveRoot,'manifest.json'),'[]');
      writeFileSync(path.join(archiveRoot,'layer.gz'),gzipSync(Buffer.from(options.leak === 'layer' ? `prefix${token}suffix` : 'synthetic layer')));
      await runOperatorCommand('tar',['-cf',args[args.indexOf('--output')+1],'-C',archiveRoot,'manifest.json','layer.gz']); return '';
    }
    if(args[0] === 'create') return 'b'.repeat(64);
    if(args[0] === 'export') { writeFileSync(args[args.indexOf('--output')+1],options.leak==='filesystem'?token:'synthetic exported filesystem'); return ''; }
    if(args[0] === 'rm') return '';
    throw new Error('Unexpected Docker operation');
  };
  const scope = {scopeKind:'gar-private-candidate-publication-v1',sourceDirectory:root,sourceCommit:commit,sourceRepository:'github.com/acme/operator',packageReadAuthentication:'github-package-read'};
  return {root,scope,command,commands,preparedArchive:()=>preparedArchive,secretFile:()=>secretFile,context:()=>context};
}
describe('private application candidate build boundary',()=>{
  it('builds the exact committed snapshot with a temporary secret and verified source/image evidence, without publication',async()=>{
    const f=await candidate(); const result=await prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root);
    expect(result).toMatchObject({sourceCommit:f.scope.sourceCommit,sourceRepository:f.scope.sourceRepository,candidateImageId:'sha256:'+'a'.repeat(64),credentialScan:'verified',
      dockerfileSha256:sha(readFileSync(path.join(f.root,'Dockerfile'))),dependencyLockSha256:sha(readFileSync(path.join(f.root,'package-lock.json')))});
    expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/); expect(result.builderCleanup).toBe('verified');
    expect(f.commands.filter(args=>args[0]==='buildx'&&args[1]==='create')).toHaveLength(1);expect(f.commands.filter(args=>args[0]==='buildx'&&args[1]==='rm')).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(token);
    expect(existsSync(f.secretFile())).toBe(false); expect(existsSync(f.context())).toBe(false);
    expect(f.commands.some(args=>['login','push','pull'].includes(args[0]))).toBe(false);
  });
  it.runIf(process.env.HYPERVIBE_RUN_CANDIDATE_DOCKER_SMOKE === '1')('executes actual BuildKit and image/archive/filesystem custody checks with a synthetic credential',async()=>{
    const f=await candidate();const result=await prepareOperatorImages(f.scope,['application-candidate-v1'],async(program,args,options)=>{
      const output=await runOperatorCommand(program,args,options);
      // Inject only acknowledgment loss after real native cleanup. The next
      // independent Docker inventories must establish actual absence.
      if(program==='docker'&&args[0]==='buildx'&&args[1]==='rm')throw new Error('Synthetic lost cleanup acknowledgment after native deletion.');
      return output;
    },f.root);
    expect(result).toMatchObject({sourceCommit:f.scope.sourceCommit,credentialScan:'verified'});expect(result.candidateImageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    if(process.env.HYPERVIBE_CANDIDATE_SMOKE_RECEIPT)writeFileSync(process.env.HYPERVIBE_CANDIDATE_SMOKE_RECEIPT,JSON.stringify({status:'passed',source:'synthetic locally committed fixture',...result,cleanupAcknowledgment:'synthetic loss after actual deletion; native absence verified',publication:'not-performed',credential:'synthetic package-read token',providerCalls:0},null,2)+'\n',{mode:0o600});
  },240000);
  it.runIf(process.env.HYPERVIBE_RUN_CANDIDATE_DOCKER_SMOKE === '1')('removes actual rejected image and isolated BuildKit cache after detecting a copied synthetic credential',async()=>{
    const f=await candidate({leak:'layer'});let builder='',tag='';
    await expect(prepareOperatorImages(f.scope,['application-candidate-v1'],async(program,args,options)=>{
      if(program==='docker'&&args[0]==='buildx'&&args[1]==='create')builder=args[args.indexOf('--name')+1];
      if(program==='docker'&&args[0]==='buildx'&&args[1]==='build')tag=args[args.indexOf('--tag')+1];
      return runOperatorCommand(program,args,options);
    },f.root)).rejects.toThrow('The exact application candidate or its private build credential could not be verified.');
    expect(builder).toMatch(/^hv-candidate-/);expect(tag).toMatch(/^hypervibe-application-candidate:/);
    for(const args of [['image','ls','--filter',`reference=${tag}`,'--quiet'],['container','ls','--all','--filter',`name=^buildx_buildkit_${builder}0$`,'--format','{{.ID}}'],['volume','ls','--filter',`name=^buildx_buildkit_${builder}0_state$`,'--format','{{.Name}}']])expect((await runOperatorCommand('docker',args)).trim()).toBe('');
    if(process.env.HYPERVIBE_CANDIDATE_SMOKE_RECEIPT)writeFileSync(process.env.HYPERVIBE_CANDIDATE_SMOKE_RECEIPT+'.rejected.json',JSON.stringify({status:'passed',copiedSyntheticCredential:'rejected',builder,tag,imageAndBuilderAndCacheAbsent:true,providerCalls:0,publication:'not-performed'},null,2)+'\n',{mode:0o600});
  },240000);
  it.each(['dirty','wrongOrigin'] as const)('rejects %s before build/credential access',async fault=>{
    const f=await candidate({[fault]:true}); await expect(prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root)).rejects.toThrow();
    expect(f.commands).toEqual([]); expect(packageCredentials.githubPackagePullSource).not.toHaveBeenCalled();
  });
  it.each(['layer','filesystem','output'] as const)('rejects a credential copied into %s and removes temporary secret/context',async leak=>{
    const f=await candidate({leak}); let error: unknown;
    try {await prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root);} catch(value) {error=value;}
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(token);
    expect(f.commands.some(args=>args[0]==='buildx'&&args[1]==='build')).toBe(true);
    expect(f.commands.filter(args=>args[0]==='buildx'&&args[1]==='rm')).toHaveLength(1);expect(f.commands.some(args=>args[0]==='image'&&args[1]==='rm')).toBe(true);
    expect(existsSync(f.secretFile())).toBe(false); expect(existsSync(f.context())).toBe(false);
    expect(f.commands.some(args=>['login','push'].includes(args[0]))).toBe(false);
  });
  it('cleans only its exact builder and rejected image after an uncertain build acknowledgment',async()=>{
    const f=await candidate({lostBuildAck:true});await expect(prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root)).rejects.toThrow();
    const created=f.commands.find(args=>args[0]==='buildx'&&args[1]==='create')!;expect(created).toBeDefined();
    const name=created[created.indexOf('--name')+1];expect(name).toMatch(/^hv-candidate-[a-f0-9-]{36}$/);
    expect(f.commands).toContainEqual(['buildx','rm','--force','--timeout','30s',name]);
    expect(f.commands.filter(args=>args[0]==='buildx'&&args[1]==='build')).toHaveLength(1);
    expect(f.commands.some(args=>args[0]==='image'&&args[1]==='rm')).toBe(true);expect(existsSync(f.secretFile())).toBe(false);
  });

  it('reports incomplete scoped cleanup without returning a publishable image or retaining the secret/context',async()=>{
    const f=await candidate({cleanupFailure:true});let error:unknown;
    try{await prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root);}catch(value){error=value;}
    expect(String(error)).toContain('cleanup is incomplete');expect(String(error)).not.toContain(token);
    const receiptPath=String(error).match(/at (.+\/cleanup\.json);/)![1];temporary.push(path.dirname(receiptPath));
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));expect(receipt).toMatchObject({status:'incomplete',buildAttempted:true,succeeded:true});
    expect(JSON.stringify(receipt)).not.toContain(token);expect(statSync(receiptPath).mode&0o777).toBe(0o600);
    expect(existsSync(f.secretFile())).toBe(false);expect(existsSync(f.context())).toBe(false);
  });

  // Docker rm has separate daemon/cache retention options. Native events on
  // 2026-10-30 proved both resources deleted although the command failed locally.
  // These reconstructed CLI responses model that lost acknowledgment, not live
  // compatibility: successful independent inventory reads establish absence.
  it('verifies native absence after a lost builder-removal acknowledgment without repeating deletion',async()=>{
    const f=await candidate({cleanupAckLost:true});
    const result=await prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root);
    expect(result.builderCleanup).toBe('verified');
    expect(f.commands.filter(a=>a[0]==='buildx'&&a[1]==='rm')).toHaveLength(1);
    expect(f.commands.some(a=>a[0]==='buildx'&&a[1]==='ls')).toBe(true);
    expect(f.commands.some(a=>a[0]==='container')).toBe(true);
    expect(f.commands.some(a=>a[0]==='volume')).toBe(true);
    expect(existsSync(f.secretFile())).toBe(false);expect(existsSync(f.context())).toBe(false);
  });

  it.each(['builder','container','volume','malformed-list'] as const)('keeps cleanup blocked when the %s observation does not prove absence',async cleanupRemaining=>{
    const f=await candidate({cleanupRemaining});let error:unknown;
    try{await prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root);}catch(value){error=value;}
    expect(String(error)).toContain('cleanup is incomplete');
    const receiptPath=String(error).match(/at (.+\/cleanup\.json);/)![1];temporary.push(path.dirname(receiptPath));
    expect(JSON.parse(readFileSync(receiptPath,'utf8'))).toMatchObject({status:'incomplete',succeeded:true});
    expect(existsSync(f.secretFile())).toBe(false);expect(existsSync(f.context())).toBe(false);
  });

  it.each([{runtimeUser:'00'},{imageSize:5*1024*1024*1024}])('rejects root-equivalent users or oversized images before archive export: %j',async options=>{
    const f=await candidate(options);await expect(prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root)).rejects.toThrow();
    expect(f.commands.some(args=>args[0]==='image'&&args[1]==='save')).toBe(false);
  });

  it.each(['zstd','zstd-skippable'] as const)('rejects unscannable %s layers even when a later whiteout leaves the final filesystem clean',async compression=>{
    const f=await candidate({compression});await expect(prepareOperatorImages(f.scope,['application-candidate-v1'],f.command,f.root)).rejects.toThrow();
    expect(f.preparedArchive()).toBe(true);
    expect(f.commands.some(args=>args[0]==='image'&&args[1]==='rm')).toBe(true);
    expect(f.commands.some(args=>args[0]==='export')).toBe(false);
    expect(existsSync(f.secretFile())).toBe(false);expect(existsSync(f.context())).toBe(false);
  });

});
