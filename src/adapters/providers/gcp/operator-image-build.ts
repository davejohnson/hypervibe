import { prepareApplicationCandidate } from './application-candidate-build.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { OperatorArtifactCommandError, OPERATOR_BUILD_REPORTED_MARKERS, type OperatorBuildReportedMarker, type OperatorBuildStep } from '../../../domain/ports/operator-artifact.port.js';

export interface OperatorCommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal;
  /** Exact archived build input, interpreted transiently and never emitted. */
  reviewedDockerfile?: { path: string; contents: string } }
export type OperatorCommand = (program: string, args: string[], options?: OperatorCommandOptions) => Promise<string>;

function standardBuildStep(value:string):OperatorBuildStep|undefined {
  const command=value.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)\s+)+/,'');
  // A mixed RUN instruction cannot identify the particular failed subcommand.
  if(/[;&|]/.test(command)) {
    const parts=command.split(/\s+&&\s+/);
    if(parts.length>1&&parts.every(part=>!/[;&|]/.test(part)&&(/^apt-get (?:update|install)(?: |$)/.test(part)||part==='rm -rf /var/lib/apt/lists/*'))
      &&parts.some(part=>part.startsWith('apt-get ')))return 'system-package';
    return undefined;
  }
  if(/^npm (?:ci|install)(?: |$)/.test(command))return 'npm-install';
  if(/^npm (?:run|run-script)(?: |$)/.test(command))return 'npm-script';
  if(/^node(?: |$)/.test(command))return 'node-command';
  if(/^apt-get (?:update|install)(?: |$)/.test(command))return 'system-package';
  return undefined;
}
/** Bounded subset of Dockerfile shell RUN parsing. Keep continuation indentation
 * and quoted whitespace; unsupported escapes, heredocs and exec forms stay unknown. */
function reviewedRunCommands(contents:string) {
  if(/^#\s*escape\s*=/im.test(contents)||/^\s*SHELL\s/im.test(contents)||contents.includes('<<'))return [];
  const lines=contents.split('\n'),runs:Array<{line:number;end:number;quoted:string;step?:OperatorBuildStep}>=[];
  const continues=(line:string)=>/(?:^|[^\\])\\[ \t]*$/.test(line);
  for(let index=0;index<lines.length;index++) {
    const start=index;let text=lines[index].replace(/\r$/,'').trimStart();
    if(/^(?:#|$)/.test(text))continue;
    const run=/^RUN\s/i.test(text);
    let continued=continues(text);if(continued)text=text.replace(/\\[ \t]*$/,'');
    while(continued&&index+1<lines.length) {
      const next=lines[++index].replace(/\r$/,'');
      if(/^\s*(?:#|$)/.test(next))continue;
      continued=continues(next);text+=continued?next.replace(/\\[ \t]*$/,''):next;
    }
    if(continued||!run)continue;
    let command=text.replace(/^RUN\s+/i,'').trimEnd();
    while(/^--(?:mount|network|security)=[^\s]+\s/.test(command))command=command.replace(/^--(?:mount|network|security)=[^\s]+\s+/,'');
    if(command.startsWith('--')||command.startsWith('[')||command.includes('<<')||command.length>3500||/[^\x20-\x7e\t]/.test(command))continue;
    // For this printable ASCII subset JSON's encoder equals Go %q. Do not decode
    // arbitrary native Go escapes as JSON or persist the quoted process text.
    runs.push({line:start+1,end:index+1,quoted:JSON.stringify('/bin/sh -c '+command),step:standardBuildStep(command)});
  }
  return runs;
}
/** Transient, bounded stderr recognition for BuildKit only. A marker describes
 * emitted text, never establishes its cause or grants retry authority. */
function buildReportedMarkers(reviewed:OperatorCommandOptions['reviewedDockerfile'],args:string[]) {
  const reported=new Set<OperatorBuildReportedMarker>(),headers=new Set<number>(),failedCommands=new Set<string>();let carry='',dropping=false;
  const fileIndex=args.indexOf('--file');
  const accepted=reviewed&&typeof reviewed.path==='string'&&typeof reviewed.contents==='string'&&fileIndex>=0
    &&args.filter(arg=>arg==='--file'||arg==='-f'||arg.startsWith('--file=')).length===1
    &&args[fileIndex+1]===reviewed.path&&reviewed.path.length>0&&reviewed.path.length<=4096
    &&!/[\x00-\x1f\x7f]/.test(reviewed.path)&&Buffer.byteLength(reviewed.contents,'utf8')<=1024*1024
    &&reviewed.contents.split('\n').length<=100000?reviewed:undefined;
  const maximum=accepted?.contents.split('\n').length,runs=accepted?reviewedRunCommands(accepted.contents):[];
  function observe(raw:string) {
    const line=raw.replace(/\r$/,'').replace(/\x1b\[[0-9;]{0,32}m/g,'').replace(/^#[0-9]{1,6} (?:[0-9]{1,8}(?:\.[0-9]{1,9})? )?/,'');
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line))return;
    const npm=/^npm (?:ERR!|error) code (E401|E403|E404|EINTEGRITY|ENOSPC)$/.exec(line);
    if(npm)reported.add(npm[1]==='ENOSPC'?'disk-full':`npm-${npm[1]}` as OperatorBuildReportedMarker);
    if(/^npm (?:ERR!|error) code 1$/.test(line))reported.add('npm-code-1');
    if(line==='gyp ERR! configure error')reported.add('native-gyp-configure');
    if(line==='gyp ERR! build error')reported.add('native-gyp-build');
    if(/^(?:[A-Za-z0-9_./-]+\.(?:[cm]?ts|tsx)\([1-9][0-9]*,[1-9][0-9]*\): )?error TS[1-9][0-9]{3,4}: .+$/.test(line))reported.add('typescript-error');
    const failed=/^(?:ERROR|error): (?:failed to build: )?(?:failed to solve: )?process ("[^\r\n]+") did not complete successfully: exit code: [1-9][0-9]{0,2}$/.exec(line);
    if(failed){reported.add('build-command-failed');if(failedCommands.size<2)failedCommands.add(failed[1]);}
    if(/^(?:ERROR|error): (?:failed to build: )?failed to solve: [^\r\n]+: no space left on device$/.test(line))reported.add('disk-full');
    if(/^(?:ERROR|error): (?:failed to build: )?failed to solve: [^\r\n]*failed to resolve source metadata for [^\r\n]+$/.test(line)) {
      reported.add('image-metadata-failed');
      if(/(?:429 Too Many Requests|toomanyrequests: [^\r\n]+)$/.test(line))reported.add('registry-rate-limit');
    }
    if(accepted&&line.startsWith(accepted.path+':')) {
      const number=line.slice(accepted.path.length+1);
      if(/^[1-9][0-9]{0,5}$/.test(number)&&Number(number)<=maximum!&&headers.size<2)headers.add(Number(number));
    }
  }
  function fragment(value:string,end:boolean) {
    if(!dropping&&carry.length+value.length<=4096)carry+=value;
    else {carry='';dropping=true;}
    if(end){if(!dropping)observe(carry);carry='';dropping=false;}
  }
  return {
    push(chunk:Buffer){const value=chunk.toString('utf8');let start=0,next:number;
      while((next=value.indexOf('\n',start))!==-1){fragment(value.slice(start,next),true);start=next+1;}
      if(start<value.length)fragment(value.slice(start),false);},
    finish(){if(carry&&!dropping)observe(carry);carry='';dropping=false;},
    details(){const markers=OPERATOR_BUILD_REPORTED_MARKERS.filter(marker=>reported.has(marker));
      let dockerfileLine=headers.size===1?[...headers][0]:undefined,buildStep:OperatorBuildStep|undefined;
      if(failedCommands.size===1&&headers.size<=1){const quoted=[...failedCommands][0];
        const matches=runs.filter(run=>run.quoted===quoted&&(dockerfileLine===undefined||dockerfileLine>=run.line&&dockerfileLine<=run.end));
        if(matches.length===1){dockerfileLine=matches[0].line;buildStep=matches[0].step;}}
      return {...(markers.length?{reported:markers}:{}),...(dockerfileLine?{dockerfileLine}:{}),...(buildStep?{buildStep}:{})};},
  };
}
/** No shell, bounded captured output, no native output or credential echo on errors. */
export const runOperatorCommand: OperatorCommand = async (program, args, options = {}) => {
  if (options.signal?.aborted) throw new OperatorArtifactCommandError({kind:'abort'});
  return new Promise<string>((resolve, reject) => {
    // Commands without input need only EOF. An unused writable pipe can fail
    // after a fast child exits and incorrectly discard its successful result.
    let child: ReturnType<typeof spawn>;
    try { child = spawn(program, args, { cwd: options.cwd, env: options.env,
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], signal: options.signal }); }
    catch { reject(new OperatorArtifactCommandError({kind:options.signal?.aborted?'abort':'spawn'})); return; }
    const output: Buffer[] = []; let bytes = 0, limitExceeded = false;
    const diagnostic=program==='docker'&&args[0]==='buildx'&&args[1]==='build'?buildReportedMarkers(options.reviewedDockerfile,args):undefined;
    const exceedsLimit = () => { if (bytes <= 64 * 1024 * 1024) return false;
      if (!limitExceeded) { limitExceeded=true; child.kill('SIGTERM'); } return true; };
    const consume = (chunk: Buffer) => { bytes += chunk.length; if (!exceedsLimit()) output.push(chunk); };
    child.stdout!.on('data', consume);
    // Drain but never expose stderr, even when it contains a native token echo.
    child.stderr!.on('data', (chunk: Buffer) => { bytes += chunk.length; if(!exceedsLimit())diagnostic?.push(chunk); });
    child.once('error', () => reject(new OperatorArtifactCommandError({kind:limitExceeded?'output-limit':options.signal?.aborted?'abort':'spawn',...diagnostic?.details()})));
    child.once('close', code => {
      if(!limitExceeded&&!options.signal?.aborted)diagnostic?.finish();
      const details=diagnostic?.details();
      if (limitExceeded) reject(new OperatorArtifactCommandError({kind:'output-limit',...details}));
      else if (options.signal?.aborted) reject(new OperatorArtifactCommandError({kind:'abort',...details}));
      else if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
      else reject(new OperatorArtifactCommandError({kind:'exit', ...(code !== null && Number.isInteger(code) && code > 0 && code <= 0xffffffff ? {exitCode:code} : {}),...details}));
    });
    child.stdin?.on('error', () => reject(new Error('Operator artifact command failed.')));
    child.stdin?.end(options.input);
  });
};
export function operatorPackageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++, directory = path.dirname(directory)) {
    const file = path.join(directory, 'package.json');
    if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === '@hypervibe/hypervibe') return directory;
  }
  throw new Error('The exact Hypervibe package is unavailable.');
}
export function packageProvenance(root = operatorPackageRoot()) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packageVersion = z.string().regex(/^\d+\.\d+\.\d+$/).parse(pkg.version);
  const lockBytes = readFileSync(path.join(root, 'dist/operator-artifacts/package-lock.json'));
  const lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.version !== packageVersion || lock.packages?.['']?.version !== packageVersion || lock.name !== '@hypervibe/hypervibe') throw new Error('The packaged dependency lock is unavailable.');
  return { packageVersion, packageLockSha256: createHash('sha256').update(lockBytes).digest('hex') };
}
export function artifactImageLabels(scope: Record<string, string>, kind: string) {
  return { 'org.opencontainers.image.title': `hypervibe-${kind}`, 'org.opencontainers.image.version': scope.packageVersion,
    'org.opencontainers.image.revision': scope.packageArchiveSha256, 'dev.hypervibe.dependency-lock': scope.packageLockSha256 };
}
export async function inspectOperatorImage(image: string, kind: string, scope: Record<string, string>, command: OperatorCommand,
  options: OperatorCommandOptions = {}): Promise<string> {
  const parsed: unknown = JSON.parse(await command('docker', ['image', 'inspect', image], options));
  const result = z.array(z.object({ Id: z.string().regex(/^sha256:[a-f0-9]{64}$/), Os: z.literal('linux'), Architecture: z.literal('amd64'),
    Config: z.object({ User: z.string(), Labels: z.record(z.string(), z.string()) }).passthrough() }).passthrough()).length(1).parse(parsed)[0];
  if (result.Config.User !== (kind === 'backup-runner-v1' ? 'postgres' : 'node')
    || Object.entries(artifactImageLabels(scope, kind)).some(([key, value]) => result.Config.Labels[key] !== value)) throw new Error('Prepared image identity changed.');
  return result.Id;
}
export function isolatedDockerEnvironment(directory: string): NodeJS.ProcessEnv {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: directory }; delete environment.DOCKER_AUTH_CONFIG;
  return environment;
}
/** Build and smoke only. No registry login, push, cloud API or publication occurs. */
export async function prepareOperatorImages(nativeScope: Record<string, string>, artifacts: string[], command: OperatorCommand = runOperatorCommand,
  root = operatorPackageRoot()): Promise<Record<string, string>> {
  if (artifacts.length === 1 && artifacts[0] === 'application-candidate-v1') return prepareApplicationCandidate(nativeScope, command);
  if (!artifacts.length || artifacts.some(kind => !['holding-v1', 'backup-runner-v1'].includes(kind))) throw new Error('Unsupported operator image kind.');
  const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-artifact-build-'));
  const signal = AbortSignal.timeout(1_200_000);
  try {
    const provenance = packageProvenance(root);
    const packed: unknown = JSON.parse(await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory, '--cache', path.join(directory, 'npm-cache')], { cwd: root, signal }));
    const name = z.array(z.object({ filename: z.string().regex(/^[A-Za-z0-9_.-]+\.tgz$/) }).passthrough()).length(1).parse(packed)[0].filename;
    const archive = path.join(directory, name), archiveBytes = readFileSync(archive);
    const scope = { ...nativeScope, ...provenance, packageArchiveSha256: createHash('sha256').update(archiveBytes).digest('hex') };
    const extracted = path.join(directory, 'extracted'); mkdirSync(extracted);
    await command('tar', ['-xzf', archive, '-C', extracted], { signal });
    const packageRoot = path.join(extracted, 'package');
    if (createHash('sha256').update(readFileSync(path.join(packageRoot, 'dist/operator-artifacts/package-lock.json'))).digest('hex') !== scope.packageLockSha256)
      throw new Error('Packed dependency lock changed.');
    const environment = isolatedDockerEnvironment(path.join(directory, 'docker'));
    const prepared: Record<string, string> = { ...scope };
    for (const kind of artifacts) {
      const build = path.join(directory, kind); mkdirSync(build);
      const dockerfile = path.join(build, 'Dockerfile');
      if (kind === 'holding-v1') {
        const target = path.join(build, 'templates/cloud-holding'); mkdirSync(target, { recursive: true });
        copyFileSync(path.join(packageRoot, 'templates/cloud-holding/server.cjs'), path.join(target, 'server.cjs'));
        copyFileSync(path.join(packageRoot, 'templates/cloud-holding/Dockerfile'), dockerfile);
      } else {
        copyFileSync(archive, path.join(build, 'package.tgz'));
        copyFileSync(path.join(packageRoot, 'templates/backup-runner/Dockerfile.packaged'), dockerfile);
      }
      const tag = `hypervibe-operator-${kind}:${scope.packageArchiveSha256}`;
      await command('docker', ['build', '--platform', 'linux/amd64', '--file', dockerfile,
        ...Object.entries(artifactImageLabels(scope, kind)).flatMap(([key, value]) => ['--label', `${key}=${value}`]), '--tag', tag, build], { env: environment, signal });
      const imageId = await inspectOperatorImage(tag, kind, scope, command, { env: environment, signal });
      const run = ['run', '--rm', '--platform', 'linux/amd64', '--pull', 'never', '--network', 'none', '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777', '--entrypoint', 'node'];
      if (kind === 'backup-runner-v1') {
        const version = (await command('docker', [...run, imageId, '-p', "require('/opt/hypervibe/package.json').version"], { env: environment, signal })).trim();
        if (version !== scope.packageVersion) throw new Error('Packaged helper version changed.');
        await command('docker', [...run, imageId, '--input-type=module', '-e',
          "await import('/opt/hypervibe/dist/ci/backup-runner.js'); await import('/opt/hypervibe/dist/ci/backup-controller.js');"], { env: environment, signal });
        await command('docker', [...run, '--mount', `type=bind,src=${path.join(packageRoot, 'test/backup-runner-smoke.mjs')},dst=/opt/hypervibe/backup-runner-smoke.mjs,readonly`,
          imageId, '/opt/hypervibe/backup-runner-smoke.mjs'], { env: environment, signal });
      } else {
        const smoke = "const s=require('/opt/hypervibe-holding/server.cjs')();s.listen(0,'127.0.0.1',async()=>{try{const r=await fetch('http://127.0.0.1:'+s.address().port);if(r.status!==503||(await r.text())!=='Deployment pending\\n')process.exitCode=1;}catch{process.exitCode=1;}finally{s.close();s.closeAllConnections();}});";
        await command('docker', [...run, imageId, '-e', smoke], { env: environment, signal });
      }
      prepared[kind === 'holding-v1' ? 'holdingImageId' : 'backupImageId'] = imageId;
    }
    return prepared;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
