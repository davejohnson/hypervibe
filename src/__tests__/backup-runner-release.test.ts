import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const sourceSha = '1234567890abcdef1234567890abcdef12345678';
const imageId = `sha256:${'a'.repeat(64)}`;
const manifestDigest = `sha256:${'b'.repeat(64)}`;
const imageRepository = 'ghcr.io/example/hypervibe/backup-runner';
const uniqueTag = `${imageRepository}:1.2.3-${sourceSha}-123-2`;
const immutableImage = `${imageRepository}@${manifestDigest}`;
const directories: string[] = [];

interface Call { command: string; args: string[]; dockerConfig?: string; config?: unknown }

function release(scenario = 'success', overrides: Record<string, string> = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'hv-backup-release-test-')));
  directories.push(directory);
  for (const path of ['scripts', 'bin', 'test', 'templates/backup-runner', 'build']) mkdirSync(join(directory, path), { recursive: true });
  const script = new URL('../../scripts/release-backup-runner.mjs', import.meta.url);
  if (existsSync(script)) copyFileSync(script, join(directory, 'scripts/release-backup-runner.mjs'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(directory, 'templates/backup-runner/Dockerfile'), '# Synthetic build input; Docker is a process fixture.\n');
  writeFileSync(join(directory, 'test/backup-runner-smoke.mjs'), '// Existing packaged smoke is invoked, never replaced in the repository.\n');
  writeFileSync(join(directory, 'build/backup-runner-release.json'), '{"stale":true}\n');
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ scenario, sourceSha, imageId, manifestDigest }));
  const binary = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const args = process.argv.slice(2), command = path.basename(process.argv[1]);
let config;
if (process.env.DOCKER_CONFIG && fs.existsSync(path.join(process.env.DOCKER_CONFIG, 'config.json'))) config = JSON.parse(fs.readFileSync(path.join(process.env.DOCKER_CONFIG, 'config.json'), 'utf8'));
fs.appendFileSync(process.env.CALLS, JSON.stringify({command,args,dockerConfig:process.env.DOCKER_CONFIG,config}) + '\\n');
function fail() { process.stderr.write('Fixture command failed; raw-secret-sentinel\\n'); process.exit(1); }
if (command === 'git') {
  if (args.join(' ') === 'rev-parse HEAD') process.stdout.write((fixture.scenario === 'checkout-mismatch' ? 'f'.repeat(40) : fixture.sourceSha) + '\\n');
  else if (args.join(' ') === 'status --porcelain=v1 --untracked-files=all') {
    if (fixture.scenario === 'dirty-source') process.stdout.write(' M templates/backup-runner/Dockerfile\\n');
    if (fixture.scenario === 'untracked-source') process.stdout.write('?? src/extra.ts\\n');
  } else fail();
} else if (args[0] === 'build') {
  if (fixture.scenario === 'build-failure') fail();
} else if (args[0] === 'image' && args[1] === 'inspect') {
  const pulled = args.at(-1).includes('@');
  const labels = {'org.opencontainers.image.source':'https://github.com/Example/Hypervibe','org.opencontainers.image.revision':fixture.sourceSha,'org.opencontainers.image.version':'1.2.3'};
  if (pulled && fixture.scenario === 'wrong-version') labels['org.opencontainers.image.version'] = '1.2.2';
  if (pulled && fixture.scenario === 'wrong-source') labels['org.opencontainers.image.source'] = 'https://github.com/other/repo';
  if (pulled && fixture.scenario === 'wrong-revision') labels['org.opencontainers.image.revision'] = 'c'.repeat(40);
  const calls = fs.readFileSync(process.env.CALLS,'utf8').trim().split('\\n').map(JSON.parse);
  const changed = (pulled && fixture.scenario === 'wrong-identity') || (fixture.scenario === 'tag-replaced' && calls.filter(call => call.args[0] === 'image').length > 1);
  process.stdout.write(JSON.stringify([{Id:changed ? 'sha256:' + 'c'.repeat(64) : fixture.imageId,Os:'linux',Architecture:pulled && fixture.scenario === 'wrong-platform' ? 'arm64' : 'amd64',Config:{User:fixture.scenario === 'root-user' ? 'root' : 'postgres',Labels:labels}}]));
} else if (args[0] === 'run') {
  if (args.some(arg => arg.endsWith('/backup-runner-smoke.mjs'))) {
    if (fixture.scenario === 'smoke-failure') fail();
    process.stdout.write('Packaged PostgreSQL restore checks passed.\\n');
  } else if (args.includes('-p')) {
    process.stdout.write((fixture.scenario === 'wrong-packaged-version' ? '1.2.2' : '1.2.3') + '\\n');
  } else fail();
} else if (args[0] === 'push') {
  if (fixture.scenario === 'push-failure') fail();
  // Docker documents this terminal manifest digest line. The unrelated image ID must not become the receipt.
  process.stdout.write('Image ID: ' + fixture.imageId + '\\n');
  if (fixture.scenario === 'bad-digest') process.stdout.write('release: digest: sha256:not-a-digest size: 1234\\n');
  else process.stdout.write('release: digest: ' + fixture.manifestDigest + ' size: 1234\\n');
} else if (args[0] === 'pull') {
  if (fixture.scenario === 'private-image') fail();
  process.stdout.write('Digest: ' + fixture.manifestDigest + '\\n');
} else fail();
`;
  for (const name of ['docker', 'git']) writeFileSync(join(directory, 'bin', name), binary, { mode: 0o755 });
  const output = join(directory, 'github-output');
  const summary = join(directory, 'github-summary');
  const result = spawnSync(process.execPath, [join(directory, 'scripts/release-backup-runner.mjs')], {
    cwd: directory, encoding: 'utf8', timeout: 15_000,
    env: {
      ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}`,
      GITHUB_REPOSITORY: 'Example/Hypervibe', GITHUB_REF_NAME: 'v1.2.3', GITHUB_SHA: sourceSha,
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      DOCKER_CONFIG: join(directory, 'authenticated-config'),
      FIXTURE: join(directory, 'fixture.json'), CALLS: join(directory, 'calls.jsonl'), ...overrides,
    },
  });
  const calls: Call[] = existsSync(join(directory, 'calls.jsonl')) ? readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const receipt = join(directory, 'build/backup-runner-release.json');
  return { directory, result, calls, receipt, output, summary };
}

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('backup helper immutable release boundary', () => {
  it('builds once, tests the default non-root image offline, and publishes a verified anonymous manifest digest', () => {
    const run = release();
    expect(run.result.status, run.result.stderr).toBe(0);
    const docker = run.calls.filter(call => call.command === 'docker');
    const build = docker.filter(call => call.args[0] === 'build');
    expect(build).toHaveLength(1);
    expect(build[0].args).toEqual(expect.arrayContaining(['--platform', 'linux/amd64', '--file', join(run.directory, 'templates/backup-runner/Dockerfile'), '--tag', uniqueTag, run.directory]));
    for (const label of [`org.opencontainers.image.source=https://github.com/Example/Hypervibe`, `org.opencontainers.image.revision=${sourceSha}`, 'org.opencontainers.image.version=1.2.3']) expect(build[0].args).toContain(label);
    const smoke = docker.find(call => call.args[0] === 'run' && call.args.some(arg => arg.endsWith('/backup-runner-smoke.mjs')))!;
    expect(smoke.args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--tmpfs', '--entrypoint', 'node', imageId]));
    expect(smoke.args).not.toContain('--user');
    expect(smoke.args.join(' ')).toContain('readonly');
    const push = docker.find(call => call.args[0] === 'push')!;
    expect(push.args).toEqual(['push', uniqueTag]);
    expect(docker.indexOf(push)).toBeGreaterThan(docker.indexOf(smoke));
    const pull = docker.find(call => call.args[0] === 'pull')!;
    expect(pull.args).toEqual(['pull', '--platform', 'linux/amd64', immutableImage]);
    expect(pull.dockerConfig).toBeTruthy();
    expect(pull.dockerConfig).not.toBe(push.dockerConfig);
    expect(pull.config).toEqual({ auths: {} });
    expect(existsSync(pull.dockerConfig!)).toBe(false);
    expect(JSON.parse(readFileSync(run.receipt, 'utf8'))).toEqual({
      schemaVersion: 1, artifact: 'hypervibe-backup-runner', packageVersion: '1.2.3', releaseTag: 'v1.2.3',
      sourceRepository: 'Example/Hypervibe', sourceSha, image: immutableImage, platform: 'linux/amd64',
      workflowRunId: '123', workflowRunAttempt: '2', packagedSmoke: 'passed', providerLiveVerified: false,
    });
    expect(readFileSync(run.output, 'utf8')).toBe(`image=${immutableImage}\n`);
    expect(readFileSync(run.summary, 'utf8')).toContain(immutableImage);
    expect(run.result.stdout).toContain(immutableImage);
    expect(run.result.stdout).not.toContain(imageId);
    expect(run.result.stdout).toMatch(/Building backup helper[\s\S]*Running packaged smoke[\s\S]*Pushing tested backup helper[\s\S]*Verifying anonymous access/);
  });

  it.each(['smoke-failure', 'wrong-packaged-version', 'tag-replaced', 'root-user'])('rejects %s before pushing', scenario => {
    const run = release(scenario);
    expect(run.result.status).not.toBe(0);
    expect(run.calls.some(call => call.args[0] === 'build')).toBe(true);
    expect(run.calls.some(call => call.args[0] === 'push')).toBe(false);
    expect(existsSync(run.receipt)).toBe(false);
    expect(existsSync(run.output)).toBe(false);
    expect(existsSync(run.summary)).toBe(false);
    expect(run.result.stderr).not.toContain('raw-secret-sentinel');
  });

  it.each(['push-failure', 'bad-digest', 'private-image', 'wrong-identity', 'wrong-version', 'wrong-platform', 'wrong-source', 'wrong-revision'])('does not claim publication success after %s', scenario => {
    const run = release(scenario);
    expect(run.result.status).not.toBe(0);
    expect(run.calls.filter(call => call.args[0] === 'push')).toHaveLength(1);
    expect(existsSync(run.receipt)).toBe(false);
    expect(existsSync(run.output)).toBe(false);
    expect(existsSync(run.summary)).toBe(false);
    expect(run.result.stderr).toMatch(/publication may have occurred/i);
    expect(run.result.stderr).toContain(uniqueTag);
    if (scenario === 'private-image') expect(run.result.stderr).toMatch(/check registry access and visibility/i);
    expect(run.result.stderr).not.toContain('raw-secret-sentinel');
    expect(run.calls.filter(call => call.args[0] === 'pull').length).toBeLessThanOrEqual(1);
  });

  it.each([
    ['tag mismatch', { GITHUB_REF_NAME: 'v1.2.4' }, 'success'],
    ['checkout mismatch', {}, 'checkout-mismatch'],
    ['changed tracked source at the correct commit', {}, 'dirty-source'],
    ['untracked source at the correct commit', {}, 'untracked-source'],
    ['short SHA', { GITHUB_SHA: '1234567' }, 'success'],
    ['unversioned tag', { GITHUB_REF_NAME: 'latest' }, 'success'],
  ])('rejects %s before any Docker mutation', (_name, overrides, scenario) => {
    const run = release(scenario as string, overrides as Record<string, string>);
    expect(run.result.status).not.toBe(0);
    expect(run.calls.filter(call => call.command === 'docker')).toEqual([]);
    expect(existsSync(run.receipt)).toBe(false);
    expect(existsSync(run.output)).toBe(false);
    expect(run.result.stderr).toMatch(/release validation/i);
  });
});
