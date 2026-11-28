import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const readyModule = new URL('../../../../templates/managed-ci/gcp-promotion-ready.cjs', import.meta.url);
export const { assertGcpPromotionWorkloadReady } = createRequire(import.meta.url)(fileURLToPath(readyModule)) as {
  assertGcpPromotionWorkloadReady(value: Record<string, unknown>, kind: 'services' | 'jobs' | 'workerPools'): void;
};

/**
 * The program a generated GitHub Actions release runs on Google Cloud: switch one
 * Cloud Run workload to a new image under its etag, wait for the rollout, and
 * check health; for a release command, also run the job and wait for it. It mirrors releaseImage in gcp-cloud-run.client.ts and must keep
 * the same guarantees; it is plain JavaScript because it runs in the workflow,
 * not in Hypervibe.
 */
function releaseScript(promotion: boolean): string { return String.raw`
const [resource, image, healthPath, kind = 'services', startCommand = '-'] = process.argv.slice(2);
const token = process.env.GCP_TOKEN;
const base = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT + '/locations/' + process.env.GCP_REGION + '/' + kind + '/' + resource;
const call = async (url, init = {}) => fetch(url, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
const isJob = kind === 'jobs';
const current = await (await call(base)).json();${promotion ? GCP_IDENTITY_CHECK : ''}
const containers = ((isJob ? current.template?.template?.containers : current.template?.containers) ?? []).map((c) => ({ ...c }));
if (containers.length !== 1) throw new Error('Workload must have exactly one container.');${promotion ? GCP_PREFLIGHT : ''}
containers[0].image = image;
// Services and workers get their start command with the image ('-' keeps what is there, '' means the image's own).
if (!isJob && startCommand !== '-') {
  delete containers[0].command; delete containers[0].args;
  const command = Buffer.from(startCommand, 'base64').toString('utf8').trim();
  if (command) { containers[0].command = ['/bin/sh']; containers[0].args = ['-lc', command]; }
}
// Only the image and its start command change; the etag makes a concurrent infrastructure change fail this release instead of being overwritten.
// Jobs take the whole resource back; services accept a mask limited to the containers.
const body = isJob ? { ...current, template: { ...current.template, template: { ...current.template.template, containers } } } : { etag: current.etag, template: { containers } };
const patch = await call(isJob ? base : base + '?updateMask=template.containers', { method: 'PATCH', body: JSON.stringify(body) });
if (patch.status === 409 || patch.status === 412) throw new Error('The workload changed while releasing. Nothing was overwritten; re-run this workflow.');
if (!patch.ok) throw new Error('Cloud Run rejected the release (HTTP ' + patch.status + '): ' + ((await patch.json().catch(() => ({}))).error?.message ?? 'no details'));
let operation = await patch.json();
for (let i = 0; i < 200 && !operation.done; i++) { await new Promise((r) => setTimeout(r, 3000)); operation = await (await call('https://run.googleapis.com/v2/' + operation.name)).json(); }
if (!operation.done || operation.error) throw new Error('Rollout failed: ' + (operation.error?.message ?? 'did not finish'));
const after = await (await call(base)).json();${promotion ? '\nassertIdentity(after); assertGcpPromotionWorkloadReady(after, kind);' : ''}
const running = isJob ? after.template?.template?.containers?.[0]?.image : after.template?.containers?.[0]?.image;
if (running !== image${promotion ? '' : ' || (!isJob && after.latestReadyRevision !== after.latestCreatedRevision)'}) throw new Error('The new image is not active.');
// A release command (migrations) runs now on the new image and must succeed before any service is switched.
if (isJob && process.env.HYPERVIBE_RUN_JOB === '1') {
  // A run of this exact image that is still going (an earlier attempt of this workflow) is waited on, never doubled.
  const listed = await call(base + '/executions?pageSize=100');
  if (!listed.ok) throw new Error('Earlier release command runs could not be read (HTTP ' + listed.status + '), so nothing was started. Re-run this workflow. No service was switched.');
  const going = ${promotion ? 'await checkRunningCommands(listed)' : '((await listed.json()).executions ?? []).find((e) => !e.completionTime && e.template?.containers?.[0]?.image === image)'};
  if (going) {
    let execution = going;
    for (let i = 0; i < 360 && !execution.completionTime; i++) { await new Promise((r) => setTimeout(r, Number(process.env.HYPERVIBE_POLL_MS ?? 5000))); const polled = await call('https://run.googleapis.com/v2/' + going.name); if (polled.ok) execution = await polled.json(); }
    if (!execution.completionTime) throw new Error('The release command did not finish within 30 minutes. No service was switched.');
    if (!(execution.succeededCount > 0) || execution.failedCount > 0 || execution.cancelledCount > 0) throw new Error('The release command failed: see the job logs in Cloud Run. No service was switched.');
    console.log('Release command (already running) finished on ' + image);
    process.exit(0);
  }
  const started = await call(base + ':run', { method: 'POST', body: ${promotion ? 'JSON.stringify({ etag: after.etag })' : "'{}'"} });
  if (!started.ok) throw new Error('The release command could not start (HTTP ' + started.status + '): ' + ((await started.json().catch(() => ({}))).error?.message ?? 'no details') + '. No service was switched.');
  let run = await started.json();
  for (let i = 0; i < 360 && !run.done; i++) { await new Promise((r) => setTimeout(r, 5000)); const polled = await call('https://run.googleapis.com/v2/' + run.name); if (polled.ok) run = await polled.json(); }
  if (!run.done) throw new Error('The release command did not finish within 30 minutes. No service was switched.');
  if (run.error || (run.response?.failedCount ?? 0) > 0) throw new Error('The release command failed: ' + (run.error?.message ?? 'see the job logs in Cloud Run') + '. No service was switched.');
  ${promotion ? "if (!run.response?.name?.startsWith(after.name + '/executions/') || run.response.template?.containers?.[0]?.image !== image || JSON.stringify(run.response.template.containers[0].args) !== JSON.stringify(['-lc', process.env.HYPERVIBE_MIGRATION_COMMAND]) || JSON.stringify(run.response.template.containers[0].command) !== JSON.stringify(['/bin/sh']) || !run.response.completionTime || run.response.cancelledCount > 0) throw new Error('The completed migration execution does not prove the exact promoted image.');\n  " : ''}if (!((run.response?.succeededCount ?? 0) > 0)) throw new Error('The release command did not report a successful run. No service was switched.');
  console.log('Release command finished on ' + image);
  process.exit(0);
}
if (!isJob && healthPath) {
  const response = await fetch(new URL(healthPath, after.uri));
  // Mirrors healthCheckFailed in release-health.ts: a declared path on a public service must answer below 400.
  if (response.status >= (process.env.HYPERVIBE_HEALTH_STRICT === '1' ? 400 : 500)) throw new Error(healthPath + ' returned HTTP ' + response.status);
  console.log('Health ' + healthPath + ': HTTP ' + response.status);
}
console.log('Released ' + image + ' to ' + resource + (isJob ? ' (next scheduled run)' : after.uri ? ' at ' + after.uri : ''));
`.trim(); }

// These checks are opt-in so existing branch-release workflows retain their reviewed bytes.
const GCP_IDENTITY_CHECK = String.raw`
function assertIdentity(value) {
  const name = 'projects/' + process.env.GCP_PROJECT + '/locations/' + process.env.GCP_REGION + '/' + kind + '/' + resource;
  const numberName = 'projects/' + process.env.GCP_PROJECT_NUMBER + name.slice(name.indexOf('/locations/'));
  if ((value.name !== name && value.name !== numberName) || !process.env.HYPERVIBE_RESOURCE_UID || value.uid !== process.env.HYPERVIBE_RESOURCE_UID || !value.etag || value.deleteTime) throw new Error('The live Cloud Run resource differs from its applied identity.');
}
${assertGcpPromotionWorkloadReady.toString()}
assertIdentity(current);
assertGcpPromotionWorkloadReady(current, kind);
`;
const GCP_PREFLIGHT = String.raw`
if (process.env.HYPERVIBE_MIGRATION_COMMAND && (JSON.stringify(containers[0].command) !== JSON.stringify(['/bin/sh'])
  || JSON.stringify(containers[0].args) !== JSON.stringify(['-lc', process.env.HYPERVIBE_MIGRATION_COMMAND]))) throw new Error('The applied job command differs from the reviewed production migration.');
if (process.env.HYPERVIBE_VERIFY_IMAGE === '1') {
  if (containers[0].image !== image) throw new Error('A workload changed before production release verification finished.');
  process.exit(0);
}
if (process.env.HYPERVIBE_PREFLIGHT === '1') process.exit(0);
async function checkRunningCommands(response) {
  const seen = new Set();
  for (;;) {
    if (!response.ok) throw new Error('Cannot verify earlier migration executions.');
    const page = await response.json();
    if (!page || typeof page !== 'object' || Array.isArray(page) || (page.executions !== undefined && !Array.isArray(page.executions))
      || (page.executions ?? []).some(job => !job?.completionTime)) throw new Error('An earlier migration execution is unfinished or unknown. Check it before retrying.');
    if (!page.nextPageToken) return undefined;
    if (typeof page.nextPageToken !== 'string' || seen.has(page.nextPageToken) || seen.size >= 100) throw new Error('Cannot verify the complete migration execution history.');
    seen.add(page.nextPageToken); response = await call(base + '/executions?pageSize=100&pageToken=' + encodeURIComponent(page.nextPageToken));
  }
}
`;
export const RELEASE_SCRIPT = releaseScript(false);
export const GCP_PROMOTION_RELEASE_SCRIPT = releaseScript(true);
