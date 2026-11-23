import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseWorkflowPath, removeReleaseWorkflow, renderReleaseWorkflow, writeReleaseWorkflow } from '../infrastructure-engine-ci.js';

describe('removing a torn-down environment\'s release workflow', () => {
  const roots: string[] = [];
  const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-workflow-')); roots.push(dir); return dir; };
  afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  it('deletes the workflow Hypervibe wrote for Google Cloud and says to commit it', () => {
    const dir = root();
    const content = renderReleaseWorkflow({
      environmentName: 'staging', branch: 'main', gcpProjectId: 'p', region: 'us-central1',
      workloadIdentityProvider: 'projects/1/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
      releaseIdentity: 'hypervibe-release@p.iam.gserviceaccount.com', buildBucket: 'b',
      services: [{ name: 'web', workload: 'web', resourceName: 'web-1', image: 'i' }],
    } as never);
    const written = writeReleaseWorkflow(dir, 'staging', content);
    writeReleaseWorkflow(dir, 'production', content);
    const message = removeReleaseWorkflow(dir, 'staging');
    expect(fs.existsSync(written.path)).toBe(false);
    expect(fs.existsSync(releaseWorkflowPath(dir, 'production'))).toBe(true);
    expect(message).toContain('deleted .github/workflows/hypervibe-release-staging.yml');
    expect(message).toContain('Commit and push');
  });

  it('leaves a workflow someone else wrote and says so', () => {
    const dir = root();
    const target = writeReleaseWorkflow(dir, 'staging', 'name: mine\non: push\n').path;
    expect(removeReleaseWorkflow(dir, 'staging')).toContain('was not written by Hypervibe');
    expect(fs.readFileSync(target, 'utf8')).toBe('name: mine\non: push\n');
  });

  it('never follows an environment name out of the workflows folder', () => {
    const dir = root();
    const production = writeReleaseWorkflow(dir, 'production', '# Managed by Hypervibe.\nname: x\n').path;
    expect(removeReleaseWorkflow(dir, 'x/../hypervibe-release-production')).toBe('');
    expect(removeReleaseWorkflow(dir, '../../production')).toBe('');
    expect(fs.existsSync(production)).toBe(true);
  });

  it('reports a workflow it cannot delete instead of failing the teardown', () => {
    const dir = root();
    const target = writeReleaseWorkflow(dir, 'staging', '# Managed by Hypervibe.\nname: x\n').path;
    fs.chmodSync(path.dirname(target), 0o555);
    try { expect(removeReleaseWorkflow(dir, 'staging')).toContain('could not delete'); } finally { fs.chmodSync(path.dirname(target), 0o755); }
    expect(fs.existsSync(target)).toBe(true);
  });

  it('says nothing when there is no workflow', () => {
    expect(removeReleaseWorkflow(root(), 'staging')).toBe('');
  });
});
