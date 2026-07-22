#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageLockPath = path.join(repoRoot, 'package-lock.json');
const publishWorkflow = 'publish-private-package.yml';
const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;

function usage() {
  console.log(`Usage: npm run release -- [patch|minor|major|X.Y.Z] [options]

Build, validate, commit, tag, and publish a Hypervibe release from main.

Options:
  --dry-run   Validate git state and print the release plan without changing files
  --no-wait   Push the release without waiting for the GitHub publish workflow
  --help      Show this help

Examples:
  npm run release -- patch
  npm run release -- 0.2.0
  npm run release -- minor --dry-run`);
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    stdio: capture ? 'pipe' : 'inherit',
  });

  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = capture
      ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : '.'}`);
  }
  return result;
}

function output(command, args) {
  return run(command, args, { capture: true }).stdout.trim();
}

function parseVersion(version, label) {
  const match = semverPattern.exec(version);
  if (!match) {
    throw new Error(`${label} must be a stable semantic version such as 0.1.2.`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function resolveNextVersion(currentVersion, requested) {
  const current = parseVersion(currentVersion, 'Current package version');
  if (['patch', 'minor', 'major'].includes(requested)) {
    const [major, minor, patch] = current;
    if (requested === 'patch') return `${major}.${minor}.${patch + 1}`;
    if (requested === 'minor') return `${major}.${minor + 1}.0`;
    return `${major + 1}.0.0`;
  }

  const next = parseVersion(requested, 'Requested version');
  if (compareVersions(next, current) <= 0) {
    throw new Error(`Requested version ${requested} must be newer than ${currentVersion}.`);
  }
  return requested;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPublishRun(commitSha) {
  const deadline = Date.now() + 90_000;
  process.stdout.write('Waiting for the GitHub package workflow');

  while (Date.now() < deadline) {
    const result = run('gh', [
      'run', 'list',
      '--workflow', publishWorkflow,
      '--event', 'push',
      '--limit', '20',
      '--json', 'databaseId,headSha,status,conclusion,url',
    ], { capture: true, allowFailure: true });

    if (result.status === 0) {
      const runs = JSON.parse(result.stdout || '[]');
      const releaseRun = runs.find((candidate) => candidate.headSha === commitSha);
      if (releaseRun) {
        console.log(`\nWatching ${releaseRun.url}`);
        run('gh', ['run', 'watch', String(releaseRun.databaseId), '--exit-status']);
        console.log(`Published by ${releaseRun.url}`);
        return;
      }
    }

    process.stdout.write('.');
    await sleep(3_000);
  }

  throw new Error(
    `The release was pushed, but ${publishWorkflow} did not appear within 90 seconds. ` +
    `Inspect it with: gh run list --workflow ${publishWorkflow}`
  );
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--help')) {
    usage();
    return;
  }

  const knownFlags = new Set(['--dry-run', '--no-wait']);
  const unknownFlags = rawArgs.filter((arg) => arg.startsWith('--') && !knownFlags.has(arg));
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown option: ${unknownFlags.join(', ')}`);
  }

  const requestedVersions = rawArgs.filter((arg) => !arg.startsWith('--'));
  if (requestedVersions.length > 1) {
    throw new Error('Pass at most one version increment or exact version.');
  }

  const requestedVersion = requestedVersions[0] ?? 'patch';
  const dryRun = rawArgs.includes('--dry-run');
  const waitForWorkflow = !rawArgs.includes('--no-wait');

  run('git', ['--version'], { capture: true });
  run('npm', ['--version'], { capture: true });

  const status = output('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) {
    throw new Error(`Release requires a clean worktree. Commit or stash these changes first:\n${status}`);
  }

  const branch = output('git', ['branch', '--show-current']);
  if (branch !== 'main') {
    throw new Error(`Release must run from main; current branch is ${branch || '(detached)'}.`);
  }

  console.log('Fetching origin/main and release tags...');
  run('git', ['fetch', 'origin', '--tags', '--prune']);

  const startingHead = output('git', ['rev-parse', 'HEAD']);
  const remoteMain = output('git', ['rev-parse', 'origin/main']);
  if (startingHead !== remoteMain) {
    throw new Error(
      `Local main must exactly match origin/main before release.\n` +
      `Local:  ${startingHead}\nRemote: ${remoteMain}`
    );
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const currentVersion = packageJson.version;
  const nextVersion = resolveNextVersion(currentVersion, requestedVersion);
  const tag = `v${nextVersion}`;
  const existingTag = run('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
    capture: true,
    allowFailure: true,
  });
  if (existingTag.status === 0) {
    throw new Error(`Tag ${tag} already exists.`);
  }

  console.log(`\nHypervibe release plan\n  version: ${currentVersion} -> ${nextVersion}\n  tag:     ${tag}\n`);
  if (dryRun) {
    console.log('Dry run complete; no files, commits, tags, or remote refs were changed.');
    return;
  }

  if (waitForWorkflow) {
    run('gh', ['auth', 'status'], { capture: true });
  }

  const originalPackageJson = readFileSync(packageJsonPath);
  const originalPackageLock = readFileSync(packageLockPath);
  let releaseCommitted = false;

  try {
    run('npm', ['version', nextVersion, '--no-git-tag-version']);
    run('npm', ['run', 'release:check']);

    const changedFiles = output('git', ['status', '--porcelain=v1', '--untracked-files=all'])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));
    const allowedFiles = new Set(['package.json', 'package-lock.json']);
    const unexpectedFiles = changedFiles.filter((file) => !allowedFiles.has(file));
    if (unexpectedFiles.length > 0) {
      throw new Error(`Release checks changed unexpected files:\n${unexpectedFiles.join('\n')}`);
    }

    run('git', ['add', '--', 'package.json', 'package-lock.json']);
    run('git', ['diff', '--cached', '--check']);
    run('git', ['commit', '-m', `Release Hypervibe ${nextVersion}`]);
    releaseCommitted = output('git', ['rev-parse', 'HEAD']) !== startingHead;
    run('git', ['tag', '-a', tag, '-m', `Hypervibe ${nextVersion}`]);
  } catch (error) {
    if (!releaseCommitted && output('git', ['rev-parse', 'HEAD']) === startingHead) {
      run('git', ['restore', '--staged', '--', 'package.json', 'package-lock.json'], { allowFailure: true });
      writeFileSync(packageJsonPath, originalPackageJson);
      writeFileSync(packageLockPath, originalPackageLock);
      console.error('Restored package version files after the failed release check.');
    }
    throw error;
  }

  const releaseCommit = output('git', ['rev-parse', 'HEAD']);
  try {
    run('git', [
      'push', '--atomic', 'origin',
      'HEAD:refs/heads/main',
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
  } catch (error) {
    console.error(`The local release commit and ${tag} were kept. Retry the atomic push with:`);
    console.error(`git push --atomic origin HEAD:refs/heads/main refs/tags/${tag}:refs/tags/${tag}`);
    throw error;
  }

  if (waitForWorkflow) {
    await waitForPublishRun(releaseCommit);
  } else {
    console.log(`Release pushed. Inspect publication with: gh run list --workflow ${publishWorkflow}`);
  }

  console.log(`\nHypervibe ${nextVersion} release complete.`);
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
