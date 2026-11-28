import { addAwsMonitoring } from './aws-monitoring.config.js';
import type { ObserverFederation } from '../../../../domain/spec/runtime-observation.js';
import { awsImageBuildspec } from '../aws-buildspec.js';
import { awsDatabaseQuerySecretName } from '../aws-database-query-secret.js';
import type { EngineConfiguration, EngineResourceMapping } from '../../../../domain/ports/infrastructure-engine.port.js';
import { addTasks } from './aws-engine.tasks.js';
import type { EngineCiIntent } from '../../../../domain/spec/engine-ci.js';
import { addAwsObserverConfiguration } from './aws-observer.config.js';
import { addAwsCiConfiguration } from './aws-engine-ci.config.js';
import { awsControlRoleName, awsRuntimeIdentity, awsTaskRoleArns } from './aws-engine.identity.js';

/**
 * Pure OpenTofu configuration for one AWS environment. Values are non-secret:
 * runtime secrets live in SSM Parameter Store (written by Hypervibe, read by
 * the app's image at start), and the database master password is managed by
 * RDS itself, so no secret ever enters engine state.
 */
export interface AwsEngineInput {
  ci?: EngineCiIntent;
  observation?: ObserverFederation;
  webCommands?: boolean;
  accountId: string;
  region: string;
  /** Short stable prefix for physical names, e.g. `hv-billforge-aws`. */
  prefix: string;
  /** Environment id stamped on owned resources so adoption can prove ownership. */
  environmentId: string;
  /** SSM path holding this environment's runtime secrets, e.g. `/hypervibe/<env-id>/`. */
  parameterPath: string;
  /** The environment's own database on the project's shared testing cluster. */
  database?: AwsEnvironmentDatabaseInput;
  storage?: Array<{ name: string; bucket: string; versioning?: boolean; browserUploads?: boolean; autoTiering?: boolean }>;
  /** Web services on Fargate; public ones get an HTTPS address through ECS Express Mode. */
  services?: AwsWebServiceInput[];
  /** Background workers on Fargate; on-demand ones sit at zero tasks until there is work. */
  workers?: AwsWorkerInput[];
  /** Scheduled jobs: EventBridge Scheduler runs a Fargate task. */
  jobs?: AwsJobInput[];
  /** Names of the runtime secrets under parameterPath, wired into Fargate tasks by reference. */
  secretKeys?: string[];
  /**
   * Runtime secrets limited to named services (secret key to service names). Absent or empty: every workload
   * receives every secret and one runtime role runs them all. Present: see aws-engine.identity.ts.
   */
  secretScopes?: Record<string, string[]>;
  /** Declared, present package token: CodeBuild alone can read it. */
  packageTokenKey?: string;
}

export interface AwsTaskInput {
  logicalName: string;
  resourceName: string;
  /** Image for first creation (in this environment's registry); the release path owns it afterwards. */
  initialImageUri: string;
  /** Fargate CPU units (256 = 0.25 vCPU) and memory in MB. */
  cpu?: number;
  memory?: number;
  command?: string[];
  env?: Record<string, string>;
}

export interface AwsWorkerInput extends AwsTaskInput {
  paused?: boolean;
  /** Run only while this read-only count of pending work is above zero (uses the Aurora Data API). */
  pendingWorkQuery?: string;
  /** Earliest time future work is due; the waker sets a one-time wake for it so a paused database can stay paused. */
  nextWorkAtQuery?: string;
}

export interface AwsJobInput extends AwsTaskInput {
  /** Five-field cron schedule and IANA time zone. */
  schedule: string;
  timeZone?: string;
}

/** Converts a five-field cron to EventBridge Scheduler's six-field form (day-of-week 1-7, one day field '?'). */
export function schedulerCron(schedule: string): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Schedule "${schedule}" must have five fields.`);
  let [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  dayOfWeek = dayOfWeek.replace(/\d+/g, (day) => String((Number(day) % 7) + 1));
  if (dayOfWeek === '*') dayOfWeek = '?';
  else if (dayOfMonth === '*') dayOfMonth = '?';
  else throw new Error(`Schedule "${schedule}" sets both day of month and day of week, which EventBridge Scheduler does not support.`);
  return `cron(${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek} *)`;
}

/**
 * The account role ECS Express Mode manages a web service's load balancer,
 * certificate and scaling with. Setup creates it; the deploy role can only pass it to ECS.
 */
export const AWS_WEB_INFRASTRUCTURE_ROLE = 'hypervibe-web-infrastructure';
export const awsWebInfrastructureRoleArn = (accountId: string): string => `arn:aws:iam::${accountId}:role/hypervibe/${AWS_WEB_INFRASTRUCTURE_ROLE}`;
export const AWS_WEB_PORT = 8080;

export interface AwsWebServiceInput extends AwsTaskInput {
  /** Non-secret configuration only; secrets are wired by reference from the parameter path. */
  env?: Record<string, string>;
  /** A public service gets an HTTPS address; a private one runs with no route from the internet. */
  public: boolean;
  healthCheckPath?: string;
  /** Most containers the service may scale out to under load (it always keeps one running). */
  maxInstances?: number;
}

export interface AwsEnvironmentDatabaseInput {
  /** The shared cluster's ARN (deterministic, so it can be named before the cluster exists). */
  clusterArn: string;
  /** This environment's database on it. */
  name: string;
}

/** The project's testing cluster: one Aurora Serverless cluster that every testing environment has its own database on. */
export interface AwsSharedInput {
  accountId: string;
  region: string;
  /** Prefix of the shared resources, e.g. `hv-billforge-shared`. */
  prefix: string;
  /** Stamped as `hv-environment` on the shared resources. */
  environmentId: string;
  database: AwsClusterInput;
}

export interface AwsClusterInput {
  /** Exact Aurora PostgreSQL version, the newest minor AWS offers for the spec's major (read at plan time). */
  engineVersion: string;
  /** 0 pauses when idle (staging); production uses at least 0.5. */
  minCapacity: number;
  maxCapacity: number;
  /** The engine already requires TLS by default (rds.force_ssl=1); setting the default again never sticks and drifts. */
  tlsRequiredByDefault?: boolean;
  /** Seconds idle before pausing when minCapacity is 0. */
  pauseAfterSeconds?: number;
}

export const awsKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

export function checkedProvider(input: Pick<AwsEngineInput, 'accountId' | 'region' | 'prefix' | 'environmentId'>): Record<string, unknown> {
  if (!/^\d{12}$/.test(input.accountId)) throw new Error('AWS account id is invalid.');
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(input.region)) throw new Error('AWS region is invalid.');
  if (!/^[a-z][a-z0-9-]{2,30}$/.test(input.prefix)) throw new Error('AWS name prefix is invalid.');
  const tags = { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() };
  return { 'provider.tf.json': { provider: { aws: [{ region: input.region, allowed_account_ids: [input.accountId], default_tags: [{ tags }] }] } } };
}

/** The registry an environment's images are pushed to: deterministic, so plans can name an image before it is built. */
export function awsRegistryUrl(input: Pick<AwsEngineInput, 'accountId' | 'region' | 'prefix'>): string {
  return `${input.accountId}.dkr.ecr.${input.region}.amazonaws.com/${input.prefix}`;
}

/**
 * The environment's image registry and CodeBuild project, in their own state:
 * they are applied first, so the first image is built inside the same reviewed
 * apply and the workloads are created from it (one plan round).
 */
export function buildAwsBuildConfiguration(input: AwsEngineInput): EngineConfiguration {
  const files: Record<string, unknown> = checkedProvider(input);
  const resources: Record<string, EngineResourceMapping> = {};
  const registry = { actionId: 'registry:images', kind: 'service' as const, name: 'images' };
  resources['aws_ecr_repository.images'] = registry;
  resources['aws_ecr_lifecycle_policy.images'] = registry;
  files['registry.tf.json'] = { resource: {
    aws_ecr_repository: { images: { name: input.prefix, image_tag_mutability: 'IMMUTABLE', force_delete: true, image_scanning_configuration: [{ scan_on_push: true }] } },
    aws_ecr_lifecycle_policy: { images: { repository: '${aws_ecr_repository.images.name}', policy: JSON.stringify({
      rules: [{ rulePriority: 1, description: 'Keep the last 10 images', selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 }, action: { type: 'expire' } }],
    }) } },
  } };
  addBuilds(input, files, resources);
  files['outputs.tf.json'] = { output: {
    registry_url: { value: '${aws_ecr_repository.images.repository_url}' },
    build_project: { value: '${aws_codebuild_project.images.name}' },
    build_source_bucket: { value: '${aws_s3_bucket.build_source.id}' },
  } };
  return { files, resources };
}

export function buildAwsConfiguration(input: AwsEngineInput): EngineConfiguration {
  const resources: Record<string, EngineResourceMapping> = {};
  const files: Record<string, unknown> = checkedProvider(input);

  const runtimeSecretKeys = (input.secretKeys ?? []).filter((key) => !['NODE_AUTH_TOKEN', 'NPM_TOKEN'].includes(key));
  // The app's runtime role (capped by the setup boundary).
  const runtime = { actionId: 'identity:runtime', kind: 'service' as const, name: 'runtime' };
  resources['aws_iam_role.runtime'] = runtime;
  resources['aws_iam_role_policy.runtime'] = runtime;
  const buckets = input.storage ?? [];
  const identity = awsRuntimeIdentity(input, runtimeSecretKeys);
  const parameterArn = (key: string) => `arn:aws:ssm:${input.region}:${input.accountId}:parameter${input.parameterPath}${key}`;
  /** What a container's role may do: write logs, read exactly its own secrets, pull the image, use the environment's buckets. */
  const workloadStatements = (secretKeys: string[]): unknown[] => [
    { Sid: 'Logs', Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' },
    ...(secretKeys.length ? [{ Sid: 'Secrets', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'], Resource: secretKeys.map(parameterArn) }] : []),
    // Decryption happens only inside a Parameter Store read, which the statement above limits to the listed parameters.
    { Sid: 'DecryptSecrets', Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Condition: { StringEquals: { 'kms:ViaService': `ssm.${input.region}.amazonaws.com` } } },
    { Sid: 'PullImages', Effect: 'Allow', Action: ['ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], Resource: '*' },
    ...(buckets.length ? [{ Sid: 'Storage', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      Resource: buckets.flatMap((bucket) => [`arn:aws:s3:::${bucket.bucket}`, `arn:aws:s3:::${bucket.bucket}/*`]) }] : []),
  ];
  const runtimeStatements = workloadStatements(identity.sharedSecretKeys);
  const account = `${input.region}:${input.accountId}`;
  const runtimeRoleArn = `arn:aws:iam::${input.accountId}:role/hypervibe/app/${input.prefix}-runtime`;
  const jobs = input.jobs ?? [];
  const onDemandWorkers = (input.workers ?? []).filter((worker) => worker.pendingWorkQuery);
  const onDemand = onDemandWorkers.length > 0;
  const wakerStatements = [
    ...(input.database ? [{ Sid: 'WakerCount', Effect: 'Allow', Action: 'rds-data:ExecuteStatement', Resource: input.database.clusterArn }] : []),
    { Sid: 'WakerLogin', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:${account}:secret:hypervibe/${input.prefix}/*` },
    { Sid: 'WakerScale', Effect: 'Allow', Action: ['ecs:UpdateService', 'ecs:DescribeServices'], Resource: `arn:aws:ecs:${account}:service/${input.prefix}/*` },
    { Sid: 'WakerWebRequests', Effect: 'Allow', Action: 'cloudwatch:GetMetricData', Resource: '*' },
    { Sid: 'WakerTimer', Effect: 'Allow', Action: 'scheduler:UpdateSchedule', Resource: `arn:aws:scheduler:${account}:schedule/default/${input.prefix}-*` },
  ];
  if (!identity.scoped && (jobs.length || onDemand)) {
    // Schedules start this environment's tasks and wakers, handing them only this role.
    runtimeStatements.push(
      { Sid: 'RunTasks', Effect: 'Allow', Action: 'ecs:RunTask', Resource: `arn:aws:ecs:${account}:task-definition/${input.prefix}-*` },
      { Sid: 'StartWakers', Effect: 'Allow', Action: 'states:StartExecution', Resource: `arn:aws:states:${account}:stateMachine:${input.prefix}-*` },
      { Sid: 'PassSelf', Effect: 'Allow', Action: 'iam:PassRole', Resource: runtimeRoleArn },
    );
  }
  if (!identity.scoped && onDemand) runtimeStatements.push(...wakerStatements);
  const boundary = `arn:aws:iam::${input.accountId}:policy/hypervibe/hypervibe-app-boundary`;
  const trust = (services: string[]) => JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: services } }] });
  const policy = (statements: unknown[]) => JSON.stringify({ Version: '2012-10-17', Statement: statements });
  const roles: Record<string, unknown> = { runtime: {
    name: `${input.prefix}-runtime`, path: '/hypervibe/app/', permissions_boundary: boundary,
    // Once a secret names services, containers alone use this role; schedules and wakers run as the control role.
    assume_role_policy: trust(identity.scoped ? ['ecs-tasks.amazonaws.com'] : ['ecs-tasks.amazonaws.com', 'scheduler.amazonaws.com', 'states.amazonaws.com', 'events.amazonaws.com']),
  } };
  const policies: Record<string, unknown> = { runtime: { name: 'runtime', role: '${aws_iam_role.runtime.id}', policy: policy(runtimeStatements) } };
  for (const role of identity.serviceRoles) {
    roles[role.key] = { name: role.name, path: '/hypervibe/app/', permissions_boundary: boundary, assume_role_policy: trust(['ecs-tasks.amazonaws.com']) };
    policies[role.key] = { name: 'runtime', role: `\${aws_iam_role.${role.key}.id}`, policy: policy(workloadStatements(role.secretKeys)) };
    resources[`aws_iam_role.${role.key}`] = runtime;
    resources[`aws_iam_role_policy.${role.key}`] = runtime;
  }
  if (identity.scoped && (jobs.length || onDemand)) {
    // No container runs as this role. It starts exactly this environment's scheduled jobs and wakers.
    const controlRoleArn = `arn:aws:iam::${input.accountId}:role/hypervibe/app/${awsControlRoleName(input.prefix)}`;
    roles.control = { name: awsControlRoleName(input.prefix), path: '/hypervibe/app/', permissions_boundary: boundary,
      assume_role_policy: trust(['scheduler.amazonaws.com', ...(onDemand ? ['states.amazonaws.com', 'events.amazonaws.com'] : [])]) };
    policies.control = { name: 'control', role: '${aws_iam_role.control.id}', policy: policy([
      ...(jobs.length ? [
        { Sid: 'RunTasks', Effect: 'Allow', Action: 'ecs:RunTask', Resource: jobs.flatMap((job) => [`arn:aws:ecs:${account}:task-definition/${job.resourceName}`, `arn:aws:ecs:${account}:task-definition/${job.resourceName}:*`]) },
        { Sid: 'PassTaskRoles', Effect: 'Allow', Action: 'iam:PassRole', Resource: awsTaskRoleArns(input, jobs), Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } },
      ] : []),
      ...(onDemand ? [
        { Sid: 'StartWakers', Effect: 'Allow', Action: 'states:StartExecution', Resource: onDemandWorkers.map((worker) => `arn:aws:states:${account}:stateMachine:${worker.resourceName}-waker`) },
        // The waker re-arms its own one-time schedule, which runs as this role.
        { Sid: 'PassSelf', Effect: 'Allow', Action: 'iam:PassRole', Resource: controlRoleArn },
        ...wakerStatements,
      ] : []),
    ]) };
    resources['aws_iam_role.control'] = runtime;
    resources['aws_iam_role_policy.control'] = runtime;
  }
  // With a limited secret, each role's permissions are exactly what this configuration declares: a managed policy
  // attached to it, or a second inline policy, from outside Hypervibe would be removed by the next apply instead of
  // quietly widening who can read the secret. Environments without a limited secret keep their configuration unchanged.
  const exclusive: Record<string, Record<string, unknown>> = {};
  if (identity.scoped) {
    exclusive.aws_iam_role_policy_attachments_exclusive = {};
    exclusive.aws_iam_role_policies_exclusive = {};
    for (const key of Object.keys(roles)) {
      exclusive.aws_iam_role_policy_attachments_exclusive[key] = { role_name: `\${aws_iam_role.${key}.name}`, policy_arns: [] };
      exclusive.aws_iam_role_policies_exclusive[key] = { role_name: `\${aws_iam_role.${key}.name}`, policy_names: [`\${aws_iam_role_policy.${key}.name}`] };
      resources[`aws_iam_role_policy_attachments_exclusive.${key}`] = runtime;
      resources[`aws_iam_role_policies_exclusive.${key}`] = runtime;
    }
  }
  files['base.tf.json'] = {
    // The default VPC: tasks run in its public subnets (no NAT gateway) and reach the database on its private address.
    data: { aws_vpc: { default: { default: true } }, aws_subnets: { default: { filter: [{ name: 'vpc-id', values: ['${data.aws_vpc.default.id}'] }] } } },
    resource: { aws_iam_role: roles, aws_iam_role_policy: policies, ...exclusive },
  };

  // Storage: private buckets, objects encrypted, no public access.
  if (buckets.length) {
    const bucketResources: Record<string, Record<string, unknown>> = { aws_s3_bucket: {}, aws_s3_bucket_public_access_block: {}, aws_s3_bucket_ownership_controls: {} };
    for (const bucket of buckets) {
      const key = awsKey(bucket.name);
      const mapping: EngineResourceMapping = { actionId: `storage:${bucket.name}`, kind: 'storage', name: bucket.name, dataBearing: true, billable: true };
      bucketResources.aws_s3_bucket![key] = { bucket: bucket.bucket, force_destroy: false };
      bucketResources.aws_s3_bucket_public_access_block![key] = { bucket: `\${aws_s3_bucket.${key}.id}`, block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true };
      bucketResources.aws_s3_bucket_ownership_controls![key] = { bucket: `\${aws_s3_bucket.${key}.id}`, rule: [{ object_ownership: 'BucketOwnerEnforced' }] };
      for (const type of ['aws_s3_bucket', 'aws_s3_bucket_public_access_block', 'aws_s3_bucket_ownership_controls']) resources[`${type}.${key}`] = mapping;
      const reference = `\${aws_s3_bucket.${key}.id}`;
      // Retain the policy address mapping when a setting is removed so its deletion is reviewable.
      for (const type of ['aws_s3_bucket_versioning', 'aws_s3_bucket_lifecycle_configuration', 'aws_s3_bucket_cors_configuration']) {
        resources[`${type}.${key}`] = mapping;
      }
      if (bucket.versioning) {
        (bucketResources.aws_s3_bucket_versioning ??= {})[key] = { bucket: reference, versioning_configuration: [{ status: 'Enabled' }] };
      }
      if (bucket.versioning || bucket.autoTiering) {
        // A bucket has one lifecycle configuration. The tiering rule comes first, so adding or removing it is always
        // a change to rule 0's transition. Intelligent-Tiering's delayed archive tiers are opt-in and never enabled:
        // files stay instantly readable. S3 leaves files under 128 KB where they are.
        (bucketResources.aws_s3_bucket_lifecycle_configuration ??= {})[key] = {
          bucket: reference, ...(bucket.versioning ? { depends_on: [`aws_s3_bucket_versioning.${key}`] } : {}),
          rule: [
            ...(bucket.autoTiering ? [{ id: 'auto-tiering', status: 'Enabled', filter: [{}], transition: [{ days: 0, storage_class: 'INTELLIGENT_TIERING' }] }] : []),
            ...(bucket.versioning ? [{ id: 'expire-old-versions', status: 'Enabled', filter: [{}], noncurrent_version_expiration: [{ noncurrent_days: 30 }] }] : []),
          ],
        };
      }
      if (bucket.browserUploads) {
        (bucketResources.aws_s3_bucket_cors_configuration ??= {})[key] = { bucket: reference, cors_rule: [{
          allowed_methods: ['PUT', 'POST', 'GET', 'HEAD'], allowed_origins: ['*'], allowed_headers: ['*'], expose_headers: ['ETag', 'Location'], max_age_seconds: 3600,
        }] };
      }
    }
    files['storage.tf.json'] = { resource: bucketResources };
  }

  addTasks({ ...input, secretKeys: runtimeSecretKeys }, files, resources, identity);
  if (input.database) {
    files['database-access.tf.json'] = { resource: { aws_secretsmanager_secret: { database_query: {
      name: awsDatabaseQuerySecretName(input.environmentId), recovery_window_in_days: 0,
      description: 'Hypervibe environment application login for database diagnostics; value managed by the approved login operation.',
      tags: { 'managed-by': 'hypervibe', 'hv-environment': input.environmentId.toLowerCase() },
    } } } };
    resources['aws_secretsmanager_secret.database_query'] = { actionId: 'database-query:credential', kind: 'secret', name: 'database query access', billable: true, requiresConfirm: true };
  }
  addAwsCiConfiguration(input, files, resources);
  addAwsObserverConfiguration(input, files, resources);
  addAwsMonitoring(input, files, resources);

  files['outputs.tf.json'] = { output: {
    runtime_role_arn: { value: '${aws_iam_role.runtime.arn}' },
  } };
  return { files, resources };
}

/** The cluster ARN a shared prefix names. */
export function awsSharedClusterArn(input: Pick<AwsSharedInput, 'accountId' | 'region' | 'prefix'>): string {
  return `arn:aws:rds:${input.region}:${input.accountId}:cluster:${input.prefix}-postgres`;
}

/**
 * The project's shared testing cluster, in its own state so each testing
 * environment adds only a database and logins (seconds, not a new cluster).
 * Aurora Serverless v2 with no public address: only workloads in the same network can connect (see docs/opentofu-engine-aws.md).
 */
export function buildAwsSharedConfiguration(input: AwsSharedInput): EngineConfiguration {
  const files: Record<string, unknown> = checkedProvider(input);
  const resources: Record<string, EngineResourceMapping> = {};
  const version = input.database.engineVersion;
  if (!/^\d+\.\d+$/.test(version)) throw new Error(`Aurora PostgreSQL version ${version} is invalid.`);
  const major = version.split('.')[0];
  const mapping: EngineResourceMapping = { actionId: 'shared:database', kind: 'database', name: 'postgres', dataBearing: true, billable: true,
    costAttributes: ['serverlessv2_scaling_configuration.*.min_capacity', 'serverlessv2_scaling_configuration.*.max_capacity',
      'serverlessv2_scaling_configuration.*.seconds_until_auto_pause', 'instance_class'] };
  for (const address of ['aws_rds_cluster.postgres', 'aws_rds_cluster_instance.postgres', 'aws_rds_cluster_parameter_group.postgres', 'aws_db_subnet_group.postgres', 'aws_security_group.postgres']) {
    resources[address] = mapping;
  }
  files['database.tf.json'] = {
    data: { aws_vpc: { default: { default: true } }, aws_subnets: { default: { filter: [{ name: 'vpc-id', values: ['${data.aws_vpc.default.id}'] }] } } },
    resource: {
      aws_security_group: { postgres: { name: `${input.prefix}-postgres`, description: 'Hypervibe: Postgres over TLS', vpc_id: '${data.aws_vpc.default.id}',
        // No public address: only workloads inside this network reach the port. Hypervibe itself uses the Data API.
        ingress: [{ description: 'Postgres from this network only (TLS required by the cluster)', from_port: 5432, to_port: 5432, protocol: 'tcp', cidr_blocks: ['${data.aws_vpc.default.cidr_block}'], ipv6_cidr_blocks: [], prefix_list_ids: [], security_groups: [], self: false }],
        egress: [] } },
      aws_db_subnet_group: { postgres: { name: `${input.prefix}-postgres`, subnet_ids: '${data.aws_subnets.default.ids}' } },
      aws_rds_cluster_parameter_group: { postgres: { name: `${input.prefix}-postgres`, family: `aurora-postgresql${major}`,
        ...(input.database.tlsRequiredByDefault ? {} : { parameter: [{ name: 'rds.force_ssl', value: '1' }] }) } },
      aws_rds_cluster: { postgres: {
        // No initial database: each testing environment gets its own.
        cluster_identifier: `${input.prefix}-postgres`, engine: 'aurora-postgresql', engine_mode: 'provisioned', engine_version: version,
        master_username: 'hvadmin',
        // RDS keeps the master password in Secrets Manager; it never enters engine state.
        manage_master_user_password: true,
        enable_http_endpoint: true, iam_database_authentication_enabled: true,
        db_subnet_group_name: '${aws_db_subnet_group.postgres.name}', vpc_security_group_ids: ['${aws_security_group.postgres.id}'],
        db_cluster_parameter_group_name: '${aws_rds_cluster_parameter_group.postgres.name}',
        storage_encrypted: true, backup_retention_period: 1, copy_tags_to_snapshot: true,
        deletion_protection: false, skip_final_snapshot: false, final_snapshot_identifier: `${input.prefix}-postgres-final`,
        serverlessv2_scaling_configuration: [{ min_capacity: input.database.minCapacity, max_capacity: input.database.maxCapacity,
          ...(input.database.minCapacity === 0 ? { seconds_until_auto_pause: input.database.pauseAfterSeconds ?? 600 } : {}) }],
        // Native backup retention is managed only by separately reviewed backup work.
        lifecycle: [{ ignore_changes: ['engine_version', 'backup_retention_period'] }],
      } },
      aws_rds_cluster_instance: { postgres: {
        identifier: `${input.prefix}-postgres-1`, cluster_identifier: '${aws_rds_cluster.postgres.id}', instance_class: 'db.serverless',
        engine: '${aws_rds_cluster.postgres.engine}', engine_version: '${aws_rds_cluster.postgres.engine_version}',
        publicly_accessible: false, db_subnet_group_name: '${aws_db_subnet_group.postgres.name}',
      } },
    },
    output: {
      database_endpoint: { value: '${aws_rds_cluster.postgres.endpoint}' },
      database_cluster_arn: { value: '${aws_rds_cluster.postgres.arn}' },
    },
  };
  return { files, resources };
}

function addBuilds(input: AwsEngineInput, files: Record<string, unknown>, resources: Record<string, EngineResourceMapping>): void {
  if (input.packageTokenKey && !['NODE_AUTH_TOKEN', 'NPM_TOKEN'].includes(input.packageTokenKey)) throw new Error('Invalid package token key.');
  // Image builds: CodeBuild reads a source archive Hypervibe uploads and pushes to the registry.
  const builds: EngineResourceMapping = { actionId: 'builds:images', kind: 'service', name: 'builds' };
  for (const address of ['aws_s3_bucket.build_source', 'aws_s3_bucket_public_access_block.build_source', 'aws_s3_bucket_lifecycle_configuration.build_source',
    'aws_iam_role.build', 'aws_iam_role_policy.build', 'aws_codebuild_project.images']) resources[address] = builds;
  files['builds.tf.json'] = { resource: {
    aws_s3_bucket: { build_source: { bucket: `${input.prefix}-build-${input.accountId}`, force_destroy: true } },
    aws_s3_bucket_public_access_block: { build_source: { bucket: '${aws_s3_bucket.build_source.id}', block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true } },
    aws_s3_bucket_lifecycle_configuration: { build_source: { bucket: '${aws_s3_bucket.build_source.id}', rule: [{ id: 'expire-sources', status: 'Enabled', filter: [{}], expiration: [{ days: 7 }] }] } },
    aws_iam_role: { build: {
      name: `${input.prefix}-build`, path: '/hypervibe/app/', permissions_boundary: `arn:aws:iam::${input.accountId}:policy/hypervibe/hypervibe-app-boundary`,
      assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'codebuild.amazonaws.com' } }] }),
    } },
    aws_iam_role_policy: { build: { name: 'build', role: '${aws_iam_role.build.id}', policy: JSON.stringify({ Version: '2012-10-17', Statement: [
      { Sid: 'Logs', Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' },
      { Sid: 'Source', Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: `arn:aws:s3:::${input.prefix}-build-${input.accountId}/*` },
      ...(input.packageTokenKey ? [
        { Sid: 'PackageToken', Effect: 'Allow', Action: 'ssm:GetParameters', Resource: `arn:aws:ssm:${input.region}:${input.accountId}:parameter${input.parameterPath}${input.packageTokenKey}` },
        { Sid: 'DecryptPackageToken', Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Condition: { StringEquals: { 'kms:ViaService': `ssm.${input.region}.amazonaws.com`, 'kms:EncryptionContext:PARAMETER_ARN': `arn:aws:ssm:${input.region}:${input.accountId}:parameter${input.parameterPath}${input.packageTokenKey}` } } },
      ] : []),
      { Sid: 'Login', Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
      { Sid: 'Push', Effect: 'Allow', Resource: `arn:aws:ecr:${input.region}:${input.accountId}:repository/${input.prefix}`, Action: [
        'ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'] },
    ] }) } },
    aws_codebuild_project: { images: {
      name: `${input.prefix}-images`, service_role: '${aws_iam_role.build.arn}', build_timeout: 30,
      artifacts: [{ type: 'NO_ARTIFACTS' }],
      environment: [{ compute_type: 'BUILD_GENERAL1_SMALL', image: 'aws/codebuild/amazonlinux-x86_64-standard:5.0', type: 'LINUX_CONTAINER', privileged_mode: true,
        environment_variable: [{ name: 'REGISTRY', value: '${aws_ecr_repository.images.repository_url}' }] }],
      // Hypervibe uploads source.zip with its generated Dockerfile and starts builds with an IMAGE_TAG override.
      source: [{ type: 'S3', location: `${input.prefix}-build-${input.accountId}/source.zip`, buildspec: JSON.stringify(awsImageBuildspec(input.webCommands)).replace(/\$\{/g, () => '$${') }],
      logs_config: [{ cloudwatch_logs: [{ status: 'ENABLED', group_name: `/hypervibe/${input.prefix}/builds` }] }],
    } },
  } };
}
