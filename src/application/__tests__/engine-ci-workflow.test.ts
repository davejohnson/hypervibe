import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { renderReleaseWorkflow } from '../infrastructure-engine-ci.js';

describe('keyless release workflow', () => {
  const workflow = renderReleaseWorkflow({
    environmentName: 'staging', branch: 'main', gcpProjectId: 'demo-project', region: 'us-central1',
    provider: 'projects/123/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
    releaseIdentity: 'hypervibe-release@demo-project.iam.gserviceaccount.com',
    services: [
      { name: 'web', resource: 'web-abc', healthPath: '/health', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web', generatedDockerfile: 'FROM node:22-slim\nCMD ["npm","start"]\n' },
      { name: 'worker', resource: 'worker-abc', kind: 'workerPools', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-worker', generatedDockerfile: 'FROM node:22-slim\nCMD ["npm","run","worker"]\n' },
    ],
  });
  const parsed = YAML.parse(workflow);

  it('authenticates through OIDC with no stored secret', () => {
    expect(parsed.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow).not.toMatch(/secrets\./);
    const auth = parsed.jobs.release.steps.find((step: { uses?: string }) => step.uses?.startsWith('google-github-actions/auth'));
    expect(auth.with.workload_identity_provider).toContain('workloadIdentityPools/hypervibe-github');
  });

  it('releases on push with one release at a time and an etag-guarded image-only change', () => {
    expect(parsed.on.push.branches).toEqual(['main']);
    expect(parsed.concurrency).toEqual({ group: 'hypervibe-release-staging', 'cancel-in-progress': false });
    const release = parsed.jobs.release.steps.find((step: { name?: string }) => step.name === 'Release web');
    expect(release.run).toContain("base + '?updateMask=template.containers'");
    expect(release.run).toContain('{ etag: current.etag, template: { containers } }');
    expect(release.run).toContain('node release.mjs web-abc us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web@${{ steps.build_web.outputs.digest }} /health services');
  });

  it('builds each service from its own generated Dockerfile when the repository has none', () => {
    const builds = ['web', 'worker'].map((name) => parsed.jobs.release.steps.find((step: { name?: string }) => step.name === `Build ${name}`).run as string);
    expect(builds[0]).toContain('.hypervibe-web.Dockerfile');
    expect(builds[1]).toContain('.hypervibe-worker.Dockerfile');
    expect(builds[0]).toContain('if [ ! -f Dockerfile ]');
    const worker = parsed.jobs.release.steps.find((step: { name?: string }) => step.name === 'Release worker').run as string;
    expect(worker).toMatch(/node release\.mjs worker-abc .+ "" workerPools/);
  });
});
