import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOperatorCommand, type OperatorCommandOptions } from '../operator-image-build.js';
import { OperatorArtifactCommandError, OperatorArtifactPreparationError,
  operatorArtifactCommandFailure, operatorArtifactPreparationMessage } from '../../../../domain/ports/operator-artifact.port.js';

const privateText = 'synthetic-command-private-output';
const temporary: string[]=[];
afterEach(()=>temporary.splice(0).forEach(directory=>rmSync(directory,{recursive:true,force:true})));
function dockerFixture(script:string) {
  const directory=mkdtempSync(path.join(tmpdir(),'hv-command-stderr-'));temporary.push(directory);
  writeFileSync(path.join(directory,'docker'),`#!${process.execPath}\n${script}\n`,{mode:0o700});
  return {env:{PATH:directory+path.delimiter+path.dirname(process.execPath)},dockerfileLineCount:30} as OperatorCommandOptions;
}
async function failure(work: Promise<string>) {
  let caught: unknown;
  try { await work; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).not.toContain(privateText);
  expect(JSON.stringify(caught)).not.toContain(privateText);
  return caught;
}

// Independent source: Node v24.18.1 child_process docs distinguish spawn error,
// close's native exit code/null on signal, and AbortSignal cancellation.
// https://raw.githubusercontent.com/nodejs/node/v24.18.1/doc/api/child_process.md
// Every child here is real; no Docker or provider process runs.
describe('operator command closed failure boundary', () => {
  it('retains a native nonzero exit code without stdout or stderr', async () => {
    const error = await failure(runOperatorCommand(process.execPath, ['-e',
      `process.stdout.write('${privateText}');process.stderr.write('${privateText}');process.exitCode=17;`]));
    expect(error).toMatchObject({ commandFailure: { kind: 'exit', exitCode: 17 } });
  });
  it('identifies failure to spawn without exposing the requested executable', async () => {
    const error = await failure(runOperatorCommand('/nonexistent/' + privateText, []));
    expect(error).toMatchObject({ commandFailure: { kind: 'spawn' } });
  });
  it('sanitizes synchronous spawn argument rejection too', async () => {
    const error = await failure(runOperatorCommand(privateText + '\0', []));
    expect(error).toMatchObject({ commandFailure: { kind: 'spawn' } });
  });
  it('distinguishes cancellation before dispatch and while a child is running', async () => {
    for (const signal of [AbortSignal.abort(), AbortSignal.timeout(100)]) {
      const error = await failure(runOperatorCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal }));
      expect(error).toMatchObject({ commandFailure: { kind: 'abort' } });
    }
  });
  it('reports the local combined output bound without retaining the oversized stderr', async () => {
    const error = await failure(runOperatorCommand(process.execPath, ['-e',
      `process.stderr.write('${privateText}');process.stderr.write(Buffer.alloc(64*1024*1024+1,65));`]));
    expect(error).toMatchObject({ commandFailure: { kind: 'output-limit' } });
  });
  it('does not invent an exit code when the native close reports signal termination', async () => {
    const error = await failure(runOperatorCommand(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"]));
    expect(error).toMatchObject({ commandFailure: { kind: 'exit' } });
    expect((error as {commandFailure:object}).commandFailure).not.toHaveProperty('exitCode');
  });
  it('preserves successful stdout and drains private stderr without returning it', async () => {
    expect(await runOperatorCommand(process.execPath, ['-e',
      `process.stderr.write('${privateText}');process.stdout.write('verified-result');`])).toBe('verified-result');
  });
  it('carries validated command facts into preparation text while ignoring native messages', async () => {
    const error = await failure(runOperatorCommand(process.execPath,['-e','process.exit(7)']));
    const value = new OperatorArtifactPreparationError({phase:'image-build',reason:'command-failed',cleanup:'verified',commandFailure:operatorArtifactCommandFailure(error)});
    value.message=privateText;
    const message=operatorArtifactPreparationMessage(value);
    expect(message).toContain('command=exit, exitCode=7');expect(message).not.toContain(privateText);
  });
  it.each([{kind:privateText},{kind:'exit',exitCode:-1},{kind:'exit',exitCode:7,stderr:privateText},
    {kind:'exit',reported:[privateText]},{kind:'exit',reported:['npm-E401','npm-E401']},{kind:'exit',dockerfileLine:100001}])('rejects malformed or arbitrary command detail %j', detail => {
    const command = new OperatorArtifactCommandError({kind:'spawn'});
    Object.assign(command,{commandFailure:detail});expect(operatorArtifactCommandFailure(command)).toBeUndefined();
    const preparation = new OperatorArtifactPreparationError({phase:'image-build',reason:'command-failed',cleanup:'verified'});
    Object.assign(preparation,{commandFailure:detail});expect(operatorArtifactPreparationMessage(preparation)).toBeUndefined();
  });
  it('reports finite BuildKit stderr markers and a reviewed Dockerfile line without credential echoes',async()=>{
    const lines=[privateText,'#7 1.234 npm error code E401','#7 1.235 npm ERR! code E403','#7 1.236 npm error code E404',
      '#7 1.237 npm error code ENOSPC','#7 1.238 src/app.ts(2,3): error TS2322: '+privateText,'Dockerfile:12',
      'ERROR: failed to solve: process "/bin/sh -c '+privateText+'" did not complete successfully: exit code: 1'];
    const options=dockerFixture(`process.stderr.write(${JSON.stringify(lines.join('\n')+'\n')});process.exitCode=1;`);
    const error=await failure(runOperatorCommand('docker',['buildx','build'],options));
    expect(error).toMatchObject({commandFailure:{kind:'exit',exitCode:1,reported:['npm-E401','npm-E403','npm-E404','disk-full','typescript-error','build-command-failed'],dockerfileLine:12}});
    const message=operatorArtifactPreparationMessage(new OperatorArtifactPreparationError({phase:'image-build',reason:'command-failed',cleanup:'verified',commandFailure:operatorArtifactCommandFailure(error)}));
    expect(message).toContain('Build reported');expect(message).toContain('npm E401');expect(message).not.toContain(privateText);
  });
  it('recognizes a split stderr line and ignores oversized lines or numbers outside the reviewed file',async()=>{
    const options=dockerFixture(`process.stderr.write('x'.repeat(9000)+'npm error code E403\\nDockerfile:90000\\n#9 0.25 npm error co');setTimeout(()=>{process.stderr.write('de E404\\n');process.exitCode=1;},10);`);
    const error=await failure(runOperatorCommand('docker',['buildx','build'],options));
    expect(error).toMatchObject({commandFailure:{kind:'exit',reported:['npm-E404']}});
    expect(operatorArtifactCommandFailure(error)).not.toHaveProperty('dockerfileLine');
  });
  it('withholds unknown, lookalike and malicious content without guessing a cause',async()=>{
    const lines=['npm error code E401 '+privateText,'untrusted npm error code E403','ERROR: '+privateText,'Dockerfile:0','Dockerfile:999999999999999999999'];
    const options=dockerFixture(`process.stderr.write(${JSON.stringify(lines.join('\n')+'\n')});process.exitCode=1;`);
    const error=await failure(runOperatorCommand('docker',['buildx','build'],options));
    expect(operatorArtifactCommandFailure(error)).toEqual({kind:'exit',exitCode:1});
  });
  it('does not interpret stdout or non-build command stderr',async()=>{
    const options=dockerFixture("process.stdout.write('npm error code E401\\n');process.stderr.write('npm error code E403\\n');process.exitCode=1;");
    const nonBuild=await failure(runOperatorCommand('docker',['image','inspect'],options));
    expect(operatorArtifactCommandFailure(nonBuild)).toEqual({kind:'exit',exitCode:1});
    const stdoutOnly=dockerFixture("process.stdout.write('npm error code E401\\n');process.exitCode=1;");
    expect(operatorArtifactCommandFailure(await failure(runOperatorCommand('docker',['buildx','build'],stdoutOnly)))).toEqual({kind:'exit',exitCode:1});
  });
  // Reconstructed published npm/BuildKit signatures, emitted by a real isolated
  // child. No registry requests, image builds or package installs occur here.
  // https://raw.githubusercontent.com/npm/cli/v11.19.0/lib/utils/error-message.js
  // https://raw.githubusercontent.com/moby/buildkit/v0.21.0/solver/llbsolver/ops/exec.go
  // https://docs.docker.com/build/checks/
  it('keeps integrity, source-metadata and rate-limit observations finite',async()=>{
    const lines=['\x1b[31mnpm error code EINTEGRITY\x1b[0m',
      'ERROR: failed to solve: node:24: failed to resolve source metadata for docker.io/library/node:24: unexpected status from HEAD request: 429 Too Many Requests',
      'ERROR: failed to solve: writing '+privateText+': no space left on device'];
    const options=dockerFixture(`process.stderr.write(${JSON.stringify(lines.join('\n')+'\n')});process.exitCode=1;`);
    const error=await failure(runOperatorCommand('docker',['buildx','build'],options));
    expect(operatorArtifactCommandFailure(error)).toEqual({kind:'exit',exitCode:1,reported:['npm-EINTEGRITY','disk-full','image-metadata-failed','registry-rate-limit']});
  });
  it('requires the reviewed line count before including any Dockerfile header',async()=>{
    const options=dockerFixture("process.stderr.write('Dockerfile:12\\n');process.exitCode=1;");
    delete options.dockerfileLineCount;
    const error=await failure(runOperatorCommand('docker',['buildx','build'],options));
    expect(operatorArtifactCommandFailure(error)).toEqual({kind:'exit',exitCode:1});
  });
});
