import { prepareApplicationCandidate } from './application-candidate-build.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export interface OperatorCommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal }
export type OperatorCommand = (program: string, args: string[], options?: OperatorCommandOptions) => Promise<string>;
/** No shell, bounded captured output, no native output or credential echo on errors. */
export const runOperatorCommand: OperatorCommand = async (program, args, options = {}) => {
  if (options.signal?.aborted) throw new Error('Operator artifact command cancelled.');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal });
    const output: Buffer[] = []; let bytes = 0;
    const consume = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) child.kill('SIGTERM'); else output.push(chunk); };
    child.stdout.on('data', consume);
    // Drain but never expose stderr, even when it contains a native token echo.
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) child.kill('SIGTERM'); });
    child.once('error', () => reject(new Error('Operator artifact command failed.')));
    child.once('close', code => code === 0 && bytes <= 64 * 1024 * 1024 ? resolve(Buffer.concat(output).toString('utf8')) : reject(new Error('Operator artifact command failed.')));
    child.stdin.on('error', () => reject(new Error('Operator artifact command failed.')));
    child.stdin.end(options.input ?? '');
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
