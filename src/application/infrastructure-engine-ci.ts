import { effectiveBranchCiAutoDeploy } from '../domain/spec/spec.schema.js';
import type { GcpCiReleaseScope } from '../adapters/providers/gcp/tofu/gcp-ci.backend.js';
import { PINNED_ACTIONS } from '../domain/services/pinned-actions.js';
import { readGcpProject } from '../adapters/providers/gcp/gcp-data.client.js';
import { RELEASE_SCRIPT } from '../adapters/providers/gcp/gcp-ci-release-script.js';
import { assertHealthCheckPath } from '../domain/spec/health-check-path.js';
import fs from 'fs';
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

export function previewCiReleaseAccess(gcpProjectId: string, repository: string, runtimeServiceAccountEmail: string, releases: GcpCiReleaseScope[]): CiReleaseAccessPreview {
  return {
    releaseIdentity: ciReleaseIdentity(gcpProjectId),
    repository,
    grants: [
      ...releases.map(scope => `${repository}/.github/workflows/hypervibe-release-${scope.environmentName}.yml on ${scope.branch}, environment ${scope.environmentName} (${scope.autoDeploy ? 'push or manual' : 'manual only'}), may use ${ciReleaseIdentity(gcpProjectId)}`),
      ...CI_RELEASE_PROJECT_ROLES.map((role) => `${ciReleaseIdentity(gcpProjectId)}: ${role}`),
      `${ciReleaseIdentity(gcpProjectId)} may deploy revisions that run as ${runtimeServiceAccountEmail}`,
    ],
  };
}

/** Plans or applies the exact reviewed CI identity configuration through OpenTofu. */
export async function grantCiReleaseAccess(params: {
  projectId: string;
  projectName?: string;
  adminToken: string;
  gcpProjectId: string;
  repository: string;
  repositoryId: string;
  releases: GcpCiReleaseScope[];
  runtimeServiceAccountEmail: string;
  confirm?: boolean;
}) {
  const response = await readGcpProject(params.adminToken, params.gcpProjectId);
  if (!response.ok) throw new Error(`Could not read the GCP project (HTTP ${response.status}).`);
  const body = await response.json() as { name?: string; projectId?: string; state?: string };
  if (!/^projects\/[0-9]+$/.test(body.name ?? '') || body.projectId !== params.gcpProjectId || body.state !== 'ACTIVE') {
    throw new Error('The CI setup project identity could not be verified.');
  }
  const projectNumber = body.name!.slice('projects/'.length);
  const configuration = buildCiReleaseConfiguration({ ...params, projectId: params.gcpProjectId, projectNumber });
  const result = await runGcpProjectSetup({
    projectId: params.projectId, projectName: params.projectName, gcpProjectId: params.gcpProjectId,
    auth: { env: { GOOGLE_OAUTH_ACCESS_TOKEN: params.adminToken }, redact: [params.adminToken] },
    contribution: { id: 'ci-release', configuration }, confirm: params.confirm,
  });
  if (!result.success) throw new Error(result.error ?? 'CI infrastructure setup did not complete.');
  return { ...result, projectNumber, provider: ciWorkloadIdentityProvider(projectNumber), releaseIdentity: ciReleaseIdentity(params.gcpProjectId) };
}

export interface ReleaseWorkflowInput {
  environmentName: string;
  branch: string;
  autoDeploy?: boolean;
  gcpProjectId: string;
  region: string;
  provider: string;
  releaseIdentity: string;
  /** generatedDockerfile is used only when the repository has no Dockerfile of its own; it carries that service's start command. */
  services: Array<{ name: string; resource: string; healthPath?: string; strictHealth?: boolean; image: string; kind?: 'services' | 'jobs' | 'workerPools'; generatedDockerfile?: string;
    /** Services and workers: the declared start command, applied with each release. */
    startCommand?: string }>;
  /** Name of the repository's Actions secret holding a private-package token; mounted into builds as npm_token. */
  packageTokenSecret?: string;
  /** The migration job and the service whose image it runs; executed after every build and before any release. */
  releaseCommand?: { job: string; service: string };
}

/** A GitHub Actions workflow with no stored cloud credentials; a package token is referenced only by its repository secret name. */
/** Values written into workflow YAML and shell lines must be plain identifiers, never shell or YAML source. */
function plain(label: string, value: string): string {
  if (!/^[A-Za-z0-9._/:@-]+$/.test(value)) throw new Error(`The ${label} ${JSON.stringify(value)} is not supported in a workflow: use only letters, digits and . _ / : @ -`);
  return value;
}

export function renderReleaseWorkflow(input: ReleaseWorkflowInput): string {
  plain('environment name', input.environmentName); plain('Google Cloud project', input.gcpProjectId); plain('region', input.region);
  plain('identity provider', input.provider); plain('release identity', input.releaseIdentity);
  if (input.releaseCommand) plain('release job', input.releaseCommand.job);
  for (const service of input.services) {
    plain('service name', service.name); plain('resource', service.resource); plain('image', service.image);
    if (service.healthPath !== undefined) assertHealthCheckPath(service.healthPath);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(input.environmentName)) throw new Error('Environment name is not supported in a workflow.');
  if (!/^[A-Za-z0-9._/-]+$/.test(input.branch)) throw new Error('Branch name is not supported in a workflow trigger.');
  const lines: string[] = [
    `# Managed by Hypervibe. Releases ${input.environmentName} from ${input.branch}.`,
    '# Authenticates without stored keys (Workload Identity Federation) and changes only the running image.',
    `name: Hypervibe release (${input.environmentName})`,
    'on:',
    ...(effectiveBranchCiAutoDeploy(input.environmentName, input.autoDeploy) ? ['  push:', `    branches: [${JSON.stringify(input.branch)}]`] : []),
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
    `    if: github.ref == 'refs/heads/${input.branch}'`,
    `    environment: ${JSON.stringify(input.environmentName)}`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '      - id: auth',
    `        uses: ${PINNED_ACTIONS.googleAuth}`,
    '        with:',
    `          workload_identity_provider: ${input.provider}`,
    `          service_account: ${input.releaseIdentity}`,
    '          token_format: access_token',
    `      - uses: ${PINNED_ACTIONS.setupGcloud}`,
    `      - run: gcloud auth configure-docker ${input.region}-docker.pkg.dev --quiet`,
  ];
  if (input.packageTokenSecret && !/^[A-Z][A-Z0-9_]*$/.test(input.packageTokenSecret)) throw new Error('Package token secret name is not supported in a workflow.');
  const secret = input.packageTokenSecret ? ' --secret id=npm_token,env=NPM_TOKEN' : '';
  for (const service of input.services) {
    const id = service.name.replace(/[^A-Za-z0-9_]/g, '_');
    const generated = service.generatedDockerfile ? `.hypervibe-${id}.Dockerfile` : undefined;
    lines.push(
      `      - name: Build ${service.name}`,
      `        id: build_${id}`,
      ...(input.packageTokenSecret ? ['        env:', `          NPM_TOKEN: \${{ secrets.${input.packageTokenSecret} }}`] : []),
      '        run: |',
      // A repository Dockerfile wins; otherwise the service's generated one (with its own start command).
      ...(generated ? [
        `          DOCKERFILE=Dockerfile`,
        `          if [ ! -f Dockerfile ]; then DOCKERFILE=${generated}; printf '%s' '${Buffer.from(service.generatedDockerfile!, 'utf8').toString('base64')}' | base64 --decode > "$DOCKERFILE"; fi`,
        `          DOCKER_BUILDKIT=1 docker build${secret} -f "$DOCKERFILE" -t ${service.image}:$GITHUB_SHA .`,
      ] : [`          ${secret ? 'DOCKER_BUILDKIT=1 ' : ''}docker build${secret} -t ${service.image}:$GITHUB_SHA .`]),
      `          docker push ${service.image}:$GITHUB_SHA`,
      `          echo "digest=$(gcloud artifacts docker images describe ${service.image}:$GITHUB_SHA --format='value(image_summary.digest)')" >> "$GITHUB_OUTPUT"`,
    );
  }
  const script = ["          cat > release.mjs <<'HYPERVIBE_RELEASE'", ...RELEASE_SCRIPT.split('\n').map((line) => `          ${line}`), '          HYPERVIBE_RELEASE'];
  const stepId = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_');
  if (input.releaseCommand) {
    const source = input.services.find((service) => service.name === input.releaseCommand!.service);
    if (!source) throw new Error('The release command needs the image of a released service.');
    // Every image is built first, so a failed migration leaves all services on the previous release.
    lines.push(
      '      - name: Run release command',
      '        env:',
      '          GCP_TOKEN: ${{ steps.auth.outputs.access_token }}',
      "          HYPERVIBE_RUN_JOB: '1'",
      '        run: |',
      ...script,
      `          node release.mjs ${input.releaseCommand.job} ${source.image}@\${{ steps.build_${stepId(source.name)}.outputs.digest }} "" jobs`,
    );
  }
  for (const service of input.services) {
    const id = stepId(service.name);
    lines.push(
      `      - name: Release ${service.name}`,
      '        env:',
      ...(service.strictHealth ? ["          HYPERVIBE_HEALTH_STRICT: '1'"] : []),
      '          GCP_TOKEN: ${{ steps.auth.outputs.access_token }}',
      '        run: |',
      ...script,
      `          node release.mjs ${service.resource} ${service.image}@\${{ steps.build_${id}.outputs.digest }} ${service.healthPath ? `'${service.healthPath}'` : '""'} ${service.kind ?? 'services'}${service.kind === 'jobs' ? '' : ` "${Buffer.from(service.startCommand?.trim() ?? '').toString('base64')}"`}`,
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
