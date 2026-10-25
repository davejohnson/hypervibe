import { EnvironmentRepository } from '../../db/repositories/environment.repository.js';
import { AuditRepository } from '../../db/repositories/audit.repository.js';
import type { CiLifecyclePort } from '../../../domain/registry/devops.registry.js';
import { acceptManagedCredentialActivation, parseRuntimeRolloutBindings, pendingCredentialOperations } from '../../../domain/services/runtime-rollout.service.js';
import { observeGitLabManagedProgram, verifyGitLabCredentialProducer } from './gitlab-ci.lifecycle.js';
import { readGitLabManagedReleaseEvidence } from './gitlab-ci.rollback.js';

export const prepareGitLabCredentialRollout: NonNullable<CiLifecyclePort['prepareCredentialRollout']> = async params => {
  if (params.inputs?.credential_operations !== undefined) throw new Error('credential_operations is reserved for the accepted Hypervibe credential plan.');
  const environments = new EnvironmentRepository().findByProjectId(params.project.id);
  const selected = params.inputs?.environment ?? params.spec.devops?.canonicalEnvironment
    ?? (Object.keys(params.spec.environments).length === 1 ? Object.keys(params.spec.environments)[0] : undefined);
  const environment = environments.find(environment => environment.name === selected);
  if (!environment) {
    if (environments.some(environment => Object.keys(pendingCredentialOperations(environment)).length)) throw new Error('Select the exact managed environment before dispatching credential activation.');
    return params.inputs ?? {};
  }
  const operations = pendingCredentialOperations(environment);
  if (!Object.keys(operations).length) return params.inputs ?? {};
  const program = await observeGitLabManagedProgram({ project: params.project, spec: params.spec, environmentName: environment.name });
  if ('error' in program) throw new Error(program.error);
  if (![program.rootPath, 'pipeline'].includes(params.definition) || params.ref !== program.ref || params.inputs?.rollback === 'true') throw new Error('Credential activation requires the exact reviewed deploy definition and branch.');
  return { ...params.inputs, environment: environment.name, credential_operations: JSON.stringify(operations) };
};

export const observeGitLabCredentialRollout: NonNullable<CiLifecyclePort['observeCredentialRollout']> = async params => {
  const results: Awaited<ReturnType<NonNullable<CiLifecyclePort['observeCredentialRollout']>>> = [];
  for (const environment of new EnvironmentRepository().findByProjectId(params.project.id)) {
    const operations = pendingCredentialOperations(environment);
    if (!Object.keys(operations).length) continue;
    const program = await observeGitLabManagedProgram({ project: params.project, spec: params.spec, environmentName: environment.name });
    if ('error' in program) throw new Error(program.error);
    const observed = await program.adapter.observeManagedCredentialRun(program.repository, params.runId, program.ref);
    if (observed.state !== 'present') continue;
    const run = observed.value;
    const startedAt = Date.parse(run.createdAt ?? '');
    const bindings = parseRuntimeRolloutBindings(environment);
    const required = bindings.filter(binding => binding.operationId && operations[binding.service]?.operationId === binding.operationId);
    if (!Number.isFinite(startedAt) || required.some(binding => !Number.isFinite(Date.parse(binding.requiredAt)) || startedAt < Date.parse(binding.requiredAt))) throw new Error('Managed run predates accepted credential configuration.');
    const history = environment.platformBindings.credentialUpdates;
    if (history && typeof history === 'object') for (const value of Object.values(history)) {
      const entry = value as Record<string, unknown>;
      if (Object.values(operations).some(operation => operation.operationId === entry.planId)
        && (entry.state !== 'accepted' || typeof entry.acceptedAt !== 'string' || startedAt < Date.parse(entry.acceptedAt))) throw new Error('Managed run does not follow complete credential acceptance.');
    }
    if (!await verifyGitLabCredentialProducer({ project: params.project, spec: params.spec, program, sha: run.sha })) throw new Error('Managed release producer differs from the reviewed program at its exact source commit.');
    const jobs = await program.adapter.listJobs(program.repository, run.id, 100);
    if (jobs.length >= 100) throw new Error('Complete managed deploy job coverage is unknown.');
    const matches = jobs.filter(job => job.name === program.deployJobName && job.attempt !== 'retried');
    if (matches.length !== 1 || matches[0].phase !== 'succeeded') continue;
    const release = await readGitLabManagedReleaseEvidence({ observation: program, environmentName: environment.name, run, job: matches[0] });
    if (!release?.credentialActivation) continue;
    const accepted = acceptManagedCredentialActivation({ environment, provider: program.hostingProvider, evidence: release.credentialActivation, expectedOperations: operations });
    if (accepted.length) new AuditRepository().create({ action: 'credential.activation.deployment-evidence', resourceType: 'environment', resourceId: environment.id,
      details: { provider: program.hostingProvider, ciProvider: 'gitlab-ci', runId: run.id, artifactId: release.artifactId, operations: accepted } });
    results.push(...accepted);
  }
  return results;
};
