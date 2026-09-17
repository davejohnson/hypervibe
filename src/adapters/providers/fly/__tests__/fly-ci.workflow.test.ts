import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { Buffer } from 'node:buffer';
import type { BranchDeployTarget } from '../../../../domain/ports/ci-deploy.port.js';
import { providerRegistry } from '../../../../domain/registry/provider.registry.js';
import { formatFlyOrganizationBinding, formatFlyServiceBinding } from '../fly.binding.js';
import { buildFlyGitHubActionsSteps } from '../fly-ci.workflow.js';
import { buildFlyPortableRecipe } from '../fly-ci.recipe.js';
import '../fly.adapter.js';

function target(): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web'],
    providerProjectId: formatFlyOrganizationBinding('hypervibe-test'),
    providerEnvironmentId: 'env-1',
    providerRegion: 'yyz',
    providerServiceIds: [formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName: 'hv-web-app',
      machineId: 'machine-1',
    })],
    providerImageUris: [],
    containerStartCommand: 'node server.mjs',
    runtime: { kind: 'node', version: '24' },
  };
}

describe('Fly.io exact-SHA workflow', () => {
  it.each([
    { kind: 'github', dropMount: false }, { kind: 'portable', dropMount: false },
    { kind: 'github', dropMount: true }, { kind: 'portable', dropMount: true },
  ])('verifies $kind image updates with provider mount loss=$dropMount', async ({ kind, dropMount }) => {
    const deployTarget = target();
    const sha = 'a'.repeat(40);
    const digest = `sha256:${'b'.repeat(64)}`;
    const image = `registry.fly.io/hv-web-app@${digest}`;
    const mounts = [{ volume: 'vol_retained', path: '/data' }];
    let machine = {
      id: 'machine-1', instance_id: 'version-1', state: 'started', checks: [],
      config: { image: 'old-image', mounts, metadata: { hypervibe_managed: 'true' } },
    };
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (init.method === 'POST') {
        expect(path).toBe('/v1/apps/hv-web-app/machines/machine-1');
        const body = JSON.parse(String(init.body));
        expect(body.config.mounts).toEqual(mounts);
        expect(body.current_version).toBe('version-1');
        machine = { ...machine, instance_id: 'version-2', config: body.config };
        if (dropMount) machine.config.mounts = [];
        return Response.json(machine);
      }
      if (path.endsWith('/machines')) return Response.json([machine]);
      if (path.endsWith('/machines/machine-1')) return Response.json(machine);
      if (path.endsWith('/hv-web-app')) return Response.json({ id: 'fly-app-1', name: 'hv-web-app', organization: { slug: 'hypervibe-test' } });
      throw new Error(`Unexpected provider operation ${path}`);
    });
    const env = {
      FLY_API_TOKEN: 'test-token', FLY_ORGANIZATION_SLUG: 'hypervibe-test',
      FLY_SERVICE_BINDINGS_JSON: JSON.stringify(deployTarget.providerServiceIds),
      FLY_REGISTRY_APP: 'hv-web-app', FLY_IMAGE_URI: image, DEPLOY_SHA: sha,
      GITHUB_REPOSITORY: 'example/project', HYPERVIBE_REPOSITORY: 'example/project',
      HYPERVIBE_ENVIRONMENT: 'production', HYPERVIBE_PROGRAM_FINGERPRINT: 'fingerprint',
      CI_REGISTRY: 'registry.example', CI_REGISTRY_USER: 'user', CI_REGISTRY_PASSWORD: 'test-password',
    };
    const source = kind === 'portable'
      ? buildFlyPortableRecipe(deployTarget).runtime.content.replace(/^import .*;\n/gm, '')
      : (parse(buildFlyGitHubActionsSteps(deployTarget).steps) as Array<{ name?: string; with?: { script?: string } }>)
          .find((step) => step.name === 'Deploy immutable digest to existing Fly.io Machines')!.with!.script!;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction('process', 'fetch', 'Buffer', 'AbortSignal', 'readFile', 'writeFile', 'execFileSync', 'core', source);
    const execution = run({ env }, fetchMock, Buffer, AbortSignal,
      async (path: string) => path === '.hypervibe-deploy-sha' ? sha : 'registry.example/image:tag',
      vi.fn(), (_path: string, args: string[]) => args[0] === 'image' ? JSON.stringify([image]) : '',
      { info: vi.fn(), setOutput: vi.fn() });
    if (dropMount) {
      await expect(execution).rejects.toThrow(/mount|filesystem/i);
      return;
    }
    await execution;
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(machine.config.mounts).toEqual(mounts);
    expect(machine.config.image).toBe(image);
  });

  it('updates only existing exact App and Machine identities to an immutable digest', () => {
    const result = buildFlyGitHubActionsSteps(target());

    expect(result.requiredSecrets).toEqual(['FLY_API_TOKEN']);
    expect(result.requiredVariables).toEqual([]);
    expect(result.releaseImageUri).toContain(
      "steps.rollback_evidence.outputs.image_uri || steps.promotion_release.outputs.image_uri"
    );
    expect(result.releaseImageUri).toContain('steps.release_image.outputs.image_uri');
    expect(result.steps).toContain("core.setOutput('image_uri', 'registry.fly.io/' + app + '@' + digest)");
    expect(result.steps).toContain('docker/build-push-action@v6');
    expect(result.steps).toContain('registry.fly.io/hv-web-app:${{ steps.deploy.outputs.sha }}');
    expect(result.steps).toContain('current_version: machine.instance_id');
    expect(result.steps).toContain("const image = (process.env.FLY_IMAGE_URI || '').trim().toLowerCase()");
    expect(result.steps).toContain('machines.length !== 1 || exact.length !== 1');
    expect(result.steps).toContain('hypervibe_git_sha: sha');
    expect(result.steps).toContain("observedDigest !== digest");
    expect(result.steps).not.toContain("'POST',\n                '/v1/apps',");
    expect(result.reviewDetails?.join(' ')).toContain('CI never creates infrastructure');
  });

  it('rejects service bindings outside the reviewed organization', () => {
    const invalid = target();
    invalid.providerServiceIds = [formatFlyServiceBinding({
      organizationSlug: 'other-org',
      appId: 'fly-app-2',
      appName: 'other-app',
      machineId: 'machine-2',
    })];

    expect(() => buildFlyGitHubActionsSteps(invalid)).toThrow(
      /does not belong to the target organization/i
    );
  });

  it('rejects an App binding without the reviewed Machine identity', () => {
    const invalid = target();
    invalid.providerServiceIds = [formatFlyServiceBinding({
      organizationSlug: 'hypervibe-test',
      appId: 'fly-app-1',
      appName: 'hv-web-app',
    })];

    expect(() => buildFlyGitHubActionsSteps(invalid)).toThrow(
      /missing a reviewed Machine identity/i
    );
  });

  it('builds the same exact-identity deployment contract for portable CI runners', () => {
    const recipe = buildFlyPortableRecipe(target());

    expect(recipe).toMatchObject({
      version: 1,
      provider: 'fly',
      kind: 'container',
      runnerCapabilities: ['linux-amd64', 'docker-privileged'],
      runtime: { path: '.gitlab/hypervibe/fly-deploy.mjs' },
    });
    expect(recipe.values).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'FLY_API_TOKEN',
        source: { kind: 'connection', provider: 'fly', credentialKey: 'apiToken' },
        secret: true,
      }),
      expect.objectContaining({
        name: 'FLY_ORGANIZATION_SLUG',
        source: { kind: 'literal', value: 'hypervibe-test' },
      }),
      expect.objectContaining({
        name: 'FLY_REGISTRY_APP',
        source: { kind: 'literal', value: 'hv-web-app' },
      }),
    ]));
    expect(recipe.runtime.content).toContain("current_version: machine.instance_id");
    expect(recipe.runtime.content).toContain("const image = prefix + digest");
    expect(recipe.runtime.content).toContain('machines.length !== 1 || exact.length !== 1');
    expect(recipe.runtime.content).toContain("provider: 'fly'");
    expect(recipe.runtime.content).not.toContain("fly('POST', '/v1/apps'");
  });

  it('registers hosting and derived Managed Postgres capabilities from one connection', () => {
    const metadata = providerRegistry.getMetadata('fly');
    expect(metadata).toMatchObject({
      displayName: 'Fly.io',
      category: 'deployment',
      lifecycle: {
        hosting: {
          workloadKinds: ['web', 'worker'],
          customDomains: 'managed',
          maintenance: 'unsupported',
          teardownBoundary: 'services',
        },
        databaseEngines: ['postgres'],
      },
      orchestration: {
        ci: {
          requiredSecrets: ['FLY_API_TOKEN'],
          buildPortableRecipe: expect.any(Function),
        },
      },
    });
    expect(providerRegistry.supports('fly', 'hosting')).toBe(true);
    expect(providerRegistry.supportsEngine('fly', 'database', 'postgres')).toBe(true);
  });
});
