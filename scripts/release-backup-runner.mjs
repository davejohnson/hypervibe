#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = join(root, 'build/backup-runner-release.json');
const temporaryReceipt = `${receiptPath}.${process.pid}.tmp`;
const platform = 'linux/amd64';
let pushAttempted = false;
let anonymousConfig;
let uniqueTag;
let stage = 'release validation';

// The workflow owns registry login. Never echo command output on failure: it
// may include credentials or other details that do not belong in a receipt.
function command(program, args, env = process.env) {
  const result = spawnSync(program, args, {
    cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`${stage} failed`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function requireValue(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${stage} failed`);
  return value;
}

try {
  // A failed rerun must not leave an earlier success receipt behind.
  rmSync(receiptPath, { force: true });
  const repository = requireValue(process.env.GITHUB_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const releaseTag = requireValue(process.env.GITHUB_REF_NAME, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  const sourceSha = requireValue(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  const workflowRunId = requireValue(process.env.GITHUB_RUN_ID, /^[1-9]\d*$/);
  const workflowRunAttempt = requireValue(process.env.GITHUB_RUN_ATTEMPT, /^[1-9]\d*$/);
  const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (releaseTag !== `v${packageVersion}` || command('git', ['rev-parse', 'HEAD']).stdout.trim() !== sourceSha) {
    throw new Error('release validation failed');
  }
  if (command('git', ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
    throw new Error('release validation failed');
  }

  const sourceUrl = `https://github.com/${repository}`;
  const imageRepository = `ghcr.io/${repository.toLowerCase()}/backup-runner`;
  // Do not retag semver or latest: each workflow attempt has its own name.
  const tag = `${imageRepository}:${packageVersion}-${sourceSha}-${workflowRunId}-${workflowRunAttempt}`;
  if (tag.slice(imageRepository.length + 1).length > 128) throw new Error('release validation failed');
  uniqueTag = tag;
  const labels = {
    'org.opencontainers.image.source': sourceUrl,
    'org.opencontainers.image.revision': sourceSha,
    'org.opencontainers.image.version': packageVersion,
  };

  function inspect(image, env) {
    const images = JSON.parse(command('docker', ['image', 'inspect', image], env).stdout);
    if (!Array.isArray(images) || images.length !== 1) throw new Error(`${stage} failed`);
    const value = images[0];
    requireValue(value.Id, /^sha256:[a-f0-9]{64}$/);
    if (value.Os !== 'linux' || value.Architecture !== 'amd64' || value.Config?.User !== 'postgres'
      || Object.entries(labels).some(([key, expected]) => value.Config?.Labels?.[key] !== expected)) {
      throw new Error(`${stage} failed`);
    }
    return value.Id;
  }

  stage = 'helper build';
  process.stdout.write(`Building backup helper for ${platform}.\n`);
  command('docker', ['build', '--platform', platform, '--file', join(root, 'templates/backup-runner/Dockerfile'),
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), '--tag', tag, root]);
  stage = 'built helper identity verification';
  const testedImageId = inspect(tag);
  // Both runs use the immutable local ID, the image's default postgres user,
  // no network, and only temporary writable storage.
  const isolatedRun = ['run', '--rm', '--platform', platform, '--pull', 'never', '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777', '--entrypoint', 'node'];
  stage = 'packaged version verification';
  const packagedVersion = command('docker', [...isolatedRun, testedImageId, '-p', "require('/opt/hypervibe/package.json').version"]).stdout.trim();
  if (packagedVersion !== packageVersion) throw new Error(`${stage} failed`);
  stage = 'packaged smoke';
  process.stdout.write('Running packaged smoke with networking disabled.\n');
  const smokePath = '/opt/hypervibe/backup-runner-smoke.mjs';
  command('docker', [...isolatedRun, '--mount', `type=bind,src=${join(root, 'test/backup-runner-smoke.mjs')},dst=${smokePath},readonly`, testedImageId, smokePath]);

  stage = 'tested tag verification';
  if (inspect(tag) !== testedImageId) throw new Error(`${stage} failed`);
  stage = 'helper push';
  process.stdout.write(`Pushing tested backup helper: ${tag}\n`);
  pushAttempted = true;
  const pushed = command('docker', ['push', tag]);
  // Docker's terminal push line names a registry manifest digest. Image inspect
  // Id is the config digest and must never be substituted for this value.
  const digestLines = [...`${pushed.stdout}\n${pushed.stderr}`.matchAll(/^\S+: digest: (sha256:[a-f0-9]{64}) size: \d+\s*$/gm)];
  stage = 'published manifest digest verification';
  if (digestLines.length !== 1) throw new Error(`${stage} failed`);
  const image = `${imageRepository}@${digestLines[0][1]}`;

  anonymousConfig = mkdtempSync(join(tmpdir(), 'hv-backup-anonymous-'));
  writeFileSync(join(anonymousConfig, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  const anonymousEnv = { ...process.env, DOCKER_CONFIG: anonymousConfig };
  delete anonymousEnv.DOCKER_AUTH_CONFIG;
  stage = 'anonymous manifest pull';
  process.stdout.write('Verifying anonymous access to the published manifest.\n');
  command('docker', ['pull', '--platform', platform, image], anonymousEnv);
  stage = 'anonymous image identity verification';
  if (inspect(image, anonymousEnv) !== testedImageId) throw new Error(`${stage} failed`);

  const receipt = {
    schemaVersion: 1, artifact: 'hypervibe-backup-runner', packageVersion, releaseTag,
    sourceRepository: repository, sourceSha, image, platform, workflowRunId, workflowRunAttempt,
    packagedSmoke: 'passed', providerLiveVerified: false,
  };
  stage = 'release receipt';
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporaryReceipt, receiptPath);
  const summary = `Backup helper published and anonymously verified: ${image}\nPackaged PostgreSQL restore smoke passed on ${platform}. Live provider compatibility was not tested.\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  process.stdout.write(summary);
} catch {
  rmSync(receiptPath, { force: true });
  const publication = pushAttempted ? ` Publication may have occurred; inspect ${uniqueTag} before taking further action.` : '';
  const access = stage === 'anonymous manifest pull' ? ' Check registry access and visibility; the cause has not been established.' : '';
  process.stderr.write(`Backup helper ${stage} failed. No success receipt was produced.${publication}${access}\n`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryReceipt, { force: true });
  if (anonymousConfig) rmSync(anonymousConfig, { recursive: true, force: true });
}
