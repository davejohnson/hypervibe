import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { Environment } from '../domain/entities/environment.entity.js';
import type { Project } from '../domain/entities/project.entity.js';
import type { BranchDeployReleaseTarget } from '../domain/ports/ci-deploy.port.js';
import { resolveManagedWorkflowContract } from '../domain/services/ci-deploy.service.js';
import { gcpPromotionServiceSources } from '../domain/services/infrastructure-engine-selection.js';
import { releaseSourceRuntimeBase64 } from '../domain/services/github-release-source.js';
import { iosReleaseAttemptRuntimeBase64 } from '../domain/services/ios-release-attempt.js';
import { releaseEvidenceValidationRuntime } from '../domain/services/github-ops.service.js';
import { managedCiReleaseArtifactPrefix, MANAGED_CI_RELEASE_EVIDENCE_FILE } from '../domain/services/managed-ci-evidence.js';
import { PINNED_ACTIONS } from '../domain/services/pinned-actions.js';
import { effectiveBranchCiAutoDeploy, type ProjectSpec } from '../domain/spec/spec.schema.js';
import { environmentDeploymentContractHashForApply } from '../domain/services/deployment-contract.service.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { parseGitHubRepoFromRemote } from '../lib/git-remote.js';
import { assertEngineCiIntent } from '../domain/spec/engine-ci.js';
import { ciReleaseCommand, ciReleaseTargets } from './gcp-ci-workloads.js';
import { ciReleaseIdentity, ciWorkloadIdentityProvider } from '../adapters/providers/gcp/tofu/gcp-ci.backend.js';
import { GCP_PROMOTION_RELEASE_SCRIPT } from '../adapters/providers/gcp/gcp-ci-release-script.js';
import type { EngineBinding } from './infrastructure-engine.js';

export interface GcpPromotionIdentity { repositoryId: string; contractHash: string; uids: Record<string, string> }
type Service = ReturnType<typeof ciReleaseTargets>[number] & { uid: string; sourceService: string };
export interface GcpPromotionContract {
  repository: string; repositoryId: string; environment: string; branch: string; gcpProjectId: string; region: string;
  provider: string; releaseIdentity: string; targetContractHash: string; sourceEnvironment: string; sourceBranch: string;
  sourceWorkflow: string; sourceWorkflowHash: string; sourceWorkflowPaths: string[]; sourceTarget: BranchDeployReleaseTarget; sourceProgram: string;
  sourcePrefix: string; services: Service[]; releaseCommand?: { job: string; service: string; uid: string; command: string };
  tests?: { workflow: string; packageReadToken?: boolean };
}
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
export function projectGcpPromotionUids(state: unknown, project: string, region: string, services: ReturnType<typeof ciReleaseTargets>, releaseJob?: string) {
  type Row = { mode?: string; type?: string; address?: string; tainted?: boolean; values?: { id?: string; uid?: string } };
  const rows = (state as { values?: { root_module?: { resources?: Row[] } } })?.values?.root_module?.resources;
  const uids: Record<string, string> = {};
  const types = { services: 'google_cloud_run_v2_service', jobs: 'google_cloud_run_v2_job', workerPools: 'google_cloud_run_v2_worker_pool' };
  for (const service of [...services, ...(releaseJob ? [{ name: 'release_command', kind: 'jobs' as const, resource: releaseJob }] : [])]) {
    const name = `${service.kind}/${service.resource}`;
    const type = types[service.kind];
    const matches = rows?.filter(row => row.mode === 'managed' && row.type === type && row.tainted !== true
      && row.address === `${type}.${service.name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}` && row.values?.id === `projects/${project}/locations/${region}/${name}`);
    const uid = matches?.length === 1 && matches[0]!.values?.uid;
    if (!uid || !uuid.test(uid) || Object.values(uids).includes(uid)) throw new Error(`Cannot verify the retained Cloud Run identity for ${service.resource}.`);
    uids[name] = uid;
  }
  return uids;
}

/** The release role can update every workload in its Google project. Only the protected workflow may assume it there. */
export function gcpCiReleaseScopes(spec: ProjectSpec, current: string, projectId: string, boundProject: (environment: string) => unknown) {
  const entries = Object.entries(spec.environments).filter(([, env]) => env.hosting.provider === 'cloudrun' && env.deploy?.strategy === 'branch');
  const protectedCi = entries.some(([, env]) => env.deploy?.promoteFrom);
  const scoped = entries.filter(([name, env]) => !protectedCi || (env.hosting.gcpProjectId ?? (name === current ? projectId : boundProject(name))) === projectId);
  if (scoped.length > 1 && scoped.some(([, env]) => env.deploy?.promoteFrom)) {
    throw new Error('The Google Cloud release account has project-wide permissions. Use a separate Google Cloud project for a protected production environment so another release workflow cannot change its workloads.');
  }
  return scoped.sort(([a], [b]) => a.localeCompare(b)).map(([environmentName, env]) => ({
    environmentName, branch: env.deploy!.branch ?? 'main', autoDeploy: effectiveBranchCiAutoDeploy(environmentName, env.deploy!.autoDeploy),
    ...(env.deploy?.promoteFrom && { promotionSource: env.deploy.promoteFrom }),
  }));
}

/** One read-only contract for launch, the manual button and local dispatch. */
export type GcpPromotionWorkflow = GcpPromotionContract & { content: string; path: string };
export function buildGcpPromotionWorkflow(project: Project, spec: ProjectSpec, environment: Environment): GcpPromotionWorkflow | { blocked: string } {
  try {
    const name = environment.name; const target = spec.environments[name]!;
    const mapping = gcpPromotionServiceSources(spec, name);
    const sourceEnvironment = target.deploy!.promoteFrom!;
    const sourceSpec = spec.environments[sourceEnvironment]!;
    const branch = target.deploy!.branch ?? 'main';
    const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl ?? spec.gitRemoteUrl);
    const bindings = environment.platformBindings as { provider?: string; projectId?: string; environmentId?: string; region?: string; engine?: EngineBinding; services?: Parameters<typeof ciReleaseTargets>[1] };
    const engine = bindings.engine; const marker = engine?.promotion; const ci = engine?.ci;
    const gcpProjectId = bindings.projectId; const region = bindings.environmentId;
    if (!repository || !gcpProjectId || !region || environment.projectId !== project.id || bindings.provider !== 'cloudrun' || engine?.kind !== 'opentofu'
      || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(gcpProjectId) || !/^[a-z]+-[a-z]+[0-9]$/.test(region)
      || (target.hosting.gcpProjectId && target.hosting.gcpProjectId !== gcpProjectId) || region !== (target.hosting.region ?? 'us-central1') || (bindings.region && bindings.region !== region)
      || !ci || ci.repository !== repository || ci.releaseIdentity !== ciReleaseIdentity(gcpProjectId)
      || ci.provider !== ciWorkloadIdentityProvider(ci.provider.split('/')[1] ?? '') || !/^projects\/[1-9]\d*\//.test(ci.provider)
      || !marker || !/^[1-9]\d*$/.test(marker.repositoryId) || marker.contractHash !== environmentDeploymentContractHashForApply(spec, name)) {
      throw new Error('Run hv_launch for this promotion target to verify the applied Google Cloud project, CI access and workload identities.');
    }
    const releases = gcpCiReleaseScopes(spec, name, gcpProjectId, env => new EnvironmentRepository().findByProjectAndName(project.id, env)?.platformBindings.projectId);
    if (ci.trust !== createHash('sha256').update(JSON.stringify([marker.repositoryId, repository, releases])).digest('hex')) throw new Error('Run hv_launch to reconcile the reviewed GitHub release identity.');
    assertEngineCiIntent({ environmentName: name, repository, branch });
    const source = resolveManagedWorkflowContract({ project, environmentName: sourceEnvironment, environmentSpec: sourceSpec });
    if (!source.ok) throw new Error(source.error);
    const sourceLock = source.binding;
    if (!source.workflow.supportsImmutableRollback || !source.target.programFingerprint || !source.target.releaseTarget?.scope.providerProjectId || !source.target.releaseTarget.scope.providerEnvironmentId
      || !sourceLock?.contentHash || !/^[a-f0-9]{64}$/.test(sourceLock.contentHash) || (sourceLock.inputHash !== source.inputHash && sourceLock.contentHash !== source.renderedContentHash)) {
      throw new Error(`Reconcile the reviewed ${sourceEnvironment} managed GitHub release workflow and its exact Railway service bindings before promoting.`);
    }
    const paths = [source.workflow.path, ...(source.workflow.companionFiles ?? []).map(file => file.path)].sort();
    if (JSON.stringify([...(sourceLock.managedPaths ?? [source.workflow.path])].sort()) !== JSON.stringify(paths)) throw new Error('The staging workflow file set has changed. Reconcile staging before promoting.');
    const uidFor = (kind: string, resource: string) => {
      const uid = marker.uids[`${kind}/${resource}`];
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(resource) || !uid || !uuid.test(uid)) throw new Error(`Run hv_launch to verify the Cloud Run identity for ${resource}.`);
      return uid;
    };
    const services = ciReleaseTargets(target, bindings.services, { gcpProjectId, region, environmentName: name }).map(service => {
      const identity = bindings.services?.[service.name];
      if (!identity || [identity.serviceId, identity.jobName, identity.workerPoolName].filter(Boolean).length !== 1) throw new Error(`Ambiguous Cloud Run binding for ${service.name}.`);
      const kind = { web: 'services', worker: 'workerPools', cron: 'jobs' }[target.services[service.name]!.workloadKind];
      if (service.kind !== kind || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(`${name}-${service.name}`.toLowerCase())) throw new Error(`Invalid promoted workload identity for ${service.name}.`);
      return { ...service, uid: uidFor(service.kind, service.resource), sourceService: mapping[service.name]! };
    });
    if (services.length !== Object.keys(mapping).length || Object.keys(bindings.services ?? {}).length !== services.length || new Set(services.map(service => service.uid)).size !== services.length) throw new Error('Every production workload requires a distinct applied Google Cloud identity.');
    const command = ciReleaseCommand(target, engine.releaseJob, services);
    if (command && 'blocked' in command) throw new Error(command.blocked);
    const contract: GcpPromotionContract = { repository, repositoryId: marker.repositoryId, environment: name, branch, gcpProjectId, region, sourceEnvironment,
      provider: ci.provider, releaseIdentity: ci.releaseIdentity, sourceBranch: source.workflow.branch, sourceWorkflow: source.workflow.path,
      targetContractHash: marker.contractHash, sourceWorkflowHash: sourceLock.contentHash, sourceWorkflowPaths: paths, sourceTarget: source.target.releaseTarget,
      sourceProgram: source.target.programFingerprint, sourcePrefix: managedCiReleaseArtifactPrefix(sourceEnvironment), services,
      ...(command && { releaseCommand: { ...command, uid: uidFor('jobs', command.job), command: target.migrations!.command!.trim() } }), ...(target.deploy?.promotionTests && { tests: target.deploy.promotionTests }) };
    return { ...contract, content: renderGcpPromotionWorkflow(contract), path: `.github/workflows/hypervibe-release-${name}.yml` };
  } catch (error) { return { blocked: error instanceof Error ? error.message : 'Could not verify the promotion contract.' }; }
}

const encodedTemplate = (name: string) => readFileSync(new URL(`../../templates/managed-ci/${name}.cjs`, import.meta.url)).toString('base64');
const moduleLoader = `const load = name => { const module = {exports: {}}; new Function('require', 'module', 'exports', Buffer.from(process.env[name], 'base64').toString('utf8'))(require, module, module.exports); return module.exports; };
const contract = JSON.parse(Buffer.from(process.env.HV_PROMOTION, 'base64').toString('utf8'));`;

export function renderGcpPromotionWorkflow(contract: GcpPromotionContract): string {
  const read = { actions: 'read', contents: 'read' };
  const sourceSteps = (recheck: boolean) => [
    { name: 'Select the latest verified staging attempt', id: 'staged', uses: 'actions/github-script@v9', with: { script: `${moduleLoader}
const selected = await load('HV_SOURCE').select({github, context, contract, validator: load('HV_VALIDATOR'), provenance: load('HV_PROVENANCE'), attempts: load('HV_ATTEMPTS')});
core.setOutput('selection', JSON.stringify(selected)); core.setOutput('sha', selected.sha); core.setOutput('artifact', String(selected.artifactId)); core.setOutput('run', String(selected.runId));` } },
    { name: 'Download that staging artifact', uses: 'actions/download-artifact@v8', with: { 'artifact-ids': '${{ steps.staged.outputs.artifact }}', 'run-id': '${{ steps.staged.outputs.run }}',
      'github-token': '${{ github.token }}', path: '${{ runner.temp }}/staging-release', 'merge-multiple': true } },
    { name: 'Verify the staged image for every workload', id: 'verified', uses: 'actions/github-script@v9', env: { SELECTION: '${{ steps.staged.outputs.selection }}',
      ...(recheck && { TESTED: '${{ needs.candidate.outputs.candidate }}' }) }, with: { script: `${moduleLoader}
const fs = require('node:fs'); const path = require('node:path');
const file = path.join(process.env.RUNNER_TEMP, 'staging-release', '${MANAGED_CI_RELEASE_EVIDENCE_FILE}');
if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw new Error('The staging release file is invalid.');
const candidate = load('HV_SOURCE').verifyEvidence(contract, JSON.parse(process.env.SELECTION), JSON.parse(fs.readFileSync(file, 'utf8')), load('HV_VALIDATOR'));
const frozen = JSON.stringify(candidate);
${recheck ? "if (frozen !== process.env.TESTED) throw new Error('Staging changed after candidate selection. Dispatch again to test the new release.');\n" : ''}core.setOutput('candidate', frozen);` } },
  ];
  const tests = contract.tests;
  const definition = {
    name: `Promote ${contract.sourceEnvironment} to ${contract.environment}`, on: { workflow_dispatch: {} }, permissions: {},
    concurrency: { group: `hypervibe-release-${contract.environment}`, 'cancel-in-progress': false },
    env: { HV_PROMOTION: Buffer.from(JSON.stringify(contract)).toString('base64'), HV_SOURCE: encodedTemplate('gcp-promotion-source'),
      HV_VALIDATOR: Buffer.from(releaseEvidenceValidationRuntime()).toString('base64'), HV_PROVENANCE: releaseSourceRuntimeBase64, HV_ATTEMPTS: iosReleaseAttemptRuntimeBase64() },
    jobs: {
      candidate: { if: `github.ref == 'refs/heads/${contract.branch}' && github.event_name == 'workflow_dispatch'`, 'runs-on': 'ubuntu-24.04', permissions: read,
        outputs: { sha: '${{ steps.staged.outputs.sha }}', candidate: '${{ steps.verified.outputs.candidate }}' }, steps: sourceSteps(false) },
      ...(tests && { promotion_tests: { needs: 'candidate', uses: `./${tests.workflow}`, permissions: { contents: 'read' }, with: { commit_sha: '${{ needs.candidate.outputs.sha }}' },
        ...(tests.packageReadToken && { secrets: { NODE_AUTH_TOKEN: '${{ secrets.NODE_AUTH_TOKEN }}' } }) } }),
      release: { needs: tests ? ['candidate', 'promotion_tests'] : ['candidate'], 'runs-on': 'ubuntu-24.04', environment: contract.environment,
        permissions: { ...read, packages: 'read', 'id-token': 'write' }, steps: [...sourceSteps(true),
          { id: 'auth', uses: PINNED_ACTIONS.googleAuth.split(' ')[0], with: { workload_identity_provider: contract.provider, service_account: contract.releaseIdentity,
            token_format: 'access_token', create_credentials_file: false, export_environment_variables: false } },
          { name: 'Copy the verified digests, run migrations and release', uses: 'actions/github-script@v9', env: { HV_DEPLOY: encodedTemplate('gcp-promotion-deploy'),
            RELEASE_PROGRAM: Buffer.from(GCP_PROMOTION_RELEASE_SCRIPT).toString('base64'), GCP_TOKEN: '${{ steps.auth.outputs.access_token }}',
            GH_PACKAGES_TOKEN: '${{ github.token }}', CANDIDATE: '${{ steps.verified.outputs.candidate }}' }, with: { script: `${moduleLoader}\nload('HV_DEPLOY').promote(contract, JSON.parse(process.env.CANDIDATE), process.env);` } },
          { name: 'Save the verified production release', uses: 'actions/upload-artifact@v7', with: { name: 'hypervibe-gcp-promotion-v1-${{ github.run_id }}-${{ github.run_attempt }}',
            path: '${{ runner.temp }}/promotion.json', 'if-no-files-found': 'error', 'retention-days': 90 } },
        ] },
    },
  };
  return '# Managed by Hypervibe. Promotes the exact verified staging images.\n' + YAML.stringify(definition, { lineWidth: 0, aliasDuplicateObjects: false });
}
