import { canonicalJsonSha256 } from '../../../../lib/canonical-json.js';
import type { EngineConfiguration, EngineStateIdentity } from '../../../../domain/ports/infrastructure-engine.port.js';
import { GCP_JOB_NODE_IMAGE } from '../gcp-node-image.js';
import { gcpDailyBucketBackupCommand } from '../gcp-daily-bucket-backup-workload.js';

export interface GcpBucketBackupSource {
  projectId: string;
  projectNumber: string;
  deployEmail: string;
  runtimeEmail: string;
  environmentId: string;
  storageName: string;
  region: string;
  bucket: string;
  location: string;
  timeCreated: string;
}

export const GCP_BACKUP_CRON = '0 3 * * *';
const archive = 'google_storage_bucket.archive';
const worker = 'google_service_account.copy';
const timer = 'google_service_account.timer';
const job = 'google_cloud_run_v2_job.copy';
const schedule = 'google_cloud_scheduler_job.daily';
const invoker = 'google_cloud_run_v2_job_iam_member.timer';
const bucketRole = 'google_storage_bucket_iam_member';
const workerViewer = 'google_service_account_iam_member.copy_observer';
const timerViewer = 'google_service_account_iam_member.timer_observer';
const policyViewer = 'google_project_iam_member.backup_observer';
export const backupAddresses = { archive, worker, timer, job, schedule, invoker, workerViewer, timerViewer, policyViewer };
export const backupBucketRoles = {
  source_read: ['source', 'roles/storage.objectViewer'],
  source_metadata: ['source', 'roles/storage.legacyBucketReader'],
  archive_objects: ['archive', 'roles/storage.objectUser'],
  archive_metadata: ['archive', 'roles/storage.legacyBucketReader'],
} as const;

export function gcpBucketBackupProgram(source: GcpBucketBackupSource) {
  const { projectId, projectNumber, environmentId, storageName, region, bucket, timeCreated, location } = source;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !/^[1-9]\d*$/.test(projectNumber)
    || !/^[a-zA-Z0-9_-]{1,63}$/.test(environmentId) || !/^[a-z][a-z0-9-]{0,62}$/.test(storageName)
    || !/^[a-z]+-[a-z]+[0-9]$/.test(region) || !/^[A-Z0-9][A-Z0-9-]*$/.test(location)
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !/^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(timeCreated)
    || !Number.isFinite(Date.parse(timeCreated))) throw new Error('The original Google Cloud bucket identity is incomplete.');
  const hash = canonicalJsonSha256([projectId, environmentId, storageName]).slice(0, 20);
  const name = 'hv-backup-' + hash;
  const archiveName = name + '-' + storageName.slice(0, 32).replace(/-+$/, '');
  if (archiveName === bucket) throw new Error('A bucket backup needs a separate destination.');
  const account = (id: string) => id + '@' + projectId + '.iam.gserviceaccount.com';
  const workerId = 'hv-copy-' + hash, timerId = 'hv-timer-' + hash;
  const workerEmail = account(workerId), timerEmail = account(timerId);
  if (![source.deployEmail, source.runtimeEmail].every(email => /^[a-z][a-z0-9-]{4,28}[a-z0-9]@/.test(email)
      && email.endsWith('@' + projectId + '.iam.gserviceaccount.com'))
      || new Set([workerEmail, timerEmail, source.deployEmail, source.runtimeEmail]).size !== 4) {
    throw new Error('The Google backup needs verified, distinct application, deployment, worker and scheduler accounts.');
  }
  const jobName = 'projects/' + projectId + '/locations/' + region + '/jobs/' + name;
  const jobUri = 'https://run.googleapis.com/v2/' + jobName + ':run';
  const labels = { 'managed-by': 'hypervibe', 'hv-environment': environmentId.toLowerCase(),
    'hv-source': canonicalJsonSha256([projectNumber, bucket, timeCreated]).slice(0, 32) };
  const observerCondition = { title: 'hv-backup-policy-' + hash, description: 'Read the app project policy when checking this backup.',
    // Google supports the project resource type, but does not expose resource.name for projects.
    // A project cannot contain other projects. This binding is granted on the selected project itself.
    expression: 'resource.type == "cloudresourcemanager.googleapis.com/Project"' };
  const runtime = (archiveTimeCreated: string) => ({ version: 1 as const, provider: 'gcs' as const,
    projectId, projectNumber, sourceBucket: bucket, sourceTimeCreated: timeCreated,
    archiveBucket: archiveName, archiveTimeCreated, serviceAccountEmail: workerEmail });
  const command = gcpDailyBucketBackupCommand();
  // OpenTofu interprets template directives even inside strings in .tf.json.
  const args = command.args.map(arg => arg.replace(/\$\{|%\{/g, match => match[0] + match));
  const grantAddresses = Object.keys(backupBucketRoles).map(key => bucketRole + '.' + key);
  const addresses = [...Object.values(backupAddresses), ...grantAddresses];
  const ref = (attr: string) => '${' + attr + '}';
  const body = Buffer.from('{}').toString('base64');
  const configuration: EngineConfiguration = { files: {
    'backup.tf.json': { provider: { google: [{ project: projectId, region }] }, resource: {
      google_storage_bucket: { archive: { project: projectId, name: archiveName, location, labels,
        uniform_bucket_level_access: true, public_access_prevention: 'enforced', force_destroy: false, deletion_policy: 'PREVENT',
        // Count retained complete copies. This new bucket has no second, age-based soft-delete retention period.
        soft_delete_policy: [{ retention_duration_seconds: 0 }], lifecycle: [{ prevent_destroy: true }] } },
      google_service_account: { copy: { project: projectId, account_id: workerId, display_name: 'Hypervibe bucket backup worker' },
        timer: { project: projectId, account_id: timerId, display_name: 'Hypervibe bucket backup scheduler' } },
      google_service_account_iam_member: Object.fromEntries([['copy_observer', worker], ['timer_observer', timer]].map(([key, account]) =>
        [key, { service_account_id: ref(account + '.name'), role: 'roles/iam.serviceAccountViewer', member: 'serviceAccount:' + source.deployEmail }])),
      google_project_iam_member: { backup_observer: { project: projectId, role: 'roles/browser', member: 'serviceAccount:' + source.deployEmail,
        condition: [observerCondition] } },
      [bucketRole]: Object.fromEntries(Object.entries(backupBucketRoles).map(([key, [side, role]]) =>
        [key, { bucket: side === 'source' ? bucket : ref(archive + '.name'), role, member: 'serviceAccount:' + ref(worker + '.email') }])),
      google_cloud_run_v2_job: { copy: { project: projectId, location: region, name, labels,
        deletion_protection: true, depends_on: grantAddresses,
        template: [{ task_count: 1, parallelism: 1, template: [{ service_account: ref(worker + '.email'),
          timeout: '86400s', max_retries: 0, execution_environment: 'EXECUTION_ENVIRONMENT_GEN2',
          containers: [{ name: 'copy', image: GCP_JOB_NODE_IMAGE, command: command.command, args,
            resources: [{ limits: { cpu: '1', memory: '1Gi' } }],
            env: [{ name: 'HYPERVIBE_BUCKET_BACKUP_CONFIG', value: JSON.stringify(runtime(ref(archive + '.time_created'))) }] }] }] }] } },
      google_cloud_run_v2_job_iam_member: { timer: { project: projectId, location: region, name: ref(job + '.name'),
        member: 'serviceAccount:' + ref(timer + '.email'), role: 'roles/run.invoker' } },
      google_cloud_scheduler_job: { daily: { project: projectId, region, name, schedule: GCP_BACKUP_CRON, time_zone: 'UTC',
        description: 'Daily Hypervibe bucket backup for Cloud Run job ' + ref(job + '.uid'), paused: false,
        depends_on: [invoker], retry_config: [{ retry_count: 0 }], http_target: [{ http_method: 'POST', uri: jobUri,
          body, headers: { 'Content-Type': 'application/json' }, oauth_token: [{ service_account_email: ref(timer + '.email'),
            scope: 'https://www.googleapis.com/auth/cloud-platform' }] }] } },
    } } },
    resources: Object.fromEntries(addresses.map(address => [address, { actionId: 'bucket-backup:' + storageName, kind: 'storage',
      name: 'Daily backup of gs://' + bucket + ' to gs://' + archiveName + ' (seven complete copies)',
      requiresConfirm: true, billable: true, dataBearing: true }])),
  };
  return { source, archiveName, labels, name, jobName, jobUri, body, workerEmail, timerEmail, observerCondition, configuration, runtime, command,
    state: (hypervibeProjectId: string): EngineStateIdentity =>
      ({ provider: 'gcp', projectId: hypervibeProjectId, environmentId: 'bucket-backups-' + hash, partition: 'environment' }) };
}

export type GcpBucketBackupProgram = ReturnType<typeof gcpBucketBackupProgram>;
