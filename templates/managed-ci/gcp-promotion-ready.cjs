'use strict';
// Cloud Run v2 returns either short revision names or scoped revision paths. Resolve both inside this workload.
function assertGcpPromotionWorkloadReady(value, kind) {
  if (!value.generation || value.observedGeneration !== value.generation || value.reconciling || value.terminalCondition?.state !== 'CONDITION_SUCCEEDED') throw new Error('Cloud Run has not confirmed a successful rollout.');
  if (kind === 'jobs') return;
  function revisionId(name) {
    if (typeof name !== 'string') return undefined;
    const id = name.split('/').pop();
    return /^[a-z][a-z0-9-]*$/.test(id) && (name === id || name === value.name + '/revisions/' + id) ? id : undefined;
  }
  const latest = revisionId(value.latestReadyRevision);
  if (!latest || latest !== revisionId(value.latestCreatedRevision)) throw new Error('Cloud Run has not confirmed its newest ready revision.');
  const splits = kind === 'services' ? value.trafficStatuses : value.instanceSplitStatuses;
  const allocation = kind === 'services' ? 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' : 'INSTANCE_SPLIT_ALLOCATION_TYPE_LATEST';
  if (!Array.isArray(splits) || splits.length !== 1 || splits[0].type !== allocation || splits[0].percent !== 100 || revisionId(splits[0].revision) !== latest) throw new Error('Cloud Run has not assigned the full rollout to the latest revision.');
}
module.exports = { assertGcpPromotionWorkloadReady };
