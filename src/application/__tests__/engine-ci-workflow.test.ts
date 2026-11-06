import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { renderReleaseWorkflow } from '../infrastructure-engine-ci.js';

describe('keyless release workflow', () => {
  const workflow = renderReleaseWorkflow({
    environmentName: 'staging', branch: 'main', gcpProjectId: 'demo-project', region: 'us-central1',
    provider: 'projects/123/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
    releaseIdentity: 'hypervibe-release@demo-project.iam.gserviceaccount.com',
    services: [{ name: 'web', resource: 'web-abc', healthPath: '/health', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web' }],
    generatedDockerfile: 'FROM node:22-slim\n',
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
    expect(release.run).toContain("updateMask=template.containers");
    expect(release.run).toContain('etag: current.etag');
    expect(release.run).toContain('node release.mjs web-abc us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web@${{ steps.build_web.outputs.digest }} /health');
  });
});
