// Authenticate release code independently of artifact contents and deployment success.
function trustedReleaseHead(ref, branch) {
  if (!branch || ref?.ref !== 'refs/heads/' + branch || ref.object?.type !== 'commit'
      || !/^[0-9a-f]{40}$/.test(ref.object.sha || '')) throw new Error('The configured release source branch could not be verified');
  return ref.object.sha;
}

function matchesReleaseProducer(run, artifact, repository, branch, workflow) {
  const origin = artifact?.workflow_run;
  const expectedRepository = repository.toLowerCase();
  const repositoryId = run?.repository?.id;
  return run?.status === 'completed' && run.conclusion === 'success'
    && ['push', 'workflow_dispatch'].includes(run.event)
    && run.head_branch === branch && (run.path === workflow || run.path === workflow + '@refs/heads/' + branch)
    && String(run.repository?.full_name || '').toLowerCase() === expectedRepository
    && String(run.head_repository?.full_name || '').toLowerCase() === expectedRepository
    && Number.isSafeInteger(repositoryId) && repositoryId > 0 && run.head_repository.id === repositoryId
    && Number.isSafeInteger(run.id) && run.id > 0 && /^[0-9a-f]{40}$/.test(run.head_sha || '')
    && origin?.id === run.id && origin.head_branch === branch && origin.head_sha === run.head_sha
    && origin.repository_id === repositoryId && origin.head_repository_id === repositoryId;
}

// A rerun keeps its original run ID and creation time. Read every page before
// deciding which deployment is current, including a queued retry of an old run.
async function rollbackHistory(readPage, excludeId) {
  const runs = [];
  const ids = new Set();
  let total;
  for (let page = 1; ; page++) {
    const result = await readPage(page);
    if (!Number.isSafeInteger(result.total_count) || result.total_count < 0 || !Array.isArray(result.workflow_runs)
        || (total !== undefined && total !== result.total_count)) throw new Error('Rollback workflow history is incomplete or changed; retry the observation');
    total = result.total_count;
    for (const run of result.workflow_runs) {
      if (!Number.isSafeInteger(run?.id) || run.id <= 0 || ids.has(run.id)) throw new Error('Rollback workflow history is ambiguous; retry the observation');
      ids.add(run.id);
      if (run.id === excludeId) continue;
      if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || !run.status) throw new Error('Rollback deployment attempt is unknown');
      if (run.status === 'completed') {
        const start = Date.parse(run.run_started_at ?? (run.run_attempt === 1 ? run.created_at : ''));
        const end = Date.parse(run.updated_at);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Rollback deployment attempt timing is unknown; inspect the managed workflow in GitHub Actions');
      }
      runs.push(run);
    }
    if (ids.size === total) break;
    if (ids.size > total || result.workflow_runs.length < 100) throw new Error('Rollback workflow history is incomplete; retry the observation');
  }
  if (excludeId !== undefined && !ids.has(excludeId)) throw new Error('The current rollback workflow run is missing from deployment history');
  runs.sort((a, b) => Number(b.status !== 'completed') - Number(a.status !== 'completed')
    || Date.parse(b.updated_at) - Date.parse(a.updated_at));
  if (runs[0]?.status === 'completed') assertRollbackRunOrder(runs[0], runs);
  return runs;
}

function assertRollbackRunOrder(selected, runs) {
  const start = run => Date.parse(run.run_started_at ?? run.created_at);
  const end = run => Date.parse(run.updated_at);
  if (runs.some(run => run.id !== selected.id && run.status === 'completed' && (end(run) === end(selected)
      || ((run.run_attempt > 1 || selected.run_attempt > 1) && start(run) <= end(selected) && start(selected) <= end(run))))) {
    throw new Error('Deployment attempt timing is ambiguous. Inspect the managed runs in GitHub Actions and establish a verified current release before retrying rollback.');
  }
}

// GitHub lists artifacts by run, including artifacts left behind by earlier attempts.
async function rollbackArtifactsForAttempt(run, artifacts, source, attemptContract, readJobs, readRun) {
  const {repository, branch, workflow, prefix} = source;
  const candidates = artifacts.filter(artifact => artifact?.expired === false && Number.isSafeInteger(artifact.id) && artifact.id > 0
    && typeof artifact.name === 'string' && artifact.name.startsWith(prefix) && /^[0-9a-f]{40}$/i.test(artifact.name.slice(prefix.length))
    && matchesReleaseProducer(run, artifact, repository, branch, workflow));
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('Rollback source attempt is unknown');
  if (run.run_attempt === 1 || !candidates.length) return candidates;
  const jobs = await readJobs(run.id, run.run_attempt);
  const matching = candidates.filter(artifact => {
    try {
      attemptContract.assertCurrentReleaseAttempt(run, artifact, jobs, 'deploy');
      return true;
    } catch {
      return false;
    }
  });
  if (matching.length !== 1) throw new Error('Rollback needs exactly one release artifact from the successful deploy job in the selected attempt');
  attemptContract.assertSameReleaseAttempt(run, await readRun(run.id), 'refs/heads/' + branch);
  return matching;
}

async function isCommitOnReleaseBranch(sha, head, compare) {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) return false;
  if (sha === head) return true;
  const result = await compare(sha, head);
  return ['ahead', 'identical'].includes(result?.status)
    && result.base_commit?.sha === sha && result.merge_base_commit?.sha === sha;
}

async function verifyGitHubReleaseSource(github, repo, branch, workflow, run, artifact, applicationSha) {
  if (!matchesReleaseProducer(run, artifact, repo.owner + '/' + repo.repo, branch, workflow)) {
    throw new Error('Release artifact producer does not match the trusted repository, workflow and source branch');
  }
  const ref = await github.rest.git.getRef({...repo, ref: 'heads/' + branch});
  const head = trustedReleaseHead(ref.data, branch);
  const compare = async (base, tip) => (await github.rest.repos.compareCommitsWithBasehead({
    ...repo, basehead: base + '...' + tip, per_page: 1,
  })).data;
  const commits = applicationSha === undefined ? [run.head_sha] : [run.head_sha, applicationSha];
  for (const sha of new Set(commits)) {
    if (!await isCommitOnReleaseBranch(sha, head, compare)) throw new Error('Release source commit is outside the verified release branch');
  }
}

module.exports = {trustedReleaseHead, matchesReleaseProducer, rollbackHistory, assertRollbackRunOrder, rollbackArtifactsForAttempt, isCommitOnReleaseBranch, verifyGitHubReleaseSource};
