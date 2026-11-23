import { isDeepStrictEqual as equal } from 'node:util';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import { BUCKET_COPY_IMAGE, BUCKET_COPY_SCRIPT } from '../gcp-transfer-bucket-workload.js';
import { transferSlot, type TransferSlotTarget } from './transfer-slot.js';

export interface TransferBucketJobScope {
  target: TransferSlotTarget;
  storageName: string;
  sourceBucketId: string;
  sourceBucketName: string;
  targetBucket: string;
}
export interface TransferBucketJobEvidence {
  projectNumber: string;
  copyUniqueId: string;
  bucketTimeCreated: string;
  jobUid: string | null;
  viewer: boolean;
  creator: boolean;
}

const jobType = 'google_cloud_run_v2_job';
const grantType = 'google_storage_bucket_iam_member';
const roles = { viewer: 'roles/storage.objectViewer', creator: 'roles/storage.objectCreator' } as const;
const prefix = 'transfer-bucket-';
export const isTransferBucketJobContribution = (id: string) => id.startsWith(prefix);
const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const textId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function transferBucketJob(scope: TransferBucketJobScope) {
  const { target, sourceBucketName, targetBucket, storageName } = scope;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(target.projectId) || !/^[a-z]+-[a-z]+[0-9]$/.test(target.targetRegion)
      || ![target.sourceEnvironmentId, target.sourceRailwayProjectId, target.sourceRailwayEnvironmentId, target.targetEnvironmentId,
        scope.sourceBucketId, storageName].every(id => typeof id === 'string' && textId.test(id))
      || ![sourceBucketName, targetBucket].every(name => typeof name === 'string' && bucketName.test(name))) {
    throw new Error('The source and destination must identify a managed Railway bucket and Google Cloud data bucket.');
  }
  const slot = transferSlot(target);
  // The slot is one identity. Changing the bucket must conflict with the original
  // contribution, rather than accumulating privileges for that same identity.
  const hash = slot.id.slice('transfer-'.length);
  const id = prefix + hash;
  const key = 'bucket_copy_' + hash;
  const jobId = 'hv-bucket-copy-' + hash;
  const addresses = { job: jobType + '.' + key, viewer: grantType + '.' + key + '_viewer', creator: grantType + '.' + key + '_creator' };
  const labels = { ...slot.labels, 'hv-selection': canonicalJsonSha256(scope).slice(0, 32) };
  const env = [{ name: 'HV_SOURCE_BUCKET', value: sourceBucketName }, { name: 'HV_TARGET_BUCKET', value: targetBucket }];
  const container = {
    name: 'copy', image: BUCKET_COPY_IMAGE, command: ['/bin/sh'], args: ['-c', BUCKET_COPY_SCRIPT], env,
    resources: [{ limits: { cpu: '1', memory: '512Mi' } }],
  };
  const task = { service_account: slot.accountEmail, execution_environment: 'EXECUTION_ENVIRONMENT_GEN2',
    max_retries: 0, timeout: '3600s', containers: [container] };
  const spec = { project: target.projectId, location: target.targetRegion, name: jobId, labels,
    deletion_protection: true, launch_stage: 'GA', template: [{ parallelism: 1, task_count: 1, template: [task] }] };
  const grants = (Object.keys(roles) as Array<keyof typeof roles>).map(kind => ({
    kind, name: key + '_' + kind, spec: { bucket: targetBucket, role: roles[kind], member: slot.member },
  }));
  // Literal JSON strings in a .tf.json expression still use OpenTofu templates.
  const script = BUCKET_COPY_SCRIPT.replace(/\$\{|%\{/g, match => match[0] + match);
  const configuration: EngineConfiguration = {
    files: { [id + '.tf.json']: { resource: {
      [jobType]: { [key]: { ...spec, template: [{ ...spec.template[0], template: [{ ...task, containers: [{ ...container, args: ['-c', script] }] }] }],
        lifecycle: [{ prevent_destroy: true }] } },
      [grantType]: Object.fromEntries(grants.map(grant => [grant.name, grant.spec])),
    } } },
    resources: {
      [addresses.job]: { actionId: 'bucket-copy:job:' + hash, kind: 'service',
        name: 'Prepare the file copy job for ' + storageName + ' (' + jobId + ')', requiresConfirm: true },
      ...Object.fromEntries(grants.map(({ kind, spec: grant }) => [addresses[kind], {
        actionId: 'bucket-copy:' + kind + ':' + hash, kind: 'storage',
        name: slot.accountEmail + ' · ' + grant.role + ' on gs://' + targetBucket, requiresConfirm: true, dataBearing: true,
      }])),
    },
  };
  return { id, configuration, jobId, accountEmail: slot.accountEmail, addresses, scope, spec, grants };
}
type Job = ReturnType<typeof transferBucketJob>;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const empty = (value: unknown) => value == null || value === '' || equal(value, []) || equal(value, {});

// These are the output-only fields of the pinned Google provider. In particular,
// start_execution_token and run_execution_token are inputs and must stay empty.
const jobOutputs = new Set(['conditions', 'create_time', 'creator', 'delete_time', 'effective_annotations', 'effective_labels', 'etag',
  'execution_count', 'expire_time', 'generation', 'id', 'last_modifier', 'latest_created_execution', 'observed_generation', 'reconciling',
  'terminal_condition', 'terraform_labels', 'uid', 'update_time']);
const jobUnknown = new Set([...jobOutputs, 'template.template.containers.startup_probe']);
const grantUnknown = new Set(['etag', 'id']);
function knownFields(mask: unknown, allowed: Set<string>, path = ''): boolean {
  if (mask === false) return true;
  if (mask === true) return allowed.has(path);
  if (Array.isArray(mask)) return mask.every(item => knownFields(item, allowed, path));
  const fields = object(mask);
  return !!fields && Object.entries(fields).every(([key, value]) => knownFields(value, allowed, path ? path + '.' + key : key));
}

// The provider writes these optional booleans into state after applying an
// unconfigured job. Other false-valued fields still need an explicit review.
const disabledJobOptions = new Set([
  'template.delay_execution',
  'template.template.gpu_zonal_redundancy_disabled',
  'template.template.containers.sandbox_launcher',
]);

/** Provider defaults add empty blocks and computed metadata. Every configured input
 * must match the immutable program, including all arguments, env and nested blocks. */
function exactInputs(expected: unknown, observed: unknown, outputs = new Set<string>(), path = ''): boolean {
  if (Array.isArray(expected)) return Array.isArray(observed) && expected.length === observed.length
    && expected.every((item, i) => exactInputs(item, observed[i], undefined, path));
  const fields = object(expected);
  if (!fields) return equal(expected, observed);
  const values = object(observed);
  if (!values) return false;
  const child = (key: string) => path ? path + '.' + key : key;
  return Object.entries(fields).every(([key, value]) => exactInputs(value, values[key], undefined, child(key)))
    && Object.entries(values).every(([key, value]) => {
      if (Object.hasOwn(fields, key) || outputs.has(key)) return true;
      if (disabledJobOptions.has(child(key))) return value == null || value === false;
      return empty(value);
    });
}

function expectedCount(address: string, job: Job, evidence: TransferBucketJobEvidence): number {
  if (address === job.addresses.job) return Number(evidence.jobUid !== null);
  return Number(address === job.addresses.viewer ? evidence.viewer : evidence.creator);
}
function matchesValues(address: string, raw: unknown, job: Job, evidence: TransferBucketJobEvidence, existing: boolean) {
  const values = object(raw);
  if (!values) return false;
  if (address === job.addresses.job) {
    // DELETE is the provider's default delete policy. Deletion protection is on
    // and every delete/replace operation is rejected independently by this review.
    const spec = { ...job.spec, ...(values.deletion_policy !== undefined && { deletion_policy: 'DELETE' }) };
    const nativeName = 'projects/' + job.scope.target.projectId + '/locations/' + job.scope.target.targetRegion + '/jobs/' + job.jobId;
    return exactInputs(spec, values, jobOutputs) && (!existing || (values.uid === evidence.jobUid && values.id === nativeName
      && (values.execution_count === 0 || values.execution_count === '0') && empty(values.latest_created_execution) && empty(values.delete_time)));
  }
  const grant = job.grants.find(grant => job.addresses[grant.kind] === address);
  if (!grant) return false;
  // The Google provider normalizes an existing bucket IAM member to b/<bucket>.
  const bucket = 'b/' + grant.spec.bucket;
  return exactInputs({ ...grant.spec, bucket: values.bucket === bucket ? bucket : grant.spec.bucket }, values, grantUnknown)
    && (!existing || values.id === bucket + '/' + grant.spec.role + '/' + grant.spec.member);
}
function originalRow(row: Record<string, unknown>, address: string) {
  return row.mode === 'managed' && row.type === address.split('.')[0] && row.provider_name === 'registry.opentofu.org/hashicorp/google'
    && !('index' in row) && !row.module_address && !row.tainted && !row.deposed && !row.deposed_key && !row.previous_address;
}

// Google refreshes the etag on each project IAM member when its shared policy
// changes. The planned no-op must retain every permission field and identity.
function onlyPermissionEtags(drift: unknown, changes: unknown[], projectId: string, owned: ReadonlySet<string>): boolean {
  if (drift === undefined) return true;
  if (!Array.isArray(drift)) return false;
  const seen = new Set<string>();
  return drift.every(raw => {
    const row = object(raw), change = object(row?.change), address = row?.address;
    if (!row || typeof address !== 'string' || !owned.has(address) || seen.has(address) || row.type !== 'google_project_iam_member' ||
        !originalRow(row, address) || !change || !equal(change.actions, ['update']) || change.importing || change.forget) return false;
    seen.add(address);
    const before = object(change.before), after = object(change.after);
    if (!before || !after || before.project !== projectId || typeof before.id !== 'string' || !before.id || !before.member || !before.role) return false;
    const { etag: prior, ...oldGrant } = before, { etag: current, ...newGrant } = after;
    if (typeof prior !== 'string' || !prior || typeof current !== 'string' || !current || prior === current || !equal(oldGrant, newGrant)) return false;
    const matching = changes.map(object).filter(item => item?.address === address);
    const saved = matching[0], noop = object(saved?.change);
    return matching.length === 1 && !!saved && originalRow(saved, address) && !!noop && equal(noop.actions, ['no-op'])
      && equal(noop.before, after) && equal(noop.after, after);
  });
}

export function verifyTransferBucketJobPlan(document: unknown, job: Job, evidence: TransferBucketJobEvidence,
  ownedProjectAddresses: ReadonlySet<string> = new Set()): boolean {
  const plan = object(document);
  if (!plan || !Array.isArray(plan.resource_changes) || plan.errored === true || plan.complete === false
      || !empty(plan.deferred_changes) || !onlyPermissionEtags(plan.resource_drift, plan.resource_changes, job.scope.target.projectId, ownedProjectAddresses)) return false;
  const selected = new Set<string>(Object.values(job.addresses));
  for (const raw of plan.resource_changes) {
    const row = object(raw);
    const change = object(row?.change);
    if (!row || !change || typeof row.address !== 'string' || row.previous_address || row.deposed || row.deposed_key || row.tainted
        || change.importing || !empty(change.replace_paths)) return false;
    const address = row.address;
    if (!Object.hasOwn(job.configuration.resources, address)) {
      if (!equal(change.actions, ['no-op']) || !knownFields(change.after_unknown ?? {}, new Set())) return false;
      continue;
    }
    const existing = !!expectedCount(address, job, evidence);
    if (!selected.delete(address) || !originalRow(row, address) || !equal(change.actions, [existing ? 'no-op' : 'create'])
        || !knownFields(change.after_unknown ?? {}, existing ? new Set() : address === job.addresses.job ? jobUnknown : grantUnknown)
        || !(existing ? matchesValues(address, change.before, job, evidence, true) : change.before === null)
        || !matchesValues(address, change.after, job, evidence, existing)) return false;
  }
  return !selected.size;
}

export function matchesTransferBucketJobState(document: unknown, job: Job, evidence: TransferBucketJobEvidence): boolean {
  const root = object(object(object(document)?.values)?.root_module);
  if (!root || !Array.isArray(root.resources)) return false;
  const rows = root.resources.map(object);
  return Object.values(job.addresses).every(address => {
    const found = rows.filter(row => row?.address === address);
    return found.length === expectedCount(address, job, evidence)
      && found.every(row => !!row && originalRow(row, address) && matchesValues(address, row.values, job, evidence, true));
  });
}
