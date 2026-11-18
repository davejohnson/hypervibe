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
    && run.head_branch === branch && run.path === workflow
    && String(run.repository?.full_name || '').toLowerCase() === expectedRepository
    && String(run.head_repository?.full_name || '').toLowerCase() === expectedRepository
    && Number.isSafeInteger(repositoryId) && repositoryId > 0 && run.head_repository.id === repositoryId
    && Number.isSafeInteger(run.id) && run.id > 0 && /^[0-9a-f]{40}$/.test(run.head_sha || '')
    && origin?.id === run.id && origin.head_branch === branch && origin.head_sha === run.head_sha
    && origin.repository_id === repositoryId && origin.head_repository_id === repositoryId;
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

module.exports = {trustedReleaseHead, matchesReleaseProducer, isCommitOnReleaseBranch, verifyGitHubReleaseSource};
