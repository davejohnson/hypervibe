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
export const CI_RELEASE_ACCOUNT_ID = 'hypervibe-release';
export const CI_POOL_ID = 'hypervibe-github';
export const CI_PROVIDER_ID = 'github';
export const CI_RELEASE_PROJECT_ROLES = ['roles/run.developer', 'roles/artifactregistry.writer'] as const;

export function ciReleaseIdentity(gcpProjectId: string): string {
  return `${CI_RELEASE_ACCOUNT_ID}@${gcpProjectId}.iam.gserviceaccount.com`;
}

export function ciWorkloadIdentityProvider(projectNumber: string): string {
  return `projects/${projectNumber}/locations/global/workloadIdentityPools/${CI_POOL_ID}/providers/${CI_PROVIDER_ID}`;
}

type Json = Record<string, unknown>;

async function google(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchWithRetry(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
}

async function waitOperation(token: string, base: string, operation: { name?: string; done?: boolean }): Promise<void> {
  if (operation.done || !operation.name) return;
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const polled = await google(token, `${base}/${operation.name}`);
    if (polled.ok && (await polled.json() as { done?: boolean }).done) return;
  }
  throw new Error('A Google Cloud setup operation did not finish in time.');
}

async function addBinding(token: string, resourceUrl: string, role: string, member: string, getMethod: 'GET' | 'POST'): Promise<void> {
  const read = await google(token, `${resourceUrl}:getIamPolicy`, getMethod === 'POST'
    ? { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) } : {});
  if (!read.ok) throw new Error(`Reading access for ${resourceUrl.split('/').pop()} failed (HTTP ${read.status}).`);
  const policy = await read.json() as { bindings?: Array<{ role: string; members: string[] }>; etag?: string; version?: number };
  const bindings = policy.bindings ?? [];
  const binding = bindings.find((entry) => entry.role === role && !(entry as { condition?: unknown }).condition);
  if (binding?.members.includes(member)) return;
  if (binding) binding.members.push(member); else bindings.push({ role, members: [member] });
  const write = await google(token, `${resourceUrl}:setIamPolicy`, { method: 'POST', body: JSON.stringify({ policy: { ...policy, bindings } }) });
  if (!write.ok) throw new Error(`Granting ${role} failed (HTTP ${write.status}).`);
}

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

/** Creates the release identity and keyless GitHub trust. Idempotent; uses a one-time admin token. */
export async function grantCiReleaseAccess(params: {
  adminToken: string;
  gcpProjectId: string;
  repository: string;
  runtimeServiceAccountEmail: string;
}): Promise<{ projectNumber: string; provider: string; releaseIdentity: string }> {
  const { adminToken: token, gcpProjectId: project, repository } = params;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('CI releases need the exact GitHub owner/repository.');
  const projectResponse = await google(token, `https://cloudresourcemanager.googleapis.com/v3/projects/${project}`);
  if (!projectResponse.ok) throw new Error(`Could not read GCP project ${project} (HTTP ${projectResponse.status}).`);
  const projectNumber = String((await projectResponse.json() as Json).name ?? '').replace('projects/', '');

  for (const service of ['iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com']) {
    const enabled = await google(token, `https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}:enable`, { method: 'POST', body: '{}' });
    if (!enabled.ok) throw new Error(`Enabling ${service} failed (HTTP ${enabled.status}).`);
    await waitOperation(token, 'https://serviceusage.googleapis.com/v1', await enabled.json() as { name?: string; done?: boolean });
  }

  const releaseIdentity = ciReleaseIdentity(project);
  const account = await google(token, `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`, {
    method: 'POST', body: JSON.stringify({ accountId: CI_RELEASE_ACCOUNT_ID, serviceAccount: { displayName: 'Hypervibe CI releases (image updates only)' } }),
  });
  if (!account.ok && account.status !== 409) throw new Error(`Creating the release identity failed (HTTP ${account.status}).`);

  const poolsBase = `https://iam.googleapis.com/v1/projects/${project}/locations/global/workloadIdentityPools`;
  const pool = await google(token, `${poolsBase}?workloadIdentityPoolId=${CI_POOL_ID}`, {
    method: 'POST', body: JSON.stringify({ displayName: 'Hypervibe GitHub Actions', description: 'Keyless CI releases managed by Hypervibe' }),
  });
  if (pool.ok) await waitOperation(token, 'https://iam.googleapis.com/v1', await pool.json() as { name?: string });
  else if (pool.status !== 409) throw new Error(`Creating the GitHub trust pool failed (HTTP ${pool.status}).`);

  const providerBody = {
    displayName: 'GitHub Actions',
    oidc: { issuerUri: 'https://token.actions.githubusercontent.com' },
    attributeMapping: { 'google.subject': 'assertion.sub', 'attribute.repository': 'assertion.repository', 'attribute.ref': 'assertion.ref' },
    // Google rejects tokens from any other repository before IAM is even consulted.
    attributeCondition: `assertion.repository == '${repository}'`,
  };
  const provider = await google(token, `${poolsBase}/${CI_POOL_ID}/providers?workloadIdentityPoolProviderId=${CI_PROVIDER_ID}`, { method: 'POST', body: JSON.stringify(providerBody) });
  if (provider.ok) await waitOperation(token, 'https://iam.googleapis.com/v1', await provider.json() as { name?: string });
  else if (provider.status === 409) {
    const patched = await google(token, `${poolsBase}/${CI_POOL_ID}/providers/${CI_PROVIDER_ID}?updateMask=attributeCondition,attributeMapping`, { method: 'PATCH', body: JSON.stringify(providerBody) });
    if (!patched.ok) throw new Error(`Updating the GitHub trust failed (HTTP ${patched.status}).`);
  } else throw new Error(`Creating the GitHub trust failed (HTTP ${provider.status}).`);

  const accountUrl = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${releaseIdentity}`;
  const principal = `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${CI_POOL_ID}/attribute.repository/${repository}`;
  // New service accounts take a moment to become visible to IAM policy calls.
  for (let attempt = 0; ; attempt++) {
    try { await addBinding(token, accountUrl, 'roles/iam.workloadIdentityUser', principal, 'POST'); break; }
    catch (error) { if (attempt >= 10) throw error; await new Promise((resolve) => setTimeout(resolve, 4000)); }
  }
  // IAM can take a little while to recognize a brand-new service account as a policy member.
  const withRetry = async (grant: () => Promise<void>) => {
    for (let attempt = 0; ; attempt++) {
      try { await grant(); return; }
      catch (error) { if (attempt >= 10) throw error; await new Promise((resolve) => setTimeout(resolve, 4000)); }
    }
  };
  for (const role of CI_RELEASE_PROJECT_ROLES) {
    await withRetry(() => addBinding(token, `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, role, `serviceAccount:${releaseIdentity}`, 'POST'));
  }
  await withRetry(() => addBinding(token, `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${params.runtimeServiceAccountEmail}`,
    'roles/iam.serviceAccountUser', `serviceAccount:${releaseIdentity}`, 'POST'));
  return { projectNumber, provider: ciWorkloadIdentityProvider(projectNumber), releaseIdentity };
}

export interface ReleaseWorkflowInput {
  environmentName: string;
  branch: string;
  gcpProjectId: string;
  region: string;
  provider: string;
  releaseIdentity: string;
  services: Array<{ name: string; resource: string; healthPath?: string; image: string; kind?: 'services' | 'jobs' }>;
  /** Used only when the repository has no Dockerfile of its own. */
  generatedDockerfile?: string;
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
console.log('Released ' + image + ' to ' + resource + (isJob ? ' (next scheduled run)' : ' at ' + after.uri));
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
    '      - uses: actions/checkout@v4',
    '      - id: auth',
    '        uses: google-github-actions/auth@v2',
    '        with:',
    `          workload_identity_provider: ${input.provider}`,
    `          service_account: ${input.releaseIdentity}`,
    '          token_format: access_token',
    '      - uses: google-github-actions/setup-gcloud@v2',
    `      - run: gcloud auth configure-docker ${input.region}-docker.pkg.dev --quiet`,
  ];
  if (input.generatedDockerfile) {
    lines.push(
      '      - name: Use the Hypervibe Dockerfile when the repository has none',
      '        run: |',
      '          if [ ! -f Dockerfile ]; then',
      `            printf '%s' '${Buffer.from(input.generatedDockerfile, 'utf8').toString('base64')}' | base64 --decode > Dockerfile`,
      '          fi',
    );
  }
  for (const service of input.services) {
    const id = service.name.replace(/[^A-Za-z0-9_]/g, '_');
    lines.push(
      `      - name: Build ${service.name}`,
      `        id: build_${id}`,
      '        run: |',
      `          docker build -t ${service.image}:$GITHUB_SHA .`,
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
