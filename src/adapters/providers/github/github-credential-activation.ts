import { createRequire } from 'node:module';
import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { AuditRepository } from '../../db/repositories/audit.repository.js';
import type { CiLifecyclePort } from '../../../domain/registry/devops.registry.js';
import { acceptManagedCredentialActivation, parseRuntimeRolloutBindings, pendingCredentialOperations } from '../../../domain/services/runtime-rollout.service.js';
import { getGitHubAdapter, releaseEvidenceValidationRuntime } from '../../../domain/services/github-ops.service.js';
import { observeManagedWorkflowFiles, resolveManagedWorkflowContract, workflowFilesContentHash } from '../../../domain/services/ci-deploy.service.js';
import { environmentDeploymentContractHashForApply } from '../../../domain/services/deployment-contract.service.js';
import { MANAGED_CI_RELEASE_EVIDENCE_FILE, managedCiReleaseArtifactName } from '../../../domain/services/managed-ci-evidence.js';
import { parseGitHubRepoFromRemote } from '../../../lib/git-remote.js';

function connection(project: Parameters<NonNullable<CiLifecyclePort['prepareCredentialRollout']>>[0]['project']) {
  const repository = parseGitHubRepoFromRemote(project.gitRemoteUrl);
  if (!repository) throw new Error('Credential rollout requires the exact reviewed GitHub repository.');
  const resolved = getGitHubAdapter(repository);
  if ('error' in resolved) throw new Error('Credential rollout requires a verified repository-scoped GitHub connection.');
  const [owner, repo] = repository.split('/');
  return { repository, owner, repo, adapter: resolved.adapter };
}

export const prepareGitHubCredentialRollout: NonNullable<CiLifecyclePort['prepareCredentialRollout']> = async params => {
  if (params.inputs?.credential_operations !== undefined) throw new Error('credential_operations is reserved for the accepted Hypervibe credential plan.');
  const environments = new EnvironmentRepository().findByProjectId(params.project.id).filter(environment => Object.keys(pendingCredentialOperations(environment)).length);
  if (!environments.length) return params.inputs ?? {};
  const context = connection(params.project);
  const definition = await context.adapter.getWorkflow(context.owner, context.repo, params.definition);
  if (definition.state !== 'active' || typeof definition.path !== 'string') throw new Error('The selected credential rollout definition is not active.');
  for (const environment of environments) {
    const environmentSpec = params.spec.environments[environment.name];
    if (!environmentSpec) continue;
    const contract = resolveManagedWorkflowContract({ project: params.project, environmentName: environment.name, environmentSpec, environment });
    if (!contract.ok || contract.workflow.path !== definition.path) continue;
    if (params.ref !== contract.workflow.branch || params.inputs?.rollback === 'true') throw new Error('Credential activation requires the exact reviewed deploy branch and a forward deployment.');
    const observation = await observeManagedWorkflowFiles({ ...context, contract });
    if (observation.acceptance === 'drift' || !observation.liveContentHash
      || !observation.desiredFiles.some(file => file.path === contract.workflow.path && file.content.includes('credential_operations:'))) throw new Error('Publish and review the managed credential rollout workflow through hv_plan and hv_apply first.');
    return { ...params.inputs, credential_operations: JSON.stringify(pendingCredentialOperations(environment)) };
  }
  // Unrelated workflows have no authority to claim credential activation.
  return params.inputs ?? {};
};

export const observeGitHubCredentialRollout: NonNullable<CiLifecyclePort['observeCredentialRollout']> = async params => {
  if (!/^[1-9][0-9]*$/.test(params.runId) || !Number.isSafeInteger(Number(params.runId))) throw new Error('Invalid managed credential run identity.');
  const environments = new EnvironmentRepository().findByProjectId(params.project.id).filter(environment => Object.keys(pendingCredentialOperations(environment)).length);
  if (!environments.length) return [];
  const context = connection(params.project);
  const run = await context.adapter.getWorkflowRun(context.owner, context.repo, Number(params.runId));
  if (run.id !== Number(params.runId) || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'success'
    || run.event !== 'workflow_dispatch' || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || run.repository?.full_name !== context.repository || run.head_repository?.full_name !== context.repository) throw new Error('The run does not prove a successful reviewed credential deployment.');
  const results: Awaited<ReturnType<NonNullable<CiLifecyclePort['observeCredentialRollout']>>> = [];
  for (const environment of environments) {
    const environmentSpec = params.spec.environments[environment.name];
    if (!environmentSpec) continue;
    const contract = resolveManagedWorkflowContract({ project: params.project, environmentName: environment.name, environmentSpec, environment });
    if (!contract.ok || contract.workflow.path !== run.path) continue;
    if (run.head_branch !== contract.workflow.branch) throw new Error('The credential release came from a different branch.');
    const ref = await context.adapter.getRef(context.owner, context.repo, `heads/${contract.workflow.branch}`);
    if (ref?.ref !== `refs/heads/${contract.workflow.branch}` || !/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error('The exact managed source branch could not be verified.');
    if (run.head_sha !== ref.object.sha) {
      const comparison = await context.adapter.compareCommits(context.owner, context.repo, run.head_sha, ref.object.sha);
      if (!['ahead', 'identical'].includes(comparison.status) || comparison.behind_by !== 0) throw new Error('The release producer commit is not in the exact managed source branch.');
    }
    const operations = pendingCredentialOperations(environment);
    const startedAt = Date.parse(run.run_started_at ?? '');
    if (!Number.isFinite(startedAt) || parseRuntimeRolloutBindings(environment).some(binding => binding.operationId && operations[binding.service]?.operationId === binding.operationId
      && (!Number.isFinite(Date.parse(binding.requiredAt)) || startedAt < Date.parse(binding.requiredAt)))) throw new Error('Managed run predates accepted credential configuration.');
    const history = environment.platformBindings.credentialUpdates;
    if (history && typeof history === 'object') for (const value of Object.values(history)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (Object.values(operations).some(operation => operation.operationId === entry.planId)
        && (entry.state !== 'accepted' || typeof entry.acceptedAt !== 'string' || !Number.isFinite(Date.parse(entry.acceptedAt)) || startedAt < Date.parse(entry.acceptedAt))) throw new Error('Managed run does not follow complete credential acceptance.');
    }
    const observation = await observeManagedWorkflowFiles({ ...context, contract });
    if (observation.acceptance === 'drift' || !observation.liveContentHash) throw new Error('The managed credential producer requires reviewed publication.');
    const producerFiles = await Promise.all(observation.desiredFiles.map(async file => ({ path: file.path, content: await context.adapter.getFileContent(context.owner, context.repo, file.path, run.head_sha) })));
    if (producerFiles.some(file => file.content === null) || workflowFilesContentHash(producerFiles as Array<{ path: string; content: string }>) !== observation.liveContentHash) throw new Error('The exact release producer differs from the reviewed program.');
    const artifacts = await context.adapter.listWorkflowRunArtifacts(context.owner, context.repo, run.id);
    if (artifacts.total_count !== artifacts.artifacts.length) throw new Error('Complete managed release artifact coverage is unknown.');
    const prefix = managedCiReleaseArtifactName(environment.name, '');
    const matches = artifacts.artifacts.filter(artifact => artifact.name.startsWith(prefix));
    if (!matches.length) continue;
    if (matches.length !== 1) throw new Error('Managed credential release artifact identity is ambiguous.');
    const artifact = matches[0];
    if (artifact.expired || artifact.workflow_run?.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha
      || !Number.isSafeInteger(artifact.workflow_run.repository_id) || artifact.workflow_run.repository_id! <= 0
      || artifact.workflow_run.repository_id !== artifact.workflow_run.head_repository_id) throw new Error('Managed credential artifact provenance is incomplete.');
    const files = await context.adapter.readArtifactFiles(context.owner, context.repo, artifact.id);
    if (Object.keys(files).length !== 1 || !Object.hasOwn(files, MANAGED_CI_RELEASE_EVIDENCE_FILE)) throw new Error('Managed credential artifact contents are incomplete.');
    let evidence: any;
    try { evidence = JSON.parse(files[MANAGED_CI_RELEASE_EVIDENCE_FILE]); } catch { throw new Error('Managed credential release evidence is malformed.'); }
    const sha = evidence?.source?.sha;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || artifact.name !== managedCiReleaseArtifactName(environment.name, sha)) throw new Error('Managed credential release source identity is inconsistent.');
    const module = { exports: {} as { validateReleaseEvidence(evidence: unknown, expected: Record<string, unknown>): unknown } };
    new Function('require', 'module', 'exports', releaseEvidenceValidationRuntime())(createRequire(import.meta.url), module, module.exports);
    module.exports.validateReleaseEvidence(evidence, { label: 'Credential activation', provider: environmentSpec.hosting.provider, environment: environment.name,
      repository: context.repository, sha, target: contract.target.releaseTarget, programFingerprint: contract.target.programFingerprint,
      deploymentContractFingerprint: environmentDeploymentContractHashForApply(params.spec, environment.name), requireImmutableImage: false });
    if (!evidence.credentialActivation) continue;
    const accepted = acceptManagedCredentialActivation({ environment, provider: environmentSpec.hosting.provider, evidence: evidence.credentialActivation, expectedOperations: operations });
    if (accepted.length) new AuditRepository().create({ action: 'credential.activation.deployment-evidence', resourceType: 'environment', resourceId: environment.id,
      details: { provider: environmentSpec.hosting.provider, ciProvider: 'github-actions', runId: run.id, artifactId: artifact.id, operations: accepted } });
    results.push(...accepted);
  }
  return results;
};
