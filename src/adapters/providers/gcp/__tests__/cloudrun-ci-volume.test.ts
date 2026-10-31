import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { buildCloudRunGitHubActionsSteps } from '../cloudrun-ci.workflow.js';
import { buildCloudRunPortableRuntime } from '../cloudrun-ci.recipe.js';
import { buildCloudRunReleaseRuntime } from '../cloudrun-ci.release-runtime.js';
import { extractGitHubScript } from '../../../../domain/services/__tests__/managed-ci-workflow.test-utils.js';

// Executes both emitted programs through their actual JSON HTTP boundary.
// Independent contract: Cloud Run v2 Service UID is stable until deletion;
// etag detects update conflicts; RevisionTemplate owns volumes and VPC identity.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const project = 'test-project'; const region = 'us-central1'; const name = 'web';
const resourceName = `projects/${project}/locations/${region}/services/${name}`;
const image = `${region}-docker.pkg.dev/${project}/hypervibe/owner/app@sha256:${'b'.repeat(64)}`;
const credentials = { client_email: 'ci@example.test', private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

it('preserves deployed legacy CI bytes when service instance bounds are omitted', () => {
  // Captured from the exact fetched main 3bfe9b98d5d262741de01ef4d6cb8e0c5a0703a1
  // source archive, independently of this merge. Main intentionally added
  // credential rollout outputs (renderer revision 2); optional capacity alone
  // must not cause any additional provider/template regeneration.
  const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
  const target = { environmentName: 'staging', kind: 'staging' as const, branch: 'main', autoDeployOnPush: true,
    serviceNames: ['web'], providerServiceIds: ['web'], providerScope: { projectId: 'legacy-project', region: 'us-central1' }, providerRegion: 'us-central1' };
  expect(sha(JSON.stringify(buildCloudRunGitHubActionsSteps(target)))).toBe('7b6b96ab1b1312a06bf2e597e7666ce3fc956d17808b5ecb767a3b87b5dc1973');
  expect(sha(buildCloudRunPortableRuntime())).toBe('275ef86ff71e47d43fdc36ac06fb8eba5c3f7f186d2ca793d7446e37246d1a56');
  expect(sha(buildCloudRunReleaseRuntime())).toBe('3e0729e6d5f0034943d7f3bbfe509352d4fc333f1e7b397d7d185e359dff7ab7');
});

function fixture(kind: 'github' | 'portable', fault?: string, rollback = false, noVolumes = false, bounds = false) {
  const original: any = { name: resourceName, uid: 'stable-uid', etag: 'version-1', generation: '1', observedGeneration: '1', terminalCondition: { state: 'CONDITION_SUCCEEDED' }, template: {
    containers: [{ name: 'web', image: 'old-image', volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
    volumes: [{ name: 'data', nfs: { server: '10.0.0.2', path: '/data', readOnly: false } }],
    serviceAccount: 'runtime@test-project.iam.gserviceaccount.com', executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
    vpcAccess: { networkInterfaces: [{ network: 'private', subnetwork: 'private-subnet' }], egress: 'PRIVATE_RANGES_ONLY' },
  } };
  if (noVolumes) { delete original.template.volumes; delete original.template.containers[0].volumeMounts; delete original.template.vpcAccess; }
  if (fault === 'missing-etag') delete original.etag;
  if (bounds) original.scaling = { maxInstanceCount: fault === 'bounds-before' ? 5 : 1 };
  let observed = structuredClone(original);
  const patches: any[] = [];
  const identity = { scope: { projectId: project, region }, region };
  const env: Record<string, string> = {
    GCP_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials), GCP_SERVICE_ACCOUNT_JSON_B64: encoded(credentials), GCP_PROJECT_ID: project, GCP_BOUND_PROJECT_ID: project, GCP_REGION: region, GCP_ARTIFACT_REPOSITORY: 'hypervibe',
    CLOUDRUN_SERVICE_NAMES: name, CLOUDRUN_JOB_NAMES: '', CLOUDRUN_RELEASE_COMMANDS_B64: encoded([]), CLOUDRUN_RUNTIME_RESOURCES_B64: encoded([{ logicalName: 'web', workloadKind: 'web', providerResourceType: 'service', providerResourceId: name, startCommand: null, healthCheckPath: null }]),
    IMAGE_URI: image, DEPLOY_OPERATION: rollback ? 'rollback' : 'deploy', HYPERVIBE_ROLLBACK: String(rollback),
    HYPERVIBE_REPOSITORY: 'owner/app', HYPERVIBE_ENVIRONMENT: 'staging', HYPERVIBE_PROGRAM_FINGERPRINT: 'program', HYPERVIBE_DEPLOYMENT_CONTRACT_FINGERPRINT: 'contract', HYPERVIBE_RELEASE_SERVICES: JSON.stringify(['web']), HYPERVIBE_RELEASE_PROVIDER_IDENTITY: JSON.stringify(identity), HYPERVIBE_RELEASE_PROVIDER_RESOURCES: JSON.stringify(['service:web']),
    CI_REGISTRY: 'gitlab.example.test', CI_REGISTRY_USER: 'ci', CI_REGISTRY_PASSWORD: 'synthetic', CI_PROJECT_PATH: 'owner/app', CI_API_V4_URL: 'https://gitlab.example.test/api/v4', CI_PROJECT_ID: '1', CI_JOB_TOKEN: 'synthetic', HYPERVIBE_SOURCE_ARTIFACT_ID: '3:.hypervibe-release.json', HYPERVIBE_SOURCE_PIPELINE_ID: '2',
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic' });
    if (url.startsWith('https://artifactregistry.googleapis.com/')) return Response.json({ name: `projects/${project}/locations/${region}/repositories/hypervibe`, format: 'DOCKER' });
    if (url.startsWith('https://gitlab.example.test/')) return Response.json({ version: 2, provider: 'cloudrun', repository: 'owner/app', environment: 'staging', sha: 'a'.repeat(40), programFingerprint: 'program', deploymentContractFingerprint: 'contract', services: ['web'], providerIdentity: identity, providerResources: ['service:web'], imageUri: image, deployments: [{ kind: 'service', name, imageUri: image, imageDigest: image.split('@')[1] }], ci: { projectId: '1', pipelineId: '2', jobId: '3' } });
    if (url.startsWith('https://run.googleapis.com/v2/' + resourceName)) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)); patches.push(body);
        observed = { ...structuredClone(original), template: body.template };
        if (fault === 'mount') observed.template.containers[0].volumeMounts = [];
        if (fault === 'volume') observed.template.volumes = [];
        if (fault === 'vpc') delete observed.template.vpcAccess;
        if (fault === 'principal') observed.template.serviceAccount = 'another@example.test';
        if (fault === 'uid') observed.uid = 'replacement-uid';
        if (fault === 'bounds-after') observed.scaling = { maxInstanceCount: 5 };
        return Response.json({ name: `projects/${project}/locations/${region}/operations/update`, done: true });
      }
      return Response.json(observed);
    }
    throw new Error('Unexpected HTTP request ' + url);
  };
  const runtimeResources = [{ logicalName: 'web', workloadKind: 'web' as const, providerResourceType: 'service' as const,
    providerResourceId: name, startCommand: null, healthCheckPath: null, ...(bounds ? { instanceBounds: { min: 0, max: 1 } } : {}) }];
  env.CLOUDRUN_RUNTIME_RESOURCES_B64 = encoded(runtimeResources);
  const script = kind === 'portable' ? buildCloudRunPortableRuntime({ instanceBounds: bounds }).replace(/^import .*;\n/gm, '') : extractGitHubScript('jobs:\n  deploy:\n    steps:\n' + buildCloudRunGitHubActionsSteps({ environmentName: 'staging', kind: 'staging', branch: 'main', autoDeployOnPush: true, serviceNames: ['web'], providerServiceIds: ['web'], providerScope: { projectId: project, region }, providerRegion: region, runtimeResources }).steps, 'Deploy image to Cloud Run');
  const run = () => new AsyncFunction('require', 'process', 'fetch', 'Buffer', 'core', 'createSign', 'execFileSync', 'readFile', 'writeFile', script)(() => crypto, { env, stdout: { write: vi.fn() } }, fetchImpl, Buffer, { info: vi.fn(), setOutput: vi.fn() }, crypto.createSign, (_file: string, args: string[]) => args[0] === 'push' ? 'digest: sha256:' + 'b'.repeat(64) : '', async (file: string) => file === '.hypervibe-deploy-sha' ? 'a'.repeat(40) : 'registry.example.test/source:tag', vi.fn());
  return { run, patches, original };
}

describe.each(['github', 'portable'] as const)('%s Cloud Run filesystem release', (kind) => {
  it('releases with reviewed service bounds, preserving their separately applied configuration', async () => {
    const f = fixture(kind, undefined, false, true, true);
    await f.run();
    expect(f.patches).toHaveLength(1);
    expect(f.patches[0]).not.toHaveProperty('scaling');
  });
  it.each(['bounds-before', 'bounds-after'])('rejects changed instance limits at %s', async fault => {
    const f = fixture(kind, fault, false, true, true);
    await expect(f.run()).rejects.toThrow(/instance bounds/);
    expect(f.patches).toHaveLength(fault === 'bounds-before' ? 0 : 1);
  });
  it('rejects a changed runtime principal even when the workload has no filesystem mounts', async () => {
    const f = fixture(kind, 'principal', false, true);
    await expect(f.run()).rejects.toThrow(/runtime|principal|identity/i); expect(f.patches).toHaveLength(1);
  });
  it.each([false, true])('preserves existing storage and uses optimistic concurrency (rollback=%s)', async (rollback) => {
    const f = fixture(kind, undefined, rollback); await f.run();
    expect(f.patches).toHaveLength(1);
    expect(f.patches[0].etag).toBe('version-1');
    expect(f.patches[0].template).toMatchObject({ volumes: f.original.template.volumes, vpcAccess: f.original.template.vpcAccess, serviceAccount: f.original.template.serviceAccount, containers: [{ image, volumeMounts: f.original.template.containers[0].volumeMounts }] });
  });
  it.each(['mount', 'volume', 'vpc', 'principal', 'uid'])('rejects ready candidate with lost %s', async (fault) => {
    const f = fixture(kind, fault); await expect(f.run()).rejects.toThrow(/filesystem|identity/i);
    expect(f.patches).toHaveLength(1);
  });
  it('blocks before patch if filesystem concurrency identity is unobservable', async () => {
    const f = fixture(kind, 'missing-etag'); await expect(f.run()).rejects.toThrow(/identity|etag/i); expect(f.patches).toHaveLength(0);
  });
});
