import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { normalizeGitRemoteIdentity } from '../../../lib/git-remote.js';
import { githubPackagePullSource } from '../github/package-pull.js';
import { isolatedDockerEnvironment, runOperatorCommand, type OperatorCommand, type OperatorCommandOptions } from './operator-image-build.js';

function fail(): never { throw new Error('The exact application candidate or its private build credential could not be verified.'); }
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const applicationCandidateDeclarationShape = {
  sourceDirectory: z.string().min(1).max(2048).refine(path.isAbsolute), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  imageName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), packageReadAuthentication: z.literal('github-package-read'),
};
export const applicationCandidatePreparedShape = {
  candidateBuildId: z.string().guid(), builderCleanup: z.literal('verified'),
  sourceRepository: z.string().regex(/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/), dockerfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  dependencyLockSha256: z.string().regex(/^[a-f0-9]{64}$/), candidateImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), credentialScan: z.literal('verified'),
};
export function applicationCandidateLabels(scope: Record<string,string>) {
  return {...(scope.candidateBuildId?{'dev.hypervibe.candidate-build':scope.candidateBuildId}:{}),'org.opencontainers.image.source':scope.sourceRepository,'org.opencontainers.image.revision':scope.sourceCommit,
    'dev.hypervibe.source-manifest':scope.sourceManifestSha256,'dev.hypervibe.dockerfile':scope.dockerfileSha256,
    'dev.hypervibe.dependency-lock':scope.dependencyLockSha256};
}
async function ownedCandidateImage(image: string, scope: Record<string,string>, command: OperatorCommand, options: OperatorCommandOptions = {}) {
  const entries=z.array(z.object({Id:z.string().regex(/^sha256:[a-f0-9]{64}$/),Os:z.string(),Architecture:z.string(),Size:z.number().optional(),
    Config:z.object({User:z.string(),Labels:z.record(z.string(),z.string())}).passthrough()}).passthrough()).length(1)
    .parse(JSON.parse(await command('docker',['image','inspect',image],options)));
  const value=entries[0];if(Object.entries(applicationCandidateLabels(scope)).some(([key,v])=>value.Config.Labels[key]!==v))fail();return value;
}
export async function inspectApplicationCandidate(image: string, scope: Record<string,string>, command: OperatorCommand, options: OperatorCommandOptions = {}) {
  const value=await ownedCandidateImage(image,scope,command,options),user=value.Config.User.split(':')[0],size=value.Size;
  if(value.Os!=='linux'||value.Architecture!=='amd64'||typeof size!=='number'||!Number.isSafeInteger(size)||size<0||size>4*1024*1024*1024
    ||user==='root'||!/^([a-z_][a-z0-9_-]*|[1-9][0-9]*)$/i.test(user))fail();
  return value.Id;
}

/** Stream bytes; no archive entry or command output containing the credential is
 * exposed or persisted. Unsupported zstd OCI layers must not pass a raw-byte scan. */
async function scan(stream: NodeJS.ReadableStream, credential: Buffer, compressed: boolean, signal: AbortSignal): Promise<void> {
  let carry=Buffer.alloc(0), bytes=0;
  const iterator=(stream as AsyncIterable<Buffer>)[Symbol.asyncIterator](); let first=Buffer.alloc(0);
  while(first.length<4) {const next=await iterator.next();if(next.done)break;first=Buffer.concat([first,next.value]);}
  // OCI permits zstd layers; RFC 8878 also permits leading skippable frames.
  // Until bounded zstd decoding is supported, reject both forms before scanning.
  if(compressed&&first.length>=4&&(first.readUInt32LE(0)===0xfd2fb528
    || (first.readUInt32LE(0)&0xfffffff0)===0x184d2a50)) {await iterator.return?.();fail();}
  const input=Readable.from((async function*(){yield first;for(;;){const next=await iterator.next();if(next.done)break;yield next.value;}})());
  const decoded=compressed&&first[0]===0x1f&&first[1]===0x8b?input.pipe(createGunzip()):input;
  input.on('error',error=>decoded.destroy(error));
  try {
    for await(const chunk of decoded) {
      bytes+=chunk.length;if(bytes>4*1024*1024*1024||signal.aborted)fail();
      const next=Buffer.concat([carry,chunk]);if(next.includes(credential))fail();carry=next.subarray(Math.max(0,next.length-credential.length+1));
    }
  } finally {input.destroy();decoded.destroy();await iterator.return?.();}
}
async function scanTarEntry(archive: string, entry: string, credential: Buffer, options: OperatorCommandOptions) {
  const child=spawn('tar',['-xOf',archive,entry],{env:options.env,stdio:['ignore','pipe','pipe'],signal:options.signal});
  child.stderr.resume();
  const exited=new Promise<void>((resolve,reject)=>{child.once('error',()=>reject(new Error('Candidate archive scan failed.')));
    child.once('close',code=>code===0?resolve():reject(new Error('Candidate archive scan failed.')));});
  // Attach rejection immediately even if streaming detects the credential first.
  const completion=exited.catch(()=>fail()); completion.catch(()=>{});
  try {await scan(child.stdout,credential,true,options.signal!);await completion;} finally {if(child.exitCode===null)child.kill('SIGTERM');}
}
function safeEnvironment(directory: string) {
  const source=isolatedDockerEnvironment(directory), result: NodeJS.ProcessEnv={DOCKER_CONFIG:source.DOCKER_CONFIG};
  writeFileSync(path.join(directory,'config.json'),JSON.stringify({auths:{},cliPluginsExtraDirs:[path.join(homedir(),'.docker','cli-plugins')]}),{mode:0o600});
  // Retain only the standard plugin location, never the user's registry auth config.
  // Do not inherit arbitrary credential variables into git, Docker or BuildKit.
  for(const key of ['PATH','HOME','USER','TMPDIR','LANG','LC_ALL'])if(process.env[key])result[key]=process.env[key];
  return result;
}
/** Local preparation only: never registry login/push, provider API, IAM, or deploy. */
export async function prepareApplicationCandidate(nativeScope: Record<string,string>, command: OperatorCommand=runOperatorCommand): Promise<Record<string,string>> {
  const root=z.string().refine(path.isAbsolute).parse(nativeScope.sourceDirectory), commit=z.string().regex(/^[a-f0-9]{40}$/).parse(nativeScope.sourceCommit);
  if(nativeScope.packageReadAuthentication!=='github-package-read' || !/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(nativeScope.sourceRepository))fail();
  const directory=mkdtempSync(path.join(tmpdir(),'hypervibe-candidate-')), context=path.join(directory,'context');
  const signal=AbortSignal.timeout(1_200_000), env=safeEnvironment(path.join(directory,'docker')), options={env,signal};
  const candidateBuildId=randomUUID(),builder=`hv-candidate-${candidateBuildId}`,tag=`hypervibe-application-candidate:${candidateBuildId}`;
  let container: string | undefined, token='',builderAttempted=false,buildAttempted=false,succeeded=false;
  let prepared:Record<string,string>|undefined,source:Record<string,string>|undefined;
  const secret=path.join(directory,'npm-token');
  try {
    const git=(args:string[])=>command('git',['-C',root,...args],options);
    if((await git(['rev-parse','--verify','HEAD'])).trim()!==commit || (await git(['status','--porcelain=v1','--untracked-files=normal'])).trim()
      || normalizeGitRemoteIdentity((await git(['remote','get-url','origin'])).trim())!==nativeScope.sourceRepository) fail();
    const entries=(await git(['ls-tree','-rz',commit])).split('\0').filter(Boolean).map(line=>{
      const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line); if(!match)fail();
      const name=match[3]; if(path.isAbsolute(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git')||/[\r\n\\]/.test(name)
        || /(^|\/)\.env(?:$|\.)/.test(name)&&!/(?:\.example|\.sample|\.template)$/.test(name) || name==='config/config.json')fail();
      return {name,mode:match[1],oid:match[2]};
    });
    if(!entries.length||entries.length>5000||!entries.some(e=>e.name==='Dockerfile')||!entries.some(e=>e.name==='package-lock.json'))fail();
    const archive=path.join(directory,'source.tar'); await git(['archive','--format=tar','--output',archive,commit]); mkdirSync(context,{mode:0o700});
    await command('tar',['-xf',archive,'-C',context],options);
    let total=0;const manifest: Record<string,{sha256:string;mode:string}>={};
    for(const entry of entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)) {
      const file=path.join(context,entry.name),stat=statSync(file);total+=stat.size;if(!stat.isFile()||total>512*1024*1024)fail();
      const bytes=readFileSync(file);if(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==entry.oid)fail();
      manifest[entry.name]={sha256:sha(bytes),mode:entry.mode};
    }
    source={...nativeScope,candidateBuildId,sourceManifestSha256:sha(JSON.stringify(manifest)),dockerfileSha256:manifest.Dockerfile.sha256,dependencyLockSha256:manifest['package-lock.json'].sha256};
    const credential=githubPackagePullSource({githubRepo:nativeScope.sourceRepository.slice('github.com/'.length),requireExactScope:true});
    if(!credential||credential.credentialKey!=='packageReadToken'||credential.token.length<16||credential.token.length>16384||/[\r\n\0]/.test(credential.token))fail();token=credential.token;
    writeFileSync(secret,token,{mode:0o600,flag:'wx'});
    // The selected secret cannot already be present in the reviewed context.
    for(const entry of entries)if(readFileSync(path.join(context,entry.name)).includes(Buffer.from(token)))fail();
    builderAttempted=true;
    const created=(await command('docker',['buildx','create','--name',builder,'--driver','docker-container','--driver-opt','memory=4g,cpu-quota=200000,cpu-period=100000'],options)).trim();
    if(created!==builder)fail();buildAttempted=true;
    const output=await command('docker',['buildx','build','--builder',builder,'--load','--platform','linux/amd64','--progress','plain','--secret',`id=npm_token,src=${secret}`,
      ...Object.entries(applicationCandidateLabels(source)).flatMap(([key,value])=>['--label',`${key}=${value}`]),'--tag',tag,'--file',path.join(context,'Dockerfile'),context],options);
    rmSync(secret);if(output.includes(token))fail();
    const image=await inspectApplicationCandidate(tag,source,command,options);
    const inspect=await command('docker',['image','inspect',image],options);if(inspect.includes(token))fail();
    const saved=path.join(directory,'image.tar');await command('docker',['image','save','--output',saved,image],options);
    const members=(await command('tar',['-tf',saved],options)).trim().split('\n');if(!members.length||members.length>1024)fail();
    for(const member of members) {if(!/^[A-Za-z0-9_./-]+$/.test(member)||member.startsWith('/')||member.split('/').includes('..'))fail();
      if(!member.endsWith('/'))await scanTarEntry(saved,member,Buffer.from(token),options);}
    container=(await command('docker',['create','--network','none','--platform','linux/amd64','--entrypoint','true',image],options)).trim();
    if(!/^[a-f0-9]{64}$/.test(container))fail();
    const filesystem=path.join(directory,'filesystem.tar');await command('docker',['export','--output',filesystem,container],options);
    await scan(createReadStream(filesystem),Buffer.from(token),false,signal);
    await command('docker',['rm',container],options);container=undefined;
    prepared={...source,candidateImageId:image,credentialScan:'verified',builderCleanup:'verified'};succeeded=true;
  } catch {succeeded=false;} finally {
    // Never retain a secret mount, source snapshot or rejected image/cache after
    // a failed scan. A unique owned builder is removed without keep-state.
    rmSync(secret,{force:true});
    const cleanupOptions={env,signal:AbortSignal.timeout(90_000)};let cleanupComplete=true;
    if(container)try{await command('docker',['rm',container],cleanupOptions);}catch{cleanupComplete=false;}
    if(!succeeded&&buildAttempted&&source)try{
      await ownedCandidateImage(tag,source,command,cleanupOptions);
      await command('docker',['image','rm',tag],cleanupOptions);
    }catch{ // Missing or unknown local image identity cannot authorize deleting any other image.
      cleanupComplete=false;
    }
    if(builderAttempted) {
      // A lost removal acknowledgment is not proof that the builder remains.
      // Reserve time for independent reads; never repeat the removal request.
      try {
        await command('docker',['buildx','rm','--force','--timeout','30s',builder],{
          ...cleanupOptions,signal:AbortSignal.any([cleanupOptions.signal,AbortSignal.timeout(60_000)]),
        });
      }catch{ /* Only the native observations below can establish cleanup. */ }
      try {
        // Suspension may expire all existing timers simultaneously. Readback
        // gets its own bounded phase and cannot authorize another deletion.
        const observationOptions={env,signal:AbortSignal.timeout(30_000)};
        const names=(await command('docker',['buildx','ls','--format','{{.Builder.Name}}'],observationOptions)).trim().split('\n');
        if(names.some(name=>!name||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)||name===builder)
          ||(await command('docker',['container','ls','--all','--filter',`name=^buildx_buildkit_${builder}0$`,'--format','{{.ID}}'],observationOptions)).trim()
          ||(await command('docker',['volume','ls','--filter',`name=^buildx_buildkit_${builder}0_state$`,'--format','{{.Name}}'],observationOptions)).trim())cleanupComplete=false;
      }catch{cleanupComplete=false;}
    }
    token='';
    if(!cleanupComplete) {
      for(const file of ['context','source.tar','image.tar','filesystem.tar'])rmSync(path.join(directory,file),{recursive:true,force:true});
      writeFileSync(path.join(directory,'cleanup.json'),JSON.stringify({status:'incomplete',builder,tag,buildAttempted,succeeded,container:container??null}),{mode:0o600});
      throw new Error(`Application candidate cleanup is incomplete. Preserve the owned recovery record at ${path.join(directory,'cleanup.json')}; no publication is authorized.`);
    }
    rmSync(directory,{recursive:true,force:true});
  }
  if(!succeeded||!prepared)return fail();return prepared;
}
