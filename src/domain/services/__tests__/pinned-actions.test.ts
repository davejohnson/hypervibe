import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { PINNED_ACTIONS } from '../pinned-actions.js';
import { renderReleaseWorkflow } from '../../../application/infrastructure-engine-ci.js';

// #419: a workflow that gives a credential to third-party code names that code by commit, not by a movable tag.
describe('third-party actions in generated workflows', () => {
  it('pins each one to a full commit SHA', () => {
    for (const reference of Object.values(PINNED_ACTIONS)) expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/);
  });

  it('leaves no tag reference to those actions anywhere in workflow-generating source', () => {
    const repositories = Object.values(PINNED_ACTIONS).map((reference) => reference.split('@')[0]!);
    // git grep exits 1 when nothing matches, which is the passing case.
    let output = '';
    try { output = execFileSync('git', ['grep', '-n', '-E', `(${repositories.join('|')})@v[0-9]`, '--', 'src', ':!*__tests__*', ':!*.test.ts'], { encoding: 'utf8' }); } catch { /* no matches */ }
    const found = output.trim().split('\n').filter(Boolean);
    expect(found).toEqual([]);
  }, 20_000);

  it('the Google release workflow authenticates through the pinned commits', () => {
    const steps = YAML.parse(renderReleaseWorkflow({
      environmentName: 'staging', branch: 'main', gcpProjectId: 'demo-project', region: 'us-central1',
      provider: 'projects/123/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
      releaseIdentity: 'hypervibe-release@demo-project.iam.gserviceaccount.com',
      services: [{ name: 'web', resource: 'web-abc', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web' }],
    })).jobs.release.steps as Array<{ uses?: string }>;
    const used = steps.map((step) => step.uses).filter((value): value is string => Boolean(value) && value!.startsWith('google-github-actions/'));
    expect(used).toEqual([PINNED_ACTIONS.googleAuth.split(' #')[0], PINNED_ACTIONS.setupGcloud.split(' #')[0]]);
  });
});
