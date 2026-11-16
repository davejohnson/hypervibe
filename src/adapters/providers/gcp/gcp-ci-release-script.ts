/**
 * The program a generated GitHub Actions release runs on Google Cloud: switch one
 * Cloud Run workload to a new image under its etag, wait for the rollout, and
 * check health; for a release command, also run the job and wait for it. It mirrors releaseImage in gcp-cloud-run.client.ts and must keep
 * the same guarantees; it is plain JavaScript because it runs in the workflow,
 * not in Hypervibe.
 */
export const RELEASE_SCRIPT = String.raw`
const [resource, image, healthPath, kind = 'services', startCommand = '-'] = process.argv.slice(2);
const token = process.env.GCP_TOKEN;
const base = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT + '/locations/' + process.env.GCP_REGION + '/' + kind + '/' + resource;
const call = async (url, init = {}) => fetch(url, { ...init, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
const isJob = kind === 'jobs';
const current = await (await call(base)).json();
const containers = ((isJob ? current.template?.template?.containers : current.template?.containers) ?? []).map((c) => ({ ...c }));
if (containers.length !== 1) throw new Error('Workload must have exactly one container.');
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
const after = await (await call(base)).json();
const running = isJob ? after.template?.template?.containers?.[0]?.image : after.template?.containers?.[0]?.image;
if (running !== image || (!isJob && after.latestReadyRevision !== after.latestCreatedRevision)) throw new Error('The new image is not active.');
// A release command (migrations) runs now on the new image and must succeed before any service is switched.
if (isJob && process.env.HYPERVIBE_RUN_JOB === '1') {
  const started = await call(base + ':run', { method: 'POST', body: '{}' });
  if (!started.ok) throw new Error('The release command could not start (HTTP ' + started.status + '): ' + ((await started.json().catch(() => ({}))).error?.message ?? 'no details') + '. No service was switched.');
  let run = await started.json();
  for (let i = 0; i < 360 && !run.done; i++) { await new Promise((r) => setTimeout(r, 5000)); const polled = await call('https://run.googleapis.com/v2/' + run.name); if (polled.ok) run = await polled.json(); }
  if (!run.done) throw new Error('The release command did not finish within 30 minutes. No service was switched.');
  if (run.error || (run.response?.failedCount ?? 0) > 0) throw new Error('The release command failed: ' + (run.error?.message ?? 'see the job logs in Cloud Run') + '. No service was switched.');
  console.log('Release command finished on ' + image);
  process.exit(0);
}
if (!isJob && healthPath) {
  const response = await fetch(new URL(healthPath, after.uri));
  if (response.status >= 500) throw new Error(healthPath + ' returned HTTP ' + response.status);
  console.log('Health ' + healthPath + ': HTTP ' + response.status);
}
console.log('Released ' + image + ' to ' + resource + (isJob ? ' (next scheduled run)' : after.uri ? ' at ' + after.uri : ''));
`.trim();
