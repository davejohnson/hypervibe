'use strict';

// Embedded in the pinned release job. Cloud Run generates the execution ID and has no client request ID.
// Atomically reserve one name in the applied Docker package before submitting the non-idempotent command.
async function runPromotionMigration({ current, base, call, image, resource, assertIdentity, assertReady, env }) {
  const { createHash } = await import('node:crypto');
  const { writeFileSync } = await import('node:fs');
  const { repository, environment, copyAttemptId, copiedAt } = JSON.parse(env.HYPERVIBE_MIGRATION_CONTEXT);
  const parent = 'projects/' + env.GCP_PROJECT + '/locations/' + env.GCP_REGION + '/jobs/' + resource;
  const numbered = 'projects/' + env.GCP_PROJECT_NUMBER + '/locations/' + env.GCP_REGION + '/jobs/' + resource;
  const jobUid = env.HYPERVIBE_RESOURCE_UID;
  const command = env.HYPERVIBE_MIGRATION_COMMAND;
  // A different staging run can prove the same image. Reserve the command's actual effect independently of that run.
  const key = createHash('sha256').update(JSON.stringify([repository.toLowerCase(), environment, parent, jobUid, command, image, copyAttemptId ?? null])).digest('hex');
  const marker = 'HYPERVIBE_MIGRATION_ID';
  const sameCommand = c => JSON.stringify(c?.command) === JSON.stringify(['/bin/sh']) && JSON.stringify(c?.args) === JSON.stringify(['-lc', command]);
  function jobContainer(job, requireImage) {
    assertIdentity(job); assertReady(job, 'jobs');
    const containers = job.template?.template?.containers;
    if (containers?.length !== 1 || !sameCommand(containers[0]) || (requireImage && containers[0].image !== image)
      || (job.template.taskCount ?? 1) !== 1 || job.template.template.maxRetries !== 0 || containers[0].env?.some(v => v.name === marker)) {
      throw new Error('The live migration job must run the one reviewed command once on the expected image.');
    }
    return containers[0];
  }
  async function read(response, name) {
    if (!response.ok) throw new Error('Cannot verify ' + name + ' (HTTP ' + response.status + ').');
    return response.json();
  }
  const runApi = 'https://run.googleapis.com/v2/';
  const operationName = name => [parent, numbered].some(job => typeof name === 'string' && name.startsWith(job.split('/jobs/')[0] + '/operations/')
    && /^[a-zA-Z0-9_-]+$/.test(name.split('/operations/')[1]));
  async function waitOperation(op, count) {
    for (let n = 0; !op.done && n < count; n++) {
      if (!operationName(op.name)) throw new Error('Cannot verify the migration operation identity.');
      await new Promise(r => setTimeout(r, 5000));
      op = await read(await call(runApi + op.name), 'the accepted migration operation');
    }
    if (!op.done || op.error) throw new Error('The migration operation did not report success. Inspect the Cloud Run execution.');
    return op.response;
  }
  function exactExecution(e) {
    const job = [parent, numbered].find(p => typeof e.name === 'string' && e.name.startsWith(p + '/executions/'));
    const containers = e.template?.containers;
    const markers = containers?.[0]?.env?.filter(v => v.name === marker);
    if (!job || !/^[a-z][a-z0-9-]{0,62}$/.test(e.name.slice(job.length + '/executions/'.length))
      || ![resource, parent, numbered].includes(e.job) || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(e.uid ?? '') || e.deleteTime
      || containers?.length !== 1 || !sameCommand(containers[0]) || containers[0].image !== image || markers?.length !== 1 || markers[0].value !== key
      || e.taskCount !== 1 || e.template.maxRetries !== 0) throw new Error('The observed execution does not prove this exact migration.');
  }
  async function history() {
    const matches = [];
    const pages = new Set();
    let address = base + '/executions?pageSize=100';
    for (;;) {
      const page = await read(await call(address), 'the migration execution history');
      if (!page || typeof page !== 'object' || Array.isArray(page) || (page.executions !== undefined && !Array.isArray(page.executions))) throw new Error('Incomplete migration execution history.');
      for (const e of page.executions ?? []) {
        if (e?.template?.containers?.some(c => c.env?.some(v => v.name === marker && v.value === key))) { exactExecution(e); matches.push(e); continue; }
        if (!e?.completionTime) throw new Error('Another migration is unfinished. Wait for it before promoting.');
        // Older generated workflows had no durable claim. Their use of this exact command is ambiguous.
        if (e.template?.containers?.some(c => c.image === image && sameCommand(c) && !c.env?.some(v => v.name === marker))
          && !(copyAttemptId && Date.parse(e.completionTime) < Date.parse(copiedAt))) throw new Error('An earlier unmarked execution used this migration. Reconcile its outcome before releasing.');
      }
      if (!page.nextPageToken) break;
      if (typeof page.nextPageToken !== 'string' || pages.has(page.nextPageToken) || pages.size >= 100) throw new Error('Cannot verify the complete migration execution history.');
      pages.add(page.nextPageToken); address = base + '/executions?pageSize=100&pageToken=' + encodeURIComponent(page.nextPageToken);
    }
    if (matches.length > 1) throw new Error('Several executions claim the same migration. Reconcile the job before releasing.');
    return matches[0];
  }
  jobContainer(current, false);
  const host = env.GCP_REGION + '-docker.pkg.dev/' + env.GCP_PROJECT + '/hypervibe/';
  const [pkg, digest] = image.startsWith(host) ? image.slice(host.length).split('@') : [];
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(pkg ?? '') || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Invalid migration image package.');
  const registry = 'https://artifactregistry.googleapis.com/v1/';
  const packageName = 'projects/' + env.GCP_PROJECT + '/locations/' + env.GCP_REGION + '/repositories/hypervibe/packages/' + pkg;
  const tagId = 'hv-migration-' + key;
  const tagName = packageName + '/tags/' + tagId;
  const version = packageName + '/versions/' + digest;
  function checkTag(tag) {
    const numberName = text => text.replace('projects/' + env.GCP_PROJECT + '/', 'projects/' + env.GCP_PROJECT_NUMBER + '/');
    if (![tagName, numberName(tagName)].includes(tag?.name) || ![version, numberName(version)].includes(tag?.version)) throw new Error('The migration reservation differs from the exact image.');
  }
  let execution = await history();
  const found = await call(registry + tagName);
  let claimed = found.status !== 404;
  if (claimed) checkTag(await read(found, 'the migration reservation'));
  if (execution && !claimed) throw new Error('The prior migration execution has lost its durable reservation. Reconcile the release before proceeding.');
  if (!claimed) {
    const template = structuredClone(current.template);
    template.template.containers[0].image = image;
    const patched = await read(await call(base, { method: 'PATCH', body: JSON.stringify({ ...current, template }) }), 'the reviewed migration job update');
    await waitOperation(patched, 200);
    const job = await read(await call(base), 'the updated migration job');
    const container = jobContainer(job, true);
    const claim = await call(registry + packageName + '/tags?tagId=' + tagId, { method: 'POST', body: JSON.stringify({ version }) });
    if (claim.status === 409) {
      checkTag(await read(await call(registry + tagName), 'the concurrent migration reservation'));
      claimed = true;
    } else checkTag(await read(claim, 'a new migration reservation'));
    if (!claimed) {
      const overrides = { containerOverrides: [{ ...(container.name && { name: container.name }), env: [{ name: marker, value: key }] }] };
      // No retry on an ambiguous HTTP response. The durable reservation makes every later dispatch recover-only.
      const started = await read(await call(base + ':run', { method: 'POST', body: JSON.stringify({ etag: job.etag, overrides }) }), 'the accepted migration execution');
      execution = await waitOperation(started, 360);
    }
  }
  if (!execution) execution = await history();
  if (!execution) throw new Error('A prior migration was reserved but its execution cannot be verified. Inspect Cloud Run before continuing.');
  exactExecution(execution);
  const { name, uid } = execution;
  // Read the actual provider resource even when the submission operation reported completion.
  for (let i = 0; i < 360; i++) {
    execution = await read(await call(runApi + name), 'the exact migration execution');
    if (execution.name !== name || execution.uid !== uid) throw new Error('The migration execution identity changed.');
    exactExecution(execution);
    if (execution.completionTime) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  const completed = execution.conditions?.filter(c => c.type === 'Completed');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(execution.completionTime ?? '') || !Number.isFinite(Date.parse(execution.completionTime))
    || (copyAttemptId && !(Date.parse(execution.completionTime) >= Date.parse(copiedAt)))
    || execution.reconciling || execution.succeededCount !== 1 || execution.failedCount > 0 || execution.cancelledCount > 0 || execution.retriedCount > 0
    || completed?.length !== 1 || completed[0].state !== 'CONDITION_SUCCEEDED') throw new Error('The exact migration execution has not completed successfully. Inspect the Cloud Run job.');
  writeFileSync(env.HYPERVIBE_MIGRATION_RECEIPT, JSON.stringify({ key, jobUid, image, execution: name, executionUid: uid,
    completedAt: execution.completionTime, ...(copyAttemptId && { copyAttemptId }) }), { mode: 0o600 });
}
module.exports = { runPromotionMigration };
