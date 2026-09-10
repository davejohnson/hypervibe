import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BranchDeployTarget, PortableCiDeployRecipe } from '../../../../domain/ports/ci-deploy.port.js';
import { buildEcsExpressPortableRecipe } from '../../aws/ecs-express-ci.recipe.js';
import { buildAzureContainerAppsPortableRecipe } from '../../azure/azure-container-apps-ci.recipe.js';
import { buildDigitalOceanPortableRecipe } from '../../digitalocean/digitalocean-ci.recipe.js';
import { buildCloudRunPortableRecipe } from '../../gcp/cloudrun-ci.recipe.js';
import {
  cloudRunMigrationJobName,
  cloudRunReleaseCommandHash,
} from '../../gcp/cloudrun-release-command.js';
import { buildRailwayPortableRecipe } from '../../railway/railway-ci.recipe.js';
import { buildVercelPortableRecipe } from '../../vercel/vercel-ci.recipe.js';

function target(overrides: Partial<BranchDeployTarget> = {}): BranchDeployTarget {
  return {
    environmentName: 'production',
    kind: 'production',
    branch: 'main',
    autoDeployOnPush: false,
    serviceNames: ['web'],
    providerServiceIds: ['service-1'],
    providerJobNames: [],
    runtime: { kind: 'node', version: '22' },
    ...overrides,
  };
}

function expectSafeRecipe(recipe: PortableCiDeployRecipe): void {
  expect(recipe.version).toBe(1);
  expect(recipe.runtime.path).toMatch(/^\.gitlab\/hypervibe\//);
  expect(new Set(recipe.values.map((value) => value.name)).size).toBe(recipe.values.length);
  expect(recipe.values.every((value) => /^[A-Z][A-Z0-9_]+$/.test(value.name))).toBe(true);
  const checked = spawnSync(process.execPath, ['--input-type=module', '--check', '-'], {
    input: recipe.runtime.content,
    encoding: 'utf8',
  });
  expect(checked.status, checked.stderr).toBe(0);
  expect(recipe.runtime.content).not.toContain('gh ');
  expect(recipe.runtime.content).not.toContain('gcloud ');
  expect(recipe.runtime.content).not.toContain('az ');
  expect(recipe.runtime.content).not.toContain('doctl ');
  expect(recipe.runtime.content).not.toContain('railway ');
}

describe('provider-neutral GitLab deploy recipes', () => {
  it('renders provider-owned runtimes for every non-native hosting adapter', () => {
    const recipes = [
      buildRailwayPortableRecipe(target({ providerEnvironmentId: 'env-1' })),
      buildCloudRunPortableRecipe(target({ providerProjectId: 'logical-prefix', providerScope: { projectId: 'gcp-project', region: 'us-central1' }, providerRegion: 'us-central1', providerServiceIds: ['web-service'] })),
      buildEcsExpressPortableRecipe(target({
        providerProjectId: 'arn:aws:ecs:us-east-1:123456789012:cluster/hv-prod',
        providerServiceIds: ['arn:aws:ecs:us-east-1:123456789012:service/hv-prod/web'],
      })),
      buildAzureContainerAppsPortableRecipe(target({
        providerProjectId: '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hv-prod',
        providerServiceIds: ['/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hv-prod/providers/Microsoft.App/containerApps/web'],
      })),
      buildDigitalOceanPortableRecipe(target({
        providerProjectId: 'app-1',
        providerServiceIds: ['app-1:services:web'],
        providerImageUris: ['registry.digitalocean.com/hypervibe-account/acme/storefront:pending'],
      })),
      buildVercelPortableRecipe(target({
        providerProjectId: 'team:team_123',
        providerServiceIds: ['team:team_123:prj_123'],
      })),
    ];
    expect(recipes.map((recipe) => recipe.provider)).toEqual([
      'railway',
      'cloudrun',
      'ecs',
      'azure-container-apps',
      'digitalocean',
      'vercel',
    ]);
    for (const recipe of recipes) expectSafeRecipe(recipe);
    expect(recipes[2]!.runtime.content).toContain('networkConfiguration: config.networkConfiguration');
    expect(recipes[2]!.runtime.content).toContain('workload-network configuration is missing or malformed');
  });

  it('keeps cloud service-account JSON encoded across the GitLab variable boundary', () => {
    const runtimeResources = [
      {
        logicalName: 'web', workloadKind: 'web' as const, providerResourceType: 'service' as const,
        providerResourceId: 'web-service', startCommand: 'npm run web', healthCheckPath: '/healthz',
      },
      {
        logicalName: 'worker', workloadKind: 'worker' as const, providerResourceType: 'service' as const,
        providerResourceId: 'worker-service', startCommand: 'npm run worker', healthCheckPath: '/ready',
      },
    ];
    const recipe = buildCloudRunPortableRecipe(target({
      providerProjectId: 'logical-production-prefix',
      providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      providerRegion: 'us-central1',
      serviceNames: ['web', 'worker'],
      providerServiceIds: ['web-service', 'worker-service'],
      runtimeResources,
      releaseCommands: [{
        serviceName: 'web',
        providerServiceId: 'web-service',
        jobName: cloudRunMigrationJobName('web-service'),
        command: 'npm run db:migrate',
      }],
    }));
    expect(recipe.values).toContainEqual(expect.objectContaining({
      name: 'GCP_SERVICE_ACCOUNT_JSON_B64',
      secret: true,
      transform: 'base64',
    }));
    expect(recipe.values).toContainEqual(expect.objectContaining({
      name: 'GCP_BOUND_PROJECT_ID',
      source: { kind: 'literal', value: 'gcp-project' },
    }));
    expect(recipe.values).toContainEqual(expect.objectContaining({
      name: 'GCP_ARTIFACT_REPOSITORY',
      source: { kind: 'literal', value: 'hypervibe' },
    }));
    expect(recipe.values).toContainEqual(expect.objectContaining({
      name: 'CLOUDRUN_RELEASE_COMMANDS_B64',
      source: { kind: 'literal', value: Buffer.from(JSON.stringify([
        {
          serviceName: 'web',
          providerServiceId: 'web-service',
          jobName: cloudRunMigrationJobName('web-service'),
          command: 'npm run db:migrate',
          commandHash: cloudRunReleaseCommandHash('npm run db:migrate'),
        },
      ])).toString('base64') },
    }));
    expect(recipe.values).toContainEqual(expect.objectContaining({
      name: 'CLOUDRUN_RUNTIME_RESOURCES_B64',
      source: { kind: 'literal', value: Buffer.from(JSON.stringify(runtimeResources)).toString('base64') },
    }));
    expect(recipe.containerBuildStartCommand).toMatch(/Hypervibe applies the runtime command/);
    expect(recipe.runtime.content).toContain('await runCloudRunReleaseCommands({');
    expect(recipe.runtime.content).toContain('cloudRunContainerWithRuntime');

    const explicitlyBoundLegacyRepository = buildCloudRunPortableRecipe(target({
      providerProjectId: 'logical-production-prefix',
      providerScope: {
        projectId: 'gcp-project',
        region: 'us-central1',
        artifactRepository: 'infraprint',
      },
      providerRegion: 'us-central1',
      providerServiceIds: ['web-service'],
    }));
    expect(explicitlyBoundLegacyRepository.values).toContainEqual(expect.objectContaining({
      name: 'GCP_ARTIFACT_REPOSITORY',
      source: { kind: 'literal', value: 'infraprint' },
    }));
    expect(recipe.runtime.content.indexOf('await runCloudRunReleaseCommands({')).toBeLessThan(
      recipe.runtime.content.indexOf('for (const name of services)')
    );
  });

  it('deploys digest-pinned images where the hosting API supports exact digests', () => {
    const cloudRun = buildCloudRunPortableRecipe(target({ providerProjectId: 'logical-prefix', providerScope: { projectId: 'gcp-project', region: 'us-central1' }, providerRegion: 'us-central1', providerServiceIds: ['web-service'] }));
    const azure = buildAzureContainerAppsPortableRecipe(target({
      providerProjectId: '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hv-prod',
      providerServiceIds: ['/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/hv-prod/providers/Microsoft.App/containerApps/web'],
    }));
    for (const recipe of [cloudRun, azure]) {
      expect(recipe.runtime.content).toContain("'@' + digest");
      expect(recipe.runtime.content).toContain('sha256:[0-9a-f]{64}');
    }
    expect(cloudRun.releaseEvidence).toEqual({
      providerResources: ['service:web-service'],
      requiresImmutableImage: true,
    });
  });

  it('restores Cloud Run from the exact recorded GitLab artifact digest without copying an image', () => {
    const cloudRun = buildCloudRunPortableRecipe(target({
      providerProjectId: 'logical-prefix',
      providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      providerRegion: 'us-central1',
      providerServiceIds: ['web-service'],
    }));

    expect(cloudRun.runtime.content).toContain("'/jobs/' + encodeURIComponent(sourceJobId) + '/artifacts/.hypervibe-release.json'");
    expect(cloudRun.runtime.content).toContain("if (rollback) {");
    expect(cloudRun.runtime.content).toContain("evidence?.imageUri");
    expect(cloudRun.runtime.content).toContain("evidence.providerIdentity");
    expect(cloudRun.runtime.content).toContain("evidence.providerResources");
    expect(cloudRun.runtime.content.indexOf('if (rollback) {')).toBeLessThan(
      cloudRun.runtime.content.indexOf("execFileSync(docker, ['pull', sourceImage]")
    );
  });

  it('executes a Cloud Run rollback with only the recorded digest and no build artifacts', () => {
    const runtime = buildCloudRunPortableRecipe(target({
      providerProjectId: 'logical-prefix',
      providerScope: { projectId: 'gcp-project', region: 'us-central1' },
      providerRegion: 'us-central1',
      providerServiceIds: ['web-service'],
    })).runtime.content;
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-cloudrun-gitlab-rollback-'));
    const exactImage = `us-central1-docker.pkg.dev/gcp-project/infraprint/acme/storefront@sha256:${'e'.repeat(64)}`;
    const providerIdentity = {
      projectId: 'logical-prefix',
      scope: { projectId: 'gcp-project', region: 'us-central1' },
      region: 'us-central1',
    };
    const releaseEvidence = {
      version: 2,
      provider: 'cloudrun',
      repository: 'https://gitlab.com/acme/storefront',
      environment: 'production',
      sha: 'a'.repeat(40),
      programFingerprint: 'b'.repeat(64),
      deploymentContractFingerprint: 'c'.repeat(64),
      services: ['web'],
      providerIdentity,
      providerResources: ['service:web-service'],
      imageUri: exactImage,
      ci: { projectId: '42', pipelineId: '19', jobId: '190' },
      deployments: [{
        kind: 'service',
        name: 'web-service',
        imageUri: exactImage,
        imageDigest: `sha256:${'e'.repeat(64)}`,
      }],
    };
    const setup = `import { writeFileSync } from 'node:fs';
let patched = false;
const exactImage = ${JSON.stringify(exactImage)};
const evidence = ${JSON.stringify(releaseEvidence)};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'access-token' });
  if (url.includes('artifactregistry.googleapis.com')) return json({ name: 'projects/gcp-project/locations/us-central1/repositories/infraprint', format: 'DOCKER' });
  if (url.includes('/jobs/190/artifacts/.hypervibe-release.json')) return json(evidence);
  if (url.endsWith('/services/web-service') && (init.method || 'GET') === 'GET') return json({ name: 'projects/gcp-project/locations/us-central1/services/web-service', uri: 'https://web.example.test', terminalCondition: { state: 'CONDITION_SUCCEEDED' }, reconciling: false, template: { containers: [{ image: patched ? exactImage : 'old-image' }] } });
  if (url.includes('/services/web-service?updateMask=') && init.method === 'PATCH') { patched = true; return json({ name: 'projects/gcp-project/locations/us-central1/operations/update', done: true }); }
  throw new Error('Unexpected request: ' + (init.method || 'GET') + ' ' + url);
};
process.on('exit', () => writeFileSync('patched.txt', String(patched)));
`;
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(path.join(directory, 'runtime.mjs'), runtime);
    writeFileSync(path.join(directory, 'setup.mjs'), setup);
    writeFileSync(path.join(directory, '.hypervibe-deploy-sha'), `${'a'.repeat(40)}\n`);
    try {
      const result = spawnSync(process.execPath, ['--import', './setup.mjs', './runtime.mjs'], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          GCP_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON.stringify({
            client_email: 'hypervibe-deploy@gcp-project.iam.gserviceaccount.com',
            private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
          })).toString('base64'),
          GCP_PROJECT_ID: 'gcp-project',
          GCP_BOUND_PROJECT_ID: 'gcp-project',
          GCP_REGION: 'us-central1',
          GCP_ARTIFACT_REPOSITORY: 'infraprint',
          CLOUDRUN_SERVICE_NAMES: 'web-service',
          CLOUDRUN_JOB_NAMES: '',
          CLOUDRUN_RELEASE_COMMANDS_B64: Buffer.from('[]').toString('base64'),
          CLOUDRUN_RUNTIME_RESOURCES_B64: Buffer.from(JSON.stringify([{
            logicalName: 'web',
            workloadKind: 'web',
            providerResourceType: 'service',
            providerResourceId: 'web-service',
            startCommand: null,
            healthCheckPath: null,
          }])).toString('base64'),
          HYPERVIBE_REPOSITORY: 'https://gitlab.com/acme/storefront',
          HYPERVIBE_ENVIRONMENT: 'production',
          HYPERVIBE_PROGRAM_FINGERPRINT: 'b'.repeat(64),
          HYPERVIBE_DEPLOYMENT_CONTRACT_FINGERPRINT: 'c'.repeat(64),
          HYPERVIBE_RELEASE_SERVICES: JSON.stringify(['web']),
          HYPERVIBE_RELEASE_PROVIDER_IDENTITY: JSON.stringify(providerIdentity),
          HYPERVIBE_RELEASE_PROVIDER_RESOURCES: JSON.stringify(['service:web-service']),
          HYPERVIBE_ROLLBACK: 'true',
          HYPERVIBE_SOURCE_ARTIFACT_ID: '190:.hypervibe-release.json',
          HYPERVIBE_SOURCE_PIPELINE_ID: '19',
          CI_API_V4_URL: 'https://gitlab.example.com/api/v4',
          CI_PROJECT_ID: '42',
          CI_JOB_TOKEN: 'job-token',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(directory, 'patched.txt'), 'utf8')).toBe('true');
      expect(JSON.parse(readFileSync(path.join(directory, '.hypervibe-release.json'), 'utf8'))).toMatchObject({
        imageUri: exactImage,
        deployments: [{ name: 'web-service', imageUri: exactImage }],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to guess a missing Cloud Run region from another binding', () => {
    expect(() => buildCloudRunPortableRecipe(target({
      providerProjectId: 'gcp-project',
      providerScope: { projectId: 'gcp-project' },
      providerEnvironmentId: 'not-a-region',
      providerServiceIds: ['web-service'],
    }))).toThrow('bindings for production are incomplete');
  });

  it('refuses to choose a DigitalOcean registry that is absent from hosting bindings', () => {
    expect(() => buildDigitalOceanPortableRecipe(target({
      providerProjectId: 'app-1',
      providerServiceIds: ['app-1:services:web'],
    }))).toThrow('exact DOCR registry');
  });
});
