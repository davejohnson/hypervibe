import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { CommandContext } from './context.js';
import { commandError, commandSuccess, HvError, type CommandEnvelope } from './results.js';
import { SpecStore } from '../domain/spec/spec.store.js';
import { projectSpecSchema, type ProjectSpec } from '../domain/spec/spec.schema.js';
import { getAppStoreConnectAdapter } from '../domain/services/appstore-ops.service.js';
import { getGitHubAdapter } from '../domain/services/github-ops.service.js';
import { connectionSetupOptions } from '../domain/services/connection-guidance.js';
import { resolveManagedWorkflowContract, workflowFiles, workflowFilesContentHash } from '../domain/services/ci-deploy.service.js';
import { environmentDeploymentContractHash } from '../domain/services/deployment-contract.service.js';
import { managedCiReleaseArtifactPrefix, MANAGED_CI_RELEASE_EVIDENCE_VERSION } from '../domain/services/managed-ci-evidence.js';
import { iosBuildContractFingerprint, IOS_RELEASE_EVIDENCE_VERSION } from '../domain/services/ios-release-evidence.js';
import { iosReleaseWorkflowPath } from '../domain/services/ios-release-workflow.service.js';
import { canonicalJsonSha256 } from '../lib/canonical-json.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import type { GitHubAdapter } from '../adapters/providers/github/github.adapter.js';
import { API_RELEASE_EVIDENCE_FILE, apiReleaseArtifactPrefix, apiReleasePolicyHash, validateApiReleaseEvidence, type ApiReleaseEvidenceManifest } from '../domain/services/api-release-workflow.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.object({ repository: z.string().min(1), sha }).strict();
const string = z.string().min(1);
const iosManifestSchema = z.object({
  version: z.literal(IOS_RELEASE_EVIDENCE_VERSION), environment: string,
  mobile: identity.extend({ buildContractFingerprint: hash }).strict(),
  server: identity.extend({ workflowRunId: z.string().regex(/^[1-9][0-9]*$/), evidenceSha256: hash }).strict(), services: z.array(string).min(1),
  app: z.object({
    bundleId: string, appId: string, buildId: string, marketingVersion: string,
    buildNumber: string, ipaSha256: hash, testflightGroups: z.array(string), submittedForBetaReview: z.boolean(),
  }).strict(),
  releasedAt: z.string().datetime(),
}).strict();
const serverManifestSchema = z.object({
  version: z.literal(MANAGED_CI_RELEASE_EVIDENCE_VERSION), provider: string, environment: string,
  source: identity, programFingerprint: hash, deploymentContractFingerprint: hash,
  target: z.object({
    scope: z.record(z.unknown()), bindingsFingerprint: hash,
    resources: z.array(z.object({
      logicalName: string, workloadKind: z.enum(['web', 'worker', 'cron']),
      providerResourceType: z.enum(['service', 'job']), providerResourceId: string,
      imageUri: z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/).nullable(),
    }).strict()).min(1),
  }).strict(),
  verifiedAt: z.string().datetime(),
}).strict();

export type IosSubmissionManifest = z.infer<typeof iosManifestSchema>;
export type ServerSubmissionManifest = z.infer<typeof serverManifestSchema>;
type Contract = Extract<ReturnType<typeof resolveManagedWorkflowContract>, { ok: true }>;
type Run = Awaited<ReturnType<GitHubAdapter['getWorkflowRun']>>;
type Artifact = Awaited<ReturnType<GitHubAdapter['listWorkflowRunArtifacts']>>['artifacts'][number];
type SelectedEvidence = { run: Run; artifact: Artifact; body: unknown; sha: string; sha256: string };

export interface AppStoreSubmitInput {
  project?: string; environment: string; appIdentifier: string; platform?: 'IOS' | 'MAC_OS' | 'TV_OS';
  iosRunId?: string; serverRunId?: string; releaseFingerprint?: string; confirm?: boolean;
}

function invalid(message: string): never { throw new HvError('VALIDATION', message); }
function runId(value: string): number {
  const result = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(result)) invalid('Release run IDs must be positive safe integers.');
  return result;
}
function validateRun(run: Run, repository: string, workflow: string, id: number): void {
  if (run.id !== id || run.path !== workflow || run.status !== 'completed' || run.conclusion !== 'success'
      || !sha.safeParse(run.head_sha).success || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || run.repository?.full_name?.toLowerCase() !== repository.toLowerCase()
      || run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    invalid('Release evidence must belong to a successful exact managed workflow run in this repository.');
  }
}

async function verifyCurrentServerRun(github: GitHubAdapter, owner: string, repo: string, workflow: string, selectedId: number): Promise<void> {
  try {
    const runs = await completeReleaseRuns(github, owner, repo, workflow);
    if (!Array.isArray(runs) || runs.length === 0
        || runs.some((run) => !Number.isSafeInteger(run.id) || Number.isNaN(Date.parse(run.created_at)) || run.status !== 'completed')) {
      invalid('The current target deployment is running or cannot be verified.');
    }
    const latest = [...runs].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (latest[0].id !== selectedId || latest[0].conclusion !== 'success'
        || latest.some((run) => run.id !== selectedId && run.updated_at === latest[0].updated_at)) {
      invalid('A newer or ambiguous target deployment prevents using the selected server release.');
    }
  } catch (error) {
    if (error instanceof HvError) throw error;
    throw new HvError('PROVIDER_ERROR', 'Could not verify the current target deployment.');
  }
}

async function completeReleaseRuns(github: GitHubAdapter, owner: string, repo: string, workflow: string, status?: string) {
  const runs: Awaited<ReturnType<GitHubAdapter['listWorkflowRuns']>>['workflow_runs'] = [];
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const observed = await github.listWorkflowRuns(owner, repo, workflow, { per_page: 100, page, ...(status ? { status } : {}) });
    if (!Array.isArray(observed.workflow_runs) || !Number.isSafeInteger(observed.total_count) || observed.total_count < 0
        || observed.total_count > 1000 || (total !== undefined && total !== observed.total_count)) {
      invalid('Workflow history is incomplete, changed during observation, or exceeds the 1000-run verification bound.');
    }
    total = observed.total_count;
    runs.push(...observed.workflow_runs);
    if (runs.some((run) => !Number.isSafeInteger(run.id) || run.id < 1 || Number.isNaN(Date.parse(run.updated_at)))
        || new Set(runs.map((run) => run.id)).size !== runs.length || runs.length > total) invalid('Workflow history is ambiguous.');
    if (runs.length === total) return runs;
    if (observed.workflow_runs.length === 0) break;
  }
  invalid('Workflow history is incomplete; current release identity cannot be verified.');
}

async function selectEvidence(params: {
  github: GitHubAdapter; owner: string; repo: string; repository: string; workflow: string;
  prefix: string; filename: string; runId?: string; contract: Contract;
  /** The trusted beta manifest already names this exact original server run. */
  originalBetaServer?: boolean;
}): Promise<SelectedEvidence> {
  const { github, owner, repo } = params;
  let ids: number[];
  if (params.runId) ids = [runId(params.runId)];
  else {
    const runs = (await completeReleaseRuns(github, owner, repo, params.workflow, 'completed')).filter((run) => run.conclusion === 'success');
    if (runs.some((run) => !Number.isSafeInteger(run.id) || run.id < 1 || Number.isNaN(Date.parse(run.created_at)))
        || new Set(runs.map((run) => run.id)).size !== runs.length) invalid('Workflow run observation is ambiguous.');
    runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (runs.length > 1 && runs[0].updated_at === runs[1].updated_at) invalid('Multiple successful releases have the same time. Select an exact run ID.');
    ids = runs.map((run) => run.id);
  }
  for (const id of ids) {
    const run = await github.getWorkflowRun(owner, repo, id);
    validateRun(run, params.repository, params.workflow, id);
    const listed = await github.listWorkflowRunArtifacts(owner, repo, id);
    if (!Array.isArray(listed.artifacts) || listed.total_count !== listed.artifacts.length) {
      invalid('Release artifact listing is incomplete. Select a run with complete observable evidence.');
    }
    const matching = listed.artifacts.filter((artifact) => artifact.name.startsWith(params.prefix));
    if (matching.length === 0 && !params.runId) continue; // A relevance-gated run can succeed without releasing a build.
    if (matching.length !== 1) invalid('Expected one release manifest in the selected workflow run.');
    const artifact = matching[0];
    const releaseSha = artifact.name.slice(params.prefix.length);
    if (!sha.safeParse(releaseSha).success || artifact.expired !== false || artifact.workflow_run?.id !== id
        || !Number.isSafeInteger(artifact.id) || artifact.id <= 0) invalid('The selected release artifact is expired or has invalid provenance.');

    // The run head proves which program executed, not which commit that program deployed.
    const desiredFiles = workflowFiles(params.contract.workflow);
    const executedFile = desiredFiles.find((file) => file.path === params.workflow);
    const executedContent = await github.getFileContent(owner, repo, params.workflow, run.head_sha);
    if (!executedFile || executedContent === null) invalid('The selected run has no observable managed workflow program.');
    const binding = params.contract.binding;
    if (!params.originalBetaServer && executedContent !== executedFile.content) {
      // A historical accepted renderer can be proven by its aggregate lock.
      // Current exact file matches do not depend on unrelated companion files.
      if (binding?.inputHash !== params.contract.inputHash) invalid('The selected release did not run the currently reviewed managed workflow program.');
      const files = await Promise.all(desiredFiles.map(async (file) => ({
        path: file.path, content: await github.getFileContent(owner, repo, file.path, run.head_sha) ?? '',
      })));
      if (workflowFilesContentHash(files) !== binding.contentHash) invalid('The selected release did not run the currently reviewed managed workflow program.');
    }
    const files = await github.readArtifactFiles(owner, repo, artifact.id);
    const content = files[params.filename];
    if (Object.keys(files).length !== 1 || typeof content !== 'string') invalid('The release artifact must contain exactly its named manifest.');
    return { run, artifact, sha: releaseSha, body: JSON.parse(content), sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
  }
  invalid('No successful managed release with a manifest was found. Select exact run IDs with hv_ci_status.');
}

async function historicalSpec(github: GitHubAdapter, owner: string, repo: string, commit: string): Promise<{ raw: ProjectSpec; spec: ProjectSpec }> {
  const content = await github.getFileContent(owner, repo, '.hypervibe/spec.json', commit);
  if (content === null) invalid('The release source has no committed Hypervibe spec.');
  try {
    const raw = JSON.parse(content) as ProjectSpec;
    const parsed = projectSpecSchema.safeParse(raw);
    if (!parsed.success) invalid('The release source spec is invalid.');
    return { raw, spec: parsed.data };
  } catch {
    invalid('The release source spec could not be validated.');
  }
}

/** Extended by the shared API-compatibility proof; never relabel mobile.sha. */
export function validateAppStoreServerCompatibility(params: {
  mobile: IosSubmissionManifest; server: ServerSubmissionManifest;
  sourceSpec: ProjectSpec; targetSpec: ProjectSpec; sourceEnvironment: string; targetEnvironment: string;
  desiredSpec: ProjectSpec; sourceApi?: ApiReleaseEvidenceManifest; targetApi?: ApiReleaseEvidenceManifest;
}): void {
  if (params.mobile.mobile.repository !== params.server.source.repository) invalid('Mobile and server evidence must belong to the same repository.');
  if (params.mobile.mobile.sha === params.server.source.sha) return;
  const version = params.sourceSpec.environments[params.sourceEnvironment]?.ios?.release?.apiVersion;
  const source = version && params.sourceApi?.versions[version];
  const target = version && params.targetApi?.versions[version];
  const historical = version && params.targetSpec.environments[params.targetEnvironment]?.api?.versions[version];
  const desired = version && params.desiredSpec.environments[params.targetEnvironment]?.api?.versions[version];
  if (!version || !source || !target || !historical || !desired
      || source.status === 'retired' || target.status === 'retired' || historical.status === 'retired' || desired.status === 'retired'
      || params.desiredSpec.environments[params.targetEnvironment]?.ios?.release?.apiVersion !== version
      || source.contractHash !== target.contractHash || source.path !== target.path) {
    invalid('The tested iOS build and target server have different commits without verified API compatibility evidence.');
  }
}

async function readApiCompanion(params: {
  github: GitHubAdapter; owner: string; repo: string; repository: string; environment: string;
  workflow: string; server: SelectedEvidence; spec: ProjectSpec;
}): Promise<ApiReleaseEvidenceManifest> {
  const { github, owner, repo } = params;
  const listed = await github.listWorkflowRunArtifacts(owner, repo, params.server.run.id);
  if (!Array.isArray(listed.artifacts) || listed.total_count !== listed.artifacts.length) invalid('API release artifact observation is incomplete.');
  const matches = listed.artifacts.filter((artifact) => artifact.name === apiReleaseArtifactPrefix(params.environment) + params.server.sha);
  const artifact = matches[0];
  if (matches.length !== 1 || artifact.expired !== false || artifact.workflow_run?.id !== params.server.run.id
      || artifact.workflow_run.head_sha !== params.server.run.head_sha || !Number.isSafeInteger(artifact.id) || artifact.id < 1) {
    invalid('The selected server run has no unique unexpired API compatibility proof.');
  }
  const files = await github.readArtifactFiles(owner, repo, artifact.id);
  const api = params.spec.environments[params.environment]?.api;
  if (!api) invalid('The selected server source does not declare an API policy.');
  let proof: ApiReleaseEvidenceManifest;
  try {
    proof = validateApiReleaseEvidence({
      manifest: JSON.parse(files[API_RELEASE_EVIDENCE_FILE]), snapshots: files,
      identity: { repository: params.repository, environment: params.environment, sha: params.server.sha, runId: params.server.run.id, workflow: params.workflow },
      serverEvidenceSha256: params.server.sha256,
    });
  } catch { invalid('The selected API compatibility manifest or immutable snapshots could not be verified.'); }
  const installCommand = api.compatibility.installCommand || params.spec.runtime?.installCommand;
  const policy = { ...api, compatibility: { ...api.compatibility, ...(installCommand ? { installCommand } : {}) } };
  const observedPolicy = { ...policy, service: proof.service, consumers: proof.consumers, versions: Object.fromEntries(
    Object.entries(proof.versions).map(([name, { snapshot: _snapshot, contractHash: _hash, ...version }]) => [name, version])
  ) };
  if (proof.policyHash !== apiReleasePolicyHash(api, params.spec.runtime) || proof.policyHash !== canonicalJsonSha256(observedPolicy)
      || proof.compatibility.commandHash !== canonicalJsonSha256(policy.compatibility)) {
    invalid('API compatibility evidence does not match the immutable source policy and command.');
  }
  return proof;
}

export async function submitAppStoreRelease(ctx: CommandContext, input: AppStoreSubmitInput): Promise<CommandEnvelope> {
  try { return await executeAppStoreRelease(ctx, input); }
  catch (error) {
    if (error instanceof HvError) throw error;
    // Upstream error prose can contain credentials or signed download URLs.
    // A failed receipt also cannot prove that Apple performed no mutation.
    return commandError('PROVIDER_ERROR', 'App Store submission could not be verified.', {
      hint: 'Inspect the current App Store version and review submission through hv_appstore_status before retrying.',
    });
  }
}

async function executeAppStoreRelease(ctx: CommandContext, input: AppStoreSubmitInput): Promise<CommandEnvelope> {
  const project = ctx.resolveProjectOrThrow({ project: input.project });
  const stored = new SpecStore().get(project);
  if (!stored) return commandError('NOT_FOUND', `Project "${project.name}" has no desired-state spec.`);
  const desired = stored.spec;
  const target = desired.environments[input.environment];
  if (!target?.ios?.release || target.ios.bundleId !== input.appIdentifier) invalid('The target environment does not declare this iOS release.');
  const sourceEnvironment = target.ios.release.promoteFrom ?? input.environment;
  const source = desired.environments[sourceEnvironment];
  const platform = input.platform ?? target.ios.platform;
  if (!source?.ios?.release || source.ios.bundleId !== input.appIdentifier || source.ios.platform !== platform || target.ios.platform !== platform) {
    invalid('Source and target must declare the same app bundle and platform.');
  }
  const repository = parseGitHubRepoFromRemote(desired.gitRemoteUrl ?? project.gitRemoteUrl);
  const [owner, repo] = repository?.split('/') ?? [];
  if (!repository || !owner || !repo) invalid('The project has no valid GitHub repository for release evidence.');
  const connected = getGitHubAdapter(repository);
  if ('error' in connected) return commandError('MISSING_CONNECTION', connected.error, connectionSetupOptions('github', { project: project.name, scope: repository }));
  const github = connected.adapter;
  const sourceContract = resolveManagedWorkflowContract({ project, environmentName: sourceEnvironment, environmentSpec: source });
  const targetContract = resolveManagedWorkflowContract({ project, environmentName: input.environment, environmentSpec: target });
  if (!sourceContract.ok || !targetContract.ok) invalid('Reconcile the managed source and target release bindings before App Store submission.');

  let mobileEvidence: SelectedEvidence;
  let serverEvidence: SelectedEvidence;
  let sourceHistory: Awaited<ReturnType<typeof historicalSpec>>;
  let targetHistory: Awaited<ReturnType<typeof historicalSpec>>;
  try {
    [mobileEvidence, serverEvidence] = await Promise.all([
      selectEvidence({ github, owner, repo, repository, contract: sourceContract, runId: input.iosRunId,
        workflow: iosReleaseWorkflowPath(sourceEnvironment), prefix: `hypervibe-ios-release-${sourceEnvironment.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-`, filename: 'hypervibe-ios-release.json' }),
      selectEvidence({ github, owner, repo, repository, contract: targetContract, runId: input.serverRunId,
        workflow: targetContract.workflow.path, prefix: managedCiReleaseArtifactPrefix(input.environment), filename: 'hypervibe-server-release.json' }),
    ]);
    [sourceHistory, targetHistory] = await Promise.all([
      historicalSpec(github, owner, repo, mobileEvidence.sha), historicalSpec(github, owner, repo, serverEvidence.sha),
    ]);
    await verifyCurrentServerRun(github, owner, repo, targetContract.workflow.path, serverEvidence.run.id);
  } catch (error) {
    if (error instanceof HvError) throw error;
    return commandError('PROVIDER_ERROR', 'Could not verify the selected managed release evidence.', { hint: 'Inspect the selected runs through hv_ci_status and retry. No provider response or artifact contents are exposed.' });
  }
  const mobileParsed = iosManifestSchema.safeParse(mobileEvidence.body);
  const serverParsed = serverManifestSchema.safeParse(serverEvidence.body);
  if (!mobileParsed.success || !serverParsed.success) invalid('Release manifests are incomplete or use an unsupported evidence version.');
  const mobile = mobileParsed.data;
  const server = serverParsed.data;
  const historicalIos = sourceHistory.spec.environments[sourceEnvironment]?.ios;
  if (!historicalIos?.release || mobile.environment !== sourceEnvironment || mobile.mobile.repository !== repository
      || mobile.server.repository !== repository || mobile.mobile.sha !== mobileEvidence.sha || mobile.server.sha !== mobile.mobile.sha
      || mobile.app.bundleId !== input.appIdentifier || historicalIos.bundleId !== input.appIdentifier
      || mobile.mobile.buildContractFingerprint !== iosBuildContractFingerprint(historicalIos, sourceHistory.spec.runtime)
      || mobile.mobile.buildContractFingerprint !== iosBuildContractFingerprint(source.ios, desired.runtime)) {
    invalid('The beta release manifest does not prove the reviewed app build and immutable source contract.');
  }
  const expected = targetContract.target;
  const resources = server.target.resources.map(({ imageUri: _image, ...resource }) => resource);
  if (server.environment !== input.environment || server.provider !== target.hosting.provider
      || server.source.repository !== repository || server.source.sha !== serverEvidence.sha
      || server.programFingerprint !== expected.programFingerprint
      || server.target.bindingsFingerprint !== expected.releaseTarget?.bindingsFingerprint
      || canonicalJsonSha256({ scope: server.target.scope, resources }) !== canonicalJsonSha256({ scope: expected.releaseTarget?.scope, resources: expected.releaseTarget?.resources })
      || server.deploymentContractFingerprint !== environmentDeploymentContractHash(targetHistory.raw, input.environment)
      || target.ios.release.services.some((name) => !resources.some((resource) => resource.logicalName === name))) {
    invalid('The target server manifest does not prove the exact reviewed deployment and source contract.');
  }
  let sourceApi: ApiReleaseEvidenceManifest | undefined;
  let targetApi: ApiReleaseEvidenceManifest | undefined;
  if (mobile.mobile.sha !== server.source.sha) {
    try {
      const originalServer = await selectEvidence({
        github, owner, repo, repository, contract: sourceContract, runId: mobile.server.workflowRunId,
        workflow: sourceContract.workflow.path, prefix: managedCiReleaseArtifactPrefix(sourceEnvironment), filename: 'hypervibe-server-release.json', originalBetaServer: true,
      });
      const original = serverManifestSchema.safeParse(originalServer.body);
      if (!original.success || original.data.environment !== sourceEnvironment || original.data.provider !== source.hosting.provider
          || original.data.source.repository !== repository || original.data.source.sha !== mobile.server.sha || originalServer.sha !== mobile.server.sha
          || originalServer.sha256 !== mobile.server.evidenceSha256
          || original.data.deploymentContractFingerprint !== environmentDeploymentContractHash(sourceHistory.raw, sourceEnvironment)
          || !original.data.target.resources.some((resource) => resource.logicalName === sourceHistory.spec.environments[sourceEnvironment]?.api?.service)) {
        invalid('The original beta server manifest does not match its immutable source and API service.');
      }
      [sourceApi, targetApi] = await Promise.all([
        readApiCompanion({ github, owner, repo, repository, environment: sourceEnvironment, workflow: sourceContract.workflow.path, server: originalServer, spec: sourceHistory.spec }),
        readApiCompanion({ github, owner, repo, repository, environment: input.environment, workflow: targetContract.workflow.path, server: serverEvidence, spec: targetHistory.spec }),
      ]);
    } catch (error) {
      if (error instanceof HvError) throw error;
      return commandError('PROVIDER_ERROR', 'Could not verify API compatibility for the selected tested build.');
    }
  }
  validateAppStoreServerCompatibility({ mobile, server, sourceSpec: sourceHistory.spec, targetSpec: targetHistory.spec, desiredSpec: desired, sourceEnvironment, targetEnvironment: input.environment, sourceApi, targetApi });

  const apple = getAppStoreConnectAdapter(input.appIdentifier);
  if ('error' in apple) return commandError('MISSING_CONNECTION', apple.error, connectionSetupOptions('appstoreconnect', { project: project.name, scope: input.appIdentifier }));
  const app = await apple.adapter.findAppByBundleId(input.appIdentifier);
  if (!app || app.id !== mobile.app.appId) invalid('The live Apple app does not match the tested build.');
  const version = await apple.adapter.getEditableAppStoreVersion(app.id, platform);
  if (!version) return commandError('VALIDATION', 'No version ready for submission. Prepare the App Store version and attach the tested build first.');
  const build = await apple.adapter.getAppStoreVersionBuild(version.id);
  if (!build || build.id !== mobile.app.buildId || build.version !== mobile.app.buildNumber || version.versionString !== mobile.app.marketingVersion || version.platform !== platform) {
    invalid('The attached App Store build does not match the exact tested TestFlight build and version.');
  }
  const releaseGate = {
    environment: input.environment, sourceEnvironment,
    mobileSha: mobile.mobile.sha, serverSha: server.source.sha,
    iosRunId: String(mobileEvidence.run.id), serverRunId: String(serverEvidence.run.id),
    iosArtifactId: mobileEvidence.artifact.id, serverArtifactId: serverEvidence.artifact.id,
    appId: app.id, versionId: version.id, buildId: build.id, buildNumber: build.version,
  };
  const releaseFingerprint = canonicalJsonSha256({
    releaseGate, mobile, server, sourceRunAttempt: mobileEvidence.run.run_attempt, targetRunAttempt: serverEvidence.run.run_attempt,
    desired: canonicalJsonSha256(desired), sourceApi: sourceApi ?? null, targetApi: targetApi ?? null,
  });
  const retryInput = { confirm: true, iosRunId: releaseGate.iosRunId, serverRunId: releaseGate.serverRunId, releaseFingerprint };
  if (!input.confirm || !input.iosRunId || !input.serverRunId || !input.releaseFingerprint) {
    return {
      ...commandError('CONFIRM_REQUIRED', `Submit tested build ${build.version} (${version.versionString}) for App Store review?`, { details: { ...releaseGate, releaseFingerprint, buildConfiguration: { sourceEnvironment, status: 'unverified', message: 'The same binary retains its source build configuration. Hypervibe has not verified embedded endpoints or environment-specific build secret values.' } } }),
      confirmation: { message: `Submit tested build ${build.version} (${version.versionString}) for App Store review? The same binary retains ${sourceEnvironment} build configuration; Hypervibe has not verified embedded endpoints or build secret values.`, retryInput },
    };
  }
  if (input.releaseFingerprint !== releaseFingerprint) invalid('The reviewed release selection changed. Preview and confirm the current exact build again.');
  // Reobserve the attached identity and both successful run attempts immediately
  // before any Apple mutation; a preview never authorizes a different build.
  const [freshBuild, freshMobile, freshServer] = await Promise.all([
    apple.adapter.getAppStoreVersionBuild(version.id), github.getWorkflowRun(owner, repo, mobileEvidence.run.id), github.getWorkflowRun(owner, repo, serverEvidence.run.id),
  ]);
  validateRun(freshMobile, repository, iosReleaseWorkflowPath(sourceEnvironment), mobileEvidence.run.id);
  validateRun(freshServer, repository, targetContract.workflow.path, serverEvidence.run.id);
  if (freshBuild?.id !== build.id || freshBuild.version !== build.version
      || freshMobile.run_attempt !== mobileEvidence.run.run_attempt || freshServer.run_attempt !== serverEvidence.run.run_attempt) {
    invalid('The attached build or selected release run changed before submission.');
  }
  await verifyCurrentServerRun(github, owner, repo, targetContract.workflow.path, serverEvidence.run.id);
  const { reviewSubmission, reusedExistingSubmission } = await apple.adapter.submitForReview({ appId: app.id, appStoreVersionId: version.id, platform: version.platform });
  ctx.repos.audit.create({ action: 'appstore.submit', resourceType: 'appstore', resourceId: app.id,
    details: { ...releaseGate, releaseFingerprint, reviewSubmissionId: reviewSubmission.id } });
  return commandSuccess({
    message: 'App submitted for App Store review',
    app: { id: app.id, bundleId: input.appIdentifier },
    version: { id: version.id, versionString: version.versionString, previousState: version.appStoreState },
    build: { id: build.id, buildNumber: build.version },
    reviewSubmission: { id: reviewSubmission.id, state: reviewSubmission.state, reusedExistingSubmission },
    releaseGate,
  });
}
