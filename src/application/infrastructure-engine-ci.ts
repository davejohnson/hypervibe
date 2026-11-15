import fs from 'fs';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import path from 'path';

/**
 * Keyless CI releases for OpenTofu-managed Cloud Run environments.
 *
 * GitHub Actions proves its repository to Google with OIDC (Workload Identity
 * Federation), so no service-account key is ever copied into GitHub. It acts
 * as a dedicated release identity that can push images and update Cloud Run
 * services, nothing else: no engine state, no secrets, no IAM. The workflow
 * changes only the running image, guarded by the service etag, exactly like
 * hv_deploy, so a release and an infrastructure apply can never overwrite
 * each other.
 */
import { buildCiReleaseConfiguration, CI_RELEASE_PROJECT_ROLES, ciReleaseIdentity, ciWorkloadIdentityProvider } from '../adapters/providers/gcp/tofu/gcp-ci.backend.js';
import { runGcpProjectSetup } from '../domain/services/gcp-project-setup.service.js';
export { CI_RELEASE_ACCOUNT_ID, CI_POOL_ID, CI_PROVIDER_ID, CI_RELEASE_PROJECT_ROLES, ciReleaseIdentity, ciWorkloadIdentityProvider } from '../adapters/providers/gcp/tofu/gcp-ci.backend.js';

export interface CiReleaseAccessPreview {
  releaseIdentity: string;
  repository: string;
  grants: string[];
}

export function previewCiReleaseAccess(gcpProjectId: string, repository: string, runtimeServiceAccountEmail: string): CiReleaseAccessPreview {
  return {
    releaseIdentity: ciReleaseIdentity(gcpProjectId),
    repository,
    grants: [
      `GitHub Actions in ${repository} (and only that repository) may act as ${ciReleaseIdentity(gcpProjectId)}, with no stored key`,
      ...CI_RELEASE_PROJECT_ROLES.map((role) => `${ciReleaseIdentity(gcpProjectId)}: ${role}`),
      `${ciReleaseIdentity(gcpProjectId)} may deploy revisions that run as ${runtimeServiceAccountEmail}`,
    ],
  };
}

/** Plans or applies the exact reviewed CI identity configuration through OpenTofu. */
export async function grantCiReleaseAccess(params: {
  projectId: string;
  adminToken: string;
  gcpProjectId: string;
  repository: string;
  runtimeServiceAccountEmail: string;
  confirm?: boolean;
}) {
  const response = await fetchWithRetry(`https://cloudresourcemanager.googleapis.com/v3/projects/${params.gcpProjectId}`, {
    headers: { Authorization: `Bearer ${params.adminToken}` },
  });
  if (!response.ok) throw new Error(`Could not read the GCP project (HTTP ${response.status}).`);
  const body = await response.json() as { name?: string; projectId?: string; state?: string };
  if (!/^projects\/[0-9]+$/.test(body.name ?? '') || body.projectId !== params.gcpProjectId || body.state !== 'ACTIVE') {
    throw new Error('The CI setup project identity could not be verified.');
  }
  const projectNumber = body.name!.slice('projects/'.length);
  const configuration = buildCiReleaseConfiguration({ ...params, projectId: params.gcpProjectId, projectNumber });
  const result = await runGcpProjectSetup({
    projectId: params.projectId, gcpProjectId: params.gcpProjectId,
    auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: params.adminToken }, redact: [params.adminToken] },
    contribution: { id: 'ci-release', configuration }, confirm: params.confirm,
  });
  if (!result.success) throw new Error(result.error ?? 'CI infrastructure setup did not complete.');
  return { ...result, projectNumber, provider: ciWorkloadIdentityProvider(projectNumber), releaseIdentity: ciReleaseIdentity(params.gcpProjectId) };
}

export interface ReleaseWorkflowInput {
  environmentName: string;
  branch: string;
  gcpProjectId: string;
  region: string;
  provider: string;
  releaseIdentity: string;
  /** generatedDockerfile is used only when the repository has no Dockerfile of its own; it carries that service's start command. */
  services: Array<{ name: string; resource: string; healthPath?: string; image: string; kind?: 'services' | 'jobs' | 'workerPools'; generatedDockerfile?: string }>;
}

const RELEASE_SCRIPT = String.raw`
const [resource, image, healthPath, kind = 'services'] = process.argv.slice(2);
const token = process.env.GCP_TOKEN;
const base = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT + '/locations/' + process.env.GCP_REGION + '/' + kind + '/' + resource;
const call = async (url, init = {}) => fetch(url, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
const isJob = kind === 'jobs';
const current = await (await call(base)).json();
const containers = ((isJob ? current.template?.template?.containers : current.template?.containers) ?? []).map((c) => ({ ...c }));
if (containers.length !== 1) throw new Error('Workload must have exactly one container.');
containers[0].image = image;
// Only the image changes; the etag makes a concurrent infrastructure change fail this release instead of being overwritten.
// Jobs take the whole resource back; services accept a mask limited to the containers.
const body = isJob ? { ...current, template: { ...current.template, template: { ...current.template.template, containers } } } : { etag: current.etag, template: { containers } };
const patch = await call(isJob ? base : base + '?updateMask=template.containers', { method: 'PATCH', body: JSON.stringify(body) });
if (patch.status === 409 || patch.status === 412) throw new Error('The workload changed while releasing. Nothing was overwritten; re-run this workflow.');
if (!patch.ok) throw new Error('Cloud Run rejected the release (HTTP ' + patch.status + '): ' + ((await patch.json().catch(() => ({}))).error?.message ?? 'no details'));
let operation = await patch.json();
for (let i = 0; i < 200 && !operation.done; i++) { await new Promise((r) => setTimeout(r, 3000)); operation = await (await call('https://run.googleapis.com/v2/' + operation.name)).json(); }
if (!operation.done || operation.error) throw new Error('Rollout failed: ' + (operation.error?.message ?? 'did not finish'));
const after = await (await call(base)).json();
const running = isJob ? after.template?.template?.containers?.[0]?.image : after.template?.containers?.[0]?.image;
if (running !== image || (!isJob && after.latestReadyRevision !== after.latestCreatedRevision)) throw new Error('The new image is not active.');
if (!isJob && healthPath) {
  const response = await fetch(new URL(healthPath, after.uri));
  if (response.status >= 500) throw new Error(healthPath + ' returned HTTP ' + response.status);
  console.log('Health ' + healthPath + ': HTTP ' + response.status);
}
console.log('Released ' + image + ' to ' + resource + (isJob ? ' (next scheduled run)' : after.uri ? ' at ' + after.uri : ''));
`.trim();

/** A GitHub Actions workflow with no stored credentials; every value is non-secret. */
export function renderReleaseWorkflow(input: ReleaseWorkflowInput): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(input.branch)) throw new Error('Branch name is not supported in a workflow trigger.');
  const lines: string[] = [
    `# Managed by Hypervibe. Releases ${input.environmentName} on every push to ${input.branch}.`,
    '# Authenticates without stored keys (Workload Identity Federation) and changes only the running image.',
    `name: Hypervibe release (${input.environmentName})`,
    'on:',
    '  push:',
    `    branches: [${JSON.stringify(input.branch)}]`,
    '  workflow_dispatch: {}',
    'permissions:',
    '  contents: read',
    '  id-token: write',
    'concurrency:',
    `  group: hypervibe-release-${input.environmentName}`,
    '  cancel-in-progress: false',
    'env:',
    `  GCP_PROJECT: ${input.gcpProjectId}`,
    `  GCP_REGION: ${input.region}`,
    'jobs:',
    '  release:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '      - id: auth',
    '        uses: google-github-actions/auth@v3',
    '        with:',
    `          workload_identity_provider: ${input.provider}`,
    `          service_account: ${input.releaseIdentity}`,
    '          token_format: access_token',
    '      - uses: google-github-actions/setup-gcloud@v3',
    `      - run: gcloud auth configure-docker ${input.region}-docker.pkg.dev --quiet`,
  ];
  for (const service of input.services) {
    const id = service.name.replace(/[^A-Za-z0-9_]/g, '_');
    const generated = service.generatedDockerfile ? `.hypervibe-${id}.Dockerfile` : undefined;
    lines.push(
      `      - name: Build ${service.name}`,
      `        id: build_${id}`,
      '        run: |',
      // A repository Dockerfile wins; otherwise the service's generated one (with its own start command).
      ...(generated ? [
        `          DOCKERFILE=Dockerfile`,
        `          if [ ! -f Dockerfile ]; then DOCKERFILE=${generated}; printf '%s' '${Buffer.from(service.generatedDockerfile!, 'utf8').toString('base64')}' | base64 --decode > "$DOCKERFILE"; fi`,
        `          DOCKER_BUILDKIT=1 docker build -f "$DOCKERFILE" -t ${service.image}:$GITHUB_SHA .`,
      ] : [`          docker build -t ${service.image}:$GITHUB_SHA .`]),
      `          docker push ${service.image}:$GITHUB_SHA`,
      `          echo "digest=$(gcloud artifacts docker images describe ${service.image}:$GITHUB_SHA --format='value(image_summary.digest)')" >> "$GITHUB_OUTPUT"`,
      `      - name: Release ${service.name}`,
      '        env:',
      '          GCP_TOKEN: ${{ steps.auth.outputs.access_token }}',
      '        run: |',
      "          cat > release.mjs <<'HYPERVIBE_RELEASE'",
      ...RELEASE_SCRIPT.split('\n').map((line) => `          ${line}`),
      '          HYPERVIBE_RELEASE',
      `          node release.mjs ${service.resource} ${service.image}@\${{ steps.build_${id}.outputs.digest }} ${service.healthPath ?? '""'} ${service.kind ?? 'services'}`,
    );
  }
  return lines.join('\n') + '\n';
}

export function releaseWorkflowPath(repositoryRoot: string, environmentName: string): string {
  return path.join(repositoryRoot, '.github', 'workflows', `hypervibe-release-${environmentName}.yml`);
}

/** Writes the workflow into the local repository; returns whether the content changed. */
export function writeReleaseWorkflow(repositoryRoot: string, environmentName: string, content: string): { path: string; changed: boolean } {
  const target = releaseWorkflowPath(repositoryRoot, environmentName);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
  if (existing === content) return { path: target, changed: false };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return { path: target, changed: true };
}
