import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectOperatorImage, prepareOperatorImages, runOperatorCommand, type OperatorCommand } from '../operator-image-build.js';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(directory => rmSync(directory,{ recursive:true,force:true })));
describe('operator image package and command boundary', () => {
  it.each([undefined, ''])('gives a no-input child an EOF source without an unused writable pipe (%s)', async input => {
    // Node's stdio=ignore contract connects fd 0 to /dev/null. Inspect the
    // actual child descriptor; do not depend on reproducing a timing race.
    const output = await runOperatorCommand(process.execPath, ['-e',
      "const fs=require('node:fs');console.log(JSON.stringify({nullInput:fs.fstatSync(0).isCharacterDevice(),bytes:fs.readFileSync(0).length}))"], { input });
    expect(JSON.parse(output)).toEqual({ nullInput: true, bytes: 0 });
  });
  it('delivers supplied input intact and retains failure checking', async () => {
    const output = await runOperatorCommand(process.execPath, ['-e',
      "const fs=require('node:fs'),crypto=require('node:crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(0)).digest('hex'))"],
      { input: 'synthetic-sensitive-input' });
    expect(output.trim()).toBe(createHash('sha256').update('synthetic-sensitive-input').digest('hex'));
    await expect(runOperatorCommand(process.execPath, ['-e', 'process.exit(9)'])).rejects.toThrow('Operator artifact command failed.');
  });
  it('builds from actual npm packed bytes and the shipped dependency lock; never logs in or publishes during preparation', async () => {
    const root=mkdtempSync(path.join(tmpdir(),'hv-packed-image-contract-'));temporary.push(root);
    for(const directory of ['dist/operator-artifacts','templates/cloud-holding','templates/backup-runner','test']) mkdirSync(path.join(root,directory),{recursive:true});
    const pkg={name:'@hypervibe/hypervibe',version:'0.1.44',files:['dist','templates','test/backup-runner-smoke.mjs'],scripts:{prepack:'node -e "process.exit(77)"'}};
    writeFileSync(path.join(root,'package.json'),JSON.stringify(pkg));
    const lock=JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':{name:pkg.name,version:pkg.version}}});
    writeFileSync(path.join(root,'dist/operator-artifacts/package-lock.json'),lock);
    for(const file of ['templates/cloud-holding/Dockerfile','templates/cloud-holding/server.cjs','templates/backup-runner/Dockerfile.packaged','test/backup-runner-smoke.mjs'])
      copyFileSync(path.resolve(file),path.join(root,file));
    let labels:Record<string,string>={},kind='';const operations:string[][]=[];let archiveHash='';
    const command:OperatorCommand=async(program,args,options)=>{
      if(program!=='docker')return runOperatorCommand(program,args,options);
      operations.push(args);
      if(args[0]==='build'){
        labels=Object.fromEntries(args.flatMap((value,index)=>value==='--label'?[args[index+1].split(/=(.*)/s).slice(0,2)]:[]));
        kind=labels['org.opencontainers.image.title'].slice('hypervibe-'.length);
        const dockerfile=readFileSync(args[args.indexOf('--file')+1],'utf8');
        if(kind==='backup-runner-v1'){
          expect(dockerfile).toContain('npm ci --omit=dev --ignore-scripts');expect(dockerfile).toContain('dist/operator-artifacts/package-lock.json');
          const archive=readFileSync(path.join(args.at(-1)!,'package.tgz'));archiveHash=createHash('sha256').update(archive).digest('hex');
          expect(labels['org.opencontainers.image.revision']).toBe(archiveHash);
        }
        return '';
      }
      if(args[0]==='image')return JSON.stringify([{Id:'sha256:'+(kind==='holding-v1'?'a':'b').repeat(64),Os:'linux',Architecture:'amd64',Config:{User:kind==='holding-v1'?'node':'postgres',Labels:labels}}]);
      if(args[0]==='run'){
        expect(args).toEqual(expect.arrayContaining(['--network','none','--read-only','--pull','never']));
        if(args.includes('-p'))return pkg.version;
        if(kind==='backup-runner-v1'&&args.includes('--mount')){
          const mount=args[args.indexOf('--mount')+1],file=mount.match(/src=(.*),dst=/)![1];
          expect(readFileSync(file,'utf8')).toBe(readFileSync(path.join(root,'test/backup-runner-smoke.mjs'),'utf8'));
        }
        return '';
      }
      throw new Error('Preparation attempted a publication or an unreviewed command.');
    };
    const result=await prepareOperatorImages({scopeKind:'local-test'},['holding-v1','backup-runner-v1'],command,root);
    expect(result).toMatchObject({packageVersion:pkg.version,packageArchiveSha256:archiveHash,
      packageLockSha256:createHash('sha256').update(lock).digest('hex'),holdingImageId:'sha256:'+'a'.repeat(64),backupImageId:'sha256:'+'b'.repeat(64)});
    expect(operations.filter(args=>args[0]==='build')).toHaveLength(2);
    const runtimeImports=operations.find(args=>args[0]==='run'&&args.includes('--input-type=module'));
    expect(runtimeImports).toEqual(expect.arrayContaining(['sha256:'+'b'.repeat(64),'-e']));
    expect(runtimeImports?.at(-1)).toContain("import('/opt/hypervibe/dist/ci/backup-runner.js')");
    expect(runtimeImports?.at(-1)).toContain("import('/opt/hypervibe/dist/ci/backup-controller.js')");
    expect(operations.some(args=>['push','login','pull'].includes(args[0]))).toBe(false);
  });
  it('rejects a credential echo from an actual failing child process without exposing its output', async () => {
    await expect(runOperatorCommand(process.execPath,['-e',"process.stdin.resume();process.stdin.on('data',v=>process.stderr.write(v));process.stdin.on('end',()=>process.exit(1))"],
      {input:'synthetic-sensitive-password'})).rejects.toThrow('Operator artifact command failed.');
  });
  it('does not mistake registry manifest digest for the reviewed Docker configuration identity', async()=>{
    const command:OperatorCommand=async()=>JSON.stringify([{Id:'sha256:'+'b'.repeat(64),Os:'linux',Architecture:'arm64',Config:{User:'node',Labels:{}}}]);
    await expect(inspectOperatorImage('sha256:'+'a'.repeat(64),'holding-v1',{},command)).rejects.toThrow();
  });
});
