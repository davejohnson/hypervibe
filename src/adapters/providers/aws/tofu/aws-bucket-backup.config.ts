import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GCP_JOB_NODE_IMAGE as NODE_IMAGE } from '../../gcp/gcp-node-image.js';
import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { awsDailyBucketConfig, type AwsDailyBucketConfig } from '../aws-daily-bucket-backup.js';
import { checkedProvider } from './aws-engine.config.js';
import { enrollmentKey } from '../../../../domain/services/bucket-backup-enrollment.js';
import { enrollmentWitnessReference, frozenEnrollmentWitness, nativeEnrollmentProbe } from '../../backup-enrollment-witness.js';

/** Fargate obtains this private S3 environment file with the execution role. Each
 * entry is bounded below Linux's per-string limit. Only verified bytes execute. */
const bootstrap = [
  "const env=Object.keys(process.env).filter(k=>/^HV_JS_[0-9]{4}$/.test(k)).sort().map(k=>process.env[k]).join('');",
  "const js=require('node:zlib').gunzipSync(Buffer.from(env,'base64'));",
  "if(require('node:crypto').createHash('sha256').update(js).digest('hex')!==process.env.HV_WORKER_SHA256)throw Error('Backup program verification failed.');",
  "require('node:fs').writeFileSync('/tmp/hv-bucket-backup.cjs',js,{flag:'wx',mode:0o600});",
  "require('/tmp/hv-bucket-backup.cjs');",
].join('\n');

export interface AwsBucketBackupInput {
  config: AwsDailyBucketConfig; prefix: string; storageName: string; environmentId: string; programName: string;
  worker: Buffer;
}
export function buildAwsBucketBackup(input: AwsBucketBackupInput): EngineConfiguration {
  const { accountId, region, sourceBucket, archiveBucket } = awsDailyBucketConfig.parse(input.config);
  const { programName, environmentId, storageName } = input;
  if (!/^hv-[a-z0-9-]{3,46}$/.test(programName)) throw new Error('The daily backup program name is invalid.');
  const files = checkedProvider({ ...input.config, prefix: input.prefix, environmentId });
  const resource: Record<string, Record<string, unknown>> = {};
  const resources: Record<string, EngineResourceMapping> = {};
  const add = (type: string, key: string, value: unknown, group: 'archive' | 'identity' | 'schedule') => {
    (resource[type] ??= {})[key] = value;
    resources[type + '.' + key] = { actionId: 'bucket-backup:' + storageName + ':' + group,
      name: group === 'archive' ? archiveBucket : programName + ' ' + group, kind: group === 'archive' ? 'storage' : 'service',
      requiresConfirm: true, ...(group === 'archive' ? { dataBearing: true } : {}), billable: group !== 'identity' };
  };
  const source = 'arn:aws:s3:::' + sourceBucket;
  const archive = 'arn:aws:s3:::' + archiveBucket;
  const taskArn = 'arn:aws:ecs:' + region + ':' + accountId;
  const arn = (type: string, key: string, attribute = 'arn') => '${' + type + '.' + key + '.' + attribute + '}';
  const hash = createHash('sha256').update(input.worker).digest('hex');
  const packed = gzipSync(input.worker, { level: 9 }).toString('base64');
  if (!packed.length || packed.length > 1_300_000) throw new Error('The packaged daily backup exceeds the Fargate worker size limit.');
  const environmentFile = packed.match(/.{1,24000}/g)!.map((chunk, index) => 'HV_JS_' + String(index).padStart(4, '0') + '=' + chunk).join('\n') + '\n';
  const workerKey = 'hypervibe-runtime/worker.env';
  const enrollment = '${terraform_data.enrollment.id}';
  add('terraform_data', 'enrollment', { input: { source: sourceBucket, archive: archiveBucket }, lifecycle: [{ prevent_destroy: true }] }, 'archive');
  add('terraform_data', 'enrollment_witness', frozenEnrollmentWitness, 'archive');
  add('aws_s3_bucket', 'archive', { bucket: archiveBucket, force_destroy: false, lifecycle: [{ prevent_destroy: true }] }, 'archive');
  add('aws_s3_bucket_public_access_block', 'archive', { bucket: arn('aws_s3_bucket', 'archive', 'id'), block_public_acls: true,
    block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }, 'archive');
  add('aws_s3_bucket_ownership_controls', 'archive', { bucket: arn('aws_s3_bucket', 'archive', 'id'), rule: [{ object_ownership: 'BucketOwnerEnforced' }] }, 'archive');
  add('aws_s3_object', 'worker', { bucket: arn('aws_s3_bucket', 'archive', 'id'), key: workerKey, content: environmentFile,
    content_type: 'text/plain', source_hash: hash, depends_on: ['aws_s3_bucket_public_access_block.archive'] }, 'schedule');
  for (const [key, bucket] of [['source_enrollment', sourceBucket], ['archive_enrollment', arn('aws_s3_bucket', 'archive', 'id')]] as const) {
    add('aws_s3_object', key, { bucket, key: enrollmentKey(enrollment), content: enrollment, content_type: 'text/plain',
      lifecycle: [{ prevent_destroy: true }] }, 'archive');
  }
  add('aws_ecs_cluster', 'backup', { name: programName }, 'schedule');
  add('aws_security_group', 'backup', { name: programName, description: 'Hypervibe daily file backup HTTPS egress', vpc_id: '${data.aws_vpc.default.id}',
    egress: [{ description: 'HTTPS to storage and the image registry', from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'],
      ipv6_cidr_blocks: [], prefix_list_ids: [], security_groups: [], self: false }] }, 'schedule');
  const cluster = arn('aws_ecs_cluster', 'backup');
  const roleArn = (key: string) => arn('aws_iam_role', key);
  const role = (key: string, service: string, allow: unknown[], sourceArn: string) => {
    const name = programName + '-' + key;
    add('aws_iam_role', key, { name, path: '/hypervibe/app/', permissions_boundary: 'arn:aws:iam::' + accountId + ':policy/hypervibe/hypervibe-app-boundary',
      assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: service },
        Condition: { StringEquals: { 'aws:SourceAccount': accountId }, ArnLike: { 'aws:SourceArn': sourceArn } } }] }) }, 'identity');
    add('aws_iam_role_policy', key, { name: 'backup', role: arn('aws_iam_role', key, 'id'), policy: JSON.stringify({ Version: '2012-10-17', Statement: allow }) }, 'identity');
  };
  const statement = (Action: string[], Resource: string | string[], Condition?: object) => ({ Effect: 'Allow', Action, Resource, ...(Condition ? { Condition } : {}) });
  const dataKeys = ['hypervibe-recovery/v1/*', 'hypervibe-bucket-backups/v1/*'];
  role('files', 'ecs-tasks.amazonaws.com', [statement(['s3:ListBucket'], [source, archive]),
    statement(['s3:GetObject'], source + '/*'), statement(['s3:GetObject'], archive + '/' + enrollmentKey(enrollment)),
    statement(['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], dataKeys.map(key => archive + '/' + key))], taskArn + ':*');
  const logGroup = '/hypervibe/' + programName;
  role('execution', 'ecs-tasks.amazonaws.com', [statement(['s3:GetObject'], archive + '/' + workerKey), statement(['s3:GetBucketLocation'], archive),
    statement(['logs:CreateLogStream', 'logs:PutLogEvents'], 'arn:aws:logs:' + region + ':' + accountId + ':log-group:' + logGroup + ':log-stream:*')], taskArn + ':*');
  add('aws_cloudwatch_log_group', 'backup', { name: logGroup, retention_in_days: 7 }, 'schedule');
  add('aws_ecs_task_definition', 'backup', { family: programName, network_mode: 'awsvpc', requires_compatibilities: ['FARGATE'],
    cpu: '256', memory: '1024', task_role_arn: roleArn('files'), execution_role_arn: roleArn('execution'),
    runtime_platform: [{ operating_system_family: 'LINUX', cpu_architecture: 'X86_64' }],
    container_definitions: JSON.stringify([{ name: 'backup', image: NODE_IMAGE, essential: true, entryPoint: ['node', '-e'], command: [bootstrap],
      environment: [{ name: 'HYPERVIBE_BUCKET_BACKUP_CONFIG', value: JSON.stringify({ ...input.config, enrollmentId: enrollment, enrollmentWitness: enrollmentWitnessReference }) }, { name: 'HV_WORKER_SHA256', value: hash }],
      environmentFiles: [{ value: archive + '/' + workerKey, type: 's3' }],
      logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-region': region, 'awslogs-group': logGroup, 'awslogs-stream-prefix': 'backup' } } }]),
    depends_on: ['aws_s3_object.worker', 'aws_s3_object.source_enrollment', 'aws_s3_object.archive_enrollment',
      'aws_iam_role_policy.files', 'aws_iam_role_policy.execution', 'aws_cloudwatch_log_group.backup'] }, 'schedule');
  role('schedule', 'scheduler.amazonaws.com', [statement(['ecs:RunTask'], arn('aws_ecs_task_definition', 'backup'),
    { ArnEquals: { 'ecs:cluster': cluster } }), statement(['iam:PassRole'], [roleArn('files'), roleArn('execution')],
    { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } })],
  'arn:aws:scheduler:' + region + ':' + accountId + ':schedule-group/default');
  add('aws_scheduler_schedule', 'daily', { name: programName, group_name: 'default', schedule_expression: 'cron(17 3 * * ? *)',
    schedule_expression_timezone: 'UTC', flexible_time_window: [{ mode: 'OFF' }], target: [{ arn: cluster, role_arn: roleArn('schedule'),
      retry_policy: [{ maximum_event_age_in_seconds: 3600, maximum_retry_attempts: 0 }], ecs_parameters: [{ task_definition_arn: arn('aws_ecs_task_definition', 'backup'),
        platform_version: '1.4.0', launch_type: 'FARGATE', task_count: 1, network_configuration: [{ subnets: '${data.aws_subnets.default.ids}', security_groups: [arn('aws_security_group', 'backup', 'id')],
          assign_public_ip: true }] }] }], depends_on: ['aws_iam_role_policy.schedule'] }, 'schedule');
  files['daily-bucket-backup.tf.json'] = { data: { external: nativeEnrollmentProbe(input.config), aws_vpc: { default: { default: true } },
    aws_subnets: { default: { filter: [{ name: 'vpc-id', values: ['${data.aws_vpc.default.id}'] },
      { name: 'default-for-az', values: ['true'] }] } } }, resource };
  return { files, resources };
}
