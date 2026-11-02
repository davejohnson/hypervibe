import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CloudInstallationDriver, CloudInstallationSetupReviewV1 } from '../ports/cloud-installation.port.js';
import { CloudInstallationError, parseCloudInstallationRecordV1 } from './cloud-installation-runtime.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const fail = (code = 'scope_mismatch'): never => { throw new CloudInstallationError(code); };
function hosted(driver: CloudInstallationDriver) {
  if (driver.localScopePreparation || driver.artifactPublication || driver.operatorApplication) fail('unsupported');
}
export function cloudInstallationSetupStagesV1(input: { record: unknown; driver: CloudInstallationDriver }) {
  hosted(input.driver);
  const root = parseCloudInstallationRecordV1(input.record, input.driver);
  if (root.intent.mode === 'disconnect' || root.plan.blockedReason || root.status !== 'review-required'
    || root.attempts.length || Object.keys(root.completed).length) fail('not_ready');
  return z.array(z.enum(['scope-preparation', 'collection', 'deployment'])).max(2)
    .parse(input.driver.setup?.continuationStages(root) ?? []);
}
/** Review preparation is value-free and makes no provider calls. The host must
 * persist a separate authenticated approval of its digest before using it. */
export function prepareCloudInstallationSetupV1(input: { record: unknown; driver: CloudInstallationDriver;
  continuationInstallationIds?: string[] }): CloudInstallationSetupReviewV1 {
  hosted(input.driver);
  const root = parseCloudInstallationRecordV1(input.record, input.driver);
  if (root.intent.mode === 'disconnect' || root.plan.blockedReason || root.status !== 'review-required'
    || root.attempts.length || Object.keys(root.completed).length) fail('not_ready');
  const ids = z.array(z.string().guid()).max(2).parse(input.continuationInstallationIds ?? []);
  if (new Set([root.installationId, ...ids]).size !== ids.length + 1) fail();
  if (ids.length && ids.length !== cloudInstallationSetupStagesV1({ record: root, driver: input.driver }).length) fail();
  const extra = ids.length ? input.driver.setup?.preview(root, ids) : undefined;
  if (ids.length && (!extra || !isDeepStrictEqual(extra.stages.map(stage => stage.installationId), ids))) fail('unsupported');
  const value = { schemaVersion: 1 as const, root,
    stages: [{ installationId: root.installationId, stage: root.intent.stage ?? 'collection' as const }, ...(extra?.stages ?? [])],
    review: extra?.review ?? root.plan.review, ...(extra ? { continuation: extra.continuation } : {}) };
  // The approved value crosses a JSON database boundary. Optional undefined
  // properties must not make an otherwise identical review fail after restart.
  return JSON.parse(JSON.stringify({ ...value, digest: createHash('sha256').update(canonical(value)).digest('hex') })) as CloudInstallationSetupReviewV1;
}
/** Recompile the reviewed recipe, so code/permission changes cannot silently
 * broaden an old approval. Historical journals keep their original digests. */
export function parseCloudInstallationSetupV1(value: unknown, driver: CloudInstallationDriver): CloudInstallationSetupReviewV1 {
  hosted(driver);
  if (!value || typeof value !== 'object') fail('invalid_contract');
  const candidate = value as CloudInstallationSetupReviewV1;
  if (!Array.isArray(candidate.stages) || candidate.stages.length < 1 || candidate.stages.length > 3) fail('invalid_contract');
  const expected = prepareCloudInstallationSetupV1({ record: candidate.root, driver,
    continuationInstallationIds: candidate.stages.slice(1).map(stage => stage.installationId) });
  if (!isDeepStrictEqual(value, expected)) fail('plan_mismatch');
  return expected;
}
/** This is not approval creation. The host supplies its previously approved
 * digest and must recheck that approval in its existing authorize callback. */
export function cloudInstallationSetupConfirmationsV1(input: { setup: unknown; approvedDigest: string;
  record: unknown; history?: unknown[]; driver: CloudInstallationDriver }): string[] {
  const setup = parseCloudInstallationSetupV1(input.setup, input.driver);
  if (setup.digest !== input.approvedDigest) fail('confirmation_required');
  const approvedRoot = parseCloudInstallationRecordV1(setup.root, input.driver);
  const record = parseCloudInstallationRecordV1(input.record, input.driver);
  // Read-only reconciliation stops at the next unattempted action with
  // not_installed. That is the normal frontier, not new mutation authority.
  if (record.plan.blockedReason || record.status === 'disconnected'
    || record.status === 'blocked' && record.reason !== 'not_installed') fail('not_ready');
  const selected = setup.stages.find(stage => stage.installationId === record.installationId);
  if (!selected || selected.stage !== (record.intent.stage ?? 'collection')) fail();
  const original = approvedRoot.intent;
  for (const key of ['customerId', 'appId', 'environment', 'source', 'provider', 'purpose', 'mode', 'keys', 'hostIdentity', 'migrationTargets', 'deployment'] as const)
    if (!isDeepStrictEqual(record.intent[key], original[key])) fail();
  // Uncertain/acknowledged writes stay on the existing read-only recovery path.
  // Rejected writes still require the established explicit retry review.
  if (record.plan.actions.some(action => {
    const latest = record.attempts.filter(attempt => attempt.actionId === action.id).at(-1);
    return latest && (latest.status !== 'succeeded' || !record.completed[action.id]);
  })) fail('not_converged');
  if (record.installationId === setup.root.installationId) {
    if (!isDeepStrictEqual(record.intent, approvedRoot.intent) || !isDeepStrictEqual(record.plan, approvedRoot.plan)) fail();
  } else {
    if (!setup.continuation || !input.driver.setup) fail('unsupported');
    const history = (input.history ?? []).map(item => parseCloudInstallationRecordV1(item, input.driver));
    if (new Set(history.map(item => item.installationId)).size !== history.length) fail();
    input.driver.setup!.assertStage({ setup: { ...setup, root: approvedRoot }, record, history });
  }
  // The existing executor confirms the complete non-noop plan before readback.
  // Completed effects retain their identity checks and are never written again.
  return record.plan.actions.filter(action => action.type !== 'noop').map(action => action.id);
}
