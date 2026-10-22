import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import { compileManagedGitHubFiles, githubSpecNeedsOpenAI } from '../github-infrastructure.service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function files() {
  const spec = projectSpecSchema.parse({ version: 1, project: 'security-review', environments: {}, github: {
    actions: { security: { kind: 'security-review', lockfilePaths: ['apps/web/package-lock.json'], publicPackageNames: ['@public/pkg'], nodeVersions: ['24.11.0'] } },
  } });
  expect(githubSpecNeedsOpenAI(spec.github!)).toBe(false);
  return compileManagedGitHubFiles(spec.github!);
}

describe('managed security review workflow', () => {
  it('publishes the exact packaged scanner through the existing owned-file manifest', () => {
    const compiled = files();
    const scanner = compiled.find((file) => file.path === '.github/hypervibe/security-review.mjs');
    expect(scanner?.content.trim()).toBe(readFileSync(new URL('../../../../templates/security/security-review.mjs', import.meta.url), 'utf8').trim());
    const manifest = compiled.find((file) => file.path === '.github/hypervibe/manifest.json')!;
    expect(manifest.content).toContain('.github/hypervibe/security-review.mjs');
    expect(scanner?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('runs schedule and manual checks at an immutable source revision with read-only permissions and no package install', () => {
    const content = files().find((file) => file.path.endsWith('/hypervibe-security.yml'))!.content;
    const workflow = parse(content);
    expect(workflow.on).toEqual({ schedule: [{ cron: '17 5 * * *', timezone: 'UTC' }], workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const steps = workflow.jobs.review.steps;
    expect(steps[0].with).toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': false });
    expect(content).not.toMatch(/npm (?:ci|install)|secrets\.|pull_request_target|issues: write/);
    expect(steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@')))
      .toMatchObject({ if: '${{ always() }}', with: { 'if-no-files-found': 'error' } });
  });

  it.each([0, 1, 2])('executes the generated launcher and preserves scanner status %s', (status) => {
    const workflow = parse(files().find((file) => file.path.endsWith('/hypervibe-security.yml'))!.content);
    const step = workflow.jobs.review.steps.find((entry: { name?: string }) => entry.name === 'Review public advisories');
    const root = mkdtempSync(join(tmpdir(), 'hypervibe-security-workflow-')); roots.push(root);
    mkdirSync(join(root, '.github/hypervibe'), { recursive: true });
    writeFileSync(join(root, '.github/hypervibe/security-review.mjs'), `process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(${status});\n`);
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd: root, encoding: 'utf8',
      env: { ...process.env, ...step.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: root } });
    expect(result.status).toBe(status);
    expect(JSON.parse(readFileSync(join(root, 'hypervibe-security-review.json'), 'utf8'))).toEqual([
      '--root', root, '--lockfile', 'apps/web/package-lock.json', '--public-package', '@public/pkg', '--node-version', '24.11.0',
    ]);
  });

  it('executes the published scanner and fails closed when source and advisory evidence are unavailable', () => {
    const compiled = files();
    const workflow = parse(compiled.find((file) => file.path.endsWith('/hypervibe-security.yml'))!.content);
    const step = workflow.jobs.review.steps.find((entry: { name?: string }) => entry.name === 'Review public advisories');
    const root = mkdtempSync(join(tmpdir(), 'hypervibe-security-emitted-')); roots.push(root);
    mkdirSync(join(root, '.github/hypervibe'), { recursive: true });
    writeFileSync(join(root, '.github/hypervibe/security-review.mjs'), compiled.find((file) => file.path === '.github/hypervibe/security-review.mjs')!.content);
    const denyNetwork = join(root, 'deny-network.mjs');
    writeFileSync(denyNetwork, 'globalThis.fetch = async () => { throw new Error("provider-error-must-not-escape"); };');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd: root, encoding: 'utf8',
      env: { ...process.env, ...step.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: root, NODE_OPTIONS: `--import=${denyNetwork}` } });
    expect(result.status).toBe(2);
    const report = readFileSync(join(root, 'hypervibe-security-review.json'), 'utf8');
    expect(JSON.parse(report)).toMatchObject({ status: 'incomplete', complete: false });
    expect(report + result.stderr).not.toContain('provider-error-must-not-escape');
  });
});
