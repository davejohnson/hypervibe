'use strict';
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');

async function file(github, repo, path, ref) {
  const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
  if (data?.type !== 'file' || data.path !== path || data.encoding !== 'base64' || !data.content || data.size > 1024 * 1024) throw new Error('Cannot verify reviewed file ' + path);
  const bytes = Buffer.from(data.content, 'base64');
  if (data.size !== bytes.length) throw new Error('Incomplete reviewed file ' + path);
  return bytes.toString('utf8');
}

async function workflowHash(github, repo, paths, sha) {
  const files = await Promise.all(paths.map(async path => ({ path, hash: hash(await file(github, repo, path, sha)) })));
  return files.length === 1 ? files[0].hash : hash(JSON.stringify(files));
}

// Select by deployment order inside the one reviewed workflow, not by the head SHA of its dispatch.
// Listing runs in pages avoids one API request per retained artifact. An older retry can be newest.
async function select({ github, context, contract, provenance, attempts, validator }) {
  const repo = context.repo;
  if (context.eventName !== 'workflow_dispatch' || context.ref !== 'refs/heads/' + contract.branch || contract.repository.toLowerCase() !== (repo.owner + '/' + repo.repo).toLowerCase()) throw new Error('Promotion requires the reviewed manual dispatch and target branch.');
  const { data: info } = await github.rest.repos.get(repo);
  if (String(info.id) !== contract.repositoryId || info.full_name.toLowerCase() !== contract.repository.toLowerCase() || info.default_branch !== contract.branch) throw new Error('The reviewed GitHub repository or default branch changed.');
  const head = await github.rest.git.getRef({ ...repo, ref: 'heads/' + contract.branch });
  if (provenance.trustedReleaseHead(head.data, contract.branch) !== context.sha) throw new Error('The target workflow commit is no longer current. Dispatch the reviewed workflow again.');
  const spec = JSON.parse(await file(github, repo, '.hypervibe/spec.json', context.sha));
  const targetSpec = spec.environments?.[contract.environment]; const stagingSpec = spec.environments?.[contract.sourceEnvironment];
  if (targetSpec?.hosting?.provider !== 'cloudrun' || targetSpec.deploy?.promoteFrom !== contract.sourceEnvironment || (targetSpec.deploy.branch ?? 'main') !== contract.branch
    || targetSpec.deploy.promotionTests?.workflow !== contract.tests?.workflow || Boolean(targetSpec.deploy.promotionTests?.packageReadToken) !== Boolean(contract.tests?.packageReadToken)
    || stagingSpec?.hosting?.provider !== 'railway' || stagingSpec.deploy?.strategy !== 'branch' || (stagingSpec.deploy.branch ?? 'main') !== contract.sourceBranch || stagingSpec.deploy.trigger === 'native') {
    throw new Error('The committed staging source, target or required tests changed. Reconcile the promotion workflow.');
  }
  const bindings = JSON.parse(await file(github, repo, '.hypervibe/bindings.json', context.sha)).environments;
  const target = bindings?.[contract.environment]?.platformBindings; const source = bindings?.[contract.sourceEnvironment]?.platformBindings;
  const marker = target?.engine?.promotion;
  if (validator.deploymentContractFingerprint(spec, contract.environment) !== contract.targetContractHash || marker?.contractHash !== contract.targetContractHash
    || marker.repositoryId !== contract.repositoryId || target.provider !== 'cloudrun' || target.projectId !== contract.gcpProjectId || target.environmentId !== contract.region
    || target.engine.ci?.provider !== contract.provider || target.engine.ci?.releaseIdentity !== contract.releaseIdentity || target.engine.ci?.repository !== contract.repository
    || source?.provider !== 'railway' || source.projectId !== contract.sourceTarget.scope.providerProjectId || source.environmentId !== contract.sourceTarget.scope.providerEnvironmentId
    || source.ci?.deployBranch?.[contract.sourceWorkflow]?.contentHash !== contract.sourceWorkflowHash) throw new Error('The committed spec or release bindings differ from the reviewed promotion. Run hv_launch and commit the reviewed files.');
  for (const item of contract.services) {
    const field = { services: 'serviceId', workerPools: 'workerPoolName', jobs: 'jobName' }[item.kind];
    if (target.services?.[item.name]?.[field] !== item.resource || marker.uids?.[item.kind + '/' + item.resource] !== item.uid) throw new Error('A production workload binding changed.');
  }
  if (contract.releaseCommand && (target.engine.releaseJob !== contract.releaseCommand.job || marker.uids?.['jobs/' + contract.releaseCommand.job] !== contract.releaseCommand.uid)) throw new Error('The production release command binding changed.');
  for (const item of contract.sourceTarget.resources) if (source.services?.[item.logicalName]?.serviceId !== item.providerResourceId) throw new Error('A staging workload binding changed.');
  const [latest] = await provenance.rollbackHistory(async page => {
    if (page > 100) throw new Error('Staging history exceeded the safe observation limit.');
    return (await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: contract.sourceWorkflow.split('/').pop(), per_page: 100, page })).data;
  });
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error('The latest staging deployment has no verified successful release.');
  const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: latest.id })).data;
  attempts.assertSameReleaseAttempt(latest, run, 'refs/heads/' + contract.sourceBranch);
  const listing = (await github.rest.actions.listWorkflowRunArtifacts({ ...repo, run_id: run.id, per_page: 100 })).data;
  if (!Array.isArray(listing.artifacts) || listing.total_count !== listing.artifacts.length) throw new Error('Staging artifact listing is incomplete.');
  const jobs = (await github.rest.actions.listJobsForWorkflowRunAttempt({ ...repo, run_id: run.id, attempt_number: run.run_attempt, per_page: 100 })).data;
  const eligible = listing.artifacts.filter(artifact => {
    if (!artifact.name?.startsWith(contract.sourcePrefix) || !/^[a-f0-9]{40}$/.test(artifact.name.slice(contract.sourcePrefix.length))) return false;
    try { attempts.assertCurrentReleaseAttempt(run, artifact, jobs, 'deploy'); return true; } catch { return false; }
  });
  if (eligible.length !== 1) throw new Error('The successful staging deploy job must have exactly one current, unexpired release artifact.');
  const artifact = eligible[0]; const sha = artifact.name.slice(contract.sourcePrefix.length);
  if (String(run.repository?.id) !== contract.repositoryId) throw new Error('The staging producer belongs to another repository.');
  await provenance.verifyGitHubReleaseSource(github, repo, contract.sourceBranch, contract.sourceWorkflow, run, artifact, sha);
  const sourceHead = provenance.trustedReleaseHead((await github.rest.git.getRef({ ...repo, ref: 'heads/' + contract.sourceBranch })).data, contract.sourceBranch);
  for (const ref of new Set([sourceHead, run.head_sha])) {
    if (await workflowHash(github, repo, contract.sourceWorkflowPaths, ref) !== contract.sourceWorkflowHash) throw new Error('The staging producer differs from its reviewed workflow.');
  }
  const sourceSpec = JSON.parse(await file(github, repo, '.hypervibe/spec.json', sha));
  const deploymentContract = validator.deploymentContractFingerprint(sourceSpec, contract.sourceEnvironment);
  attempts.assertSameReleaseAttempt(run, (await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id })).data, 'refs/heads/' + contract.sourceBranch);
  return { environment: contract.sourceEnvironment, sha, runId: run.id, runAttempt: run.run_attempt, artifactId: artifact.id, deploymentContract };
}

function verifyEvidence(contract, selection, evidence, validator) {
  const source = contract.sourceTarget;
  const expected = validator.expectedReleaseTarget('railway', contract.sourceEnvironment, JSON.stringify(source.resources.map(item => item.logicalName)), JSON.stringify(source.scope), JSON.stringify(source.resources), source.bindingsFingerprint);
  if (evidence.source?.repository?.toLowerCase() !== contract.repository.toLowerCase()) throw new Error('The staged release belongs to another repository.');
  const verified = validator.validateReleaseEvidence(evidence, { label: 'Staging', provider: 'railway', environment: contract.sourceEnvironment,
    repository: evidence.source.repository, sha: selection.sha, target: expected, programFingerprint: contract.sourceProgram,
    deploymentContractFingerprint: selection.deploymentContract, requireImmutableImage: true });
  const images = Object.fromEntries(verified.resources.map(item => [item.logicalName, item.imageUri]));
  const prefix = 'ghcr.io/' + contract.repository.toLowerCase() + '@';
  const deployments = contract.services.map(service => {
    const sourceImage = images[service.sourceService];
    if (typeof sourceImage !== 'string' || !sourceImage.startsWith(prefix) || !/^sha256:[a-f0-9]{64}$/.test(sourceImage.slice(prefix.length))) throw new Error('Staged image must be the immutable GHCR image for the reviewed repository.');
    return { name: service.name, sourceImage, image: service.image + '@' + sourceImage.slice(prefix.length) };
  });
  const { deploymentContract, ...sourceRun } = selection;
  return { source: sourceRun, deployments };
}
module.exports = { select, verifyEvidence };
