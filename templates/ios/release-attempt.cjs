'use strict';

// Shared by the emitted GitHub gates and the App Store submission command.
// Jobs MUST come from /runs/{run.id}/attempts/{run.run_attempt}/jobs.
// Artifact metadata has no attempt number; use creation, never update time.
const fail = () => { throw new Error('Release evidence must be created by the successful job in the current workflow attempt.'); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;

function assertAttemptJobs(run, listing) {
  if (!run || !positive(run.id) || !positive(run.run_attempt) || run.status !== 'completed' || run.conclusion !== 'success'
      || !/^[0-9a-f]{40}$/.test(run.head_sha || '') || !Number.isFinite(time(run.run_started_at))) fail();
  if (!listing || !Array.isArray(listing.jobs) || !Number.isSafeInteger(listing.total_count)
      || listing.total_count < 1 || listing.total_count > 100 || listing.total_count !== listing.jobs.length
      || new Set(listing.jobs.map(job => job?.id)).size !== listing.jobs.length
      || listing.jobs.some(job => !job || !positive(job.id) || job.run_id !== run.id
        || (job.run_attempt !== undefined && job.run_attempt !== run.run_attempt)
        || job.head_sha !== run.head_sha)) fail();
}

function assertCurrentReleaseAttempt(run, artifact, listing, jobName) {
  assertAttemptJobs(run, listing);
  const matches = listing.jobs.filter(job => job.name === jobName);
  if (matches.length !== 1) fail();
  const job = matches[0];
  const start = time(job.started_at), end = time(job.completed_at), created = time(artifact?.created_at);
  if (job.status !== 'completed' || job.conclusion !== 'success' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < time(run.run_started_at) || end < start || !Number.isFinite(created) || created < start || created > end
      || !artifact || !positive(artifact.id) || artifact.expired !== false || artifact.workflow_run?.id !== run.id
      || artifact.workflow_run?.head_sha !== run.head_sha) fail();
}

function assertSkippedIosReleaseAttempt(run, listing) {
  assertAttemptJobs(run, listing);
  if (listing.jobs.length !== 4) fail();
  for (const name of ['eligibility', 'prepare', 'build', 'release']) {
    const jobs = listing.jobs.filter(job => job.name === name);
    if (jobs.length !== 1 || jobs[0].status !== 'completed'
        || jobs[0].conclusion !== (name === 'eligibility' ? 'success' : 'skipped')) fail();
  }
}

function assertSameReleaseAttempt(previous, current) {
  if (!current || current.status !== 'completed' || current.conclusion !== 'success'
      || ['id', 'path', 'head_sha', 'run_attempt', 'run_started_at'].some(key => previous[key] !== current[key])) {
    throw new Error('The selected workflow attempt changed while verifying release evidence.');
  }
}

module.exports = {assertCurrentReleaseAttempt, assertSkippedIosReleaseAttempt, assertSameReleaseAttempt};
