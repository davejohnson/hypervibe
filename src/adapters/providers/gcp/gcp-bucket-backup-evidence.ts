import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { storageEngineKey } from './tofu/gcp-engine.backend.js';
import { backupAddresses as address, backupBucketRoles, GCP_BACKUP_CRON, type GcpBucketBackupProgram, type GcpBucketBackupSource } from './tofu/gcp-bucket-backups.js';
import { GCP_JOB_NODE_IMAGE } from './gcp-node-image.js';
import { backupStorageRole, unpackBackupCondition, type BackupGrantCondition } from './tofu/backup-archive-access.js';
import { railwayExportPrefix } from '../../../domain/services/railway-export-prefix.js';

const record = z.record(z.string(), z.unknown());
const text = z.string().min(1);
const numeric = z.string().regex(/^[1-9]\d*$/);
const timestamp = z.iso.datetime({ offset: true });
const rowSchema = z.object({ address: text, type: text, provider_name: text, mode: text, values: record,
  tainted: z.literal(false).optional(), deposed_key: z.never().optional(), index: z.never().optional() });
function birth(raw: unknown) {
  // Google and the provider can spell the same creation instant with different fractional-second precision.
  return timestamp.parse(raw).replace(/\.(\d+)Z$/, (_, fraction: string) => {
    const digits = fraction.replace(/0+$/, '');
    return digits ? '.' + digits + 'Z' : 'Z';
  });
}
const google = 'registry.opentofu.org/hashicorp/google';
/** Only messages composed from reviewed resource names and HTTP status may leave these reads. */
export class GoogleBucketBackupError extends Error {}
export async function readGoogleBackupApplicationAccount(source: GcpBucketBackupSource, token: string) {
  const name = 'projects/' + source.projectId + '/serviceAccounts/' + source.runtimeEmail;
  const response = await fetch('https://iam.googleapis.com/v1/' + name.replace(source.runtimeEmail, encodeURIComponent(source.runtimeEmail)),
    { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new GoogleBucketBackupError('Google could not verify the original application account before narrowing its storage access.');
  return z.object({ name: z.literal(name), projectId: z.literal(source.projectId), email: z.literal(source.runtimeEmail),
    uniqueId: z.string().regex(/^[1-9]\d*$/), disabled: z.literal(false).optional() }).parse(await response.json());
}

export class GoogleBackupRuntimeExposure extends GoogleBucketBackupError {
  constructor(readonly program: GcpBucketBackupProgram, readonly before: BackupGrantCondition | undefined) {
    super('The application runtime can change the planned archive through its project storage permission. Review the application storage restriction before the daily backup.');
  }
}
function requireMatch(value: unknown, message: string): asserts value {
  if (!value) throw new GoogleBucketBackupError(message);
}
function hasLabels(value: unknown, expected: Record<string, string>): boolean {
  const labels = record.safeParse(value).data;
  return !!labels && Object.entries(expected).every(([key, expectedValue]) => labels[key] === expectedValue);
}

/** A global name can be reused. Read the bucket's birth time and numbered project from its original private state. */
export function googleBackupSourceFromState(raw: unknown, target: Omit<GcpBucketBackupSource, 'timeCreated' | 'projectNumber'>): GcpBucketBackupSource {
  const sourceAddress = 'google_storage_bucket.' + storageEngineKey(target.storageName);
  const root = z.object({ values: z.object({ root_module: z.object({ resources: z.array(record) }) }) }).parse(raw);
  const resources = root.values.root_module.resources.filter(r => r.address === sourceAddress);
  const row = rowSchema.safeParse(resources[0]).data, v = row?.values;
  requireMatch(resources.length === 1 && row?.mode === 'managed' && row.type === 'google_storage_bucket' && row.provider_name === google
    && v?.id === target.bucket && v.name === target.bucket && v.project === target.projectId && v.location === target.location
    && v.uniform_bucket_level_access === true && v.public_access_prevention === 'enforced'
    && hasLabels(v.labels, { 'managed-by': 'hypervibe', 'hv-environment': target.environmentId.toLowerCase(), 'hv-storage': target.storageName }),
    'The selected bucket does not match its original private Google Cloud environment state.');
  return { ...target, projectNumber: numeric.parse(String(v.project_number)), timeCreated: birth(v.time_created) };
}

/** The keys are engine addresses. Native incarnations are compared with Google before planning, applying and reading points. */
export type GoogleBackupOwnership = Record<string, string>;
export function googleBackupOwnershipFromState(raw: unknown, program: GcpBucketBackupProgram): GoogleBackupOwnership {
  const root = z.object({ values: z.object({ root_module: z.object({
    resources: z.array(z.unknown()).optional(), child_modules: z.array(z.unknown()).max(0).optional(),
  }) }) }).parse(raw).values.root_module;
  const owned: GoogleBackupOwnership = {};
  for (const row of z.array(rowSchema).parse(root.resources ?? [])) {
    const v = row.values;
    requireMatch(row.mode === 'managed' && row.provider_name === google && Object.hasOwn(program.configuration.resources, row.address)
      && row.type === row.address.split('.')[0] && !Object.hasOwn(owned, row.address), 'The backup state has resources outside this bucket program.');
    const email = row.address === address.worker ? program.workerEmail : program.timerEmail;
    let identity: string | undefined;
    if (row.address === address.archive && v.name === program.archiveName && v.id === program.archiveName
        && v.project === program.source.projectId && String(v.project_number) === program.source.projectNumber
        && hasLabels(v.labels, program.labels)) identity = birth(v.time_created);
    if ([address.worker, address.timer].includes(row.address) && v.email === email && v.project === program.source.projectId
        && v.id === 'projects/' + program.source.projectId + '/serviceAccounts/' + email) identity = numeric.parse(v.unique_id);
    if (row.address === address.workerViewer || row.address === address.timerViewer) {
      const observed = row.address === address.workerViewer ? program.workerEmail : program.timerEmail;
      if (v.service_account_id === 'projects/' + program.source.projectId + '/serviceAccounts/' + observed
          && v.member === 'serviceAccount:' + program.source.deployEmail && v.role === 'roles/iam.serviceAccountViewer'
          && (!v.condition || equal(v.condition, []))) identity = v.role;
    }
    if (row.address === address.job && v.id === program.jobName && hasLabels(v.labels, program.labels)) identity = z.uuid().parse(v.uid);
    if (row.address === address.policyViewer && v.project === program.source.projectId && v.role === 'roles/browser' &&
        v.member === 'serviceAccount:' + program.source.deployEmail && equal(v.condition, [program.observerCondition])) identity = v.role;
    if (row.address === address.schedule && v.id === program.jobName) identity = text.parse(v.description);
    if (row.address === address.invoker && v.member === 'serviceAccount:' + program.timerEmail && v.role === 'roles/run.invoker'
        && v.project === program.source.projectId && v.location === program.source.region && [program.jobName, program.name].includes(String(v.name))) identity = 'roles/run.invoker';
    for (const [key, [side, role]] of Object.entries(backupBucketRoles)) {
      const bucket = side === 'source' ? program.source.bucket : program.archiveName;
      if (row.address === 'google_storage_bucket_iam_member.' + key && [bucket, 'b/' + bucket].includes(String(v.bucket))
          && v.member === 'serviceAccount:' + program.workerEmail && v.role === role && (!v.condition || equal(v.condition, []))) identity = role;
    }
    requireMatch(identity, 'The backup state does not identify the originally reviewed Google Cloud resource ' + row.address + '.');
    owned[row.address] = identity;
  }
  return owned;
}

const metadata = z.object({ name: text, id: text, projectNumber: numeric, timeCreated: timestamp, location: text, labels: record,
  iamConfiguration: z.object({ publicAccessPrevention: z.literal('enforced'), uniformBucketLevelAccess: z.object({ enabled: z.literal(true) }) }) });
const policy = z.object({ etag: text, version: z.number().optional(), bindings: z.array(z.object({ role: text, members: z.array(text).min(1), condition: record.optional() })).optional() });
const oauthScope = 'https://www.googleapis.com/auth/cloud-platform';
const harmlessApplicationRoles = new Set(['roles/cloudsql.client','roles/cloudsql.instanceUser','roles/secretmanager.secretAccessor',
  'roles/pubsub.publisher','roles/pubsub.subscriber','roles/workflows.invoker','roles/run.invoker','roles/storage.objectViewer','roles/storage.legacyBucketReader','roles/browser']);
function originalExportCondition(expression: string, projectId: string) {
  const start = 'resource.type != "storage.googleapis.com/Object" || !resource.name.startsWith(';
  if (!expression.startsWith(start) || !expression.endsWith(')')) return false;
  const literal = expression.slice(start.length, -1), prefix = 'projects/_/buckets/' + projectId + '-hv-build-source/objects/';
  try {
    const name: unknown = JSON.parse(literal);
    if (typeof name !== 'string' || literal !== JSON.stringify(name) || !name.startsWith(prefix + 'migrations/') || !name.endsWith('/')) return false;
    return name === prefix + railwayExportPrefix(name.slice((prefix + 'migrations/').length, -1));
  } catch { return false; }
}

function checkRuntimeStorage(raw: unknown, program: GcpBucketBackupProgram, scope: 'project' | 'archive') {
  const live = policy.parse(raw), principal = 'serviceAccount:' + program.source.runtimeEmail;
  let storageGrant: { before?: BackupGrantCondition; excludes: boolean } | undefined;
  for (const grant of live.bindings ?? []) {
    requireMatch(!grant.role.includes('_withcond_') && (!grant.condition || live.version === 3), 'Google Cloud did not return the complete storage access conditions.');
    const relevant = grant.members.filter(m => m === principal || m === 'allUsers' || m === 'allAuthenticatedUsers' ||
      m.startsWith('principal://iam.googleapis.com/projects/-/serviceAccounts/') ||
      /^principalSet:\/\/cloudresourcemanager\.googleapis\.com\/(?:folders|organizations)\/.+\/type\/ServiceAccount$/.test(m) ||
      m === 'principalSet://cloudresourcemanager.googleapis.com/projects/' + program.source.projectNumber + '/type/ServiceAccount');
    if (!relevant.length || harmlessApplicationRoles.has(grant.role)) continue;
    if (scope === 'project' && grant.role === backupStorageRole && equal(relevant, [principal]) && !storageGrant) {
      const split = unpackBackupCondition(grant.condition);
      // Opaque conditions cannot prove a backup exclusion. Verify the managed migration form or the original unconditional grant.
      requireMatch(!split.base || originalExportCondition(split.base.expression, program.source.projectId),
        'The application has an unrecognized Google Cloud project storage condition. Review its original managed setup.');
      storageGrant = { before: grant.condition as BackupGrantCondition | undefined, excludes: split.archives.includes(program.archiveName) };
    } else throw new GoogleBucketBackupError('An additional application runtime or public permission can change the backup archive. Review that access before planning daily copies.');
  }
  return storageGrant;
}

function assertBucket(raw: unknown, program: GcpBucketBackupProgram, archive: boolean) {
  const { projectNumber, location, environmentId, bucket, storageName, timeCreated } = program.source;
  const name = archive ? program.archiveName : bucket;
  const v = metadata.parse(raw);
  requireMatch(v.id === name && v.name === name && v.projectNumber === projectNumber && v.location === location
    && (archive || birth(v.timeCreated) === birth(timeCreated))
    && hasLabels(v.labels, archive ? program.labels : { 'managed-by': 'hypervibe', 'hv-storage': storageName, 'hv-environment': environmentId.toLowerCase() }),
    'Google Cloud reports a different bucket identity or ownership for gs://' + name + '.');
  return birth(v.timeCreated);
}

function liveJob(raw: Record<string, unknown>, p: GcpBucketBackupProgram, archiveCreated: string | undefined) {
  const v = z.object({ name: text, uid: z.uuid(), generation: numeric, observedGeneration: numeric, deleteTime: z.never().optional(),
    reconciling: z.literal(false).optional(), terminalCondition: z.object({ type: z.literal('Ready'), state: z.literal('CONDITION_SUCCEEDED') }),
    labels: record, template: record }).parse(raw);
  const nativeTask = record.parse(v.template.template), container = z.tuple([record]).parse(nativeTask.containers)[0];
  const limits = record.parse(record.parse(container.resources).limits);
  const actualEnv = z.tuple([z.object({ name: z.literal('HYPERVIBE_BUCKET_BACKUP_CONFIG'), value: text }).strict()]).parse(container.env)[0];
  const config = record.parse(JSON.parse(actualEnv.value));
  requireMatch(archiveCreated && [p.jobName, p.jobName.replace('projects/' + p.source.projectId + '/', 'projects/' + p.source.projectNumber + '/')].includes(v.name)
    && v.observedGeneration === v.generation && hasLabels(v.labels, p.labels)
    && equal({ ...config, archiveTimeCreated: birth(config.archiveTimeCreated) }, p.runtime(archiveCreated))
    && (limits.cpu === '1' || limits.cpu === '1000m') && ['1Gi', '1024Mi'].includes(String(limits.memory))
    && equal(v.template, { parallelism: 1, taskCount: 1, template: { serviceAccount: p.workerEmail,
      executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2', timeout: '86400s', maxRetries: 0,
      containers: [{ name: 'copy', image: GCP_JOB_NODE_IMAGE, command: p.command.command, args: p.command.args,
        resources: { limits }, env: [actualEnv] }] } }), 'The live Google Cloud backup job differs from its reviewed worker, image, command or bucket identities.');
  return v.uid;
}

export async function observeGoogleBackupProgram(program: GcpBucketBackupProgram, owned: GoogleBackupOwnership, token: string,
  options: { fetch?: typeof fetch; managedStorage?: { condition?: BackupGrantCondition; archiveEnrolled: boolean } } = {}) {
  const { projectId, projectNumber, bucket } = program.source;
  const evidence: GoogleBackupOwnership = {};
  const read = async (url: string, allowMissing = false, post = false) => {
    const response = await (options.fetch ?? fetch)(url, { method: post ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token,
      ...(post && { 'Content-Type': 'application/json' }) }, ...(post && { body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) }),
      signal: AbortSignal.timeout(15000), redirect: 'error' });
    const data = record.parse(await response.json());
    if (!response.ok) {
      const error = z.object({ code: z.literal(404), status: text.optional(), errors: z.array(z.object({ reason: text })).optional() }).safeParse(data.error);
      if (allowMissing && response.status === 404 && error.success && (error.data.status === 'NOT_FOUND'
          || error.data.errors?.some(item => item.reason === 'notFound'))) return;
      throw new GoogleBucketBackupError('Google Cloud could not verify a backup resource or permission (HTTP ' + response.status + ').');
    }
    return data;
  };
  const storage = (name: string) => 'https://storage.googleapis.com/storage/v1/b/' + name;
  const accountUrl = (email: string) => 'https://iam.googleapis.com/v1/projects/' + projectId + '/serviceAccounts/' + encodeURIComponent(email);
  const jobUrl = 'https://run.googleapis.com/v2/' + program.jobName;
  const [source, archive, worker, timer, job, schedule, projectPolicy] = await Promise.all([
    read(storage(bucket)), read(storage(program.archiveName), true), read(accountUrl(program.workerEmail), true),
    read(accountUrl(program.timerEmail), true), read(jobUrl, true), read('https://cloudscheduler.googleapis.com/v1/' + program.jobName, true),
    read('https://cloudresourcemanager.googleapis.com/v3/projects/' + projectNumber + ':getIamPolicy', false, true),
  ]);
  assertBucket(source, program, false);
  const runtimeStorage = checkRuntimeStorage(projectPolicy, program, 'project');
  if (options.managedStorage) {
    requireMatch(runtimeStorage && equal(runtimeStorage.before, options.managedStorage.condition) && runtimeStorage.excludes === options.managedStorage.archiveEnrolled,
      'The live application storage permission differs from its original managed project grant. Restore that Google setup before planning the daily archive.');
  }
  if (archive) evidence[address.archive] = assertBucket(archive, program, true);
  for (const [key, a, email] of [[address.worker, worker, program.workerEmail], [address.timer, timer, program.timerEmail]] as const) {
    if (!a) continue;
    requireMatch(a.email === email && a.projectId === projectId && a.disabled !== true
      && a.name === 'projects/' + projectId + '/serviceAccounts/' + email, 'Google Cloud returned a different or disabled backup service account.');
    evidence[key] = numeric.parse(a.uniqueId);
  }
  if (job) evidence[address.job] = liveJob(job, program, evidence[address.archive]);
  if (schedule) {
    const http = record.parse(schedule.httpTarget), retry = record.parse(schedule.retryConfig ?? {});
    requireMatch(evidence[address.job] && [program.jobName, program.jobName.replace('projects/' + projectId + '/', 'projects/' + projectNumber + '/')].includes(String(schedule.name))
      && schedule.description === 'Daily Hypervibe bucket backup for Cloud Run job ' + evidence[address.job]
      && schedule.state === 'ENABLED' && schedule.schedule === GCP_BACKUP_CRON && schedule.timeZone === 'UTC'
      && http.uri === program.jobUri && http.httpMethod === 'POST' && http.body === program.body && !http.oidcToken
      && equal(http.oauthToken, { serviceAccountEmail: program.timerEmail, scope: oauthScope }) && (retry.retryCount ?? 0) === 0,
      'Google Cloud could not verify the enabled daily trigger for the original backup job.');
    evidence[address.schedule] = String(schedule.description);
  }
  const sourceIam = storage(bucket) + '/iam?optionsRequestedPolicyVersion=3';
  const [sourcePolicy, archivePolicy, jobPolicy, workerPolicy, timerPolicy] = await Promise.all([read(sourceIam), archive && read(storage(program.archiveName) + '/iam?optionsRequestedPolicyVersion=3'),
    job && read(jobUrl + ':getIamPolicy?options.requestedPolicyVersion=3'), worker && read(accountUrl(program.workerEmail) + ':getIamPolicy', false, true),
    timer && read(accountUrl(program.timerEmail) + ':getIamPolicy', false, true)]);
  if (archivePolicy) checkRuntimeStorage(archivePolicy, program, 'archive');
  if ((policy.parse(projectPolicy).bindings ?? []).some(grant => grant.role === 'roles/browser' && grant.members.includes('serviceAccount:' + program.source.deployEmail) && equal(grant.condition, program.observerCondition))) {
    evidence[address.policyViewer] = 'roles/browser';
  }
  for (const [grantAddress, raw] of [[address.workerViewer, workerPolicy], [address.timerViewer, timerPolicy]] as const) {
    if (!raw) continue;
    const principal = 'serviceAccount:' + program.source.deployEmail;
    for (const grant of policy.parse(raw).bindings ?? []) {
      if (grant.role !== 'roles/iam.serviceAccountViewer' || !grant.members.includes(principal)) continue;
      requireMatch(!grant.condition && !evidence[grantAddress], 'Google Cloud returned a different grant for reading a backup service account.');
      evidence[grantAddress] = grant.role;
    }
  }
  for (const [side, raw] of [['source', sourcePolicy], ['archive', archivePolicy], ['job', jobPolicy], ['project', projectPolicy]] as const) {
    if (!raw) continue;
    if (side === 'source' || side === 'archive') requireMatch(raw.kind === 'storage#policy' && raw.resourceId === 'projects/_/buckets/' +
      (side === 'source' ? bucket : program.archiveName), 'Google Cloud returned a policy for a different backup bucket.');
    for (const grant of policy.parse(raw).bindings ?? []) {
      for (const member of grant.members) {
        if (![program.workerEmail, program.timerEmail].some(email => member === 'serviceAccount:' + email || member.startsWith('deleted:serviceAccount:' + email + '?uid='))) continue;
        const key = side === 'job' && member === 'serviceAccount:' + program.timerEmail && grant.role === 'roles/run.invoker' ? address.invoker :
          Object.entries(backupBucketRoles).find(([, [bucketSide, role]]) => bucketSide === side && role === grant.role && member === 'serviceAccount:' + program.workerEmail)?.[0];
        requireMatch(key && !grant.condition, 'A backup service account has an unreviewed Google Cloud permission.');
        const grantAddress = key === address.invoker ? key : 'google_storage_bucket_iam_member.' + key;
        requireMatch(!evidence[grantAddress], 'Google Cloud returned duplicate backup grants.');
        evidence[grantAddress] = grant.role;
      }
    }
  }
  requireMatch(equal(evidence, owned), 'Google Cloud backup resources differ from their original private state. Check the named archive, identities and schedule before planning again.');
  if (runtimeStorage && !runtimeStorage.excludes) throw new GoogleBackupRuntimeExposure(program, runtimeStorage.before);
  return evidence;
}
