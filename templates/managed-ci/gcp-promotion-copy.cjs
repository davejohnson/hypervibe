'use strict';
const { createPublicKey, verify } = require('node:crypto');

// Only the deployment connection signs, after Hypervibe verifies a completed database copy.
// Use a separate protocol prefix, fixed field order and full destination scope when signing.
function copyPayload({ repository, environment, gcpProjectId, region, job, copyAttemptId, copiedAt }) {
  if (![repository, environment, gcpProjectId, region, job, copyAttemptId, copiedAt].every(value => typeof value === 'string') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !/^[A-Za-z0-9_-]+$/.test(environment) || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(gcpProjectId)
    || !/^[a-z]+-[a-z]+[0-9]$/.test(region) || !/^[a-z][a-z0-9-]{0,62}$/.test(job)
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(copyAttemptId)
    || typeof copiedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(copiedAt)
    || !Number.isFinite(Date.parse(copiedAt)) || new Date(copiedAt).toISOString() !== copiedAt) throw new Error('The Google Cloud promotion copy receipt has an invalid scope or completion time.');
  return Buffer.from(JSON.stringify(['hypervibe-gcp-promotion-copy-v1', repository.toLowerCase(), environment,
    'projects/' + gcpProjectId + '/locations/' + region + '/jobs/' + job, copyAttemptId, copiedAt]));
}
function verifyCopy(receipt, spki, signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{340,1366}={0,2}$/.test(signature)) throw new Error('The database copy signature is missing. Complete a verified copy with the current deployment connection and publish its bindings.');
  const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'rsa' || !verify('RSA-SHA256', copyPayload(receipt), key, Buffer.from(signature, 'base64'))) throw new Error('The database copy signature does not match the reviewed deployment connection and destination.');
}
module.exports = { copyPayload, verifyCopy };
